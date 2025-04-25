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
            username: process.env.POSTGRESQL_USERNAME,
            password: process.env.POSTGRESQL_PASSWORD,
            database: process.env.POSTGRESQL_DB,
        }),
    ],
})
export class FixAssetModule {
    private readonly logger = new Logger(FixAssetModule.name)
    private limit = 200000

    constructor(
        @InjectDataSource('source') private fromDataSource: DataSource,
        @InjectDataSource('to') private toDataSource: DataSource,
    ) { }

    /*
    async onModuleInit() {
        this.logger.debug('Fixing assets')

        setTimeout(async () => {
            await this.fix()
        }, 5000)
    }
    */

    async fix() {
        this.logger.debug('Starting asset fix process');

        try {
            // Enable pgcrypto extension for SHA1 hashing
            await this.toDataSource.query(`CREATE EXTENSION IF NOT EXISTS pgcrypto;`);

            // Create a temporary function in Postgres to generate the unique ID
            await this.toDataSource.query(`
                CREATE OR REPLACE FUNCTION generate_unique_id(paint_seed INTEGER, paint_index INTEGER, paint_wear FLOAT, def_index INTEGER)
                RETURNS VARCHAR AS $$
                DECLARE
                    hash VARCHAR;
                BEGIN
                    hash := encode(digest(CONCAT(
                        COALESCE(paint_seed, 0)::TEXT, '-',
                        COALESCE(paint_index, 0)::TEXT, '-',
                        COALESCE(paint_wear, 0)::TEXT, '-',
                        COALESCE(def_index, 0)::TEXT
                    ), 'sha1'), 'hex');
                    RETURN SUBSTRING(hash, 1, 8);
                END;
                $$ LANGUAGE plpgsql;
            `);

            // Count total assets to update
            const count = await this.toDataSource.query('SELECT COUNT(asset_id) FROM "asset"');
            this.logger.debug('Total assets to process: ' + count[0].count);

            // Execute all operations in a single SQL statement using CTEs
            const result = await this.toDataSource.query(`
                -- First CTE: Generate new unique IDs for all assets
                WITH assets_with_new_ids AS (
                    SELECT 
                        asset_id,
                        unique_id AS old_unique_id,
                        generate_unique_id(paint_seed, paint_index, paint_wear, def_index) AS new_unique_id
                    FROM "asset"
                ),
                
                -- Second CTE: Find assets where old_unique_id != new_unique_id
                changed_assets AS (
                    SELECT * FROM assets_with_new_ids 
                    WHERE old_unique_id != new_unique_id
                ),
                
                -- Third CTE: Find which assets need to be deleted (duplicates)
                assets_to_delete AS (
                    SELECT ca.old_unique_id
                    FROM changed_assets ca
                    WHERE EXISTS (
                        SELECT 1 FROM "asset" 
                        WHERE unique_id = ca.new_unique_id
                        AND unique_id != ca.old_unique_id
                    )
                ),
                
                -- Fourth CTE: Delete the duplicate assets and return count
                deleted_assets AS (
                    DELETE FROM "asset"
                    WHERE unique_id IN (SELECT old_unique_id FROM assets_to_delete)
                    RETURNING asset_id
                ),
                
                -- Fifth CTE: Update assets that need new unique_ids (non-duplicates)
                updated_assets AS (
                    UPDATE "asset" a
                    SET unique_id = ca.new_unique_id
                    FROM changed_assets ca
                    WHERE a.unique_id = ca.old_unique_id
                    AND NOT EXISTS (SELECT 1 FROM assets_to_delete atd WHERE atd.old_unique_id = ca.old_unique_id)
                    RETURNING a.asset_id
                ),
                
                -- Sixth CTE: Update history records with new unique_ids
                updated_history AS (
                    UPDATE "history" h
                    SET unique_id = ca.new_unique_id
                    FROM changed_assets ca
                    WHERE h.unique_id = ca.old_unique_id
                    RETURNING h.id
                )
                
                -- Final result counts
                SELECT
                    (SELECT COUNT(*) FROM changed_assets) AS total_changed,
                    (SELECT COUNT(*) FROM deleted_assets) AS total_deleted,
                    (SELECT COUNT(*) FROM updated_assets) AS total_assets_updated,
                    (SELECT COUNT(*) FROM updated_history) AS total_history_updated;
            `);

            // Log results
            this.logger.debug(`Results: 
                Total assets needing change: ${result[0].total_changed}
                Assets deleted (duplicates): ${result[0].total_deleted}
                Assets updated: ${result[0].total_assets_updated}
                History records updated: ${result[0].total_history_updated}
            `);

            // Drop the temporary function
            await this.toDataSource.query('DROP FUNCTION IF EXISTS generate_unique_id');

            this.logger.debug('Fix completed successfully');
        } catch (error) {
            this.logger.error('Error during fix process:', error);
            throw error;
        }
    }
}
