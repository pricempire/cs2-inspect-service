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

        let offset = 0

        const bulks = []

        let lastid = 0

        // Recover last id
        const lastIdQuery = await this.toDataSource.query(
            'SELECT id FROM "asset" ORDER BY id DESC LIMIT 1',
        )

        if (lastIdQuery.length > 0) {
            this.logger.debug('Last id: ' + lastIdQuery[0].id)
            lastid = lastIdQuery[0].id
        }

        while (offset < count[0].count) {
            const date = new Date()

            const items = await this.fromDataSource.query(
                `SELECT * FROM "items" WHERE floatid > ${lastid} ORDER BY floatid LIMIT ${this.limit}`, // LIMIT ${this.limit} OFFSET ${offset}`,
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

                const props = this.extractProperties(item.props)

                values.push(
                    `(${item.floatid}, ${this.signedToUn(item.ms)}, ${a}, '${this.signedToUn(item.d)}', ${item.paintseed}, ${float}, ${item.defindex}, ${item.paintindex}, ${
                        item.stattrak === '1' ? true : false
                    }, ${item.souvenir === '1' ? true : false}, ${
                        item.stickers
                            ? "'" + JSON.stringify(item.stickers) + "'"
                            : null
                    }, '${date}', '${props.rarity}', '${props.quality}', '${props.origin}')`,
                )
                lastid = item.floatid
            }

            bulks.push(values)

            offset += this.limit

            if (bulks.length === 10) {
                await Promise.all(
                    bulks.map((bulk) =>
                        this.toDataSource.query(
                            `INSERT INTO "asset" (id, ms, "assetId", d, "paintSeed", "paintWear", "defIndex", "paintIndex", "isStattrak", "isSouvenir", stickers, "createdAt", rarity, quality, origin) VALUES ${bulk.join(',')} ON CONFLICT DO NOTHING`,
                        ),
                    ),
                )

                bulks.length = 0

                this.logger.debug('Imported ' + offset + ' items')
            }
        }

        // Insert remaining items
        await Promise.all(
            bulks.map(async (bulk) => {
                this.toDataSource.query(
                    `INSERT INTO "asset" (ms, "assetId", d, "paintSeed", "paintWear", "defIndex", "paintIndex", "isStattrak", "isSouvenir", stickers, "createdAt", rarity, quality, origin) VALUES ${bulk.join(',')} ON CONFLICT DO NOTHING`,
                )
            }),
        )

        const countHistory = await this.fromDataSource.query(
            'SELECT COUNT(id) FROM "history"',
        )

        this.logger.debug('Count of items in history: ' + countHistory[0].count)

        const lastHistoryId = await this.toDataSource.query(
            'SELECT id FROM "history" ORDER BY id DESC LIMIT 1',
        )

        lastid = 0

        if (lastHistoryId.length > 0) {
            lastid = lastHistoryId[0].id
        }

        offset = 0

        bulks.length = 0

        while (offset < countHistory[0].count) {
            const items = await this.fromDataSource.query(
                `SELECT * FROM "history" WHERE id > ${lastid} ORDER BY id LIMIT ${this.limit}`,
            )

            const values = []
            for (const item of items) {
                const date = new Date(item.created_at)
                    .toISOString()
                    .replace('T', ' ')
                    .replace('Z', '')

                values.push(
                    `(${this.signedToUn(item.a)}, '${this.signedToUn(item.steamid)}', '${date}', '${this.signedToUn(item.current_steamid)}', ${item.stickers ? "'" + JSON.stringify(item.stickers) + "'" : null}, '${item.type}', '${this.signedToUn(item.d)}', ${item.stickers_new ? "'" + JSON.stringify(item.stickers_new) + "'" : null})`,
                )
            }

            bulks.push(values)

            if (bulks.length === 10) {
                await Promise.all(
                    bulks.map((bulk) =>
                        this.toDataSource.query(
                            `INSERT INTO "history" ("assetId", "prevOwner", "createdAt", "owner", "prevStickers", type, d, stickers) VALUES ${bulk.join(',')} ON CONFLICT DO NOTHING`,
                        ),
                    ),
                )

                bulks.length = 0
            }

            offset += this.limit

            this.logger.debug('Imported History ' + offset + ' items')
        }

        // Insert remaining history

        await Promise.all(
            bulks.map(async (bulk) => {
                this.toDataSource.query(
                    `INSERT INTO "history" ("assetId", "prevOwner", "createdAt", "owner", "prevStickers", type, d, stickers) VALUES ${bulk.join(',')} ON CONFLICT DO NOTHING`,
                )
            }),
        )

        this.logger.debug('Imported all items & history, enjoy your data')
    }
    private signedToUn(num) {
        const mask = 1n << 63n
        return (BigInt(num) + mask) ^ mask
    }

    private extractProperties(props: number) {
        return {
            origin: props & ((1 << 8) - 1),
            quality: (props >> 8) & ((1 << 8) - 1),
            rarity: (props >> 16) & ((1 << 8) - 1),
        }
    }
}
