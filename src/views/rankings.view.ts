import { ViewEntity, ViewColumn, Unique, Index } from 'typeorm'

@ViewEntity({
    materialized: true,
    synchronize: true,
    expression: `
        WITH top_global_low AS (
            SELECT "asset_id", "paint_wear"
            FROM asset
            WHERE "paint_wear" IS NOT NULL AND "paint_wear" > 0
            ORDER BY "paint_wear" DESC
            LIMIT 500
        ),
        top_global_high AS (
            SELECT "asset_id", "paint_wear"
            FROM asset
            WHERE "paint_wear" IS NOT NULL AND "paint_wear" > 0
            ORDER BY "paint_wear" ASC
            LIMIT 500
        ),
        top_low_rank AS (
            SELECT a."asset_id", a."paint_wear", a."paint_index", a."def_index", a."is_stattrak", a."is_souvenir"
            FROM asset a
            INNER JOIN (
                SELECT "paint_index", "def_index", "is_stattrak", "is_souvenir", MIN("paint_wear") + 
                    (SELECT percentile_cont(0.01) WITHIN GROUP (ORDER BY "paint_wear") 
                     FROM asset 
                     WHERE "paint_wear" IS NOT NULL AND "paint_wear" > 0) AS wear_threshold
                FROM asset
                WHERE "paint_wear" IS NOT NULL AND "paint_wear" > 0
                GROUP BY "paint_index", "def_index", "is_stattrak", "is_souvenir"
            ) b ON a."paint_index" = b."paint_index" 
                AND a."def_index" = b."def_index" 
                AND a."is_stattrak" = b."is_stattrak" 
                AND a."is_souvenir" = b."is_souvenir"
                AND a."paint_wear" >= b.wear_threshold
        ),
        top_high_rank AS (
            SELECT a."asset_id", a."paint_wear", a."paint_index", a."def_index", a."is_stattrak", a."is_souvenir"
            FROM asset a
            INNER JOIN (
                SELECT "paint_index", "def_index", "is_stattrak", "is_souvenir", MAX("paint_wear") - 
                    (SELECT percentile_cont(0.01) WITHIN GROUP (ORDER BY "paint_wear") 
                     FROM asset 
                     WHERE "paint_wear" IS NOT NULL AND "paint_wear" > 0) AS wear_threshold
                FROM asset
                WHERE "paint_wear" IS NOT NULL AND "paint_wear" > 0
                GROUP BY "paint_index", "def_index", "is_stattrak", "is_souvenir"
            ) b ON a."paint_index" = b."paint_index" 
                AND a."def_index" = b."def_index" 
                AND a."is_stattrak" = b."is_stattrak" 
                AND a."is_souvenir" = b."is_souvenir"
                AND a."paint_wear" <= b.wear_threshold
        ),
        combined_assets AS (
            SELECT DISTINCT "asset_id" FROM top_global_low
            UNION
            SELECT DISTINCT "asset_id" FROM top_global_high
            UNION
            SELECT DISTINCT "asset_id" FROM top_low_rank
            UNION
            SELECT DISTINCT "asset_id" FROM top_high_rank
        ),
        ranked_assets AS (
            SELECT 
                DENSE_RANK() OVER(ORDER BY a."paint_wear" DESC) AS "global_low",
                DENSE_RANK() OVER(ORDER BY a."paint_wear" ASC) AS "global_high",
                DENSE_RANK() OVER(PARTITION BY a."paint_index", a."def_index", a."is_stattrak", a."is_souvenir" ORDER BY a."paint_wear" DESC) AS "low_rank",
                DENSE_RANK() OVER(PARTITION BY a."paint_index", a."def_index", a."is_stattrak", a."is_souvenir" ORDER BY a."paint_wear" ASC) AS "high_rank",
                a."asset_id"
            FROM asset a
            INNER JOIN combined_assets ca ON a."asset_id" = ca."asset_id"
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
