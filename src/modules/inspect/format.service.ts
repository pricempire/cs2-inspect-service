import { Injectable, Logger } from '@nestjs/common'
import { Asset } from 'src/entities/asset.entity'

@Injectable()
export class FormatService {
    private readonly logger = new Logger(FormatService.name)

    public formatResponse(asset: Asset) {
        console.log(asset)
        return asset
        /*
        {
            "iteminfo": {
                "stickers": [
                    {
                        "slot": 0,
                        "stickerId": 5935,
                        "codename": "csgo10_blue_gem_glitter",
                        "material": "csgo10/blue_gem_glitter",
                        "name": "Blue Gem (Glitter)"
                    }
                ],
                "itemid": "35675800220",
                "defindex": 1209,
                "paintindex": 0,
                "rarity": 4,
                "quality": 4,
                "paintseed": 0,
                "inventory": 261,
                "origin": 8,
                "s": "76561198023809011",
                "a": "35675800220",
                "d": "12026419764860007457",
                "m": "0",
                "floatvalue": 0,
                "min": 0.06,
                "max": 0.8,
                "weapon_type": "Sticker",
                "item_name": "-",
                "rarity_name": "Remarkable",
                "quality_name": "Unique",
                "origin_name": "Found in Crate",
                "full_item_name": "Sticker | Blue Gem (Glitter)"
            }
        }
        */
    }
}
