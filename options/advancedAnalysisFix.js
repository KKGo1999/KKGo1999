(function() {
    function escapeHtml(value) {
        return String(value).replace(/[&<>"']/g, char => ({
            '&': '&amp;',
            '<': '&lt;',
            '>': '&gt;',
            '"': '&quot;',
            "'": '&#39;'
        }[char]));
    }

    function getCurrentTheme() {
        return document.documentElement.getAttribute('data-theme') ||
            localStorage.getItem('theme') ||
            'light';
    }

    function createAnalysisWindow(symbol, optionType, theme) {
        const win = window.open('', '_blank');
        if (!win) {
            alert('无法打开新窗口，请检查浏览器弹窗设置');
            return null;
        }

        const doc = win.document;
        doc.title = `${symbol} 高级分析`;
        doc.documentElement.setAttribute('data-theme', theme);
        doc.documentElement.style.colorScheme = theme === 'dark' ? 'dark' : 'light';

        const bootstrapLink = doc.createElement('link');
        bootstrapLink.rel = 'stylesheet';
        bootstrapLink.href = 'https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/css/bootstrap.min.css';
        doc.head.appendChild(bootstrapLink);

        const appStylesLink = doc.createElement('link');
        appStylesLink.rel = 'stylesheet';
        appStylesLink.href = new URL('styles.css', window.location.href).href;
        doc.head.appendChild(appStylesLink);

        const style = doc.createElement('style');
        style.textContent = [
            'body{background-color:var(--bg-color,#f8f9fa);color:var(--text-color,#212529);}',
            '.table-container{position:relative;max-height:70vh;overflow:auto;}',
            '#resultTable thead th{position:sticky;top:0;z-index:3;background:var(--table-header-bg,var(--bs-body-bg,#fff));}',
            '#resultTable th:first-child,#resultTable td:first-child{position:sticky;left:0;z-index:2;background:var(--card-bg,var(--bs-body-bg,#fff));}',
            '#resultTable thead th:first-child{z-index:4;background:var(--table-header-bg,var(--bs-body-bg,#fff));}',
            '[data-theme="dark"] #resultTable .table-warning{--bs-table-bg:rgba(255,193,7,.22);--bs-table-color:var(--text-color);background-color:rgba(255,193,7,.22)!important;color:var(--text-color)!important;}',
            '[data-theme="dark"] #resultTable .text-success{color:var(--positive-color,#42d86c)!important;}'
        ].join('');
        doc.head.appendChild(style);

        const container = doc.createElement('div');
        container.className = 'container my-3';
        container.innerHTML =
            `<h3>高级卖方回报率分析 - ${escapeHtml(symbol)} (${optionType.toUpperCase()})</h3>` +
            '<div class="mb-3">执行价范围：' +
            '<input type="number" id="minStrike" placeholder="Min" class="form-control d-inline-block" style="width:110px;">' +
            '<span class="mx-2">-</span>' +
            '<input type="number" id="maxStrike" placeholder="Max" class="form-control d-inline-block" style="width:110px;">' +
            '<button id="applyStrikeFilter" class="btn btn-sm btn-primary ms-2">过滤</button>' +
            '</div>' +
            '<div id="progressText" class="mb-2">加载进度: 0 / 0 (0%)</div>' +
            '<div id="analysisContent" class="mt-4">数据加载中...</div>';
        doc.body.appendChild(container);

        return win;
    }

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

        const optionType = callOption && callOption.checked ? 'call' : 'put';
        const win = createAnalysisWindow(symbol, optionType, getCurrentTheme());
        if (!win) return;

        try {
            const apiService = window.apiService || new APIService();
            const today = new Date();
            const stockData = await apiService.getStockPrice(symbol);
            const stockPrice = stockData.price;
            const matrix = {};
            const bidMatrix = {};
            const progressElem = win.document.getElementById('progressText');

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

                if (progressElem) {
                    const pct = (((idx + 1) / validDates.length) * 100).toFixed(0);
                    progressElem.textContent = `加载进度: ${idx + 1} / ${validDates.length} (${pct}%)`;
                }
            }

            const strikes = Object.keys(matrix).map(Number).sort((a, b) => a - b);
            let html = '<div class="table-container"><table id="resultTable" class="table table-sm table-bordered text-center align-middle">';
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
            win.document.getElementById('analysisContent').innerHTML = html;
            if (progressElem && progressElem.parentNode) {
                progressElem.parentNode.removeChild(progressElem);
            }

            const minInput = win.document.getElementById('minStrike');
            const maxInput = win.document.getElementById('maxStrike');
            if (minInput && maxInput && strikes.length > 0) {
                const minAvail = Math.min(...strikes);
                const maxAvail = Math.max(...strikes);
                let recommendedMin = Math.min(Math.max(Math.ceil(0.65 * stockPrice), minAvail), maxAvail);
                let recommendedMax = Math.max(Math.min(Math.floor(0.9 * stockPrice), maxAvail), minAvail);

                if (recommendedMin > recommendedMax) {
                    [recommendedMin, recommendedMax] = [recommendedMax, recommendedMin];
                }

                minInput.value = recommendedMin;
                maxInput.value = recommendedMax;
            }

            const applyStrikeFilter = win.document.getElementById('applyStrikeFilter');
            if (applyStrikeFilter) {
                applyStrikeFilter.addEventListener('click', function() {
                    const min = parseFloat(win.document.getElementById('minStrike').value) || -Infinity;
                    const max = parseFloat(win.document.getElementById('maxStrike').value) || Infinity;
                    win.document.querySelectorAll('#resultTable tbody tr').forEach(row => {
                        const strike = parseFloat(row.getAttribute('data-strike'));
                        row.style.display = (strike >= min && strike <= max) ? '' : 'none';
                    });
                });
                applyStrikeFilter.click();
            }
        } catch (error) {
            console.error('高级分析失败:', error);
            const analysisContent = win.document.getElementById('analysisContent');
            if (analysisContent) {
                analysisContent.innerHTML = `<div class="alert alert-danger">分析过程中发生错误: ${escapeHtml(error.message)}</div>`;
            }
        }
    }

    document.addEventListener('DOMContentLoaded', () => {
        const button = document.getElementById('advancedAnalysisBtn');
        if (button) {
            button.addEventListener('click', openAdvancedAnalysis, true);
        }
    });
})();
