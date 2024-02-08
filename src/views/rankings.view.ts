import { ViewEntity, ViewColumn } from 'typeorm'

@ViewEntity({
    materialized: true,
    synchronize: true,
    expression: `
        SELECT 
            DENSE_RANK() OVER(ORDER BY "paintWear" DESC) AS "globalRank",
            DENSE_RANK() OVER(PARTITION BY "paintIndex", "defIndex", "isStattrak", "isSouvenir" ORDER BY "paintWear" DESC) AS "rank",
            "assetId"
        FROM asset
        WHERE "paintWear" IS NOT NULL AND "paintWear" > 0
    `,
})
export class Rankings {
    @ViewColumn()
    globalRank: number

    @ViewColumn()
    rank: number

    @ViewColumn()
    assetId: number
}
