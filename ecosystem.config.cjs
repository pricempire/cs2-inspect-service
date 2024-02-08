module.exports = {
    apps: [
        {
            name: 'cs2-inspect-server',
            exec_mode: 'fork',
            script: 'dist/main.js',
        },
    ],
}
