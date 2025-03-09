import { Worker, isMainThread, parentPort, workerData } from 'worker_threads';
import * as fs from 'fs';
import { Bot } from '../bot.class';
import { Logger } from '@nestjs/common';

// This file handles bot initialization and management in a separate thread

class BotWorker {
    private bots: Map<string, Bot> = new Map();
    private readonly logger = new Logger('BotWorker');
    private readonly accounts: string[] = [];
    private readonly sessionPath: string;
    private readonly maxRetries: number;
    private readonly workerIndex: number;
    private readonly throttledAccounts: Map<string, number> = new Map();
    private readonly THROTTLE_COOLDOWN = 30 * 60 * 1000; // 30 minutes

    constructor(data: {
        accounts: string[];
        sessionPath: string;
        maxRetries: number;
        workerIndex: number;
    }) {
        this.accounts = data.accounts;
        this.sessionPath = data.sessionPath;
        this.maxRetries = data.maxRetries;
        this.workerIndex = data.workerIndex;
        this.logger.log(`Bot Worker ${this.workerIndex} started with ${this.accounts.length} accounts to manage`);
        this.initializeBots();
    }

    private async initializeBots() {
        try {
            // Create session directory if it doesn't exist
            if (!fs.existsSync(this.sessionPath)) {
                fs.mkdirSync(this.sessionPath, { recursive: true });
                this.logger.debug(`Created session directory at: ${this.sessionPath}`);
            }

            // Check for existing session files to prioritize accounts with saved sessions
            const existingSessionFiles = fs.readdirSync(this.sessionPath).filter(file => file.endsWith('.json'));
            const accountsWithSessions = existingSessionFiles.map(file => file.replace('.json', ''));

            const prioritizedAccounts = [];
            const remainingAccounts = [];

            // Sort accounts for optimal initialization
            this.accounts.forEach(account => {
                const [username] = account.split(':');
                const throttleExpiry = this.throttledAccounts.get(username);

                if (throttleExpiry && Date.now() < throttleExpiry) {
                    this.logger.warn(`Account ${username} is throttled. Skipping initialization.`);
                    return;
                }

                if (accountsWithSessions.includes(username)) {
                    prioritizedAccounts.push(account);
                } else {
                    remainingAccounts.push(account);
                }
            });

            // Create a final ordered queue with prioritized accounts first
            const initQueue = [...prioritizedAccounts, ...remainingAccounts];

            // Process accounts with concurrency control
            const MAX_CONCURRENT = 5; // Maximum concurrent initializations per worker
            const pool = new Set(); // Track active promises
            let processed = 0;

            while (processed < initQueue.length || pool.size > 0) {
                // Start new initializations if capacity allows and there are accounts left
                while (pool.size < MAX_CONCURRENT && processed < initQueue.length) {
                    const account = initQueue[processed++];
                    const [username, password] = account.split(':');

                    const initPromise = this.initializeBot(username, password).finally(() => {
                        pool.delete(initPromise);

                        // Report progress to main thread
                        if (parentPort) {
                            parentPort.postMessage({
                                type: 'progress',
                                processed,
                                total: initQueue.length,
                                ready: Array.from(this.bots.values()).filter(bot => bot.isReady()).length
                            });
                        }
                    });

                    pool.add(initPromise);
                }

                // If pool is full or no more accounts to process, wait for at least one promise to complete
                if (pool.size > 0) {
                    await Promise.race(Array.from(pool));
                }
            }

            // Initialization complete - report final status
            if (parentPort) {
                parentPort.postMessage({
                    type: 'initialized',
                    count: this.bots.size,
                    ready: Array.from(this.bots.values()).filter(bot => bot.isReady()).length
                });
            }

            this.logger.log(`Worker ${this.workerIndex} completed initialization: ${this.bots.size} bots, ${Array.from(this.bots.values()).filter(bot => bot.isReady()).length} ready`);
        } catch (error) {
            this.logger.error(`Worker initialization error: ${error.message}`);
            if (parentPort) {
                parentPort.postMessage({ type: 'error', message: error.message });
            }
        }
    }

