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

        if (process.env.WORKER_ENABLED === 'true') {
            this.logger.log('Worker mode enabled. Bot initialization handled by Worker Manager Service.');
            this.logger.log('Each worker thread will handle up to 50 bots for optimal performance.');
        } else {
            this.logger.warn('Worker mode is disabled. To enable multi-threading, set WORKER_ENABLED=true');
            this.logger.warn('Reverting to single-threaded legacy mode.');

            // Let's still use the worker manager's accounts
            await this.workerManagerService.onModuleInit();
        }
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
                retried: {
                    count: workerStats.retriedInspections || 0,
                    successAfterRetry: workerStats.successAfterRetry || 0,
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
            },
            activeInspections: {
                count: workerStats.activeInspections || 0,
                avgTime: workerStats.avgInspectionTime || 0,
                details: workerStats.activeInspectionDetails || []
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

        if (this.queueService.isFull()) {
            throw new HttpException(
                `Queue is full (${this.queueService.size()}/${this.MAX_QUEUE_SIZE}), please try again later`,
                HttpStatus.TOO_MANY_REQUESTS
            );
        }

        return new Promise((resolve, reject) => {
            const timeoutId = setTimeout(() => {
                this.queueService.remove(a);
                this.timeouts++;
                reject(new HttpException('Inspection request timed out', HttpStatus.GATEWAY_TIMEOUT));
            }, this.QUEUE_TIMEOUT);

            // Add to queue before making the request
            this.queueService.add(a, {
                ms: m !== '0' && m ? m : s,
                d,
                resolve,
                reject,
                timeoutId,
                retryCount: 0,
                inspectUrl: { s, a, d, m }
            });

            // Try using the worker manager
            this.workerManagerService.inspectItem(s, a, d, m)
                .then(async (response) => {
                    clearTimeout(timeoutId);
                    this.success++;

                    try {
                        const formattedResponse = await this.handleInspectResult(response);
                        // Remove from queue after successful processing
                        this.queueService.remove(a);
                        this.logger.debug(`Successfully processed and removed item ${a} from queue`);
                        resolve(formattedResponse);
                    } catch (error) {
                        this.logger.error(`Error handling inspect result: ${error.message}`);
                        this.failed++;
                        // Ensure we remove the item from queue on error too
                        this.queueService.remove(a);
                        reject(new HttpException('Error processing inspection result', HttpStatus.INTERNAL_SERVER_ERROR));
                    }
                })
                .catch(error => {
                    this.logger.error(`Worker inspection error for asset ${a}: ${error.message}`);
                    this.failed++;
                    clearTimeout(timeoutId);
                    this.queueService.remove(a);
                    reject(new HttpException(
                        error.message || 'Inspection failed',
                        HttpStatus.GATEWAY_TIMEOUT
                    ));
                });
        });
    }

    private async handleInspectResult(response: any) {
        const inspectData = this.queueService.get(response.itemid?.toString());
        if (!inspectData) {
            this.logger.error(`No inspect data found for item ${response.itemid}`);
            throw new Error(`No inspect data found for item ${response.itemid}`);
        }

        try {
            // Start timing the response
            const startTime = Date.now();

            const uniqueId = this.generateUniqueId({
                paintSeed: response.paintseed,
                paintIndex: response.paintindex,
                paintWear: response.paintwear,
                defIndex: response.defindex,
                origin: response.origin,
                rarity: response.rarity,
                questId: response.questid,
                quality: response.quality,
                dropReason: response.dropreason
            });

            const history = await this.findHistory(response);
            await this.saveHistory(response, history, inspectData, uniqueId);
            const asset = await this.saveAsset(response, inspectData, uniqueId);

            const formattedResponse = await this.formatService.formatResponse(asset);
            return formattedResponse;
        } catch (error) {
            this.logger.error(`Failed to handle inspect result: ${error.message}`);
            throw error;
        } finally {
            // Cleanup will happen in the inspectItem method
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

    private async findHistory(response: any) {
        return await this.assetRepository.findOne({
            where: {
                paintWear: response.paintwear,
                paintIndex: response.paintindex,
                defIndex: response.defindex,
                paintSeed: response.paintseed,
                origin: response.origin,
                questId: response.questid,
                rarity: response.rarity,
            },
            order: {
                createdAt: 'DESC',
            },
        })
    }

    private async saveHistory(response: any, history: any, inspectData: any, uniqueId: string) {
        /*
        const existing = await this.historyRepository.findOne({
            where: {
                assetId: parseInt(response.itemid),
            },
        })

        if (!existing) {
            await this.historyRepository.upsert({
                uniqueId,
                assetId: parseInt(response.itemid),
                prevAssetId: history?.assetId,
                owner: inspectData.ms,
                prevOwner: history?.ms,
                d: inspectData.d,
                stickers: response.stickers,
                keychains: response.keychains,
                prevStickers: history?.stickers,
                prevKeychains: history?.keychains,
                type: this.getHistoryType(response, history, inspectData),
            }, ['assetId', 'uniqueId'])
        }
        */
    }

    private async saveAsset(response: any, inspectData: any, uniqueId: string) {
        await this.assetRepository.upsert({
            uniqueId,
            ms: inspectData.ms,
            d: inspectData.d,
            assetId: response.itemid,
            paintSeed: response.paintseed,
            paintIndex: response.paintindex,
            paintWear: response.paintwear,
            customName: response.customname,
            defIndex: response.defindex,
            origin: response.origin,
            rarity: response.rarity,
            questId: response.questid,
            stickers: response.stickers,
            quality: response.quality,
            keychains: response.keychains,
            killeaterScoreType: response.killeaterscoretype,
            killeaterValue: response.killeatervalue,
            inventory: response.inventory,
            petIndex: response.petindex,
            musicIndex: response.musicindex,
            entIndex: response.entindex,
            dropReason: response.dropreason,
        }, ['assetId'])

        return await this.assetRepository.findOne({
            where: {
                assetId: parseInt(response.itemid),
            },
        })
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
        const values = [
            item.paintSeed || 0,
            item.paintIndex || 0,
            item.paintWear || 0,
            item.defIndex || 0,
            item.origin || 0,
            item.rarity || 0,
            item.questId || 0,
            item.quality || 0,
            item.dropReason || 0
        ]
        const stringToHash = values.join('-')
        return createHash('sha1').update(stringToHash).digest('hex').substring(0, 8)
    }

    // Implement the remaining methods (findHistory, saveHistory, getHistoryType, etc.)
    // They can remain mostly unchanged since they don't involve bot management

    // ... (rest of the existing service methods for history handling)
}
