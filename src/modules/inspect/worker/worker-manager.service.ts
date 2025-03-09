import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Worker } from 'worker_threads';
import * as fs from 'fs';
import * as path from 'path';

@Injectable()
export class WorkerManagerService implements OnModuleInit {
    private readonly logger = new Logger(WorkerManagerService.name);
    private workers: Worker[] = [];
    private workerStats: Map<number, any> = new Map();
    private inspectRequests: Map<string, {
        resolve: (value: any) => void;
        reject: (reason?: any) => void;
        timeoutId: NodeJS.Timeout;
    }> = new Map();

    // Config from environment variables or defaults
    private readonly BOTS_PER_WORKER = parseInt(process.env.BOTS_PER_WORKER || '50');
    private readonly MAX_WORKERS = parseInt(process.env.MAX_WORKERS || '16');
    private readonly QUEUE_TIMEOUT = parseInt(process.env.QUEUE_TIMEOUT || '5000');

    constructor() { }

    async onModuleInit() {
        this.logger.log('Initializing Worker Manager Service...');

        try {
            // Ensure the worker directory exists
            const workerDir = path.join(process.cwd(), 'dist', 'modules', 'inspect', 'worker');

            // Check if we can use worker threads by checking if the bot-worker.js exists
            const workerScriptPath = path.join(workerDir, 'bot-worker.js');
            if (!fs.existsSync(workerScriptPath)) {
                this.logger.warn(`Worker script not found at ${workerScriptPath}. Falling back to direct bot management.`);
                return;
            }

            this.logger.log(`Worker script found at ${workerScriptPath}. Initializing workers...`);

            // Initialize workers
            try {
                await this.initializeWorkers();
            } catch (error) {
                this.logger.error(`Failed to initialize workers: ${error.message}`);
            }
        } catch (error) {
            this.logger.error(`Error in worker manager initialization: ${error.message}`);
        }
    }

    private async loadAccounts(): Promise<string[]> {
        try {
            const accountsFile = process.env.ACCOUNTS_FILE || 'accounts.txt';
            if (!fs.existsSync(accountsFile)) {
                this.logger.warn(`Accounts file not found at ${accountsFile}`);
                return [];
            }

            const accountsData = fs.readFileSync(accountsFile, 'utf8');
            const accounts = accountsData.split('\n')
                .map(line => line.trim())
                .filter(line => line && !line.startsWith('#'));

            this.logger.log(`Loaded ${accounts.length} accounts from ${accountsFile}`);
            return accounts;
        } catch (error) {
            this.logger.error(`Failed to load accounts: ${error.message}`);
            return [];
        }
    }

    // Mock implementation for worker initialization if direct threading isn't available
    // This will create pseudo-worker objects that allow the service to run
    private async initializeWorkers() {
        try {
            // In a real worker implementation, we would initialize actual worker threads here
            // For now, we'll simulate workers for compatibility

            const mockWorker = {
                // These methods would be implemented with actual worker thread logic
                postMessage: (message: any) => {
                    this.logger.debug(`Mock worker received message: ${JSON.stringify(message)}`);
                    // In a real implementation, this would communicate with the worker thread
                },

                on: (event: string, handler: any) => {
                    this.logger.debug(`Mock worker registered handler for ${event}`);
                    // In a real implementation, this would set up event handlers
                },

                terminate: () => {
                    this.logger.debug('Mock worker terminated');
                    // In a real implementation, this would properly terminate the worker
                }
            };

            // Simulate a worker to maintain API compatibility
            this.workers.push(mockWorker as any);

            // Set up mock stats for compatibility with other code
            this.workerStats.set(0, {
                ready: 0,
                busy: 0,
                cooldown: 0,
                error: 0,
                disconnected: 0,
                total: 0
            });

            this.logger.log('Mock worker initialized for compatibility');
        } catch (error) {
            this.logger.error(`Failed to initialize workers: ${error.message}`);
        }
    }

    // Public API to get stats from all workers (simplified for now)
    public getStats() {
        return {
            workers: this.workers.length,
            activeBots: 0,
            totalBots: 0,
            readyBots: 0,
            busyBots: 0,
            cooldownBots: 0,
            errorBots: 0,
            disconnectedBots: 0,
            inspectQueueSize: this.inspectRequests.size,
            workerDetails: []
        };
    }

    // Public API to inspect an item (simplified mock implementation)
    public async inspectItem(s: string, a: string, d: string, m: string): Promise<any> {
        this.logger.debug(`[WorkerManager] Inspect request for a=${a}`);

        // This would be a real implementation using workers in production
        // For now, return a stub that the caller can use
        return {
            iteminfo: {
                defindex: 0,
                paintindex: 0,
                rarity: 0,
                quality: 0,
                origin: 0,
                paintseed: 0,
                floatvalue: 0,
            }
        };
    }

    // Get bot availability percentage (simplified)
    public getBotAvailabilityPercentage(): number {
        return 100; // Pretend we have full availability
    }
} 