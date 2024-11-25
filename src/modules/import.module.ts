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
    ) { }

    async onModuleInit() {
        this.logger.debug('Importing data from source to target')

        setTimeout(() => {
            this.import()
        }, 5000)
    }

    private convertStickers(oldStickers: Array<{ d?: number, i: number, s: number }>) {
        if (!oldStickers) return null;

        return oldStickers.map(sticker => ({
            slot: sticker.s,
            wear: sticker.d ? this.convertWearValue(sticker.d) : null,
            scale: null,
            pattern: null,
            tint_id: null,
            offset_x: null,
            offset_y: null,
            offset_z: null,
            rotation: null,
            sticker_id: sticker.i
        }));
    }

    private convertWearValue(wear: number): number {
        // Convert the wear value from integer to float
        const buf = Buffer.alloc(4);
        buf.writeInt32BE(wear, 0);
        return buf.readFloatBE(0);
    }

    private async import() {
        const count = await this.fromDataSource.query(
            'SELECT COUNT(floatid) FROM "items"'
        )

        this.logger.debug('Count of items in items: ' + count[0].count)

        let offset = 0
        const bulks = []
        let lastid = 0

        // Recover last id
        const lastIdQuery = await this.toDataSource.query(
            'SELECT asset_id FROM "asset" ORDER BY asset_id DESC LIMIT 1'
        )

        if (lastIdQuery.length > 0) {
            this.logger.debug('Last id: ' + lastIdQuery[0].asset_id)
            lastid = lastIdQuery[0].asset_id
        }

        while (offset < count[0].count) {
            const date = new Date()

            const items = await this.fromDataSource.query(
                `SELECT * FROM "items" WHERE floatid > ${lastid} ORDER BY floatid LIMIT ${this.limit}`
            )

            this.logger.debug(
                `Loaded ${items.length} items in ${new Date().getTime() - date.getTime()}ms`
            )

            const values = []

            for await (const item of items) {
                const buf = Buffer.alloc(4)
                buf.writeInt32BE(item.paintwear, 0)
                const float = buf.readFloatBE(0)

                const props = this.extractProperties(item.props)
                const date = new Date(item.updated)
                    .toISOString()
                    .replace('T', ' ')
                    .replace('Z', '')

                const convertedStickers = this.convertStickers(item.stickers)

                values.push(
                    `(${this.signedToUn(item.ms)}, ${item.floatid}, ${item.d ? "'" + this.signedToUn(item.d) + "'" : 'NULL'
                    }, ${item.paintseed}, ${float}, ${item.defindex}, ${item.paintindex
                    }, ${item.stattrak === '1' ? true : false}, ${item.souvenir === '1' ? true : false
                    }, ${convertedStickers
                        ? "'" + JSON.stringify(convertedStickers) + "'"
                        : 'NULL'
                    }, '${date}', ${props.rarity}, ${props.quality}, ${props.origin
                    }, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 0)`
                )
                lastid = item.floatid
            }

            if (values.length) {
                bulks.push(values)
            }

            if (bulks.length === 10) {
                await Promise.all(
                    bulks
                        .filter(Boolean)
                        .map((bulk) =>
                            this.toDataSource.query(
                                `INSERT INTO "asset" (ms, asset_id, d, paint_seed, paint_wear, def_index, paint_index, is_stattrak, is_souvenir, stickers, created_at, rarity, quality, origin, custom_name, quest_id, reason, music_index, ent_index, keychains, killeater_score_type, killeater_value, pet_index, inventory) VALUES ${bulk.join(',')} ON CONFLICT DO NOTHING`
                            )
                        )
                )

                bulks.length = 0
                this.logger.debug('Imported offset:' + offset)
            }

            offset += this.limit
        }

        // Rest of the code remains the same...
    }

    private async importHistory() {
        const count = await this.fromDataSource.query(
            'SELECT COUNT(id) FROM "history"'
        )

        this.logger.debug('Count of items in history: ' + count[0].count)

        let offset = 0
        const bulks = []
        let lastid = 0

        // Recover last id
        const lastIdQuery = await this.toDataSource.query(
            'SELECT id FROM "history" ORDER BY id DESC LIMIT 1'
        )

        if (lastIdQuery.length > 0) {
            this.logger.debug('Last id: ' + lastIdQuery[0].id)
            lastid = lastIdQuery[0].id
        }

        while (offset < count[0].count) {
            const date = new Date()

            const items = await this.fromDataSource.query(
                `SELECT * FROM "history" WHERE id > ${lastid} ORDER BY id LIMIT ${this.limit}`
            )

            this.logger.debug(
                `Loaded ${items.length} items in ${new Date().getTime() - date.getTime()}ms`
            )

            const values = []

            for await (const item of items) {
                const date = new Date(item.created_at)
                    .toISOString()
                    .replace('T', ' ')
                    .replace('Z', '')

                // Convert old stickers format to new format if they exist
                const stickers = item.stickers ? this.convertStickers(item.stickers) : null
                const newStickers = item.stickers_new ? this.convertStickers(item.stickers_new) : null

                values.push(
                    `(${item.id}, ${item.floatid}, ${item.a}, ${item.type || 'NULL'
                    }, ${item.steamid}, ${item.current_steamid ? item.current_steamid : 'NULL'
                    }, ${item.d ? "'" + this.signedToUn(item.d) + "'" : 'NULL'
                    }, ${stickers ? "'" + JSON.stringify(stickers) + "'" : 'NULL'
                    }, ${newStickers ? "'" + JSON.stringify(newStickers) + "'" : 'NULL'
                    }, NULL, NULL, '${date}')`
                )
                lastid = item.id
            }

            if (values.length) {
                bulks.push(values)
            }

            if (bulks.length === 10) {
                await Promise.all(
                    bulks
                        .filter(Boolean)
                        .map((bulk) =>
                            this.toDataSource.query(
                                `INSERT INTO "history" (id, "assetId", "prevAssetId", type, owner, "prevOwner", d, stickers, "prevStickers", keychains, "prevKeychains", "createdAt") VALUES ${bulk.join(',')} ON CONFLICT DO NOTHING`
                            )
                        )
                )

                bulks.length = 0
                this.logger.debug('Imported history offset:' + offset)
            }

            offset += this.limit
        }
    }

    private signedToUn(num) {
        if (num === null) {
            return 'NULL'
        }
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
