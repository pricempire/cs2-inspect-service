import { ViewEntity, ViewColumn, Unique, Index } from 'typeorm'

@ViewEntity({
    materialized: true,
    synchronize: true,
    expression: `
        WITH ranked_assets AS (
            SELECT 
                DENSE_RANK() OVER(ORDER BY "paint_wear" DESC) AS "global_low",
                DENSE_RANK() OVER(ORDER BY "paint_wear" ASC) AS "global_high",
                DENSE_RANK() OVER(PARTITION BY "paint_index", "def_index", "is_stattrak", "is_souvenir" ORDER BY "paint_wear" DESC) AS "low_rank",
                DENSE_RANK() OVER(PARTITION BY "paint_index", "def_index", "is_stattrak", "is_souvenir" ORDER BY "paint_wear" ASC) AS "high_rank",
                "asset_id"
            FROM asset
            WHERE "paint_wear" IS NOT NULL AND "paint_wear" > 0 
        )
        SELECT * FROM ranked_assets
        WHERE "global_low" <= 500
           OR "global_high" <= 500 
           OR "low_rank" <= 500 
           OR "high_rank" <= 500
    `,
})
@Index(['assetId'], { unique: true })
export class Rankings {
    @ViewColumn()
    globalLow: number

    @ViewColumn()
    globalHigh: number

    @ViewColumn()
    lowRank: number

    @ViewColumn()
    highRank: number

    @ViewColumn()
    assetId: number
}
