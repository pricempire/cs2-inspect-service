import { HttpService } from '@nestjs/axios'
import {
    HttpException,
    HttpStatus,
    Injectable,
    Logger,
    OnModuleInit,
} from '@nestjs/common'
import { InjectRepository } from '@nestjs/typeorm'
import { firstValueFrom } from 'rxjs'
import { Asset } from 'src/entities/asset.entity'
import { Rankings } from 'src/views/rankings.view'
import { Repository } from 'typeorm'
import { Schema, FormattedResponse, Metadata, Paint } from './interfaces/schema.interface'
import { getPatternName } from 'src/constants'

enum ItemDefIndex {
    Sticker = 1209,
    Graffiti2 = 1348,
    Graffiti = 1349,
    Keychain = 1355,
    Bomb = 49,
}

enum WearRange {
    FactoryNew = 0.07,
    MinimalWear = 0.15,
    FieldTested = 0.38,
    WellWorn = 0.45,
}

const Phase = {
    418: 'Phase 1',
    419: 'Phase 2',
    420: 'Phase 3',
    421: 'Phase 4',
    415: 'Ruby',
    416: 'Sapphire',
    417: 'Black Pearl',
    569: 'Phase 1',
    570: 'Phase 2',
    571: 'Phase 3',
    572: 'Phase 4',
    568: 'Emerald',
    618: 'Phase 2',
    619: 'Sapphire',
    617: 'Black Pearl',
    852: 'Phase 1',
    853: 'Phase 2',
    854: 'Phase 3',
    855: 'Phase 4',
    1119: 'Emerald',
    1120: 'Phase 1',
    1121: 'Phase 2',
    1122: 'Phase 3',
    1123: 'Phase 4',
};

@Injectable()
export class FormatService implements OnModuleInit {
    private readonly logger = new Logger(FormatService.name)
    private schema: Schema

    constructor(
        private httpService: HttpService,
        @InjectRepository(Rankings)
        private rankingRepository: Repository<Rankings>,
    ) { }

    async onModuleInit() {
        await this.loadSchema()
    }

    private async loadSchema(): Promise<void> {
        this.logger.debug('Loading schema...')
        try {
            const response = await firstValueFrom(
                this.httpService.get<Schema>('https://csfloat.com/api/v1/schema'),
            )
            this.schema = response.data
            this.logger.debug('Schema loaded')
        } catch (error) {
            this.logger.error('Failed to load schema', error)
            throw new Error('Failed to load schema')
        }
    }

    public async formatResponse(asset: Asset): Promise<FormattedResponse> {
        const rank = await this.rankingRepository.findOne({
            where: { uniqueId: asset.uniqueId },
        })

        const meta = this.createMetadata(asset, rank)

        if (!this.schema.weapons[asset.defIndex]) {
            return this.formatSpecialItem(asset)
        }

        return this.formatWeapon(asset, meta)
    }

    private createMetadata(asset: Asset, rank?: Rankings): Metadata {
        return {
            wear: asset.paintWear ? this.getWear(asset.paintWear) : undefined,
            low_rank: rank?.lowRank,
            high_rank: rank?.highRank,
            totalCount: rank?.globalHigh,
            rank,
            paintIndex: asset.paintIndex,
            defIndex: asset.defIndex,
            quality: asset.quality,
            rarity: asset.rarity,
            origin: asset.origin,
            paintSeed: asset.paintSeed,
            paintWear: asset.paintWear,
            killeaterValue: asset.killeaterValue,
        }
    }

    private formatSpecialItem(asset: Asset): FormattedResponse {
        switch (asset.defIndex) {
            case ItemDefIndex.Sticker:
                return this.formatSticker(asset)
            case ItemDefIndex.Graffiti:
            case ItemDefIndex.Graffiti2:
                return this.formatGraffiti(asset)
            case ItemDefIndex.Keychain:
                return this.formatKeychain(asset)

            case ItemDefIndex.Bomb:
            default:
                if (this.schema.agents[asset.defIndex]) {
                    return this.formatAgent(asset)
                }
                return {
                    iteminfo: {
                        asset_id: asset.assetId,
                        defindex: asset.defIndex,
                        rarity: asset.rarity,
                        quality: asset.quality,
                        origin: asset.origin,
                        type: 'Unknown',
                        ...asset
                    },
                }
        }
    }

    private formatSticker(asset: Asset): FormattedResponse {

        const stickerId = asset.stickers[0].sticker_id

        const sticker = this.schema.stickers[stickerId]
        if (!sticker) {
            throw new HttpException('Sticker not found', HttpStatus.NOT_FOUND)
        }

        return {
            iteminfo: {
                asset_id: asset.assetId,
                defindex: asset.defIndex,
                paintindex: asset.paintIndex,
                rarity: asset.rarity,
                quality: asset.quality,
                origin: asset.origin,
                market_hash_name: sticker.market_hash_name,
                sticker_id: stickerId,
                type: 'Sticker',
            },
        }
    }

    private formatKeychain(asset: Asset): FormattedResponse {
        const keychainId = asset.keychains.find((keychain) => keychain.slot === 0)?.sticker_id
        if (!keychainId) {
            throw new HttpException('Keychain not found', HttpStatus.NOT_FOUND)
        }

        const keychain = this.schema.keychains[keychainId]
        if (!keychain) {
            throw new HttpException('Keychain not found', HttpStatus.NOT_FOUND)
        }

        return {
            iteminfo: {
                asset_id: asset.assetId,
                defindex: asset.defIndex,
                paintindex: asset.paintIndex,
                rarity: asset.rarity,
                quality: asset.quality,
                origin: asset.origin,
                market_hash_name: keychain.market_hash_name,
                type: 'Keychain',
                keychains: asset.keychains.map((keychain) => ({
                    ...keychain,
                    market_hash_name: this.schema.keychains[keychain.sticker_id].market_hash_name,
                })),
            },
        }
    }

