import { NestFactory } from '@nestjs/core'
import { MainModule } from './modules/main.module'
import 'dotenv/config'

async function bootstrap() {
    const app = await NestFactory.create(MainModule)
    await app.listen(3000)
}
bootstrap()
