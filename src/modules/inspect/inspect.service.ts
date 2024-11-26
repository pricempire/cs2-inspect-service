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
import { PricempireService } from '../pricempire/pricempire.service'
import { HttpService } from '@nestjs/axios'
import { Cron } from '@nestjs/schedule'
import { InspectDto } from './inspect.dto'
import { Bot } from './bot.class'
import { createHash } from 'crypto';

@Injectable()
export class InspectService implements OnModuleInit {
    private readonly logger = new Logger(InspectService.name)
    private bots: Map<string, Bot> = new Map()
    private accounts: string[] = []
    private inspects: Map<string, { ms: string; d: string; resolve: (value: any) => void; reject: (reason?: any) => void; timeoutId: NodeJS.Timeout; startTime?: number; retryCount?: number }> = new Map()
    private nextBot = 0
    private currentRequests = 0
    private requests: number[] = []
    private initializedBots = 0
    private maxConcurrentBots = 120 // Initial bot count
    private botsToAddWhenNeeded = 50 // Number of bots to add when needed
    private botLastUsedTime: Map<string, number> = new Map() // Track last usage time
    private readonly BOT_INACTIVE_THRESHOLD = 15 * 60 * 1000 // 15 minutes in milliseconds
    private readonly BOT_INIT_DELAY = 10; // 5 seconds delay between bot initializations

    private success = 0
    private cached = 0
    private failed = 0

    private initializationInProgress = false;
    private readonly DEBOUNCE_DELAY = 10000; // 10 seconds debounce
    private lastInitializationTime = 0;

    private readonly QUEUE_TIMEOUT = 30000; // 30 seconds timeout
    private readonly MAX_RETRIES = 2; // Add max retries constant

    // Add new property to track initial bots ready state
    private initialBotsReady = false;

    constructor(
        private parseService: ParseService,
        private formatService: FormatService,
        @InjectRepository(Asset)
        private assetRepository: Repository<Asset>,
        @InjectRepository(History)
        private historyRepository: Repository<History>,
        private readonly pricempireService: PricempireService,
        private readonly httpService: HttpService,
    ) { }

    async onModuleInit() {
        this.logger.debug('Starting Inspect Module...')
        this.accounts = await this.loadAccounts()

        if (this.maxConcurrentBots > this.accounts.length) {
            this.maxConcurrentBots = this.accounts.length
        }

        // Initialize minimum number of bots with delay
        for (let i = 0; i < this.maxConcurrentBots; i++) {
            if (this.accounts[i]) {
                const [username, password] = this.accounts[i].split(':')
                await this.initializeBot(username, password)
                // Add delay between initializations
                await new Promise(resolve => setTimeout(resolve, this.BOT_INIT_DELAY))
            }
        }

        // Set initial bots as ready if we have enough ready bots

        let iv = setInterval(() => {
            const readyBots = Array.from(this.bots.values()).filter(bot => bot.isReady()).length;
            this.initialBotsReady = readyBots >= this.maxConcurrentBots * 0.6; // 60% of bots should be ready
            if (this.initialBotsReady) {
                clearInterval(iv)
            }
        }, 1000)
    }

