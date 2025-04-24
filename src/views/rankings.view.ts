import { ViewEntity, ViewColumn, Index } from 'typeorm'

@ViewEntity({
    materialized: true,
    synchronize: true,
    expression: `
        -- Create partitioned approach with multiple separate queries for better performance
        WITH 
        -- Get extreme low float values (top candidates)
        extreme_low_floats AS (
            SELECT
                "unique_id", "paint_wear", "paint_index", "def_index",
                "killeater_value" IS NOT NULL AS is_stattrak,
                "quality" = 12 AS is_souvenir,
                1 AS rarity_tier
            FROM asset
            WHERE "paint_wear" < 0.001
              AND "paint_wear" > 0
              AND "paint_index" > 0
            ORDER BY "paint_wear" ASC
        ),
        -- Get extreme high float values
        extreme_high_floats AS (
            SELECT
                "unique_id", "paint_wear", "paint_index", "def_index",
                "killeater_value" IS NOT NULL AS is_stattrak,
                "quality" = 12 AS is_souvenir,
                1 AS rarity_tier
            FROM asset
            WHERE "paint_wear" > 0.98
              AND "paint_index" > 0
            ORDER BY "paint_wear" DESC
        ),
        -- Get very low float values
        very_low_floats AS (
            SELECT
                "unique_id", "paint_wear", "paint_index", "def_index",
                "killeater_value" IS NOT NULL AS is_stattrak,
                "quality" = 12 AS is_souvenir,
                2 AS rarity_tier
            FROM asset
            WHERE "paint_wear" BETWEEN 0.001 AND 0.01
              AND "paint_index" > 0
            ORDER BY "paint_wear" ASC
        ),
        -- Get very high float values
        very_high_floats AS (
            SELECT
                "unique_id", "paint_wear", "paint_index", "def_index",
                "killeater_value" IS NOT NULL AS is_stattrak,
                "quality" = 12 AS is_souvenir,
                2 AS rarity_tier
            FROM asset
            WHERE "paint_wear" BETWEEN 0.95 AND 0.99
              AND "paint_index" > 0
            ORDER BY "paint_wear" DESC
        ),
        -- Get float values near category boundaries
        boundary_fn_mw AS (
            SELECT 
                "unique_id", "paint_wear", "paint_index", "def_index", 
                "killeater_value" IS NOT NULL AS is_stattrak,
                "quality" = 12 AS is_souvenir,
                3 AS rarity_tier
            FROM asset 
            WHERE "paint_wear" BETWEEN 0.068 AND 0.072
              AND "paint_index" > 0
        ),
        boundary_mw_ft AS (
            SELECT 
                "unique_id", "paint_wear", "paint_index", "def_index", 
                "killeater_value" IS NOT NULL AS is_stattrak,
                "quality" = 12 AS is_souvenir,
                3 AS rarity_tier
            FROM asset 
            WHERE "paint_wear" BETWEEN 0.148 AND 0.152
              AND "paint_index" > 0
        ),
        boundary_ft_ww AS (
            SELECT 
                "unique_id", "paint_wear", "paint_index", "def_index", 
                "killeater_value" IS NOT NULL AS is_stattrak,
                "quality" = 12 AS is_souvenir,
                3 AS rarity_tier
            FROM asset 
            WHERE "paint_wear" BETWEEN 0.378 AND 0.382
              AND "paint_index" > 0
        ),
        boundary_ww_bs AS (
            SELECT 
                "unique_id", "paint_wear", "paint_index", "def_index", 
                "killeater_value" IS NOT NULL AS is_stattrak,
                "quality" = 12 AS is_souvenir,
                3 AS rarity_tier
            FROM asset 
            WHERE "paint_wear" BETWEEN 0.448 AND 0.452
              AND "paint_index" > 0
        ),
        -- Combine all filtered assets
        filtered_assets AS (
            SELECT * FROM extreme_low_floats
            UNION ALL
            SELECT * FROM extreme_high_floats
            UNION ALL
            SELECT * FROM very_low_floats
            UNION ALL
            SELECT * FROM very_high_floats
            UNION ALL
            SELECT * FROM boundary_fn_mw
            UNION ALL
            SELECT * FROM boundary_mw_ft
            UNION ALL
            SELECT * FROM boundary_ft_ww
            UNION ALL
            SELECT * FROM boundary_ww_bs
        ),
        -- Categorize each asset
        categorized_assets AS (
            SELECT
                fa.*,
                CASE
                    WHEN fa."paint_wear" < 0.07 THEN 
                        CASE 
                            WHEN fa.is_stattrak THEN 'ST-FN'
                            WHEN fa.is_souvenir THEN 'SV-FN'
                            ELSE 'FN'
                        END
                    WHEN fa."paint_wear" < 0.15 THEN 
                        CASE 
                            WHEN fa.is_stattrak THEN 'ST-MW'
                            WHEN fa.is_souvenir THEN 'SV-MW'
                            ELSE 'MW'
                        END
                    WHEN fa."paint_wear" < 0.38 THEN 
                        CASE 
                            WHEN fa.is_stattrak THEN 'ST-FT'
                            WHEN fa.is_souvenir THEN 'SV-FT'
                            ELSE 'FT'
                        END
                    WHEN fa."paint_wear" < 0.45 THEN 
                        CASE 
                            WHEN fa.is_stattrak THEN 'ST-WW'
                            WHEN fa.is_souvenir THEN 'SV-WW'
                            ELSE 'WW'
                        END
                    ELSE 
                        CASE 
                            WHEN fa.is_stattrak THEN 'ST-BS'
                            WHEN fa.is_souvenir THEN 'SV-BS'
                            ELSE 'BS'
                        END
                END AS wear_category
            FROM filtered_assets fa
        ),
        -- Get category statistics
        category_stats AS (
            SELECT
                "paint_index",
                "def_index",
                is_stattrak,
                is_souvenir,
                wear_category,
                COUNT(*) AS category_count,
                MIN("paint_wear") AS min_wear,
                MAX("paint_wear") AS max_wear
            FROM categorized_assets
            GROUP BY 
                "paint_index", 
                "def_index", 
                is_stattrak,
                is_souvenir,
                wear_category
            HAVING COUNT(*) > 1  -- Ensure at least 2 items per category
        ),
        -- Join assets with their category stats
        valid_assets AS (
            SELECT
                ca."unique_id",
                ca."paint_wear",
                ca."paint_index",
                ca."def_index",
                ca.is_stattrak,
                ca.is_souvenir,
                ca.wear_category,
                ca.rarity_tier,
                cs.category_count,
                cs.min_wear,
                cs.max_wear
            FROM categorized_assets ca
            INNER JOIN category_stats cs ON
                ca."paint_index" = cs."paint_index" AND
                ca."def_index" = cs."def_index" AND
                ca.is_stattrak = cs.is_stattrak AND
                ca.is_souvenir = cs.is_souvenir AND
                ca.wear_category = cs.wear_category
        ),
        -- Calculate ranks (global and item-specific)
        ranked_assets AS (
            SELECT
                va.*,
                -- Global rankings
                DENSE_RANK() OVER(
                    PARTITION BY va.wear_category 
                    ORDER BY va."paint_wear" DESC
                ) AS global_low_rank,
                DENSE_RANK() OVER(
                    PARTITION BY va.wear_category
                    ORDER BY va."paint_wear" ASC
                ) AS global_high_rank,
                -- Item-specific rankings
                DENSE_RANK() OVER(
                    PARTITION BY 
                        va."paint_index", 
                        va."def_index", 
                        va.is_stattrak, 
                        va.is_souvenir,
                        va.wear_category
                    ORDER BY va."paint_wear" DESC
                ) AS item_low_rank,
                DENSE_RANK() OVER(
                    PARTITION BY 
                        va."paint_index", 
                        va."def_index", 
                        va.is_stattrak, 
                        va.is_souvenir,
                        va.wear_category
                    ORDER BY va."paint_wear" ASC
                ) AS item_high_rank,
                -- Calculate percentiles
                CASE
                    WHEN (va.max_wear - va.min_wear) = 0 THEN 0
                    ELSE ROUND(100 * (1 - ((va."paint_wear" - va.min_wear) / (va.max_wear - va.min_wear))))
                END AS percentile_low,
                CASE
                    WHEN (va.max_wear - va.min_wear) = 0 THEN 0
                    ELSE ROUND(100 * ((va."paint_wear" - va.min_wear) / (va.max_wear - va.min_wear)))
                END AS percentile_high
            FROM valid_assets va
        )
        -- Final selection with ranking criteria
        SELECT
            ra."unique_id" AS "unique_id",
            ra.wear_category AS "wear_category",
            ra.global_low_rank AS "global_low",
            ra.global_high_rank AS "global_high",
            ra.item_low_rank AS "low_rank",
            ra.item_high_rank AS "high_rank",
            ra.percentile_low AS "better_than_percent_low",
            ra.percentile_high AS "better_than_percent_high",
            ra.category_count AS "total_in_category",
            ra."paint_index" AS "paint_index",
            ra."def_index" AS "def_index",
            ra.is_stattrak AS "is_stattrak",
            ra.is_souvenir AS "is_souvenir",
            ra."paint_wear" AS "paint_wear",
            ra.rarity_tier AS "rarity_tier"
        FROM ranked_assets ra
        WHERE 
            ra.global_low_rank <= 100 OR 
            ra.global_high_rank <= 100 OR 
            ra.item_low_rank <= 100 OR 
            ra.item_high_rank <= 100 OR
            ra.rarity_tier <= 2
        ORDER BY 
            ra.rarity_tier,
            GREATEST(
                100 - COALESCE(ra.global_low_rank, 0), 
                100 - COALESCE(ra.global_high_rank, 0),
                100 - COALESCE(ra.item_low_rank, 0),
                100 - COALESCE(ra.item_high_rank, 0)
            ) DESC
    `,
})
@Index(['uniqueId'], { unique: true })
@Index(['wearCategory', 'globalLow'])
@Index(['wearCategory', 'globalHigh'])
@Index(['paintIndex', 'defIndex', 'isStattrak', 'isSouvenir', 'wearCategory', 'lowRank'])
@Index(['paintIndex', 'defIndex', 'isStattrak', 'isSouvenir', 'wearCategory', 'highRank'])
@Index(['rarityTier'])
export class Rankings {
    @ViewColumn()
    uniqueId: string

    @ViewColumn()
    wearCategory: string

    @ViewColumn()
    globalLow: number

    @ViewColumn()
    globalHigh: number

    @ViewColumn()
    lowRank: number

    @ViewColumn()
    highRank: number

    @ViewColumn()
    betterThanPercentLow: number

    @ViewColumn()
    betterThanPercentHigh: number

    @ViewColumn()
    totalInCategory: number

    @ViewColumn()
    paintIndex: number

    @ViewColumn()
    defIndex: number

    @ViewColumn()
    isStattrak: boolean

    @ViewColumn()
    isSouvenir: boolean

    @ViewColumn()
    paintWear: number

    @ViewColumn()
    rarityTier: number
}
