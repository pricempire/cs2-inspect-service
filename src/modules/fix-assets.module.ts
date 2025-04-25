import { Logger, Module, OnModuleInit } from '@nestjs/common'
import { InjectDataSource, TypeOrmModule } from '@nestjs/typeorm'
import { DataSource } from 'typeorm'
import { createHash } from 'crypto'
import 'dotenv/config'
import { promises as fs } from 'fs'
import { HistoryType } from 'src/entities/history.entity'

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
export class FixAssetModule implements OnModuleInit {
    private readonly logger = new Logger(FixAssetModule.name)
    private limit = 200000

    constructor(
        @InjectDataSource('source') private fromDataSource: DataSource,
        @InjectDataSource('to') private toDataSource: DataSource,
    ) { }

    async onModuleInit() {
        this.logger.debug('Fixing assets')

        setTimeout(async () => {
            await this.fix()
        }, 5000)
    }

    async fix() {
        const count = await this.toDataSource.query(
            'SELECT COUNT(asset_id) FROM "asset"'
        )

        this.logger.debug('Count of items in items: ' + count[0].count)

        const batchSize = this.limit;
        let lastId = 0;
        let hasMoreData = true;

        const processAsset = async (asset) => {
            const oldUniqueId = asset.unique_id;
            const newUniqueId = this.generateUniqueId({
                paintSeed: asset.paint_seed,
                paintIndex: asset.paint_index,
                paintWear: asset.paint_wear,
                defIndex: asset.def_index,
            });

            if (oldUniqueId !== newUniqueId) {
                this.logger.debug('Unique ID mismatch for asset ' + asset.asset_id + ' - ' + oldUniqueId + ' != ' + newUniqueId);

                const alreadyExists = await this.toDataSource.query(
                    `SELECT COUNT(unique_id) FROM "asset" WHERE unique_id = '${newUniqueId}'`
                );

                if (alreadyExists[0].count > 0) {
                    this.logger.debug('Unique ID already exists for asset ' + newUniqueId);
                    await this.toDataSource.query(
                        `DELETE FROM "asset" WHERE unique_id = '${oldUniqueId}'`
                    );
                    this.logger.debug('Deleted asset ' + oldUniqueId);
                } else {
                    await this.toDataSource.query(
                        `UPDATE "asset" SET unique_id = '${newUniqueId}' WHERE unique_id = '${oldUniqueId}'`
                    );
                }

                await this.toDataSource.query(
                    `UPDATE "history" SET unique_id = '${newUniqueId}' WHERE unique_id = '${oldUniqueId}'`
                );
            }

            return asset.asset_id;
        };

        while (hasMoreData) {
            // Fetch a batch of assets
            const assets = await this.toDataSource.query(
                `SELECT asset_id, unique_id, paint_seed, paint_index, paint_wear, def_index FROM "asset" 
                 WHERE asset_id > ${lastId} ORDER BY asset_id LIMIT ${batchSize}`
            );

            if (assets.length === 0) {
                hasMoreData = false;
                continue;
            }

            // Process all assets in the batch concurrently
            const promises = assets.map(asset => processAsset(asset));
            const results = await Promise.all(promises);

            // Get the highest asset_id processed
            lastId = Math.max(...results);
            this.logger.debug(`Processed batch up to asset_id ${lastId}`);
        }

        this.logger.debug('Fix completed successfully');
    }

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
    }): string {
        const values = [
            item.paintSeed || 0,
            item.paintIndex || 0,
            item.paintWear || 0,
            item.defIndex || 0,
        ];
        const stringToHash = values.join('-');
        return createHash('sha1').update(stringToHash).digest('hex').substring(0, 8);
    }
}
