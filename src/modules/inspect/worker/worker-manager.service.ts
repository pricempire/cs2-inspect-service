import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Asset } from 'src/entities/asset.entity';
import { History, HistoryType } from 'src/entities/history.entity';
import { Bot } from '../bot.class';
import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';

@Injectable()
export class WorkerManagerService implements OnModuleInit {
    private readonly logger = new Logger(WorkerManagerService.name);
    private bots: Map<string, Bot> = new Map();
    private accounts: string[] = [];
    private throttledAccounts: Map<string, number> = new Map();
    private readonly THROTTLE_COOLDOWN = 30 * 60 * 1000; // 30 minutes
    private readonly MAX_RETRIES = parseInt(process.env.MAX_RETRIES || '3');
    private readonly MAX_CONCURRENT = parseInt(process.env.MAX_CONCURRENT_INIT || '10');
    private nextBot = 0;

    // Add a map to store pending inspection requests
    private inspectRequests: Map<string, {
        resolve: (value: any) => void;
        reject: (reason?: any) => void;
        timeoutId: NodeJS.Timeout;
        startTime?: number;
        retryCount?: number;
        inspectUrl?: { s: string, a: string, d: string, m: string };
        ms?: string;
    }> = new Map();

    // Track stats like the original service
    private success = 0;
    private failed = 0;
    private cached = 0;
    private timeouts = 0;

    constructor(
        @InjectRepository(Asset)
        private assetRepository: Repository<Asset>,
        @InjectRepository(History)
        private historyRepository: Repository<History>,
    ) { }

    async onModuleInit() {
        this.logger.log('Initializing Worker Manager Service...');

        try {
            // Load accounts
            await this.loadAccounts();

            // Initialize bots
            await this.initializeBots();
        } catch (error) {
            this.logger.error(`Error in worker manager initialization: ${error.message}`);
        }
    }

    private async loadAccounts(): Promise<void> {
        try {
            const accountsFile = process.env.ACCOUNTS_FILE || 'accounts.txt';
            if (!fs.existsSync(accountsFile)) {
                this.logger.warn(`Accounts file not found at ${accountsFile}`);
                return;
            }

            const accountsData = fs.readFileSync(accountsFile, 'utf8');
            this.accounts = accountsData.split('\n')
                .map(line => line.trim())
                .filter(line => line && !line.startsWith('#'));

            this.logger.log(`Loaded ${this.accounts.length} accounts from ${accountsFile}`);
        } catch (error) {
            this.logger.error(`Failed to load accounts: ${error.message}`);
        }
    }

    private async initializeBots(): Promise<void> {

        this.logger.log('Initializing bots...');
        const activeInitializations = new Set<string>();
        const botPromises: Promise<void>[] = [];

        for (const account of this.accounts) {
            const [username, password] = account.split(':');

            // Check if account is throttled
            const throttleExpiry = this.throttledAccounts.get(username);
            if (throttleExpiry && Date.now() < throttleExpiry) {
                this.logger.warn(`Account ${username} is throttled. Skipping initialization.`);
                continue;
            }

            // Wait if we've reached the concurrent initialization limit
            while (activeInitializations.size >= this.MAX_CONCURRENT) {
                await new Promise(resolve => setTimeout(resolve, 100));
            }

            activeInitializations.add(username);

            const initializeAccount = async (account: string) => {
                const [username, password] = account.split(':');

                try {
                    const bot = new Bot({
                        username,
                        password,
                        proxyUrl: process.env.PROXY_URL,
                        debug: process.env.DEBUG === 'true',
                        sessionPath: process.env.SESSION_PATH || './sessions',
                        blacklistPath: process.env.BLACKLIST_PATH || './blacklist.txt',
                        inspectTimeout: 10000,
                    });

                    // Listen for bot events
                    bot.on('error', (error) => {
                        this.logger.error(`Bot ${username} error: ${error}`);
                    });

                    await bot.initialize();
                    this.bots.set(username, bot);
                    this.logger.debug(`Bot ${username} initialized successfully`);

                    // Clear throttle status if successful
                    this.throttledAccounts.delete(username);
                } catch (error) {
                    if (error.message === 'ACCOUNT_DISABLED') {
                        this.logger.error(`Account ${username} is disabled. Blacklisting...`);
                        this.accounts = this.accounts.filter(acc => !acc.startsWith(username));
                    } else if (error.message === 'LOGIN_THROTTLED') {
                        this.logger.warn(`Account ${username} is throttled. Adding to cooldown.`);
                        this.throttledAccounts.set(username, Date.now() + this.THROTTLE_COOLDOWN);
                    } else {
                        this.logger.error(`Failed to initialize bot ${username}: ${error.message}`);
                    }
                } finally {
                    activeInitializations.delete(username);
                }
            };

            botPromises.push(initializeAccount(account));
        }

        await Promise.allSettled(botPromises);
        this.logger.log(`Initialized ${this.bots.size} bots successfully`);
    }

