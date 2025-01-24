import { Logger, Module } from '@nestjs/common'
import { SnakeNamingStrategy } from 'typeorm-naming-strategies';
import { InjectDataSource, TypeOrmModule } from '@nestjs/typeorm'
import { InspectModule } from './inspect/inspect.module'
import { Cron, CronExpression, ScheduleModule } from '@nestjs/schedule'
import { DataSource } from 'typeorm'
import 'dotenv/config'

@Module({
    imports: [
        TypeOrmModule.forRoot({
            type: 'postgres',
            host: process.env.POSTGRESQL_HOST,
            port: parseInt(process.env.POSTGRESQL_PORT, 10),
            username: process.env.POSTGRESQL_USERNAME,
            password: process.env.POSTGRESQL_PASSWORD,
            database: process.env.POSTGRESQL_DB,
            entities: [__dirname + '/../**/*.{entity,view}.{js,ts}'],
            namingStrategy: new SnakeNamingStrategy(),
            logging: process.env.POSTGRESQL_LOGGING === 'true',
            autoLoadEntities: true,
            synchronize: true,
        }),
        InspectModule,
        ScheduleModule.forRoot(),
    ],
})
export class MainModule {
    constructor() {
        if (!process.env.POSTGRESQL_HOST) {
            throw new Error('POSTGRESQL_HOST is not defined')
        }
        if (!process.env.POSTGRESQL_PORT) {
            throw new Error('POSTGRESQL_PORT is not defined')
        }
        if (!process.env.POSTGRESQL_USERNAME) {
            throw new Error('POSTGRESQL_USERNAME is not defined')
        }
        if (!process.env.POSTGRESQL_PASSWORD) {
            throw new Error('POSTGRESQL_PASSWORD is not defined')
        }
        if (!process.env.POSTGRESQL_DB) {
            throw new Error('POSTGRESQL_DB is not defined')
        }
    }
    @InjectDataSource()
    private dataSource: DataSource

    private readonly logger = new Logger(MainModule.name)
    private isRunning = false;
    /**
     * Refresh the materialized view "rankings"
     */
    @Cron(CronExpression.EVERY_DAY_AT_MIDNIGHT)
    async handleCron() {
        if (this.isRunning) {
            this.logger.debug('Cron job is already running, skipping')
            return;
        }

        this.isRunning = true;
        this.logger.debug('Refreshing materialized view "rankings"')

        const date = new Date()
        await this.dataSource.query('REFRESH MATERIALIZED VIEW CONCURRENTLY "rankings"')
        const diff = new Date().getTime() - date.getTime()

        this.logger.debug(
            'Materialized view "rankings" refreshed in ' + diff / 1000 + 's',
        )

        this.isRunning = false;
    }
}
