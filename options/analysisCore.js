(function(root, factory) {
    const core = factory();
    if (typeof module === 'object' && module.exports) module.exports = core;
    else root.OptionsAnalysis = core;
})(typeof globalThis !== 'undefined' ? globalThis : this, function() {
    'use strict';

    const WATCHLIST = Object.freeze([
        'BILI', 'GOOG', 'LMND', 'PDD', 'RKLB', 'SPCX', 'TEM', 'CRCL',
        'DUOL', 'TSLA', 'TSLL', 'OSCR', 'HIMS', 'HOOD', 'CRWV', 'SOFI', 'AMD'
    ]);
    const SUPPORTED_SYMBOLS = Object.freeze([...new Set([...WATCHLIST, 'AAPL', 'NVDA'])].sort());
    const SCHEMA_VERSION = '1.0.0';
    const SCORE_VERSION = '2.0.0';
    const DEFAULTS = Object.freeze({
        strategyType: 'put', riskProfile: 'balanced', minDays: 30, maxDays: 200,
        minBid: 1, minAnnualReturn: 20, minStrikePct: -60, maxStrikePct: -15,
        minOpenInterest: 1, maxSpreadPct: 45, candidateLimit: 40, perSymbolLimit: 3
    });
    const ASSUMPTIONS = Object.freeze({
        currency: 'USD',
        priceUnit: 'USD per underlying share',
        percentageUnit: 'percentage points: 20 means 20%',
        impliedVolatilityUnit: 'fraction: 0.5 means 50%',
        feePerShare: 0.01,
        contractMultiplier: 100,
        multiplierStatus: 'assumed standard contract; adjusted contracts excluded',
        annualization: 'simple premium yield, 365 calendar days; not total return',
        calendarTimeZone: 'America/New_York',
        sourceTimeZone: null,
        scoreVersion: SCORE_VERSION,
        scoreMeaning: 'ranking heuristic, not probability or expected profit'
    });

    function numberOrNull(value) {
        if (!['number', 'string'].includes(typeof value)) return null;
        if (typeof value === 'string' && value.trim() === '') return null;
        const number = Number(value);
        return Number.isFinite(number) ? number : null;
    }

    function normalizeSettings(input = {}) {
        const result = {};
        for (const [key, fallback] of Object.entries(DEFAULTS)) {
            result[key] = typeof fallback === 'number' ? (numberOrNull(input[key]) ?? fallback) : input[key] || fallback;
        }
        const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
        result.strategyType = ['put', 'call', 'both'].includes(result.strategyType) ? result.strategyType : 'put';
        result.riskProfile = ['balanced', 'conservative', 'aggressive'].includes(result.riskProfile) ? result.riskProfile : 'balanced';
        result.minDays = Math.trunc(clamp(result.minDays, 1, 730));
        result.maxDays = Math.trunc(clamp(result.maxDays, result.minDays, 730));
        const bounds = [result.minStrikePct, result.maxStrikePct].map(value => clamp(value, -100, 300)).sort((a, b) => a - b);
        [result.minStrikePct, result.maxStrikePct] = bounds;
        for (const key of ['minBid', 'minAnnualReturn', 'minOpenInterest']) result[key] = Math.max(0, result[key]);
        result.maxSpreadPct = clamp(result.maxSpreadPct, 1, 300);
        result.candidateLimit = Math.trunc(clamp(result.candidateLimit, 10, 120));
        result.perSymbolLimit = Math.trunc(clamp(result.perSymbolLimit, 1, 20));
        return result;
    }

    function marketDate(asOf) {
        const date = new Date(asOf);
        if (Number.isNaN(date.getTime())) throw new Error('Invalid analysis time');
        const parts = new Intl.DateTimeFormat('en-US', {
            timeZone: ASSUMPTIONS.calendarTimeZone, year: 'numeric', month: '2-digit', day: '2-digit'
        }).formatToParts(date);
        const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
        return values.year + '-' + values.month + '-' + values.day;
    }

    function daysToExpiry(expiryDate, asOf, analysisDate = marketDate(asOf)) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(expiryDate || '')) return null;
        const expiry = new Date(expiryDate + 'T00:00:00Z');
        if (!Number.isFinite(expiry.getTime()) || expiry.toISOString().slice(0, 10) !== expiryDate) return null;
        return Math.round((expiry - new Date(analysisDate + 'T00:00:00Z')) / 86400000);
    }

    function calculateLocalScore(candidate, riskProfile) {
        const liquidityScore = Math.log10(candidate.openInterest + 1) * 1.8 + Math.log10((candidate.volume ?? 0) + 1) * 0.9;
        const spreadPenalty = candidate.spreadPct * 0.08;
        const shortDatedPenalty = candidate.daysToExpiry < 21 ? 1.8 : 0;
        const longDatedPenalty = candidate.daysToExpiry > 75 ? 0.8 : 0;
        const moneynessPenalty = candidate.optionType === 'put'
            ? Math.max(0, candidate.strikePct) * 1.7 : Math.max(0, -candidate.strikePct) * 1.7;
        if (riskProfile === 'conservative') {
            return candidate.annualReturn * 0.72 + candidate.downsideProtectionPct * 1.15 + liquidityScore
                - spreadPenalty * 1.35 - moneynessPenalty * 1.8 - shortDatedPenalty - longDatedPenalty;
        }
        if (riskProfile === 'aggressive') {
            return candidate.annualReturn * 1.12 + candidate.downsideProtectionPct * 0.35 + liquidityScore * 0.7
                - spreadPenalty * 0.65 - moneynessPenalty - longDatedPenalty;
        }
        return candidate.annualReturn * 0.92 + candidate.downsideProtectionPct * 0.7 + liquidityScore
            - spreadPenalty - moneynessPenalty * 1.25 - shortDatedPenalty * 0.6 - longDatedPenalty;
    }

    function buildCandidate(symbol, stockPrice, option, settings, asOf, analysisDate) {
        const days = daysToExpiry(option.expiryDate, asOf, analysisDate);
        if (days === null || days < settings.minDays || days > settings.maxDays || days <= 0) return null;
        const optionType = option.optionType;
        if (!['put', 'call'].includes(optionType)) return null;
        if (settings.strategyType !== 'both' && optionType !== settings.strategyType) return null;
        const strike = numberOrNull(option.strike);
        const bid = numberOrNull(option.bid);
        const ask = numberOrNull(option.ask);
        const openInterest = numberOrNull(option.openInterest);
        const rawVolume = numberOrNull(option.volume);
        const volume = rawVolume !== null && rawVolume >= 0 ? rawVolume : null;
        if (stockPrice === null || !Number.isFinite(stockPrice) || stockPrice <= 0) return null;
        if (strike === null || strike <= 0 || bid === null || bid < settings.minBid || bid <= 0) return null;
        if (ask === null || ask <= 0 || ask < bid || openInterest === null || openInterest < settings.minOpenInterest) return null;
        // A changed OCC root may indicate a nonstandard deliverable; do not assume 100 shares for it.
        const root = String(option.contractSymbol || '').match(/^(.+?)\d{6}[CP]\d{8}$/)?.[1];
        if (root !== symbol || (option.contractMultiplier != null && option.contractMultiplier !== 100)) return null;
        const mid = (bid + ask) / 2;
        const spreadPct = ((ask - bid) / mid) * 100;
        if (spreadPct > settings.maxSpreadPct) return null;
        const strikePct = (strike / stockPrice - 1) * 100;
        if (strikePct < settings.minStrikePct || strikePct > settings.maxStrikePct) return null;
        const netPremium = bid - ASSUMPTIONS.feePerShare;
        if (netPremium <= 0) return null;
        const collateral = (optionType === 'put' ? strike : stockPrice) * ASSUMPTIONS.contractMultiplier;
        const premiumDollars = netPremium * ASSUMPTIONS.contractMultiplier;
        const annualReturn = (premiumDollars / collateral) * (365 / days) * 100;
        if (!Number.isFinite(annualReturn) || annualReturn < settings.minAnnualReturn) return null;
        const breakEven = (optionType === 'put' ? strike : stockPrice) - netPremium;
        const downsideProtectionPct = optionType === 'put'
            ? ((stockPrice - breakEven) / stockPrice) * 100 : (netPremium / stockPrice) * 100;
        const candidate = {
            id: symbol + '-' + optionType + '-' + option.expiryDate + '-' + strike.toFixed(2).replace('.', '_'),
            symbol, optionType, strategy: optionType === 'call' ? '备兑卖 Call' : '现金担保卖 Put',
            contractSymbol: option.contractSymbol, stockPrice, expiryDate: option.expiryDate,
            daysToExpiry: days, strike, strikePct, bid, ask, spreadPct, openInterest, volume,
            impliedVolatility: numberOrNull(option.impliedVolatility), currency: 'USD',
            contractMultiplier: 100, multiplierStatus: ASSUMPTIONS.multiplierStatus,
            premiumDollars, collateral, annualReturn, breakEven, downsideProtectionPct,
            lastTradeDate: option.lastTradeDate || null
        };
        candidate.localScore = calculateLocalScore(candidate, settings.riskProfile);
        return candidate;
    }

    function scanSnapshots(snapshots, inputSettings, metadata = {}) {
        const settings = normalizeSettings(inputSettings);
        const asOf = metadata.asOf || new Date().toISOString();
        const analysisDate = marketDate(asOf);
        const allCandidates = [];
        const errors = [];
        const perSymbol = [];
        const sources = [];
        const compareText = (a, b) => a < b ? -1 : a > b ? 1 : 0;
        for (const snapshot of snapshots) {
            const { symbol, quote, optionsData } = snapshot;
            const options = Array.isArray(optionsData?.options) ? optionsData.options : [];
            const price = numberOrNull(quote?.price);
            const unavailable = price === null || price <= 0 || !Array.isArray(options) || !options.length;
            if (unavailable) errors.push(symbol + ': ' + (snapshot.error || 'Stock quote or options unavailable'));
            let matched = 0;
            if (!unavailable) {
                for (const option of options) {
                    const candidate = buildCandidate(symbol, price, option, settings, asOf, analysisDate);
                    if (candidate) { allCandidates.push(candidate); matched += 1; }
                }
            }
            perSymbol.push({ symbol, status: unavailable ? 'unavailable' : 'available', optionCount: options.length,
                matchedBeforeSymbolLimit: matched, retained: 0 });
            sources.push({
                symbol, stockPrice: price,
                stockSource: quote?.source || null, stockSourceUrl: quote?.sourceUrl || null,
                stockSourceTimestamp: quote?.sourceTimestamp || null, stockRetrievedAt: quote?.retrievedAt || null,
                optionsSource: optionsData?.source || null, optionsSourceUrl: optionsData?.sourceUrl || null,
                optionsSourceTimestamp: optionsData?.sourceTimestamp || null,
                optionsGeneratedAt: optionsData?.generatedAt || null,
                optionsSnapshotId: optionsData?.snapshotId || null,
                sourceTimeZone: null
            });
        }
        allCandidates.sort((a, b) => b.localScore - a.localScore || compareText(a.contractSymbol, b.contractSymbol));
        const counts = new Map();
        const candidates = allCandidates.filter(candidate => {
            const count = counts.get(candidate.symbol) || 0;
            if (count >= settings.perSymbolLimit) return false;
            counts.set(candidate.symbol, count + 1);
            return true;
        });
        perSymbol.forEach(item => { item.retained = counts.get(item.symbol) || 0; });
        return {
            schemaVersion: SCHEMA_VERSION,
            snapshotId: metadata.snapshotId || 'browser-' + asOf,
            scope: metadata.scope || 'browser-scan',
            generatedAt: asOf, analysisDate, assumptions: ASSUMPTIONS,
            filters: settings, symbols: snapshots.map(snapshot => snapshot.symbol),
            status: errors.length === snapshots.length ? 'unavailable' : errors.length ? 'partial' : 'complete',
            errors, sources, perSymbol,
            counts: { optionsRead: perSymbol.reduce((sum, item) => sum + item.optionCount, 0),
                matchedBeforeSymbolLimit: allCandidates.length, retained: candidates.length,
                excludedBySymbolLimit: allCandidates.length - candidates.length,
                aiShortlist: Math.min(candidates.length, settings.candidateLimit) },
            sort: { field: 'localScore', direction: 'descending', tieBreak: 'contractSymbol ascending' },
            candidates, shortlist: candidates.slice(0, settings.candidateLimit)
        };
    }

    // Only engine-owned data is serializable here; UI settings can contain API credentials.
    function exportScan(scan) {
        const keys = ['schemaVersion', 'snapshotId', 'scope', 'generatedAt', 'analysisDate', 'assumptions',
            'symbols', 'status', 'errors', 'sources', 'perSymbol', 'counts', 'sort', 'candidates'];
        const result = Object.fromEntries(keys.map(key => [key, scan[key]]));
        result.filters = normalizeSettings(scan.filters);
        result.shortlistIds = scan.shortlist.map(candidate => candidate.id);
        return result;
    }

    return Object.freeze({ WATCHLIST, SUPPORTED_SYMBOLS, SCHEMA_VERSION, SCORE_VERSION, DEFAULTS,
        ASSUMPTIONS, numberOrNull, normalizeSettings, marketDate, daysToExpiry, calculateLocalScore,
        buildCandidate, scanSnapshots, exportScan });
});
