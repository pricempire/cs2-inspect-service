import { NestFactory } from '@nestjs/core'
import { MainModule } from './modules/main.module'
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify'
import 'dotenv/config'
import { ValidationPipe } from '@nestjs/common';

async function bootstrap() {
    const app = await NestFactory.create<NestFastifyApplication>(
        MainModule,
        new FastifyAdapter()
    )
    app.useGlobalPipes(new ValidationPipe({ transform: true }));
    await app.listen(3000, '0.0.0.0')
}

process.on('uncaughtException', err => {
    // console.log(`Uncaught Exception: ${err.message}`)
    // process.exit(1)
})
process.on('unhandledRejection', (reason, promise) => {
    // console.log('Unhandled rejection at ', promise, `reason: ${reason.message}`)
    // process.exit(1)
})

bootstrap()