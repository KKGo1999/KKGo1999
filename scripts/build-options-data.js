#!/usr/bin/env node

const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const core = require('../options/analysisCore.js');
const APIService = require('../options/apiService.js');
const { renderAgentSite } = require('./render-agent-site.js');

const SOURCE_BASE_URL = 'https://cdn.cboe.com/api/global/delayed_quotes/options';
const api = new APIService();
api.debug = false;

function parseContractSymbol(contractSymbol) {
    const match = String(contractSymbol || '').match(/^(.+?)(\d{2})(\d{2})(\d{2})([CP])(\d{8})$/i);
    if (!match) return null;
    const expiryDate = '20' + match[2] + '-' + match[3] + '-' + match[4];
    const parsedDate = new Date(expiryDate + 'T00:00:00Z');
    if (!Number.isFinite(parsedDate.getTime()) || parsedDate.toISOString().slice(0, 10) !== expiryDate) return null;
    return { root: match[1], expiryDate, optionType: match[5].toUpperCase() === 'C' ? 'call' : 'put', strike: Number(match[6]) / 1000 };
}

function normalizeOption(rawOption, symbol) {
    const parsed = parseContractSymbol(rawOption?.option);
    if (!parsed) return null;
    const standardRoot = parsed.root === symbol;
    return {
        contractSymbol: String(rawOption.option), optionType: parsed.optionType,
        expiryDate: parsed.expiryDate, strike: parsed.strike,
        lastPrice: core.numberOrNull(rawOption.last_trade_price),
        bid: core.numberOrNull(rawOption.bid), ask: core.numberOrNull(rawOption.ask),
        volume: core.numberOrNull(rawOption.volume), openInterest: core.numberOrNull(rawOption.open_interest),
        impliedVolatility: core.numberOrNull(rawOption.iv), delta: core.numberOrNull(rawOption.delta),
        gamma: core.numberOrNull(rawOption.gamma), theta: core.numberOrNull(rawOption.theta),
        vega: core.numberOrNull(rawOption.vega), currency: 'USD',
        contractMultiplier: standardRoot ? 100 : null,
        multiplierStatus: standardRoot ? 'assumed standard contract' : 'unknown adjusted contract',
        lastTradeDate: rawOption.last_trade_time || null
    };
}

async function fetchCboeOptions(symbol) {
    let lastError;
    for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
            const response = await fetch(SOURCE_BASE_URL + '/' + encodeURIComponent(symbol) + '.json', {
                headers: { Accept: 'application/json', 'User-Agent': 'KKGo1999 options data builder' },
                signal: AbortSignal.timeout(20000)
            });
            if (!response.ok) throw new Error('HTTP ' + response.status);
            return await response.json();
        } catch (error) {
            lastError = error;
            if (attempt < 2) await new Promise(resolve => setTimeout(resolve, 1000 * (attempt + 1)));
        }
    }
    throw lastError;
}

