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
    ) { }

    async onModuleInit() {
        this.logger.debug('Starting Inspect Module...')
        this.accounts = await this.loadAccounts()
        this.initializeAllBots()
    }

    private async loadAccounts(): Promise<string[]> {
        let accounts: string[] = []
        const accountsFile = process.env.ACCOUNTS_FILE || 'accounts.txt'

        try {
            if (fs.existsSync(accountsFile)) {
                accounts = fs.readFileSync(accountsFile, 'utf8').split('\n')
            } else {
                const fallbackLocations = [
                    'accounts.txt',
                    '../accounts.txt',
                    '/app/accounts.txt'
                ]

                for (const location of fallbackLocations) {
                    if (fs.existsSync(location)) {
                        accounts = fs.readFileSync(location, 'utf8').split('\n')
                        this.logger.debug(`Found accounts file at: ${location}`)
                        break
                    }
                }

                if (accounts.length === 0) {
                    throw new Error(`No accounts file found at ${accountsFile} or fallback locations`)
                }
            }

            accounts = accounts
                .map(account => account.trim())
                .filter(account => account.length > 0)

            if (accounts.length === 0) {
                throw new Error('No valid accounts found in accounts file')
            }

            // Randomize the accounts array
            accounts = accounts.sort(() => Math.random() - 0.5)

            this.logger.debug(`Loaded ${accounts.length} accounts`)
            return accounts

        } catch (error) {
            this.logger.error(`Failed to load accounts: ${error.message}`)
            throw error
        }
    }

    private async initializeAllBots() {
        const BATCH_SIZE = parseInt(process.env.BATCH_SIZE || '100');
        const MAX_RETRIES = parseInt(process.env.MAX_RETRIES || '3');

        const sessionPath = process.env.SESSION_PATH || './sessions';
        if (!fs.existsSync(sessionPath)) {
            fs.mkdirSync(sessionPath, { recursive: true });
            this.logger.debug(`Created session directory at: ${sessionPath}`);
        }

        for (let i = 0; i < this.accounts.length; i += BATCH_SIZE) {
            const batch = this.accounts.slice(i, i + BATCH_SIZE);
            const initPromises = batch.map(async (account) => {
                const [username, password] = account.split(':');

                // Check if account is throttled
                const throttleExpiry = this.throttledAccounts.get(username);
                if (throttleExpiry && Date.now() < throttleExpiry) {
                    this.logger.warn(`Account ${username} is throttled. Skipping initialization.`);
                    return;
                }

                let retryCount = 0;
                let initialized = false;

                while (retryCount < MAX_RETRIES && !initialized) {
                    try {
                        const bot = new Bot({
                            username,
                            password,
                            proxyUrl: process.env.PROXY_URL,
                            debug: process.env.DEBUG === 'true',
                            sessionPath,
                            blacklistPath: process.env.BLACKLIST_PATH || './blacklist.txt',
                        });

                        bot.on('inspectResult', (response) => this.handleInspectResult(username, response));
                        bot.on('error', (error) => {
                            this.logger.error(`Bot ${username} error: ${error}`);
                        });

                        await bot.initialize();
                        this.bots.set(username, bot);
                        this.logger.debug(`Bot ${username} initialized successfully`);
                        initialized = true;
                        // Clear throttle status if successful
                        this.throttledAccounts.delete(username);

                    } catch (error) {
                        if (error.message === 'ACCOUNT_DISABLED') {
                            this.logger.error(`Account ${username} is disabled. Blacklisting...`);
                            this.accounts = this.accounts.filter(acc => !acc.startsWith(username));
                            break;
                        } else if (error.message === 'LOGIN_THROTTLED') {
                            this.logger.warn(`Account ${username} is throttled. Adding to cooldown.`);
                            this.throttledAccounts.set(username, Date.now() + this.THROTTLE_COOLDOWN);
                            break;
                        } else if (error.message === 'INITIALIZATION_ERROR') {
                            this.logger.warn(`Initialization timeout for bot ${username}. Retrying...`);
                            if (retryCount >= MAX_RETRIES) {
                                this.logger.error(`Max retries reached for bot ${username}. Initialization failed.`);
                            }
                        } else {
                            this.logger.error(`Failed to initialize bot ${username}: ${error.message}`);
                        }
                        retryCount++;
                    }
                }
            });

            await Promise.allSettled(initPromises);
            this.logger.debug(`Initialized batch of ${batch.length} bots (${i + batch.length}/${this.accounts.length} total)`);
        }

        this.logger.debug(`Finished initializing ${this.bots.size} bots`);
    }

    public stats() {
        const readyBots = Array.from(this.bots.values()).filter(bot => bot.isReady()).length
        const busyBots = Array.from(this.bots.values()).filter(bot => bot.isBusy()).length
        const cooldownBots = Array.from(this.bots.values()).filter(bot => bot.isCooldown()).length
        const disconnectedBots = Array.from(this.bots.values()).filter(bot => bot.isDisconnected()).length
        const errorBots = Array.from(this.bots.values()).filter(bot => bot.isError()).length
        const initializingBots = Array.from(this.bots.values()).filter(bot => bot.isInitializing()).length
        const totalBots = this.bots.size
        const queueUtilization = (this.inspects.size / this.MAX_QUEUE_SIZE) * 100

        // Calculate uptime
        const uptime = Date.now() - this.startTime
        const days = Math.floor(uptime / (24 * 60 * 60 * 1000))
        const hours = Math.floor((uptime % (24 * 60 * 60 * 1000)) / (60 * 60 * 1000))
        const minutes = Math.floor((uptime % (60 * 60 * 1000)) / (60 * 1000))
        const seconds = Math.floor((uptime % (60 * 1000)) / 1000)

        // Calculate average processing time
        const activeInspects = Array.from(this.inspects.values())
        const processingTimes = activeInspects
            .filter(inspect => inspect.startTime)
            .map(inspect => Date.now() - inspect.startTime)
        const avgProcessingTime = processingTimes.length > 0
            ? processingTimes.reduce((a, b) => a + b, 0) / processingTimes.length
            : 0

        // Get queue details
        const queueItems = Array.from(this.inspects.entries()).map(([assetId, inspect]) => ({
            assetId,
            elapsedTime: inspect.startTime ? Date.now() - inspect.startTime : 0,
            retryCount: inspect.retryCount || 0
        }));

        return {
            status: this.bots.size > 0 ? 'ready' : 'initializing',
            uptime: {
                days,
                hours,
                minutes,
                seconds,
                formatted: `${days}d ${hours}h ${minutes}m ${seconds}s`
            },
            bots: {
                ready: readyBots,
                busy: busyBots,
                cooldown: cooldownBots,
                disconnected: disconnectedBots,
                error: errorBots,
                initializing: initializingBots,
                total: totalBots,
                utilization: (totalBots > 0 ? (busyBots / totalBots) * 100 : 0).toFixed(2) + '%'
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
                avgProcessingTime: Math.round(avgProcessingTime) + 'ms',
                items: queueItems
            },
        }
    }

    public async inspectItem(query: InspectDto) {
        this.currentRequests++;

        if (this.queueService.isFull()) {
            throw new HttpException(
                `Queue is full (${this.queueService.size()}/${this.MAX_QUEUE_SIZE}), please try again later`,
                HttpStatus.TOO_MANY_REQUESTS
            );
        }

        const { s, a, d, m } = this.parseService.parse(query);

        // Add debug logging
        // this.logger.debug(`Processing inspect request for asset ${a}`);

        // Handle cache check
        if (!query.refresh) {
            const cachedAsset = await this.checkCache(a, d);
            if (cachedAsset) {
                this.cached++;
                return cachedAsset;
            }
        }

        return new Promise((resolve, reject) => {
            const attemptInspection = async (retryCount = 0) => {
                const bot = await this.getAvailableBot();
                if (!bot) {
                    return reject(new HttpException('No bots are ready', HttpStatus.FAILED_DEPENDENCY));
                }

                const timeoutId = setTimeout(async () => {
                    if (retryCount < this.MAX_RETRIES) {
                        this.logger.error(`Inspection timeout for asset ${a}, retry ${retryCount + 1}`);
                        this.queueService.remove(a);
                        await attemptInspection(retryCount + 1);
                    } else {
                        this.logger.error(`Max retries reached for asset ${a}`);
                        this.queueService.remove(a);
                        this.failed++;
                        reject(new HttpException('Inspection request timed out after retries', HttpStatus.GATEWAY_TIMEOUT));
                    }
                }, this.QUEUE_TIMEOUT);

                // Add to queue before making the request
                this.queueService.add(a, {
                    ms: m !== '0' && m ? m : s,
                    d,
                    resolve,
                    reject,
                    timeoutId,
                    retryCount,
                    inspectUrl: { s, a, d, m }
                });

                try {
                    // this.logger.debug(`Sending inspect request for asset ${a} to bot`);
                    await bot.inspectItem(s !== '0' ? s : m, a, d);
                } catch (error) {
                    this.logger.error(`Bot inspection error for asset ${a}: ${error.message}`);
                    if (retryCount < this.MAX_RETRIES) {
                        this.queueService.remove(a);
                        await attemptInspection(retryCount + 1);
                    } else {
                        this.queueService.remove(a);
                        this.failed++;
                        reject(new HttpException(error.message, HttpStatus.GATEWAY_TIMEOUT));
                    }
                }
            };

            attemptInspection();
        });
    }

    private async getAvailableBot(): Promise<Bot | null> {
        const readyBots = Array.from(this.bots.entries())
            .filter(([_, bot]) => bot.isReady())

        if (readyBots.length === 0) {
            return null
        }

        // Get the next available bot using the total number of bots
        const startIndex = this.nextBot
        let attempts = 0

        // Try finding an available bot, starting from the next position
        while (attempts < this.bots.size) {
            const currentIndex = (startIndex + attempts) % this.bots.size
            const bot = Array.from(this.bots.values())[currentIndex]

            if (bot && bot.isReady()) {
                this.nextBot = (currentIndex + 1) % this.bots.size
                return bot
            }

            attempts++
        }

        // If we get here, return the first available bot
        return readyBots[0][1] // Extract the Bot from the [string, Bot] tuple
    }

    @Cron('* * * * * *')
    private handleRequestMetrics() {
        this.requests.push(this.currentRequests)
        this.currentRequests = 0
        if (this.requests.length > 60) {
            this.requests.shift()
        }
    }

    private async checkCache(assetId: string, d: string): Promise<any> {
        const asset = await this.assetRepository.findOne({
            where: {
                assetId: parseInt(assetId),
                d,
            },
        })

        if (asset) {
            return this.formatService.formatResponse(asset)
        }
        return null
    }

    private async handleInspectResult(username: string, response: any) {
        // Add debug logging
        // this.logger.debug(`Received inspect result for item ${response.itemid} from bot ${username}`);

        const inspectData = this.queueService.get(response.itemid.toString());  // Ensure string conversion
        if (!inspectData) {
            this.logger.error(`No inspect data found for item ${response.itemid}. Queue size: ${this.queueService.size()}`);
            this.logger.debug(`Current queue items: ${JSON.stringify(Array.from(this.queueService.getQueueMetrics().items))}`);
            return;
        }

        try {
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
            this.success++;

            inspectData.resolve(formattedResponse);
        } catch (error) {
            this.logger.error(`Failed to handle inspect result: ${error.message}`);
            if (!(error instanceof HttpException)) {
                this.failed++;
            }
            inspectData.reject(error);
        } finally {
            if (inspectData.timeoutId) {
                clearTimeout(inspectData.timeoutId);
            }
            this.queueService.remove(response.itemid.toString());  // Ensure string conversion
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

        for (const slot of [0, 1, 2, 3, 4]) {
            const current = currentStickers.find(s => s.slot === slot)
            const previous = previousStickers.find(s => s.slot === slot)

            if (!current && previous) return HistoryType.STICKER_REMOVE
            if (current && !previous) return HistoryType.STICKER_APPLY
            if (current && previous && current.stickerId !== previous.stickerId) {
                if (current.stickerId === previous.stickerId && current.wear > previous.wear) {
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

    @Cron('*/30 * * * * *')
    private async cleanupStaleRequests() {
        const staleRequests = this.queueService.getStaleRequests();
        for (const [assetId, request] of staleRequests) {
            this.queueService.remove(assetId);
            this.failed++;
            this.logger.warn(`Cleaned up stale request for asset ${assetId}`);
        }
    }

    @Cron('*/5 * * * *') // Run every 5 minutes
    private cleanupThrottledAccounts() {
        const now = Date.now();
        for (const [username, expiry] of this.throttledAccounts.entries()) {
            if (now >= expiry) {
                this.throttledAccounts.delete(username);
                this.logger.debug(`Removed ${username} from throttle list`);
            }
        }
    }

    @Cron('*/1 * * * *') // Run every minute
    private async checkBotsHealth() {
        const readyBots = Array.from(this.bots.values()).filter(bot => bot.isReady()).length;
        const busyBots = Array.from(this.bots.values()).filter(bot => bot.isBusy()).length;
        const cooldownBots = Array.from(this.bots.values()).filter(bot => bot.isCooldown()).length;
        const errorBots = Array.from(this.bots.values()).filter(bot => bot.isError()).length;
        const disconnectedBots = Array.from(this.bots.values()).filter(bot => bot.isDisconnected()).length;

        const totalBots = this.bots.size;
        const expectedBots = this.accounts.length;

        // Consider both ready and temporarily occupied (busy/cooldown) bots as "active"
        const activeBots = readyBots + busyBots + cooldownBots;
        const botRatio = activeBots / expectedBots;
        const isBotRatioLow = botRatio < this.MIN_BOT_RATIO;

        // If we have too many error or disconnected bots
        const problematicBots = errorBots + disconnectedBots;
        const isHighErrorRate = (problematicBots / totalBots) > 0.3; // More than 30% problematic

        if ((activeBots === 0 || isBotRatioLow || isHighErrorRate) && totalBots > 0) {
            const timeSinceHealthy = Date.now() - this.lastHealthyTime;

            this.logger.warn(
                `Unhealthy bot state!\n` +
                `Ready: ${readyBots}, Busy: ${busyBots}, Cooldown: ${cooldownBots}\n` +
                `Error: ${errorBots}, Disconnected: ${disconnectedBots}\n` +
                `Active ratio: ${(botRatio * 100).toFixed(1)}% (${activeBots}/${expectedBots})\n` +
                `Last healthy: ${Math.floor(timeSinceHealthy / 1000)}s ago`
            );

            // Only attempt recovery if:
            // 1. We've been unhealthy for more than the threshold
            // 2. We're not already recovering
            // 3. We have accounts configured
            // 4. We have actual problems (not just temporary busy/cooldown states)
            const needsRecovery = (
                activeBots === 0 ||
                isHighErrorRate ||
                (isBotRatioLow && (errorBots > 0 || disconnectedBots > 0))
            );

            if (timeSinceHealthy > this.HEALTH_CHECK_THRESHOLD && !this.isRecovering && this.accounts.length > 0 && needsRecovery) {
                await this.recoverBots();
            }
        } else if (activeBots > 0 && !isBotRatioLow && !isHighErrorRate) {
            this.lastHealthyTime = Date.now();
        }
    }

    private async recoverBots() {
        try {
            this.isRecovering = true;
            this.logger.warn('Starting bot recovery process...');

            // Destroy all existing bots
            const destroyPromises = Array.from(this.bots.values()).map(bot => bot.destroy());
            await Promise.allSettled(destroyPromises);

            // Clear the bots map
            this.bots.clear();

            // Wait a bit before reinitializing
            await new Promise(resolve => setTimeout(resolve, 5000));

            // Reinitialize bots
            await this.initializeAllBots();

            this.logger.log(`Recovery complete. ${this.bots.size} bots reinitialized`);
        } catch (error) {
            this.logger.error(`Recovery failed: ${error.message}`);
        } finally {
            this.isRecovering = false;
        }
    }
}
