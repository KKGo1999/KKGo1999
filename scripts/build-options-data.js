#!/usr/bin/env node

const fs = require('node:fs/promises');
const path = require('node:path');

const SYMBOLS = [
    'AAPL',
    'AMD',
    'BILI',
    'CRCL',
    'CRWV',
    'DUOL',
    'GOOG',
    'HIMS',
    'HOOD',
    'LMND',
    'NVDA',
    'OSCR',
    'PDD',
    'RKLB',
    'SOFI',
    'TEM',
    'TSLA',
    'TSLL'
].sort();

const SOURCE_BASE_URL = 'https://cdn.cboe.com/api/global/delayed_quotes/options';
const OUT_DIR = path.resolve(__dirname, '..', 'options', 'data', 'options');
const MANIFEST_PATH = path.resolve(__dirname, '..', 'options', 'data', 'options-manifest.json');
const RETRIES = 2;

function numberOrZero(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number : 0;
}

function parseContractSymbol(contractSymbol) {
    const match = String(contractSymbol || '').match(/^(.+?)(\d{2})(\d{2})(\d{2})([CP])(\d{8})$/i);
    if (!match) return null;

    const year = 2000 + Number(match[2]);
    const month = Number(match[3]);
    const day = Number(match[4]);
    const strike = Number(match[6]) / 1000;

    if (!year || month < 1 || month > 12 || day < 1 || day > 31 || !Number.isFinite(strike)) {
        return null;
    }

    return {
        expiryDate: `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
        optionType: match[5].toUpperCase() === 'C' ? 'call' : 'put',
        strike
    };
}

function normalizeOption(rawOption) {
    const parsed = parseContractSymbol(rawOption?.option);
    if (!parsed) return null;

    return {
        contractSymbol: String(rawOption.option),
        optionType: parsed.optionType,
        expiryDate: parsed.expiryDate,
        strike: parsed.strike,
        lastPrice: numberOrZero(rawOption.last_trade_price),
        bid: numberOrZero(rawOption.bid),
        ask: numberOrZero(rawOption.ask),
        volume: numberOrZero(rawOption.volume),
        openInterest: numberOrZero(rawOption.open_interest),
        impliedVolatility: numberOrZero(rawOption.iv),
        delta: numberOrZero(rawOption.delta),
        gamma: numberOrZero(rawOption.gamma),
        theta: numberOrZero(rawOption.theta),
        vega: numberOrZero(rawOption.vega),
        currency: 'USD',
        lastTradeDate: rawOption.last_trade_time || null
    };
}

async function fetchCboeOptions(symbol) {
    const url = `${SOURCE_BASE_URL}/${encodeURIComponent(symbol)}.json`;
    let lastError;

    for (let attempt = 0; attempt <= RETRIES; attempt += 1) {
        try {
            const response = await fetch(url, {
                headers: {
                    Accept: 'application/json',
                    'User-Agent': 'KKGo1999 options data builder'
                }
            });

            if (!response.ok) {
                throw new Error(`HTTP ${response.status}`);
            }

            return await response.json();
        } catch (error) {
            lastError = error;
            if (attempt < RETRIES) {
                await new Promise(resolve => setTimeout(resolve, 1000 * (attempt + 1)));
            }
        }
    }

    throw lastError || new Error(`Failed to fetch ${symbol}`);
}

async function buildSymbol(symbol) {
    const rawData = await fetchCboeOptions(symbol);
    const options = (rawData?.data?.options || [])
        .map(normalizeOption)
        .filter(Boolean)
        .sort((a, b) => {
            if (a.expiryDate !== b.expiryDate) return a.expiryDate.localeCompare(b.expiryDate);
            if (a.strike !== b.strike) return a.strike - b.strike;
            return a.optionType.localeCompare(b.optionType);
        });

    if (options.length === 0) {
        throw new Error(`No parseable Cboe options for ${symbol}`);
    }

    const payload = {
        symbol,
        source: 'Cboe delayed options quotes',
        sourceUrl: `${SOURCE_BASE_URL}/${encodeURIComponent(symbol)}.json`,
        sourceTimestamp: rawData.timestamp || null,
        generatedAt: new Date().toISOString(),
        options
    };

    await fs.writeFile(path.join(OUT_DIR, `${symbol}.json`), JSON.stringify(payload));

    return {
        symbol,
        optionCount: options.length,
        expirationDates: [...new Set(options.map(option => option.expiryDate))]
    };
}

async function main() {
    await fs.rm(OUT_DIR, { force: true, recursive: true });
    await fs.mkdir(OUT_DIR, { recursive: true });

    const generatedAt = new Date().toISOString();
    const results = [];
    const failures = [];

    for (const symbol of SYMBOLS) {
        try {
            const result = await buildSymbol(symbol);
            results.push(result);
            console.log(`Generated ${symbol}: ${result.optionCount} options`);
        } catch (error) {
            failures.push({ symbol, error: error.message || String(error) });
            console.error(`Failed ${symbol}: ${error.message || error}`);
        }
    }

    const manifest = {
        generatedAt,
        source: 'Cboe delayed options quotes',
        symbols: results,
        failures
    };

    await fs.writeFile(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`);

    if (failures.length > 0) {
        throw new Error(`Failed to generate options data for: ${failures.map(failure => failure.symbol).join(', ')}`);
    }
}

main().catch(error => {
    console.error(error);
    process.exit(1);
});