    /**
     * Get stats
     * @returns 
     */
    public stats() {
        const readyBots = Array.from(this.bots.values()).filter(bot => bot.isReady()).length
        const busyBots = Array.from(this.bots.values()).filter(bot => !bot.isReady()).length
        const totalBots = this.bots.size
        const queueUtilization = (this.inspects.size / this.MAX_QUEUE_SIZE) * 100

        // Calculate average request processing time
        const activeInspects = Array.from(this.inspects.values())
        const processingTimes = activeInspects
            .filter(inspect => inspect.startTime)
            .map(inspect => Date.now() - inspect.startTime)
        const avgProcessingTime = processingTimes.length > 0
            ? processingTimes.reduce((a, b) => a + b, 0) / processingTimes.length
            : 0

        return {
            status: this.initialBotsReady ? 'ready' : 'initializing',
            bots: {
                ready: readyBots,
                busy: busyBots,
                total: totalBots,
                initialized: this.initializedBots,
                maxConcurrent: this.maxConcurrentBots,
                utilization: (totalBots > 0 ? (busyBots / totalBots) * 100 : 0).toFixed(2) + '%'
            },
            queue: {
                current: this.inspects.size,
                max: this.MAX_QUEUE_SIZE,
                utilization: queueUtilization.toFixed(2) + '%',
                avgProcessingTime: Math.round(avgProcessingTime) + 'ms'
            },
            metrics: {
                success: {
                    rate: ((this.success / (this.success + this.failed + this.cached)) * 100).toFixed(2) + '%',
                    count: this.success,
                },
                cached: {
                    rate: ((this.cached / (this.success + this.failed + this.cached)) * 100).toFixed(2) + '%',
                    count: this.cached,
                },
                failed: {
                    rate: ((this.failed / (this.success + this.failed + this.cached)) * 100).toFixed(2) + '%',
                    count: this.failed,
                },
                total: this.success + this.failed + this.cached
            },
            requests: {
                history: this.requests,
                current: this.currentRequests,
                average: this.requests.length > 0
                    ? (this.requests.reduce((a, b) => a + b, 0) / this.requests.length).toFixed(2)
                    : 0
            }
        }
    }

