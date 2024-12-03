import * as SteamUser from 'steam-user'
import * as GlobalOffensive from 'globaloffensive'
import { Logger } from '@nestjs/common'
import { EventEmitter } from 'events'

export enum BotStatus {
    IDLE = 'IDLE',
    INITIALIZING = 'INITIALIZING',
    READY = 'READY',
    BUSY = 'BUSY',
    ERROR = 'ERROR',
    COOLDOWN = 'COOLDOWN',
    DISCONNECTED = 'DISCONNECTED'
}

export enum BotError {
    INVALID_CREDENTIALS = 'INVALID_CREDENTIALS',
    RATE_LIMITED = 'RATE_LIMITED',
    ACCOUNT_DISABLED = 'ACCOUNT_DISABLED',
    CONNECTION_ERROR = 'CONNECTION_ERROR',
    INITIALIZATION_ERROR = 'INITIALIZATION_ERROR',
    TIMEOUT = 'TIMEOUT',
    GC_ERROR = 'GC_ERROR',
    LOGIN_THROTTLED = 'LOGIN_THROTTLED'
}

interface BotConfig {
    username: string
    password: string
    proxyUrl?: string
    initTimeout?: number
    inspectTimeout?: number
    cooldownTime?: number
    maxRetries?: number
    debug?: boolean
}

export class Bot extends EventEmitter {
    private readonly logger = new Logger(Bot.name)
    private steamUser: SteamUser | null = null
    private cs2Instance: GlobalOffensive | null = null
    private status: BotStatus = BotStatus.IDLE
    private retryCount = 0
    private sessionId = 0
    private currentInspectTimeout: NodeJS.Timeout | null = null
    private initializationTimeout: NodeJS.Timeout | null = null
    private cooldownTimeout: NodeJS.Timeout | null = null

    private readonly config: Required<BotConfig>

    constructor(config: BotConfig) {
        super()
        this.config = {
            initTimeout: 60000,
            inspectTimeout: 1000,
            cooldownTime: 10000,
            maxRetries: 3,
            debug: false,
            proxyUrl: '',
            ...config
        }
    }

    public get currentStatus(): BotStatus {
        return this.status
    }

    public isBusy(): boolean {
        return this.status === BotStatus.BUSY
    }

    public isCooldown(): boolean {
        return this.status === BotStatus.COOLDOWN
    }

    public isDisconnected(): boolean {
        return this.status === BotStatus.DISCONNECTED
    }

    public isError(): boolean {
        return this.status === BotStatus.ERROR
    }

    public isIdle(): boolean {
        return this.status === BotStatus.IDLE
    }

    public isInitializing(): boolean {
        return this.status === BotStatus.INITIALIZING
    }

    public isReady(): boolean {
        return this.status === BotStatus.READY
    }

    public async initialize(): Promise<void> {
        if (this.status === BotStatus.INITIALIZING) {
            throw new Error('Bot is already initializing')
        }

        this.cleanup()
        this.status = BotStatus.INITIALIZING
        this.sessionId++

        try {
            await this.initializeWithTimeout()
        } catch (error) {
            this.handleInitializationError(error)
            throw error
        }
    }

    private async initializeWithTimeout(): Promise<void> {
        return new Promise((resolve, reject) => {
            let initComplete = false

            this.initializationTimeout = setTimeout(() => {
                if (!initComplete) {
                    this.cleanup()
                    reject(new Error('Initialization timeout'))
                }
            }, this.config.initTimeout)

            this.setupSteamUser()
            this.setupCS2Instance()

            const checkInitComplete = () => {
                initComplete = true
                clearTimeout(this.initializationTimeout!)
                this.retryCount = 0
                resolve()
            }

            this.steamUser!.on('loggedOn', checkInitComplete)
            this.cs2Instance!.on('connectedToGC', checkInitComplete)

            this.login()
        })
    }

    private setupSteamUser(): void {
        if (this.steamUser) {
            this.steamUser.removeAllListeners()
        }

        const proxyConfig = this.getProxyConfig()

        this.steamUser = new SteamUser({
            promptSteamGuardCode: false,
            enablePicsCache: true,
            ...proxyConfig
        })

        this.setupSteamUserEvents()
    }

    private getProxyConfig() {
        if (!this.config.proxyUrl) return {}

        const proxyUrl = this.config.proxyUrl.replace(
            '[session]',
            `${this.config.username}_${this.sessionId}`
        )

        return {
            httpProxy: proxyUrl.startsWith('http://') ? proxyUrl : null,
            socksProxy: proxyUrl.startsWith('socks5://') ? proxyUrl : null
        }
    }

    private setupSteamUserEvents(): void {
        this.steamUser!.on('error', this.handleSteamError.bind(this))
        this.steamUser!.on('disconnected', this.handleDisconnect.bind(this))
        this.steamUser!.on('loggedOn', this.handleLoggedOn.bind(this))
    }

    private setupCS2Instance(): void {
        if (!this.steamUser) throw new Error('Steam user not initialized')

        this.cs2Instance = new GlobalOffensive(this.steamUser)

        this.log('Initializing CS2 instance and attempting GC connection')

        this.cs2Instance.on('inspectItemInfo', this.handleInspectResult.bind(this))
        this.cs2Instance.on('connectedToGC', () => {
            this.log('Connected to GC')
            this.status = BotStatus.READY
            this.emit('ready')
        })
        this.cs2Instance.on('disconnectedFromGC', this.handleGCDisconnect.bind(this))

        this.cs2Instance.on('error', (error) => {
            this.log(`CS2 instance error: ${error}`, true)
            this.handleGCDisconnect()
        })
    }

