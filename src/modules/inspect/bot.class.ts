import * as SteamUser from 'steam-user'
import * as GlobalOffensive from 'globaloffensive'
import { Logger } from '@nestjs/common'
import { EventEmitter } from 'events'
import * as fs from 'fs/promises'
import * as path from 'path'

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
    sessionPath?: string
    blacklistPath?: string
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
    private readonly sessionFile: string
    private refreshToken: string | null = null
    private inspectCount: number = 0;
    private successCount: number = 0;
    private failureCount: number = 0;
    private lastInspectTime: number | null = null;
    private errorCount: number = 0;
    private responseTimes: number[] = [];
    private startTime: number = Date.now();
    private cooldownCount: number = 0;

    private readonly config: Required<BotConfig>

    constructor(config: BotConfig) {
        super()
        this.config = {
            initTimeout: 60000,
            inspectTimeout: 2000,
            cooldownTime: 30000,
            maxRetries: 3,
            debug: false,
            proxyUrl: '',
            sessionPath: './sessions',
            blacklistPath: './blacklist.txt',
            ...config
        }
        this.sessionFile = path.join(this.config.sessionPath, `${this.config.username}.json`)
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

        if (await this.checkBlacklist()) {
            this.status = BotStatus.ERROR
            throw new Error('Account is blacklisted')
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

            this.cs2Instance!.on('error', (err) => {
                this.log(`CS2 instance error during initialization: ${err.message}`, true)
            })

            this.steamUser!.on('error', (err) => {
                this.log(`Steam error during initialization: ${err.message}`, true)
                reject(err)
            })

            this.steamUser!.on('disconnected', (err) => {
                this.log(`Steam disconnected during initialization: ${err.message}`, true)
                reject(err)
            })

            this.steamUser!.on('loggedOff', (err) => {
                this.log(`Steam logged off during initialization: ${err.message}`, true)
                reject(err)
            })

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

        // Handle Steam Guard code request
        this.steamUser!.on('steamGuard', async (domain: string, callback: (code: string) => void) => {
            this.log('Steam Guard code requested - this account has Steam Guard enabled', true)
            await this.addToBlacklist('STEAM_GUARD_REQUIRED')
            callback('')
        })

        this.steamUser!.on('loggedOn', async (details: any) => {
            this.log(`Logged in successfully. Account flags: ${details?.account_flags || 'unknown'}`)
            await this.handleLoggedOn()
        })

        this.steamUser!.on('refreshToken', async (token: string) => {
            this.log('Received new refresh token')
            if (token) {
                this.refreshToken = token
                await this.saveSession()
            }
        })

        this.steamUser!.on('webSession', async () => {
            this.log('Web session established')
            const token = this.steamUser?.refreshToken
            if (token) {
                this.log('Refresh token available after web session')
                await this.saveSession()
            } else {
                this.log('No refresh token available after web session')
            }
        })

        if (this.config.debug) {
            this.steamUser!.on('debug', (msg: string) => {
                this.log(`Steam Debug: ${msg}`)
            })
        }
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

        if (error.message.includes('InvalidPassword') ||
            error.message.includes('AccountDisabled')
            // || error.message.includes('AccountLoginDeniedThrottle')
        ) {
            this.addToBlacklist(this.mapError(error))
                .catch(err => this.log(`Failed to add to blacklist: ${err.message}`, true))
        }

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
    private requestCS2License() {
        this.steamUser.requestFreeLicense([730], (err, grantedPackages, grantedAppIDs) => {
            this.log(`${this.config.username} Granted Packages`, grantedPackages)
            this.log(`${this.config.username} Granted App IDs`, grantedAppIDs)
            if (err) {
                this.log(`${this.config.username} Failed to obtain free CS:GO license`, true)
            } else {
                this.log(`${this.config.username}: Initiating GC Connection`)
                this.steamUser.gamesPlayed([730], true)
            }
        })
    }

    private async handleLoggedOn(): Promise<void> {
        this.log('Logged into Steam')
        this.steamUser.once('ownershipCached', () => {
            if (!this.steamUser.ownsApp(730)) {
                this.log(`${this.config.username} doesn't own CS:GO, retrieving free license`)
                this.requestCS2License()
            } else {
                this.log(`${this.config.username}: Initiating GC Connection`)
                this.steamUser.gamesPlayed([730], true)
            }
        })
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

    private async login(): Promise<void> {
        try {
            const session = await this.loadSession()

            // First try with refresh token if available
            if (session?.refreshToken) {
                this.log('Found existing refresh token, attempting to use it')
                this.steamUser!.logOn({
                    refreshToken: session.refreshToken,
                    logonID: Math.floor(Math.random() * 100000000),
                    machineName: `CS2Bot_${this.config.username}`
                })
            } else {
                // Password login with required properties
                this.log('Attempting password login')
                this.steamUser!.logOn({
                    accountName: this.config.username,
                    password: this.config.password,
                    logonID: Math.floor(Math.random() * 100000000),
                    machineName: `CS2Bot_${this.config.username}`
                })

            }
        } catch (error) {
            this.log(`Login error: ${error.message}`, true)
            throw error
        }
    }

    private async loadSession(): Promise<any> {
        try {
            await fs.mkdir(this.config.sessionPath, { recursive: true })
            const data = await fs.readFile(this.sessionFile, 'utf8')
            const session = JSON.parse(data)

            if (session?.refreshToken) {
                this.log('Found existing session data')
                // Check if the session is not too old (e.g., 180 days)
                const ageInDays = (Date.now() - (session.timestamp || 0)) / (1000 * 60 * 60 * 24)
                if (ageInDays > 180) {
                    this.log('Session is too old, will create new one')
                    return null
                }
            }

            return session
        } catch (error) {
            this.log('No existing session found or error reading session')
            return null
        }
    }

    private async saveSession(): Promise<void> {
        try {
            if (!this.steamUser) {
                this.log('Cannot save session: Steam user is null', true)
                return
            }

            const refreshToken = this.refreshToken

            if (!refreshToken) {
                this.log('No refresh token available to save - this might be normal for Steam Guard enabled accounts', true)
                return
            }

            const session = {
                refreshToken,
                timestamp: Date.now(),
                username: this.config.username,
                hasGuard: this.steamUser?.isSteamGuardEnabled || false
            }

            await fs.mkdir(this.config.sessionPath, { recursive: true })
            await fs.writeFile(
                this.sessionFile,
                JSON.stringify(session, null, 2)
            )

            this.log(`Session saved successfully for ${this.config.username}`)
        } catch (error) {
            this.log(`Failed to save session: ${error.message}`, true)
        }
    }

    private async checkBlacklist(): Promise<boolean> {
        try {
            const content = await fs.readFile(this.config.blacklistPath, 'utf8')
            const blacklistedAccounts = content.split('\n').map(line => line.trim())
            return blacklistedAccounts.includes(this.config.username)
        } catch (error) {
            // If file doesn't exist, create it
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
                await fs.writeFile(this.config.blacklistPath, '', 'utf8')
                return false
            }
            throw error
        }
    }

    private async addToBlacklist(reason: string): Promise<void> {
        const entry = `${this.config.username}:${reason}:${new Date().toISOString()}`
        await fs.appendFile(this.config.blacklistPath, entry + '\n', 'utf8')
        this.log(`Account added to blacklist: ${entry}`)
    }

    public getInspectCount(): number {
        return this.inspectCount;
    }

    public getSuccessCount(): number {
        return this.successCount;
    }

    public getFailureCount(): number {
        return this.failureCount;
    }

    public getLastInspectTime(): number | null {
        return this.lastInspectTime;
    }

    public getErrorCount(): number {
        return this.errorCount;
    }

    public getAverageResponseTime(): number {
        return this.responseTimes.length > 0
            ? this.responseTimes.reduce((a, b) => a + b, 0) / this.responseTimes.length
            : 0;
    }

    public getUptime(): string {
        const ms = Date.now() - this.startTime
        const days = Math.floor(ms / (24 * 60 * 60 * 1000))
        const hours = Math.floor((ms % (24 * 60 * 60 * 1000)) / (60 * 60 * 1000))
        const minutes = Math.floor((ms % (60 * 60 * 1000)) / (60 * 1000))
        const seconds = Math.floor((ms % (60 * 1000)) / 1000)
        return `${days}d ${hours}h ${minutes}m ${seconds}s`
    }

    public getCooldownCount(): number {
        return this.cooldownCount;
    }

    public incrementSuccessCount(): void {
        this.successCount++;
    }

    public incrementFailureCount(): void {
        this.failureCount++;
    }

    public incrementInspectCount(): void {
        this.inspectCount++;
        this.lastInspectTime = Date.now();
    }

    public addResponseTime(time: number): void {
        this.responseTimes.push(time);
        // Keep only last 100 response times to avoid memory bloat
        if (this.responseTimes.length > 100) {
            this.responseTimes.shift();
        }
    }
}