import {
    HttpException,
    HttpStatus,
    Injectable,
    Logger,
    OnModuleInit,
} from '@nestjs/common'
import * as fs from 'fs'
import { ParseService } from './parse.service'
import { InjectRepository } from '@nestjs/typeorm'
import { Asset } from 'src/entities/asset.entity'
import { History } from 'src/entities/history.entity'
import { Repository } from 'typeorm'
import { FormatService } from './format.service'
import { HistoryType } from 'src/entities/history.entity'
import { Cron } from '@nestjs/schedule'
import { InspectDto } from './inspect.dto'
import { Bot } from './bot.class'
import { createHash } from 'crypto'
import { QueueService } from './queue.service'
import { WorkerManagerService } from './worker/worker-manager.service'

@Injectable()
export class InspectService implements OnModuleInit {
    private readonly logger = new Logger(InspectService.name)
    private startTime: number = Date.now()
    private readonly QUEUE_TIMEOUT = parseInt(process.env.QUEUE_TIMEOUT || '5000') // 5 seconds timeout
    private readonly MAX_RETRIES = parseInt(process.env.MAX_RETRIES || '3')
    private readonly MAX_QUEUE_SIZE = parseInt(process.env.MAX_QUEUE_SIZE || '100')
    private throttledAccounts: Map<string, number> = new Map()
    private readonly THROTTLE_COOLDOWN = 30 * 60 * 1000 // 30 minutes in milliseconds

    private bots: Map<string, Bot> = new Map()
    private accounts: string[] = []
    private inspects: Map<string, {
        ms: string
        d: string
        resolve: (value: any) => void
        reject: (reason?: any) => void
        timeoutId: NodeJS.Timeout
        startTime?: number
        retryCount?: number
        inspectUrl?: { s: string, a: string, d: string, m: string }
    }> = new Map()

    private nextBot = 0
    private currentRequests = 0
    private requests: number[] = []
    private success = 0
    private cached = 0
    private failed = 0
    private timeouts = 0

    private readonly HEALTH_CHECK_THRESHOLD = 15 * 60 * 1000; // 15 minutes
    private readonly MIN_BOT_RATIO = 0.7; // 70% minimum active bots
    private lastHealthyTime: number = Date.now();
    private isRecovering: boolean = false;

    constructor(
        private parseService: ParseService,
        private formatService: FormatService,
        @InjectRepository(Asset)
        private assetRepository: Repository<Asset>,
        @InjectRepository(History)
        private historyRepository: Repository<History>,
        private readonly queueService: QueueService,
        private readonly workerManagerService: WorkerManagerService,
    ) { }

    async onModuleInit() {
        this.logger.debug('Starting Inspect Module...');
        // Worker manager service will handle bot initialization
        this.logger.log('Inspect Module initialized. Bot initialization handled by Worker Manager Service.');
    }

    // Use worker manager for bot stats
    public stats() {
        const workerStats = this.workerManagerService.getStats();
        const queueUtilization = (this.inspects.size / this.MAX_QUEUE_SIZE) * 100;

        // Calculate uptime
        const uptime = Date.now() - this.startTime;
        const days = Math.floor(uptime / (24 * 60 * 60 * 1000));
        const hours = Math.floor((uptime % (24 * 60 * 60 * 1000)) / (60 * 60 * 1000));
        const minutes = Math.floor((uptime % (60 * 60 * 1000)) / (60 * 1000));
        const seconds = Math.floor((uptime % (60 * 1000)) / 1000);

        return {
            status: workerStats.readyBots > 0 ? 'ready' : 'initializing',
            uptime: `${days}d ${hours}h ${minutes}m ${seconds}s`,
            bots: {
                ready: workerStats.readyBots,
                busy: workerStats.busyBots,
                cooldown: workerStats.cooldownBots,
                disconnected: workerStats.disconnectedBots,
                error: workerStats.errorBots,
                total: workerStats.totalBots,
                availability: this.workerManagerService.getBotAvailabilityPercentage().toFixed(2) + '%',
                utilization: (workerStats.totalBots > 0 ? (workerStats.busyBots / workerStats.totalBots) * 100 : 0).toFixed(2) + '%',
                workers: workerStats.workers,
                workerDetails: workerStats.workerDetails
            },
            metrics: {
                success: {
                    rate: ((this.success / (this.success + this.failed + this.cached + this.timeouts)) * 100).toFixed(2) + '%',
                    count: this.success,
                },
                cached: {
                    rate: ((this.cached / (this.success + this.failed + this.cached + this.timeouts)) * 100).toFixed(2) + '%',
                    count: this.cached,
                },
                failed: {
                    rate: ((this.failed / (this.success + this.failed + this.cached + this.timeouts)) * 100).toFixed(2) + '%',
                    count: this.failed,
                },
                timeouts: {
                    rate: ((this.timeouts / (this.success + this.failed + this.cached + this.timeouts)) * 100).toFixed(2) + '%',
                    count: this.timeouts,
                },
                total: this.success + this.failed + this.cached + this.timeouts
            },
            requests: {
                history: this.requests,
                current: this.currentRequests,
                average: this.requests.length > 0
                    ? (this.requests.reduce((a, b) => a + b, 0) / this.requests.length).toFixed(2)
                    : 0
            },
            queue: {
                current: this.inspects.size,
                max: this.MAX_QUEUE_SIZE,
                utilization: queueUtilization.toFixed(2) + '%',
                avgProcessingTime: Math.round(this.getAverageProcessingTime()) + 'ms',
                items: this.getQueueItems()
            }
        }
    }

