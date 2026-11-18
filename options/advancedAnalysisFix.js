(function() {
    const analysis = window.OptionsAnalysis;
    const gate = window.OptionsAsync.createRequestGate();
    let autoAnalysisTimer = null;

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

    function showSection(elements, symbol, optionType, validDates, loadingText = '正在加载期权链数据...') {
        elements.section.classList.remove('d-none');
        setText(elements.title, `${symbol.toUpperCase()} 卖方回报率矩阵`);
        setText(elements.subtitle, `${formatOptionType(optionType)} | 14-365天到期 | 权利金简单年化`);
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
        const upperRatio = optionType === 'call' ? 1.35 : 0.85;

        const nearestStrike = target => strikes.reduce((closest, strike) => {
            return Math.abs(strike - target) < Math.abs(closest - target) ? strike : closest;
        }, strikes[0]);

        let recommendedMin = nearestStrike(Math.min(Math.max(lowerRatio * stockPrice, minAvail), maxAvail));
        let recommendedMax = nearestStrike(Math.min(Math.max(upperRatio * stockPrice, minAvail), maxAvail));

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
        event?.preventDefault();
        const symbol = document.getElementById('stockSelect').value.trim().toUpperCase();
        const elements = getElements();
        if (!symbol) return;
        const run = gate.start();
        const optionType = document.getElementById('callOption').checked ? 'call' : 'put';
        showSection(elements, symbol, optionType, []);
        try {
            let state = window.optionsStockState;
            if (options.force || !state || state.symbol !== symbol) {
                const [quote, optionsData] = await Promise.all([
                    window.apiService.getStockPrice(symbol, { signal: run.signal, force: !!options.force }),
                    window.apiService.getOptionsData(symbol, { signal: run.signal, force: !!options.force })
                ]);
                state = { symbol, quote, optionsData };
            }
            if (!gate.current(run) || symbol !== document.getElementById('stockSelect').value.trim().toUpperCase()) return;
            const asOf = new Date().toISOString();
            const source = {
                symbol, stockRetrievedAt: state.quote.retrievedAt, stockSourceTimestamp: state.quote.sourceTimestamp,
                optionsGeneratedAt: state.optionsData.generatedAt, optionsSnapshotId: state.optionsData.snapshotId,
                optionsSourceTimestamp: state.optionsData.sourceTimestamp, optionsMode: state.optionsData.mode
            };
            const quality = analysis.assessDataQuality([source], asOf);
            const validDates = [...new Set(state.optionsData.options.map(option => option.expiryDate))]
                .filter(date => {
                    const days = analysis.daysToExpiry(date, asOf);
                    return days >= 14 && days <= 365;
                }).sort();
            const matrix = {};
            const bidMatrix = {};
            for (const option of state.optionsData.options) {
                if (option.optionType !== optionType || !validDates.includes(option.expiryDate)) continue;
                const metrics = analysis.optionMetrics(symbol, state.quote.price, option, asOf);
                if (!metrics) continue;
                if (!matrix[option.strike]) { matrix[option.strike] = {}; bidMatrix[option.strike] = {}; }
                matrix[option.strike][option.expiryDate] = metrics.annualReturn;
                bidMatrix[option.strike][option.expiryDate] = metrics.bid;
            }
            renderMatrix(elements, symbol, optionType, validDates, state.quote.price, matrix, bidMatrix);
            const note = document.createElement('p');
            note.className = quality.requiresConfirmation ? 'alert alert-warning' : 'data-time-note';
            note.textContent = '股票行情 ' + (source.stockSourceTimestamp || '未知') + '；期权行情 ' +
                (source.optionsSourceTimestamp || '未知') + '；缓存生成 ' + (source.optionsGeneratedAt || '未知') +
                '。源站时区未确认；权利金简单年化不等于总收益。' + quality.issues.join(' ');
            elements.content.prepend(note);
        } catch (error) {
            if (!gate.current(run)) return;
            setText(elements.progress, '加载失败');
            elements.content.textContent = '分析失败：' + error.message;
        }
    }

    function scheduleAutomaticAnalysis() {
        const stockSelect = document.getElementById('stockSelect');
        const symbol = stockSelect ? stockSelect.value.trim() : '';
        if (!symbol) return;

        window.clearTimeout(autoAnalysisTimer);
        autoAnalysisTimer = window.setTimeout(() => {
            openAdvancedAnalysis(null);
        }, 250);
    }

    document.addEventListener('DOMContentLoaded', () => {
        const button = document.getElementById('advancedAnalysisBtn');
        const stockSelect = document.getElementById('stockSelect');
        const callOption = document.getElementById('callOption');
        const putOption = document.getElementById('putOption');
        const elements = getElements();

        if (button) {
            button.addEventListener('click', event => openAdvancedAnalysis(event, { force: true }));
        }

        document.addEventListener('stockDataLoaded', scheduleAutomaticAnalysis);
        document.addEventListener('stockSelectionChanged', () => {
            gate.cancel();
            clearTimeout(autoAnalysisTimer);
            elements.section.classList.add('d-none');
        });

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
