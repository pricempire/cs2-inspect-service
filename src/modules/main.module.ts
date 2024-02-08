import { Logger, Module } from '@nestjs/common'
import { InjectDataSource, TypeOrmModule } from '@nestjs/typeorm'
import { InspectModule } from './inspect/inspect.module'
import { Cron, ScheduleModule } from '@nestjs/schedule'
import 'dotenv/config'
import { DataSource } from 'typeorm'

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
            entities: [__dirname + '/../**/*.{entity,view}.{js,ts}'],
            logging: process.env.POSTGRESQL_LOGGING === 'true',
            autoLoadEntities: true,
            synchronize: true,
        }),
        InspectModule,
        ScheduleModule.forRoot(),
    ],
})
export class MainModule {
    private readonly logger = new Logger(MainModule.name)
    constructor(@InjectDataSource() private dataSource: DataSource) {}

    // This method is called every hour to refresh the materialized view
    @Cron('0 0 * * * *')
    async handleCron() {
        this.logger.debug('Refreshing materialized view "rankings"')

        const date = new Date()
        await this.dataSource.query('REFRESH MATERIALIZED VIEW "rankings"')
        const diff = new Date().getTime() - date.getTime()

        this.logger.debug(
            'Materialized view "rankings" refreshed in ' + diff / 1000 + 's',
        )
    }
}
