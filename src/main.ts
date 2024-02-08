import { NestFactory } from '@nestjs/core'
import { MainModule } from './modules/main.module'
import { ImportModule } from './modules/import.module'
import 'dotenv/config'

async function bootstrap() {
    if (process.env.IMPORT_DB === 'true') {
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

        const app = await NestFactory.createMicroservice(ImportModule)
        await app.listen()
    } else {
        const app = await NestFactory.create(MainModule)
        await app.listen(process.env.PORT || 3000)
    }
}
bootstrap()
