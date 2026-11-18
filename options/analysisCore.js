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
    const SCHEMA_VERSION = '1.1.0';
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

    function optionMetrics(symbol, stockPrice, option, asOf, analysisDate) {
        const days = daysToExpiry(option.expiryDate, asOf, analysisDate);
        const strike = numberOrNull(option.strike);
        const bid = numberOrNull(option.bid);
        const root = String(option.contractSymbol || '').match(/^(.+?)\d{6}[CP]\d{8}$/)?.[1];
        if (root !== symbol || (option.contractMultiplier != null && option.contractMultiplier !== 100)) return null;
        if (!['put', 'call'].includes(option.optionType) || days === null || days <= 0 ||
            !Number.isFinite(stockPrice) || stockPrice <= 0 || strike === null || strike <= 0 ||
            bid === null || bid <= ASSUMPTIONS.feePerShare) return null;
        const netPremium = bid - ASSUMPTIONS.feePerShare;
        const collateral = (option.optionType === 'put' ? strike : stockPrice) * ASSUMPTIONS.contractMultiplier;
        const premiumDollars = netPremium * ASSUMPTIONS.contractMultiplier;
        const breakEven = (option.optionType === 'put' ? strike : stockPrice) - netPremium;
        const metrics = {
            daysToExpiry: days, strike, bid, stockPrice,
            strikePct: (strike / stockPrice - 1) * 100,
            premiumDollars, collateral, breakEven,
            annualReturn: (premiumDollars / collateral) * (365 / days) * 100,
            downsideProtectionPct: option.optionType === 'put'
                ? ((stockPrice - breakEven) / stockPrice) * 100 : (netPremium / stockPrice) * 100
        };
        return Object.values(metrics).every(Number.isFinite) ? metrics : null;
    }

    function buildCandidate(symbol, stockPrice, option, settings, asOf, analysisDate) {
        const metrics = optionMetrics(symbol, stockPrice, option, asOf, analysisDate);
        if (!metrics || metrics.daysToExpiry < settings.minDays || metrics.daysToExpiry > settings.maxDays) return null;
        if (settings.strategyType !== 'both' && option.optionType !== settings.strategyType) return null;
        const ask = numberOrNull(option.ask);
        const openInterest = numberOrNull(option.openInterest);
        const rawVolume = numberOrNull(option.volume);
        const volume = rawVolume !== null && rawVolume >= 0 ? rawVolume : null;
        if (metrics.bid < settings.minBid || ask === null || ask < metrics.bid ||
            openInterest === null || openInterest < settings.minOpenInterest) return null;
        const spreadPct = (ask - metrics.bid) / ((ask + metrics.bid) / 2) * 100;
        if (spreadPct > settings.maxSpreadPct || metrics.strikePct < settings.minStrikePct ||
            metrics.strikePct > settings.maxStrikePct || metrics.annualReturn < settings.minAnnualReturn) return null;
        const candidate = {
            ...metrics,
            id: symbol + '-' + option.optionType + '-' + option.expiryDate + '-' + metrics.strike.toFixed(2).replace('.', '_'),
            symbol, optionType: option.optionType,
            strategy: option.optionType === 'call' ? '备兑卖 Call' : '现金担保卖 Put',
            contractSymbol: option.contractSymbol, expiryDate: option.expiryDate,
            ask, spreadPct, openInterest, volume,
            impliedVolatility: numberOrNull(option.impliedVolatility), currency: 'USD',
            contractMultiplier: 100, multiplierStatus: ASSUMPTIONS.multiplierStatus,
            lastTradeDate: option.lastTradeDate || null
        };
        candidate.localScore = calculateLocalScore(candidate, settings.riskProfile);
        return candidate;
    }

    function assessDataQuality(sources, asOf = new Date().toISOString()) {
        const issues = [];
        const maxAgeHours = 96;
        const now = new Date(asOf).getTime();
        const ids = new Set(sources.map(source => source.optionsSnapshotId).filter(Boolean));
        if (ids.size > 1) issues.push('期权数据来自不同快照，请刷新后复核。');
        const today = marketDate(asOf);
        for (const source of sources) {
            if (source.optionsMode === 'cached-preview') issues.push(source.symbol + ' 行情刷新失败，正在使用旧快照。');
            for (const [label, value] of [['期权缓存', source.optionsGeneratedAt], ['股价抓取', source.stockRetrievedAt]]) {
                const explicitZone = typeof value === 'string' && /(?:Z|[+-]\d{2}:\d{2})$/.test(value);
                const age = explicitZone ? (now - new Date(value).getTime()) / 3600000 : NaN;
                if (!Number.isFinite(age)) issues.push(source.symbol + ' ' + label + '时间不明。');
                else if (age > maxAgeHours || age < -1) issues.push(source.symbol + ' ' + label + '时间过旧或异常。');
            }
            // Upstream timezone is unknown: compare calendar dates, never invent an offset.
            for (const value of [source.stockSourceTimestamp, source.optionsSourceTimestamp]) {
                const date = typeof value === 'string' ? value.slice(0, 10) : '';
                const days = daysToExpiry(date, asOf, today);
                if (days === null) issues.push(source.symbol + ' 源站行情时间不明。');
                else if (days < -4 || days > 1) issues.push(source.symbol + ' 源站行情日期过旧或异常。');
            }
        }
        return { status: issues.length ? 'warning' : 'ok', requiresConfirmation: issues.length > 0,
            maxAgeHours, sourceTimeZone: null, issues: [...new Set(issues)] };
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
                optionsMode: optionsData?.mode || null,
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
            errors, sources, perSymbol, dataQuality: assessDataQuality(sources, asOf),
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
            'symbols', 'status', 'errors', 'sources', 'perSymbol', 'counts', 'sort', 'candidates', 'dataQuality'];
        const result = Object.fromEntries(keys.map(key => [key, scan[key]]));
        result.filters = normalizeSettings(scan.filters);
        result.shortlistIds = scan.shortlist.map(candidate => candidate.id);
        return result;
    }

    return Object.freeze({ WATCHLIST, SUPPORTED_SYMBOLS, SCHEMA_VERSION, SCORE_VERSION, DEFAULTS,
        ASSUMPTIONS, numberOrNull, normalizeSettings, marketDate, daysToExpiry, calculateLocalScore,
        optionMetrics, buildCandidate, scanSnapshots, exportScan, assessDataQuality });
});
