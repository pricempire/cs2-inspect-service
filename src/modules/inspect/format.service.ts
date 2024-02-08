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

@Injectable()
export class FormatService implements OnModuleInit {
    private readonly logger = new Logger(FormatService.name)

    private schema: any

    private qualities = {
        0: 'Normal',
        1: 'Genuine',
        2: 'Vintage',
        3: '★',
        4: 'Unique',
        5: 'Community',
        6: 'Valve',
        7: 'Prototype',
        8: 'Customized',
        9: 'StatTrak™',
        10: 'Completed',
        11: 'haunted',
        12: 'Souvenir',
    }

    private rarities = {
        1: 'Consumer Grade',
        2: 'Industrial Grade',
        3: 'Mil-Spec Grade',
        4: 'Restricted',
        5: 'Classified',
        6: 'Covert',
        7: 'Contraband',
    }

    private origins = {
        0: 'Timed Drop',
        1: 'Achievement',
        2: 'Purchased',
        3: 'Traded',
        4: 'Crafted',
        5: 'Store Promotion',
        6: 'Gifted',
        7: 'Support Granted',
        8: 'Found in Crate',
        9: 'Earned',
        10: 'Third-Party Promotion',
        11: 'Wrapped Gift',
        12: 'Halloween Drop',
        13: 'Steam Purchase',
        14: 'Foreign Item',
        15: 'CD Key',
        16: 'Collection Reward',
        17: 'Preview Item',
        18: 'Steam Workshop Contribution',
        19: 'Periodic Score Reward',
        20: 'Recycling',
        21: 'Tournament Drop',
        22: 'Stock Item',
        23: 'Quest Reward',
        24: 'Level Up Reward',
    }

    constructor(
        private httpService: HttpService,
        @InjectRepository(Rankings)
        private rankingRepository: Repository<Rankings>,
    ) {}

    async onModuleInit() {
        this.logger.debug('Loading schema...')

        try {
            this.schema = (
                await firstValueFrom(
                    this.httpService.get('https://csfloat.com/api/v1/schema'),
                )
            )?.data
        } catch (e) {
            this.logger.error('Failed to load schema')
            throw new Error('Failed to load schema')
        }

        this.logger.debug('Schema loaded')
    }

    public async formatResponse(asset: Asset) {
        const rank = await this.rankingRepository.findOne({
            where: {
                assetId: asset.assetId,
            },
        })

        const meta = {
            origin: asset.origin,
            quality: asset.quality,
            rarity: asset.rarity,
            a: asset.assetId,
            d: asset.d,
            paintseed: asset.paintSeed,
            defindex: asset.defIndex,
            paintindex: asset.paintIndex,
            itemid: asset.assetId,
            floatid: asset.assetId,
            floatvalue: asset.paintWear,
            rarity_name: this.rarities[asset.rarity],
            quality_name: this.qualities[asset.quality],
            origin_name: this.origins[asset.origin],
            s: asset.ms.toString().startsWith('7656') ? asset.ms : '0',
            m: asset.ms.toString().startsWith('7656') ? '0' : asset.ms,
            low_rank: rank?.lowRank,
            high_rank: rank?.highRank,
            global_low: rank?.globalLow,
            global_high: rank?.globalHigh,
        }

        const weapon = this.schema.weapons[asset.defIndex]

        if (!weapon) {
            if (asset.defIndex === 1209) {
                // Sticker

                return {
                    iteminfo: {
                        ...meta,
                        stickers: [],
                        imageurl: '',
                        min: 0,
                        max: 0,
                        weapon_type: 'Sticker',
                        item_name: 'Sticker',
                        wear_name: '',
                        full_item_name:
                            this.schema.stickers[asset.stickers[0].sticker_id]
                                .market_hash_name,
                    },
                }
            } else if (this.schema.agents[asset.defIndex]) {
                // Agents

                const agent = this.schema.agents[asset.defIndex]

                return {
                    iteminfo: {
                        ...meta,
                        stickers: asset.stickers.map((sticker) => ({
                            stickerId: sticker.sticker_id,
                            slot: sticker.slot,
                            rotation: sticker.rotation,
                            wear: sticker.wear,
                            offsetX: sticker.offset_x,
                            offsetY: sticker.offset_y,
                            scale: sticker.scale,
                            name: this.schema.stickers[
                                sticker.sticker_id
                            ].market_hash_name.replace('Patch | ', ''),
                        })),
                        imageurl: agent.image,
                        min: 0,
                        max: 0,
                        weapon_type: 'Agent',
                        item_name: agent.market_hash_name.split(' | ')[0],
                        wear_name: '',
                        full_item_name: agent.market_hash_name,
                    },
                }
            } else if (asset.defIndex === 1349) {
                return {
                    iteminfo: {
                        ...meta,
                        stickers: asset.stickers.map((sticker) => ({
                            stickerId: sticker.sticker_id,
                            slot: sticker.slot,
                            rotation: sticker.rotation,
                            wear: sticker.wear,
                            offsetX: sticker.offset_x,
                            offsetY: sticker.offset_y,
                            scale: sticker.scale,
                            name: sticker.sticker_id,
                        })),
                        imageurl: '',
                        min: 0,
                        max: 0,
                        weapon_type: 'Graffiti',
                        item_name: 'Graffiti',
                        wear_name: '',
                        full_item_name: 'Graffiti',
                    },
                }
            } else {
                throw new HttpException('Item not found', HttpStatus.NOT_FOUND)
            }
        }
        const paint = weapon.paints[asset.paintIndex]
        const wear = this.getWear(asset.paintWear)

        const item_name = `${weapon.name} | ${paint.name}`

        let full_item_name = item_name

        if (wear) {
            full_item_name = `${full_item_name} (${wear})`
        }
        return {
            iteminfo: {
                ...meta,
                stickers: asset.stickers.map((sticker) => ({
                    stickerId: sticker.sticker_id,
                    slot: sticker.slot,
                    rotation: sticker.rotation,
                    wear: sticker.wear,
                    offsetX: sticker.offset_x,
                    offsetY: sticker.offset_y,
                    scale: sticker.scale,
                    name: this.schema.stickers[
                        sticker.sticker_id
                    ].market_hash_name.replace('Sticker | ', ''),
                })),
                imageurl: paint.image,
                min: paint.min,
                max: paint.max,
                weapon_type: weapon.name,
                item_name: paint.name,
                wear_name: wear,
                full_item_name,
            },
        }
    }

    private getWear(wear: number) {
        if (wear < 0.07) return 'Factory New'
        if (wear < 0.15) return 'Minimal Wear'
        if (wear < 0.38) return 'Field-Tested'
        if (wear < 0.45) return 'Well-Worn'
        return 'Battle-Scarred'
    }
}
