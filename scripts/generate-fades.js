// https://raw.githubusercontent.com/chescos/csgo-fade-percentage-calculator/master/generated/fade-percentages.json

const fs = require('fs')
const path = require('path')
const https = require('https')

const url =
    'https://raw.githubusercontent.com/chescos/csgo-fade-percentage-calculator/master/generated/fade-percentages.json'
const rawOutputPath = path.join(__dirname, '../data/fade-percentages.json')
const processedOutputPath = path.join(
    __dirname,
    '../static/fade-percentages.json',
)

// Ensure directories exist
const dataDir = path.dirname(rawOutputPath)
const staticDir = path.dirname(processedOutputPath)
if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true })
}
if (!fs.existsSync(staticDir)) {
    fs.mkdirSync(staticDir, { recursive: true })
}

console.log(`Fetching fade percentages from ${url}...`)

https
    .get(url, (res) => {
        let data = ''

        res.on('data', (chunk) => {
            data += chunk
        })

        res.on('end', () => {
            try {
                const rawFadeData = JSON.parse(data)

                // Save raw data
                fs.writeFileSync(
                    rawOutputPath,
                    JSON.stringify(rawFadeData, null, 2),
                )
                console.log(
                    `Successfully saved raw fade percentages to ${rawOutputPath}`,
                )

                // Process and transform data
                console.log('Processing and aggregating fade data...')
                const processedFadeData = processData(rawFadeData)

                // Save processed data
                fs.writeFileSync(
                    processedOutputPath,
                    JSON.stringify(processedFadeData, null, 2),
                )
                console.log(
                    `Successfully saved processed fade percentages to ${processedOutputPath}`,
                )
            } catch (error) {
                console.error('Error processing fade data:', error)
            }
        })
    })
    .on('error', (error) => {
        console.error('Error fetching fade data:', error)
    })

/**
 * Clean weapon name by removing "knife" and applying specific mappings
 * @param {string} name The weapon name
 * @returns {string} Cleaned weapon name
 */
function cleanWeaponName(name) {
    // Convert to lowercase
    let cleaned = name.toLowerCase()

    // Remove the word "knife"
    cleaned = cleaned.replace(/\sknife/g, '')

    // Apply specific mappings
    const mappings = {
        'r8 revolver': 'r8',
        'm9 bayonet': 'm9',
        'shadow daggers': 'shadow_daggers',
        'ump-45': 'ump',
    }

    // Check if we have a specific mapping for this weapon name
    if (mappings[cleaned]) {
        return mappings[cleaned]
    }

    // Trim leading and trailing whitespace
    cleaned = cleaned.trim()

    return cleaned
}

/**
 * Processes raw fade data into the desired format
 * @param {Array} rawData Array of objects with weapon and percentages arrays
 * @returns {Object} Structured data by weapon and percentage
 */
function processData(rawData) {
    const result = {}

    // Process each weapon entry in the raw data
    rawData.forEach((weaponData) => {
        if (
            !weaponData ||
            !weaponData.weapon ||
            !weaponData.percentages ||
            !Array.isArray(weaponData.percentages)
        ) {
            console.warn('Skipping invalid weapon data:', weaponData)
            return
        }

        const weaponName = cleanWeaponName(weaponData.weapon)

        if (!result[weaponName]) {
            result[weaponName] = {}
        }

        // Process all seed entries for this weapon
        weaponData.percentages.forEach((entry) => {
            if (
                !entry ||
                typeof entry.seed !== 'number' ||
                entry.percentage === undefined
            ) {
                return
            }

            const seed = entry.seed
            const percentage = Number(entry.percentage)

            // Skip if percentage is not a valid number
            if (isNaN(percentage)) {
                return
            }

            // Format the percentage
            let formattedPercentage
            if (Number.isInteger(percentage)) {
                formattedPercentage = percentage.toString()
            } else {
                formattedPercentage = percentage.toFixed(2)
            }

            // If this percentage doesn't exist yet, create an array
            if (!result[weaponName][formattedPercentage]) {
                result[weaponName][formattedPercentage] = []
            }

            // Add the seed to the array
            result[weaponName][formattedPercentage].push(seed)
        })
    })

    return result
}
