import {
    HttpException,
    HttpStatus,
    Injectable,
    Logger,
    OnModuleInit,
} from '@nestjs/common'
import * as SteamUser from 'steam-user'
import * as GlobalOffensive from 'globaloffensive'
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

@Injectable()
export class InspectService implements OnModuleInit {
    private readonly logger = new Logger(InspectService.name)

    private loginErrors = {
        61: 'Invalid Password',
        63:
            'Account login denied due to 2nd factor authentication failure. ' +
            'If using email auth, an email has been sent.',
        65: 'Account login denied due to auth code being invalid',
        66: 'Account login denied due to 2nd factor auth failure and no mail has been sent',
    }

    private schema

    private steamUsers = {}
    private cs2Instances = {}
    private ready = []
    private promises = {}
    private args = {}
    private ttls = {}
    private busy = []
    private onhold = []
    private inspects = {}
    private nextBot = 0

    private inspectTimeout = 3 * 1000 // 10 seconds
    private onHoldTimeout = 60 * 1000 // 10 seconds

    constructor(
        private parseService: ParseService,
        private formatService: FormatService,
        @InjectRepository(Asset)
        private assetRepository: Repository<Asset>,
        @InjectRepository(History)
        private historyRepository: Repository<History>,
        private readonly pricempireService: PricempireService,
        private readonly httpService: HttpService,
    ) {}

    async onModuleInit() {
        this.logger.debug('Starting Inspect Module...')

        let accounts = []

        if (fs.existsSync('accounts.txt')) {
            accounts = fs.readFileSync('accounts.txt', 'utf8').split('\n')
        } else if (fs.existsSync('../accounts.txt')) {
            accounts = fs.readFileSync('../accounts.txt', 'utf8').split('\n')
        } else {
            throw new Error('accounts.txt not found')
        }

        this.logger.debug(`Found ${accounts.length} accounts`)

        this.logger.debug('Starting bots...')

        for await (const account of accounts) {
            const [user, pass] = account.split(':')
            this.logger.debug(`Starting bot for ${user}`)
            await this.initBot(user, pass)
        }
    }

    public async inspectItem(query: {
        s?: string
        a?: string
        d?: string
        m?: string
        url?: string
        refresh?: string // reload from GC instead of cache (optional), used for reload stickers usually
    }) {
        const { s, a, d, m } = this.parseService.parse(query)

        // Ping pricempire
        if (process.env.PING_PRICEMPIRE === 'true') {
            // no need async here because we don't care about the response
            this.pricempireService.ping({
                s,
                a,
                d,
                m,
            })
        }

        if (query.refresh !== 'true') {
            const asset = await this.assetRepository.findOne({
                where: {
                    assetId: parseInt(a),
                    d,
                },
            })
            if (asset) {
                return Promise.resolve(this.formatService.formatResponse(asset))
            }
        } else if (process.env.ALLOW_REFRESH === 'false') {
            throw new HttpException(
                'Refresh is not allowed',
                HttpStatus.FORBIDDEN,
            )
        }

        this.inspects[a] = {
            ms: m !== '0' ? m : s,
            d,
        }

        if (this.ready.length === 0) {
            if (process.env.GC_DEBUG === 'true') {
                this.logger.error('No bots are ready')
            }
            throw new HttpException(
                'No bots are ready',
                HttpStatus.FAILED_DEPENDENCY,
            )
        }

        const username = this.ready[this.nextBot++ % this.ready.length] // Round Robin

        if (this.nextBot >= this.ready.length) {
            this.nextBot = 0
        }

        if (this.busy.includes(username) || this.onhold[username]) {
            if (process.env.GC_DEBUG === 'true') {
                this.logger.error(
                    `${username} is busy or on hold, trying another bot`,
                )
            }
            return this.inspectItem(query) // try again with another bot
        }

        this.busy.push(username)

        return new Promise((resolve) => {
            this.promises[username] = resolve

            if (process.env.GC_DEBUG === 'true') {
                this.logger.debug(
                    `${username} Fetching for ${a} with ${username}`,
                )
            }

            if (!this.cs2Instances[username].haveGCSession) {
                this.logger.error(`Bot ${username} doesn't have a GC Session`)
                this.initBot(
                    this.args[username].username,
                    this.args[username].password,
                )
                return this.inspectItem(query) // try again with another bot
            }

            this.ttls[username] = setTimeout(() => {
                if (process.env.GC_DEBUG === 'true') {
                    this.logger.error(`${username} TTL exceeded for ${a}`)
                }

                this.busy.splice(this.busy.indexOf(username), 1)

                this.onhold[username] = true

                setTimeout(() => {
                    this.onhold[username] = false
                }, this.onHoldTimeout)

                throw new HttpException(
                    'Request Timeout',
                    HttpStatus.REQUEST_TIMEOUT,
                )
            }, this.inspectTimeout)

            this.cs2Instances[username].inspectItem(s !== '0' ? s : m, a, d)
        })
    }

