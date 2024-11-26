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
    private inspects: Map<string, { ms: string; d: string; resolve: (value: any) => void; reject: (reason?: any) => void }> = new Map()
    private nextBot = 0
    private currentRequests = 0
    private requests: number[] = []
    private initializedBots = 0
    private maxConcurrentBots = 3 // Initial bot count
    private botsToAddWhenNeeded = 3 // Number of bots to add when needed
    private botLastUsedTime: Map<string, number> = new Map() // Track last usage time
    private readonly BOT_INACTIVE_THRESHOLD = 15 * 60 * 1000 // 15 minutes in milliseconds
    private readonly BOT_INIT_DELAY = 200; // 5 seconds delay between bot initializations

    private success = 0
    private cached = 0
    private failed = 0

    private initializationInProgress = false;
    private readonly DEBOUNCE_DELAY = 3000; // 30 seconds debounce
    private lastInitializationTime = 0;

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

        // Initialize minimum number of bots with delay
        for (let i = 0; i < this.maxConcurrentBots; i++) {
            if (this.accounts[i]) {
                const [username, password] = this.accounts[i].split(':')
                await this.initializeBot(username, password)
                // Add delay between initializations
                await new Promise(resolve => setTimeout(resolve, this.BOT_INIT_DELAY))
            }
        }
    }

    /**
     * Get stats
     * @returns 
     */
    public stats() {
        const readyBots = Array.from(this.bots.values()).filter(bot => bot.isReady()).length
        const busyBots = Array.from(this.bots.values()).filter(bot => !bot.isReady()).length

        return {
            ready: readyBots,
            busy: busyBots,
            pending: this.inspects.size,
            success: {
                rate: this.success / (this.success + this.failed + this.cached),
                count: this.success,
            },
            cached: {
                rate: this.cached / (this.success + this.failed + this.cached),
                count: this.cached,
            },
            failed: {
                rate: this.failed / (this.success + this.failed + this.cached),
                count: this.failed,
            },
            requests: this.requests,
        }
    }

    /**
     * Inspect an item
     * @param query 
     * @returns 
     */
    public async inspectItem(query: InspectDto) {
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

        // Store inspect details with promise handlers
        const resultPromise = new Promise((resolve, reject) => {
            this.inspects.set(a, {
                ms: m !== '0' ? m : s,
                d,
                resolve,
                reject,
            })
        })

        // Get available bot
        const bot = await this.getAvailableBot()
        if (!bot) {
            // Check cache one more time before failing
            const cachedAsset = await this.checkCache(a, d)
            if (cachedAsset) {
                this.cached++
                this.inspects.delete(a)
                return cachedAsset
            }

            throw new HttpException('No bots are ready', HttpStatus.FAILED_DEPENDENCY)
        }

        // Trigger inspection
        try {
            await bot.inspectItem(s !== '0' ? s : m, a, d)
            return resultPromise
        } catch (error) {
            this.failed++
            this.inspects.delete(a)
            throw new HttpException(error.message, HttpStatus.INTERNAL_SERVER_ERROR)
        }
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
            this.logger.debug('Bot initialization already in progress, skipping...');
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
            return HistoryType.UNKNOWN
        }

        if (history.owner === inspectData.ms) {
            // Check sticker changes
            for (const slot of [0, 1, 2, 3, 4]) {
                const sticker = response.stickers.find(s => s.slot === slot)
                const stickerOld = history.stickers.find(s => s.slot === slot)

                if (!sticker && stickerOld) return HistoryType.STICKER_REMOVE
                if (sticker && !stickerOld) return HistoryType.STICKER_APPLY
                if (sticker?.stickerId !== stickerOld?.stickerId) return HistoryType.STICKER_CHANGE
            }
        }

        if (history.owner !== inspectData.ms) {
            if (history.owner.startsWith('7656')) {
                return HistoryType.TRADE
            }
            return HistoryType.MARKET_BUY
        }

        if (!history.owner.startsWith('7656') && inspectData.ms.startsWith('7656')) {
            return HistoryType.MARKET_LISTING
        }

        return HistoryType.UNKNOWN
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
}
