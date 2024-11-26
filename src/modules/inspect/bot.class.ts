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
    private readonly connectionTimeout = 30000; // 30 seconds
    private connectionTimer: NodeJS.Timeout | null = null;

    private readonly loginErrors = {
        61: 'Invalid Password',
        63: 'Account login denied due to 2nd factor authentication failure. If using email auth, an email has been sent.',
        65: 'Account login denied due to auth code being invalid',
        66: 'Account login denied due to 2nd factor auth failure and no mail has been sent',
    }

    constructor(
        private readonly username: string,
        private readonly password: string,
        private readonly proxyUrl: string,
        private readonly onInspectResult: (response: any) => void,
    ) { }

    async initialize() {
        this.logger.log(`Starting initialization for bot ${this.username}`)

        // Clear any existing connection timer
        if (this.connectionTimer) {
            clearTimeout(this.connectionTimer);
        }

        // Set connection timeout
        this.connectionTimer = setTimeout(() => {
            if (!this.ready) {
                this.logger.error(`${this.username}: Connection timeout after ${this.connectionTimeout}ms`);
                this.disconnect();
                this.initialize(); // Retry connection
            }
        }, this.connectionTimeout);

        try {
            await this.createSteamUser()
            await this.createCS2Instance()
            await this.login()
            this.logger.log(`Initialization started for bot ${this.username}`)
        } catch (error) {
            this.logger.error(`Initialization failed for bot ${this.username}`, {
                error: error.message,
                stack: error.stack
            })
            throw error
        }
    }

    private createSteamUser() {
        this.logger.debug(`Creating Steam User for ${this.username}`)

        if (this.steamUser) {
            this.logger.error(`Bot for ${this.username} already exists`)
            this.steamUser.removeAllListeners()
        }

        this.steamUser = new SteamUser({
            promptSteamGuardCode: false,
            enablePicsCache: true,
            httpProxy: this.proxyUrl.startsWith('http://') ? this.proxyUrl : null,
            socksProxy: this.proxyUrl.startsWith('socks5://') ? this.proxyUrl : null,
        })

        console.log({
            promptSteamGuardCode: false,
            enablePicsCache: true,
            httpProxy: this.proxyUrl.startsWith('http://') ? this.proxyUrl : null,
            socksProxy: this.proxyUrl.startsWith('socks5://') ? this.proxyUrl : null,
        })

        this.setupSteamUserEvents()
    }

    private createCS2Instance() {
        this.logger.debug(`Creating CS2 Instance for ${this.username}`)
        this.cs2Instance = new GlobalOffensive(this.steamUser)
        this.setupCS2Events()
    }

    private setupSteamUserEvents() {
        this.logger.debug(`${this.username}: Setting up Steam user events`)

        this.steamUser.on('error', (err) => {
            this.logger.error(`${this.username}: Steam error occurred`, {
                error: err.toString(),
                eresult: err.eresult,
                stack: err.stack,
                timestamp: new Date().toISOString()
            })

            if (err.eresult && this.loginErrors[err.eresult]) {
                this.logger.error(`${this.username}: Steam login error: ${this.loginErrors[err.eresult]}`)
            }

            if (err.toString().includes('Proxy connection') ||
                err.toString().includes('RateLimit') ||
                err.toString().includes('Connection timed out')) {
                this.logger.error(`${this.username}: Connection error detected, attempting reconnect`)
                this.initialize()
            }
        })

        this.steamUser.on('disconnected', (eresult, msg) => {
            this.logger.warn(`${this.username}: Steam disconnected`, {
                eresult,
                message: msg,
                wasReady: this.ready,
                timestamp: new Date().toISOString()
            })
            this.ready = false
            this.initialize()
        })

        this.steamUser.on('loggedOn', () => {
            this.logger.log(`${this.username}: Successfully logged into Steam`, {
                steamId: this.steamUser.steamID?.getSteamID64(),
                timestamp: new Date().toISOString()
            })

            this.logger.debug(`${this.username}: Stopping all games`)
            this.steamUser.gamesPlayed([], true)

            this.steamUser.once('ownershipCached', () => {
                const ownsCS2 = this.steamUser.ownsApp(730)
                this.logger.debug(`${this.username}: Ownership cached, owns CS2: ${ownsCS2}`)

                if (!ownsCS2) {
                    this.logger.debug(`${this.username}: Requesting CS2 free license`)
                    this.requestCS2License()
                } else {
                    this.logger.debug(`${this.username}: Launching CS2`)
                    this.steamUser.gamesPlayed([730], true)
                }
            })
        })

        this.steamUser.on('steamGuard', (domain, callback) => {
            this.logger.warn(`${this.username}: Steam Guard requested`, { domain })
        })
    }

    private setupCS2Events() {
        this.logger.debug(`${this.username}: Setting up CS2 events`)

        this.cs2Instance.on('connectedToGC', () => {
            this.ready = true
            this.logger.log(`${this.username}: Connected to CS2 Game Coordinator`, {
                timestamp: new Date().toISOString(),
                haveGCSession: this.cs2Instance.haveGCSession
            })
        })

        this.cs2Instance.on('disconnectedFromGC', (reason) => {
            this.ready = false
            this.logger.warn(`${this.username}: Disconnected from CS2 GC`, {
                reason,
                timestamp: new Date().toISOString(),
                wasReady: this.ready
            })
            this.initialize()
        })

        this.cs2Instance.on('connectionStatus', (status) => {
            this.logger.debug(`${this.username}: CS2 GC connection status`, {
                status,
                ready: this.ready,
                busy: this.busy,
                haveGCSession: this.cs2Instance.haveGCSession
            })
        })
    }

    private async login() {
        this.logger.debug(`${this.username}: Starting login process`, {
            hasProxy: !!this.proxyUrl,
            proxyType: this.proxyUrl?.startsWith('socks5://') ? 'SOCKS5' : 'HTTP'
        })

        try {
            const loginDetails = {
                accountName: this.username,
                password: this.password,
                rememberPassword: true,
            }

            this.logger.debug(`${this.username}: Attempting Steam login`)
            this.steamUser.logOn(loginDetails)
        } catch (error) {
            this.logger.error(`${this.username}: Login attempt failed`, {
                error: error.message,
                stack: error.stack,
                timestamp: new Date().toISOString()
            })
            throw error
        }
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

            throw new Error('Inspection timeout')
        }, this.inspectTimeout)

        this.cs2Instance.inspectItem(s !== '0' ? s : a, a, d)
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