    private async initBot(username: string, password: string) {
        this.createSteamUser(username)
        this.createCSIntance(username)
        this.logIn(username, password)
    }

    private createSteamUser(username: string) {
        this.logger.debug(`Creating Steam User for ${username}`)
        const proxy = process.env.PROXY_URL.replace('[session]', username)

        if (this.steamUsers[username]) {
            this.logger.error(`Bot for ${username} already exists`)
            this.steamUsers[username].removeAllListeners()
        }

        this.steamUsers[username] = new SteamUser({
            promptSteamGuardCode: false,
            enablePicsCache: true,
            httpProxy: proxy.startsWith('http://') ? proxy : null,
            socksProxy: proxy.startsWith('socks5://') ? proxy : null,
        })

        this.steamUsers[username].on('error', (err) => {
            if (err.eresult && this.loginErrors[err.eresult] !== undefined) {
                this.logger.error(
                    username + ': ' + this.loginErrors[err.eresult],
                )
            }
            if (
                err.toString().includes('Proxy connection timed out') ||
                err.toString().includes('RateLimit') ||
                err.toString().includes('Bad Gateway') ||
                err.toString().includes('AccountLoginDeniedThrottle') ||
                err.toString().includes('NetworkUnreachable')
            ) {
                //  this.newSession()
                //  this.logIn()
            }
        })

        if (process.env.GC_DEBUG === 'true') {
            this.steamUsers[username].on('disconnected', (eresult, msg) => {
                this.logger.debug(
                    `${username}: Logged off, reconnecting! (${eresult}, ${msg})`,
                )
                this.initBot(username, this.args[username].password)
            })
        }

        this.steamUsers[username].on('loggedOn', () => {
            this.logger.debug(`${username}: Log on OK`)

            this.steamUsers[username].gamesPlayed([], true)

            this.steamUsers[username].once('ownershipCached', () => {
                if (!this.steamUsers[username].ownsApp(730)) {
                    this.logger.debug(
                        `${username} doesn't own CS:GO, retrieving free license`,
                    )

                    // Request a license for CS:GO
                    this.steamUsers[username].requestFreeLicense(
                        [730],
                        (err, grantedPackages, grantedAppIDs) => {
                            this.logger.debug(
                                `${username} Granted Packages`,
                                grantedPackages,
                            )
                            this.logger.debug(
                                `${username} Granted App IDs`,
                                grantedAppIDs,
                            )

                            if (err) {
                                this.logger.error(
                                    `${username} Failed to obtain free CS:GO license`,
                                )
                            } else {
                                if (process.env.GC_DEBUG === 'true') {
                                    this.logger.debug(
                                        `${username}: Initiating GC Connection`,
                                    )
                                }
                                this.steamUsers[username].gamesPlayed(
                                    [730],
                                    true,
                                )
                            }
                        },
                    )
                } else {
                    this.logger.debug(`${username}: Initiating GC Connection`)
                    this.steamUsers[username].gamesPlayed([730], true)
                }
            })
        })
    }

