import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Asset } from 'src/entities/asset.entity';
import { History, HistoryType } from 'src/entities/history.entity';
import { Bot } from '../bot.class';
import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import { Worker } from 'worker_threads';
import { spawnWorker } from './spawn-worker';

interface WorkerInfo {
    id: number;
    worker: Worker;
    stats: {
        readyBots: number;
        busyBots: number;
        cooldownBots: number;
        errorBots: number;
        disconnectedBots: number;
        totalBots: number;
        botDetails: any[];
    };
    status: 'initializing' | 'ready' | 'error';
}

interface InspectRequest {
    resolve: (value: any) => void;
    reject: (reason?: any) => void;
    timeoutId: NodeJS.Timeout;
    startTime?: number;
    retryCount?: number;
    inspectUrl?: { s: string, a: string, d: string, m: string };
    ms?: string;
    requestId: string;
}

@Injectable()
export class WorkerManagerService implements OnModuleInit {
    private readonly logger = new Logger(WorkerManagerService.name);
    private bots: Map<string, Bot> = new Map();
    private accounts: string[] = [];
    private throttledAccounts: Map<string, number> = new Map();
    private readonly THROTTLE_COOLDOWN = 30 * 60 * 1000; // 30 minutes
    private readonly MAX_RETRIES = parseInt(process.env.MAX_RETRIES || '3');
    private readonly MAX_CONCURRENT = parseInt(process.env.MAX_CONCURRENT_INIT || '10');
    private readonly BOTS_PER_WORKER = parseInt(process.env.BOTS_PER_WORKER || '50');
    private readonly WORKER_TIMEOUT = parseInt(process.env.WORKER_TIMEOUT || '60000'); // 1 minute

    private workers: WorkerInfo[] = [];
    private nextWorkerId = 0;

    private inspectRequests: Map<string, InspectRequest> = new Map();

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
        if (process.env.WORKER_ENABLED !== 'true') {
            this.logger.warn('Worker initialization is disabled. Set WORKER_ENABLED=true to enable.');
            return;
        }

        await this.loadAccounts();

