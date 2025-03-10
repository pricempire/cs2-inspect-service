import { Worker } from 'worker_threads';
import * as path from 'path';

/**
 * Helper function to spawn TypeScript worker threads correctly
 */
export function spawnWorker(
    workerPath: string,
    workerData: any,
    options: any = {}
): Worker {
    // Ensure the worker path is relative to the current file
    const resolvedPath = path.resolve(__dirname, workerPath);

    // Create the worker with the provided data and options
    return new Worker(resolvedPath, {
        workerData,
        ...options
    });
} 