    // Get stats to satisfy the InspectService requirements
    public getStats() {
        // Count the bots in each status
        const readyBots = Array.from(this.bots.values()).filter(bot => bot.isReady()).length;
        const busyBots = Array.from(this.bots.values()).filter(bot => bot.isBusy()).length;
        const cooldownBots = Array.from(this.bots.values()).filter(bot => bot.isCooldown()).length;
        const errorBots = Array.from(this.bots.values()).filter(bot => bot.isError()).length;
        const disconnectedBots = Array.from(this.bots.values()).filter(bot => bot.isDisconnected()).length;
        const totalBots = this.bots.size;

        const botDetails = Array.from(this.bots.entries()).map(([username, bot]) => {
            return {
                username: username.substring(0, 10), // Truncate to 10 characters
                status: bot.isReady() ? 'ready' :
                    bot.isBusy() ? 'busy' :
                        bot.isCooldown() ? 'cooldown' :
                            bot.isDisconnected() ? 'disconnected' :
                                bot.isError() ? 'error' : 'initializing',
                inspectCount: bot.getInspectCount() || 0,
                successCount: bot.getSuccessCount() || 0,
                failureCount: bot.getFailureCount() || 0,
                lastInspectTime: bot.getLastInspectTime() || null,
                errorCount: bot.getErrorCount() || 0,
                avgResponseTime: bot.getAverageResponseTime() || 0,
                uptime: bot.getUptime() || 0,
            };
        });

        return {
            readyBots,
            busyBots,
            cooldownBots,
            errorBots,
            disconnectedBots,
            totalBots,
            botDetails,
            // For compatibility with existing code
            workers: 1,
            workerDetails: [
                {
                    id: 1,
                    status: 'ready',
                    bots: totalBots,
                    ready: readyBots,
                    busy: busyBots,
                    cooldown: cooldownBots,
                    error: errorBots,
                    disconnected: disconnectedBots
                }
            ]
        };
    }

    // Get bot availability percentage
    public getBotAvailabilityPercentage(): number {
        const totalBots = this.bots.size;
        if (totalBots === 0) return 0;

        const readyBots = Array.from(this.bots.values()).filter(bot => bot.isReady()).length;
        return (readyBots / totalBots) * 100;
    }

    // Get an available bot for inspections
    private async getAvailableBot(): Promise<Bot | null> {
        const readyBots = Array.from(this.bots.entries())
            .filter(([_, bot]) => bot.isReady());

        if (readyBots.length === 0) {
            return null;
        }

        // Get the next available bot using the total number of bots
        const startIndex = this.nextBot;
        let attempts = 0;

        // Try finding an available bot, starting from the next position
        while (attempts < this.bots.size) {
            const currentIndex = (startIndex + attempts) % this.bots.size;
            const bot = Array.from(this.bots.values())[currentIndex];

            if (bot && bot.isReady()) {
                this.nextBot = (currentIndex + 1) % this.bots.size;
                return bot;
            }

            attempts++;
        }

        // If we get here, return the first available bot
        return readyBots[0][1]; // Extract the Bot from the [string, Bot] tuple
    }

    // Update the inspectItem method to use the inspect requests map
    public async inspectItem(s: string, a: string, d: string, m: string): Promise<any> {
        try {
            const bot = await this.getAvailableBot();
            if (!bot) {
                throw new Error('No bots are ready');
            }

            // Use a promise to wait for the inspect result
            return new Promise<any>((resolve, reject) => {
                // Create timeout to handle inspection timeouts
                const timeoutId = setTimeout(() => {
                    this.inspectRequests.delete(a);
                    this.timeouts++;
                    reject(new Error('Inspection request timed out'));
                }, 10000);

                // Store the promise handlers and inspection data
                this.inspectRequests.set(a, {
                    resolve,
                    reject,
                    timeoutId,
                    startTime: Date.now(),
                    retryCount: 0,
                    inspectUrl: { s, a, d, m },
                    ms: m !== '0' && m ? m : s
                });

                // Listen for the inspectResult event from the bot
                const handleInspectResult = (result: any) => {
                    if (result.itemid?.toString() === a) {
                        // Remove the listener to avoid memory leaks
                        bot.removeListener('inspectResult', handleInspectResult);

                        try {
                            // Process the inspect result (just log success and cleanup)
                            bot.incrementSuccessCount();
                            bot.incrementInspectCount();
                            this.success++;

                            // Return the raw result to InspectService to handle DB operations
                            resolve(result);
                        } catch (error) {
                            this.logger.error(`Error handling inspect result: ${error.message}`);
                            reject(error);
                        } finally {
                            clearTimeout(timeoutId);
                            this.inspectRequests.delete(a);
                        }
                    }
                };

                // Add the event listener
                bot.on('inspectResult', handleInspectResult);

                // Send the inspection request to the bot
                bot.inspectItem(m !== '0' && m ? m : s, a, d).catch(error => {
                    bot.removeListener('inspectResult', handleInspectResult);
                    clearTimeout(timeoutId);
                    this.inspectRequests.delete(a);
                    this.failed++;
                    reject(error);
                });
            });
        } catch (error) {
            this.logger.error(`Error inspecting item: ${error.message}`);
            throw error;
        }
    }
} 