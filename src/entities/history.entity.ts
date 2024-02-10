import {
    Column,
    CreateDateColumn,
    Entity,
    Index,
    PrimaryColumn,
    PrimaryGeneratedColumn,
} from 'typeorm'

export enum HistoryType {
    TRADE = 1,
    MARKET_LISTING = 2,
    MARKET_BUY = 3,
    STICKER_APPLY = 4,
    UNBOXED = 5,
    UNKNOWN = 6,
    MARKET_RELISTING = 7,
    STICKER_REMOVE = 8,
    STICKER_CHANGE = 9,
}

@Entity()
@Index('history_owner_prevOwner', ['owner', 'prevOwner'])
@Index('history_assetId_prevAssetId', ['assetId', 'prevAssetId'])
@Index('history_assetId', ['assetId'])
@Index('history_prevAssetId', ['prevAssetId'])
@Index('history_owner', ['owner'])
@Index('history_prevOwner', ['prevOwner'])
@Index('history_d', ['d'])
@Index('history_type', ['type'])
@Index('history_createdAt', ['createdAt'])
export class History {
    @PrimaryGeneratedColumn({
        type: 'bigint',
    })
    id: number

    @PrimaryColumn({
        type: 'bigint',
    })
    assetId: number

    @Column({
        nullable: true,
    })
    prevAssetId: number

    @Column()
    type: HistoryType

    @Column({
        type: 'bigint',
    })
    owner: number

    @Column({
        type: 'bigint',
        nullable: true,
    })
    prevOwner: number

    @Column({
        nullable: true,
    })
    d: string

    @Column({
        type: 'jsonb',
        nullable: true,
    })
    stickers: any[]

    @Column({
        type: 'jsonb',
        nullable: true,
    })
    prevStickers: any[]

    @CreateDateColumn()
    createdAt: Date
}
