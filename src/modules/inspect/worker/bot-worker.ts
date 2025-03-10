import { parentPort, workerData } from 'worker_threads';
import { Bot } from '../bot.class';
import * as fs from 'fs';
import { Logger } from '@nestjs/common';

/**
 * Worker thread implementation for managing a batch of bots
 */
class BotWorker {
    private readonly logger = new Logger('BotWorker');
    private bots: Map<string, Bot> = new Map();
    private accounts: string[] = [];
    private throttledAccounts: Map<string, number> = new Map();
    private readonly THROTTLE_COOLDOWN = 30 * 60 * 1000; // 30 minutes
    private readonly MAX_RETRIES = parseInt(process.env.MAX_RETRIES || '3');
    private readonly workerId: number;

    constructor() {
        this.workerId = workerData.workerId;
        this.accounts = workerData.accounts || [];

        this.logger.log(`Worker ${this.workerId} initialized with ${this.accounts.length} accounts`);

        this.setupCommunication();
        this.initializeBots();

        // Set up periodic stats reporting
        this.setupPeriodicStatsReporting();
    }

    private setupCommunication() {
        if (!parentPort) {
            this.logger.error('No parent port available for worker communication');
            return;
        }

        parentPort.on('message', (message) => {
            switch (message.type) {
                case 'inspectItem':
                    this.handleInspectRequest(message);
                    break;
                case 'getStats':
                    this.sendStats();
                    break;
                case 'shutdown':
                    this.shutdown();
                    break;
                default:
                    this.logger.warn(`Unknown message type: ${message.type}`);
            }
        });
    }

    private async initializeBots() {
        this.logger.log(`Worker ${this.workerId} initializing ${this.accounts.length} bots`);
        const sessionPath = process.env.SESSION_PATH || './sessions';

        // Ensure session directory exists
        if (!fs.existsSync(sessionPath)) {
            fs.mkdirSync(sessionPath, { recursive: true });
            this.logger.debug(`Created session directory: ${sessionPath}`);
        }

        // Track initialization progress for logging
        let successCount = 0;
        let failureCount = 0;

        for (const account of this.accounts) {
            const [username, password] = account.split(':');

            // Skip throttled accounts
            const throttleExpiry = this.throttledAccounts.get(username);
            if (throttleExpiry && Date.now() < throttleExpiry) {
                this.logger.warn(`Account ${username} is throttled. Skipping initialization.`);
                continue;
            }

            let retryCount = 0;
            let initialized = false;

            while (retryCount < this.MAX_RETRIES && !initialized) {
                try {
                    const bot = new Bot({
                        username,
                        password,
                        proxyUrl: process.env.PROXY_URL,
                        debug: process.env.DEBUG === 'true',
                        sessionPath,
                        blacklistPath: process.env.BLACKLIST_PATH || './blacklist.txt',
                        inspectTimeout: 2000,
                    });

                    // Forward bot events to parent process
                    bot.on('inspectResult', (response) => this.handleInspectResult(username, response));
                    bot.on('error', (error) => {
                        this.logger.error(`Bot ${username} error: ${error}`);
                    });

                    await bot.initialize();
                    this.bots.set(username, bot);
                    initialized = true;
                    successCount++;

                    // Clear throttle status if successful
                    this.throttledAccounts.delete(username);

                    // Notify parent about successful initialization
                    this.sendToParent({
                        type: 'botInitialized',
                        workerId: this.workerId,
                        username,
                        status: bot.isReady() ? 'ready' : 'initializing'
                    });

                    this.logger.debug(`Bot ${username} initialized successfully with status: ${bot.isReady() ? 'ready' : 'initializing'}`);
                } catch (error) {
                    failureCount++;
                    if (error.message === 'ACCOUNT_DISABLED') {
                        this.logger.error(`Account ${username} is disabled. Blacklisting...`);
                        this.accounts = this.accounts.filter(acc => !acc.startsWith(username));
                        break;
                    } else if (error.message === 'LOGIN_THROTTLED') {
                        this.logger.warn(`Account ${username} is throttled. Adding to cooldown.`);
                        this.throttledAccounts.set(username, Date.now() + this.THROTTLE_COOLDOWN);
                        break;
                    } else {
                        this.logger.error(`Failed to initialize bot ${username}: ${error.message}`);
                    }
                    retryCount++;
                }
            }
        }

        // Send comprehensive stats after all bots are initialized
        this.logger.log(`Worker ${this.workerId} finished initializing ${this.bots.size} bots (${successCount} success, ${failureCount} failures)`);

        // Send complete stats to parent
        this.sendStats();
    }

    private setupPeriodicStatsReporting() {
        // Send stats every 3 seconds to balance between real-time updates and overhead
        const STATS_UPDATE_INTERVAL = parseInt(process.env.STATS_UPDATE_INTERVAL || '3000');
        setInterval(() => {
            this.sendStats();
        }, STATS_UPDATE_INTERVAL);
    }

