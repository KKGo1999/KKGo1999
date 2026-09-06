const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const core = require('../options/analysisCore.js');
const { buildSite, normalizeOption, parseContractSymbol } = require('./build-options-data.js');
const { PAGE_SIZE } = require('./render-agent-site.js');

const asOf = '2026-09-06T12:00:00.000Z';
const expiryDate = '2026-10-16';
function option(symbol = 'BILI', strike = 15, extra = {}) {
    return { contractSymbol: symbol + '261016P' + String(Math.round(strike * 1000)).padStart(8, '0'),
        optionType: 'put', expiryDate, strike, bid: 1, ask: 1.1, volume: 20,
        openInterest: 100, impliedVolatility: 0.5, ...extra };
}
const snapshot = (symbol = 'BILI', options = [option(symbol)]) => ({
    symbol, quote: { price: 20, sourceTimestamp: '2026-09-04 16:00:01', retrievedAt: asOf },
    optionsData: { options, sourceTimestamp: '2026-09-04 20:00:00', generatedAt: asOf, snapshotId: 'fixture' }
});

test('candidate yield, spread, and currency agree with hand calculation', () => {
    const scan = core.scanSnapshots([snapshot()], core.DEFAULTS, { asOf });
    const candidate = scan.candidates[0];
    assert.ok(candidate);
    assert.equal(candidate.daysToExpiry, 40);
    assert.equal(candidate.premiumDollars, 99);
    assert.equal(candidate.collateral, 1500);
    assert.ok(Math.abs(candidate.annualReturn - 60.225) < 1e-10);
    assert.equal(candidate.strikePct, -25);
    assert.ok(Math.abs(candidate.spreadPct - 9.523809523809524) < 1e-10);
    assert.equal(candidate.breakEven, 14.01);
    assert.equal(scan.assumptions.contractMultiplier, 100);
    const call = core.buildCandidate('BILI', 20, option('BILI', 15, {
        optionType: 'call', contractSymbol: 'BILI261016C00015000'
    }), { ...core.DEFAULTS, strategyType: 'call' }, asOf);
    assert.equal(call.collateral, 2000);
    assert.equal(call.breakEven, 19.01);
    assert.ok(Math.abs(call.annualReturn - 45.16875) < 1e-10);
});

test('filter boundaries, missing quotes, adjusted contracts, expired contracts', () => {
    const settings = { ...core.DEFAULTS, minAnnualReturn: 0 };
    const candidate = extra => core.buildCandidate('BILI', 20, option('BILI', 15, extra), settings, asOf);
    for (const extra of [{ bid: null }, { ask: null }, { openInterest: null }, { ask: 0.5 },
        { bid: 0 }, { contractSymbol: 'BILI1261016P00015000' }, { expiryDate: '2026-09-06' },
        { expiryDate: '2026-02-30' }]) assert.equal(candidate(extra), null);
    assert.equal(candidate({ volume: null }).volume, null);
    assert.ok(Number.isFinite(candidate({ volume: null }).localScore));
    assert.equal(candidate({ strike: 17 }).strikePct, -15.000000000000002);
    assert.ok(candidate({ strike: 8 }));
    assert.equal(candidate({ strike: 17.01 }), null);
    assert.equal(candidate({ strike: 7.99 }), null);
    assert.equal(core.numberOrNull(''), null);
    assert.equal(core.numberOrNull('  '), null);
    assert.equal(core.numberOrNull([]), null);
    assert.equal(core.numberOrNull(null), null);
    assert.equal(core.numberOrNull(0), 0);
});

test('one date basis is used around UTC midnight and DST', () => {
    assert.equal(core.marketDate('2026-09-07T01:00:00Z'), '2026-09-06');
    assert.equal(core.daysToExpiry('2026-03-09', '2026-03-07T17:00:00Z'), 2);
    assert.equal(core.daysToExpiry('2026-11-02', '2026-10-31T17:00:00Z'), 2);
});

test('per-stock cap follows score, deterministic ties, failures and empty results remain exportable', () => {
    const options = [14, 15, 16, 17].map(strike => option('BILI', strike));
    const scan = core.scanSnapshots([snapshot('BILI', options), snapshot('SOFI'), { symbol: 'AMD', error: 'offline' }],
        { ...core.DEFAULTS, apiKey: 'must-not-export', rememberKey: true, perSymbolLimit: 2.9 }, { asOf });
    assert.equal(scan.filters.perSymbolLimit, 2);
    assert.equal(scan.candidates.filter(row => row.symbol === 'BILI').length, 2);
    assert.equal(scan.counts.matchedBeforeSymbolLimit, 5);
    assert.equal(scan.counts.excludedBySymbolLimit, 2);
    assert.equal(scan.status, 'partial');
    assert.equal(scan.perSymbol.find(row => row.symbol === 'AMD').status, 'unavailable');
    assert.equal(JSON.stringify(core.exportScan({ ...scan, apiKey: 'must-not-export' })).includes('must-not-export'), false);
    assert.deepEqual(core.exportScan(scan).shortlistIds, scan.shortlist.map(row => row.id));
    assert.equal(Object.hasOwn(core.exportScan(scan), 'shortlist'), false);
    const reverse = core.scanSnapshots([snapshot('SOFI'), snapshot('BILI', options.slice().reverse())],
        { ...core.DEFAULTS, perSymbolLimit: 2 }, { asOf });
    assert.deepEqual(scan.candidates, reverse.candidates);
    const empty = core.scanSnapshots([snapshot()], { ...core.DEFAULTS, minBid: 99 }, { asOf });
    assert.equal(empty.status, 'complete');
    assert.equal(core.exportScan(empty).candidates.length, 0);
});

