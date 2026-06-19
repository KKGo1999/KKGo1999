(function() {
    function getValidExpiryDates(expirySelect) {
        const today = new Date();
        return Array.from(expirySelect.options)
            .map(option => option.value)
            .filter(Boolean)
            .filter(dateStr => {
                const expiry = new Date(dateStr);
                const diff = Math.ceil((expiry - today) / (1000 * 60 * 60 * 24));
                return diff >= 14 && diff <= 365;
            });
    }

    function getElements() {
        return {
            section: document.getElementById('advancedAnalysisSection'),
            title: document.getElementById('advancedAnalysisTitle'),
            subtitle: document.getElementById('advancedAnalysisSubtitle'),
            progress: document.getElementById('advancedAnalysisProgress'),
            content: document.getElementById('advancedAnalysisContent'),
            minStrike: document.getElementById('advancedMinStrike'),
            maxStrike: document.getElementById('advancedMaxStrike'),
            applyFilter: document.getElementById('applyAdvancedStrikeFilter'),
            collapse: document.getElementById('collapseAdvancedAnalysis')
        };
    }

    function showSection(elements, symbol, optionType) {
        elements.section.classList.remove('d-none');
        elements.title.textContent = `高级卖方回报率分析 - ${symbol}`;
        elements.subtitle.textContent = `${optionType.toUpperCase()} | 14-365天到期`;
        elements.progress.textContent = '加载进度: 0 / 0 (0%)';
        elements.content.innerHTML = '<div class="text-center py-4">数据加载中...</div>';
        elements.section.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }

    function applyStrikeFilter(elements) {
        const min = parseFloat(elements.minStrike.value) || -Infinity;
        const max = parseFloat(elements.maxStrike.value) || Infinity;
        document.querySelectorAll('#advancedResultTable tbody tr').forEach(row => {
            const strike = parseFloat(row.getAttribute('data-strike'));
            row.style.display = (strike >= min && strike <= max) ? '' : 'none';
        });
    }

    function setRecommendedStrikeRange(elements, strikes, stockPrice) {
        if (!strikes.length) return;

        const minAvail = Math.min(...strikes);
        const maxAvail = Math.max(...strikes);
        let recommendedMin = Math.min(Math.max(Math.ceil(0.65 * stockPrice), minAvail), maxAvail);
        let recommendedMax = Math.max(Math.min(Math.floor(0.9 * stockPrice), maxAvail), minAvail);

        if (recommendedMin > recommendedMax) {
            [recommendedMin, recommendedMax] = [recommendedMax, recommendedMin];
        }

        elements.minStrike.value = recommendedMin;
        elements.maxStrike.value = recommendedMax;
    }

    function renderMatrix(elements, validDates, stockPrice, matrix, bidMatrix) {
        const strikes = Object.keys(matrix).map(Number).sort((a, b) => a - b);
        let html = '<div class="advanced-analysis-table-container"><table id="advancedResultTable" class="table table-sm table-bordered text-center align-middle">';
        html += '<thead><tr><th>价格</th><th>相对差%</th>';

        validDates.forEach(date => {
            html += `<th class="text-nowrap">${date}</th>`;
        });

        html += '</tr></thead><tbody>';

        strikes.forEach(strike => {
            const diffPerc = ((strike / stockPrice) * 100 - 100).toFixed(2);
            html += `<tr data-strike="${strike}"><td><strong>${strike.toFixed(2)}</strong></td><td>${diffPerc}%</td>`;

            const returnsArr = validDates.map(date => matrix[strike][date]);
            const topIdx = [...returnsArr.entries()]
                .filter(([, value]) => value !== undefined)
                .sort((a, b) => b[1] - a[1])
                .slice(0, 3)
                .map(([idx]) => idx);

            validDates.forEach((date, idx) => {
                const val = matrix[strike][date];
                const bidVal = bidMatrix[strike] ? bidMatrix[strike][date] : undefined;
                let cell = '--';
                let cls = '';

                if (val !== undefined) {
                    cell = `${val.toFixed(2)}%`;
                    if (bidVal !== undefined) {
                        cell += ` (${bidVal.toFixed(2)})`;
                    }
                    cls = val >= 15 ? 'text-success fw-bold' : (val >= 8 ? 'text-success' : '');
                    if (topIdx.includes(idx)) cls += ' table-warning';
                }

                html += `<td class="${cls}">${cell}</td>`;
            });

            html += '</tr>';
        });

        html += '</tbody></table></div>';
        elements.content.innerHTML = html;
        setRecommendedStrikeRange(elements, strikes, stockPrice);
        applyStrikeFilter(elements);
        elements.progress.textContent = `完成: ${validDates.length} 个到期日 / ${strikes.length} 个执行价`;
    }

    async function openAdvancedAnalysis(event) {
        event.preventDefault();
        event.stopImmediatePropagation();

        const stockSelect = document.getElementById('stockSelect');
        const expirySelect = document.getElementById('expirySelect');
        const callOption = document.getElementById('callOption');
        const symbol = stockSelect ? stockSelect.value.trim() : '';

        if (!symbol) {
            alert('请先选择股票代码');
            return;
        }

        const validDates = getValidExpiryDates(expirySelect);
        if (validDates.length === 0) {
            alert('没有14至365天之间的有效到期日');
            return;
        }

        const elements = getElements();
        if (!elements.section || !elements.content) {
            console.error('高级分析结果区域不存在');
            return;
        }

        const optionType = callOption && callOption.checked ? 'call' : 'put';
        showSection(elements, symbol, optionType);

        try {
            const apiService = window.apiService || new APIService();
            const today = new Date();
            const stockData = await apiService.getStockPrice(symbol);
            const stockPrice = stockData.price;
            const matrix = {};
            const bidMatrix = {};

            for (let idx = 0; idx < validDates.length; idx += 1) {
                const expiry = validDates[idx];
                try {
                    const chain = await apiService.getOptionsChain(symbol, expiry, optionType);
                    const expiryDateObj = new Date(expiry);
                    const daysToExpiry = Math.max(1, Math.ceil((expiryDateObj - today) / (1000 * 60 * 60 * 24)));

                    chain.forEach(option => {
                        const bid = option.bid || 0;
                        if (bid === 0) return;

                        const premium = bid * 100 - 1.0;
                        const collateral = optionType === 'put' ? option.strike * 100 : stockPrice * 100;
                        const annualReturn = (premium / collateral) * (365 / daysToExpiry) * 100;

                        if (!bidMatrix[option.strike]) bidMatrix[option.strike] = {};
                        bidMatrix[option.strike][expiry] = bid;

                        if (!matrix[option.strike]) matrix[option.strike] = {};
                        matrix[option.strike][expiry] = annualReturn;
                    });
                } catch (error) {
                    console.error('获取期权链失败', symbol, expiry, error);
                }

                const pct = (((idx + 1) / validDates.length) * 100).toFixed(0);
                elements.progress.textContent = `加载进度: ${idx + 1} / ${validDates.length} (${pct}%)`;
            }

            renderMatrix(elements, validDates, stockPrice, matrix, bidMatrix);
        } catch (error) {
            console.error('高级分析失败:', error);
            elements.progress.textContent = '加载失败';
            elements.content.innerHTML = '<div class="alert alert-danger"></div>';
            elements.content.querySelector('.alert').textContent = `分析过程中发生错误: ${error.message}`;
        }
    }

    document.addEventListener('DOMContentLoaded', () => {
        const button = document.getElementById('advancedAnalysisBtn');
        const elements = getElements();

        if (button) {
            button.addEventListener('click', openAdvancedAnalysis, true);
        }

        if (elements.applyFilter) {
            elements.applyFilter.addEventListener('click', () => applyStrikeFilter(getElements()));
        }

        if (elements.collapse && elements.section) {
            elements.collapse.addEventListener('click', () => {
                elements.section.classList.add('d-none');
            });
        }
    });
})();
