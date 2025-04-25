import { NestFactory } from '@nestjs/core'
import 'dotenv/config'
import { FixAssetModule } from './modules/fix-assets.module'

async function bootstrap() {
    // check if source database env variables are set

    if (
        !process.env.POSTGRESQL_HOST_SOURCE ||
        !process.env.POSTGRESQL_PORT_SOURCE ||
        !process.env.POSTGRESQL_USER_SOURCE ||
        !process.env.POSTGRESQL_PASSWORD_SOURCE ||
        !process.env.POSTGRESQL_DB_SOURCE
    ) {
        throw new Error(
            'Source database env variables are not set correctly',
        )
    }

    const app = await NestFactory.createMicroservice(FixAssetModule)
    await app.listen()
}
bootstrap()
