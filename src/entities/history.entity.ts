import { StickerKeychain } from 'src/modules/inspect/interfaces/schema.interface'
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
@Index('history_asset_tracking', ['assetId', 'prevAssetId'])
@Index('history_ownership', ['owner', 'prevOwner'])
@Index('history_timeline', ['createdAt', 'type'])
@Index('history_details', ['d', 'type'])
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
        type: 'bigint',
        nullable: true,
    })
    prevAssetId: number

    @Column({
        type: 'smallint',
    })
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
        length: 64,
    })
    d: string

    @Column({
        type: 'jsonb',
        nullable: true,
    })
    stickers: StickerKeychain[]

    @Column({
        type: 'jsonb',
        nullable: true,
    })
    prevStickers: StickerKeychain[]

    @Column({
        type: 'jsonb',
        nullable: true,
    })
    keychains: StickerKeychain[]

    @Column({
        type: 'jsonb',
        nullable: true,
    })
    prevKeychains: StickerKeychain[]

    @CreateDateColumn()
    createdAt: Date
}