    private getAverageProcessingTime(): number {
        const activeInspects = Array.from(this.inspects.values())
        const processingTimes = activeInspects
            .filter(inspect => inspect.startTime)
            .map(inspect => Date.now() - inspect.startTime)
        return processingTimes.length > 0
            ? processingTimes.reduce((a, b) => a + b, 0) / processingTimes.length
            : 0
    }

    private getQueueItems() {
        return Array.from(this.inspects.entries()).map(([assetId, inspect]) => ({
            assetId,
            elapsedTime: inspect.startTime ? Date.now() - inspect.startTime : 0,
            retryCount: inspect.retryCount || 0
        }))
    }

    private getBotAvailabilityPercentage(): number {
        // Use worker manager to get bot availability
        return this.workerManagerService.getBotAvailabilityPercentage();
    }

    public async inspectItem(query: InspectDto) {
        this.currentRequests++;

        const { s, a, d, m } = this.parseService.parse(query);

        // First check if we have cached data before checking bot availability
        if (!query.refresh) {
            const cachedAsset = await this.checkCache(a, d);
            if (cachedAsset) {
                this.cached++;
                return cachedAsset;
            }
        }

        // After checking cache, if no cached data exists, then check bot availability
        const botAvailability = this.getBotAvailabilityPercentage();
        const MIN_BOT_AVAILABILITY = 40; // 40% threshold

        if (botAvailability < MIN_BOT_AVAILABILITY) {
            this.logger.warn(`Rejecting request due to low bot availability: ${botAvailability.toFixed(2)}% (threshold: ${MIN_BOT_AVAILABILITY}%)`);
            throw new HttpException(
                `Service is currently under heavy load (${botAvailability.toFixed(0)}% availability), please try again later`,
                HttpStatus.SERVICE_UNAVAILABLE
            );
        }

        if (this.queueService.isFull()) {
            throw new HttpException(
                `Queue is full (${this.queueService.size()}/${this.MAX_QUEUE_SIZE}), please try again later`,
                HttpStatus.TOO_MANY_REQUESTS
            );
        }

        try {
            // Try using the worker manager first
            let response;
            try {
                response = await this.workerManagerService.inspectItem(s, a, d, m);
                this.success++;
            } catch (workerError) {
                this.logger.warn(`Worker manager error, falling back to legacy approach: ${workerError.message}`);

                // Legacy fallback - might need to be implemented if needed
                throw new HttpException(
                    'Bot service currently unavailable',
                    HttpStatus.SERVICE_UNAVAILABLE
                );
            }

            // Only try to save valid responses
            if (response && response.iteminfo) {
                try {
                    await this.saveAsset(response, { s, a, d, m }, this.generateUniqueId(response.iteminfo));
                } catch (saveError) {
                    this.logger.error(`Error saving asset: ${saveError.message}`);
                    // Continue - don't fail the request if saving fails
                }
            } else {
                this.logger.warn(`Worker returned invalid response: ${JSON.stringify(response)}`);
            }

            // Always return whatever the worker gave us, even if saving failed
            return response;
        } catch (error) {
            this.logger.error(`Inspection error for asset ${a}: ${error.message}`);
            this.failed++;
            throw new HttpException(
                error.message || 'Inspection failed',
                HttpStatus.GATEWAY_TIMEOUT
            );
        }
    }

    private async checkCache(assetId: string, d: string): Promise<any> {
        try {
            // Convert string assetId to number
            const assetIdNum = parseInt(assetId, 10);

            const asset = await this.assetRepository.findOne({ where: { assetId: assetIdNum } });
            if (asset) {
                return this.formatService.formatResponse(asset);
            }
            return null;
        } catch (e) {
            this.logger.error(`Error checking cache: ${e.message}`);
            return null;
        }
    }

    private async findHistory(response: any): Promise<Asset | null> {
        try {
            return await this.assetRepository.findOne({
                where: {
                    paintWear: response.iteminfo.floatvalue,
                    paintIndex: response.iteminfo.paintindex,
                    defIndex: response.iteminfo.defindex,
                    paintSeed: response.iteminfo.paintseed,
                    origin: response.iteminfo.origin,
                }
            });
        } catch (error) {
            this.logger.error(`Error finding history: ${error.message}`);
            return null;
        }
    }