    private formatGraffiti(asset: Asset): FormattedResponse {
        const graffitiId = asset.stickers[0].sticker_id
        return {
            iteminfo: {
                asset_id: asset.assetId,
                defindex: asset.defIndex,
                paintindex: asset.paintIndex,
                rarity: asset.rarity,
                quality: asset.quality,
                origin: asset.origin,
                // market_hash_name: graffiti.market_hash_name,
                graffiti_id: graffitiId,
                type: 'Graffiti',
            },
        }
    }

    private formatAgent(asset: Asset): FormattedResponse {
        const agent = this.schema.agents[asset.defIndex]
        if (!agent) {
            throw new HttpException('Agent not found', HttpStatus.NOT_FOUND)
        }

        return {
            iteminfo: {
                asset_id: asset.assetId,
                defindex: asset.defIndex,
                rarity: asset.rarity,
                quality: asset.quality,
                origin: asset.origin,
                market_hash_name: agent.market_hash_name,
                image: agent.image,
                type: 'Agent',
                /** Patches */
                stickers: asset.stickers.map((sticker) => ({
                    ...sticker,
                    market_hash_name: this.schema.stickers[sticker.sticker_id].market_hash_name,
                })),
            },
        }
    }

    private formatWeapon(asset: Asset, meta: Metadata): FormattedResponse {
        const weapon = this.schema.weapons[asset.defIndex]
        const paint = this.getPaint(weapon.paints, asset.paintIndex)

        const marketHashName = this.buildMarketHashName(weapon, paint, meta)
        return {
            iteminfo: {
                asset_id: asset.assetId,
                defindex: asset.defIndex,
                paintindex: asset.paintIndex,
                rarity: asset.rarity,
                quality: asset.quality,
                origin: asset.origin,
                floatvalue: asset.paintWear,
                paintseed: meta.paintSeed,
                wear_name: meta.wear,
                market_hash_name: marketHashName,
                stickers: asset.stickers?.map((sticker) => ({
                    ...sticker,
                    slot: sticker.slot,
                    sticker_id: sticker.sticker_id,
                    wear: sticker.wear,
                    market_hash_name: this.schema.stickers[sticker.sticker_id].market_hash_name,
                })) ?? [],
                keychains: asset.keychains?.map((keychain) => ({
                    ...keychain,
                    market_hash_name: this.schema.keychains[keychain.sticker_id].market_hash_name,
                })) ?? [],
                image: paint?.image,
                type: 'Weapon',
                low_rank: meta.low_rank,
                high_rank: meta.high_rank,
                total_count: meta.totalCount,
                souvenir: meta.quality === 12,
                stattrak: meta.killeaterValue !== null,
                min: paint?.min,
                max: paint?.max,
                phase: Phase[asset.paintIndex] ?? undefined,
                pattern: getPatternName(marketHashName, meta.paintSeed),
            },
        }
    }

    private getPaint(paints: Record<string, Paint>, paintIndex?: number): Paint | undefined {
        if (!paintIndex) return undefined
        return paints[paintIndex.toString()]
    }

    private buildMarketHashName(weapon: any, paint: Paint | undefined, meta: Metadata): string {
        const parts: string[] = []

        if (meta.quality === 3) {
            parts.push('★')
        }

        if (meta.killeaterValue !== null) {
            parts.push('StatTrak™')
        } else if (meta.quality === 12) {
            parts.push('Souvenir')
        }

        parts.push(weapon.name)

        let phase;

        let paintName = paint?.name;

        if (paintName && paintName.includes('Doppler (')) {
            if (paintName.includes('Phase 1')) {
                paintName = paintName.replace(' (Phase 1)', '')
                phase = 'Phase 1'
            } else if (paintName.includes('Phase 2')) {
                paintName = paintName.replace(' (Phase 2)', '')
                phase = 'Phase 2'
            } else if (paintName.includes('Phase 3')) {
                paintName = paintName.replace(' (Phase 3)', '')
                phase = 'Phase 3'
            } else if (paintName.includes('Phase 4')) {
                paintName = paintName.replace(' (Phase 4)', '')
                phase = 'Phase 4'
            } else if (paintName.includes('Ruby')) {
                paintName = paintName.replace(' (Ruby)', '')
                phase = 'Ruby'
            } else if (paintName.includes('Sapphire')) {
                paintName = paintName.replace(' (Sapphire)', '')
                phase = 'Sapphire'
            } else if (paintName.includes('Black Pearl')) {
                paintName = paintName.replace(' (Black Pearl)', '')
                phase = 'Black Pearl'
            } else if (paintName.includes('Emerald')) {
                paintName = paintName.replace(' (Emerald)', '')
                phase = 'Emerald'
            }
        }

        if (paint) parts.push(`| ${paintName}`)
        if (meta.wear && paint /** make sure it wont add to the vanilla paint */) parts.push(`(${meta.wear})`)
        if (phase) parts.push(`- ${phase}`)

        return parts.join(' ').trim();
    }

    private getWear(wear: number): string {
        if (wear < WearRange.FactoryNew) return 'Factory New'
        if (wear < WearRange.MinimalWear) return 'Minimal Wear'
        if (wear < WearRange.FieldTested) return 'Field-Tested'
        if (wear < WearRange.WellWorn) return 'Well-Worn'
        return 'Battle-Scarred'
    }
}