    private handleSteamError(error: any): void {
        this.log(`Steam error: ${error.message}`, true)

        if (this.shouldRetry(error)) {
            this.retryInitialization()
        } else {
            this.status = BotStatus.ERROR
            this.emit('error', this.mapError(error))
        }
    }

    private shouldRetry(error: any): boolean {
        const retryableErrors = [
            'Proxy connection timed out',
            'RateLimit',
            'Bad Gateway',
            'NetworkUnreachable',
            'ECONNREFUSED'
        ]

        return (
            this.retryCount < this.config.maxRetries &&
            retryableErrors.some(msg => error.message.includes(msg))
        )
    }

    private mapError(error: any): BotError {
        if (error.message.includes('InvalidPassword')) return BotError.INVALID_CREDENTIALS
        if (error.message.includes('RateLimit')) return BotError.RATE_LIMITED
        if (error.message.includes('AccountDisabled')) return BotError.ACCOUNT_DISABLED
        if (error.message.includes('NetworkUnreachable')) return BotError.CONNECTION_ERROR
        if (error.message.includes('AccountLoginDeniedThrottle')) return BotError.LOGIN_THROTTLED
        return BotError.INITIALIZATION_ERROR
    }

    private async retryInitialization(): Promise<void> {
        this.retryCount++
        this.log(`Retrying initialization (attempt ${this.retryCount})`)
        await this.initialize()
    }

    public async inspectItem(s: string, a: string, d: string): Promise<void> {
        if (!this.isReady()) {
            throw new Error(`Bot is not ready (status: ${this.status})`)
        }

        this.status = BotStatus.BUSY

        return new Promise((resolve, reject) => {
            this.currentInspectTimeout = setTimeout(() => {
                this.handleInspectTimeout()
                reject(new Error('Inspect timeout'))
            }, this.config.inspectTimeout)

            try {
                this.cs2Instance!.inspectItem(s !== '0' ? s : a, a, d)
                resolve()
            } catch (error) {
                this.handleInspectError(error)
                reject(error)
            }
        })
    }

    private handleInspectResult(result: any): void {
        this.clearInspectTimeout()
        this.status = BotStatus.READY
        this.emit('inspectResult', result)
    }

    private handleInspectTimeout(): void {
        this.status = BotStatus.COOLDOWN
        this.clearInspectTimeout()

        this.cooldownTimeout = setTimeout(() => {
            this.status = BotStatus.READY
        }, this.config.cooldownTime)
    }

    private handleInspectError(error: any): void {
        this.log(`Inspect error: ${error.message}`, true)
        this.clearInspectTimeout()
        this.status = BotStatus.ERROR
    }

    public async destroy(): Promise<void> {
        this.cleanup()

        if (this.steamUser) {
            return new Promise<void>((resolve) => {
                this.steamUser!.once('disconnected', () => {
                    this.status = BotStatus.DISCONNECTED
                    resolve()
                })

                this.steamUser!.logOff()

                // Fallback timeout
                setTimeout(resolve, 5000)
            })
        }
    }

    private cleanup(): void {
        this.clearInspectTimeout()
        this.clearInitializationTimeout()
        this.clearCooldownTimeout()

        if (this.steamUser) {
            this.steamUser.removeAllListeners()
            this.steamUser = null
        }

        if (this.cs2Instance) {
            this.cs2Instance.removeAllListeners()
            this.cs2Instance = null
        }
    }

    private clearInspectTimeout(): void {
        if (this.currentInspectTimeout) {
            clearTimeout(this.currentInspectTimeout)
            this.currentInspectTimeout = null
        }
    }

    private clearInitializationTimeout(): void {
        if (this.initializationTimeout) {
            clearTimeout(this.initializationTimeout)
            this.initializationTimeout = null
        }
    }

    private clearCooldownTimeout(): void {
        if (this.cooldownTimeout) {
            clearTimeout(this.cooldownTimeout)
            this.cooldownTimeout = null
        }
    }

    private log(message: string, isError = false): void {
        if (this.config.debug || isError) {
            const logFn = isError ? this.logger.error : this.logger.debug
            logFn.call(this.logger, `[${this.config.username}] ${message}`)
        }
    }

    private handleInitializationError(error: any): void {
        this.log(`Initialization error: ${error.message}`, true)
        this.cleanup()
        this.status = BotStatus.ERROR
        this.emit('error', this.mapError(error))
    }

    private handleDisconnect(): void {
        this.log('Disconnected from Steam')
        this.status = BotStatus.DISCONNECTED
        this.cleanup()

        this.initialize()
    }

    private handleLoggedOn(): void {
        this.log('Logged into Steam')

        if (this.steamUser) {
            this.log('Setting game played to CS2')
            this.steamUser.gamesPlayed([730])
        }
    }

    private handleGCDisconnect(): void {
        this.log('Disconnected from GC', true)
        this.status = BotStatus.ERROR

        if (this.shouldRetry({ message: 'GC_DISCONNECT' })) {
            this.log('Attempting to reconnect to GC...')
            if (this.steamUser) {
                this.steamUser.gamesPlayed([730])
            }
        } else {
            this.emit('error', BotError.GC_ERROR)
        }
    }

    private login(): void {
        this.steamUser!.logOn({
            accountName: this.config.username,
            password: this.config.password
        })
    }
}