        if (this.accounts.length > 0) {
            await this.createWorkers();
        } else {
            this.logger.warn('No accounts loaded, workers will not be created');
        }
    }

    private async loadAccounts(): Promise<void> {
        const accountsFile = process.env.ACCOUNTS_FILE || 'accounts.txt';
        this.logger.debug(`Loading accounts from ${accountsFile}`);

        try {
            // Try loading from the specified file
            if (fs.existsSync(accountsFile)) {
                const content = fs.readFileSync(accountsFile, 'utf8');
                this.processAccountFile(content);
                return;
            }

            // Try alternative locations
            const fallbackLocations = [
                'accounts.txt',
                '../accounts.txt',
                '/app/accounts.txt'
            ];

            for (const location of fallbackLocations) {
                if (fs.existsSync(location)) {
                    const content = fs.readFileSync(location, 'utf8');
                    this.processAccountFile(content);
                    this.logger.debug(`Loaded accounts from fallback location: ${location}`);
                    return;
                }
            }

            throw new Error(`Accounts file not found at ${accountsFile} or fallback locations`);
        } catch (error) {
            this.logger.error(`Failed to load accounts: ${error.message}`);
        }
    }

    private processAccountFile(content: string): void {
        this.accounts = content.split('\n')
            .map(line => line.trim())
            .filter(line => line && !line.startsWith('#'));

        // Randomize accounts for better distribution
        this.accounts = this.accounts.sort(() => Math.random() - 0.5);

        this.logger.log(`Loaded ${this.accounts.length} accounts`);
    }

    private async createWorkers(): Promise<void> {
        const numWorkers = Math.ceil(this.accounts.length / this.BOTS_PER_WORKER);
        this.logger.log(`Creating ${numWorkers} workers for ${this.accounts.length} accounts (${this.BOTS_PER_WORKER} bots per worker)`);

        for (let i = 0; i < numWorkers; i++) {
            const workerAccounts = this.accounts.slice(
                i * this.BOTS_PER_WORKER,
                (i + 1) * this.BOTS_PER_WORKER
            );

            await this.createWorker(i, workerAccounts);
        }

        this.logger.log(`All ${numWorkers} workers created and initializing`);
    }

    private async createWorker(workerId: number, accounts: string[]): Promise<void> {
        try {
            const workerPath = path.join('bot-worker.js');

            // Create a new worker thread using our helper
            const worker = spawnWorker(workerPath, {
                workerId,
                accounts
            }, {
                // Pass environment variables to the worker
                env: process.env
            });

            // Store worker info
            this.workers.push({
                id: workerId,
                worker,
                stats: {
                    readyBots: 0,
                    busyBots: 0,
                    cooldownBots: 0,
                    errorBots: 0,
                    disconnectedBots: 0,
                    totalBots: 0,
                    botDetails: []
                },
                status: 'initializing'
            });

            // Set up event handlers
            this.setupWorkerCommunication(worker, workerId);

            this.logger.debug(`Worker ${workerId} created with ${accounts.length} accounts`);
        } catch (error) {
            this.logger.error(`Failed to create worker ${workerId}: ${error.message}`);
        }
    }

    private setupWorkerCommunication(worker: Worker, workerId: number): void {
        worker.on('message', (message: any) => {
            switch (message.type) {
                case 'botInitialized':
                    this.handleBotInitialized(message);
                    break;
                case 'inspectResult':
                    this.handleInspectResult(message);
                    break;
                case 'inspectError':
                    this.handleInspectError(message);
                    break;
                case 'stats':
                    this.updateWorkerStats(workerId, message.stats);
                    break;
                case 'shutdown':
                    this.logger.log(`Worker ${workerId} shut down successfully`);
                    this.removeWorker(workerId);
                    break;
                default:
                    this.logger.warn(`Unknown message from worker ${workerId}: ${message.type}`);
            }
        });

        worker.on('error', (error) => {
            this.logger.error(`Worker ${workerId} error: ${error.message}`);
            this.updateWorkerStatus(workerId, 'error');
        });

        worker.on('exit', (code) => {
            if (code !== 0) {
                this.logger.error(`Worker ${workerId} exited with code ${code}`);
            } else {
                this.logger.log(`Worker ${workerId} exited cleanly`);
            }
            this.removeWorker(workerId);
        });
    }

    private handleBotInitialized(message: any): void {
        const { workerId, username, status } = message;
        this.logger.debug(`Bot ${username} initialized in worker ${workerId} with status ${status}`);

        // Update worker status if there's at least one ready bot
        if (status === 'ready') {
            const workerInfo = this.workers.find(w => w.id === workerId);
            if (workerInfo) {
                // Mark the worker as ready since it has at least one ready bot
                workerInfo.status = 'ready';

                // Request fresh stats after bot initialization
                workerInfo.worker.postMessage({ type: 'getStats' });

                this.logger.debug(`Worker ${workerId} marked as ready with at least one ready bot`);
            }
        }
    }

    private handleInspectResult(message: any): void {
        const { workerId, assetId, result } = message;

        const request = this.inspectRequests.get(assetId);
        if (!request) {
            this.logger.warn(`Received inspect result for unknown request: ${assetId}`);
            return;
        }

        try {
            clearTimeout(request.timeoutId);
            this.success++;
            request.resolve(result);
        } catch (error) {
            this.logger.error(`Error handling inspect result: ${error.message}`);
            request.reject(error);
        } finally {
            this.inspectRequests.delete(assetId);
        }
    }

    private handleInspectError(message: any): void {
        const { requestId, assetId, error } = message;

        const request = this.inspectRequests.get(assetId);
        if (!request) {
            this.logger.warn(`Received inspect error for unknown request: ${assetId}`);
            return;
        }

        clearTimeout(request.timeoutId);
        this.failed++;
        request.reject(new Error(error));
        this.inspectRequests.delete(assetId);
    }

    private updateWorkerStats(workerId: number, stats: any): void {
        const workerInfo = this.workers.find(w => w.id === workerId);
        if (workerInfo) {
            // Update stats
            workerInfo.stats = stats;

            // Update worker status based on available bots
            if (stats.readyBots > 0 && workerInfo.status !== 'ready') {
                this.updateWorkerStatus(workerId, 'ready');
                this.logger.debug(`Worker ${workerId} marked ready with ${stats.readyBots} ready bots`);
            } else if (stats.readyBots === 0 && workerInfo.status === 'ready') {
                // Still mark as ready but log a warning
                this.logger.warn(`Worker ${workerId} has no ready bots but status is ready`);
            }

            // Log stats periodically (to reduce log spam, only log when ready bots change)
            if (stats.readyBots > 0) {
                this.logger.debug(`Worker ${workerId} stats: ready=${stats.readyBots}, busy=${stats.busyBots}, total=${stats.totalBots}`);
            }
        }
    }

    private updateWorkerStatus(workerId: number, status: 'initializing' | 'ready' | 'error'): void {
        const workerInfo = this.workers.find(w => w.id === workerId);
        if (workerInfo) {
            workerInfo.status = status;
        }
    }

    private removeWorker(workerId: number): void {
        this.workers = this.workers.filter(w => w.id !== workerId);
    }

    public getBotAvailabilityPercentage(): number {
        const totalBots = this.getTotalBots();
        if (totalBots === 0) return 0;

        const readyBots = this.getReadyBots();
        return (readyBots / totalBots) * 100;
    }

    private getTotalBots(): number {
        return this.workers.reduce((sum, worker) => sum + worker.stats.totalBots, 0);
    }

    private getReadyBots(): number {
        return this.workers.reduce((sum, worker) => sum + worker.stats.readyBots, 0);
    }

    private async getAvailableWorker(): Promise<WorkerInfo | null> {
        // Filter workers that are ready and have available bots
        const availableWorkers = this.workers.filter(w =>
            w.status === 'ready' && w.stats.readyBots > 0
        );

        if (availableWorkers.length === 0) {
            // Log detailed information about all workers for debugging
            this.logger.warn(`No available workers found. Worker states:`);
            this.workers.forEach(w => {
                this.logger.warn(`Worker ${w.id}: status=${w.status}, readyBots=${w.stats.readyBots}, totalBots=${w.stats.totalBots}`);
            });

            // Refresh stats from all workers
            this.workers.forEach(w => {
                if (w.worker) {
                    try {
                        w.worker.postMessage({ type: 'getStats' });
                    } catch (e) {
                        this.logger.error(`Error requesting stats from worker ${w.id}: ${e.message}`);
                    }
                }
            });

            return null;
        }

        // Simple round-robin selection
        const workerIndex = this.nextWorkerId % availableWorkers.length;
        this.nextWorkerId = (this.nextWorkerId + 1) % Math.max(1, availableWorkers.length);

        const selectedWorker = availableWorkers[workerIndex];
        this.logger.debug(`Selected worker ${selectedWorker.id} with ${selectedWorker.stats.readyBots} ready bots`);

        return selectedWorker;
    }

    public async inspectItem(s: string, a: string, d: string, m: string): Promise<any> {
        try {
            const worker = await this.getAvailableWorker();
            if (!worker) {
                throw new Error('No workers with available bots');
            }

            // Use a promise to wait for the inspect result
            return new Promise<any>((resolve, reject) => {
                // Generate a unique request ID
                const requestId = `${Date.now()}-${Math.random().toString(36).substring(2, 15)}`;

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
                    ms: m !== '0' && m ? m : s,
                    requestId
                });

                // Send the inspect request to the worker
                worker.worker.postMessage({
                    type: 'inspectItem',
                    s, a, d, m,
                    requestId
                });
            });
        } catch (error) {
            this.logger.error(`Error inspecting item: ${error.message}`);
            throw error;
        }
    }

    public getStats() {
        // Aggregate stats from all workers
        const readyBots = this.workers.reduce((sum, w) => sum + w.stats.readyBots, 0);
        const busyBots = this.workers.reduce((sum, w) => sum + w.stats.busyBots, 0);
        const cooldownBots = this.workers.reduce((sum, w) => sum + w.stats.cooldownBots, 0);
        const errorBots = this.workers.reduce((sum, w) => sum + w.stats.errorBots, 0);
        const disconnectedBots = this.workers.reduce((sum, w) => sum + w.stats.disconnectedBots, 0);
        const totalBots = this.workers.reduce((sum, w) => sum + w.stats.totalBots, 0);

        // Compile detailed stats about each worker
        const workerDetails = this.workers.map(worker => ({
            id: worker.id,
            status: worker.status,
            bots: worker.stats.totalBots,
            ready: worker.stats.readyBots,
            busy: worker.stats.busyBots,
            cooldown: worker.stats.cooldownBots,
            error: worker.stats.errorBots,
            disconnected: worker.stats.disconnectedBots
        }));

        // Flatten all bot details from all workers
        const botDetails = this.workers.flatMap(w => w.stats.botDetails || []);

        return {
            readyBots,
            busyBots,
            cooldownBots,
            errorBots,
            disconnectedBots,
            totalBots,
            workers: this.workers.length,
            workerDetails,
            botDetails
        };
    }
} 