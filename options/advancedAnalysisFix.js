(function() {
    let analysisRunId = 0;
    let autoAnalysisTimer = null;

    function getValidExpiryDates(expirySelect) {
        if (!expirySelect) return [];

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
            collapse: document.getElementById('collapseAdvancedAnalysis'),
            metrics: {
                symbol: document.getElementById('advancedMetricSymbol'),
                type: document.getElementById('advancedMetricType'),
                price: document.getElementById('advancedMetricPrice'),
                dates: document.getElementById('advancedMetricDates'),
                strikes: document.getElementById('advancedMetricStrikes'),
                visibleRows: document.getElementById('advancedMetricVisibleRows')
            }
        };
    }

    function setText(element, value) {
        if (element) element.textContent = value;
    }

    function setMetric(elements, name, value) {
        if (elements.metrics && elements.metrics[name]) {
            elements.metrics[name].textContent = value;
        }
    }

    function formatOptionType(optionType) {
        return optionType === 'call' ? 'CALL' : 'PUT';
    }

    function delay(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    async function waitForValidExpiryDates(expirySelect, timeoutMs = 10000) {
        const start = Date.now();

        while (Date.now() - start < timeoutMs) {
            const validDates = getValidExpiryDates(expirySelect);
            if (validDates.length > 0) return validDates;

            const statusText = expirySelect && expirySelect.options[0] ? expirySelect.options[0].textContent : '';
            if (/失败|无可用/.test(statusText)) return [];
            await delay(100);
        }

        return getValidExpiryDates(expirySelect);
    }

    function showSection(elements, symbol, optionType, validDates, loadingText = '正在加载期权链数据...') {
        elements.section.classList.remove('d-none');
        setText(elements.title, `${symbol.toUpperCase()} 卖方回报率矩阵`);
        setText(elements.subtitle, `${formatOptionType(optionType)} | 14-365天到期 | 年化回报率`);
        setText(elements.progress, validDates.length > 0 ? `0/${validDates.length}` : '准备中');
        setMetric(elements, 'symbol', symbol.toUpperCase());
        setMetric(elements, 'type', formatOptionType(optionType));
        setMetric(elements, 'price', '--');
        setMetric(elements, 'dates', validDates.length > 0 ? `${validDates.length} 个` : '--');
        setMetric(elements, 'strikes', '--');
        setMetric(elements, 'visibleRows', '--');
        elements.content.innerHTML = [
            '<div class="advanced-empty-state">',
            '<div class="advanced-spinner" aria-hidden="true"></div>',
            `<div>${loadingText}</div>`,
            '</div>'
        ].join('');
        elements.section.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }

    function getFilterBounds(elements) {
        const minValue = elements.minStrike && elements.minStrike.value.trim();
        const maxValue = elements.maxStrike && elements.maxStrike.value.trim();
        const min = minValue === '' ? -Infinity : parseFloat(minValue);
        const max = maxValue === '' ? Infinity : parseFloat(maxValue);

        return {
            min: Number.isFinite(min) ? min : -Infinity,
            max: Number.isFinite(max) ? max : Infinity
        };
    }

    function updateVisibleRowsMetric(elements) {
        const rows = Array.from(document.querySelectorAll('#advancedResultTable tbody tr'));
        if (!rows.length) {
            setMetric(elements, 'visibleRows', '--');
            return;
        }

        const visibleRows = rows.filter(row => row.style.display !== 'none').length;
        setMetric(elements, 'visibleRows', `${visibleRows}/${rows.length}`);
    }

    function applyStrikeFilter(elements) {
        const { min, max } = getFilterBounds(elements);

        document.querySelectorAll('#advancedResultTable tbody tr').forEach(row => {
            const strike = parseFloat(row.getAttribute('data-strike'));
            row.style.display = (strike >= min && strike <= max) ? '' : 'none';
        });

        updateVisibleRowsMetric(elements);
    }

    function setRecommendedStrikeRange(elements, strikes, stockPrice, optionType) {
        if (!strikes.length) return;

        const minAvail = Math.min(...strikes);
        const maxAvail = Math.max(...strikes);
        const lowerRatio = optionType === 'call' ? 1.05 : 0.65;
        const upperRatio = optionType === 'call' ? 1.35 : 0.9;
        let recommendedMin = Math.min(Math.max(Math.ceil(lowerRatio * stockPrice), minAvail), maxAvail);
        let recommendedMax = Math.max(Math.min(Math.floor(upperRatio * stockPrice), maxAvail), minAvail);

        if (recommendedMin > recommendedMax) {
            [recommendedMin, recommendedMax] = [recommendedMax, recommendedMin];
        }

        elements.minStrike.value = recommendedMin;
        elements.maxStrike.value = recommendedMax;
    }

    function renderMatrix(elements, symbol, optionType, validDates, stockPrice, matrix, bidMatrix) {
        const strikes = Object.keys(matrix).map(Number).sort((a, b) => a - b);
        setMetric(elements, 'price', stockPrice.toFixed(2));
        setMetric(elements, 'dates', `${validDates.length} 个`);
        setMetric(elements, 'strikes', `${strikes.length} 个`);

        if (!strikes.length) {
            elements.content.innerHTML = '<div class="advanced-empty-state">没有可用的买价数据，无法生成回报率矩阵。</div>';
            updateVisibleRowsMetric(elements);
            setText(elements.progress, '无数据');
            return;
        }

        let html = [
            '<div class="advanced-analysis-table-container" role="region" aria-label="高级分析矩阵" tabindex="0">',
            '<table id="advancedResultTable" class="table table-sm table-bordered text-center align-middle advanced-matrix-table">',
            '<thead><tr>',
            '<th class="advanced-sticky-col" scope="col">执行价</th>',
            '<th scope="col">相对差</th>'
        ].join('');

        validDates.forEach(date => {
            html += `<th class="advanced-date-col" scope="col">${date}</th>`;
        });

        html += '</tr></thead><tbody>';

        strikes.forEach(strike => {
            const diffValue = (strike / stockPrice) * 100 - 100;
            const diffClass = diffValue >= 0 ? 'advanced-diff-positive' : 'advanced-diff-negative';
            html += [
                `<tr data-strike="${strike}">`,
                `<td class="advanced-sticky-col advanced-strike-cell"><strong>${strike.toFixed(2)}</strong></td>`,
                `<td class="${diffClass}">${diffValue.toFixed(2)}%</td>`
            ].join('');

            const returnsArr = validDates.map(date => matrix[strike][date]);
            const topIdx = [...returnsArr.entries()]
                .filter(([, value]) => value !== undefined)
                .sort((a, b) => b[1] - a[1])
                .slice(0, 3)
                .map(([idx]) => idx);

            validDates.forEach((date, idx) => {
                const val = matrix[strike][date];
                const bidVal = bidMatrix[strike] ? bidMatrix[strike][date] : undefined;
                const classes = ['advanced-matrix-cell'];
                let cell = '<span class="advanced-empty-cell">--</span>';

                if (val !== undefined) {
                    if (val >= 15) {
                        classes.push('is-strong');
                    } else if (val >= 8) {
                        classes.push('is-good');
                    }

                    if (topIdx.includes(idx)) classes.push('is-top');

                    cell = `<span class="advanced-return">${val.toFixed(2)}%</span>`;
                    if (bidVal !== undefined) {
                        cell += `<span class="advanced-bid">买 ${bidVal.toFixed(2)}</span>`;
                    }
                }

                html += `<td class="${classes.join(' ')}">${cell}</td>`;
            });

            html += '</tr>';
        });

        html += '</tbody></table></div>';
        elements.content.innerHTML = html;
        setRecommendedStrikeRange(elements, strikes, stockPrice, optionType);
        applyStrikeFilter(elements);
        setText(elements.progress, '完成');
    }

    async function openAdvancedAnalysis(event, options = {}) {
        if (event) {
            event.preventDefault();
            event.stopImmediatePropagation();
        }

        const stockSelect = document.getElementById('stockSelect');
        const expirySelect = document.getElementById('expirySelect');
        const callOption = document.getElementById('callOption');
        const symbol = stockSelect ? stockSelect.value.trim() : '';
        const silent = options.silent === true;

        if (!symbol) {
            if (!silent) alert('请先选择股票代码');
            return;
        }

        const elements = getElements();
        if (!elements.section || !elements.content) {
            console.error('高级分析结果区域不存在');
            return;
        }

        const runId = ++analysisRunId;
        const optionType = callOption && callOption.checked ? 'call' : 'put';

        let validDates = getValidExpiryDates(expirySelect);
        if (options.waitForDates && validDates.length === 0) {
            showSection(elements, symbol, optionType, [], '正在读取可用到期日...');
            validDates = await waitForValidExpiryDates(expirySelect);
            if (runId !== analysisRunId) return;
        }

        if (validDates.length === 0) {
            if (!silent) alert('没有14至365天之间的有效到期日');
            elements.section.classList.remove('d-none');
            setText(elements.title, `${symbol.toUpperCase()} 卖方回报率矩阵`);
            setText(elements.subtitle, `${formatOptionType(optionType)} | 14-365天到期 | 年化回报率`);
            setText(elements.progress, '无到期日');
            elements.content.innerHTML = '<div class="advanced-empty-state">没有14至365天之间的有效到期日。</div>';
            return;
        }

        showSection(elements, symbol, optionType, validDates);

        try {
            const apiService = window.apiService || new APIService();
            const today = new Date();
            const stockData = await apiService.getStockPrice(symbol);
            if (runId !== analysisRunId) return;
            const stockPrice = stockData.price;
            const matrix = {};
            const bidMatrix = {};

            for (let idx = 0; idx < validDates.length; idx += 1) {
                const expiry = validDates[idx];
                try {
                    const chain = await apiService.getOptionsChain(symbol, expiry, optionType);
                    if (runId !== analysisRunId) return;
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
                setText(elements.progress, `${idx + 1}/${validDates.length} (${pct}%)`);
            }

            if (runId !== analysisRunId) return;
            renderMatrix(elements, symbol, optionType, validDates, stockPrice, matrix, bidMatrix);
        } catch (error) {
            if (runId !== analysisRunId) return;
            console.error('高级分析失败:', error);
            setText(elements.progress, '加载失败');
            elements.content.innerHTML = '<div class="advanced-empty-state advanced-empty-state-error"></div>';
            elements.content.querySelector('.advanced-empty-state-error').textContent = `分析过程中发生错误: ${error.message}`;
        }
    }

    function scheduleAutomaticAnalysis() {
        const stockSelect = document.getElementById('stockSelect');
        const symbol = stockSelect ? stockSelect.value.trim() : '';
        if (!symbol) return;

        window.clearTimeout(autoAnalysisTimer);
        autoAnalysisTimer = window.setTimeout(() => {
            openAdvancedAnalysis(null, { silent: true, waitForDates: true });
        }, 250);
    }

    document.addEventListener('DOMContentLoaded', () => {
        const button = document.getElementById('advancedAnalysisBtn');
        const stockSelect = document.getElementById('stockSelect');
        const callOption = document.getElementById('callOption');
        const putOption = document.getElementById('putOption');
        const elements = getElements();

        if (button) {
            button.addEventListener('click', event => openAdvancedAnalysis(event, { waitForDates: true }), true);
        }

        document.addEventListener('stockDataLoaded', scheduleAutomaticAnalysis);

        [callOption, putOption].forEach(input => {
            if (input) input.addEventListener('change', scheduleAutomaticAnalysis);
        });

        if (stockSelect && stockSelect.value.trim()) {
            scheduleAutomaticAnalysis();
        }

        if (elements.applyFilter) {
            elements.applyFilter.addEventListener('click', () => applyStrikeFilter(getElements()));
        }

        [elements.minStrike, elements.maxStrike].forEach(input => {
            if (!input) return;
            input.addEventListener('keydown', event => {
                if (event.key === 'Enter') {
                    event.preventDefault();
                    applyStrikeFilter(getElements());
                }
            });
        });

        if (elements.collapse && elements.section) {
            elements.collapse.addEventListener('click', () => {
                elements.section.classList.add('d-none');
            });
        }
    });
})();
