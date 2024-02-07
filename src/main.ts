import { NestFactory } from '@nestjs/core'
import { MainModule } from './modules/main.module'

async function bootstrap() {
    const app = await NestFactory.create(MainModule)
    await app.listen(4100)
}
bootstrap()
