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
    private limit = 200000

    constructor(
        @InjectDataSource('source') private fromDataSource: DataSource,
        @InjectDataSource('to') private toDataSource: DataSource,
    ) {}

    async onModuleInit() {
        this.logger.debug('Importing data from source to target')

        setTimeout(() => {
            this.import()
        }, 5000)
    }

    private async import() {
        const count = await this.fromDataSource.query(
            'SELECT COUNT(floatid) FROM "items"',
        )

        this.logger.debug('Count of items in items: ' + count[0].count)

        let offset = 46200000

        const bulks = []

        while (offset < count[0].count) {
            const date = new Date()
            const items = await this.fromDataSource.query(
                `SELECT * FROM "items" ORDER BY floatid LIMIT ${this.limit} OFFSET ${offset}`,
            )

            this.logger.debug(
                `Loaded ${items.length} items in ${new Date().getTime() - date.getTime()}ms`,
            )

            this.logger.debug('Importing ' + offset + ' items')

            if (items.length === 0) {
                break
            }

            const values = []

            for await (const item of items) {
                const buf = Buffer.alloc(4)
                buf.writeInt32BE(item.paintwear, 0)
                const float = buf.readFloatBE(0)

                const a = this.signedToUn(item.a)

                const date = new Date(item.updated)
                    .toISOString()
                    .replace('T', ' ')
                    .replace('Z', '')

                values.push(
                    `(${this.signedToUn(item.ms)}, ${a}, '${this.signedToUn(item.d)}', ${item.paintseed}, ${float}, ${item.defindex}, ${item.paintindex}, ${
                        item.stattrak === '1' ? true : false
                    }, ${item.souvenir === '1' ? true : false}, '${
                        item.stickers ? JSON.stringify(item.stickers) : null
                    }', '${date}', '${item.rarity}')`,
                )
            }

            bulks.push(values)

            offset += this.limit

            if (bulks.length === 10) {
                await Promise.all(
                    bulks.map((bulk) => {
                        this.toDataSource.query(
                            `INSERT INTO "asset" (ms, "assetId", d, "paintSeed", "paintWear", "defIndex", "paintIndex", "isStattrak", "isSouvenir", stickers, "createdAt", rarity) VALUES ${bulk.join(',')} ON CONFLICT DO NOTHING`,
                        )
                    }),
                )

                bulks.length = 0

                this.logger.debug('Imported ' + offset + ' items')
            }
        }

        await Promise.all(
            bulks.map(async (bulk) => {
                this.toDataSource.query(
                    `INSERT INTO "asset" (ms, "assetId", d, "paintSeed", "paintWear", "defIndex", "paintIndex", "isStattrak", "isSouvenir", stickers, "createdAt", rarity) VALUES ${bulk.join(',')} ON CONFLICT DO NOTHING`,
                )
            }),
        )

        const countHistory = await this.fromDataSource.query(
            'SELECT COUNT(id) FROM "history"',
        )

        this.logger.debug('Count of items in history: ' + countHistory[0].count)

        offset = 0

        while (offset < countHistory[0].count) {
            const items = await this.fromDataSource.query(
                `SELECT * FROM "history" ORDER BY id LIMIT ${this.limit} OFFSET ${offset}`,
            )

            const values = []
            for (const item of items) {
                values.push(
                    `(${this.signedToUn(item.a)}, '${this.signedToUn(item.steamid)}', '${item.created_at}', '${this.signedToUn(item.current_steamid)}', '${item.stickers ? JSON.stringify(item.stickers) : null}', '${item.type}', '${this.signedToUn(item.d)}', '${item.stickers_new ? JSON.stringify(item.stickers_new) : null}')`,
                )
            }

            await this.toDataSource.query(
                `INSERT INTO "history" ("assetId", "prevOwner", "createdAt", "owner", "prevStickers", type, d, stickers) VALUES ${values.join(',')} ON CONFLICT DO NOTHING`,
            )

            offset += this.limit

            this.logger.debug('Imported History ' + offset + ' items')
        }
    }
    private signedToUn(num) {
        const mask = 1n << 63n
        return (BigInt(num) + mask) ^ mask
    }
}