    private createCSIntance(username: string) {
        this.logger.debug(`Creating CS2 Instance for ${username}`)
        this.cs2Instances[username] = new GlobalOffensive(
            this.steamUsers[username],
        )

        this.cs2Instances[username].on('inspectItemInfo', async (response) => {
            this.busy.splice(this.busy.indexOf(username), 1)

            clearTimeout(this.ttls[username])

            if (!this.promises[username]) {
                if (process.env.GC_DEBUG === 'true') {
                    this.logger.error(
                        `${username}: Received inspectItemInfo event without a promise`,
                    )
                }
            }

            try {
                const history = await this.assetRepository.findOne({
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

                const already = await this.historyRepository.findOne({
                    where: {
                        assetId: parseInt(response.itemid),
                    },
                })

                if (!already) {
                    await this.historyRepository.save({
                        assetId: parseInt(response.itemid),
                        prevAssetId: history?.assetId,
                        owner: this.inspects[response.itemid].ms,
                        prevOwner: history?.ms,
                        d: this.inspects[response.itemid].d,
                        stickers: response.stickers,
                        prevStickers: history?.stickers,
                        type: this.getHistoryType(response, history),
                    })
                }

                const asset = await this.assetRepository.save({
                    ms: this.inspects[response.itemid].ms,
                    d: this.inspects[response.itemid].d,
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
                })

                delete this.inspects[response.itemid]

                return this.promises[username](
                    this.formatService.formatResponse(asset),
                )
            } catch (e) {
                console.log(e)
                this.logger.error('Failed to save asset')
            } finally {
                delete this.inspects[response.itemid]
                delete this.promises[username]
            }
        })

        this.cs2Instances[username].on('connectedToGC', () => {
            this.ready.push(username)
            if (process.env.GC_DEBUG === 'false') {
                return
            }
            this.logger.debug(`${username}: CS2 Client Ready!`)
        })

        this.cs2Instances[username].on('disconnectedFromGC', (reason) => {
            const index = this.ready.indexOf(username)
            if (index > -1) {
                this.ready.splice(index, 1)
            }

            if (process.env.GC_DEBUG === 'false') {
                return
            }

            this.logger.debug(
                `${username}: CS2 unready (${reason}), trying to reconnect!`,
            )
            this.initBot(username, this.args[username].password)
        })

        this.cs2Instances[username].on('connectionStatus', (status) => {
            if (process.env.GC_DEBUG === 'false') {
                return
            }
            this.logger.debug(
                `${username}: GC Connection Status Update ${status}`,
            )
        })

        this.cs2Instances[username].on('debug', (msg) => {
            if (process.env.GC_DEBUG === 'false') {
                return
            }
            this.logger.debug(`${username}: ${msg}`)
        })
    }

    private getHistoryType(response, history) {
        if (!history) {
            return HistoryType.UNKNOWN
        }

        if (history.owner === this.inspects[response.itemid].ms) {
            for (const slot in [0, 1, 2, 3, 4]) {
                const sticker = response.stickers.find(
                    (sticker) => sticker.slot === slot,
                )
                const stickerOld = history.stickers.find(
                    (sticker) => sticker.slot === slot,
                )

                if (!sticker && stickerOld) {
                    return HistoryType.STICKER_REMOVE
                } else if (sticker && !stickerOld) {
                    return HistoryType.STICKER_APPLY
                } else if (sticker.stickerId !== stickerOld.stickerId) {
                    return HistoryType.STICKER_CHANGE
                }
            }
        }

        if (
            history &&
            history.owner !== this.inspects[response.itemid].ms &&
            history.owner.startsWith('7656')
        ) {
            return HistoryType.TRADE
        }

        if (
            history &&
            history.owner !== this.inspects[response.itemid].ms &&
            !history.owner.startsWith('7656')
        ) {
            return HistoryType.MARKET_BUY
        }

        if (
            history &&
            !history.owner.startsWith('7656') &&
            this.inspects[response.itemid].ms.startsWith('7656')
        ) {
            return HistoryType.MARKET_LISTING
        }
    }

    private logIn(username, password) {
        this.logger.debug(`Logging in ${username}`)
        this.ready[username] = false

        this.args[username] = {
            username,
            password,
        }

        this.steamUsers[username].logOn({
            accountName: username,
            password: password,
            rememberPassword: true,
        })
    }
}