    /**
     * Inspect an item
     * @param query 
     * @returns 
     */
    public async inspectItem(query: InspectDto) {
        // Add check for initial bots ready state
        if (!this.initialBotsReady) {
            throw new HttpException(
                'Service is still initializing, please try again later',
                HttpStatus.SERVICE_UNAVAILABLE
            )
        }

        if (this.inspects.size >= this.MAX_QUEUE_SIZE) {
            throw new HttpException(
                `Queue is full (${this.inspects.size}/${this.MAX_QUEUE_SIZE}), please try again later`,
                HttpStatus.TOO_MANY_REQUESTS
            )
        }

        this.currentRequests++

        const { s, a, d, m } = this.parseService.parse(query)

        // Handle Pricempire ping
        if (process.env.PING_PRICEMPIRE === 'true') {
            this.pricempireService.ping({ s, a, d, m })
        }

        // Check cache if refresh not requested
        if (!query.refresh) {
            const cachedAsset = await this.checkCache(a, d)
            if (cachedAsset) {
                this.cached++
                return cachedAsset
            }
        } else if (process.env.ALLOW_REFRESH === 'false') {
            throw new HttpException('Refresh is not allowed', HttpStatus.FORBIDDEN)
        }

        const resultPromise = new Promise((resolve, reject) => {
            const attemptInspection = async (retryCount = 0) => {
                const bot = await this.getAvailableBot()
                if (!bot) {
                    // Check cache one more time before failing
                    const cachedAsset = await this.checkCache(a, d)
                    if (cachedAsset) {
                        this.cached++
                        return resolve(cachedAsset)
                    }
                    return reject(new HttpException('No bots are ready', HttpStatus.FAILED_DEPENDENCY))
                }

                // Add logging for debugging
                this.logger.debug(`Starting inspection attempt ${retryCount + 1} for asset ${a} with bot ${bot.username}`);

                const timeoutId = setTimeout(async () => {
                    this.logger.warn(`Timeout triggered for asset ${a} on attempt ${retryCount + 1}`);
                    if (retryCount < this.MAX_RETRIES) {
                        this.logger.warn(`Inspection request timed out with bot ${bot.username}, attempting retry ${retryCount + 1} for asset ${a}`);
                        clearTimeout(timeoutId);
                        this.inspects.delete(a);
                        await attemptInspection(retryCount + 1);
                    } else {
                        this.inspects.delete(a);
                        this.failed++;
                        reject(new HttpException('Inspection request timed out after retries', HttpStatus.GATEWAY_TIMEOUT));
                    }
                }, this.QUEUE_TIMEOUT);

                this.inspects.set(a, {
                    ms: m !== '0' ? m : s,
                    d,
                    resolve: (value: any) => {
                        clearTimeout(timeoutId);
                        resolve(value);
                    },
                    reject: (reason?: any) => {
                        this.logger.warn(`Rejecting inspection for asset ${a}: ${reason}`);
                        clearTimeout(timeoutId);
                        reject(reason);
                    },
                    timeoutId,
                    startTime: Date.now(),
                    retryCount,
                });

                try {
                    await bot.inspectItem(s !== '0' ? s : m, a, d);
                } catch (error) {
                    this.logger.error(`Bot inspection failed for asset ${a}: ${error.message}`);
                    if (retryCount < this.MAX_RETRIES) {
                        this.logger.warn(`Bot inspection failed, attempting retry ${retryCount + 1} for asset ${a}`);
                        clearTimeout(timeoutId);
                        this.inspects.delete(a);
                        await attemptInspection(retryCount + 1);
                    } else {
                        const inspect = this.inspects.get(a);
                        if (inspect?.timeoutId) {
                            clearTimeout(inspect.timeoutId);
                        }
                        this.failed++;
                        this.inspects.delete(a);
                        reject(new HttpException(error.message, HttpStatus.GATEWAY_TIMEOUT));
                    }
                }
            };

            attemptInspection();
        });

        return resultPromise;
    }
    /**
     * Load accounts
     * @returns 
     */
    private async loadAccounts(): Promise<string[]> {
        let accounts: string[] = []
        const accountsFile = process.env.ACCOUNTS_FILE || 'accounts.txt'

        try {
            if (fs.existsSync(accountsFile)) {
                accounts = fs.readFileSync(accountsFile, 'utf8').split('\n')
            } else {
                // Try common fallback locations
                const fallbackLocations = [
                    'accounts.txt',
                    '../accounts.txt',
                    '/app/accounts.txt'
                ]

                for (const location of fallbackLocations) {
                    if (fs.existsSync(location)) {
                        accounts = fs.readFileSync(location, 'utf8').split('\n')
                        this.logger.debug(`Found accounts file at fallback location: ${location}`)
                        break
                    }
                }

                if (accounts.length === 0) {
                    throw new Error(`No accounts file found at ${accountsFile} or fallback locations`)
                }
            }

            // Filter out empty lines and trim whitespace
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

    /**
     * Initialize a bot
     * @param username 
     * @param password 
     */
    private async initializeBot(username: string, password: string) {
        try {
            // Calculate which session this bot should use 
            const proxyUrl = process.env.PROXY_URL

            const bot = new Bot(
                username,
                password,
                proxyUrl,
                (response) => this.handleInspectResult(username, response)
            )

            await bot.initialize()
            this.bots.set(username, bot)
            this.botLastUsedTime.set(username, Date.now())
            this.initializedBots++
            this.logger.debug(`Bot ${username} initialized successfully`)
        } catch (error) {
            this.logger.error(`Failed to initialize bot ${username}: ${error.message}`)
        }
    }

    /**
     * Initialize additional bots with debounce
     * @returns 
     */
    private async initializeAdditionalBots() {
        // Check if initialization is already in progress
        if (this.initializationInProgress) {
            // this.logger.debug('Bot initialization already in progress, skipping...');
            return [];
        }

        // Check debounce time
        const now = Date.now();
        if (now - this.lastInitializationTime < this.DEBOUNCE_DELAY) {
            // this.logger.debug('Initialization requested too soon, skipping...');
            return [];
        }

        try {
            this.initializationInProgress = true;
            this.lastInitializationTime = now;

            const botsToAdd = Math.min(
                this.botsToAddWhenNeeded,
                this.accounts.length - this.initializedBots
            )

            this.logger.debug(`Initializing ${botsToAdd} additional bots...`);

            const newBots: Bot[] = []
            for (let i = 0; i < botsToAdd; i++) {
                const nextAccountIndex = this.initializedBots
                if (nextAccountIndex >= this.accounts.length) break

                const [username, password] = this.accounts[nextAccountIndex].split(':')
                await this.initializeBot(username, password)
                await new Promise(resolve => setTimeout(resolve, this.BOT_INIT_DELAY))
                const newBot = this.bots.get(username)
                if (newBot) newBots.push(newBot)
            }

            return newBots.filter(bot => bot?.isReady())
        } finally {
            this.initializationInProgress = false;
        }
    }

    /**
     * Get an available bot
     * @returns 
     */
    private async getAvailableBot(): Promise<Bot | null> {
        const readyBots = Array.from(this.bots.entries())
            .filter(([_, bot]) => bot.isReady())

        if (readyBots.length === 0) {
            // If no bots are ready and we haven't initialized all accounts
            if (this.initializedBots < this.accounts.length) {
                const newBots = await this.initializeAdditionalBots()
                if (newBots.length > 0) {
                    return newBots[0] // Return the first new bot
                }
            }
            return null
        }

        // Round-robin selection
        const [username, bot] = readyBots[this.nextBot % readyBots.length]
        this.nextBot = (this.nextBot + 1) % readyBots.length

        // Update last used time
        this.botLastUsedTime.set(username, Date.now())

        return bot
    }

    /**
     * Handle request metrics
     */
    @Cron('* * * * * *')
    private async handleRequestMetrics() {
        this.requests.push(this.currentRequests)
        this.currentRequests = 0
        if (this.requests.length > 60) {
            this.requests.shift()
        }
    }

    /**
     * Cleanup inactive bots
     */
    @Cron('0 * * * * *') // Run every minute
    private async cleanupInactiveBots() {
        const now = Date.now()
        const botsToRemove: string[] = []

        // Find inactive bots
        this.botLastUsedTime.forEach((lastUsed, username) => {
            if (now - lastUsed > this.BOT_INACTIVE_THRESHOLD) {
                botsToRemove.push(username)
            }
        })

        // Remove inactive bots
        for (const username of botsToRemove) {
            const bot = this.bots.get(username)
            if (bot) {
                try {
                    await bot.destroy() // Assuming there's a destroy method in Bot class
                    this.bots.delete(username)
                    this.botLastUsedTime.delete(username)
                    this.initializedBots--
                    this.logger.debug(`Removed inactive bot ${username}`)
                } catch (error) {
                    this.logger.error(`Failed to remove bot ${username}: ${error.message}`)
                }
            }
        }
    }

    /**
     * Check cache
     * @param assetId 
     * @param d 
     * @returns 
     */
    private async checkCache(assetId: string, d: string): Promise<any> {
        const asset = await this.assetRepository.findOne({
            where: {
                assetId: parseInt(assetId),
                d,
            },
        })

        if (asset) {
            this.cached++
            return this.formatService.formatResponse(asset)
        }
        return null
    }

    /**
     * Handle inspect result
     * @param username 
     * @param response 
     */
    private async handleInspectResult(username: string, response: any) {
        const inspectData = this.inspects.get(response.itemid)
        if (!inspectData) {
            this.logger.error(`No inspect data found for item ${response.itemid}`)
            return
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
            // Find history
            const history = await this.findHistory(response)

            // Save history if not exists
            await this.saveHistory(response, history, inspectData, uniqueId)

            // Save asset
            const asset = await this.saveAsset(response, inspectData, uniqueId)

            const formattedResponse = await this.formatService.formatResponse(asset)
            this.success++

            // Resolve the promise with the formatted response
            inspectData.resolve(formattedResponse)
            return formattedResponse
        } catch (error) {
            this.logger.error(`Failed to handle inspect result: ${error.message}`)
            this.failed++
            inspectData.reject(new HttpException(error.message, HttpStatus.INTERNAL_SERVER_ERROR))
        } finally {
            if (inspectData.timeoutId) {
                clearTimeout(inspectData.timeoutId)
            }
            this.inspects.delete(response.itemid)
        }
    }

    /**
     * Find history
     * @param response 
     * @returns 
     */
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

    /**
     * Save history
     * @param response 
     * @param history 
     * @param inspectData 
     * @param uniqueId 
     */
    private async saveHistory(response: any, history: any, inspectData: any, uniqueId: string) {
        const existing = await this.historyRepository.findOne({
            where: {
                assetId: parseInt(response.itemid),
            },
        })

        if (!existing) {

            await this.historyRepository.save({
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
            })
        }
    }

    /**
     * Save an asset
     * @param response 
     * @param inspectData 
     * @param uniqueId 
     * @returns 
     */
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

    /**
     * Get the type of history
     * @param response 
     * @param history 
     * @param inspectData 
     * @returns 
     */
    private getHistoryType(response: any, history: any, inspectData: any): HistoryType {
        if (!history) {
            // Check for new item sources
            if (response.origin === 8) return HistoryType.TRADED_UP
            if (response.origin === 4) return HistoryType.DROPPED
            if (response.origin === 1) return HistoryType.PURCHASED_INGAME
            if (response.origin === 2) return HistoryType.UNBOXED
            if (response.origin === 3) return HistoryType.CRAFTED
            return HistoryType.UNKNOWN
        }

        // Check ownership changes
        if (history?.owner !== inspectData?.ms) {
            // Trading events
            if (history?.owner?.startsWith('7656')) {
                return HistoryType.TRADE
            }

            // Market events
            if (history?.owner && !history?.owner?.startsWith('7656')) {
                return HistoryType.MARKET_BUY
            }
        }

        // Market listing events
        if (history?.owner && history.owner.startsWith('7656') && !inspectData?.ms?.startsWith('7656')) {
            return HistoryType.MARKET_LISTING
        }

        // Sticker changes
        if (history.owner === inspectData.ms) {
            const stickerChanges = this.detectStickerChanges(response.stickers, history.stickers)
            if (stickerChanges) return stickerChanges
        }

        // Nametag changes
        if (response.customname !== history.customName) {
            return response.customname ? HistoryType.NAMETAG_ADDED : HistoryType.NAMETAG_REMOVED
        }

        // Keychain changes
        if (history.owner === inspectData.ms) {
            const keychainChanges = this.detectKeychainChanges(response.keychains, history.keychains)
            if (keychainChanges) return keychainChanges
        }

        // Storage unit detection
        if (this.isStorageUnitOperation(response, history)) {
            return response.inventory ? HistoryType.STORAGE_UNIT_RETRIEVED : HistoryType.STORAGE_UNIT_STORED
        }

        return HistoryType.UNKNOWN
    }

    // Helper methods
    private detectStickerChanges(currentStickers: any[], previousStickers: any[]): HistoryType | null {
        if (!currentStickers || !previousStickers) return null

        for (const slot of [0, 1, 2, 3, 4]) {
            const current = currentStickers.find(s => s.slot === slot)
            const previous = previousStickers.find(s => s.slot === slot)

            if (!current && previous) return HistoryType.STICKER_REMOVE
            if (current && !previous) return HistoryType.STICKER_APPLY
            if (current && previous && current.stickerId !== previous.stickerId) {
                // Check if it's a scrape by comparing wear values
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

    private isStorageUnitOperation(response: any, history: any): boolean {
        // Implement your storage unit detection logic here
        // Could be based on inventory status or other indicators
        return false
    }
    /**
     * Generate a unique ID for an asset
     * @param item 
     * @returns 
     */
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
        ];
        const stringToHash = values.join('-');
        return createHash('sha1').update(stringToHash).digest('hex').substring(0, 8);
    }

    // Add a cleanup method to run periodically
    @Cron('*/30 * * * * *') // Run every 30 seconds
    private async cleanupStaleRequests() {
        const now = Date.now()
        const staleTimeout = this.QUEUE_TIMEOUT * 2 // Double the timeout for extra safety

        for (const [assetId, inspect] of this.inspects.entries()) {
            if (now - inspect.startTime > staleTimeout) {
                if (inspect.timeoutId) {
                    clearTimeout(inspect.timeoutId)
                }
                this.inspects.delete(assetId)
                this.failed++
                this.logger.warn(`Cleaned up stale request for asset ${assetId}`)
            }
        }
    }

    // Remove the static MAX_QUEUE_SIZE constant and add a getter
    private get MAX_QUEUE_SIZE(): number {
        return this.bots.size || this.maxConcurrentBots; // Fallback to initial bot count if no bots yet
    }
}
