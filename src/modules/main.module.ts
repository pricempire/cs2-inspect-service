import { Module } from '@nestjs/common'
import { TypeOrmModule } from '@nestjs/typeorm'
import { InspectModule } from './inspect/inspect.module'
import 'dotenv/config'
import { ScheduleModule } from '@nestjs/schedule'

@Module({
    imports: [
        TypeOrmModule.forRoot({
            type: 'postgres',
            host: process.env.POSTGRESQL_HOST,
            port: parseInt(process.env.POSTGRESQL_PORT, 10),
            username: process.env.POSTGRESQL_USER,
            password: process.env.POSTGRESQL_PASSWORD,
            database: process.env.POSTGRESQL_DB,
            // cache: {
            //     type: 'redis',
            //     options: {
            //         host: process.env.REDIS_HOST,
            //         port: process.env.REDIS_PORT,
            //         password: process.env.REDIS_PASSWORD,
            //     },
            //     duration: 5 * 60 * 1000,
            // },
            entities: [__dirname + '/../**/*.{entity}.{js,ts}'],
            logging: process.env.POSTGRESQL_LOGGING === 'true',
            autoLoadEntities: true,
            synchronize: true,
        }),
        InspectModule,
        ScheduleModule.forRoot(),
    ],
})
export class MainModule {}
