const fs = require('fs');

const dopplerPatterns = {};
const gammaPatterns = {};

const chPatterns = JSON.parse(fs.readFileSync('static/ch-patterns.json', 'utf8'));
const marblePatterns = JSON.parse(fs.readFileSync('static/marble-fade-patterns.json', 'utf8'));
const fadePatterns = JSON.parse(fs.readFileSync('static/fade-percentages.json', 'utf8'));

const weaponNames = {
    "bayonet": "Bayonet",
    "butterfly": "Butterfly Knife",
    "classic": "Classic Knife",
    "falchion": "Falchion Knife",
    "flip": "Flip Knife",
    "gut": "Gut Knife",
    "huntsman": "Huntsman Knife",
    "karambit": "Karambit",
    "m9": "M9 Bayonet",
    "navaja": "Navaja Knife",
    "nomad": "Nomad Knife",
    "paracord": "Paracord Knife",
    "skeleton": "Skeleton Knife",
    "stilleto": "Stilleto Knife",
    "survival": "Survival Knife",
    "talon": "Talon Knife",
    "ursus": "Ursus Knife",
    'kukri': 'Kukri Knife',
    'awp': 'AWP',
    'mp9': 'MP9',
    'five_seven': 'Five-Seven',
    'ak47': 'AK-47',
    'glock': 'Glock-18',
};

const patternTypes = {
    'Case Hardened': 'ch',
    'Marble Fade': 'marble',
    'Fade': 'fade',
    'Gamma Doppler': 'gamma',
    'Doppler': 'doppler'
};

export const getPatternName = (marketHashName: string, paintSeed: number) => {
    const weaponKey = Object.keys(weaponNames).find(key => marketHashName.includes(weaponNames[key]));
    const type = Object.keys(patternTypes).find(key => marketHashName.includes(key)) || null;

    if (!type || !weaponKey) {
        return null;
    }

    const patterns = {
        'ch': chPatterns,
        'marble': marblePatterns,
        'fade': fadePatterns,
        'doppler': dopplerPatterns,
        'gamma': gammaPatterns
    };

    const pattern = patterns[patternTypes[type]];
    return pattern[weaponKey] ? Object.keys(pattern[weaponKey]).find(key => pattern[weaponKey][key].includes(paintSeed)) : null;
};

export const dopplers = {
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

export const slugify = (str: string) => {
    if (!str) {
        return str;
    }

    return str
        .toString()
        .toLowerCase()
        .replace('弐', '2')
        .replace('  ', 'doublespace')
        .replace(/\s+/g, '-') // Replace spaces with -
        .replace(/[^\w\-]+/g, '') // Remove all non-word chars
        .replace(/\-\-+/g, '-') // Replace multiple - with single -
        .replace(/^-+/, '') // Trim - from start of text
        .replace(/-+$/, '') // Trim - from end of text
        .replace('doublespace', '-'); // Replace double space with -
}; 