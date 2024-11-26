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

enum ItemDefIndex {
    Sticker = 1209,
    Graffiti = 1349,
    Keychain = 1355,
}

enum WearRange {
    FactoryNew = 0.07,
    MinimalWear = 0.15,
    FieldTested = 0.38,
    WellWorn = 0.45,
}

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
            where: { assetId: asset.assetId },
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
            rank: rank?.lowRank,
            totalCount: rank?.globalHigh,
            paintIndex: asset.paintIndex,
            defIndex: asset.defIndex,
            quality: asset.quality,
            rarity: asset.rarity,
            origin: asset.origin,
            paintSeed: asset.paintSeed,
            paintWear: asset.paintWear,
        }
    }

    private formatSpecialItem(asset: Asset): FormattedResponse {
        switch (asset.defIndex) {
            case ItemDefIndex.Sticker:
                return this.formatSticker(asset)
            case ItemDefIndex.Graffiti:
                return this.formatGraffiti(asset)
            case ItemDefIndex.Keychain:
                return this.formatKeychain(asset)
            default:
                if (this.schema.agents[asset.defIndex]) {
                    return this.formatAgent(asset)
                }
                throw new HttpException('Item not found', HttpStatus.NOT_FOUND)
        }
    }

    private formatSticker(asset: Asset): FormattedResponse {
        const sticker = this.schema.stickers[asset.paintIndex]
        if (!sticker) {
            throw new HttpException('Sticker not found', HttpStatus.NOT_FOUND)
        }

        return {
            iteminfo: {
                defindex: asset.defIndex,
                paintindex: asset.paintIndex,
                rarity: asset.rarity,
                quality: asset.quality,
                origin: asset.origin,
                market_hash_name: sticker.market_hash_name,
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
        const graffiti = this.schema.graffiti[asset.paintIndex]
        if (!graffiti) {
            throw new HttpException('Graffiti not found', HttpStatus.NOT_FOUND)
        }

        return {
            iteminfo: {
                defindex: asset.defIndex,
                paintindex: asset.paintIndex,
                rarity: asset.rarity,
                quality: asset.quality,
                origin: asset.origin,
                market_hash_name: graffiti.market_hash_name,
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
                defindex: asset.defIndex,
                rarity: asset.rarity,
                quality: asset.quality,
                origin: asset.origin,
                market_hash_name: agent.market_hash_name,
                image: agent.image,
                type: 'Agent',
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

        return {
            iteminfo: {
                defindex: asset.defIndex,
                paintindex: asset.paintIndex,
                rarity: asset.rarity,
                quality: asset.quality,
                origin: asset.origin,
                paintwear: asset.paintWear,
                paintseed: meta.paintSeed,
                wear_name: meta.wear,
                market_hash_name: this.buildMarketHashName(weapon, paint, meta),
                stickers: asset.stickers.map((sticker) => ({
                    ...sticker,
                    slot: sticker.slot,
                    sticker_id: sticker.sticker_id,
                    wear: sticker.wear,
                    market_hash_name: this.schema.stickers[sticker.sticker_id].market_hash_name,
                })),
                keychains: asset.keychains.map((keychain) => ({
                    ...keychain,
                    market_hash_name: this.schema.keychains[keychain.sticker_id].market_hash_name,
                })),
                image: paint?.image,
                type: 'Weapon',
                rank: meta.rank,
                total_count: meta.totalCount,
                souvenir: meta.quality === 12,
                stattrak: meta.quality === 9,
            },
        }
    }

    private getPaint(paints: Record<string, Paint>, paintIndex?: number): Paint | undefined {
        if (!paintIndex) return undefined
        return paints[paintIndex.toString()]
    }

    private buildMarketHashName(weapon: any, paint: Paint | undefined, meta: Metadata): string {
        const parts: string[] = []

        if (meta.quality === 9) parts.push('StatTrak™')
        if (meta.quality === 12) parts.push('Souvenir')

        parts.push(weapon.name)
        if (paint) parts.push(`| ${paint.name}`)
        if (meta.wear) parts.push(`(${meta.wear})`)

        return parts.join(' ')
    }

    private getWear(wear: number): string {
        if (wear < WearRange.FactoryNew) return 'Factory New'
        if (wear < WearRange.MinimalWear) return 'Minimal Wear'
        if (wear < WearRange.FieldTested) return 'Field-Tested'
        if (wear < WearRange.WellWorn) return 'Well-Worn'
        return 'Battle-Scarred'
    }
}