test('browser and Node run the same engine against the same snapshot', async () => {
    const context = vm.createContext({});
    vm.runInContext(await fs.readFile(path.join(__dirname, '../options/analysisCore.js'), 'utf8'), context);
    const snapshots = [snapshot(), snapshot('SOFI')];
    const nodeResult = core.scanSnapshots(snapshots, core.DEFAULTS, { asOf, snapshotId: 'same' });
    const browserResult = context.OptionsAnalysis.scanSnapshots(snapshots, core.DEFAULTS, { asOf, snapshotId: 'same' });
    assert.equal(JSON.stringify(browserResult), JSON.stringify(nodeResult));
});

test('normalization preserves missing fields and rejects impossible expiry dates', () => {
    assert.equal(parseContractSymbol('BILI260230P00015000'), null);
    assert.equal(parseContractSymbol('untrusted/path'), null);
    const raw = normalizeOption({ option: 'BILI261016P00015000', bid: 0, ask: '' }, 'BILI');
    assert.equal(raw.bid, 0);
    assert.equal(raw.ask, null);
    assert.equal(raw.impliedVolatility, null);
    assert.equal(raw.contractMultiplier, 100);
    assert.equal(normalizeOption({ option: 'BILI1261016P00015000' }, 'BILI').contractMultiplier, null);
});

test('build publishes static HTML, complete pagination, identical snapshot IDs and partial failures', async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'options-agent-test-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const rawOptions = Array.from({ length: PAGE_SIZE + 1 }, (_, i) => ({
        option: option('BILI', 10 + i / 100).contractSymbol,
        bid: 1, ask: 1.1, open_interest: 100, volume: 20
    }));
    const result = await buildSite({
        root, asOf, symbols: ['BILI', 'SOFI', 'AAPL'],
        loadOptions: async symbol => {
            if (symbol !== 'BILI') throw new Error('<unavailable>');
            return { timestamp: '2026-09-04 20:00:00', data: { options: rawOptions } };
        },
        loadQuote: async () => ({ price: 20, changePct: 1, sourceTimestamp: '2026-09-04 16:00:01', retrievedAt: asOf }),
        loadYtd: async () => ({ percent: 10, basePrice: 18.18, baseDate: '2026-01-02' })
    });
    const read = name => fs.readFile(path.join(root, 'options', name), 'utf8');
    const stocks = JSON.parse(await read('data/stocks.json'));
    const candidates = JSON.parse(await read('data/candidates.json'));
    const full = JSON.parse(await read('data/options/BILI.json'));
    const html = await read('agent/index.html');
    assert.equal(stocks.snapshotId, full.snapshotId);
    assert.equal(stocks.snapshotId, candidates.snapshotId);
    assert.equal(stocks.stocks.length, 3);
    assert.equal(stocks.stocks.find(row => row.symbol === 'AAPL').inWatchlist, false);
    assert.deepEqual(candidates.symbols, ['BILI', 'SOFI']);
    assert.equal(candidates.status, 'partial');
    assert.ok(html.includes('&lt;unavailable&gt;'));
    assert.ok(!html.includes('<script'));
    assert.ok(html.includes(result.manifest.snapshotId));
    const pages = stocks.stocks[0].expirations[0].pages;
    assert.equal(pages.length, 2);
    const collected = [];
    for (const page of pages) {
        const part = JSON.parse(await fs.readFile(path.join(root, page.jsonUrl), 'utf8'));
        assert.equal(part.snapshotId, stocks.snapshotId);
        assert.ok(part.options.length <= PAGE_SIZE);
        collected.push(...part.options.map(row => row.contractSymbol));
        const pageHtml = await fs.readFile(path.join(root, page.htmlUrl), 'utf8');
        assert.ok(pageHtml.includes('BILI'));
        assert.ok(pageHtml.includes('本页 JSON'));
    }
    assert.deepEqual(collected, full.options.map(row => row.contractSymbol));
    const recalculated = core.scanSnapshots(result.snapshots.filter(row => core.WATCHLIST.includes(row.symbol)),
        candidates.filters, { asOf: candidates.generatedAt, snapshotId: candidates.snapshotId, scope: candidates.scope });
    assert.deepEqual(recalculated.candidates, candidates.candidates);
    const before = await read('data/stocks.json');
    await assert.rejects(buildSite({
        root, asOf, symbols: ['BILI'], loadOptions: async () => { throw new Error('offline'); },
        loadQuote: async () => null, loadYtd: async () => null
    }), /No options available/);
    assert.equal(await read('data/stocks.json'), before);
});
