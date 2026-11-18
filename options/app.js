document.addEventListener('DOMContentLoaded', () => {
    const apiService = window.apiService;
    const analysis = window.OptionsAnalysis;
    const overviewSymbols = analysis.WATCHLIST;
    const stockSelect = document.getElementById('stockSelect');
    const expirySelect = document.getElementById('expirySelect');
    const expirySummary = document.getElementById('expirySummary');
    const currentPrice = document.getElementById('currentPrice');
    const priceChange = document.getElementById('priceChange');
    const refreshOverviewBtn = document.getElementById('refreshOverviewBtn');
    const gate = window.OptionsAsync.createRequestGate();
    let stockInputTimer;
    let loadedSymbol = '';

    function invalidateSelection() {
        clearTimeout(stockInputTimer);
        gate.cancel();
        loadedSymbol = '';
        window.optionsStockState = null;
        expirySelect.replaceChildren();
        currentPrice.textContent = '当前价格: --';
        priceChange.textContent = '涨跌幅: --';
        document.getElementById('stockDataStatus').textContent = '';
        expirySummary.textContent = stockSelect.value.trim() ? '正在读取到期日...' : '选择股票后自动读取';
        document.dispatchEvent(new CustomEvent('stockSelectionChanged'));
    }

    async function loadStockData() {
        clearTimeout(stockInputTimer);
        const symbol = stockSelect.value.trim().toUpperCase();
        if (!symbol || symbol === loadedSymbol) return;
        const run = gate.start();
        expirySummary.textContent = '正在读取到期日...';
        try {
            const [quote, optionsData] = await Promise.all([
                apiService.getStockPrice(symbol, { signal: run.signal }),
                apiService.getOptionsData(symbol, { signal: run.signal })
            ]);
            if (!gate.current(run) || symbol !== stockSelect.value.trim().toUpperCase()) return;
            const asOf = new Date().toISOString();
            const dates = [...new Set(optionsData.options.map(option => option.expiryDate))]
                .filter(date => analysis.daysToExpiry(date, asOf) >= 0).sort();
            expirySelect.replaceChildren(...dates.map(date => {
                const option = document.createElement('option');
                option.value = date;
                option.textContent = date + ' (' + analysis.daysToExpiry(date, asOf) + '天)';
                return option;
            }));
            currentPrice.textContent = '当前价格: $' + quote.price.toFixed(2);
            priceChange.textContent = '涨跌幅: ' + (quote.changePct >= 0 ? '+' : '') + quote.changePct.toFixed(2) + '%';
            priceChange.className = 'h6 ' + (quote.changePct >= 0 ? 'positive-change' : 'negative-change');
            const count = dates.filter(date => {
                const days = analysis.daysToExpiry(date, asOf);
                return days >= 14 && days <= 365;
            }).length;
            expirySummary.textContent = count + ' 个到期日可用于矩阵';
            document.getElementById('stockDataStatus').textContent = '股票行情 ' + (quote.sourceTimestamp || '未知') +
                '；期权行情 ' + (optionsData.sourceTimestamp || '未知') + '；缓存生成 ' + (optionsData.generatedAt || '未知') + '。源站时区未确认。';
            loadedSymbol = symbol;
            window.optionsStockState = { symbol, quote, optionsData, asOf };
            document.dispatchEvent(new CustomEvent('stockDataLoaded', { detail: window.optionsStockState }));
        } catch (error) {
            if (!gate.current(run)) return;
            expirySummary.textContent = '读取失败：' + error.message;
            document.getElementById('stockDataStatus').textContent = '未显示旧股票数据，请重试。';
        }
    }

    async function updateStockPriceOverview() {
        refreshOverviewBtn.disabled = true;
        refreshOverviewBtn.textContent = '加载中...';
        let index = 0;
        async function worker() {
            while (index < overviewSymbols.length) {
                const symbol = overviewSymbols[index++];
                const price = document.getElementById('price-' + symbol);
                const change = document.getElementById('change-' + symbol);
                const ytd = document.getElementById('ytd-' + symbol);
                try {
                    const quote = await apiService.getStockPrice(symbol, { force: true });
                    price.textContent = '$' + quote.price.toFixed(2);
                    price.title = '行情时间 ' + (quote.sourceTimestamp || '未知');
                    change.textContent = (quote.changePct >= 0 ? '+' : '') + quote.changePct.toFixed(2) + '%';
                    change.className = quote.changePct >= 0 ? 'positive-change' : 'negative-change';
                    try {
                        const data = await apiService.getYearToDateChange(symbol, quote.price);
                        ytd.textContent = (data.percent >= 0 ? '+' : '') + data.percent.toFixed(2) + '%';
                        ytd.className = data.percent >= 0 ? 'positive-change' : 'negative-change';
                        ytd.title = '基准日 ' + data.baseDate;
                    } catch {
                        ytd.textContent = '--';
                        ytd.className = '';
                        ytd.title = '年初基准不可用';
                    }
                } catch (error) {
                    price.textContent = '读取失败';
                    price.title = error.message;
                    change.textContent = ytd.textContent = '--';
                }
            }
        }
        try { await Promise.all(Array.from({ length: 3 }, worker)); }
        finally { refreshOverviewBtn.disabled = false; refreshOverviewBtn.textContent = '刷新'; }
    }

    function initStockOverviewTable() {
        const overviewTable = document.getElementById('overviewTable');
        if (!overviewTable) {
            console.error('overviewTable not found');
            return;
        }

        const tbody = overviewTable.tBodies[0];
        tbody.replaceChildren(...overviewSymbols.map(symbol => {
            const row = document.createElement('tr');
            row.dataset.symbol = symbol;
            const cell = row.insertCell();
            const link = document.createElement('a');
            link.href = 'https://stock.finance.sina.com.cn/usstock/quotes/' + symbol + '.html';
            link.target = '_blank';
            link.rel = 'noopener';
            link.textContent = symbol;
            cell.appendChild(link);
            for (const prefix of ['price', 'change', 'ytd']) {
                const value = row.insertCell();
                value.id = prefix + '-' + symbol;
                value.textContent = '--';
            }
            return row;
        }));
        document.getElementById('stockOptions')?.replaceChildren(
            ...window.OptionsAnalysis.SUPPORTED_SYMBOLS.map(symbol => {
                const option = document.createElement('option');
                option.value = symbol;
                return option;
            })
        );

        const headers = overviewTable.querySelectorAll('th.sortable');
        const overviewSortConfig = { column: null, direction: 'asc' };

        // 排序函数
        const sortOverviewRows = (column, direction) => {
            const tbody = overviewTable.tBodies[0];
            if (!tbody) return;
            const rows = Array.from(tbody.rows);
            rows.sort((a, b) => {
                let valA, valB;
                const symA = a.getAttribute('data-symbol');
                const symB = b.getAttribute('data-symbol');

                const numFromText = (text) => {
                    const match = text.match(/[-+]?\d*\.?\d+/);
                    return match ? parseFloat(match[0]) : 0;
                };

                if (column === 'symbol') {
                    valA = symA;
                    valB = symB;
                } else if (column === 'price') {
                    valA = numFromText(document.getElementById(`price-${symA}`).textContent);
                    valB = numFromText(document.getElementById(`price-${symB}`).textContent);
                } else if (column === 'change') {
                    valA = numFromText(document.getElementById(`change-${symA}`).textContent);
                    valB = numFromText(document.getElementById(`change-${symB}`).textContent);
                } else if (column === 'ytdChange') {
                    valA = numFromText(document.getElementById(`ytd-${symA}`).textContent);
                    valB = numFromText(document.getElementById(`ytd-${symB}`).textContent);
                }

                if (valA < valB) return direction === 'asc' ? -1 : 1;
                if (valA > valB) return direction === 'asc' ? 1 : -1;
                return 0;
            });

            rows.forEach(row => tbody.appendChild(row));
        };

        headers.forEach(header => {
            header.addEventListener('click', function() {
                const sortKey = this.getAttribute('data-sort');
                if (overviewSortConfig.column === sortKey) {
                    overviewSortConfig.direction = overviewSortConfig.direction === 'asc' ? 'desc' : 'asc';
                } else {
                    overviewSortConfig.column = sortKey;
                    overviewSortConfig.direction = 'asc';
                }

                headers.forEach(h => h.classList.remove('sort-asc', 'sort-desc', 'active-sort'));
                this.classList.add('active-sort');
                this.classList.add(overviewSortConfig.direction === 'asc' ? 'sort-asc' : 'sort-desc');

                sortOverviewRows(overviewSortConfig.column, overviewSortConfig.direction);
            });
        });

        // 行点击事件: 设置股票选择
        Array.from(overviewTable.tBodies[0].rows).forEach(row => {
            row.addEventListener('click', function(event) {
                if (event.target.closest('a')) return;
                const sym = this.getAttribute('data-symbol');
                if (!sym) return;
                stockSelect.value = sym;
                const changeEvent = new Event('change');
                stockSelect.dispatchEvent(changeEvent);
                // 滚动到顶部，方便查看主信息
                window.scrollTo({ top: 0, behavior: 'smooth' });
            });
        });
    }

    const theme = document.getElementById('theme-toggle');
    let savedTheme;
    try { savedTheme = localStorage.getItem('theme'); } catch {}
    theme.checked = savedTheme ? savedTheme === 'dark' : window.matchMedia('(prefers-color-scheme: dark)').matches;
    const applyTheme = () => {
        const value = theme.checked ? 'dark' : 'light';
        document.documentElement.dataset.theme = value;
        document.documentElement.dataset.bsTheme = value;
        try { localStorage.setItem('theme', value); } catch {}
    };
    applyTheme();
    theme.addEventListener('change', applyTheme);
    stockSelect.addEventListener('input', () => {
        invalidateSelection();
        if (stockSelect.value.trim()) stockInputTimer = setTimeout(loadStockData, 600);
    });
    stockSelect.addEventListener('change', () => {
        invalidateSelection();
        loadStockData();
    });
    refreshOverviewBtn.addEventListener('click', updateStockPriceOverview);
    initStockOverviewTable();
    updateStockPriceOverview();
    if (stockSelect.value.trim()) loadStockData();

});