async function buildSite({
    root = path.resolve(__dirname, '..'),
    asOf = new Date().toISOString(),
    symbols = core.SUPPORTED_SYMBOLS,
    loadOptions = fetchCboeOptions,
    loadQuote = symbol => api.getStockPrice(symbol),
    loadYtd = (symbol, price) => api.getYearToDateChange(symbol, price),
    mode = 'published-default'
} = {}) {
    const snapshotId = 'options-' + asOf.replace(/[:.]/g, '-');
    const snapshots = [];
    const stocks = [];
    const failures = [];
    let nextIndex = 0;
    // Limit upstream concurrency; failed symbols remain visible in the published directory.
    async function worker() {
        while (nextIndex < symbols.length) {
            const symbol = symbols[nextIndex++];
            const [optionsResult, quoteResult] = await Promise.allSettled([loadOptions(symbol), loadQuote(symbol)]);
            const quote = quoteResult.status === 'fulfilled' ? quoteResult.value : null;
            const errors = [];
            let optionsData = null;
            let ytd = null;
            if (quoteResult.status === 'rejected') errors.push('stock: ' + quoteResult.reason.message);
            if (optionsResult.status === 'fulfilled') {
                const raw = optionsResult.value;
                const options = (raw?.data?.options || []).map(option => normalizeOption(option, symbol)).filter(Boolean);
                options.sort((a, b) => a.expiryDate.localeCompare(b.expiryDate) || a.strike - b.strike ||
                    a.optionType.localeCompare(b.optionType) || a.contractSymbol.localeCompare(b.contractSymbol));
                if (options.length) {
                    optionsData = {
                        schemaVersion: core.SCHEMA_VERSION, snapshotId, symbol, mode,
                        source: 'Cboe delayed options quotes',
                        sourceUrl: SOURCE_BASE_URL + '/' + encodeURIComponent(symbol) + '.json',
                        sourceTimestamp: raw.timestamp || null, sourceTimeZone: null,
                        generatedAt: asOf, retrievedAt: raw.cachedRetrievedAt || new Date().toISOString(),
                        isDelayed: true, underlyingQuote: quote, currency: 'USD', options
                    };
                } else errors.push('options: no parseable contracts');
            } else errors.push('options: ' + optionsResult.reason.message);
            if (quote?.price > 0) {
                try { ytd = await loadYtd(symbol, quote.price); }
                catch (error) { errors.push('ytd: ' + error.message); }
            }
            const snapshot = { symbol, quote, optionsData, error: errors.join('; ') };
            snapshots.push(snapshot);
            const stock = {
                symbol, inWatchlist: core.WATCHLIST.includes(symbol),
                status: !quote && !optionsData ? 'unavailable' : errors.length ? 'partial' : 'available',
                quote, ytdChangePct: ytd?.percent ?? null, ytdBaseDate: ytd?.baseDate ?? null,
                ytdBasePrice: ytd?.basePrice ?? null,
                optionCount: optionsData?.options.length || 0,
                optionsSourceTimestamp: optionsData?.sourceTimestamp || null,
                optionsUrl: optionsData ? '/options/data/options/' + symbol + '.json' : null,
                agentUrl: '/options/agent/stocks/' + symbol + '.html', errors
            };
            stocks.push(stock);
            if (errors.length) failures.push({ symbol, errors });
            console.log(symbol + ': ' + stock.optionCount + ' options, ' + stock.status);
        }
    }
    await Promise.all(Array.from({ length: 3 }, () => worker()));
    if (!snapshots.some(snapshot => snapshot.optionsData)) throw new Error('No options available; previous published data retained');
    const order = new Map(symbols.map((symbol, index) => [symbol, index]));
    stocks.sort((a, b) => order.get(a.symbol) - order.get(b.symbol));
    snapshots.sort((a, b) => order.get(a.symbol) - order.get(b.symbol));
    const scan = core.scanSnapshots(core.WATCHLIST.filter(symbol => symbols.includes(symbol))
        .map(symbol => snapshots.find(snapshot => snapshot.symbol === symbol)), core.DEFAULTS,
    { asOf, snapshotId, scope: 'published-default' });
    const metadata = { schemaVersion: core.SCHEMA_VERSION, snapshotId, generatedAt: asOf, mode };
    const stocksData = {
        ...metadata, status: failures.length ? 'partial' : 'complete',
        watchlist: core.WATCHLIST.filter(symbol => symbols.includes(symbol)),
        defaultFilters: core.DEFAULTS, assumptions: core.ASSUMPTIONS, stocks, failures
    };
    const stage = await fs.mkdtemp(path.join(os.tmpdir(), 'options-agent-build-'));
    try {
        const dataDir = path.join(stage, 'options', 'data');
        await fs.mkdir(path.join(dataDir, 'options'), { recursive: true });
        for (const snapshot of snapshots) {
            if (snapshot.optionsData) await fs.writeFile(path.join(dataDir, 'options', snapshot.symbol + '.json'),
                JSON.stringify(snapshot.optionsData));
        }
        await fs.writeFile(path.join(dataDir, 'candidates.json'), JSON.stringify(core.exportScan(scan), null, 2) + '\n');
        await renderAgentSite(stage, stocksData, scan, snapshots);
        const manifest = {
            ...metadata, source: 'Cboe delayed options quotes', failures,
            stocksUrl: '/options/data/stocks.json', candidatesUrl: '/options/data/candidates.json',
            agentUrl: '/options/agent/', fieldsUrl: '/options/agent/fields.html',
            fieldsTextUrl: '/options/agent/fields.txt', fieldsMarkdownUrl: '/options/agent/fields.md',
            symbols: stocks.map(stock => ({
                symbol: stock.symbol, inWatchlist: stock.inWatchlist, status: stock.status,
                optionCount: stock.optionCount, url: stock.optionsUrl,
                sourceTimestamp: stock.optionsSourceTimestamp,
                expirationDates: stock.expirations.map(item => item.expiryDate)
            }))
        };
        await fs.writeFile(path.join(dataDir, 'options-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
        const destinationData = path.join(root, 'options', 'data');
        const destinationAgent = path.join(root, 'options', 'agent');
        await fs.mkdir(destinationAgent, { recursive: true });
        await fs.rm(destinationData, { recursive: true, force: true });
        await fs.cp(dataDir, destinationData, { recursive: true });
        await fs.rm(path.join(destinationAgent, 'stocks'), { recursive: true, force: true });
        await fs.cp(path.join(stage, 'options', 'agent'), destinationAgent, { recursive: true });
        return { stocksData, scan, manifest, snapshots };
    } finally {
        await fs.rm(stage, { recursive: true, force: true });
    }
}

if (require.main === module) {
    buildSite().catch(error => { console.error(error); process.exitCode = 1; });
}

module.exports = { buildSite, normalizeOption, parseContractSymbol };
