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
    // Trading Events
    TRADE = 1,
    TRADE_BOT = 2,
    TRADE_CANCELLED = 3,

    // Market Events
    MARKET_LISTING = 4,
    MARKET_BUY = 5,
    MARKET_RELISTING = 6,
    MARKET_CANCELLED = 7,

    // Sticker Events
    STICKER_APPLY = 8,
    STICKER_REMOVE = 9,
    STICKER_CHANGE = 10,
    STICKER_SCRAPE = 11,

    // Item Source Events
    UNBOXED = 12,
    CRAFTED = 13,
    TRADED_UP = 14,
    PURCHASED_INGAME = 15,
    DROPPED = 16,

    // Name Tag Events
    NAMETAG_ADDED = 17,
    NAMETAG_REMOVED = 18,

    // Keychain Events
    KEYCHAIN_ADDED = 19,
    KEYCHAIN_REMOVED = 20,
    KEYCHAIN_CHANGED = 21,

    // Special Events
    STORAGE_UNIT_STORED = 22,
    STORAGE_UNIT_RETRIEVED = 23,
    GIFT_RECEIVED = 24,
    GIFT_SENT = 25,

    // Contract Events
    CONTRACT_LISTED = 26,
    CONTRACT_COMPLETED = 27,
    CONTRACT_CANCELLED = 28,

    // Other
    UNKNOWN = 99
}


@Entity()
@Index('history_unique_id', ['uniqueId'])
@Index('history_asset_tracking', ['assetId', 'prevAssetId'])
@Index('history_ownership', ['owner', 'prevOwner'])
@Index('history_timeline', ['createdAt', 'type'])
@Index('history_details', ['d', 'type'])
@Index('history_asset_id', ['assetId'], { unique: true })
export class History {
    @Column()
    uniqueId: string;

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
