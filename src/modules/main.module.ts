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
    private readonly logger = new Logger(MainModule.name)
    constructor(@InjectDataSource() private dataSource: DataSource) { }

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
