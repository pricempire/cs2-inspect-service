import * as SteamUser from 'steam-user'
import * as GlobalOffensive from 'globaloffensive'
import { Logger } from '@nestjs/common'

export class Bot {
    private readonly logger = new Logger(Bot.name)
    private steamUser: SteamUser
    private cs2Instance: GlobalOffensive
    private ready = false
    private busy = false
    private onHold = false
    private ttl: NodeJS.Timeout | null = null
    private readonly inspectTimeout = 3000 // 3 seconds
    private readonly onHoldTimeout = 60000 // 60 seconds
    private client: any // Replace 'any' with your actual Steam client type
    private interval: NodeJS.Timeout | null = null
    private readonly graceTimeout = 20000 // 20 seconds grace period 

    private readonly loginErrors = {
        61: 'Invalid Password',
        63: 'Account login denied due to 2nd factor authentication failure. If using email auth, an email has been sent.',
        65: 'Account login denied due to auth code being invalid',
        66: 'Account login denied due to 2nd factor auth failure and no mail has been sent',
    }

    constructor(
        public readonly username: string,
        private readonly password: string,
        private readonly proxyUrl: string,
        private readonly onInspectResult: (response: any) => void,
    ) { }

    async initialize() {
        this.createSteamUser()
        this.createCS2Instance()
        await this.login()
    }

    private createSteamUser() {
        this.logger.debug(`Creating Steam User for ${this.username}`)

        if (this.steamUser) {
            this.logger.error(`Bot for ${this.username} already exists`)
            this.steamUser.removeAllListeners()
        }

        const proxyUrl = this.proxyUrl.replace('[session]', this.username.toString())

        this.steamUser = new SteamUser({
            promptSteamGuardCode: false,
            enablePicsCache: false,
            httpProxy: proxyUrl.startsWith('http://') ? proxyUrl : null,
            socksProxy: proxyUrl.startsWith('socks5://') ? proxyUrl : null,
        })

        this.setupSteamUserEvents()
    }

    private createCS2Instance() {
        this.logger.debug(`Creating CS2 Instance for ${this.username}`)
        this.cs2Instance = new GlobalOffensive(this.steamUser)
        this.setupCS2Events()
    }

    private setupSteamUserEvents() {
        this.steamUser.on('error', (err) => {
            if (err.eresult && this.loginErrors[err.eresult]) {
                this.logger.error(`${this.username}: ${this.loginErrors[err.eresult]}`)
            }
            if (
                err.toString().includes('Proxy connection timed out') ||
                err.toString().includes('RateLimit') ||
                err.toString().includes('Bad Gateway') ||
                err.toString().includes('NetworkUnreachable') ||
                err.toString().includes('ECONNREFUSED')
            ) {
                this.initialize() // Reinitialize on these errors
            }

            if (err.toString().includes('Account Disabled')) {
            }

            console.log(err)
        })

        this.steamUser.on('disconnected', (eresult, msg) => {
            this.logger.debug(`${this.username}: Logged off, reconnecting! (${eresult}, ${msg})`)
            this.ready = false
            this.initialize()
        })

        this.steamUser.on('loggedOn', () => {
            this.logger.debug(`${this.username}: Log on OK`)
            this.steamUser.gamesPlayed([], true)

            this.steamUser.once('ownershipCached', () => {
                if (!this.steamUser.ownsApp(730)) {
                    this.logger.debug(`${this.username} doesn't own CS:GO, retrieving free license`)
                    this.requestCS2License()
                } else {
                    this.logger.debug(`${this.username}: Initiating GC Connection`)
                    this.steamUser.gamesPlayed([730], true)
                }
            })
        })
    }

    private setupCS2Events() {
        this.cs2Instance.on('inspectItemInfo', async (response) => {
            this.busy = false
            if (this.ttl) {
                clearTimeout(this.ttl)
                this.ttl = null
            }
            await this.onInspectResult(response)
        })

        this.cs2Instance.on('connectedToGC', () => {
            this.ready = true
            this.logger.debug(`${this.username}: CS2 Client Ready!`)
        })

        this.cs2Instance.on('disconnectedFromGC', (reason) => {
            this.ready = false
            this.logger.debug(`${this.username}: CS2 unready (${reason}), trying to reconnect!`)
            this.initialize()
        })

        this.cs2Instance.on('connectionStatus', (status) => {
            this.logger.debug(`${this.username}: GC Connection Status Update ${status}`)
        })

        this.cs2Instance.on('debug', (msg) => {
            this.logger.debug(`${this.username}: ${msg}`)
        })
    }

    private async login() {
        this.logger.debug(`Logging in ${this.username}`)
        this.ready = false

        this.steamUser.logOn({
            accountName: this.username,
            password: this.password,
            rememberPassword: true,
        })
    }

    private requestCS2License() {
        this.steamUser.requestFreeLicense([730], (err, grantedPackages, grantedAppIDs) => {
            this.logger.debug(`${this.username} Granted Packages`, grantedPackages)
            this.logger.debug(`${this.username} Granted App IDs`, grantedAppIDs)

            if (err) {
                this.logger.error(`${this.username} Failed to obtain free CS:GO license`)
            } else {
                this.logger.debug(`${this.username}: Initiating GC Connection`)
                this.steamUser.gamesPlayed([730], true)
            }
        })
    }

    public isReady(): boolean {
        return this.ready && !this.busy && !this.onHold
    }

    public async inspectItem(s: string, a: string, d: string): Promise<void> {
        if (!this.isReady()) {
            throw new Error('Bot is not ready')
        }

        if (!this.cs2Instance.haveGCSession) {
            this.logger.error(`Bot ${this.username} doesn't have a GC Session`)
            throw new Error('No GC session')
        }

        this.busy = true

        // Set timeout for inspection
        this.ttl = setTimeout(() => {
            this.logger.error(`${this.username} TTL exceeded for ${a}`)
            this.busy = false
            this.onHold = true

            setTimeout(() => {
                this.onHold = false
            }, this.onHoldTimeout)

            // throw new Error('Inspection timeout')
        }, this.inspectTimeout)

        this.cs2Instance.inspectItem(s !== '0' ? s : a, a, d)

        // Add grace period after inspection
        setTimeout(() => {
            this.busy = false
        }, this.graceTimeout)
    }

    public disconnect() {
        if (this.steamUser) {
            this.steamUser.logOff()
            this.steamUser.removeAllListeners()
        }
        this.ready = false
        this.busy = false
        this.onHold = false
    }

    public async destroy(): Promise<void> {
        try {
            // Clear any intervals
            if (this.interval) {
                clearInterval(this.interval)
                this.interval = null
            }

            // Logout and disconnect from Steam
            if (this.client) {
                await new Promise<void>((resolve) => {
                    this.client.logOff()
                    this.client.once('disconnected', () => {
                        resolve()
                    })

                    // Fallback timeout in case disconnect event doesn't fire
                    setTimeout(resolve, 5000)
                })
            }

            // Reset state
            this.ready = false
            this.client = null

        } catch (error) {
            console.error(`Error destroying bot: ${error.message}`)
            throw error
        }
    }
}