    private async handleInspectRequest(message: any) {
        const { s, a, d, m, requestId } = message;

        try {
            const bot = await this.getAvailableBot();
            if (!bot) {
                this.sendToParent({
                    type: 'inspectError',
                    requestId,
                    assetId: a,
                    error: 'No bots are ready in this worker'
                });
                return;
            }

            // Notify parent that a bot is now busy (real-time status update)
            this.sendToParent({
                type: 'botStatusChange',
                workerId: this.workerId,
                username: this.getBotUsername(bot),
                status: 'busy',
                assetId: a
            });

            // Send updated stats immediately after status change
            this.sendStats();

            await bot.inspectItem(m !== '0' && m ? m : s, a, d);
        } catch (error) {
            this.sendToParent({
                type: 'inspectError',
                requestId,
                assetId: a,
                error: error.message
            });
        }
    }

    private handleInspectResult(username: string, response: any) {
        const bot = this.bots.get(username);
        if (!bot) return;

        // Increment bot stats
        bot.incrementSuccessCount();
        bot.incrementInspectCount();

        // Notify parent that bot is now ready again (real-time status update)
        this.sendToParent({
            type: 'botStatusChange',
            workerId: this.workerId,
            username,
            status: 'ready',
            assetId: response.itemid?.toString()
        });

        // Send result back to parent
        this.sendToParent({
            type: 'inspectResult',
            workerId: this.workerId,
            assetId: response.itemid?.toString(),
            result: response
        });

        // Send updated stats immediately after status change
        this.sendStats();
    }

    private getBotUsername(bot: Bot): string {
        // Find the username for a bot instance
        for (const [username, botInstance] of this.bots.entries()) {
            if (botInstance === bot) {
                return username;
            }
        }
        return 'unknown';
    }

    private async getAvailableBot(): Promise<Bot | null> {
        const readyBots = Array.from(this.bots.entries())
            .filter(([_, bot]) => bot.isReady());

        if (readyBots.length === 0) {
            return null;
        }

        // Simple round-robin selection
        const randomIndex = Math.floor(Math.random() * readyBots.length);
        return readyBots[randomIndex][1];
    }

    private sendStats() {
        const readyBots = Array.from(this.bots.values()).filter(bot => bot.isReady()).length;
        const busyBots = Array.from(this.bots.values()).filter(bot => bot.isBusy()).length;
        const cooldownBots = Array.from(this.bots.values()).filter(bot => bot.isCooldown()).length;
        const errorBots = Array.from(this.bots.values()).filter(bot => bot.isError()).length;
        const disconnectedBots = Array.from(this.bots.values()).filter(bot => bot.isDisconnected()).length;
        const totalBots = this.bots.size;

        const botDetails = Array.from(this.bots.entries()).map(([username, bot]) => {
            return {
                username: username.substring(0, 10), // Truncate username
                status: bot.isReady() ? 'ready' :
                    bot.isBusy() ? 'busy' :
                        bot.isCooldown() ? 'cooldown' :
                            bot.isDisconnected() ? 'disconnected' : 'error',
                inspectCount: bot.getInspectCount() || 0,
                successCount: bot.getSuccessCount() || 0,
                failureCount: bot.getFailureCount() || 0,
                lastInspectTime: bot.getLastInspectTime() || null
            };
        });

        // Log stats for debugging
        this.logger.debug(`Worker ${this.workerId} stats: ready=${readyBots}, busy=${busyBots}, cooldown=${cooldownBots}, error=${errorBots}, disconnected=${disconnectedBots}, total=${totalBots}`);

        this.sendToParent({
            type: 'stats',
            workerId: this.workerId,
            stats: {
                readyBots,
                busyBots,
                cooldownBots,
                errorBots,
                disconnectedBots,
                totalBots,
                botDetails
            }
        });
    }

    private async shutdown() {
        this.logger.log(`Worker ${this.workerId} shutting down...`);

        // Destroy all bots
        const destroyPromises = Array.from(this.bots.values()).map(bot => bot.destroy());
        await Promise.allSettled(destroyPromises);

        this.logger.log(`Worker ${this.workerId} shut down ${this.bots.size} bots`);

        // Notify parent that we're done
        this.sendToParent({
            type: 'shutdown',
            workerId: this.workerId,
            status: 'completed'
        });

        // Exit the worker thread
        if (parentPort) {
            parentPort.close();
        }
        process.exit(0);
    }

    private sendToParent(message: any) {
        if (parentPort) {
            parentPort.postMessage(message);
        }
    }
}

process.on('uncaughtException', err => {
    // console.log(`Uncaught Exception: ${err.message}`)
    // process.exit(1)
})
process.on('unhandledRejection', (reason, promise) => {
    // console.log('Unhandled rejection at ', promise, `reason: ${reason.message}`)
    // process.exit(1)
})


// Start the worker
new BotWorker();
