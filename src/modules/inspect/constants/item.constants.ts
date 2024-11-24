export enum ItemQuality {
    Normal = 0,
    Genuine = 1,
    Vintage = 2,
    Star = 3,
    Unique = 4,
    Community = 5,
    Valve = 6,
    Prototype = 7,
    Customized = 8,
    StatTrak = 9,
    Completed = 10,
    Haunted = 11,
    Souvenir = 12,
}

export const QUALITY_NAMES: Record<ItemQuality, string> = {
    [ItemQuality.Normal]: 'Normal',
    [ItemQuality.Genuine]: 'Genuine',
    [ItemQuality.Vintage]: 'Vintage',
    [ItemQuality.Star]: '★',
    [ItemQuality.Unique]: 'Unique',
    [ItemQuality.Community]: 'Community',
    [ItemQuality.Valve]: 'Valve',
    [ItemQuality.Prototype]: 'Prototype',
    [ItemQuality.Customized]: 'Customized',
    [ItemQuality.StatTrak]: 'StatTrak™',
    [ItemQuality.Completed]: 'Completed',
    [ItemQuality.Haunted]: 'haunted',
    [ItemQuality.Souvenir]: 'Souvenir',
}

// Similar enums and mappings for rarities and origins... 