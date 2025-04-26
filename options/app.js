document.addEventListener('DOMContentLoaded', () => {
    // 实例化服务
    const apiService = new APIService();
    const optionsCalculator = new OptionsCalculator();
    const optionStrategies = new OptionStrategies(optionsCalculator);
    
    // 图表实例
    let priceChart = null;
    let ivChart = null;
    let greeksChart = null;
    let payoffChart = null;
    
    // DOM元素 - 期权链分析
    const stockSelect = document.getElementById('stockSelect');
    const expirySelect = document.getElementById('expirySelect');
    const currentPrice = document.getElementById('currentPrice');
    const priceChange = document.getElementById('priceChange');
    const optionsData = document.getElementById('optionsData');
    const callOption = document.getElementById('callOption');
    const putOption = document.getElementById('putOption');
    const selectAllOptions = document.getElementById('selectAllOptions');
    const candidatesList = document.getElementById('candidatesList');
    const clearCandidates = document.getElementById('clearCandidates');
    const filterOptionsTable = document.getElementById('filterOptionsTable');
    
    // DOM元素 - 策略分析
    const strategyStockSelect = document.getElementById('strategyStockSelect');
    const strategyExpiry = document.getElementById('strategyExpiry');
    const strategyIV = document.getElementById('strategyIV');
    const strategyType = document.getElementById('strategyType');
    const strikeInputs = document.getElementById('strikeInputs');
    const calculateStrategy = document.getElementById('calculateStrategy');
    
    // 策略结果显示元素
    const strategyNameDisplay = document.getElementById('strategyNameDisplay');
    const strategyCost = document.getElementById('strategyCost');
    const strategyMaxProfit = document.getElementById('strategyMaxProfit');
    const strategyMaxLoss = document.getElementById('strategyMaxLoss');
    const strategyBreakEven = document.getElementById('strategyBreakEven');
    const legsListDisplay = document.getElementById('legsListDisplay');
    
    // 候选列表数据
    let candidateOptions = [];
    
    // 排序状态
    let sortConfig = {
        column: null,
        direction: 'asc'  // 'asc' or 'desc'
    };
    
    // 初始化
    init();
    
    // 从LocalStorage加载候选列表
    function loadCandidatesFromStorage() {
        const storedCandidates = localStorage.getItem('candidateOptions');
        if (storedCandidates) {
            try {
                candidateOptions = JSON.parse(storedCandidates);
                console.log('Loaded candidates from localStorage:', candidateOptions.length);
            } catch (e) {
                console.error('Error parsing candidates from localStorage:', e);
                candidateOptions = [];
                localStorage.removeItem('candidateOptions'); // Clear corrupted data
            }
        } else {
            candidateOptions = [];
        }
        updateCandidatesList(); // Update display after loading
    }

    // 保存候选列表到LocalStorage
    function saveCandidatesToStorage() {
        try {
            localStorage.setItem('candidateOptions', JSON.stringify(candidateOptions));
            console.log('Saved candidates to localStorage:', candidateOptions.length);
        } catch (e) {
            console.error('Error saving candidates to localStorage:', e);
        }
    }
    
    // 初始化应用
    async function init() {
        // 初始化主题切换
        initThemeSwitch();
        
        // 检查关键DOM元素是否存在
        if (!selectAllOptions) {
            console.error('selectAllOptions checkbox not found!');
        }
        if (!candidatesList) {
            console.error('candidatesList element not found!');
        }
        if (!clearCandidates) {
            console.error('clearCandidates button not found!');
        }
        console.log('DOM Elements initialized:', {
            selectAllOptions,
            candidatesList,
            clearCandidates
        });
        
        // 创建数据源指示器
        createDataSourceIndicators();
        
        // Load candidates from storage first
        loadCandidatesFromStorage();
        
        // 初始化表格排序
        initSortableTable();
        
        try {
            // 默认加载第一个股票
            const defaultSymbol = stockSelect.value;
            await loadStockData(defaultSymbol);
            
            // 初始化策略相关内容
            await loadStrategyStockData(strategyStockSelect.value);
            await loadStrategyExpiryDates(strategyStockSelect.value);
            updateStrategyInputs();
            
            // 添加事件监听器
            stockSelect.addEventListener('change', async () => {
                const symbol = stockSelect.value;
                await loadStockData(symbol);
                loadOptionsChain();
            });
            
            expirySelect.addEventListener('change', loadOptionsChain);
            callOption.addEventListener('change', loadOptionsChain);
            putOption.addEventListener('change', loadOptionsChain);
            
            strategyStockSelect.addEventListener('change', async () => {
                const symbol = strategyStockSelect.value;
                await loadStrategyStockData(symbol);
                await loadStrategyExpiryDates(symbol);
                updateStrategyInputs();
            });
            
            strategyExpiry.addEventListener('change', updateStrategyInputs);
            strategyType.addEventListener('change', updateStrategyInputs);
            strategyIV.addEventListener('input', updateStrategyInputs);
            calculateStrategy.addEventListener('click', calculateAndDisplayStrategy);
            
            selectAllOptions.addEventListener('change', function() {
                const checkboxes = document.querySelectorAll('#optionsData input[type="checkbox"]');
                checkboxes.forEach(checkbox => {
                    checkbox.checked = selectAllOptions.checked;
                    
                    // 触发 change 事件以更新候选列表
                    if (checkbox.checked) {
                        const event = new Event('change');
                        checkbox.dispatchEvent(event);
                    } else {
                        // 如果取消选中，从候选列表中移除
                        const optionId = checkbox.getAttribute('data-option-id');
                        removeFromCandidateList(optionId);
                    }
                });
            });
            
            clearCandidates.addEventListener('click', clearCandidateList);
            
            // 添加期权链表格过滤器事件监听
            if (filterOptionsTable) {
                filterOptionsTable.addEventListener('change', function() {
                    // 保存过滤器状态到本地存储
                    localStorage.setItem('filterOptionsTable', this.checked);
                    // 重新加载期权链以应用过滤器
                    loadOptionsChain();
                });
                
                // 从本地存储中恢复过滤器状态
                const savedFilterState = localStorage.getItem('filterOptionsTable');
                if (savedFilterState === 'true') {
                    filterOptionsTable.checked = true;
                }
            } else {
                console.error('Filter checkbox not found');
            }
            
            // 显示数据源指示器
            const dataSourceContainer = document.createElement('div');
            dataSourceContainer.id = 'dataSourceIndicator';
            dataSourceContainer.className = 'data-source-indicator text-center mb-2';
            document.querySelector('.options-container').prepend(dataSourceContainer);
            
            // 添加API密钥配置按钮
            const apiKeyContainer = document.createElement('div');
            apiKeyContainer.className = 'api-key-config text-center mt-2 mb-3';
            
            const finnhubKeyButton = document.createElement('button');
            finnhubKeyButton.textContent = '配置Finnhub API密钥';
            finnhubKeyButton.className = 'btn btn-sm btn-outline-primary me-2';
            finnhubKeyButton.addEventListener('click', () => configureApiKey('finnhub'));
            
            apiKeyContainer.appendChild(finnhubKeyButton);
            document.querySelector('.options-container').prepend(apiKeyContainer);
            
            // 初始化数据源指示器
            updateDataSourceIndicator(true);
            
        } catch (error) {
            console.error('初始化错误:', error);
            showMessage('加载数据时出错: ' + error.message, true);
        }
    }
    
    // 初始化主题切换功能
    function initThemeSwitch() {
        const toggleSwitch = document.getElementById('theme-toggle');
        if (!toggleSwitch) {
            console.error('Theme toggle switch not found');
            return;
        }

        // 检查本地存储中是否有保存的主题
        const currentTheme = localStorage.getItem('theme') || 'light';
        
        // 设置初始主题
        if (currentTheme === 'dark') {
            document.documentElement.setAttribute('data-theme', 'dark');
            toggleSwitch.checked = true;
        }
        
        // 监听切换事件
        toggleSwitch.addEventListener('change', function(e) {
            if (e.target.checked) {
                // 切换到暗色主题
                document.documentElement.setAttribute('data-theme', 'dark');
                localStorage.setItem('theme', 'dark');
                console.log('Switched to dark theme');
            } else {
                // 切换到亮色主题
                document.documentElement.setAttribute('data-theme', 'light');
                localStorage.setItem('theme', 'light');
                console.log('Switched to light theme');
            }
        });
    }
    
    // 加载股票数据
    async function loadStockData(symbol) {
        try {
            // 清空到期日选择器并显示加载中状态
            expirySelect.innerHTML = '<option value="">加载中...</option>';
            
            // 加载股票价格
            const data = await apiService.getStockPrice(symbol);
            currentPrice.textContent = `当前价格: $${data.price.toFixed(2)}`;
            
            const changeClass = data.change >= 0 ? 'positive-change' : 'negative-change';
            const changeSign = data.change >= 0 ? '+' : '';
            priceChange.textContent = `涨跌幅: ${changeSign}${data.change.toFixed(2)} (${changeSign}${(data.change / (data.price - data.change) * 100).toFixed(2)}%)`;
            priceChange.className = `h6 ${changeClass}`;
            
            // 更新数据源指示器
            updateDataSourceIndicator(true);
            
            // 加载期权到期日 - 移除直接引用dates
            await loadExpiryDates(symbol);
            
            // 不再直接引用dates变量，从loadExpiryDates返回后，根据expirySelect是否有选择的值来判断是否加载期权链
            if (expirySelect.value) {
                await loadOptionsChain();
            }
        } catch (error) {
            console.error('Error loading stock data:', error);
            
            // 更新数据源指示器
            updateDataSourceIndicator(false);
            
            // 错误处理 - 清空到期日选择器并显示错误信息
            expirySelect.innerHTML = '<option value="">获取到期日失败</option>';
            optionsData.innerHTML = '<tr><td colspan="14" class="text-center">加载期权数据出错: ' + error.message + '</td></tr>';
        }
    }
    
    // 加载期权到期日
    async function loadExpiryDates(symbol) {
        try {
            console.log(`正在获取${symbol}的期权到期日...`);
            const dates = await apiService.getOptionsExpiryDates(symbol);
            console.log(`获取到${dates.length}个到期日: ${dates.join(', ')}`);
            
            // 更新下拉菜单
            expirySelect.innerHTML = '';
            
            if (dates.length === 0) {
                // 如果没有获取到日期，显示提示
                const option = document.createElement('option');
                option.value = "";
                option.textContent = "无可用到期日";
                expirySelect.appendChild(option);
                
                // 清空期权链表格
                optionsData.innerHTML = '<tr><td colspan="14" class="text-center">没有可用的期权数据</td></tr>';
                
                // 更新数据源指示器
                updateDataSourceIndicator(false);
                return;
            }
            
            // 添加日期选项 - 增加天数显示
            dates.forEach(date => {
                const option = document.createElement('option');
                option.value = date;
                
                // 计算距离当前日期的天数
                const today = new Date();
                const expiryDate = new Date(date);
                const daysToExpiry = Math.ceil((expiryDate - today) / (1000 * 60 * 60 * 24));
                
                // 格式化日期显示，加上天数
                option.textContent = `${date} (${daysToExpiry}天)`;
                
                expirySelect.appendChild(option);
            });
            
            // 选择默认到期日 - 优先选择30-60天左右的日期
            let selectedIndex = 0;
            const today = new Date();
            
            // 查找30-60天范围内的第一个日期
            for (let i = 0; i < dates.length; i++) {
                const daysToExpiry = Math.ceil((new Date(dates[i]) - today) / (1000 * 60 * 60 * 24));
                if (daysToExpiry >= 60 && daysToExpiry <= 120) {
                    selectedIndex = i;
                    break;
                }
                // 如果找不到理想范围，选择第一个大于20天的日期
                if (selectedIndex === 0 && daysToExpiry >= 30) {
                    selectedIndex = i;
                }
            }
            
            expirySelect.selectedIndex = selectedIndex;
        } catch (error) {
            console.error('Error loading expiry dates:', error);
            expirySelect.innerHTML = '<option value="">获取到期日失败</option>';
            updateDataSourceIndicator(false);
        }
    }
    
    // 策略分析 - 加载股票数据
    async function loadStrategyStockData(symbol) {
        try {
            // 加载股票价格
            const data = await apiService.getStockPrice(symbol);
            
            // 加载期权到期日
            const dates = await apiService.getOptionsExpiryDates(symbol);
            
            // 更新下拉菜单
            strategyExpiry.innerHTML = '';
            dates.forEach(date => {
                const option = document.createElement('option');
                option.value = date;
                option.textContent = new Date(date).toLocaleDateString(undefined, { 
                    year: 'numeric', 
                    month: 'short', 
                    day: 'numeric' 
                });
                strategyExpiry.appendChild(option);
            });
            
            // 更新执行价输入框
            updateStrategyInputs();
        } catch (error) {
            console.error('Error loading strategy stock data:', error);
        }
    }
    
    // 加载策略到期日
    async function loadStrategyExpiryDates(symbol) {
        try {
            // 加载期权到期日
            const dates = await apiService.getOptionsExpiryDates(symbol);
            
            // 更新下拉菜单
            strategyExpiry.innerHTML = '';
            
            if (dates.length === 0) {
                // 如果没有获取到日期，显示提示
                const option = document.createElement('option');
                option.value = "";
                option.textContent = "无可用到期日";
                strategyExpiry.appendChild(option);
                return;
            }
            
            dates.forEach(date => {
                const option = document.createElement('option');
                option.value = date;
                
                // 计算距离当前日期的天数
                const today = new Date();
                const expiryDate = new Date(date);
                const daysToExpiry = Math.ceil((expiryDate - today) / (1000 * 60 * 60 * 24));
                
                // 格式化日期显示，加上天数
                option.textContent = `${date} (${daysToExpiry}天)`;
                
                strategyExpiry.appendChild(option);
            });
            
            // 选择默认到期日 - 优先选择30-60天左右的日期
            let selectedIndex = 0;
            const today = new Date();
            
            // 查找30-60天范围内的第一个日期
            for (let i = 0; i < dates.length; i++) {
                const daysToExpiry = Math.ceil((new Date(dates[i]) - today) / (1000 * 60 * 60 * 24));
                if (daysToExpiry >= 30 && daysToExpiry <= 60) {
                    selectedIndex = i;
                    break;
                }
                // 如果找不到理想范围，选择第一个大于20天的日期
                if (selectedIndex === 0 && daysToExpiry >= 20) {
                    selectedIndex = i;
                }
            }
            
            strategyExpiry.selectedIndex = selectedIndex;
            
        } catch (error) {
            console.error('Error loading strategy expiry dates:', error);
            strategyExpiry.innerHTML = '<option value="">获取到期日失败</option>';
        }
    }
    
    // 根据策略类型更新执行价输入
    function updateStrategyInputs() {
        const strategy = strategyType.value;
        strikeInputs.innerHTML = '';
        
        let strikesNeeded = 0;
        let strikeLebels = [];
        
        if (strategy === 'bullCallSpread' || strategy === 'bearPutSpread') {
            strikesNeeded = 2;
            strikeLabels = ['低执行价', '高执行价'];
        } else if (strategy === 'ironCondor') {
            strikesNeeded = 4;
            strikeLabels = ['看跌低执行价', '看跌高执行价', '看涨低执行价', '看涨高执行价'];
        } else if (strategy === 'callButterfly' || strategy === 'putButterfly') {
            strikesNeeded = 3;
            strikeLabels = ['低执行价', '中间执行价', '高执行价'];
        } else if (strategy === 'straddle') {
            strikesNeeded = 1;
            strikeLabels = ['执行价'];
        }
        
        // 创建执行价输入框
        for (let i = 0; i < strikesNeeded; i++) {
            const formGroup = document.createElement('div');
            formGroup.className = 'form-group mb-2';
            
            const label = document.createElement('label');
            label.textContent = `${strikeLabels[i] || `执行价 ${i+1}`}:`;
            
            const input = document.createElement('input');
            input.type = 'number';
            input.className = 'form-control strike-input';
            input.placeholder = '输入执行价';
            input.step = '0.5';
            
            // 尝试设置一个合理的默认值
            const getStockPrice = async () => {
                try {
                    const data = await apiService.getStockPrice(strategyStockSelect.value);
                    const basePrice = data.price;
                    
                    // 根据策略类型设置默认值
                    if (strategy === 'straddle') {
                        input.value = basePrice.toFixed(1);
                    } else if (strategy === 'bullCallSpread') {
                        input.value = (basePrice * (0.95 + i * 0.1)).toFixed(1);
                    } else if (strategy === 'bearPutSpread') {
                        input.value = (basePrice * (1.05 - i * 0.1)).toFixed(1);
                    } else if (strategy === 'ironCondor') {
                        const factors = [0.85, 0.95, 1.05, 1.15];
                        input.value = (basePrice * factors[i]).toFixed(1);
                    } else if (strategy === 'callButterfly' || strategy === 'putButterfly') {
                        const factors = [0.9, 1.0, 1.1];
                        input.value = (basePrice * factors[i]).toFixed(1);
                    }
                } catch (e) {
                    console.error('Error setting default strike prices:', e);
                    input.value = '100';
                }
            };
            
            getStockPrice();
            
            formGroup.appendChild(label);
            formGroup.appendChild(input);
            strikeInputs.appendChild(formGroup);
        }
    }
    
    // 计算并显示策略
    async function calculateAndDisplayStrategy() {
        try {
            // 获取基本参数
            const symbol = strategyStockSelect.value;
            const expiryDate = strategyExpiry.value;
            const ivValue = parseFloat(strategyIV.value) / 100; // 转换为小数
            const strategyName = strategyType.value;
            
            // 获取当前股价
            const stockData = await apiService.getStockPrice(symbol);
            const stockPrice = stockData.price;
            
            // 显示数据源指示器
            if (stockData.isMockData || stockData.timestamp) {
                showDataSourceIndicator('策略分析', true);
            } else {
                showDataSourceIndicator('策略分析', false);
            }
            
            // 获取执行价
            const strikeInputElements = document.querySelectorAll('.strike-input');
            const strikes = Array.from(strikeInputElements).map(input => parseFloat(input.value));
            
            // 计算到期天数
            const today = new Date();
            const expiry = new Date(expiryDate);
            const daysToExpiry = Math.max(1, Math.ceil((expiry - today) / (1000 * 60 * 60 * 24)));
            
            // 根据策略类型计算
            let result;
            if (strategyName === 'bullCallSpread' || strategyName === 'bearCallSpread' || 
                strategyName === 'bullPutSpread' || strategyName === 'bearPutSpread') {
                result = optionStrategies.calculateVerticalSpread(
                    strategyName, stockPrice, strikes, daysToExpiry, ivValue
                );
            } else if (strategyName === 'ironCondor') {
                result = optionStrategies.calculateIronCondor(
                    stockPrice, strikes, daysToExpiry, ivValue
                );
            } else if (strategyName === 'callButterfly' || strategyName === 'putButterfly') {
                result = optionStrategies.calculateButterfly(
                    strategyName, stockPrice, strikes, daysToExpiry, ivValue
                );
            } else if (strategyName === 'straddle') {
                result = optionStrategies.calculateStraddle(
                    stockPrice, strikes[0], daysToExpiry, ivValue
                );
            }
            
            // 显示策略结果
            displayStrategyResult(result, stockPrice);
            
        } catch (error) {
            console.error('Error calculating strategy:', error);
            showDataSourceIndicator('策略分析', true);
        }
    }
    
    // 显示策略计算结果
    function displayStrategyResult(result, stockPrice) {
        if (!result) return;
        
        // 转换策略名称为可读形式
        const strategyNames = {
            'bullCallSpread': '牛市看涨价差 (Bull Call Spread)',
            'bearCallSpread': '熊市看涨价差 (Bear Call Spread)',
            'bullPutSpread': '牛市看跌价差 (Bull Put Spread)',
            'bearPutSpread': '熊市看跌价差 (Bear Put Spread)',
            'ironCondor': '铁秃鹰 (Iron Condor)',
            'callButterfly': '看涨蝶式策略 (Call Butterfly)',
            'putButterfly': '看跌蝶式策略 (Put Butterfly)',
            'straddle': '跨式策略 (Straddle)'
        };
        
        // 更新基本信息
        strategyNameDisplay.textContent = strategyNames[result.strategy] || result.strategy;
        
        // 成本/收益
        const costValue = Math.abs(result.netCost || result.netCredit || 0);
        const isCost = result.netCost > 0 || !result.netCredit;
        strategyCost.textContent = `${isCost ? '-' : '+'} $${costValue.toFixed(2)}`;
        strategyCost.className = isCost ? 'text-danger' : 'text-success';
        
        // 最大盈利/亏损
        strategyMaxProfit.textContent = typeof result.maxProfit === 'number' ? 
            `$${result.maxProfit.toFixed(2)}` : result.maxProfit;
        strategyMaxLoss.textContent = typeof result.maxLoss === 'number' ? 
            `$${result.maxLoss.toFixed(2)}` : result.maxLoss;
        
        // 盈亏平衡点
        if (result.breakEven) {
            strategyBreakEven.textContent = `$${result.breakEven.toFixed(2)}`;
        } else if (result.breakEvenLow && result.breakEvenHigh) {
            strategyBreakEven.textContent = `$${result.breakEvenLow.toFixed(2)} 和 $${result.breakEvenHigh.toFixed(2)}`;
        } else {
            strategyBreakEven.textContent = '-';
        }
        
        // 清空并显示组合部分
        legsListDisplay.innerHTML = '';
        
        // 垂直价差显示
        if (result.longOption && result.shortOption) {
            const longLeg = document.createElement('li');
            longLeg.className = 'list-group-item';
            longLeg.textContent = `买入 ${result.longOption.type === 'call' ? '看涨' : '看跌'} 执行价: $${result.longOption.strike.toFixed(2)} 价格: $${result.longOption.price.toFixed(2)}`;
            legsListDisplay.appendChild(longLeg);
            
            const shortLeg = document.createElement('li');
            shortLeg.className = 'list-group-item';
            shortLeg.textContent = `卖出 ${result.shortOption.type === 'call' ? '看涨' : '看跌'} 执行价: $${result.shortOption.strike.toFixed(2)} 价格: $${result.shortOption.price.toFixed(2)}`;
            legsListDisplay.appendChild(shortLeg);
        } 
        // legs数组显示(铁鹰、蝶式、跨式)
        else if (result.legs && Array.isArray(result.legs)) {
            result.legs.forEach(leg => {
                const legElement = document.createElement('li');
                legElement.className = 'list-group-item';
                const quantity = leg.quantity ? leg.quantity : 1;
                const position = leg.position === 'long' ? '买入' : '卖出';
                const type = leg.type === 'call' ? '看涨' : '看跌';
                legElement.textContent = `${position} ${quantity}张 ${type} 执行价: $${leg.strike.toFixed(2)} 价格: $${leg.price.toFixed(2)}`;
                legsListDisplay.appendChild(legElement);
            });
        }
        
        // 更新收益曲线图表
        updatePayoffChart(result.payoffCurve, stockPrice, result.strategy);
    }
    
    // 更新收益曲线图表
    function updatePayoffChart(payoffData, stockPrice, strategyName) {
        if (!payoffData || !payoffData.length) return;
        
        const ctx = document.getElementById('payoffChart').getContext('2d');
        
        // 准备数据
        const labels = payoffData.map(item => item.stockPrice.toFixed(0));
        const data = payoffData.map(item => item.payoff);
        
        // 当前股价位置的索引
        const currentIndex = payoffData.findIndex(item => item.stockPrice >= stockPrice);
        
        // 设置图表颜色
        const getStrategyColor = (strategy) => {
            const colors = {
                'bullCallSpread': 'rgba(75, 192, 192, 1)', // 青绿色
                'bearPutSpread': 'rgba(255, 99, 132, 1)',  // 红色
                'ironCondor': 'rgba(153, 102, 255, 1)',    // 紫色
                'callButterfly': 'rgba(255, 159, 64, 1)',  // 橙色
                'putButterfly': 'rgba(54, 162, 235, 1)',   // 蓝色
                'straddle': 'rgba(255, 206, 86, 1)'        // 黄色
            };
            return colors[strategy] || 'rgba(75, 192, 192, 1)';
        };
        
        const borderColor = getStrategyColor(strategyName);
        const backgroundColor = borderColor.replace('1)', '0.2)');
        
        // 销毁旧图表
        if (payoffChart) {
            payoffChart.destroy();
        }
        
        // 创建图表
        payoffChart = new Chart(ctx, {
            type: 'line',
            data: {
                labels: labels,
                datasets: [{
                    label: '策略收益 ($)',
                    data: data,
                    borderColor: borderColor,
                    backgroundColor: backgroundColor,
                    borderWidth: 2,
                    fill: true,
                    tension: 0.1
                }]
            },
            options: {
                responsive: true,
                plugins: {
                    title: {
                        display: true,
                        text: '策略收益曲线'
                    },
                    tooltip: {
                        callbacks: {
                            label: function(context) {
                                return `股价: $${context.label}, 收益: $${context.raw.toFixed(2)}`;
                            }
                        }
                    },
                    annotation: {
                        annotations: {
                            line1: {
                                type: 'line',
                                yMin: 0,
                                yMax: 0,
                                borderColor: 'rgba(0, 0, 0, 0.5)',
                                borderWidth: 1,
                                borderDash: [5, 5]
                            },
                            line2: currentIndex >= 0 ? {
                                type: 'line',
                                xMin: currentIndex,
                                xMax: currentIndex,
                                borderColor: 'rgba(255, 0, 0, 0.5)',
                                borderWidth: 1
                            } : undefined
                        }
                    }
                },
                scales: {
                    x: {
                        title: {
                            display: true,
                            text: '股票价格 ($)'
                        },
                        grid: {
                            display: false
                        }
                    },
                    y: {
                        title: {
                            display: true,
                            text: '盈亏 ($)'
                        },
                        grid: {
                            color: function(context) {
                                if (context.tick.value === 0) {
                                    return 'rgba(0, 0, 0, 0.5)';
                                }
                                return 'rgba(0, 0, 0, 0.1)';
                            }
                        }
                    }
                }
            }
        });
    }
    
    // 加载期权链
    async function loadOptionsChain() {
        try {
            const symbol = stockSelect.value;
            const expiryDate = expirySelect.value;
            const optionType = callOption.checked ? 'call' : 'put';
            const isFiltered = filterOptionsTable && filterOptionsTable.checked;
            
            if (!expiryDate) return;
            
            // 显示加载中消息
            optionsData.innerHTML = `<tr><td colspan="14" class="text-center">正在加载期权数据... (${symbol}, ${expiryDate}, ${optionType})</td></tr>`;
            
            // 保存当前数据源，以便检测是否发生自动切换
            const currentSource = apiService.dataSource;
            const sourceName = 'Finnhub';
            
            // 获取期权链数据
            let optionsChain;
            try {
                optionsChain = await apiService.getOptionsChain(symbol, expiryDate, optionType);
            } catch (error) {
                console.error('Error in primary data source:', error);
                throw error;
            }
            
            // 更新数据源指示器
            updateDataSourceIndicator(true);
            
            // 更新表格
            optionsData.innerHTML = '';
            
            if (!optionsChain || optionsChain.length === 0) {
                optionsData.innerHTML = `<tr><td colspan="14" class="text-center">没有可用的期权数据 (${symbol}, ${expiryDate}, ${optionType})</td></tr>`;
                return;
            }
            
            // 获取当前股价用于标记平值期权
            const stockData = await apiService.getStockPrice(symbol);
            const stockPrice = stockData.price;
            
            // 按执行价排序
            optionsChain.sort((a, b) => a.strike - b.strike);
            
            // 计算到期天数
            const today = new Date();
            const expiry = new Date(expiryDate);
            const daysToExpiry = Math.max(1, Math.ceil((expiry - today) / (1000 * 60 * 60 * 24)));
            
            // 检查是否所有期权都缺少价格数据 (lastPrice, bid, ask都为0)
            const hasMarketData = optionsChain.some(option => 
                option.lastPrice > 0 || option.bid > 0 || option.ask > 0
            );
            
            if (!hasMarketData) {
                showMessage(`警告: ${sourceName}未提供期权的价格数据，显示的是基本合约信息`, true);
            }
            
            // 计算表格中要显示的期权总数
            let totalOptions = optionsChain.length;
            let displayedOptions = 0;
            
            optionsChain.forEach((option, index) => {
                const row = document.createElement('tr');
                
                // 给每个期权分配一个唯一ID
                option.id = `option-${symbol}-${expiryDate}-${optionType}-${index}-${option.strike}`;
                option.optionType = optionType;
                option.stockPrice = stockPrice;
                option.expiryDate = expiryDate; // Store the expiry date with each option
                option.stockSymbol = symbol; // Store the stock symbol with each option
                
                // 防止undefined值 - 设置默认值
                if (!option) {
                    console.error('发现无效期权数据:', option);
                    return; // 跳过这个期权
                }
                
                // 确保所有必要的属性都有默认值
                const strike = option.strike || 0;
                const lastPrice = option.lastPrice || 0;
                const bid = option.bid || 0;
                const ask = option.ask || 0;
                const volume = option.volume || 0;
                const openInterest = option.openInterest || 0;
                const impliedVolatility = option.impliedVolatility || 0;
                const delta = option.delta || 0;
                const gamma = option.gamma || 0;
                const theta = option.theta || 0;
                const vega = option.vega || 0;
                
                // 判断接近平值的期权
                const isNearATM = Math.abs(strike - stockPrice) < (stockPrice * 0.02);
                option.isNearATM = isNearATM;
                
                // 根据期权状态设置行样式
                if (isNearATM) {
                    row.classList.add('table-primary'); // 高亮显示平值期权
                } else if ((optionType === 'call' && strike < stockPrice) || 
                           (optionType === 'put' && strike > stockPrice)) {
                    row.classList.add('table-success'); // 实值期权
                } else {
                    row.classList.add('table-light'); // 虚值期权
                }
                
                // 计算执行价相对于股价的百分比
                const strikePercentage = ((strike / stockPrice) * 100 - 100).toFixed(2);
                const percentageClass = strikePercentage > 0 ? 'text-success' : (strikePercentage < 0 ? 'text-danger' : '');
                const percentageSign = strikePercentage > 0 ? '+' : '';
                
                // 保存这些值到option对象中
                option.strikePercentage = strikePercentage;
                option.percentageClass = percentageClass;
                option.percentageSign = percentageSign;
                
                // 计算卖方回报率（年化）
                let sellerReturn = '-';
                let sellerReturnClass = '';
                let numericSellerReturn = 0;
                
                if (bid > 0) {
                    // 计算卖方收取的权利金 - 1.0元手续费
                    const premium = bid * 100 - 1.0; // 100股
                    
                    // 计算所需保证金（担保金额）
                    let collateral;
                    
                    if (optionType === 'put') {
                        // 对于看跌期权（现金担保看跌）
                        // 保证金 = 行权价 × 100股
                        collateral = strike * 100;
                        
                        // 回报率计算 = (权利金 / 保证金) × (一年天数 / 剩余天数)
                        const annualReturn = (premium / collateral) * (365 / daysToExpiry) * 100;
                        numericSellerReturn = annualReturn;
                        sellerReturn = annualReturn.toFixed(2) + '%';
                        sellerReturnClass = annualReturn >= 15 ? 'text-success fw-bold' : 
                                           (annualReturn >= 8 ? 'text-success' : '');
                    } else {
                        // 对于看涨期权（备兑看涨）
                        // 保证金 = 股票价格 × 100股
                        collateral = stockPrice * 100;
                        
                        // 回报率计算 = (权利金 / 保证金) × (一年天数 / 剩余天数)
                        const annualReturn = (premium / collateral) * (365 / daysToExpiry) * 100;
                        numericSellerReturn = annualReturn;
                        sellerReturn = annualReturn.toFixed(2) + '%';
                        sellerReturnClass = annualReturn >= 15 ? 'text-success fw-bold' : 
                                           (annualReturn >= 8 ? 'text-success' : '');
                    }
                }
                
                // 保存回报率到option对象中
                option.sellerReturn = sellerReturn;
                option.sellerReturnClass = sellerReturnClass;
                option.numericSellerReturn = numericSellerReturn;
                
                // 应用过滤器 - 如果启用了过滤器且不满足条件，则跳过此期权
                if (isFiltered) {
                    const numericStrikePercentage = parseFloat(strikePercentage);
                    // 只显示价内 (strikePercentage < 0) 且有正回报率 (numericSellerReturn > 0) 的期权
                    if (!(numericStrikePercentage < -10 && numericSellerReturn > 5)) {
                        return; // 跳过这个期权
                    }
                }
                
                // 累计显示的期权数量
                displayedOptions++;
                
                // 创建复选框
                const checkbox = document.createElement('input');
                checkbox.type = 'checkbox';
                checkbox.setAttribute('data-option-id', option.id);
                
                // 检查此期权是否已在候选列表中
                const isSelected = candidateOptions.some(candidateOption => candidateOption.id === option.id);
                checkbox.checked = isSelected;
                
                // Give the checkbox a unique ID
                const checkboxId = `checkbox-${option.id}`;
                checkbox.id = checkboxId;
                
                // Remove all event listeners from the checkbox - we'll handle everything in the row click

                // 创建复选框单元格
                const checkboxCell = document.createElement('td');
                checkboxCell.appendChild(checkbox);
                
                // 添加复选框单元格到行
                row.appendChild(checkboxCell);
                
                // 添加其他单元格内容
                const cells = `
                    <td><strong>${strike.toFixed(2)}</strong></td>
                    <td class="${percentageClass}">${percentageSign}${strikePercentage}%</td>
                    <td>${lastPrice.toFixed(2)}</td>
                    <td>${bid.toFixed(2)}</td>
                    <td>${ask.toFixed(2)}</td>
                    <td class="${sellerReturnClass}">${sellerReturn}</td>
                    <td>${volume.toLocaleString()}</td>
                    <td>${openInterest ? openInterest.toLocaleString() : 'N/A'}</td>
                    <td>${(impliedVolatility * 100).toFixed(1)}%</td>
                    <td>${delta.toFixed(3)}</td>
                    <td>${gamma.toFixed(4)}</td>
                    <td>${theta.toFixed(3)}</td>
                    <td>${vega.toFixed(3)}</td>
                    <td class="text-nowrap">${expiryDate}</td>
                    <td class="text-nowrap">${option.stockSymbol || 'N/A'}</td>
                `;
                
                row.innerHTML += cells;
                
                // Handle all events in the row click handler
                row.addEventListener('click', (event) => {
                    const target = event.target;
                    console.log('Row clicked, target:', target.tagName, 'id:', target.id);
                    
                    // Check if we clicked on a checkbox
                    if (target.tagName === 'INPUT' && target.type === 'checkbox') {
                        console.log('Checkbox clicked, checked:', target.checked);
                        
                        // Handle checkbox logic
                        if (target.checked) {
                            // Add to candidates list
                            if (!candidateOptions.some(o => o.id === option.id)) {
                                console.log('Adding to candidates:', option.id);
                                candidateOptions.push(option);
                            }
                        } else {
                            // Remove from candidates list
                            console.log('Removing from candidates:', option.id);
                            removeFromCandidateList(option.id);
                        }
                        
                        // Save and update
                        saveCandidatesToStorage();
                        updateCandidatesList();
                        
                        // Don't process the row click logic
                        return;
                    }
                    
                    // This is a regular row click (not on checkbox)
                    // Don't proceed with row logic if we clicked directly on a checkbox
                    
                    // 移除其他行的选中状态
                    document.querySelectorAll('#optionsData tr.selected').forEach(tr => {
                        tr.classList.remove('selected');
                    });
                    
                    // 添加选中状态样式
                    row.classList.add('selected');
                    
                    // 分析当前选中期权
                    analyzeOption(option);
                });
                
                optionsData.appendChild(row);
            });
            
            // 显示过滤器状态信息
            if (isFiltered && displayedOptions < totalOptions) {
                const filterInfo = document.createElement('tr');
                filterInfo.innerHTML = `<td colspan="14" class="text-center text-muted">
                    <small>过滤器已启用: 显示 ${displayedOptions} 个期权 (共 ${totalOptions} 个期权)</small>
                </td>`;
                optionsData.appendChild(filterInfo);
            }
            
            // 如果没有期权数据，显示提示信息
            if (optionsChain.length === 0) {
                optionsData.innerHTML = `<tr><td colspan="14" class="text-center">没有可用的期权数据</td></tr>`;
                return;
            }
            
            // 分析平值期权（或最接近的）
            const atmOption = optionsChain.reduce((closest, current) => {
                return (Math.abs(current.strike - stockPrice) < Math.abs(closest.strike - stockPrice)) 
                    ? current : closest;
            }, optionsChain[0]);
            
            // 选中并高亮显示平值行
            const rows = Array.from(optionsData.querySelectorAll('tr'));
            const atmRow = rows.find(row => 
                parseFloat(row.cells[0].textContent) === atmOption.strike
            );
            
            if (atmRow) {
                atmRow.classList.add('selected');
                // 滚动到平值期权位置
                atmRow.scrollIntoView({ block: 'center', behavior: 'smooth' });
            }
            
            // 分析选中期权
            analyzeOption(atmOption);
        } catch (error) {
            console.error('Error loading options chain:', error);
            optionsData.innerHTML = `<tr><td colspan="14" class="text-center">加载期权数据出错: ${error.message}</td></tr>`;
            updateDataSourceIndicator(false);
        }
    }
    
    // 分析特定期权
    async function analyzeOption(option) {
        try {
            // 防止undefined值
            if (!option) {
                console.error('无效的期权数据用于分析');
                return;
            }
            
            const symbol = stockSelect.value;
            const expiryDate = expirySelect.value;
            const optionType = callOption.checked ? 'call' : 'put';
            
            // 获取基本数据
            const stockData = await apiService.getStockPrice(symbol);
            const stockPrice = stockData.price;
            const strikePrice = option.strike || 0;
            
            // 计算到期时间(年)
            const today = new Date();
            const expiry = new Date(expiryDate);
            const timeToExpiryDays = Math.max(0, Math.ceil((expiry - today) / (1000 * 60 * 60 * 24)));
            const timeToExpiryYears = timeToExpiryDays / 365;
            
            // 波动率
            const impliedVol = parseFloat(option.impliedVolatility || 0);
            
            // 更新图表
            updatePriceChart(optionType, stockPrice, strikePrice, timeToExpiryYears, impliedVol);
            updateIVChart(optionsData);
            updateGreeksChart(optionType, stockPrice, strikePrice, timeToExpiryYears, impliedVol);
            
        } catch (error) {
            console.error('Error analyzing option:', error);
        }
    }
    
    // 更新价格分布图表
    function updatePriceChart(optionType, stockPrice, strikePrice, timeToExpiryYears, impliedVol) {
        const priceImpact = optionsCalculator.calculatePriceImpact(
            optionType,
            stockPrice,
            strikePrice,
            timeToExpiryYears,
            impliedVol
        );
        
        const labels = priceImpact.map(item => item.stockPrice.toFixed(0));
        const data = priceImpact.map(item => item.optionPrice);
        
        const ctx = document.getElementById('priceChart').getContext('2d');
        
        if (priceChart) {
            priceChart.destroy();
        }
        
        priceChart = new Chart(ctx, {
            type: 'line',
            data: {
                labels: labels,
                datasets: [{
                    label: optionType === 'call' ? '看涨期权价格' : '看跌期权价格',
                    data: data,
                    borderColor: optionType === 'call' ? 'rgba(75, 192, 192, 1)' : 'rgba(255, 99, 132, 1)',
                    backgroundColor: optionType === 'call' ? 'rgba(75, 192, 192, 0.2)' : 'rgba(255, 99, 132, 0.2)',
                    borderWidth: 2,
                    fill: true,
                    tension: 0.3
                }]
            },
            options: {
                responsive: true,
                plugins: {
                    title: {
                        display: true,
                        text: `期权价格与股票价格关系 (执行价: $${strikePrice})`
                    },
                    tooltip: {
                        callbacks: {
                            label: function(context) {
                                return `股票价格: $${context.label}, 期权价格: $${context.raw.toFixed(2)}`;
                            }
                        }
                    }
                },
                scales: {
                    x: {
                        title: {
                            display: true,
                            text: '股票价格 ($)'
                        },
                        grid: {
                            display: false
                        }
                    },
                    y: {
                        title: {
                            display: true,
                            text: '期权价格 ($)'
                        },
                        beginAtZero: true
                    }
                }
            }
        });
    }
    
    // 更新隐含波动率图表
    function updateIVChart(optionsData) {
        // 从期权链表提取数据
        const rows = Array.from(optionsData.querySelectorAll('tr'));
        const strikes = [];
        const ivs = [];
        
        rows.forEach(row => {
            const cells = row.querySelectorAll('td');
            if (cells.length >= 7) {
                strikes.push(parseFloat(cells[0].textContent));
                
                // 正确处理IV值，去除百分比符号
                const ivText = cells[6].textContent;
                const ivValue = parseFloat(ivText.replace('%', '')) / 100;
                ivs.push(ivValue);
            }
        });
        
        // 排序数据以确保图表正确
        const dataPoints = strikes.map((strike, index) => ({strike, iv: ivs[index]}));
        dataPoints.sort((a, b) => a.strike - b.strike);
        
        const sortedStrikes = dataPoints.map(point => point.strike);
        const sortedIVs = dataPoints.map(point => point.iv);
        
        // 创建图表
        const ctx = document.getElementById('ivChart').getContext('2d');
        
        if (ivChart) {
            ivChart.destroy();
        }
        
        ivChart = new Chart(ctx, {
            type: 'line',
            data: {
                labels: sortedStrikes,
                datasets: [{
                    label: '隐含波动率',
                    data: sortedIVs,
                    borderColor: 'rgba(153, 102, 255, 1)',
                    backgroundColor: 'rgba(153, 102, 255, 0.2)',
                    borderWidth: 2,
                    fill: true,
                    tension: 0.3
                }]
            },
            options: {
                responsive: true,
                plugins: {
                    title: {
                        display: true,
                        text: '波动率微笑'
                    },
                    tooltip: {
                        callbacks: {
                            label: function(context) {
                                return `执行价: $${context.label}, IV: ${(context.raw * 100).toFixed(1)}%`;
                            }
                        }
                    }
                },
                scales: {
                    x: {
                        title: {
                            display: true,
                            text: '执行价 ($)'
                        }
                    },
                    y: {
                        title: {
                            display: true,
                            text: '隐含波动率'
                        },
                        ticks: {
                            callback: function(value) {
                                return (value * 100).toFixed(0) + '%';
                            }
                        }
                    }
                }
            }
        });
    }
    
    // 更新希腊字母图表
    function updateGreeksChart(optionType, stockPrice, strikePrice, timeToExpiryYears, impliedVol) {
        // 计算不同股价对希腊字母的影响
        const priceRange = 0.2;
        const priceLow = stockPrice * (1 - priceRange);
        const priceHigh = stockPrice * (1 + priceRange);
        const steps = 40;
        const priceStep = (priceHigh - priceLow) / steps;
        
        const prices = [];
        const deltas = [];
        const gammas = [];
        const thetas = [];
        const vegas = [];
        
        for (let price = priceLow; price <= priceHigh; price += priceStep) {
            const greeks = optionsCalculator.calculateGreeks(
                optionType, price, strikePrice, timeToExpiryYears, impliedVol
            );
            
            prices.push(price.toFixed(0));
            deltas.push(greeks.delta);
            gammas.push(greeks.gamma * 100); // 放大gamma以便于可视化
            thetas.push(greeks.theta / 10);  // 缩小theta以便于可视化
            vegas.push(greeks.vega);
        }
        
        // 创建图表
        const ctx = document.getElementById('greeksChart').getContext('2d');
        
        if (greeksChart) {
            greeksChart.destroy();
        }
        
        greeksChart = new Chart(ctx, {
            type: 'line',
            data: {
                labels: prices,
                datasets: [
                    {
                        label: '德尔塔',
                        data: deltas,
                        borderColor: 'rgba(75, 192, 192, 1)',
                        borderWidth: 2,
                        fill: false,
                        tension: 0.1
                    },
                    {
                        label: '伽马 (x100)',
                        data: gammas,
                        borderColor: 'rgba(255, 99, 132, 1)',
                        borderWidth: 2,
                        fill: false,
                        tension: 0.1
                    },
                    {
                        label: '西塔 (/10)',
                        data: thetas,
                        borderColor: 'rgba(255, 205, 86, 1)',
                        borderWidth: 2,
                        fill: false,
                        tension: 0.1
                    },
                    {
                        label: '维加',
                        data: vegas,
                        borderColor: 'rgba(54, 162, 235, 1)',
                        borderWidth: 2,
                        fill: false,
                        tension: 0.1
                    }
                ]
            },
            options: {
                responsive: true,
                plugins: {
                    title: {
                        display: true,
                        text: '希腊字母与股票价格关系'
                    }
                },
                scales: {
                    x: {
                        title: {
                            display: true,
                            text: '股票价格 ($)'
                        }
                    },
                    y: {
                        title: {
                            display: true,
                            text: '希腊字母值'
                        }
                    }
                }
            }
        });
    }
    
    // 数据源指示器
    function createDataSourceIndicators() {
        // 创建数据源指示器元素
        const mainDataSourceIndicator = document.createElement('div');
        mainDataSourceIndicator.id = 'dataSourceIndicator';
        mainDataSourceIndicator.className = 'data-source-indicator';
        
        const optionsContainer = document.querySelector('.options-container');
        if (optionsContainer) {
            optionsContainer.prepend(mainDataSourceIndicator);
        } else {
            console.warn('未找到期权容器 (.options-container)');
        }
        
        // 创建策略分析数据源指示器
        const strategyDataSourceIndicator = document.createElement('div');
        strategyDataSourceIndicator.id = 'strategyDataSourceIndicator';
        strategyDataSourceIndicator.className = 'data-source-indicator mb-2';
        
        const strategyContainer = document.querySelector('.strategy-container');
        if (strategyContainer) {
            strategyContainer.prepend(strategyDataSourceIndicator);
        } else {
            console.warn('未找到策略容器 (.strategy-container)');
        }
    }
    
    // 更新数据源指示器
    function updateDataSourceIndicator(isRealData) {
        const indicator = document.getElementById('dataSourceIndicator');
        const strategyIndicator = document.getElementById('strategyDataSourceIndicator');
        
        const currentSource = 'Finnhub';
        
        if (indicator) {
            indicator.innerHTML = `
                <div class="alert alert-${isRealData ? 'info' : 'warning'} py-1 small mb-2">
                    <i class="bi ${isRealData ? 'bi-cloud-download' : 'bi-exclamation-triangle'}"></i>
                    ${isRealData ? `使用${currentSource}市场数据` : '数据获取失败，请检查API密钥或网络连接'}
                </div>
            `;
            
            // 5秒后淡出
            setTimeout(() => {
                indicator.style.transition = 'opacity 1s';
                indicator.style.opacity = '0';
            }, 5000);
        }
        
        if (strategyIndicator) {
            strategyIndicator.innerHTML = `
                <div class="alert alert-${isRealData ? 'info' : 'warning'} py-1 small">
                    <i class="bi ${isRealData ? 'bi-cloud-download' : 'bi-exclamation-triangle'}"></i>
                    ${isRealData ? `使用${currentSource}市场数据` : '数据获取失败，请检查API密钥或网络连接'}
                </div>
            `;
            
            // 5秒后淡出
            setTimeout(() => {
                strategyIndicator.style.transition = 'opacity 1s';
                strategyIndicator.style.opacity = '0';
            }, 5000);
        }
    }
    
    // 配置API密钥
    function configureApiKey(source) {
        // 获取当前密钥
        const currentKey = apiService.getApiKey(source);
        
        const newKey = prompt(
            `请输入Finnhub API密钥:`, 
            currentKey || 'cju2rn9r01qr958213c0cju2rn9r01qr958213cg'
        );
        
        if (newKey !== null) {
            const formattedKey = newKey.trim();
            if (apiService.setApiKey(source, formattedKey)) {
                // 更新成功
                alert(`Finnhub密钥已更新!`);
                
                // 刷新数据
                if (apiService.dataSource === source) {
                    updateStockInfo().then(() => updateExpiryDates());
                }
            } else {
                alert('更新API密钥失败');
            }
        }
    }
    
    // 检查localStorage中是否有保存的API密钥
    if (localStorage.getItem('finnhubApiKey')) {
        apiService.finnhubKey = localStorage.getItem('finnhubApiKey');
        apiService.useRealOptionsData = true;
    }

    // 显示临时消息
    function showMessage(message, isWarning = false) {
        const messageDiv = document.createElement('div');
        messageDiv.className = `alert alert-${isWarning ? 'warning' : 'info'} alert-dismissible fade show`;
        messageDiv.role = 'alert';
        messageDiv.innerHTML = `
            ${message}
            <button type="button" class="btn-close" data-bs-dismiss="alert" aria-label="Close"></button>
        `;
        
        // 添加到页面
        const container = document.querySelector('.options-container');
        
        // 检查容器是否存在
        if (container) {
            container.insertBefore(messageDiv, container.firstChild);
            
            // 5秒后自动消失
            setTimeout(() => {
                messageDiv.classList.remove('show');
                setTimeout(() => messageDiv.remove(), 150);
            }, 5000);
        } else {
            // 容器不存在，仅记录到控制台
            console.log(`消息: ${message}`);
        }
    }

    // 清除候选列表
    function clearCandidateList() {
        candidateOptions = [];
        saveCandidatesToStorage(); // Save cleared list
        updateCandidatesList();
        
        // 取消所有选中的复选框
        document.querySelectorAll('#optionsData input[type="checkbox"]').forEach(checkbox => {
            checkbox.checked = false;
        });
        selectAllOptions.checked = false;
    }
    
    // 从候选列表中移除项目
    function removeFromCandidateList(optionId) {
        candidateOptions = candidateOptions.filter(option => option.id !== optionId);
        saveCandidatesToStorage(); // Save updated list
        updateCandidatesList();
    }
    
    // 初始化排序功能
    function initSortableTable() {
        const candidatesTable = document.getElementById('candidatesTable');
        if (!candidatesTable) {
            console.error('Candidates table not found');
            return;
        }

        const headers = candidatesTable.querySelectorAll('th.sortable');
        
        headers.forEach(header => {
            header.addEventListener('click', function() {
                const sortKey = this.getAttribute('data-sort');
                
                // 更新排序配置
                if (sortConfig.column === sortKey) {
                    // 已经按照这一列排序，则切换方向
                    sortConfig.direction = sortConfig.direction === 'asc' ? 'desc' : 'asc';
                } else {
                    // 设置新的排序列，默认升序
                    sortConfig.column = sortKey;
                    sortConfig.direction = 'asc';
                }
                
                // 移除所有排序指示器
                headers.forEach(h => {
                    h.classList.remove('sort-asc', 'sort-desc', 'active-sort');
                });
                
                // 添加新的排序指示器
                this.classList.add('active-sort');
                this.classList.add(sortConfig.direction === 'asc' ? 'sort-asc' : 'sort-desc');
                
                // 重新排序和更新列表
                updateCandidatesList();
                
                console.log(`Sorting by ${sortKey} in ${sortConfig.direction} order`);
            });
        });
    }
    
    // 用于排序的辅助函数
    function sortCandidates(candidates, column, direction) {
        // 如果没有指定排序列，不进行排序
        if (!column) return candidates;
        
        return [...candidates].sort((a, b) => {
            let valueA = a[column];
            let valueB = b[column];
            
            // 对于特殊列的处理
            if (column === 'sellerReturn') {
                // 卖方回报率可能是字符串，如 "10.5%"，需要转换为数字
                valueA = parseFloat(String(valueA).replace('%', '')) || 0;
                valueB = parseFloat(String(valueB).replace('%', '')) || 0;
            } else if (column === 'strike' || column === 'lastPrice' || column === 'bid' || 
                       column === 'ask' || column === 'impliedVolatility' || 
                       column === 'delta' || column === 'gamma' || column === 'theta' || 
                       column === 'vega') {
                // 确保数字列是数字类型
                valueA = parseFloat(valueA) || 0;
                valueB = parseFloat(valueB) || 0;
            } else if (column === 'volume' || column === 'openInterest') {
                // 整数列
                valueA = parseInt(valueA) || 0;
                valueB = parseInt(valueB) || 0;
            } else if (column === 'expiryDate') {
                // 日期列
                valueA = new Date(valueA).getTime();
                valueB = new Date(valueB).getTime();
            } else if (column === 'percentage') {
                // 百分比列，例如 "+10.5%"
                valueA = parseFloat(String(valueA).replace(/[+%]/g, '')) || 0;
                valueB = parseFloat(String(valueB).replace(/[+%]/g, '')) || 0;
            }
            
            // 比较值
            if (valueA < valueB) {
                return direction === 'asc' ? -1 : 1;
            }
            if (valueA > valueB) {
                return direction === 'asc' ? 1 : -1;
            }
            return 0;
        });
    }

    // 更新候选列表
    function updateCandidatesList() {
        console.log('Updating candidates list. Current candidates:', candidateOptions.length);
        
        if (candidateOptions.length === 0) {
            candidatesList.innerHTML = '<tr><td colspan="16" class="text-center">选择期权以添加到候选列表</td></tr>';
            return;
        }
        
        // 排序候选列表
        const sortedCandidates = sortCandidates(
            candidateOptions, 
            sortConfig.column, 
            sortConfig.direction
        );
        
        candidatesList.innerHTML = '';
        
        sortedCandidates.forEach(option => {
            console.log('Adding candidate to list:', option.id, option.strike);
            const row = document.createElement('tr');
            
            // 确保所有必要的属性都有默认值
            const strike = option.strike || 0;
            const lastPrice = option.lastPrice || 0;
            const bid = option.bid || 0;
            const ask = option.ask || 0;
            const volume = option.volume || 0;
            const openInterest = option.openInterest || 0;
            const impliedVolatility = option.impliedVolatility || 0;
            const delta = option.delta || 0;
            const gamma = option.gamma || 0;
            const theta = option.theta || 0;
            const vega = option.vega || 0;
            const percentageSign = option.percentageSign || '';
            const strikePercentage = option.strikePercentage || '0.00';
            const percentageClass = option.percentageClass || '';
            const sellerReturn = option.sellerReturn || '-';
            const sellerReturnClass = option.sellerReturnClass || '';
            const optionType = option.optionType || 'call';
            const expiryDate = option.expiryDate || '未知';
            
            // 设置行样式
            if (option.isNearATM) {
                row.classList.add('table-primary');
            } else if ((optionType === 'call' && strike < option.stockPrice) || 
                       (optionType === 'put' && strike > option.stockPrice)) {
                row.classList.add('table-success');
            } else {
                row.classList.add('table-light');
            }
            
            row.innerHTML = `
                <td><strong>${strike.toFixed(2)}</strong></td>
                <td class="${percentageClass}">${percentageSign}${strikePercentage}%</td>
                <td>${lastPrice.toFixed(2)}</td>
                <td>${bid.toFixed(2)}</td>
                <td>${ask.toFixed(2)}</td>
                <td class="${sellerReturnClass}">${sellerReturn}</td>
                <td>${volume.toLocaleString()}</td>
                <td>${openInterest ? openInterest.toLocaleString() : 'N/A'}</td>
                <td>${(impliedVolatility * 100).toFixed(1)}%</td>
                <td>${delta.toFixed(3)}</td>
                <td>${gamma.toFixed(4)}</td>
                <td>${theta.toFixed(3)}</td>
                <td>${vega.toFixed(3)}</td>
                <td class="text-nowrap">${expiryDate}</td>
                <td class="text-nowrap">${option.stockSymbol || 'N/A'}</td>
                <td>
                    <button class="btn btn-sm btn-danger" data-option-id="${option.id}">移除</button>
                </td>
            `;
            
            candidatesList.appendChild(row);
        });
        
        // 添加移除按钮事件监听器
        document.querySelectorAll('#candidatesList button').forEach(button => {
            button.addEventListener('click', function() {
                const optionId = this.getAttribute('data-option-id');
                removeFromCandidateList(optionId);
                
                // 取消对应的复选框的选中状态
                const checkbox = document.querySelector(`#optionsData input[data-option-id="${optionId}"]`);
                if (checkbox) {
                    checkbox.checked = false;
                }
            });
        });
    }
});