class APIService {
    constructor() {
        // Tradier API配置
        this.tradierKey = ''; // Tradier API Key (Bearer Token)
        this.tradierUrl = 'https://api.tradier.com/v1';
        
        // 默认使用 Tradier
        this.dataSource = 'tradier';
        
        // 是否显示调试信息
        this.debug = true;
    }
    
    // 获取当前数据源名称
    getDataSourceName() {
        return 'Tradier';
    }
    
    // 调试日志
    logDebug(message, data = null) {
        if (this.debug) {
            if (data) {
                console.log(`[DEBUG] ${message}`, data);
            } else {
                console.log(`[DEBUG] ${message}`);
            }
        }
    }
    
    // 错误日志
    logError(message, error = null) {
        if (error) {
            console.error(`[ERROR] ${message}`, error);
        } else {
            console.error(`[ERROR] ${message}`);
        }
    }
    
    // 获取股票价格
    async getStockPrice(symbol) {
        try {
            this.logDebug(`正在获取${symbol}的股票价格`);
            return await this._getTradierStockPrice(symbol);
        } catch (error) {
            this.logError(`获取${symbol}股票价格失败`, error);
            throw error;
        }
    }
    
    // 从Tradier获取股票价格
    async _getTradierStockPrice(symbol) {
        try {
            // 构建API请求URL
            const url = `${this.tradierUrl}/markets/quotes?symbols=${symbol}`;
            
            this.logDebug(`请求URL: ${url}`);
            const response = await fetch(url, {
                headers: {
                    'Authorization': `Bearer ${this.tradierKey}`,
                    'Accept': 'application/json'
                }
            });
            
            if (!response.ok) {
                throw new Error(`HTTP错误: ${response.status}`);
            }
            
            const data = await response.json();
            
            if (data && data.quotes && data.quotes.quote) {
                const quote = Array.isArray(data.quotes.quote) ? data.quotes.quote[0] : data.quotes.quote;
                const price = quote.last;
                const change = quote.change;
                const changePct = quote.change_percentage;
                
                this.logDebug('Successfully fetched Tradier data', { price, change, changePct });
                
                return {
                    price,
                    change,
                    changePct
                };
            } else {
                this.logDebug('No Tradier data available');
                throw new Error(`无法获取${symbol}的股票价格`);
            }
        } catch (error) {
            this.logError('Error fetching Tradier stock price', error);
            throw error;
        }
    }
    
    // 获取期权到期日
    async getOptionsExpiryDates(symbol) {
        try {
            this.logDebug(`正在获取${symbol}的期权到期日`);
            return await this._getTradierOptionsExpiryDates(symbol);
        } catch (error) {
            this.logError(`获取${symbol}期权到期日失败`, error);
            throw error;
        }
    }
    
    // 从Tradier获取期权到期日
    async _getTradierOptionsExpiryDates(symbol) {
        try {
            // 构建API请求URL
            const url = `${this.tradierUrl}/markets/options/expirations?symbol=${symbol}&includeAllRoots=true`;
            
            this.logDebug(`请求URL: ${url}`);
            const response = await fetch(url, {
                headers: {
                    'Authorization': `Bearer ${this.tradierKey}`,
                    'Accept': 'application/json'
                }
            });
            
            if (!response.ok) {
                throw new Error(`HTTP错误: ${response.status}`);
            }
            
            const data = await response.json();
            console.log('Expirations response:', data);
            
            if (data && data.expirations) {
                let dates = [];
                
                // 处理 date 字段是数组的情况
                if (data.expirations.date && Array.isArray(data.expirations.date)) {
                    dates = data.expirations.date;
                }
                // 处理 date 字段是单个字符串的情况
                else if (data.expirations.date) {
                    dates = [data.expirations.date];
                }
                // 兼容旧格式：处理 expiration 字段的情况
                else if (data.expirations.expiration) {
                    // 提取不重复的到期日
                    dates = Array.isArray(data.expirations.expiration) 
                        ? data.expirations.expiration.map(item => item.date)
                        : [data.expirations.expiration.date];
                }
                
                // 按日期排序
                dates.sort();
                
                this.logDebug(`从Tradier获取了${dates.length}个到期日`);
                return dates;
            } else {
                this.logDebug('No Tradier expiry dates available');
                throw new Error(`无法获取${symbol}的期权到期日`);
            }
        } catch (error) {
            this.logError('Error fetching Tradier expiry dates', error);
            throw error;
        }
    }
    
