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
    rank?: number;
    totalCount?: number;
    paintIndex?: number;
    defIndex: number;
    quality: number;
    rarity: number;
    origin: number;
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
        defindex: number;
        paintindex?: number;
        rarity: number;
        quality: number;
        origin: number;
        wear?: number;
        wear_name?: string;
        market_hash_name: string;
        image?: string;
        type: 'Weapon' | 'Sticker' | 'Graffiti' | 'Agent' | 'Keychain';
        rank?: number;
        total_count?: number;
        stickers?: StickerKeychain[];
        keychains?: StickerKeychain[];
    };
} 