    private async initializeBot(username: string, password: string): Promise<void> {
        const sessionFile = `${this.sessionPath}/${username}.json`;
        const hasExistingSession = fs.existsSync(sessionFile);

        let retryCount = 0;
        let initialized = false;

        try {
            // Try to determine if session file is valid (for logging only)
            if (hasExistingSession) {
                const stats = fs.statSync(sessionFile);
                const sessionAge = Date.now() - stats.mtimeMs;
                this.logger.debug(`Session for ${username} is ${Math.round(sessionAge / (1000 * 60 * 60))} hours old`);
            }

            while (retryCount < this.maxRetries && !initialized) {
                try {
                    const bot = new Bot({
                        username,
                        password,
                        proxyUrl: process.env.PROXY_URL,
                        debug: process.env.DEBUG === 'true',
                        sessionPath: this.sessionPath,
                        blacklistPath: process.env.BLACKLIST_PATH || './blacklist.txt',
                        inspectTimeout: 10000,
                    });

                    // Set up event handlers
                    bot.on('inspectResult', (response) => {
                        if (parentPort) {
                            parentPort.postMessage({
                                type: 'inspectResult',
                                username,
                                response
                            });
                        }
                    });

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
                        return;
                    } else if (error.message === 'LOGIN_THROTTLED') {
                        this.logger.warn(`Account ${username} is throttled. Adding to cooldown.`);
                        this.throttledAccounts.set(username, Date.now() + this.THROTTLE_COOLDOWN);
                        return;
                    } else if (error.message === 'INITIALIZATION_ERROR') {
                        this.logger.warn(`Initialization timeout for bot ${username}. Retrying...`);
                        if (retryCount >= this.maxRetries - 1) {
                            this.logger.error(`Max retries reached for bot ${username}. Initialization failed.`);
                        }
                    } else {
                        this.logger.error(`Failed to initialize bot ${username}: ${error.message || 'Unknown error'}`);
                    }
                    retryCount++;

                    // Add delay between retries
                    await new Promise(resolve => setTimeout(resolve, 500 + Math.random() * 500));
                }
            }
        } catch (error) {
            this.logger.error(`Exception during bot initialization for ${username}: ${error.message}`);
        }
    }

    // Handle messaging from main thread
    public handleMessage(message: any) {
        try {
            if (message.type === 'inspect') {
                this.handleInspectRequest(message);
            } else if (message.type === 'getStats') {
                this.sendStats();
            }
        } catch (error) {
            this.logger.error(`Error handling message: ${error.message}`);
        }
    }

    private async handleInspectRequest(message: any) {
        const { id, s, a, d, m } = message;

        try {
            // Find an available bot
            const availableBots = Array.from(this.bots.entries())
                .filter(([_, bot]) => bot.isReady())
                .map(([username, bot]) => ({ username, bot }));

            if (availableBots.length === 0) {
                if (parentPort) {
                    parentPort.postMessage({
                        type: 'inspectError',
                        id,
                        error: 'No bots available'
                    });
                }
                return;
            }

            // Simple round-robin
            const botInfo = availableBots[Math.floor(Math.random() * availableBots.length)];

            try {
                await botInfo.bot.inspectItem(m !== '0' && m ? m : s, a, d);
                // The result will be sent via the inspect result event handler
            } catch (error) {
                if (parentPort) {
                    parentPort.postMessage({
                        type: 'inspectError',
                        id,
                        error: error.message
                    });
                }
            }
        } catch (error) {
            this.logger.error(`Error processing inspect request: ${error.message}`);
            if (parentPort) {
                parentPort.postMessage({
                    type: 'inspectError',
                    id,
                    error: error.message
                });
            }
        }
    }

    private sendStats() {
        const stats = {
            total: this.bots.size,
            ready: Array.from(this.bots.values()).filter(bot => bot.isReady()).length,
            busy: Array.from(this.bots.values()).filter(bot => bot.isBusy()).length,
            cooldown: Array.from(this.bots.values()).filter(bot => bot.isCooldown()).length,
            error: Array.from(this.bots.values()).filter(bot => bot.isError()).length,
            disconnected: Array.from(this.bots.values()).filter(bot => bot.isDisconnected()).length,
            workerIndex: this.workerIndex
        };

        if (parentPort) {
            parentPort.postMessage({
                type: 'stats',
                stats
            });
        }
    }
}

// Only run worker code if this is being run as a worker thread
if (!isMainThread && parentPort) {
    const worker = new BotWorker(workerData);

    // Listen for messages from the main thread
    parentPort.on('message', (message) => {
        worker.handleMessage(message);
    });
}

// Export a function to create workers from the main thread
export function createBotWorker(accounts: string[], sessionPath: string, maxRetries: number, workerIndex: number) {
    return new Worker(__filename, {
        workerData: {
            accounts,
            sessionPath,
            maxRetries,
            workerIndex
        }
    });
} 