    // 获取期权链数据
    async getOptionsChain(symbol, expiryDate, optionType) {
        try {
            this.logDebug(`正在获取${symbol}的期权链 (到期日: ${expiryDate}, 类型: ${optionType})`);
            return await this._getTradierOptionsChain(symbol, expiryDate, optionType);
        } catch (error) {
            this.logError(`获取${symbol}期权链失败`, error);
            throw error;
        }
    }
    
    // 设置API密钥
    setApiKey(source, newKey) {
        if (source === 'tradier') {
            this.tradierKey = newKey;
            localStorage.setItem('tradierApiKey', newKey);
            return true;
        }
        return false;
    }
    
    // 获取API密钥
    getApiKey(source) {
        if (source === 'tradier') {
            return this.tradierKey;
        }
        return null;
    }
    
    // 从Tradier获取期权链数据
    async _getTradierOptionsChain(symbol, expiryDate, optionType) {
        try {
            // 构建API请求URL
            const url = `${this.tradierUrl}/markets/options/chains?symbol=${symbol}&expiration=${expiryDate}&greeks=true`;
            
            this.logDebug(`请求URL: ${url}`);
            const response = await fetch(url, {
                headers: {
                    'Authorization': `Bearer ${this.tradierKey}`,
                    'Accept': 'application/json'
                }
            });
            
            if (!response.ok) {
                throw new Error(`HTTP错误: ${response.status}`);
            }
            
            const data = await response.json();
            console.log('=== Tradier API响应 ===');
            console.log(JSON.stringify(data, null, 2));
            
            // 检查响应格式是否正确
            if (!data || !data.options || !data.options.option) {
                this.logDebug('No Tradier options data available or invalid format');
                throw new Error(`无法获取${symbol}的期权数据`);
            }
            
            // Tradier API返回所有期权（看涨和看跌），我们需要根据optionType筛选
            let optionsArray = data.options.option;
            
            // 确保optionsArray是数组
            if (!Array.isArray(optionsArray)) {
                optionsArray = [optionsArray];
            }
            
            // 根据期权类型筛选
            const filteredOptions = optionsArray.filter(option => 
                option.option_type.toLowerCase() === optionType.toLowerCase()
            );
            
            // 记录找到的期权数量
            this.logDebug(`从Tradier获取了${filteredOptions.length}个${optionType}期权`);
            
            if (filteredOptions.length === 0) {
                this.logDebug(`无法找到${expiryDate}到期的${optionType}期权`);
                throw new Error(`无法找到${symbol}在${expiryDate}到期的${optionType}期权`);
            }
            
            // 从Tradier响应中提取所需的字段
            const optionsChain = filteredOptions.map(option => {
                // 使用希腊字母数据（如果有）
                const greeks = option.greeks || {};
                
                return {
                    strike: parseFloat(option.strike) || 0,
                    lastPrice: parseFloat(option.last) || 0,
                    bid: parseFloat(option.bid) || 0,
                    ask: parseFloat(option.ask) || 0,
                    volume: parseInt(option.volume) || 0,
                    openInterest: parseInt(option.open_interest) || 0,
                    impliedVolatility: parseFloat(greeks.mid_iv) || 0,
                    delta: parseFloat(greeks.delta) || 0,
                    gamma: parseFloat(greeks.gamma) || 0,
                    theta: parseFloat(greeks.theta) || 0,
                    vega: parseFloat(greeks.vega) || 0
                };
            });
            
            this.logDebug(`成功解析了${optionsChain.length}个期权合约`);
            
            // 按执行价排序
            return optionsChain.sort((a, b) => a.strike - b.strike);
            
        } catch (error) {
            this.logError('Error fetching options chain from Tradier', error);
            throw error;
        }
    }
}

