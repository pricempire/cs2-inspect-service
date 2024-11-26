import { NestFactory } from '@nestjs/core'
import { MainModule } from './modules/main.module'
import 'dotenv/config'
import { ValidationPipe } from '@nestjs/common';

async function bootstrap() {
    const app = await NestFactory.create(MainModule)
    app.useGlobalPipes(new ValidationPipe({ transform: true }));
    await app.listen(3000)
}
bootstrap()
