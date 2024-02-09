import {
    Column,
    CreateDateColumn,
    Entity,
    Index,
    PrimaryGeneratedColumn,
} from 'typeorm'

@Index('asset_ms_assetId_d_stickers', ['ms', 'assetId', 'd', 'stickers'], {
    unique: true,
})
@Index('paintSeed_paintIndex_paintWear', [
    'paintSeed',
    'paintIndex',
    'paintWear',
])
@Index('asset_ms', ['ms'])
@Index('asset_assetId', ['assetId'])
@Index('asset_d', ['d'])
@Index('asset_paintSeed', ['paintSeed'])
@Index('asset_paintIndex', ['paintIndex'])
@Index('asset_paintWear', ['paintWear'])
@Index('asset_customName', ['customName'])
@Index('asset_defIndex', ['defIndex'])
@Index('asset_origin', ['origin'])
@Index('asset_rarity', ['rarity'])
@Index('asset_questId', ['questId'])
@Index('asset_reason', ['reason'])
@Index('asset_musicIndex', ['musicIndex'])
@Index('asset_entIndex', ['entIndex'])
@Index('asset_isStattrak', ['isStattrak'])
@Index('asset_isSouvenir', ['isSouvenir'])
@Index('asset_stickers', ['stickers'])
@Entity()
export class Asset {
    @PrimaryGeneratedColumn({
        type: 'bigint',
    })
    id: number

    @Column({
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
    stickers: any[]

    @CreateDateColumn()
    createdAt: Date
}
