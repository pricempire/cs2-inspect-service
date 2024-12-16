// docker-scripts/cs2-inspect-service/src/modules/queue/queue.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter } from 'events';

export interface InspectRequest {
    ms: string;
    d: string;
    resolve: (value: any) => void;
    reject: (reason?: any) => void;
    startTime: number;
    retryCount: number;
    inspectUrl: { s: string; a: string; d: string; m: string };
    timeoutId: NodeJS.Timeout;
}

@Injectable()
export class QueueService extends EventEmitter {
    private readonly logger = new Logger(QueueService.name);
    private queue: Map<string, InspectRequest> = new Map();
    private readonly maxSize: number;
    private readonly timeout: number;

    constructor() {
        super();
        this.maxSize = parseInt(process.env.MAX_QUEUE_SIZE || '100');
        this.timeout = parseInt(process.env.QUEUE_TIMEOUT || '5000');
    }

    public add(assetId: string, request: Omit<InspectRequest, 'startTime'>): void {
        if (this.isFull()) {
            throw new Error('Queue is full');
        }

        const fullRequest = {
            ...request,
            startTime: Date.now()
        };

        this.queue.set(assetId, fullRequest);
        this.emit('itemAdded', { assetId, request: fullRequest });
    }

    public get(assetId: string): InspectRequest | undefined {
        return this.queue.get(assetId);
    }

    public remove(assetId: string): void {
        const request = this.queue.get(assetId);
        if (request?.timeoutId) {
            clearTimeout(request.timeoutId);
        }
        this.queue.delete(assetId);
        this.emit('itemRemoved', assetId);
    }

    public isFull(): boolean {
        return this.queue.size >= this.maxSize;
    }

    public size(): number {
        return this.queue.size;
    }

    public clear(): void {
        for (const [_, request] of this.queue) {
            if (request.timeoutId) {
                clearTimeout(request.timeoutId);
            }
        }
        this.queue.clear();
        this.emit('queueCleared');
    }

    public getStaleRequests(): [string, InspectRequest][] {
        const now = Date.now();
        return Array.from(this.queue.entries())
            .filter(([_, request]) => now - request.startTime > this.timeout);
    }

    public getQueueMetrics() {
        const now = Date.now();
        return {
            size: this.queue.size,
            maxSize: this.maxSize,
            utilization: (this.queue.size / this.maxSize) * 100,
            items: Array.from(this.queue.entries()).map(([assetId, request]) => ({
                assetId,
                elapsedTime: now - request.startTime,
                retryCount: request.retryCount
            })),
            averageWaitTime: this.calculateAverageWaitTime()
        };
    }

    private calculateAverageWaitTime(): number {
        const now = Date.now();
        const waitTimes = Array.from(this.queue.values())
            .map(request => now - request.startTime);

        return waitTimes.length > 0
            ? waitTimes.reduce((a, b) => a + b, 0) / waitTimes.length
            : 0;
    }
}