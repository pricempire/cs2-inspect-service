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

@Injectable()
export class InspectService implements OnModuleInit {
    private readonly logger = new Logger(InspectService.name)
    private bots: Map<string, Bot> = new Map()
    private inspects: Map<string, { ms: string; d: string; resolve: (value: any) => void; reject: (reason?: any) => void }> = new Map()
    private nextBot = 0
    private currentRequests = 0
    private requests: number[] = []

    private success = 0
    private cached = 0
    private failed = 0

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
        const accounts = await this.loadAccounts()

        for (const account of accounts) {
            const [username, password] = account.split(':')
            await this.initializeBot(username, password)
        }
    }

    private async loadAccounts(): Promise<string[]> {
        let accounts: string[] = []

        if (fs.existsSync('accounts.txt')) {
            accounts = fs.readFileSync('accounts.txt', 'utf8').split('\n')
        } else if (fs.existsSync('../accounts.txt')) {
            accounts = fs.readFileSync('../accounts.txt', 'utf8').split('\n')
        } else {
            throw new Error('accounts.txt not found')
        }

        this.logger.debug(`Found ${accounts.length} accounts`)
        return accounts.filter(account => account.trim().length > 0)
    }

    private async initializeBot(username: string, password: string) {
        try {
            const bot = new Bot(
                username,
                password,
                process.env.PROXY_URL,
                (response) => this.handleInspectResult(username, response)
            )

            await bot.initialize()
            this.bots.set(username, bot)
            this.logger.debug(`Bot ${username} initialized successfully`)
        } catch (error) {
            this.logger.error(`Failed to initialize bot ${username}: ${error.message}`)
        }
    }

    @Cron('* * * * * *')
    async handleRequestMetrics() {
        this.requests.push(this.currentRequests)
        this.currentRequests = 0
        if (this.requests.length > 60) {
            this.requests.shift()
        }
    }

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

    private async getAvailableBot(): Promise<Bot | null> {
        const readyBots = Array.from(this.bots.entries())
            .filter(([_, bot]) => bot.isReady())

        if (readyBots.length === 0) {
            return null
        }

        // Round-robin selection
        const [username, bot] = readyBots[this.nextBot++ % readyBots.length]
        if (this.nextBot >= readyBots.length) {
            this.nextBot = 0
        }

        return bot
    }

    private async handleInspectResult(username: string, response: any) {
        const inspectData = this.inspects.get(response.itemid)
        if (!inspectData) {
            this.logger.error(`No inspect data found for item ${response.itemid}`)
            return
        }

        console.log(response)

        try {
            // Find history
            const history = await this.findHistory(response)

            // Save history if not exists
            await this.saveHistory(response, history, inspectData)

            // Save asset
            const asset = await this.saveAsset(response, inspectData)

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

    private async saveHistory(response: any, history: any, inspectData: any) {
        const existing = await this.historyRepository.findOne({
            where: {
                assetId: parseInt(response.itemid),
            },
        })

        if (!existing) {
            await this.historyRepository.save({
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

    private async saveAsset(response: any, inspectData: any) {
        await this.assetRepository.upsert({
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
}
