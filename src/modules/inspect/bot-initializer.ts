import { Bot } from './bot.class';

process.on('message', async (message: { username: string; password: string; proxyUrl: string }) => {
    try {
        // Create temporary bot instance for initialization
        const tempBot = new Bot(
            message.username,
            message.password,
            message.proxyUrl,
            () => { } // Empty callback since this is just for initialization
        );

        // Perform initialization
        const initData = await tempBot.initialize();

        // Send success message back to parent process
        process.send({
            type: 'init_success',
            data: initData // This should include cookies, session data, etc.
        });

        // Clean up
        await tempBot.destroy();
        process.exit(0);

    } catch (error) {
        // Send error message back to parent process
        process.send({
            type: 'init_error',
            error: error.message
        });
        process.exit(1);
    }
}); 