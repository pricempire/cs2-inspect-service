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
import { BotStatus } from '../bot.class';

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
    private readonly BOTS_PER_WORKER = parseInt(process.env.BOTS_PER_WORKER || '50');

    private workers: WorkerInfo[] = [];
    private nextWorkerId = 0;

    private inspectRequests: Map<string, InspectRequest> = new Map();

    private success = 0;
    private failed = 0;
    private cached = 0;
    private timeouts = 0;

    private retriedInspections = 0;
    private successAfterRetry = 0;

    // Track response times for statistics
    private responseTimesHistory: Array<{
        timestamp: number;
        duration: number;
        assetId: string;
        success: boolean;
    }> = [];

    // Keep track of the last 5 minutes of inspections
    private readonly STATS_HISTORY_PERIOD = 5 * 60 * 1000; // 5 minutes in ms

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

        // Set up periodic cleanup of stale inspect requests
        this.setupPeriodicCleanup();
    }

    private setupPeriodicCleanup() {
        const CLEANUP_INTERVAL = 30000; // 30 seconds
        const MAX_REQUEST_AGE = 60000;  // 1 minute

        setInterval(() => {
            this.cleanupStaleRequests(MAX_REQUEST_AGE);
        }, CLEANUP_INTERVAL);
    }

    private cleanupStaleRequests(maxAge: number) {
        const now = Date.now();
        let cleanedCount = 0;

        for (const [assetId, request] of this.inspectRequests.entries()) {
            if (request.startTime && (now - request.startTime) > maxAge) {
                // This request has been pending for too long
                try {
                    clearTimeout(request.timeoutId);
                    request.reject(new Error('Request timed out during processing'));
                } catch (e) {
                    this.logger.error(`Error rejecting stale request: ${e.message}`);
                }

                this.inspectRequests.delete(assetId);
                this.timeouts++;
                cleanedCount++;
            }
        }

        if (cleanedCount > 0) {
            this.logger.warn(`Cleaned up ${cleanedCount} stale inspect requests`);
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
                case 'botStatusChange':
                    this.handleBotStatusChange(message);
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

    private handleBotStatusChange(message: any): void {
        const { workerId, username, status, assetId } = message;

        // Request updated stats immediately to ensure accurate status tracking
        const workerInfo = this.workers.find(w => w.id === workerId);
        if (workerInfo) {
            try {
                // Request stats update immediately to reflect the most recent status changes
                workerInfo.worker.postMessage({ type: 'getStats' });

                // Update the stats for this worker directly to improve responsiveness
                if (status === 'busy') {
                    // Increment busy count, decrement ready count
                    if (workerInfo.stats.readyBots > 0) workerInfo.stats.readyBots--;
                    workerInfo.stats.busyBots++;
                } else if (status === 'ready') {
                    // Increment ready count, decrement busy count
                    workerInfo.stats.readyBots++;
                    workerInfo.stats.busyBots--;
                } else if (status === 'cooldown') {
                    // Handle cooldown status
                    workerInfo.stats.cooldownBots++;
                    if (workerInfo.stats.busyBots > 0) workerInfo.stats.busyBots--;
                } else if (status === 'error') {
                    // Handle error status
                    workerInfo.stats.errorBots++;
                    if (workerInfo.stats.busyBots > 0) workerInfo.stats.busyBots--;
                } else if (status === 'disconnected') {
                    // Handle disconnected status
                    workerInfo.stats.disconnectedBots++;
                    if (workerInfo.stats.busyBots > 0) workerInfo.stats.busyBots--;
                }

                // Log for debugging
                const actionType = status === 'busy' ? 'started' : 'completed';
                this.logger.debug(`Bot ${username} in worker ${workerId} ${actionType} inspection for asset ${assetId}`);
                this.logger.debug(`Updated worker stats: ready=${workerInfo.stats.readyBots}, busy=${workerInfo.stats.busyBots}, cooldown=${workerInfo.stats.cooldownBots}, error=${workerInfo.stats.errorBots}, disconnected=${workerInfo.stats.disconnectedBots}`);
            } catch (error) {
                this.logger.error(`Error updating stats after bot status change: ${error.message}`);
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
            this.trackInspectionSuccess(assetId, Date.now() - request.startTime!);
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
        this.trackInspectionFailure(assetId, Date.now() - request.startTime);
        request.reject(new Error(error));
        this.inspectRequests.delete(assetId);
    }

    private updateWorkerStats(workerId: number, stats: any): void {
        const workerInfo = this.workers.find(w => w.id === workerId);
        if (workerInfo) {
            // Store previous stats for comparison
            const prevStats = { ...workerInfo.stats };

            // Update stats
            workerInfo.stats = stats;

            // Log significant changes in bot counts
            if (prevStats.readyBots !== stats.readyBots ||
                prevStats.busyBots !== stats.busyBots ||
                prevStats.errorBots !== stats.errorBots ||
                prevStats.cooldownBots !== stats.cooldownBots ||
                prevStats.disconnectedBots !== stats.disconnectedBots) {

                this.logger.debug(`Worker ${workerId} stats changed: ready=${prevStats.readyBots}->${stats.readyBots}, ` +
                    `busy=${prevStats.busyBots}->${stats.busyBots}, ` +
                    `error=${prevStats.errorBots}->${stats.errorBots}, ` +
                    `cooldown=${prevStats.cooldownBots}->${stats.cooldownBots}, ` +
                    `disconnected=${prevStats.disconnectedBots}->${stats.disconnectedBots}`);
            }

            // Update worker status based on available bots
            if (stats.readyBots > 0 && workerInfo.status !== 'ready') {
                this.updateWorkerStatus(workerId, 'ready');
                this.logger.debug(`Worker ${workerId} marked ready with ${stats.readyBots} ready bots`);
            } else if (stats.readyBots === 0 && stats.totalBots > 0 && workerInfo.status === 'ready') {
                // Still mark as ready but log a warning
                this.logger.warn(`Worker ${workerId} has no ready bots but status is ready`);
            }

            // Update the bots map with the latest status information from the worker
            if (stats.botDetails && Array.isArray(stats.botDetails)) {
                for (const botDetail of stats.botDetails) {
                    const bot = this.bots.get(botDetail.username);
                    if (bot) {
                        // We can't update the bot status directly, but we can track it in our map
                        // This helps ensure our getStats() method returns accurate information
                        this.logger.debug(`Bot ${botDetail.username} status from worker: ${botDetail.status}`);
                    }
                }
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
        // Calculate bot counts from worker stats for more accurate reporting
        let readyBots = 0;
        let totalBots = 0;

        // Aggregate stats from all workers
        for (const worker of this.workers) {
            readyBots += worker.stats.readyBots || 0;
            totalBots += worker.stats.totalBots || 0;
        }

        return totalBots > 0 ? (readyBots / totalBots) * 100 : 0;
    }

    private getTotalBots(): number {
        let totalBots = 0;
        for (const worker of this.workers) {
            totalBots += worker.stats.totalBots || 0;
        }
        return totalBots;
    }

    private getReadyBots(): number {
        let readyBots = 0;
        for (const worker of this.workers) {
            readyBots += worker.stats.readyBots || 0;
        }
        return readyBots;
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
            // Create a unique request ID
            const requestId = `${Date.now()}-${Math.random().toString(36).substring(2, 15)}`;

            // Set initial retry count
            const retryCount = 0;

            // Start the inspection with retry tracking
            return this.executeInspection(s, a, d, m, requestId, retryCount);
        } catch (error) {
            this.logger.error(`Error inspecting item: ${error.message}`);
            throw error;
        }
    }

    private async executeInspection(s: string, a: string, d: string, m: string, requestId: string, retryCount: number): Promise<any> {
        const MAX_RETRIES = parseInt(process.env.MAX_INSPECT_RETRIES || '3');

        try {
            const worker = await this.getAvailableWorker();
            if (!worker) {
                throw new Error('No workers with available bots');
            }

            // Use a promise to wait for the inspect result
            return new Promise<any>((resolve, reject) => {
                // Create timeout to handle inspection timeouts
                const timeoutId = setTimeout(() => {
                    // Handle timeout with retry logic
                    this.handleInspectionTimeout(s, a, d, m, requestId, retryCount, MAX_RETRIES, resolve, reject);
                }, 10000);

                // Store the promise handlers and inspection data
                this.inspectRequests.set(a, {
                    resolve,
                    reject,
                    timeoutId,
                    startTime: Date.now(),
                    retryCount,
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
            this.logger.error(`Error during inspection attempt ${retryCount + 1}: ${error.message}`);

            // If we still have retries left and this is a timeout/availability error, try again
            if (retryCount < MAX_RETRIES &&
                (error.message.includes('timed out') || error.message.includes('No workers with available bots'))) {
                this.logger.warn(`Retrying inspection for asset ${a} (attempt ${retryCount + 1}/${MAX_RETRIES})`);

                // Wait a moment before retrying
                await new Promise(resolve => setTimeout(resolve, 1000));

                // Retry with incremented retry count
                return this.executeInspection(s, a, d, m, requestId, retryCount + 1);
            }

            // Otherwise, give up
            throw error;
        }
    }

    private handleInspectionTimeout(
        s: string, a: string, d: string, m: string,
        requestId: string, retryCount: number, maxRetries: number,
        resolve: (value: any) => void,
        reject: (reason?: any) => void
    ): void {
        const assetId = a;
        const request = this.inspectRequests.get(assetId);

        if (!request) {
            this.logger.warn(`Cannot handle timeout for request ${requestId} - request not found`);
            return;
        }

        // Calculate duration if we have a start time
        const duration = request.startTime ? Date.now() - request.startTime : undefined;

        if (retryCount < maxRetries) {
            // We still have retries left
            this.incrementRetriedInspections();
            this.logger.warn(`Inspection timeout for asset ${assetId} (attempt ${retryCount + 1}/${maxRetries + 1}). Retrying with a different bot...`);

            // Remove the current request from the map
            this.inspectRequests.delete(assetId);

            // Try again with a different bot
            this.executeInspection(s, a, d, m, requestId, retryCount + 1)
                .then(result => {
                    this.incrementSuccessAfterRetry();
                    resolve(result);
                })
                .catch(error => {
                    reject(error);
                });
        } else {
            // No more retries left, report as timeout
            this.timeouts++;
            this.logger.error(`All retry attempts exhausted for asset ${assetId}. Reporting as timeout.`);

            // Track the timeout in our metrics
            if (duration) {
                this.trackInspectionTime(assetId, duration, false);
            }

            this.inspectRequests.delete(assetId);
            reject(new Error(`Inspection timed out after ${maxRetries + 1} attempts`));
        }
    }

    public getStats() {
        // Calculate bot counts from worker stats for more accurate reporting
        let readyBots = 0;
        let busyBots = 0;
        let errorBots = 0;
        let cooldownBots = 0;
        let disconnectedBots = 0;
        let totalBots = 0;

        // Aggregate stats from all workers
        for (const worker of this.workers) {
            readyBots += worker.stats.readyBots || 0;
            busyBots += worker.stats.busyBots || 0;
            errorBots += worker.stats.errorBots || 0;
            cooldownBots += worker.stats.cooldownBots || 0;
            disconnectedBots += worker.stats.disconnectedBots || 0;
            totalBots += worker.stats.totalBots || 0;
        }

        // Active inspections
        const activeInspections = this.inspectRequests.size;
        const activeInspectionDetails = Array.from(this.inspectRequests.entries()).map(([assetId, request]) => {
            const elapsedTime = request.startTime ? Date.now() - request.startTime : 0;
            return {
                assetId,
                elapsedTimeMs: elapsedTime,
                startedAt: request.startTime,
                formattedTime: `${Math.floor(elapsedTime / 1000)}s ${elapsedTime % 1000}ms`,
                retry: request.retryCount || 0
            };
        });

        // Calculate bot availability
        const botAvailabilityPercentage = totalBots > 0 ? (readyBots / totalBots) * 100 : 0;

        // Collect bot details from all workers
        const botDetails = [];
        for (const worker of this.workers) {
            if (worker.stats.botDetails && Array.isArray(worker.stats.botDetails)) {
                botDetails.push(...worker.stats.botDetails);
            }
        }

        return {
            readyBots,
            busyBots,
            cooldownBots,
            errorBots,
            disconnectedBots,
            totalBots,
            activeInspections,
            botAvailabilityPercentage,
            metrics: {
                readyBots,
                busyBots,
                cooldownBots,
                errorBots,
                disconnectedBots,
                totalBots,
                botAvailabilityPercentage,
                activeInspections,
                activeInspectionDetails: activeInspectionDetails.slice(0, 10), // Limit to 10 for UI display
                retriedInspections: this.retriedInspections,
                successAfterRetry: this.successAfterRetry,
                responseTimeStats: this.getResponseTimeStats(),
                success: this.success,
                failed: this.failed,
                cached: this.cached,
                timeouts: this.timeouts,
                botDetails
            },
            responseTimeStats: this.getResponseTimeStats()
        };
    }

    private incrementRetriedInspections() {
        this.retriedInspections++;
    }

    private incrementSuccessAfterRetry() {
        this.successAfterRetry++;
    }

    public incrementCached() {
        this.cached++;
    }

    // Track a successful inspection with its response time
    private trackInspectionSuccess(assetId: string, duration: number) {
        this.success++;
        this.trackInspectionTime(assetId, duration, true);
    }

    // Track a failed inspection with its response time (if available)
    private trackInspectionFailure(assetId: string, duration?: number) {
        this.failed++;
        if (duration !== undefined) {
            this.trackInspectionTime(assetId, duration, false);
        }
    }

    // Record response time data with timestamp
    private trackInspectionTime(assetId: string, duration: number, success: boolean) {
        const now = Date.now();

        // Add new record
        this.responseTimesHistory.push({
            timestamp: now,
            duration,
            assetId,
            success
        });

        // Clean up old records (older than 5 minutes)
        const cutoffTime = now - this.STATS_HISTORY_PERIOD;
        this.responseTimesHistory = this.responseTimesHistory.filter(
            record => record.timestamp >= cutoffTime
        );
    }

    // Get response time statistics
    private getResponseTimeStats() {
        // Get current time for filtering recent data
        const now = Date.now();
        const recentCutoff = now - this.STATS_HISTORY_PERIOD;

        // Filter for successful inspections only
        const allSuccessful = this.responseTimesHistory.filter(r => r.success);
        const recentSuccessful = allSuccessful.filter(r => r.timestamp >= recentCutoff);

        // Calculate average response times
        const calculateAvg = (items: typeof allSuccessful) => {
            if (items.length === 0) return 0;
            return Math.round(items.reduce((sum, r) => sum + r.duration, 0) / items.length);
        };

        // Get percentiles
        const getPercentile = (items: typeof allSuccessful, percentile: number) => {
            if (items.length === 0) return 0;
            const sorted = [...items].sort((a, b) => a.duration - b.duration);
            const index = Math.floor(sorted.length * (percentile / 100));
            return sorted[index].duration;
        };

        // Prepare time-series data for recent inspections (for charting)
        const timeSeriesData = recentSuccessful
            .sort((a, b) => a.timestamp - b.timestamp)
            .map(record => ({
                timestamp: record.timestamp,
                duration: record.duration
            }));

        // Group time series data by minute for charting
        const minuteBuckets: Record<string, number[]> = {};
        recentSuccessful.forEach(record => {
            // Create minute buckets (floor to nearest minute)
            const minute = Math.floor(record.timestamp / 60000) * 60000;
            if (!minuteBuckets[minute]) {
                minuteBuckets[minute] = [];
            }
            minuteBuckets[minute].push(record.duration);
        });

        // Calculate average per minute
        const timeSeriesByMinute = Object.entries(minuteBuckets).map(([timestamp, durations]) => ({
            timestamp: parseInt(timestamp),
            avgDuration: Math.round(durations.reduce((sum, d) => sum + d, 0) / durations.length),
            count: durations.length
        })).sort((a, b) => a.timestamp - b.timestamp);

        return {
            allTime: {
                count: allSuccessful.length,
                avgResponseTime: calculateAvg(allSuccessful),
                p50: allSuccessful.length > 0 ? getPercentile(allSuccessful, 50) : 0,
                p90: allSuccessful.length > 0 ? getPercentile(allSuccessful, 90) : 0,
                p95: allSuccessful.length > 0 ? getPercentile(allSuccessful, 95) : 0,
            },
            recent: {
                count: recentSuccessful.length,
                avgResponseTime: calculateAvg(recentSuccessful),
                p50: recentSuccessful.length > 0 ? getPercentile(recentSuccessful, 50) : 0,
                p90: recentSuccessful.length > 0 ? getPercentile(recentSuccessful, 90) : 0,
                p95: recentSuccessful.length > 0 ? getPercentile(recentSuccessful, 95) : 0,
                timeSeriesData: timeSeriesByMinute
            }
        };
    }
} 