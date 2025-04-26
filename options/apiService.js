class APIService {
    constructor() {
        // Finnhub API配置
        //this.finnhubKey = 'cvoe1h1r01qppf5ch410cvoe1h1r01qppf5ch41g'; // Finnhub API Key
        this.finnhubKey = 'd024ba9r01qt2u31ue8gd024ba9r01qt2u31ue90'
        this.finnhubUrl = 'https://finnhub.io/api/v1';
        
        // 默认使用 Finnhub
        this.dataSource = 'finnhub';
        
        // CORS代理，用于避免跨域问题
        this.corsProxy = 'https://corsproxy.io/?url='; //key=bc613458&url=
        
        // 是否显示调试信息
        this.debug = true;
    }
    
    // 获取当前数据源名称
    getDataSourceName() {
        return 'Finnhub';
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
            return await this._getFinnhubStockPrice(symbol);
        } catch (error) {
            this.logError(`获取${symbol}股票价格失败`, error);
            throw error;
        }
    }
    
    // 从Finnhub获取股票价格
    async _getFinnhubStockPrice(symbol) {
        try {
            // 构建正确的URL，使API参数能正确传递给Finnhub
            const finnhubUrl = `${this.finnhubUrl}/quote?symbol=${symbol}&token=${this.finnhubKey}`;
            const url = `${this.corsProxy}${encodeURIComponent(finnhubUrl)}`;
            
            this.logDebug(`请求URL: ${url}`);
            const response = await fetch(url);
            
            if (!response.ok) {
                throw new Error(`HTTP错误: ${response.status}`);
            }
            
            const data = await response.json();
            
            if (data && data.c > 0) {
                const price = data.c;
                const change = data.d;
                const changePct = data.dp;
                
                this.logDebug('Successfully fetched Finnhub data', { price, change, changePct });
                
                return {
                    price,
                    change,
                    changePct
                };
            } else {
                this.logDebug('No Finnhub data available');
                throw new Error(`无法获取${symbol}的股票价格`);
            }
        } catch (error) {
            this.logError('Error fetching Finnhub stock price', error);
            throw error;
        }
    }
    
    // 获取期权到期日
    async getOptionsExpiryDates(symbol) {
        try {
            this.logDebug(`正在获取${symbol}的期权到期日`);
            return await this._getFinnhubOptionsExpiryDates(symbol);
        } catch (error) {
            this.logError(`获取${symbol}期权到期日失败`, error);
            throw error;
        }
    }
    
    // 从Finnhub获取期权到期日
    async _getFinnhubOptionsExpiryDates(symbol) {
        try {
            // 构建正确的URL，使API参数能正确传递给Finnhub
            const finnhubUrl = `${this.finnhubUrl}/stock/option-chain?symbol=${symbol}&token=${this.finnhubKey}`;
            const url = `${this.corsProxy}${encodeURIComponent(finnhubUrl)}`;
            
            this.logDebug(`请求URL: ${url}`);
            const response = await fetch(url);
            
            if (!response.ok) {
                throw new Error(`HTTP错误: ${response.status}`);
            }
            
            const data = await response.json();
            
            if (data && data.data && data.data.length > 0) {
                // 提取不重复的到期日
                const datesSet = new Set(data.data.map(item => item.expirationDate));
                const dates = [...datesSet];
                
                // 按日期排序
                dates.sort();
                
                this.logDebug(`从Finnhub获取了${dates.length}个到期日`);
                return dates;
            } else {
                this.logDebug('No Finnhub expiry dates available');
                throw new Error(`无法获取${symbol}的期权到期日`);
            }
        } catch (error) {
            this.logError('Error fetching Finnhub expiry dates', error);
            throw error;
        }
    }
    
    // 获取期权链数据
    async getOptionsChain(symbol, expiryDate, optionType) {
        try {
            this.logDebug(`正在获取${symbol}的期权链 (到期日: ${expiryDate}, 类型: ${optionType})`);
            return await this._getFinnhubOptionsChain(symbol, expiryDate, optionType);
        } catch (error) {
            this.logError(`获取${symbol}期权链失败`, error);
            throw error;
        }
    }
    
    // 设置API密钥
    setApiKey(source, newKey) {
        if (source === 'finnhub') {
            this.finnhubKey = newKey;
            localStorage.setItem('finnhubApiKey', newKey);
            return true;
        }
        return false;
    }
    
    // 获取API密钥
    getApiKey(source) {
        if (source === 'finnhub') {
            return this.finnhubKey;
        }
        return null;
    }
    
    // 从Finnhub获取期权链数据
    async _getFinnhubOptionsChain(symbol, expiryDate, optionType) {
        try {
            // 构建正确的URL，使API参数能正确传递给Finnhub
            const finnhubUrl = `${this.finnhubUrl}/stock/option-chain?symbol=${symbol}&token=${this.finnhubKey}`;
            const url = `${this.corsProxy}${encodeURIComponent(finnhubUrl)}`;
            
            this.logDebug(`请求URL: ${url}`);
            const response = await fetch(url);
            
            if (!response.ok) {
                throw new Error(`HTTP错误: ${response.status}`);
            }
            
            const data = await response.json();
            console.log('=== Finnhub API响应 ===');
            console.log(JSON.stringify(data, null, 2));
            
            // 检查响应格式是否正确
            if (!data || !data.data) {
                this.logDebug('No Finnhub options data available or invalid format');
                throw new Error(`无法获取${symbol}的期权数据`);
            }
            
            // 检查该结构是否使用新的格式（包含options字段）
            if (data.data && Array.isArray(data.data)) {
                // 处理包含data数组的响应格式
                const expiryItem = data.data.find(item => item.expirationDate === expiryDate);
                this.logDebug(`在data数组中查找到期日: ${expiryDate}, 找到: ${expiryItem ? 'yes' : 'no'}`);
                
                if (!expiryItem && data.data.length > 0) {
                    // 输出可用的到期日，帮助调试
                    const availableDates = data.data.map(item => item.expirationDate);
                    this.logDebug(`可用到期日: ${availableDates.join(', ')}`);
                }

                if (!expiryItem) {
                    this.logDebug(`无法找到${expiryDate}到期的期权，可用到期日:`, 
                        data.data ? data.data.map(item => item.expirationDate).join(", ") : "无");
                    throw new Error(`无法找到${symbol}在${expiryDate}到期的期权`);
                }
                
                this.logDebug(`找到期权到期日: ${expiryItem.expirationDate}`);
                
                // 确认有options字段和相应类型的期权数据
                if (!expiryItem.options || !expiryItem.options[optionType.toUpperCase()]) {
                    this.logDebug(`无法找到${expiryDate}到期的${optionType}期权，options结构:`, expiryItem.options ? Object.keys(expiryItem.options) : 'null');
                    throw new Error(`无法找到${symbol}在${expiryDate}到期的${optionType}期权`);
                }
                
                const optionsArray = expiryItem.options[optionType.toUpperCase()];
                
                // 记录找到的期权数量
                if (Array.isArray(optionsArray)) {
                    this.logDebug(`从Finnhub获取了${optionsArray.length}个${optionType}期权`);
                } else {
                    this.logDebug(`Finnhub返回了非数组格式的期权数据:`, typeof optionsArray);
                    throw new Error(`Finnhub返回了无效的期权数据格式`);
                }
                
                // 从Finnhub响应中提取所需的字段
                const optionsChain = optionsArray.map(option => {
                    return {
                        strike: parseFloat(option.strike) || 0,
                        lastPrice: parseFloat(option.lastPrice) || 0,
                        bid: parseFloat(option.bid) || 0,
                        ask: parseFloat(option.ask) || 0,
                        volume: parseInt(option.volume) || 0,
                        openInterest: parseInt(option.openInterest) || 0,
                        impliedVolatility: parseFloat(option.impliedVolatility) / 100 || 0, // 将百分比转换为小数
                        delta: parseFloat(option.delta) || 0,
                        gamma: parseFloat(option.gamma) || 0,
                        theta: parseFloat(option.theta) || 0,
                        vega: parseFloat(option.vega) || 0
                    };
                });
                
                this.logDebug(`成功解析了${optionsChain.length}个期权合约`);
                
                // 按执行价排序
                return optionsChain.sort((a, b) => a.strike - b.strike);
            } else {
                 // Fallback for older format or other structures (if any)
                 // You might need to adjust this part if Finnhub has other response structures
                this.logDebug(`Finnhub响应不是预期的数组格式，尝试旧格式解析`);
                // Fallback logic to handle older Finnhub format if needed
                // For now, we assume the new format is standard
                 throw new Error(`无法处理的Finnhub响应格式`);
            }
            
        } catch (error) {
            this.logError('Error fetching options chain from Finnhub', error);
            throw error;
        }
    }
}

// 导出API服务实例
const apiService = new APIService();

// 在控制台公开API服务，方便调试
window.apiService = apiService;

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
        
        updateDataSourceIndicator(true);
        
        await loadExpiryDates(symbol); 
        
        return data;
        
    } catch (error) {
        console.error('Error loading stock data:', error);
        updateDataSourceIndicator(false);
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