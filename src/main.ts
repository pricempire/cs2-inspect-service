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
bootstrap()
