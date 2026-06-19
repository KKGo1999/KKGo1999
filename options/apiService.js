class APIService {
    constructor() {
        // 免费数据源配置：
        // 1) 腾讯财经公开行情接口：用于股票报价，响应带 CORS 头，浏览器可直接 fetch。
        // 2) Jina Reader + Yahoo Finance 页面：用于读取 Yahoo 期权链页面的 Markdown 表格，
        //    避免浏览器直连 Yahoo Finance API 时被 CORS 拦截。
        this.tencentQuoteUrl = 'https://qt.gtimg.cn/q=';
        this.jinaReaderUrl = 'https://r.jina.ai/http://finance.yahoo.com/quote';
        this.dataSource = 'tencent-jina-yahoo';
        this.debug = true;
        this.pageCache = new Map();
        this.cacheTtlMs = 2 * 60 * 1000;
    }

    getDataSourceName() {
        return '腾讯财经行情 + Yahoo Finance 页面数据';
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

    getYahooOptionsPageUrl(symbol) {
        return `${this.jinaReaderUrl}/${encodeURIComponent(symbol)}/options/`;
    }

    async getYahooOptionsPage(symbol) {
        const normalizedSymbol = this.normalizeSymbol(symbol);
        const text = await this.fetchText(this.getYahooOptionsPageUrl(normalizedSymbol));
        if (/Oops, something went wrong/i.test(text) || !text.includes('| Contract Name |')) {
            throw new Error(`Yahoo Finance 暂无${normalizedSymbol}可解析的期权链页面`);
        }
        return text;
    }

    parseContractExpiry(contractSymbol, underlyingSymbol) {
        const normalizedUnderlying = this.normalizeSymbol(underlyingSymbol).replace(/[^A-Z0-9.]/g, '');
        const regex = new RegExp(`^${normalizedUnderlying.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\d{2})(\\d{2})(\\d{2})[CP]`, 'i');
        const match = String(contractSymbol || '').match(regex);
        if (!match) return null;

        const year = 2000 + Number(match[1]);
        const month = Number(match[2]);
        const day = Number(match[3]);
        if (!year || month < 1 || month > 12 || day < 1 || day > 31) return null;

        return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    }

    parseNumber(value) {
        const cleaned = String(value || '')
            .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
            .replace(/[%,$,]/g, '')
            .replace(/—|N\/A/g, '')
            .trim();
        const number = Number(cleaned);
        return Number.isFinite(number) ? number : 0;
    }

    parseMarkdownTableRows(text) {
        return text
            .split('\n')
            .filter(line => line.startsWith('| [') && line.includes('finance.yahoo.com/quote/'))
            .map(line => line.split('|').slice(1, -1).map(cell => cell.trim()));
    }

    parseContractSymbol(cell) {
        const match = cell.match(/\[([^\]]+)\]/);
        return match ? match[1].trim() : '';
    }

    parseOptionRows(text, symbol) {
        return this.parseMarkdownTableRows(text).map(cells => {
            const contractSymbol = this.parseContractSymbol(cells[0]);
            const typeMatch = contractSymbol.match(/[0-9]{6}([CP])/i);
            const optionType = typeMatch?.[1]?.toUpperCase() === 'C' ? 'call' : 'put';
            const impliedVolatility = this.parseNumber(cells[10]) / 100;

            return {
                contractSymbol,
                optionType,
                expiryDate: this.parseContractExpiry(contractSymbol, symbol),
                lastTradeDate: cells[1] || null,
                strike: this.parseNumber(cells[2]),
                lastPrice: this.parseNumber(cells[3]),
                bid: this.parseNumber(cells[4]),
                ask: this.parseNumber(cells[5]),
                change: this.parseNumber(cells[6]),
                volume: this.parseNumber(cells[8]),
                openInterest: this.parseNumber(cells[9]),
                impliedVolatility,
                delta: 0,
                gamma: 0,
                theta: 0,
                vega: 0,
                currency: 'USD'
            };
        }).filter(option => option.contractSymbol && option.expiryDate && option.strike > 0);
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
            const page = await this.getYahooOptionsPage(normalizedSymbol);
            const dates = [...new Set(this.parseOptionRows(page, normalizedSymbol).map(option => option.expiryDate))]
                .filter(Boolean)
                .sort();

            if (dates.length === 0) {
                throw new Error(`${normalizedSymbol}没有可解析的期权到期日`);
            }

            this.logDebug(`从免费页面数据源获取了${dates.length}个到期日`);
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
            const page = await this.getYahooOptionsPage(normalizedSymbol);
            const optionsChain = this.parseOptionRows(page, normalizedSymbol)
                .filter(option => option.expiryDate === expiryDate && option.optionType === optionType)
                .sort((a, b) => a.strike - b.strike);

            if (optionsChain.length === 0) {
                throw new Error(`无法找到${normalizedSymbol}在${expiryDate}到期的${optionType}期权`);
            }

            this.logDebug(`成功解析了${optionsChain.length}个免费期权合约`);
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
