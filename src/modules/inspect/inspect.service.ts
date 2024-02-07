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

    private steamUsers = {}
    private cs2Instances = {}
    private ready = []
    private promises = {}
    private args = {}
    private ttls = {}
    private busy = []
    private onhold = []

    private inspectTimeout = 3 * 1000 // 10 seconds
    private onHoldTimeout = 60 * 1000 // 10 seconds

    constructor(private parseService: ParseService) {}

    async onModuleInit() {
        this.logger.debug('Starting Inspect Module...')

        this.logger.debug('Loading accounts.txt...')
        const accounts = fs.readFileSync('accounts.txt', 'utf8').split('\n')
        this.logger.debug('Loaded accounts.txt')

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
    }) {
        if (this.ready.length === 0) {
            if (process.env.GC_DEBUG === 'true') {
                this.logger.error('No bots are ready')
            }
            throw new HttpException(
                'No bots are ready',
                HttpStatus.FAILED_DEPENDENCY,
            )
        }

        const { s, a, d, m } = this.parseService.parse(query)

        const username =
            this.ready[Math.floor(Math.random() * this.ready.length)]

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
                return this.inspectItem(query)
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
                    `${username} Logged off, reconnecting! (${eresult}, ${msg})`,
                )
            })
        }

        this.steamUsers[username].on('loggedOn', () => {
            this.logger.debug(`${username} Log on OK`)

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
                                        `${username} Initiating GC Connection`,
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
                    this.logger.debug(`${username} Initiating GC Connection`)
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

        this.cs2Instances[username].on('inspectItemInfo', (response) => {
            this.busy.splice(this.busy.indexOf(username), 1)

            clearTimeout(this.ttls[username])

            if (!this.promises[username]) {
                if (process.env.GC_DEBUG === 'true') {
                    this.logger.error(
                        `${username} Received inspectItemInfo event without a promise`,
                    )
                }
            }

            return this.promises[username](response)
        })

        this.cs2Instances[username].on('connectedToGC', () => {
            this.ready.push(username)
            if (process.env.GC_DEBUG === 'false') {
                return
            }
            this.logger.debug(`${username} CS2 Client Ready!`)
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
                `${username} CS2 unready (${reason}), trying to reconnect!`,
            )
        })

        this.cs2Instances[username].on('connectionStatus', (status) => {
            if (process.env.GC_DEBUG === 'false') {
                return
            }
            this.logger.debug(
                `${username} GC Connection Status Update ${status}`,
            )
        })

        this.cs2Instances[username].on('debug', (msg) => {
            if (process.env.GC_DEBUG === 'false') {
                return
            }
            this.logger.debug(`${username}: ${msg}`)
        })
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
