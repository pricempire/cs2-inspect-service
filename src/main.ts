import { NestFactory } from '@nestjs/core'
import { MainModule } from './modules/main.module'
import 'dotenv/config'

async function bootstrap() {
    const app = await NestFactory.create(MainModule)
    await app.listen(process.env.PORT || 3000)
}
bootstrap()
