import {
    HttpException,
    HttpStatus,
    Injectable,
    Logger,
    OnModuleInit,
} from '@nestjs/common'
import { ParseService } from './parse.service'
import { InjectRepository } from '@nestjs/typeorm'
import { Asset } from 'src/entities/asset.entity'
import { History, HistoryType } from 'src/entities/history.entity'
import { Repository } from 'typeorm'
import { FormatService } from './format.service'
import { InspectDto } from './inspect.dto'
import { createHash } from 'crypto'
import { QueueService } from './queue.service'
import { WorkerManagerService } from './worker/worker-manager.service'

@Injectable()
export class InspectService implements OnModuleInit {
    private readonly logger = new Logger(InspectService.name)
    private startTime: number = Date.now()
    private readonly QUEUE_TIMEOUT = parseInt(process.env.QUEUE_TIMEOUT || '10000') // 5 seconds timeout
    private readonly MAX_QUEUE_SIZE = parseInt(process.env.MAX_QUEUE_SIZE || '100')

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

    private currentRequests = 0
    private success = 0
    private cached = 0
    private failed = 0
    private timeouts = 0

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

    public stats() {
        const stats = this.workerManagerService.getStats();

        // Calculate uptime
        const uptime = Date.now() - this.startTime;
        const days = Math.floor(uptime / (24 * 60 * 60 * 1000));
        const hours = Math.floor((uptime % (24 * 60 * 60 * 1000)) / (60 * 60 * 1000));
        const minutes = Math.floor((uptime % (60 * 60 * 1000)) / (60 * 1000));
        const seconds = Math.floor((uptime % (60 * 1000)) / 1000);

        // Get response time stats and metrics from the correct path
        const responseTimeStats = stats.responseTimeStats;
        const metrics = stats.metrics;

        // Return a clean, well-organized stats structure
        return {
            uptime: `${days}d ${hours}h ${minutes}m ${seconds}s`,
            service: {
                status: stats.readyBots > 0 ? 'healthy' : 'initializing',
                version: process.env.npm_package_version || 'unknown',
                bots: {
                    total: stats.totalBots,
                    ready: stats.readyBots,
                    busy: stats.busyBots,
                    error: stats.errorBots,
                    cooldown: stats.cooldownBots,
                    disconnected: stats.disconnectedBots,
                    availabilityPercentage: stats.botAvailabilityPercentage.toFixed(2) + '%',
                },
                queue: {
                    current: this.inspects.size,
                    max: this.MAX_QUEUE_SIZE,
                },
            },
            inspections: {
                total: metrics.success + metrics.failed + metrics.timeouts,
                success: metrics.success,
                cached: metrics.cached,
                failed: metrics.failed,
                timeouts: metrics.timeouts,
                activeCount: stats.activeInspections,
                successRate: metrics.success > 0
                    ? (metrics.success / (metrics.success + metrics.failed + metrics.timeouts) * 100).toFixed(2) + '%'
                    : '0%',
                retries: {
                    total: metrics.retriedInspections || 0,
                    successfulAfterRetry: metrics.successAfterRetry || 0
                }
            },
            performance: {
                allTime: responseTimeStats.allTime,
                last5Minutes: responseTimeStats.recent
            },
            // Include detailed info for administrators
            details: {
                botStatus: metrics.botDetails || [],
                activeInspections: metrics.activeInspectionDetails || []
            }
        };
    }

    public async inspectItem(query: InspectDto) {
        this.currentRequests++;

        const { s, a, d, m } = this.parseService.parse(query);

        // First check if we have cached data before checking bot availability
        if (!query.refresh) {
            const cachedAsset = await this.checkCache(a, d);
            if (cachedAsset) {
                this.cached++;
                this.workerManagerService.incrementCached();
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
    }

    private getHistoryType(response: any, history: any, inspectData: any): HistoryType {
        if (!history) {
            if (response.origin === 8) return HistoryType.TRADED_UP
            if (response.origin === 4) return HistoryType.DROPPED
            if (response.origin === 1) return HistoryType.PURCHASED_INGAME
            if (response.origin === 2) return HistoryType.UNBOXED
            if (response.origin === 3) return HistoryType.CRAFTED
            return HistoryType.UNKNOWN
        }

        if (history?.owner !== inspectData?.ms) {
            if (history?.owner?.startsWith('7656')) {
                return HistoryType.TRADE
            }
            if (history?.owner && !history?.owner?.startsWith('7656')) {
                return HistoryType.MARKET_BUY
            }
        }

        if (history?.owner && history.owner.startsWith('7656') && !inspectData?.ms?.startsWith('7656')) {
            return HistoryType.MARKET_LISTING
        }

        if (history.owner === inspectData.ms) {
            const stickerChanges = this.detectStickerChanges(response.stickers, history.stickers)
            if (stickerChanges) return stickerChanges

            const keychainChanges = this.detectKeychainChanges(response.keychains, history.keychains)
            if (keychainChanges) return keychainChanges
        }

        if (response.customname !== history.customName) {
            return response.customname ? HistoryType.NAMETAG_ADDED : HistoryType.NAMETAG_REMOVED
        }

        return HistoryType.UNKNOWN
    }


    private detectStickerChanges(currentStickers: any[], previousStickers: any[]): HistoryType | null {
        if (!currentStickers || !previousStickers) return null

        // Check if stickers have been added or removed
        if (currentStickers.length > previousStickers.length) {
            return HistoryType.STICKER_APPLY
        }

        if (currentStickers.length < previousStickers.length) {
            return HistoryType.STICKER_REMOVE
        }

        // If the count is the same, check for position or wear changes
        for (const current of currentStickers) {
            // [{"slot": 2, "wear": 0.6399999856948853, "scale": null, "pattern": null, "tint_id": null, "offset_x": -0.5572507381439209, "offset_y": -0.019832462072372437, "offset_z": null, "rotation": null, "sticker_id": 8541}]
            // Find matching sticker in previous collection based on position
            const previous = previousStickers.find(
                prev => prev.offset_x === current.offset_x &&
                    prev.offset_y === current.offset_y &&
                    prev.offset_z === current.offset_z &&
                    prev.rotation === current.rotation &&
                    prev.slot === current.slot &&
                    prev.sticker_id === current.sticker_id
            )

            // No matching sticker found at this position - indicates change
            if (!previous) {
                if (currentStickers.length === previousStickers.length) {
                    return HistoryType.STICKER_CHANGE
                }

                return HistoryType.STICKER_REMOVE
            }

            // Sticker found but wear value changed
            if (previous && current.wear !== previous.wear) {
                // Higher wear value means more scraped
                if (current.wear > previous.wear) {
                    return HistoryType.STICKER_SCRAPE
                }
                return HistoryType.STICKER_CHANGE
            }
        }

        return null
    }

    private detectKeychainChanges(currentKeychains: any[], previousKeychains: any[]): HistoryType | null {
        if (!currentKeychains || !previousKeychains) return null

        if (currentKeychains.length === 0 && previousKeychains.length > 0) {
            return HistoryType.KEYCHAIN_REMOVED
        }
        if (currentKeychains.length > 0 && previousKeychains.length === 0) {
            return HistoryType.KEYCHAIN_ADDED
        }
        if (JSON.stringify(currentKeychains) !== JSON.stringify(previousKeychains)) {
            return HistoryType.KEYCHAIN_CHANGED
        }
        return null
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