// 导出API服务实例
const apiService = new APIService();

// 在控制台公开API服务，方便调试
window.apiService = apiService;

// 初始化时从本地存储加载API密钥
if (localStorage.getItem('tradierApiKey')) {
    apiService.tradierKey = localStorage.getItem('tradierApiKey');
}

stockSelect.addEventListener('change', async () => {
    const symbol = stockSelect.value.trim();
    if (!symbol) {
        currentPrice.textContent = `当前价格: --`;
        priceChange.textContent = `涨跌幅: --`;
        priceChange.className = 'h6';
        expirySelect.innerHTML = '<option value="">请输入有效的股票代码</option>';
        optionsData.innerHTML = '<tr><td colspan="14" class="text-center">请输入有效的股票代码</td></tr>';
        return;
    }
    
    const stockData = await loadStockData(symbol); 
    
    if (stockData && expirySelect.value) {
        await loadOptionsChain(stockData.price); 
    }
});

async function loadStockData(symbol) {
    try {
        if (!symbol || symbol.trim() === '') {
            currentPrice.textContent = `当前价格: --`;
            priceChange.textContent = `涨跌幅: --`;
            priceChange.className = 'h6';
            expirySelect.innerHTML = '<option value="">请输入有效的股票代码</option>';
            optionsData.innerHTML = '<tr><td colspan="14" class="text-center">请输入有效的股票代码</td></tr>';
            return null;
        }

        expirySelect.innerHTML = '<option value="">加载中...</option>';
        
        const data = await apiService.getStockPrice(symbol); 
        currentPrice.textContent = `当前价格: $${data.price.toFixed(2)}`;
        
        await loadExpiryDates(symbol); 
        
        return data;
        
    } catch (error) {
        console.error('Error loading stock data:', error);
        expirySelect.innerHTML = '<option value="">获取到期日失败</option>';
        optionsData.innerHTML = '<tr><td colspan="14" class="text-center">加载期权数据出错: ' + error.message + '</td></tr>';
        return null;
    }
}

async function loadExpiryDates(symbol) {
    try {
        if (!symbol || symbol.trim() === '') {
            expirySelect.innerHTML = '<option value="">请输入有效的股票代码</option>';
            return;
        }
        
        console.log(`正在获取${symbol}的期权到期日...`);
        // ...
    } catch (error) {
        // ...
    }
}

async function loadOptionsChain(stockPriceParam) {
    try {
        const symbol = stockSelect.value.trim();
        if (!symbol) {
            optionsData.innerHTML = '<tr><td colspan="14" class="text-center">请输入有效的股票代码</td></tr>';
            return;
        }
        
        const expiryDate = expirySelect.value;
        const optionType = callOption.checked ? 'call' : 'put';
        const isFiltered = filterOptionsTable && filterOptionsTable.checked;
        
        if (!expiryDate) return;
        
        optionsData.innerHTML = `<tr><td colspan="14" class="text-center">正在加载期权数据... (${symbol}, ${expiryDate}, ${optionType})</td></tr>`;
        
        let stockPrice;
        if (stockPriceParam !== undefined) {
            stockPrice = stockPriceParam;
        } else {
            const stockData = await apiService.getStockPrice(symbol);
            stockPrice = stockData.price;
        }
        
        let optionsChain = await apiService.getOptionsChain(symbol, expiryDate, optionType);
        
        // ... rest of the function ...
    } catch (error) {
        // ... error handling ...
    }
} 