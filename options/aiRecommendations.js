(function() {
    const analysis = window.OptionsAnalysis;
    const providers = window.OptionsAI.PROVIDERS;
    const historyStore = window.OptionsHistory.createStore();
    let historyEntries = [];
    let selectedProvider = 'glm';
    const keyDrafts = { glm: '', openai: '' };
    const modelDrafts = { glm: 'glm-5.3', openai: 'gpt-6.2-sol' };
    let activeController = null;
    const DEFAULT_CANDIDATE_SORT = { column: 'rank', direction: 'asc' };
    const SETTING_INPUTS = {
        strategyType: 'aiStrategyType', riskProfile: 'aiRiskProfile',
        minDays: 'aiMinDays', maxDays: 'aiMaxDays', minBid: 'aiMinBid',
        minAnnualReturn: 'aiMinAnnualReturn', minStrikePct: 'aiMinStrikePct',
        maxStrikePct: 'aiMaxStrikePct', minOpenInterest: 'aiMinOpenInterest',
        maxSpreadPct: 'aiMaxSpread', candidateLimit: 'aiCandidateLimit',
        perSymbolLimit: 'aiPerSymbolLimit'
    };
    const CANDIDATE_SORT_COLUMNS = new Set([
        'rank',
        'localScore',
        'symbol',
        'expiryDate',
        'strike',
        'bid',
        'spreadPct',
        'annualReturn',
        'collateral',
        'breakEven',
        'openInterest',
        'volume'
    ]);

    let activeRunId = 0;
    let latestLocalScan = null;
    let latestCandidateSettings = null;
    let latestScanSignature = '';
    let candidateSortConfig = { ...DEFAULT_CANDIDATE_SORT };

    function $(id) {
        return document.getElementById(id);
    }

    function escapeHtml(value) {
        return String(value ?? '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
    }

    function clamp(value, min, max) {
        return Math.min(max, Math.max(min, value));
    }

    function formatPct(value, digits = 2) {
        if (!Number.isFinite(value)) return '--';
        const sign = value > 0 ? '+' : '';
        return `${sign}${value.toFixed(digits)}%`;
    }

    function formatMoney(value, digits = 2) {
        if (!Number.isFinite(value)) return '--';
        return `$${value.toFixed(digits)}`;
    }

    function parseDate(dateStr) {
        const date = new Date(`${dateStr}T00:00:00`);
        return Number.isNaN(date.getTime()) ? null : date;
    }

    function getOverviewSymbols() {
        return [...analysis.WATCHLIST];
    }

    function getSettings() {
        return {
            ...analysis.normalizeSettings(Object.fromEntries(Object.entries(SETTING_INPUTS).map(([key, id]) => [key, $(id)?.value]))),
            apiKey: String($('aiApiKey')?.value || '').trim(),
            provider: selectedProvider,
            model: $('aiModel')?.value || modelDrafts[selectedProvider]
        };
    }

    function getScanSignature(settings) {
        return JSON.stringify({
            strategyType: settings.strategyType,
            riskProfile: settings.riskProfile,
            minDays: settings.minDays,
            maxDays: settings.maxDays,
            minBid: settings.minBid,
            minAnnualReturn: settings.minAnnualReturn,
            minStrikePct: settings.minStrikePct,
            maxStrikePct: settings.maxStrikePct,
            minOpenInterest: settings.minOpenInterest,
            maxSpreadPct: settings.maxSpreadPct,
            candidateLimit: settings.candidateLimit,
            perSymbolLimit: settings.perSymbolLimit
        });
    }

    function configureProvider() {
        $('aiProvider').value = selectedProvider;
        const provider = providers[selectedProvider];
        $('aiApiKey').value = keyDrafts[selectedProvider];
        $('aiKeyLabel').textContent = provider.label + ' API Key';
        $('aiApiKey').placeholder = selectedProvider === 'glm' ? 'Coding Plan Key' : 'OpenAI API Key';
        $('aiModelField').hidden = selectedProvider === 'glm';
        $('aiModel').replaceChildren(...provider.models.map(model => {
            const option = document.createElement('option');
            option.value = model.id;
            option.textContent = model.label;
            return option;
        }));
        $('aiModel').value = modelDrafts[selectedProvider];
    }

    function restoreKey() {
        // Keep a formerly saved GLM key for this page only; remove persistent copies.
        try {
            keyDrafts.glm = localStorage.getItem('kkgo1999.glmCodingPlanKey') ||
                sessionStorage.getItem('kkgo1999.glmCodingPlanSessionKey') || '';
            localStorage.removeItem('kkgo1999.glmCodingPlanKey');
            sessionStorage.removeItem('kkgo1999.glmCodingPlanSessionKey');
        } catch {}
        configureProvider();
    }

    function setBusy(busy) {
        $('scanAiCandidates').disabled = busy;
        $('runAiRecommendation').disabled = busy;
        $('cancelAiAnalysis').hidden = !busy;
    }

    function beginRun() {
        activeController?.abort();
        activeController = new AbortController();
        $('exportCurrentAi').hidden = true;
        setBusy(true);
        return ++activeRunId;
    }

    function cancelRun() {
        activeController?.abort();
        activeController = null;
        ++activeRunId;
        setBusy(false);
    }

    function downloadJson(value, filename) {
        const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' }));
        const link = document.createElement('a');
        link.href = url;
        link.download = filename;
        link.click();
        setTimeout(() => URL.revokeObjectURL(url), 30000);
    }

    function renderDataQuality(scan) {
        const quality = analysis.assessDataQuality(scan.sources, new Date().toISOString());
        const lines = scan.sources.map(source => source.symbol + '：股价 ' + (source.stockSourceTimestamp || '未知') +
            '；期权 ' + (source.optionsSourceTimestamp || '未知') + '；缓存生成 ' + (source.optionsGeneratedAt || '未知'));
        const warnings = [...scan.errors, ...quality.issues];
        return (warnings.length ? '<div class="alert alert-warning">' + escapeHtml(warnings.join(' ')) + '</div>' : '') +
            '<details class="data-time-note"><summary>行情时间与来源</summary><p>源站时区未确认；生成时间不等于行情时间。</p>' +
            '<ul>' + lines.map(line => '<li>' + escapeHtml(line) + '</li>').join('') + '</ul></details>';
    }

    function setStatus(text) {
        const status = $('aiRecommendationStatus');
        if (status) status.textContent = text;
    }

    function setProgress(percent, text) {
        const bar = $('aiRecommendationProgressBar');
        const label = $('aiRecommendationProgressText');
        if (bar) bar.style.width = `${clamp(percent, 0, 100)}%`;
        if (label) label.textContent = text;
    }

    function setOutput(html) {
        const output = $('aiRecommendationOutput');
        if (output) output.innerHTML = html;
    }

    function getStrategyLabel(type) {
        return type === 'call' ? '备兑卖 Call' : '现金担保卖 Put';
    }

    async function scanLocalCandidates(settings, runId) {
        const api = window.apiService || new APIService();
        const symbols = getOverviewSymbols();
        const snapshots = [];
        const asOf = new Date().toISOString();
        const signal = activeController.signal;
        for (let index = 0; index < symbols.length; index += 1) {
            if (runId !== activeRunId) return null;
            const symbol = symbols[index];
            setProgress(5 + (index / symbols.length) * 62, '扫描 ' + symbol + ' (' + (index + 1) + '/' + symbols.length + ')');
            const results = await Promise.allSettled([api.getStockPrice(symbol, { signal, force: true }), api.getOptionsData(symbol, { signal, force: true })]);
            if (runId !== activeRunId) return null;
            snapshots.push({
                symbol,
                quote: results[0].status === 'fulfilled' ? results[0].value : null,
                optionsData: results[1].status === 'fulfilled' ? results[1].value : null,
                error: results.filter(result => result.status === 'rejected').map(result => result.reason.message).join('; ')
            });
        }
        return analysis.scanSnapshots(snapshots, settings, { asOf, scope: 'browser-scan' });
    }

    function describeFilters(settings) {
        return [
            `${settings.strategyType === 'both' ? 'Put + Call' : getStrategyLabel(settings.strategyType)}`,
            `${settings.minDays}-${settings.maxDays}天`,
            `买价 >= ${formatMoney(settings.minBid)}`,
            `年化 >= ${formatPct(settings.minAnnualReturn, 0)}`,
            `相对差 ${formatPct(settings.minStrikePct, 0)} 至 ${formatPct(settings.maxStrikePct, 0)}`,
            `持仓 >= ${settings.minOpenInterest}`,
            `价差 <= ${settings.maxSpreadPct}%`,
            `单股 <= ${settings.perSymbolLimit}个`
        ].join(' / ');
    }

    function renderAiStreamBlock(streamCapture = {}) {
        const status = streamCapture.status || '等待模型返回';
        const provider = providers[streamCapture.provider || selectedProvider];
        const reasoningLabel = (streamCapture.provider || selectedProvider) === 'openai' ? '推理摘要' : 'Thinking 过程';
        const reasoning = streamCapture.reasoning || '';
        const content = streamCapture.content || '';
        return [
            '<div id="glmStreamBlock" class="glm-stream-block">',
            '<div class="glm-stream-header">',
            '<strong>' + escapeHtml(provider?.label || 'AI') + ' / ' + escapeHtml(streamCapture.model || '') + '</strong>',
            `<span id="glmStreamStatus">${escapeHtml(status)}</span>`,
            '</div>',
            '<div class="glm-stream-grid">',
            '<section class="glm-stream-panel">',
            '<h3>' + reasoningLabel + '</h3>',
            `<pre id="glmThinkingText">${escapeHtml(reasoning || (status === '接收完成' || status === '历史记录' ? '模型未提供推理摘要。' : '等待模型输出...'))}</pre>`,
            '</section>',
            '<section class="glm-stream-panel">',
            '<h3>结果文本</h3>',
            `<pre id="glmResultText">${escapeHtml(content || '等待结果内容...')}</pre>`,
            '</section>',
            '</div>',
            '</div>'
        ].join('');
    }

    function ensureAiStreamBlock(streamCapture) {
        let block = $('glmStreamBlock');
        if (block) return block;

        const output = $('aiRecommendationOutput');
        if (!output) return null;
        const summaryBlock = output.querySelector('.ai-summary-block');
        if (summaryBlock) {
            summaryBlock.insertAdjacentHTML('afterend', renderAiStreamBlock(streamCapture));
        } else {
            output.insertAdjacentHTML('afterbegin', renderAiStreamBlock(streamCapture));
        }
        return $('glmStreamBlock');
    }

    function updateAiStreamBlock(streamCapture) {
        ensureAiStreamBlock(streamCapture);
        const status = $('glmStreamStatus');
        const thinking = $('glmThinkingText');
        const result = $('glmResultText');

        if (status) status.textContent = streamCapture.status || '接收中';
        if (thinking) {
            thinking.textContent = streamCapture.reasoning || (streamCapture.status === '接收完成' || streamCapture.status === '历史记录' ? '模型未提供推理摘要。' : '等待模型输出...');
            thinking.scrollTop = thinking.scrollHeight;
        }
        if (result) {
            result.textContent = streamCapture.content || '等待结果内容...';
            result.scrollTop = result.scrollHeight;
        }
    }

    function normalizeAiRows(aiResult, localScan) {
        const byId = new Map(localScan.shortlist.map(candidate => [candidate.id, candidate]));
        if (aiResult) {
            return aiResult.top10.map(item => ({ ...item, candidate: byId.get(item.id) }));
        }
        return localScan.shortlist.slice(0, 10).map((candidate, index) => ({
            rank: index + 1, candidate, reason: '本地评分结果，非 AI 推荐。',
            risk: '需复核行情与风险。', confidence: '未评估'
        }));
    }

    function renderRows(rows) {
        const tableRows = rows.map(row => {
            const c = row.candidate;
            return [
                '<tr>',
                `<td>${row.rank}</td>`,
                `<td><strong>${escapeHtml(c.symbol)}</strong></td>`,
                `<td>${escapeHtml(c.expiryDate)}<span class="ai-subtext">${c.daysToExpiry}天</span></td>`,
                `<td>${c.strike.toFixed(2)}<span class="ai-subtext">${formatPct(c.strikePct)}</span></td>`,
                `<td>${formatMoney(c.bid)}<span class="ai-subtext">价差 ${c.spreadPct.toFixed(1)}%</span></td>`,
                `<td class="positive-change">${c.annualReturn.toFixed(2)}%</td>`,
                `<td>${formatMoney(c.collateral, 0)}</td>`,
                `<td>${formatMoney(c.breakEven)}<span class="ai-subtext">垫 ${formatPct(c.downsideProtectionPct)}</span></td>`,
                `<td>${escapeHtml(row.reason)}<span class="ai-subtext">信心：${escapeHtml(row.confidence)}</span></td>`,
                `<td>${escapeHtml(row.risk)}</td>`,
                `<td><button class="btn btn-sm btn-outline-primary ai-view-matrix" data-symbol="${escapeHtml(c.symbol)}" data-type="${escapeHtml(c.optionType)}" data-expiry="${escapeHtml(c.expiryDate)}">查看矩阵</button></td>`,
                '</tr>'
            ].join('');
        }).join('');

        const cards = rows.map(row => {
            const c = row.candidate;
            return [
                '<article class="ai-recommendation-card">',
                `<div class="ai-card-rank">#${row.rank} ${escapeHtml(c.symbol)} ${escapeHtml(c.strategy)}</div>`,
                `<div class="ai-card-main">${escapeHtml(c.expiryDate)} / ${c.strike.toFixed(2)} / ${c.annualReturn.toFixed(2)}%</div>`,
                `<div class="ai-card-meta">买价 ${formatMoney(c.bid)} · 相对差 ${formatPct(c.strikePct)} · 安全垫 ${formatPct(c.downsideProtectionPct)}</div>`,
                `<p>${escapeHtml(row.reason)}</p>`,
                `<p class="ai-risk-text">${escapeHtml(row.risk)}</p>`,
                `<button class="btn btn-sm btn-outline-primary ai-view-matrix" data-symbol="${escapeHtml(c.symbol)}" data-type="${escapeHtml(c.optionType)}" data-expiry="${escapeHtml(c.expiryDate)}">查看矩阵</button>`,
                '</article>'
            ].join('');
        }).join('');

        return [
            '<div class="ai-results-table-wrap">',
            '<table class="table table-sm table-hover align-middle ai-results-table">',
            '<thead><tr>',
            '<th>#</th><th>股票</th><th>到期</th><th>执行价</th><th>买价</th><th>年化</th><th>保证金</th><th>盈亏平衡</th><th>推荐原因</th><th>风险</th><th></th>',
            '</tr></thead>',
            `<tbody>${tableRows}</tbody>`,
            '</table>',
            '</div>',
            `<div class="ai-mobile-results">${cards}</div>`
        ].join('');
    }

    function roundHistoryNumber(value, digits = 2) {
        const number = Number(value);
        return Number.isFinite(number) ? Number(number.toFixed(digits)) : 0;
    }

    function serializeHistoryCandidate(candidate) {
        return {
            id: candidate.id,
            contractSymbol: candidate.contractSymbol,
            symbol: candidate.symbol,
            strategy: candidate.strategy,
            optionType: candidate.optionType,
            expiryDate: candidate.expiryDate,
            daysToExpiry: candidate.daysToExpiry,
            strike: roundHistoryNumber(candidate.strike),
            stockPrice: roundHistoryNumber(candidate.stockPrice),
            strikePct: roundHistoryNumber(candidate.strikePct),
            bid: roundHistoryNumber(candidate.bid),
            ask: roundHistoryNumber(candidate.ask),
            spreadPct: roundHistoryNumber(candidate.spreadPct, 1),
            openInterest: Number(candidate.openInterest) || 0,
            volume: candidate.volume ?? null,
            annualReturn: roundHistoryNumber(candidate.annualReturn),
            collateral: roundHistoryNumber(candidate.collateral, 0),
            breakEven: roundHistoryNumber(candidate.breakEven),
            downsideProtectionPct: roundHistoryNumber(candidate.downsideProtectionPct),
            localScore: roundHistoryNumber(candidate.localScore)
        };
    }

    function serializeHistoryRows(rows) {
        return rows.map(row => ({
            rank: Number(row.rank) || 0,
            candidate: serializeHistoryCandidate(row.candidate),
            reason: row.reason || '',
            risk: row.risk || '',
            confidence: row.confidence || '中'
        }));
    }

    function serializeHistorySettings(settings) {
        return {
            strategyType: settings.strategyType,
            riskProfile: settings.riskProfile,
            minDays: settings.minDays,
            maxDays: settings.maxDays,
            minBid: settings.minBid,
            minAnnualReturn: settings.minAnnualReturn,
            minStrikePct: settings.minStrikePct,
            maxStrikePct: settings.maxStrikePct,
            minOpenInterest: settings.minOpenInterest,
            maxSpreadPct: settings.maxSpreadPct,
            candidateLimit: settings.candidateLimit,
            perSymbolLimit: settings.perSymbolLimit
        };
    }

    function getAiHistory() { return historyEntries; }

    async function refreshHistory() {
        historyEntries = await historyStore.list();
        updateHistoryButtonCount(historyEntries.length);
        renderHistoryPanel();
    }

    function historyError(error) {
        $('aiHistoryStatus').textContent = '历史保存/读取失败：' + error.message + '。已有记录未删除，可导出当前结果备份。';
    }

    function formatHistoryTime(value) {
        const date = new Date(value);
        if (Number.isNaN(date.getTime())) return '--';
        return new Intl.DateTimeFormat('zh-CN', {
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            hour12: false
        }).format(date);
    }

    function formatHistorySettings(settings = {}) {
        const type = settings.strategyType === 'both'
            ? 'Put + Call'
            : getStrategyLabel(settings.strategyType);
        return [
            type,
            `${settings.minDays || '--'}-${settings.maxDays || '--'}天`,
            `买价 >= ${formatMoney(Number(settings.minBid) || 0)}`,
            `年化 >= ${formatPct(Number(settings.minAnnualReturn) || 0, 0)}`,
            `相对差 ${formatPct(Number(settings.minStrikePct) || 0, 0)} 至 ${formatPct(Number(settings.maxStrikePct) || 0, 0)}`,
            `单股 <= ${settings.perSymbolLimit || '--'}个`
        ].join(' / ');
    }

    function updateHistoryButtonCount(count = getAiHistory().length) {
        const button = $('toggleAiHistory');
        if (button) button.textContent = count > 0 ? `历史记录 (${count})` : '历史记录';
    }

    function renderHistoryPanel(selectedId = '') {
        const content = $('aiHistoryContent');
        if (!content) return;

        const history = getAiHistory();
        updateHistoryButtonCount(history.length);
        if (history.length === 0) {
            content.innerHTML = '<div class="ai-empty-state">暂无历史记录。</div>';
            return;
        }

        content.innerHTML = history.map((entry, index) => {
            const activeClass = entry.id === selectedId ? ' ai-history-item-active' : '';
            const symbols = Array.from(new Set((entry.rows || []).map(row => row.candidate?.symbol).filter(Boolean))).slice(0, 6).join(', ');
            return [
                `<article class="ai-history-item${activeClass}">`,
                '<div class="ai-history-main">',
                '<div class="ai-history-meta">' + escapeHtml((providers[entry.provider || 'glm']?.label || 'AI') + ' / ' + (entry.model || '未记录（旧版）')) + '</div>',
                `<div class="ai-history-title">${escapeHtml(entry.id.slice(0, 8))} · ${escapeHtml(formatHistoryTime(entry.createdAt))}</div>`,
                `<div class="ai-history-meta">${escapeHtml(symbols || '无股票')} · ${(entry.rows || []).length} 个推荐</div>`,
                `<div class="ai-history-meta">${escapeHtml(formatHistorySettings(entry.settings))}</div>`,
                '</div>',
                '<div class="ai-history-actions">',
                `<button class="btn btn-sm btn-outline-primary" data-history-view="${escapeHtml(entry.id)}">查看</button>`,
                `<button class="btn btn-sm btn-outline-danger" data-history-delete="${escapeHtml(entry.id)}">删除</button>`,
                '</div>',
                '</article>'
            ].join('');
        }).join('');
    }

    async function saveAiHistoryEntry(aiResult, localScan, settings, streamCapture) {
        const entry = {
            id: crypto.randomUUID(), createdAt: new Date().toISOString(),
            provider: settings.provider, model: settings.model, promptVersion: window.OptionsAI.PROMPT_VERSION,
            summary: aiResult.summary, notes: aiResult.notes, settings: serializeHistorySettings(settings),
            analysisData: analysis.exportScan(localScan), streamCapture: { ...streamCapture },
            rows: serializeHistoryRows(normalizeAiRows(aiResult, localScan))
        };
        $('exportCurrentAi').hidden = false;
        $('exportCurrentAi').onclick = () => downloadJson({ schemaVersion: 1, entries: [entry] }, 'options-ai-result.json');
        try {
            await historyStore.put(entry);
            await refreshHistory();
            $('aiHistoryStatus').textContent = '已保存到此浏览器。';
        } catch (error) { historyError(error); }
    }

    function renderHistoryResult(entry) {
        const notes = Array.isArray(entry.notes) ? entry.notes.slice(0, 3) : [];
        const notesHtml = notes.length
            ? `<ul class="ai-notes">${notes.map(note => `<li>${escapeHtml(note)}</li>`).join('')}</ul>`
            : '';

        setStatus('历史记录');
        setProgress(100, `已加载历史版本 ${formatHistoryTime(entry.createdAt)}`);
        setOutput([
            '<div class="ai-summary-block">',
            `<strong>历史版本 · ${escapeHtml(formatHistoryTime(entry.createdAt))}</strong>`,
            `<p>${escapeHtml(entry.summary || '')}</p>`,
            `<p>${escapeHtml(formatHistorySettings(entry.settings))}</p>`,
            notesHtml,
            '</div>',
            renderAiStreamBlock(entry.streamCapture),
            renderRows(entry.rows || [])
        ].join(''));
    }

    function viewHistoryEntry(id) {
        cancelRun();
        const entry = getAiHistory().find(item => item.id === id);
        if (!entry) return;
        $('exportCurrentAi').hidden = false;
        $('exportCurrentAi').onclick = () => downloadJson({ schemaVersion: 1, entries: [entry] }, 'options-ai-result.json');

        const panel = $('aiHistoryPanel');
        if (panel) panel.hidden = false;
        renderHistoryPanel(id);
        renderHistoryResult(entry);
    }

    async function deleteHistoryEntry(id) {
        try { await historyStore.remove(id); await refreshHistory(); }
        catch (error) { historyError(error); }
    }

    async function clearAiHistory() {
        if (!window.confirm('确认清空所有 AI 分析历史？建议先导出备份。')) return;
        try { await historyStore.clear(); await refreshHistory(); }
        catch (error) { historyError(error); }
    }

    function toggleHistoryPanel() {
        const panel = $('aiHistoryPanel');
        if (!panel) return;
        panel.hidden = !panel.hidden;
        if (!panel.hidden) renderHistoryPanel();
    }

    function getCandidateDefaultSortDirection(column) {
        if (['symbol', 'expiryDate', 'strike', 'spreadPct', 'collateral', 'breakEven', 'rank'].includes(column)) {
            return 'asc';
        }
        return 'desc';
    }

    function getCandidateSortValue(candidate, column, rank) {
        switch (column) {
            case 'rank':
                return rank;
            case 'localScore':
                return candidate.localScore;
            case 'symbol':
                return candidate.symbol;
            case 'expiryDate':
                return parseDate(candidate.expiryDate)?.getTime() || 0;
            case 'strike':
                return candidate.strike;
            case 'bid':
                return candidate.bid;
            case 'spreadPct':
                return candidate.spreadPct;
            case 'annualReturn':
                return candidate.annualReturn;
            case 'collateral':
                return candidate.collateral;
            case 'breakEven':
                return candidate.breakEven;
            case 'openInterest':
                return candidate.openInterest;
            case 'volume':
                return candidate.volume;
            default:
                return rank;
        }
    }

    function compareCandidateRows(rowA, rowB, column) {
        const valueA = getCandidateSortValue(rowA.candidate, column, rowA.rank);
        const valueB = getCandidateSortValue(rowB.candidate, column, rowB.rank);

        if (typeof valueA === 'number' && typeof valueB === 'number') {
            const safeA = Number.isFinite(valueA) ? valueA : Number.NEGATIVE_INFINITY;
            const safeB = Number.isFinite(valueB) ? valueB : Number.NEGATIVE_INFINITY;
            return safeA - safeB;
        }

        return String(valueA ?? '').localeCompare(String(valueB ?? ''), 'zh-CN', {
            numeric: true,
            sensitivity: 'base'
        });
    }

    function getSortedCandidateRows(localScan) {
        const rows = localScan.candidates.map((candidate, index) => ({
            candidate,
            rank: index + 1
        }));
        const column = CANDIDATE_SORT_COLUMNS.has(candidateSortConfig.column)
            ? candidateSortConfig.column
            : DEFAULT_CANDIDATE_SORT.column;
        const direction = candidateSortConfig.direction === 'desc' ? 'desc' : 'asc';

        rows.sort((rowA, rowB) => {
            const comparison = compareCandidateRows(rowA, rowB, column);
            if (comparison !== 0) return direction === 'asc' ? comparison : -comparison;
            return rowA.rank - rowB.rank;
        });
        return rows;
    }

    function renderCandidateSortHeader(column, label) {
        const classes = ['sortable'];
        if (candidateSortConfig.column === column) {
            classes.push('active-sort', candidateSortConfig.direction === 'desc' ? 'sort-desc' : 'sort-asc');
        }
        return `<th class="${classes.join(' ')}" data-ai-sort="${escapeHtml(column)}">${escapeHtml(label)}</th>`;
    }

    function renderCandidateList(localScan, settings) {
        const rows = getSortedCandidateRows(localScan);
        const headerCells = [
            renderCandidateSortHeader('rank', '#'),
            renderCandidateSortHeader('localScore', '本地评分'),
            renderCandidateSortHeader('symbol', '股票'),
            renderCandidateSortHeader('expiryDate', '到期'),
            renderCandidateSortHeader('strike', '执行价'),
            renderCandidateSortHeader('bid', '买价'),
            renderCandidateSortHeader('spreadPct', '价差'),
            renderCandidateSortHeader('annualReturn', '年化'),
            renderCandidateSortHeader('collateral', '保证金'),
            renderCandidateSortHeader('breakEven', '盈亏平衡'),
            renderCandidateSortHeader('openInterest', '持仓'),
            renderCandidateSortHeader('volume', '成交量'),
            '<th></th>'
        ].join('');
        const tableRows = rows.map(row => {
            const candidate = row.candidate;
            return [
            '<tr>',
            `<td>${row.rank}</td>`,
            `<td>${candidate.localScore.toFixed(2)}</td>`,
            `<td><strong>${escapeHtml(candidate.symbol)}</strong></td>`,
            `<td>${escapeHtml(candidate.expiryDate)}<span class="ai-subtext">${candidate.daysToExpiry}天</span></td>`,
            `<td>${candidate.strike.toFixed(2)}<span class="ai-subtext">${formatPct(candidate.strikePct)}</span></td>`,
            `<td>${formatMoney(candidate.bid)}<span class="ai-subtext">卖价 ${formatMoney(candidate.ask)}</span></td>`,
            `<td>${candidate.spreadPct.toFixed(1)}%</td>`,
            `<td class="positive-change">${candidate.annualReturn.toFixed(2)}%</td>`,
            `<td>${formatMoney(candidate.collateral, 0)}</td>`,
            `<td>${formatMoney(candidate.breakEven)}<span class="ai-subtext">垫 ${formatPct(candidate.downsideProtectionPct)}</span></td>`,
            `<td>${candidate.openInterest}</td>`,
            `<td>${candidate.volume ?? '--'}</td>`,
            `<td><button class="btn btn-sm btn-outline-primary ai-view-matrix" data-symbol="${escapeHtml(candidate.symbol)}" data-type="${escapeHtml(candidate.optionType)}" data-expiry="${escapeHtml(candidate.expiryDate)}">查看矩阵</button></td>`,
            '</tr>'
        ].join('');
        }).join('');

        const cards = rows.map(row => {
            const candidate = row.candidate;
            return [
            '<article class="ai-recommendation-card">',
            `<div class="ai-card-rank">#${row.rank} ${escapeHtml(candidate.symbol)} ${escapeHtml(candidate.strategy)}</div>`,
            `<div class="ai-card-main">${escapeHtml(candidate.expiryDate)} / ${candidate.strike.toFixed(2)} / ${candidate.annualReturn.toFixed(2)}%</div>`,
            `<div class="ai-card-meta">本地评分 ${candidate.localScore.toFixed(2)} · 买价 ${formatMoney(candidate.bid)} · 相对差 ${formatPct(candidate.strikePct)} · 价差 ${candidate.spreadPct.toFixed(1)}% · 持仓 ${candidate.openInterest}</div>`,
            `<button class="btn btn-sm btn-outline-primary ai-view-matrix" data-symbol="${escapeHtml(candidate.symbol)}" data-type="${escapeHtml(candidate.optionType)}" data-expiry="${escapeHtml(candidate.expiryDate)}">查看矩阵</button>`,
            '</article>'
        ].join('');
        }).join('');

        const errorHtml = localScan.errors.length
            ? `<div class="alert alert-warning ai-warning">部分股票读取失败：${escapeHtml(localScan.errors.slice(0, 4).join('；'))}</div>`
            : '';

        setOutput([
            errorHtml,
            renderDataQuality(localScan),
            '<div class="ai-summary-block">',
            '<div class="ai-candidate-heading"><strong>候选扫描结果</strong>',
            '<div class="ai-export-actions">',
            '<button type="button" class="btn btn-sm btn-outline-secondary ai-export-button" data-export-scan="copy"><span class="tool-icon icon-copy" aria-hidden="true"></span>复制分析数据</button>',
            '<button type="button" class="btn btn-sm btn-outline-secondary ai-export-button" data-export-scan="download"><span class="tool-icon icon-download" aria-hidden="true"></span>下载 JSON</button>',
            '</div></div>',
            '<div id="aiExportStatus" role="status" aria-live="polite"></div>',
            `<p>共 ${localScan.candidates.length} 个候选。筛选条件：${escapeHtml(describeFilters(settings))}。</p>`,
            `<p>扫描结果已限制每只股票最多保留本地评分前 ${settings.perSymbolLimit} 个；点击“AI分析 Top 10”会把其中前 ${localScan.shortlist.length} 个候选发送给所选模型做总结和排序。</p>`,
            '</div>',
            '<div class="ai-results-table-wrap">',
            '<table class="table table-sm table-hover align-middle sortable-table ai-results-table ai-candidate-table">',
            '<thead><tr>',
            headerCells,
            '</tr></thead>',
            `<tbody>${tableRows || '<tr><td colspan="13">没有符合当前条件的候选。</td></tr>'}</tbody>`,
            '</table>',
            '</div>',
            `<div class="ai-mobile-results">${cards}</div>`
        ].join(''));
    }

    async function exportCurrentScan(action) {
        if (!latestLocalScan) return;
        const scan = latestLocalScan;
        const payload = JSON.stringify(analysis.exportScan(scan), null, 2);
        const status = $('aiExportStatus');
        const download = () => {
            const url = URL.createObjectURL(new Blob([payload + '\n'], { type: 'application/json' }));
            const link = document.createElement('a');
            link.href = url;
            link.download = 'options-scan-' + scan.generatedAt.replace(/[:.]/g, '-') + '.json';
            document.body.appendChild(link);
            link.click();
            link.remove();
            setTimeout(() => URL.revokeObjectURL(url), 30000);
        };
        if (action === 'download') {
            download();
            if (status) status.textContent = '已导出本次扫描结果及扫描时的筛选条件。';
            return;
        }
        try {
            await navigator.clipboard.writeText(payload);
            if (status) status.textContent = '已复制本次扫描结果及扫描时的筛选条件。';
        } catch {
            download();
            if (status) status.textContent = '剪贴板不可用，已改为下载 JSON。';
        }
    }

    function sortCandidateList(column) {
        if (!CANDIDATE_SORT_COLUMNS.has(column) || !latestLocalScan) return;

        if (candidateSortConfig.column === column) {
            candidateSortConfig.direction = candidateSortConfig.direction === 'asc' ? 'desc' : 'asc';
        } else {
            candidateSortConfig.column = column;
            candidateSortConfig.direction = getCandidateDefaultSortDirection(column);
        }

        renderCandidateList(latestLocalScan, latestCandidateSettings || getSettings());
    }

    function renderResult(aiResult, localScan, glmFailedMessage = '', streamCapture = null) {
        const rows = normalizeAiRows(aiResult, localScan);
        const notes = Array.isArray(aiResult?.notes) ? aiResult.notes.slice(0, 3) : [];
        const summary = aiResult?.summary || '以下为本地评分前 10，非 AI 推荐。';
        const errorBlock = glmFailedMessage
            ? `<div class="alert alert-warning ai-warning">AI 分析未完成，以下仅为本地预筛结果：${escapeHtml(glmFailedMessage)}</div>`
            : '';
        const notesHtml = notes.length
            ? `<ul class="ai-notes">${notes.map(note => `<li>${escapeHtml(note)}</li>`).join('')}</ul>`
            : '';

        setOutput([
            errorBlock,
            renderDataQuality(localScan),
            '<div class="ai-summary-block">',
            `<strong>总结</strong><p>${escapeHtml(summary)}</p>`,
            notesHtml,
            '</div>',
            streamCapture ? renderAiStreamBlock(streamCapture) : '',
            renderRows(rows)
        ].join(''));
    }

    function renderLocalPreview(localScan) { renderResult(null, localScan); }

    async function runCandidateScan() {
        const settings = getSettings();
        const runId = beginRun();
        setStatus('扫描中');
        setProgress(2, '准备扫描股票列表');
        setOutput('<div class="ai-empty-state">正在扫描本地期权缓存...</div>');

        try {
            const localScan = await scanLocalCandidates(settings, runId);
            if (!localScan || runId !== activeRunId) return;

            latestLocalScan = localScan;
            latestCandidateSettings = analysis.normalizeSettings(settings);
            latestScanSignature = getScanSignature(settings);
            candidateSortConfig = { ...DEFAULT_CANDIDATE_SORT };
            setStatus(localScan.candidates.length ? '候选完成' : '无候选');
            setProgress(100, `扫描完成，共 ${localScan.candidates.length} 个候选`);
            renderCandidateList(localScan, settings);
        } catch (error) {
            if (runId !== activeRunId) return;
            setStatus('失败');
            setProgress(100, '扫描失败');
            setOutput(`<div class="ai-empty-state ai-empty-state-error">扫描失败：${escapeHtml(error.message)}</div>`);
        } finally {
            if (runId === activeRunId) setBusy(false);
        }
    }

    async function runRecommendation() {
        const settings = getSettings();
        if (!settings.apiKey) { setStatus('缺少 Key'); $('aiApiKey').focus(); return; }
        const runId = beginRun();
        const signal = activeController.signal;
        const scanSignature = getScanSignature(settings);
        setStatus('准备分析');
        try {
            let localScan = latestLocalScan;
            if (!localScan || latestScanSignature !== scanSignature ||
                Date.now() - Date.parse(localScan.generatedAt) > 120000) {
                localScan = await scanLocalCandidates(settings, runId);
                if (!localScan || runId !== activeRunId) return;
                latestLocalScan = localScan;
                latestCandidateSettings = analysis.normalizeSettings(settings);
                latestScanSignature = scanSignature;
            }
            if (!localScan.shortlist.length) {
                setStatus('无候选');
                renderCandidateList(localScan, settings);
                return;
            }
            const quality = analysis.assessDataQuality(localScan.sources);
            localScan.dataQuality = quality;
            const warnings = [...localScan.errors, ...quality.issues];
            if (warnings.length && !window.confirm(warnings.join('\n') + '\n仍使用这些数据进行 AI 分析？')) {
                setStatus('待复核数据');
                renderCandidateList(localScan, settings);
                return;
            }
            setStatus('分析中');
            setProgress(72, '发送 ' + localScan.shortlist.length + ' 个候选至 ' + providers[settings.provider].label + ' / ' + settings.model);
            renderLocalPreview(localScan);
            const streamCapture = { provider: settings.provider, model: settings.model, reasoning: '', content: '', status: '等待模型返回' };
            updateAiStreamBlock(streamCapture);
            try {
                const response = await window.OptionsAI.analyze(settings, localScan, {
                    signal, onUpdate(update) {
                        if (runId !== activeRunId) return;
                        Object.assign(streamCapture, update);
                        updateAiStreamBlock(streamCapture);
                    }
                });
                if (runId !== activeRunId) return;
                renderResult(response.aiResult, localScan, '', response.streamCapture);
                setStatus('完成');
                setProgress(100, 'AI 返回 ' + response.aiResult.top10.length + ' 个推荐');
                await saveAiHistoryEntry(response.aiResult, localScan, settings, response.streamCapture);
            } catch (error) {
                if (runId !== activeRunId) return;
                streamCapture.status = '未完成';
                renderResult(null, localScan, error.message, streamCapture);
                setStatus('本地结果');
                setProgress(100, '模型分析未完成，未保存为 AI 推荐');
            }
        } catch (error) {
            if (runId !== activeRunId) return;
            setStatus('失败');
            setOutput('<div class="alert alert-warning">' + escapeHtml(error.message) + '</div>');
        } finally {
            if (runId === activeRunId) setBusy(false);
        }
    }

    async function waitForExpiryOption(expirySelect, expiryDate, timeoutMs = 10000) {
        const start = Date.now();
        while (Date.now() - start < timeoutMs) {
            const option = Array.from(expirySelect.options).find(item => item.value === expiryDate);
            if (option) return option;
            await new Promise(resolve => setTimeout(resolve, 250));
        }
        return null;
    }

    async function viewMatrix(button) {
        const stockSelect = $('stockSelect');
        const expirySelect = $('expirySelect');
        const callOption = $('callOption');
        const putOption = $('putOption');
        if (!stockSelect || !expirySelect) return;

        const symbol = button.getAttribute('data-symbol');
        const type = button.getAttribute('data-type');
        const expiry = button.getAttribute('data-expiry');
        stockSelect.value = symbol;
        if (type === 'call' && callOption) callOption.checked = true;
        if (type === 'put' && putOption) putOption.checked = true;
        stockSelect.dispatchEvent(new Event('change'));

        const option = await waitForExpiryOption(expirySelect, expiry);
        if (option) {
            expirySelect.value = expiry;
            expirySelect.dispatchEvent(new Event('change'));
        }

        const section = $('advancedAnalysisSection') || $('options-content');
        if (section) section.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }

    function bindEvents() {
        document.addEventListener('optionsDataUpdated', () => {
            const hadScan = !!latestLocalScan;
            cancelRun();
            latestLocalScan = null;
            latestScanSignature = '';
            $('exportCurrentAi').hidden = true;
            setStatus('数据已更新');
            setOutput('<div class="ai-empty-state">期权快照已更新。旧版 AI 结果可在历史记录中查看。</div>');
            if (hadScan) runCandidateScan();
        });
        const scanButton = $('scanAiCandidates');
        if (scanButton) {
            scanButton.addEventListener('click', runCandidateScan);
        }

        const runButton = $('runAiRecommendation');
        if (runButton) {
            runButton.addEventListener('click', runRecommendation);
        }

        const historyButton = $('toggleAiHistory');
        if (historyButton) {
            historyButton.addEventListener('click', toggleHistoryPanel);
        }

        const clearHistoryButton = $('clearAiHistory');
        if (clearHistoryButton) {
            clearHistoryButton.addEventListener('click', clearAiHistory);
        }

        const historyContent = $('aiHistoryContent');
        if (historyContent) {
            historyContent.addEventListener('click', event => {
                const viewButton = event.target.closest('[data-history-view]');
                if (viewButton) {
                    viewHistoryEntry(viewButton.getAttribute('data-history-view'));
                    return;
                }

                const deleteButton = event.target.closest('[data-history-delete]');
                if (deleteButton) {
                    deleteHistoryEntry(deleteButton.getAttribute('data-history-delete'));
                }
            });
        }

        $('aiProvider').addEventListener('change', () => {
            keyDrafts[selectedProvider] = $('aiApiKey').value;
            modelDrafts[selectedProvider] = $('aiModel').value;
            cancelRun();
            selectedProvider = $('aiProvider').value;
            configureProvider();
            setStatus('服务商已切换');
            if (latestLocalScan) renderCandidateList(latestLocalScan, getSettings());
        });
        $('aiModel').addEventListener('change', () => {
            cancelRun();
            modelDrafts[selectedProvider] = $('aiModel').value;
            setStatus('模型已切换');
            if (latestLocalScan) renderCandidateList(latestLocalScan, getSettings());
        });
        $('clearAiKey').addEventListener('click', () => {
            cancelRun();
            keyDrafts.glm = keyDrafts.openai = '';
            $('aiApiKey').value = '';
            setStatus('密钥已清除');
        });
        $('cancelAiAnalysis').addEventListener('click', () => {
            cancelRun();
            setStatus('已取消');
            setProgress(100, '已停止当前请求；已产生的 API 用量仍可能计费');
            if (latestLocalScan) renderCandidateList(latestLocalScan, getSettings());
        });
        $('exportAiHistory').addEventListener('click', async () => {
            try { downloadJson({ schemaVersion: 1, entries: await historyStore.list() }, 'options-ai-history.json'); }
            catch (error) { historyError(error); }
        });
        $('importAiHistory').addEventListener('click', () => $('aiHistoryFile').click());
        $('aiHistoryFile').addEventListener('change', async event => {
            const file = event.target.files[0];
            if (!file) return;
            try {
                if (file.size > 50 * 1024 * 1024) throw new Error('备份文件超过 50 MB');
                await historyStore.importFile(await file.text());
                await refreshHistory();
                $('aiHistoryStatus').textContent = '备份已合并，重复版本未覆盖。';
            } catch (error) { historyError(error); }
            finally { event.target.value = ''; }
        });

        const output = $('aiRecommendationOutput');
        if (output) {
            output.addEventListener('click', event => {
                const exportButton = event.target.closest('[data-export-scan]');
                if (exportButton) {
                    exportCurrentScan(exportButton.dataset.exportScan);
                    return;
                }
                const sortHeader = event.target.closest('.ai-candidate-table th[data-ai-sort]');
                if (sortHeader) {
                    sortCandidateList(sortHeader.getAttribute('data-ai-sort'));
                    return;
                }

                const button = event.target.closest('.ai-view-matrix');
                if (button) viewMatrix(button);
            });
        }
    }

    function init() {
        for (const [key, id] of Object.entries(SETTING_INPUTS)) {
            if ($(id)) $(id).value = analysis.DEFAULTS[key];
        }
        restoreKey();
        bindEvents();
        refreshHistory().catch(historyError);
    }

    window.aiRecommendations = {
        run: runRecommendation,
        scan: runCandidateScan,
        getOverviewSymbols,
        getScanExport: () => latestLocalScan ? analysis.exportScan(latestLocalScan) : null
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
