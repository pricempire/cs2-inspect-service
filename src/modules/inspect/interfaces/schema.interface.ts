export interface Weapon {
    name: string;
    paints: Record<string, Paint>;
}

export interface Paint {
    name: string;
    image: string;
    min: number;
    max: number;
}

export interface Schema {
    weapons: Record<string, Weapon>;
    stickers: Record<string, { market_hash_name: string }>;
    agents: Record<string, { market_hash_name: string; image: string }>;
    graffiti: Record<string, { market_hash_name: string }>;
    keychains: Record<string, { market_hash_name: string }>;
}

export interface Metadata {
    wear?: string;
    low_rank?: number;
    high_rank?: number;
    totalCount?: number;
    paintIndex?: number;
    defIndex: number;
    quality: number;
    rarity: number;
    origin: number;
    paintSeed: number;
    paintWear: number;
    killeaterValue?: number;
}

export interface StickerKeychain {
    slot: number;
    sticker_id: number;
    wear: number | null;
    scale: number | null;
    rotation: number | null;
    tint_id: number | null;
    offset_x: number | null;
    offset_y: number | null;
    offset_z: number | null;
    pattern?: number | null;
}

export interface FormattedResponse {
    iteminfo: {
        asset_id: number;
        defindex: number;
        paintindex?: number;
        rarity: number;
        quality: number;
        origin: number;
        floatvalue?: number;
        paintseed?: number;
        wear_name?: string;
        sticker_id?: number;
        market_hash_name?: string;
        souvenir?: boolean;
        graffiti_id?: number;
        stattrak?: boolean;
        image?: string;
        type: 'Weapon' | 'Sticker' | 'Graffiti' | 'Agent' | 'Keychain' | 'Unknown';
        low_rank?: number;
        high_rank?: number;
        total_count?: number;
        stickers?: StickerKeychain[];
        keychains?: StickerKeychain[];
        min?: number;
        max?: number;
        phase?: string;
        pattern?: string;
    };
} 