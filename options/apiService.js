class APIService {
    constructor() {
        // 免费数据源配置：优先直接访问 Yahoo Finance 的公开接口；遇到浏览器 CORS 限制时，
        // 自动通过 allorigins.win 的免费转发接口重试。所有请求都不需要 API Key。
        this.yahooOptionsUrl = 'https://query1.finance.yahoo.com/v7/finance/options';
        this.yahooQuoteUrl = 'https://query1.finance.yahoo.com/v7/finance/quote';
        this.corsProxyUrl = 'https://api.allorigins.win/raw?url=';
        this.dataSource = 'yahoo';
        this.debug = true;
    }

    getDataSourceName() {
        return 'Yahoo Finance 免费公开数据';
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

    async fetchJson(url) {
        const urls = [url, `${this.corsProxyUrl}${encodeURIComponent(url)}`];
        let lastError;

        for (const requestUrl of urls) {
            try {
                this.logDebug(`请求URL: ${requestUrl}`);
                const response = await fetch(requestUrl, {
                    headers: { 'Accept': 'application/json' }
                });

                if (!response.ok) {
                    throw new Error(`HTTP错误: ${response.status}`);
                }

                return await response.json();
            } catch (error) {
                lastError = error;
                this.logError('免费数据源请求失败，准备尝试下一个通道', error);
            }
        }

        throw lastError || new Error('免费数据源请求失败');
    }

    getOptionChainResult(data, symbol) {
        const result = data?.optionChain?.result?.[0];
        const error = data?.optionChain?.error;

        if (error) {
            throw new Error(error.description || error.message || `无法获取${symbol}的期权数据`);
        }

        if (!result) {
            throw new Error(`无法获取${symbol}的期权数据`);
        }

        return result;
    }

    async getStockPrice(symbol) {
        const normalizedSymbol = this.normalizeSymbol(symbol);
        if (!normalizedSymbol) {
            throw new Error('股票代码不能为空');
        }

        try {
            const url = `${this.yahooQuoteUrl}?symbols=${encodeURIComponent(normalizedSymbol)}`;
            const data = await this.fetchJson(url);
            const quote = data?.quoteResponse?.result?.[0];

            if (!quote) {
                throw new Error(`无法获取${normalizedSymbol}的股票价格`);
            }

            const price = Number(
                quote.regularMarketPrice ??
                quote.postMarketPrice ??
                quote.preMarketPrice ??
                quote.bid ??
                quote.ask
            );
            const previousClose = Number(quote.regularMarketPreviousClose ?? quote.previousClose ?? 0);
            const change = Number(
                quote.regularMarketChange ??
                (Number.isFinite(price) && previousClose ? price - previousClose : 0)
            );
            const changePct = Number(
                quote.regularMarketChangePercent ??
                (previousClose ? (change / previousClose) * 100 : 0)
            );

            if (!Number.isFinite(price)) {
                throw new Error(`无法解析${normalizedSymbol}的股票价格`);
            }

            return { price, change, changePct };
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
            const url = `${this.yahooOptionsUrl}/${encodeURIComponent(normalizedSymbol)}`;
            const data = await this.fetchJson(url);
            const result = this.getOptionChainResult(data, normalizedSymbol);
            const dates = (result.expirationDates || [])
                .map(timestamp => new Date(timestamp * 1000).toISOString().slice(0, 10))
                .sort();

            if (dates.length === 0) {
                throw new Error(`${normalizedSymbol}没有可用期权到期日`);
            }

            this.logDebug(`从免费数据源获取了${dates.length}个到期日`);
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
            const expirationTimestamp = Math.floor(new Date(`${expiryDate}T00:00:00Z`).getTime() / 1000);
            const url = `${this.yahooOptionsUrl}/${encodeURIComponent(normalizedSymbol)}?date=${expirationTimestamp}`;
            const data = await this.fetchJson(url);
            const result = this.getOptionChainResult(data, normalizedSymbol);
            const chain = result.options?.[0];
            const optionsArray = optionType === 'call' ? chain?.calls : chain?.puts;

            if (!Array.isArray(optionsArray) || optionsArray.length === 0) {
                throw new Error(`无法找到${normalizedSymbol}在${expiryDate}到期的${optionType}期权`);
            }

            const optionsChain = optionsArray.map(option => ({
                strike: Number(option.strike) || 0,
                lastPrice: Number(option.lastPrice) || 0,
                bid: Number(option.bid) || 0,
                ask: Number(option.ask) || 0,
                volume: Number(option.volume) || 0,
                openInterest: Number(option.openInterest) || 0,
                impliedVolatility: Number(option.impliedVolatility) || 0,
                delta: Number(option.delta) || 0,
                gamma: Number(option.gamma) || 0,
                theta: Number(option.theta) || 0,
                vega: Number(option.vega) || 0,
                contractSymbol: option.contractSymbol,
                currency: option.currency,
                inTheMoney: Boolean(option.inTheMoney),
                lastTradeDate: option.lastTradeDate
                    ? new Date(option.lastTradeDate * 1000).toISOString()
                    : null
            }));

            this.logDebug(`成功解析了${optionsChain.length}个免费期权合约`);
            return optionsChain.sort((a, b) => a.strike - b.strike);
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
