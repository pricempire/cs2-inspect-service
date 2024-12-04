import { Logger, Module, OnModuleInit } from '@nestjs/common'
import { InjectDataSource, TypeOrmModule } from '@nestjs/typeorm'
import { DataSource } from 'typeorm'
import { createHash } from 'crypto'
import 'dotenv/config'
import { promises as fs } from 'fs'

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
            username: process.env.POSTGRESQL_USERNAME,
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

    private convertStickers(oldStickers: Array<{ d?: number, i: number, s: number, w: number }>) {
        if (!oldStickers) return null;

        return oldStickers.map(sticker => ({
            slot: sticker.s,
            wear: sticker.w ? sticker.w : null,
            // to save space
            /*
            scale: null,
            pattern: null,
            tint_id: null,
            offset_x: null,
            offset_y: null,
            offset_z: null,
            rotation: null,
            */
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

        let lastid = 0
        const concurrentBatches = 5 // Number of parallel batches

        // Try to load last id from file first
        try {
            if (process.env.LAST_ID_FILE) {
                const savedId = await fs.readFile(process.env.LAST_ID_FILE, 'utf8');
                if (savedId) {
                    lastid = parseInt(savedId, 10);
                    this.logger.debug('Loaded last id from file: ' + lastid);
                }
            }
        } catch {
            this.logger.debug('No last id file found, starting from 0')
        }

        // Process batches in parallel
        const processBatch = async (batchLastId: number) => {
            const date = new Date()
            const items = await this.fromDataSource.query(
                `SELECT * FROM "items" WHERE floatid > ${batchLastId} ORDER BY floatid LIMIT ${this.limit}`
            )

            if (items.length === 0) return null;

            this.logger.debug(
                `Loaded ${items.length} items in ${new Date().getTime() - date.getTime()}ms`
            )

            const values = []
            let maxId = batchLastId

            for (const item of items) {
                const float = this.convertWearValue(item.paintwear)
                const props = this.extractProperties(item.props)
                const date = new Date(item.updated)
                    .toISOString()
                    .replace('T', ' ')
                    .replace('Z', '')

                const convertedStickers = this.convertStickers(item.stickers)
                const uniqueId = this.generateUniqueId({
                    paintSeed: item.paintseed,
                    paintIndex: item.paintindex,
                    paintWear: float,
                    defIndex: item.defindex,
                    origin: props.origin,
                    rarity: item.rarity,
                    quality: props.quality,
                    dropReason: props.origin,
                });

                values.push(
                    `('${uniqueId}', ${this.signedToUn(item.ms)}, ${item.a}, ${item.d ? "'" + this.signedToUn(item.d) + "'" : 'NULL'
                    }, ${item.paintseed}, ${float}, ${item.defindex}, ${item.paintindex
                    }, ${item.stattrak === '1' ? true : false}, ${item.souvenir === '1' ? true : false
                    }, ${convertedStickers
                        ? "'" + JSON.stringify(convertedStickers) + "'"
                        : 'NULL'
                    }, '${date}', ${props.rarity}, ${props.quality}, ${props.origin
                    }, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 0)`
                )
                maxId = Math.max(maxId, item.floatid)
            }

            this.logger.log('Importing ' + values.length + ' items')

            if (values.length) {
                await this.toDataSource.query(
                    `INSERT INTO "asset" (unique_id, ms, asset_id, d, paint_seed, paint_wear, def_index, paint_index, is_stattrak, is_souvenir, stickers, created_at, rarity, quality, origin, custom_name, quest_id, reason, music_index, ent_index, keychains, killeater_score_type, killeater_value, pet_index, inventory) VALUES ${values.join(',')} ON CONFLICT DO NOTHING`
                )

                this.logger.log('Imported ' + values.length + ' items')
                return maxId
            }

            return null
        }

        while (true) {
            const batchPromises = Array(concurrentBatches).fill(null).map((_, index) => {
                const batchStartId = lastid + (index * this.limit);
                return processBatch(batchStartId);
            });
            const results = await Promise.all(batchPromises);

            const validResults = results.filter(id => id !== null);
            if (validResults.length === 0) break;

            lastid = Math.max(...validResults);

            // Save lastid to file
            if (process.env.LAST_ID_FILE) {
                await fs.writeFile(process.env.LAST_ID_FILE, lastid.toString());
            }

            this.logger.debug(`Processed up to ID: ${lastid}`);
        }
    }

    /*
    // not working yet
    private async importHistory() {
        const count = await this.fromDataSource.query(
            'SELECT COUNT(id) FROM "history"'
        )

        this.logger.debug('Count of items in history: ' + count[0].count)

        let offset = 0
        const bulks = []
        let lastid = 0

        // Try to load last id from file first
        try {
            if (process.env.LAST_ID_FILE) {
                const savedId = await fs.readFile(process.env.LAST_ID_FILE, 'utf8');
                lastid = parseInt(savedId, 10);
                this.logger.debug('Loaded last id from file: ' + lastid);
            }
        } catch (error) {
            // If file doesn't exist or has invalid content, fall back to database
            const lastIdQuery = await this.toDataSource.query(
                'SELECT id FROM "history" ORDER BY id DESC LIMIT 1'
            )

            if (lastIdQuery.length > 0) {
                this.logger.debug('Last id from DB: ' + lastIdQuery[0].id)
                lastid = lastIdQuery[0].id
            }
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

            // Save lastid to file
            if (process.env.LAST_ID_FILE) {
                await fs.writeFile(process.env.LAST_ID_FILE, lastid.toString());
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
                                `INSERT INTO "history" (unique_id, asset_id, prev_asset_id, type, owner, prev_owner, d, stickers, prev_stickers, keychains, prev_keychains, created_at) VALUES ${bulk.join(',')} ON CONFLICT DO NOTHING`
                            )
                        )
                )

                bulks.length = 0
                this.logger.debug('Imported history offset:' + offset)
            }

            offset += this.limit
        }
    }
    */

    /**
     * Generate a unique ID for an asset
     * @param item 
     * @returns 
     */
    private generateUniqueId(item: {
        paintSeed?: number,
        paintIndex?: number,
        paintWear?: number,
        defIndex?: number,
        origin?: number,
        rarity?: number,
        questId?: number,
        quality?: number,
        dropReason?: number
    }): string {
        const values = [
            item.paintSeed || 0,
            item.paintIndex || 0,
            item.paintWear || 0,
            item.defIndex || 0,
            item.origin || 0,
            item.rarity || 0,
            item.questId || 0,
            item.quality || 0,
            item.dropReason || 0
        ];
        const stringToHash = values.join('-');
        return createHash('sha1').update(stringToHash).digest('hex').substring(0, 8);
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
