import { Logger, Module, OnModuleInit } from '@nestjs/common'
import { InjectDataSource, TypeOrmModule } from '@nestjs/typeorm'
import { DataSource } from 'typeorm'
import 'dotenv/config'

@Module({
    imports: [
        TypeOrmModule.forRoot({
            type: 'postgres',
            name: 'source',
            host: process.env.POSTGRESQL_HOST_SOURCE,
            port: parseInt(process.env.POSTGRESQL_PORT_SOURCE, 10),
            username: process.env.POSTGRESQL_USER_SOURCE,
            password: process.env.POSTGRESQL_PASSWORD_SOURCE,
            database: process.env.POSTGRESQL_DB_SOURCE,
        }),
        TypeOrmModule.forRoot({
            type: 'postgres',
            name: 'to',
            host: process.env.POSTGRESQL_HOST,
            port: parseInt(process.env.POSTGRESQL_PORT, 10),
            username: process.env.POSTGRESQL_USER,
            password: process.env.POSTGRESQL_PASSWORD,
            database: process.env.POSTGRESQL_DB,
        }),
    ],
})
export class ImportModule implements OnModuleInit {
    private readonly logger = new Logger(ImportModule.name)
    private limit = 1000

    constructor(
        @InjectDataSource('source') private fromDataSource: DataSource,
        @InjectDataSource('to') private toDataSource: DataSource,
    ) {}

    async onModuleInit() {
        this.logger.debug('Importing data from source to target')
        await this.import()
    }
    private async import() {
        // Import data from source to target

        const count = await this.fromDataSource.query(
            'SELECT COUNT(id) FROM "items"',
        )

        this.logger.debug('Count of items in items: ' + count[0].count)

        let offset = 0
        while (offset < count[0].count) {
            const items = await this.fromDataSource.query(
                `SELECT * FROM "items" ORDER BY id LIMIT ${this.limit} OFFSET ${offset}`,
            )

            for await (const item of items) {
                await this.toDataSource.query(
                    `INSERT INTO "asset" (ms, "assetId", d, "paintSeed", "paintWear", "defIndex", "paintIndex", "isStattrak", "isSouvenir", stickers, "createdAt", rarity) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
                    [
                        item.ms,
                        item.a,
                        item.d,
                        item.paintseed,
                        item.paintwear,
                        item.defindex,
                        item.paintindex,
                        item.stattrak,
                        item.souvenir,
                        item.props,
                        item.stickers,
                        item.updated,
                        item.rarity,
                    ],
                )
            }
            offset += this.limit

            this.logger.debug('Imported ' + offset + ' items')
        }

        const countHistory = await this.fromDataSource.query(
            'SELECT COUNT(id) FROM "history"',
        )

        this.logger.debug('Count of items in history: ' + countHistory[0].count)

        offset = 0

        while (offset < countHistory[0].count) {
            const items = await this.fromDataSource.query(
                `SELECT * FROM "history" ORDER BY id LIMIT ${this.limit} OFFSET ${offset}`,
            )

            for await (const item of items) {
                await this.toDataSource.query(
                    `INSERT INTO "history" ("assetId", "prevOwner", "createdAt", "owner", "prevStickers", type, d, stickers) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
                    [
                        item.a,
                        item.steamid,
                        item.created_at,
                        item.current_steamid,
                        item.stickers,
                        item.type,
                        item.d,
                        item.stickers_new,
                    ],
                )
            }
            offset += this.limit

            this.logger.debug('Imported History ' + offset + ' items')
        }
    }
}
