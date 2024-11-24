import {
    Column,
    CreateDateColumn,
    Entity,
    Index,
    PrimaryColumn,
    PrimaryGeneratedColumn,
} from 'typeorm'

interface StickerKeychain {
    slot: number;
    sticker_id: number;
    wear: number | null;
    scale: number | null;
    rotation: number | null;
    tint_id: number | null;
    offset_x: number | null;
    offset_y: number | null;
    offset_z: number | null;
    pattern: number | null;
}

@Index('asset_assetId', ['assetId'], { unique: true })
@Index('asset_ms_assetId_d_stickers', ['ms', 'assetId', 'd', 'stickers'], {
    unique: true,
})
@Index('asset_paint_details', ['paintSeed', 'paintIndex', 'paintWear'])
@Index('asset_item_details', ['defIndex', 'quality', 'rarity', 'origin'])
@Index('asset_special_flags', ['isStattrak', 'isSouvenir'])
@Index('asset_custom_details', ['customName', 'questId', 'reason'])
@Index('asset_misc', ['musicIndex', 'entIndex'])
@Entity()
export class Asset {
    @PrimaryColumn({
        type: 'bigint',
    })
    assetId: number

    @Column({
        type: 'bigint',
    })
    ms: number

    @Column()
    d: string

    @Column({
        nullable: true,
        type: 'smallint',
    })
    paintSeed: number

    @Column({
        nullable: true,
        type: 'smallint',
    })
    paintIndex: number

    @Column({
        nullable: true,
        type: 'double precision',
    })
    paintWear: number

    @Column({
        type: 'smallint',
        nullable: true,
    })
    quality: number

    @Column({
        nullable: true,
        length: 64,
    })
    customName: string

    @Column({
        nullable: true,
        type: 'smallint',
    })
    defIndex: number

    @Column({
        nullable: true,
        type: 'smallint',
    })
    origin: number

    @Column({
        nullable: true,
        type: 'smallint',
    })
    rarity: number

    @Column({
        nullable: true,
        type: 'smallint',
    })
    questId: number

    @Column({
        nullable: true,
        type: 'smallint',
    })
    reason: number

    @Column({
        nullable: true,
        type: 'smallint',
    })
    musicIndex: number

    @Column({
        nullable: true,
        type: 'smallint',
    })
    entIndex: number

    @Column({
        default: false,
    })
    isStattrak: boolean

    @Column({
        default: false,
    })
    isSouvenir: boolean

    @Column({
        type: 'jsonb',
        nullable: true,
    })
    stickers: StickerKeychain[]

    @Column({
        type: 'jsonb',
        nullable: true,
    })
    keychains: StickerKeychain[]

    @Column({
        nullable: true,
        type: 'smallint',
    })
    killeaterScoreType: number

    @Column({
        nullable: true,
        type: 'integer',
    })
    killeaterValue: number

    @Column({
        nullable: true,
        type: 'smallint',
    })
    petIndex: number

    @Column({
        type: 'smallint',
    })
    inventory: number

    @Column({
        nullable: true,
        type: 'smallint',
    })
    dropReason: number

    @CreateDateColumn()
    createdAt: Date
}
