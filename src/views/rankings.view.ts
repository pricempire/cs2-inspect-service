import { ViewEntity, ViewColumn } from 'typeorm'

@ViewEntity({
    materialized: true,
    synchronize: true,
    expression: `
        SELECT 
            DENSE_RANK() OVER(ORDER BY "paintWear" DESC) AS "globalLow",
            DENSE_RANK() OVER(ORDER BY "paintWear" ASC) AS "globalHigh",
            DENSE_RANK() OVER(PARTITION BY "paintIndex", "defIndex", "isStattrak", "isSouvenir" ORDER BY "paintWear" DESC) AS "lowRank",
            DENSE_RANK() OVER(PARTITION BY "paintIndex", "defIndex", "isStattrak", "isSouvenir" ORDER BY "paintWear" ASC) AS "highRank",
            "assetId"
        FROM asset
        WHERE "paintWear" IS NOT NULL AND "paintWear" > 0
    `,
})
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
