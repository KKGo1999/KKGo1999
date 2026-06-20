class APIService {
    constructor() {
        // 免费数据源配置：
        // 1) 腾讯财经公开行情接口：用于股票报价，响应带 CORS 头，浏览器可直接 fetch。
        // 2) GitHub Pages 同源静态缓存：部署时从 Cboe 延迟行情生成期权链 JSON，
        //    避免浏览器直连第三方期权接口时被 CORS 或代理稳定性影响。
        this.tencentQuoteUrl = 'https://qt.gtimg.cn/q=';
        this.tencentKlineUrl = 'https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=';
        this.optionsDataBaseUrl = 'data/options';
        this.dataSource = 'tencent-cboe-cache';
        this.debug = true;
        this.pageCache = new Map();
        this.cacheTtlMs = 2 * 60 * 1000;
        this.tencentKlineSuffixMap = {
            BILI: 'OQ',
            GOOG: 'OQ',
            LMND: 'N',
            PDD: 'OQ',
            RKLB: 'OQ',
            TEM: 'OQ',
            CRCL: 'N',
            DUOL: 'OQ',
            TSLA: 'OQ',
            OSCR: 'N',
            HIMS: 'N',
            HOOD: 'OQ',
            CRWV: 'OQ',
            SOFI: 'OQ',
            AMD: 'OQ'
        };
    }

    getDataSourceName() {
        return '腾讯财经行情 + Cboe 延迟期权数据';
    }

    logDebug(message, data = null) {
        if (!this.debug) return;
        if (data) {
            console.log(`[DEBUG] ${message}`, data);
        } else {
            console.log(`[DEBUG] ${message}`);
        }
    }

    logError(message, error = null) {
        if (error) {
            console.error(`[ERROR] ${message}`, error);
        } else {
            console.error(`[ERROR] ${message}`);
        }
    }

    normalizeSymbol(symbol) {
        return String(symbol || '').trim().toUpperCase();
    }

    async fetchText(url) {
        const cached = this.pageCache.get(url);
        if (cached && Date.now() - cached.timestamp < this.cacheTtlMs) {
            return cached.text;
        }

        this.logDebug(`请求URL: ${url}`);
        const response = await fetch(url, { headers: { 'Accept': 'text/plain,*/*' } });
        if (!response.ok) {
            throw new Error(`HTTP错误: ${response.status}`);
        }

        const text = await response.text();
        this.pageCache.set(url, { text, timestamp: Date.now() });
        return text;
    }

    async fetchJson(url) {
        const cached = this.pageCache.get(url);
        if (cached && Date.now() - cached.timestamp < this.cacheTtlMs) {
            return cached.json;
        }

        this.logDebug(`请求URL: ${url}`);
        const response = await fetch(url, { headers: { 'Accept': 'application/json,*/*' } });
        if (!response.ok) {
            throw new Error(`HTTP错误: ${response.status}`);
        }

        const json = await response.json();
        this.pageCache.set(url, { json, timestamp: Date.now() });
        return json;
    }

    async getTencentQuote(symbol) {
        const normalizedSymbol = this.normalizeSymbol(symbol);
        const url = `${this.tencentQuoteUrl}us${encodeURIComponent(normalizedSymbol)}`;
        const text = await this.fetchText(url);
        const match = text.match(/="([^"]*)"/);
        if (!match) {
            throw new Error(`腾讯财经未返回${normalizedSymbol}行情`);
        }

        const fields = match[1].split('~');
        const price = Number(fields[3]);
        const previousClose = Number(fields[4]);
        const change = Number(fields[31] || (price - previousClose));
        const changePct = Number(fields[32] || (previousClose ? (change / previousClose) * 100 : 0));

        if (!Number.isFinite(price) || price <= 0) {
            throw new Error(`无法解析${normalizedSymbol}的腾讯财经行情`);
        }
        return { price, change, changePct };
    }

    formatDate(date) {
        const year = date.getFullYear();
        const month = String(date.getMonth() + 1).padStart(2, '0');
        const day = String(date.getDate()).padStart(2, '0');
        return `${year}-${month}-${day}`;
    }

    getTencentKlineCodes(symbol) {
        const normalizedSymbol = this.normalizeSymbol(symbol);
        const preferredSuffix = this.tencentKlineSuffixMap[normalizedSymbol];
        const suffixes = [preferredSuffix, 'OQ', 'N', 'A', 'P', '']
            .filter((suffix, index, arr) => suffix !== undefined && arr.indexOf(suffix) === index);

        return suffixes.map(suffix => `us${normalizedSymbol}${suffix ? `.${suffix}` : ''}`);
    }

    getTencentKlineRows(data, code) {
        const rows = data?.data?.[code]?.day;
        if (!Array.isArray(rows)) {
            return [];
        }

        return rows.filter(row => {
            const close = Number(row?.[2]);
            return Array.isArray(row) && row[0] && Number.isFinite(close) && close > 0;
        });
    }

    async getYearStartClose(symbol, year = new Date().getFullYear()) {
        const normalizedSymbol = this.normalizeSymbol(symbol);
        const startDate = `${year}-01-01`;
        const endDate = this.formatDate(new Date());
        let bestCandidate = null;

        for (const code of this.getTencentKlineCodes(normalizedSymbol)) {
            try {
                const url = `${this.tencentKlineUrl}${code},day,${startDate},${endDate},260,qfq`;
                const data = await this.fetchJson(url);
                const rows = this.getTencentKlineRows(data, code);
                if (rows.length === 0) {
                    continue;
                }

                const firstRow = rows[0];
                const candidate = {
                    price: Number(firstRow[2]),
                    date: firstRow[0],
                    code,
                    rowCount: rows.length
                };

                if (!bestCandidate || candidate.rowCount > bestCandidate.rowCount) {
                    bestCandidate = candidate;
                }

                if (candidate.rowCount > 5 && candidate.date.startsWith(`${year}-01`)) {
                    return candidate;
                }
            } catch (error) {
                this.logDebug(`${normalizedSymbol}年初K线候选${code}不可用: ${error.message}`);
            }
        }

        if (bestCandidate) {
            return bestCandidate;
        }

        throw new Error(`${normalizedSymbol}没有可用年初K线`);
    }

    async getYearToDateChange(symbol, currentPrice) {
        const normalizedSymbol = this.normalizeSymbol(symbol);
        const price = Number(currentPrice);
        if (!Number.isFinite(price) || price <= 0) {
            throw new Error(`${normalizedSymbol}当前价格无效`);
        }

        const yearStart = await this.getYearStartClose(normalizedSymbol);
        return {
            percent: ((price - yearStart.price) / yearStart.price) * 100,
            basePrice: yearStart.price,
            baseDate: yearStart.date,
            code: yearStart.code
        };
    }

    getOptionsDataUrl(symbol) {
        return `${this.optionsDataBaseUrl}/${encodeURIComponent(symbol)}.json`;
    }

    async getOptionsData(symbol) {
        const normalizedSymbol = this.normalizeSymbol(symbol);
        const data = await this.fetchJson(this.getOptionsDataUrl(normalizedSymbol));
        const options = data?.options;

        if (!Array.isArray(options) || options.length === 0) {
            throw new Error(`${normalizedSymbol}没有可用的本地期权缓存`);
        }

        return data;
    }

    isFutureOrToday(date) {
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const expiry = new Date(`${date}T00:00:00`);
        return !Number.isNaN(expiry.getTime()) && expiry >= today;
    }

    async getStockPrice(symbol) {
        const normalizedSymbol = this.normalizeSymbol(symbol);
        if (!normalizedSymbol) {
            throw new Error('股票代码不能为空');
        }

        try {
            return await this.getTencentQuote(normalizedSymbol);
        } catch (error) {
            this.logError(`获取${normalizedSymbol}股票价格失败`, error);
            throw error;
        }
    }

    async getOptionsExpiryDates(symbol) {
        const normalizedSymbol = this.normalizeSymbol(symbol);
        if (!normalizedSymbol) {
            throw new Error('股票代码不能为空');
        }

        try {
            const data = await this.getOptionsData(normalizedSymbol);
            const dates = [...new Set(data.options.map(option => option.expiryDate))]
                .filter(Boolean)
                .filter(date => this.isFutureOrToday(date))
                .sort();

            if (dates.length === 0) {
                throw new Error(`${normalizedSymbol}没有可用期权到期日`);
            }

            this.logDebug(`从Cboe本地缓存获取了${dates.length}个到期日`);
            return dates;
        } catch (error) {
            this.logError(`获取${normalizedSymbol}期权到期日失败`, error);
            throw error;
        }
    }

    async getOptionsChain(symbol, expiryDate, optionType) {
        const normalizedSymbol = this.normalizeSymbol(symbol);
        if (!normalizedSymbol) {
            throw new Error('股票代码不能为空');
        }
        if (!expiryDate) {
            throw new Error('期权到期日不能为空');
        }

        try {
            const data = await this.getOptionsData(normalizedSymbol);
            const optionsChain = data.options
                .filter(option => option.expiryDate === expiryDate && option.optionType === optionType)
                .sort((a, b) => a.strike - b.strike);

            if (optionsChain.length === 0) {
                throw new Error(`无法找到${normalizedSymbol}在${expiryDate}到期的${optionType}期权`);
            }

            this.logDebug(`成功读取了${optionsChain.length}个Cboe延迟期权合约`);
            return optionsChain;
        } catch (error) {
            this.logError(`获取${normalizedSymbol}期权链失败`, error);
            throw error;
        }
    }

    // 兼容旧版 UI：免费数据源不需要 API Key。
    setApiKey() {
        return false;
    }

    getApiKey() {
        return null;
    }
}

// 导出API服务实例
const apiService = new APIService();

// 在控制台公开API服务，方便调试
window.apiService = apiService;
