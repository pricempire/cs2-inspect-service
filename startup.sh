#!/bin/bash

# Enable worker mode
export WORKER_ENABLED=true

# Set debugging mode (uncomment to enable)
# export DEBUG=true
# export BOT_DEBUG=true

# Set worker configuration
export BOTS_PER_WORKER=50
export MAX_CONCURRENT_INIT=10
export WORKER_TIMEOUT=60000

# Specify accounts file location
export ACCOUNTS_FILE=${ACCOUNTS_FILE:-"accounts.txt"}
export SESSION_PATH=${SESSION_PATH:-"./sessions"}

# Set Node.js options for worker threads
export NODE_OPTIONS="--max-old-space-size=8096 --experimental-worker"
export UV_THREADPOOL_SIZE=64

echo "Starting CS2 Inspect Service with worker threads..."
echo "Worker configuration: ${BOTS_PER_WORKER} bots per worker"
echo "Accounts file: ${ACCOUNTS_FILE}"

# Start the service
node dist/main.js 