    private async saveHistory(response: any, history: any, inspectData: any, uniqueId: string): Promise<void> {
        try {
            const historyEntity = new History();
            historyEntity.uniqueId = uniqueId;
            historyEntity.assetId = parseInt(inspectData.a, 10);
            historyEntity.prevAssetId = history?.assetId;
            historyEntity.owner = inspectData.ms;
            historyEntity.prevOwner = history?.owner;
            historyEntity.stickers = response.iteminfo.stickers || null;
            historyEntity.prevStickers = history?.stickers || null;
            historyEntity.keychains = response.iteminfo.keychains || null;
            historyEntity.prevKeychains = history?.keychains || null;
            historyEntity.type = this.getHistoryType(response, history, inspectData);

            await this.historyRepository.save(historyEntity);
        } catch (error) {
            this.logger.error(`Error saving history: ${error.message}`);
        }
    }

    private getHistoryType(response: any, history: any, inspectData: any): HistoryType {
        if (!history) {
            if (response.iteminfo.origin === 8) return HistoryType.TRADED_UP;
            if (response.iteminfo.origin === 4) return HistoryType.DROPPED;
            if (response.iteminfo.origin === 1) return HistoryType.PURCHASED_INGAME;
            if (response.iteminfo.origin === 2) return HistoryType.UNBOXED;
            if (response.iteminfo.origin === 3) return HistoryType.CRAFTED;
            return HistoryType.UNKNOWN;
        }

        // Compare owners to detect trades or market transactions
        if (history.owner !== inspectData.ms) {
            if (history.owner?.startsWith('7656')) {
                return HistoryType.TRADE;
            }
            if (history.owner && !history.owner.startsWith('7656')) {
                return HistoryType.MARKET_BUY;
            }
        }

        // Compare stickers or keychains if needed
        // For now, return UNKNOWN as default
        return HistoryType.UNKNOWN;
    }

    private async saveAsset(response: any, inspectData: any, uniqueId: string) {
        try {
            const history = await this.findHistory(response);
            if (history) {
                const historyType = this.getHistoryType(response, history, inspectData);
                // Use UNKNOWN as a default "no changes" type since NONE isn't defined
                if (historyType !== HistoryType.UNKNOWN) {
                    await this.saveHistory(response, history, inspectData, uniqueId);
                }
            }

            // Convert string assetId to number
            const assetIdNum = parseInt(inspectData.a, 10);

            const existingAsset = await this.assetRepository.findOne({ where: { assetId: assetIdNum } });
            if (existingAsset) {
                await this.assetRepository.update({ assetId: assetIdNum }, {
                    defIndex: response.iteminfo.defindex,
                    paintIndex: response.iteminfo.paintindex,
                    rarity: response.iteminfo.rarity,
                    quality: response.iteminfo.quality,
                    paintSeed: response.iteminfo.paintseed,
                    origin: response.iteminfo.origin,
                    paintWear: response.iteminfo.floatvalue,
                    stickers: response.iteminfo.stickers || null,
                    keychains: response.iteminfo.keychains || null,
                    uniqueId: uniqueId,
                    updatedAt: new Date()
                });
            } else {
                const asset = new Asset();
                asset.assetId = assetIdNum;
                asset.defIndex = response.iteminfo.defindex;
                asset.paintIndex = response.iteminfo.paintindex;
                asset.rarity = response.iteminfo.rarity;
                asset.quality = response.iteminfo.quality;
                asset.paintSeed = response.iteminfo.paintseed;
                asset.origin = response.iteminfo.origin;
                asset.stickers = response.iteminfo.stickers || null;
                asset.keychains = response.iteminfo.keychains || null;
                asset.paintWear = response.iteminfo.floatvalue;
                asset.uniqueId = uniqueId;
                asset.createdAt = new Date();
                asset.updatedAt = new Date();
                await this.assetRepository.save(asset);
            }
        } catch (e) {
            this.logger.error(`Error saving asset: ${e.message}`);
        }
    }

    private generateUniqueId(item: {
        paintSeed?: number,
        paintIndex?: number,
        paintWear?: number,
        defIndex?: number,
        origin?: number,
        rarity?: number,
        questId?: number,
        quality?: number,
        dropReason?: number
    }): string {
        try {
            const data = {
                d: item.defIndex || 0,
                p: item.paintIndex || 0,
                s: item.paintSeed || 0,
                w: item.paintWear || 0,
                o: item.origin || 0,
                r: item.rarity || 0,
                q: item.quality || 0,
                qid: item.questId || 0,
                dr: item.dropReason || 0
            }
            return createHash('md5').update(JSON.stringify(data)).digest('hex')
        } catch (e) {
            this.logger.error(`Error generating unique ID: ${e.message}`)
            return ''
        }
    }

    // Implement the remaining methods (findHistory, saveHistory, getHistoryType, etc.)
    // They can remain mostly unchanged since they don't involve bot management

    // ... (rest of the existing service methods for history handling)
}
