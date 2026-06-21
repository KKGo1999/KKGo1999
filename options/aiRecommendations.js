(function() {
    const STORAGE_KEY = 'kkgo1999.glmCodingPlanKey';
    const SESSION_KEY = 'kkgo1999.glmCodingPlanSessionKey';
    const GLM_BASE_URL = 'https://open.bigmodel.cn/api/coding/paas/v4';
    const DEFAULT_GLM_MODEL = 'glm-5.2';
    const DEFAULT_CANDIDATE_SORT = { column: 'rank', direction: 'asc' };
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

    function toNumber(value, fallback) {
        const num = Number(value);
        return Number.isFinite(num) ? num : fallback;
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

    function daysToExpiry(dateStr) {
        const expiry = parseDate(dateStr);
        if (!expiry) return null;
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        return Math.ceil((expiry - today) / (1000 * 60 * 60 * 24));
    }

    function getOverviewSymbols() {
        return Array.from(document.querySelectorAll('#overviewTable tbody tr[data-symbol]'))
            .map(row => row.getAttribute('data-symbol'))
            .filter(Boolean)
            .filter((symbol, index, arr) => arr.indexOf(symbol) === index);
    }

    function getSettings() {
        const minDays = clamp(toNumber($('aiMinDays')?.value, 30), 1, 730);
        const maxDays = clamp(toNumber($('aiMaxDays')?.value, 200), minDays, 730);
        const rawMinStrikePct = clamp(toNumber($('aiMinStrikePct')?.value, -60), -100, 300);
        const rawMaxStrikePct = clamp(toNumber($('aiMaxStrikePct')?.value, -15), -100, 300);
        const minStrikePct = Math.min(rawMinStrikePct, rawMaxStrikePct);
        const maxStrikePct = Math.max(rawMinStrikePct, rawMaxStrikePct);
        return {
            apiKey: String($('glmApiKey')?.value || '').trim(),
            rememberKey: !!$('rememberGlmKey')?.checked,
            model: DEFAULT_GLM_MODEL,
            strategyType: $('aiStrategyType')?.value || 'put',
            riskProfile: $('aiRiskProfile')?.value || 'balanced',
            minDays,
            maxDays,
            minBid: Math.max(0, toNumber($('aiMinBid')?.value, 1)),
            minAnnualReturn: Math.max(0, toNumber($('aiMinAnnualReturn')?.value, 20)),
            minStrikePct,
            maxStrikePct,
            minOpenInterest: Math.max(0, toNumber($('aiMinOpenInterest')?.value, 1)),
            maxSpreadPct: clamp(toNumber($('aiMaxSpread')?.value, 45), 1, 300),
            candidateLimit: clamp(toNumber($('aiCandidateLimit')?.value, 40), 10, 120),
            perSymbolLimit: clamp(toNumber($('aiPerSymbolLimit')?.value, 3), 1, 20)
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

    function persistKey(settings) {
        if (!settings.apiKey) {
            sessionStorage.removeItem(SESSION_KEY);
            if (!settings.rememberKey) localStorage.removeItem(STORAGE_KEY);
            return;
        }

        sessionStorage.setItem(SESSION_KEY, settings.apiKey);
        if (settings.rememberKey) {
            localStorage.setItem(STORAGE_KEY, settings.apiKey);
        } else {
            localStorage.removeItem(STORAGE_KEY);
        }
    }

    function restoreKey() {
        const savedKey = localStorage.getItem(STORAGE_KEY);
        const sessionKey = sessionStorage.getItem(SESSION_KEY);
        const keyInput = $('glmApiKey');
        const rememberInput = $('rememberGlmKey');
        if (!keyInput) return;

        if (savedKey) {
            keyInput.value = savedKey;
            if (rememberInput) rememberInput.checked = true;
        } else if (sessionKey) {
            keyInput.value = sessionKey;
        }
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

    function getAllowedTypes(strategyType) {
        if (strategyType === 'both') return ['put', 'call'];
        return [strategyType === 'call' ? 'call' : 'put'];
    }

    function calculateLocalScore(candidate, riskProfile) {
        const liquidityScore = Math.log10(candidate.openInterest + 1) * 1.8 + Math.log10(candidate.volume + 1) * 0.9;
        const spreadPenalty = candidate.spreadPct * 0.08;
        const shortDatedPenalty = candidate.daysToExpiry < 21 ? 1.8 : 0;
        const longDatedPenalty = candidate.daysToExpiry > 75 ? 0.8 : 0;
        const moneynessPenalty = candidate.optionType === 'put'
            ? Math.max(0, candidate.strikePct) * 1.7
            : Math.max(0, -candidate.strikePct) * 1.7;

        if (riskProfile === 'conservative') {
            return candidate.annualReturn * 0.72
                + candidate.downsideProtectionPct * 1.15
                + liquidityScore
                - spreadPenalty * 1.35
                - moneynessPenalty * 1.8
                - shortDatedPenalty
                - longDatedPenalty;
        }

        if (riskProfile === 'aggressive') {
            return candidate.annualReturn * 1.12
                + candidate.downsideProtectionPct * 0.35
                + liquidityScore * 0.7
                - spreadPenalty * 0.65
                - moneynessPenalty
                - longDatedPenalty;
        }

        return candidate.annualReturn * 0.92
            + candidate.downsideProtectionPct * 0.7
            + liquidityScore
            - spreadPenalty
            - moneynessPenalty * 1.25
            - shortDatedPenalty * 0.6
            - longDatedPenalty;
    }

    function buildCandidate(symbol, stockPrice, option, settings) {
        const days = daysToExpiry(option.expiryDate);
        if (!Number.isFinite(days) || days < settings.minDays || days > settings.maxDays) return null;

        const optionType = option.optionType;
        const strike = Number(option.strike);
        const bid = Number(option.bid);
        const ask = Number(option.ask);
        const openInterest = Math.max(0, Number(option.openInterest) || 0);
        const volume = Math.max(0, Number(option.volume) || 0);

        if (!Number.isFinite(strike) || strike <= 0) return null;
        if (!Number.isFinite(bid) || bid < settings.minBid) return null;
        if (!Number.isFinite(ask) || ask <= 0 || ask < bid) return null;
        if (openInterest < settings.minOpenInterest) return null;

        const mid = (bid + ask) / 2;
        const spreadPct = mid > 0 ? ((ask - bid) / mid) * 100 : 999;
        if (!Number.isFinite(spreadPct) || spreadPct > settings.maxSpreadPct) return null;

        const strikePct = ((strike / stockPrice) - 1) * 100;
        if (strikePct < settings.minStrikePct || strikePct > settings.maxStrikePct) return null;

        const netPremium = bid - 0.01;
        if (netPremium <= 0) return null;

        const collateral = optionType === 'put' ? strike * 100 : stockPrice * 100;
        const premiumDollars = netPremium * 100;
        const annualReturn = (premiumDollars / collateral) * (365 / days) * 100;
        if (!Number.isFinite(annualReturn) || annualReturn <= 0) return null;
        if (annualReturn < settings.minAnnualReturn) return null;

        const breakEven = optionType === 'put' ? strike - netPremium : stockPrice - netPremium;
        const downsideProtectionPct = optionType === 'put'
            ? ((stockPrice - breakEven) / stockPrice) * 100
            : (netPremium / stockPrice) * 100;
        const id = `${symbol}-${optionType}-${option.expiryDate}-${strike.toFixed(2).replace('.', '_')}`;
        const candidate = {
            id,
            symbol,
            optionType,
            strategy: getStrategyLabel(optionType),
            contractSymbol: option.contractSymbol || '',
            stockPrice,
            expiryDate: option.expiryDate,
            daysToExpiry: days,
            strike,
            strikePct,
            bid,
            ask,
            spreadPct,
            volume,
            openInterest,
            impliedVolatility: Number(option.impliedVolatility) || 0,
            premiumDollars,
            collateral,
            annualReturn,
            breakEven,
            downsideProtectionPct,
            lastTradeDate: option.lastTradeDate || ''
        };
        candidate.localScore = calculateLocalScore(candidate, settings.riskProfile);
        return candidate;
    }

    function limitCandidatesPerSymbol(candidates, perSymbolLimit) {
        const symbolCounts = new Map();
        const limitedCandidates = [];

        for (const candidate of candidates) {
            const count = symbolCounts.get(candidate.symbol) || 0;
            if (count >= perSymbolLimit) continue;

            limitedCandidates.push(candidate);
            symbolCounts.set(candidate.symbol, count + 1);
        }

        return limitedCandidates;
    }

    async function scanLocalCandidates(settings, runId) {
        const api = window.apiService || new APIService();
        const symbols = getOverviewSymbols();
        const allowedTypes = getAllowedTypes(settings.strategyType);
        const candidates = [];
        const errors = [];

        if (symbols.length === 0) {
            throw new Error('没有找到股票列表');
        }

        for (let index = 0; index < symbols.length; index += 1) {
            if (runId !== activeRunId) return null;
            const symbol = symbols[index];
            setProgress(5 + (index / symbols.length) * 62, `扫描 ${symbol} (${index + 1}/${symbols.length})`);

            try {
                const [stockData, optionsData] = await Promise.all([
                    api.getStockPrice(symbol),
                    api.getOptionsData(symbol)
                ]);
                const stockPrice = Number(stockData.price);
                if (!Number.isFinite(stockPrice) || stockPrice <= 0) continue;

                optionsData.options
                    .filter(option => allowedTypes.includes(option.optionType))
                    .forEach(option => {
                        const candidate = buildCandidate(symbol, stockPrice, option, settings);
                        if (candidate) candidates.push(candidate);
                    });
            } catch (error) {
                errors.push(`${symbol}: ${error.message}`);
            }
        }

        candidates.sort((a, b) => b.localScore - a.localScore);
        const limitedCandidates = limitCandidatesPerSymbol(candidates, settings.perSymbolLimit);
        return {
            symbols,
            errors,
            candidates: limitedCandidates,
            shortlist: limitedCandidates.slice(0, settings.candidateLimit)
        };
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

    function compactCandidate(candidate) {
        return {
            id: candidate.id,
            symbol: candidate.symbol,
            strategy: candidate.strategy,
            type: candidate.optionType,
            expiryDate: candidate.expiryDate,
            daysToExpiry: candidate.daysToExpiry,
            strike: Number(candidate.strike.toFixed(2)),
            stockPrice: Number(candidate.stockPrice.toFixed(2)),
            strikePct: Number(candidate.strikePct.toFixed(2)),
            bid: Number(candidate.bid.toFixed(2)),
            ask: Number(candidate.ask.toFixed(2)),
            spreadPct: Number(candidate.spreadPct.toFixed(1)),
            openInterest: candidate.openInterest,
            volume: candidate.volume,
            annualReturn: Number(candidate.annualReturn.toFixed(2)),
            breakEven: Number(candidate.breakEven.toFixed(2)),
            downsideProtectionPct: Number(candidate.downsideProtectionPct.toFixed(2)),
            localScore: Number(candidate.localScore.toFixed(2))
        };
    }

    function getDeltaText(value) {
        if (typeof value === 'string') return value;
        if (Array.isArray(value)) {
            return value.map(item => {
                if (typeof item === 'string') return item;
                return item?.text || item?.content || '';
            }).join('');
        }
        return '';
    }

    function renderGlmStreamBlock(streamCapture = {}) {
        const status = streamCapture.status || '等待智谱返回';
        const reasoning = streamCapture.reasoning || '';
        const content = streamCapture.content || '';
        return [
            '<div id="glmStreamBlock" class="glm-stream-block">',
            '<div class="glm-stream-header">',
            '<strong>智谱流式返回</strong>',
            `<span id="glmStreamStatus">${escapeHtml(status)}</span>`,
            '</div>',
            '<div class="glm-stream-grid">',
            '<section class="glm-stream-panel">',
            '<h3>Thinking 过程</h3>',
            `<pre id="glmThinkingText">${escapeHtml(reasoning || '等待 thinking 内容...')}</pre>`,
            '</section>',
            '<section class="glm-stream-panel">',
            '<h3>结果文本</h3>',
            `<pre id="glmResultText">${escapeHtml(content || '等待结果内容...')}</pre>`,
            '</section>',
            '</div>',
            '</div>'
        ].join('');
    }

    function ensureGlmStreamBlock() {
        let block = $('glmStreamBlock');
        if (block) return block;

        const output = $('aiRecommendationOutput');
        if (!output) return null;
        const summaryBlock = output.querySelector('.ai-summary-block');
        if (summaryBlock) {
            summaryBlock.insertAdjacentHTML('afterend', renderGlmStreamBlock());
        } else {
            output.insertAdjacentHTML('afterbegin', renderGlmStreamBlock());
        }
        return $('glmStreamBlock');
    }

    function updateGlmStreamBlock(streamCapture) {
        ensureGlmStreamBlock();
        const status = $('glmStreamStatus');
        const thinking = $('glmThinkingText');
        const result = $('glmResultText');

        if (status) status.textContent = streamCapture.status || '接收中';
        if (thinking) {
            thinking.textContent = streamCapture.reasoning || '等待 thinking 内容...';
            thinking.scrollTop = thinking.scrollHeight;
        }
        if (result) {
            result.textContent = streamCapture.content || '等待结果内容...';
            result.scrollTop = result.scrollHeight;
        }
    }

    async function callGlm(settings, localScan, onStreamUpdate) {
        const payload = {
            task: '从美股卖方期权候选中推荐最近值得交易的 Top 10。请优先风险调整后收益、流动性、执行价安全垫和到期天数，避免只按回报率排序。',
            outputSchema: {
                summary: 'string',
                top10: [
                    {
                        id: '候选 id，必须来自 candidates',
                        rank: 'number',
                        reason: '推荐原因，中文，控制在60字以内',
                        risk: '主要风险，中文，控制在60字以内',
                        confidence: '高|中|低'
                    }
                ],
                notes: ['string']
            },
            settings: {
                riskProfile: settings.riskProfile,
                strategyType: settings.strategyType,
                minDays: settings.minDays,
                maxDays: settings.maxDays,
                minBid: settings.minBid,
                minAnnualReturn: settings.minAnnualReturn,
                minStrikePct: settings.minStrikePct,
                maxStrikePct: settings.maxStrikePct,
                minOpenInterest: settings.minOpenInterest,
                maxSpreadPct: settings.maxSpreadPct,
                perSymbolLimit: settings.perSymbolLimit
            },
            candidates: localScan.shortlist.map(compactCandidate)
        };

        const response = await fetch(`${GLM_BASE_URL}/chat/completions`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${settings.apiKey}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                model: settings.model,
                temperature: 0.2,
                max_tokens: 12000,
                stream: true,
                thinking: {
                    type: 'enabled'
                },
                reasoning_effort: 'high',
                messages: [
                    {
                        role: 'system',
                        content: [
                            '你是期权卖方交易候选筛选助手。',
                            '只能使用用户提供的候选数据，不要编造行情、价格或外部新闻。',
                            '输出必须是严格 JSON 对象，不要使用 Markdown。',
                            '这不是投资建议，必须说明关键风险。'
                        ].join('')
                    },
                    {
                        role: 'user',
                        content: JSON.stringify(payload)
                    }
                ]
            })
        });

        if (!response.ok) {
            const text = await response.text();
            throw new Error(`GLM 请求失败: HTTP ${response.status} ${text.slice(0, 180)}`);
        }
        if (!response.body) {
            throw new Error('当前浏览器不支持流式读取响应');
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        const streamCapture = {
            reasoning: '',
            content: '',
            status: '接收中'
        };
        let buffer = '';
        const handleSseLine = line => {
            const trimmed = line.trim();
            if (!trimmed || !trimmed.startsWith('data:')) return;

            const dataText = trimmed.slice(5).trim();
            if (!dataText || dataText === '[DONE]') return;

            let chunk;
            try {
                chunk = JSON.parse(dataText);
            } catch (error) {
                return;
            }

            const delta = chunk?.choices?.[0]?.delta || {};
            const reasoningDelta = getDeltaText(delta.reasoning_content);
            const contentDelta = getDeltaText(delta.content);

            if (reasoningDelta) streamCapture.reasoning += reasoningDelta;
            if (contentDelta) streamCapture.content += contentDelta;

            if (reasoningDelta || contentDelta) {
                onStreamUpdate?.({ ...streamCapture });
            }
        };

        while (true) {
            const { value, done } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split(/\r?\n/);
            buffer = lines.pop() || '';

            for (const line of lines) {
                handleSseLine(line);
            }
        }
        buffer += decoder.decode();
        if (buffer.trim()) handleSseLine(buffer);

        streamCapture.status = '接收完成';
        onStreamUpdate?.({ ...streamCapture });

        if (!streamCapture.content.trim()) {
            throw new Error('GLM 流式响应缺少结果文本 content');
        }

        return {
            aiResult: parseAiJson(streamCapture.content),
            streamCapture
        };
    }

    function parseAiJson(content) {
        const trimmed = String(content).trim()
            .replace(/^```json\s*/i, '')
            .replace(/^```\s*/i, '')
            .replace(/```$/i, '')
            .trim();

        try {
            return JSON.parse(trimmed);
        } catch (error) {
            const start = trimmed.indexOf('{');
            const end = trimmed.lastIndexOf('}');
            if (start >= 0 && end > start) {
                return JSON.parse(trimmed.slice(start, end + 1));
            }
            throw error;
        }
    }

    function normalizeAiRows(aiResult, localScan) {
        const byId = new Map(localScan.shortlist.map(candidate => [candidate.id, candidate]));
        const rows = [];
        const used = new Set();

        if (Array.isArray(aiResult?.top10)) {
            aiResult.top10.forEach((item, index) => {
                const candidate = byId.get(item.id);
                if (!candidate || used.has(candidate.id)) return;
                used.add(candidate.id);
                rows.push({
                    rank: Number(item.rank) || rows.length + 1,
                    candidate,
                    reason: item.reason || '',
                    risk: item.risk || '',
                    confidence: item.confidence || '中'
                });
            });
        }

        localScan.shortlist.forEach(candidate => {
            if (rows.length >= 10) return;
            if (used.has(candidate.id)) return;
            used.add(candidate.id);
            rows.push({
                rank: rows.length + 1,
                candidate,
                reason: '本地评分靠前，回报率、价差和安全垫相对均衡。',
                risk: '需复核财报、消息面和盘中真实成交价。',
                confidence: '中'
            });
        });

        return rows.slice(0, 10).map((row, index) => ({ ...row, rank: index + 1 }));
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
            `<td>${candidate.volume}</td>`,
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
            '<div class="ai-summary-block">',
            '<strong>候选扫描结果</strong>',
            `<p>共 ${localScan.candidates.length} 个候选。筛选条件：${escapeHtml(describeFilters(settings))}。</p>`,
            `<p>扫描结果已限制每只股票最多保留本地评分前 ${settings.perSymbolLimit} 个；点击“AI分析 Top 10”会把其中前 ${localScan.shortlist.length} 个候选发送给智谱做总结和排序。</p>`,
            '</div>',
            '<div class="ai-results-table-wrap">',
            '<table class="table table-sm table-hover align-middle sortable-table ai-results-table ai-candidate-table">',
            '<thead><tr>',
            headerCells,
            '</tr></thead>',
            `<tbody>${tableRows}</tbody>`,
            '</table>',
            '</div>',
            `<div class="ai-mobile-results">${cards}</div>`
        ].join(''));
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
        const summary = aiResult?.summary || '已根据本地计算结果生成 Top 10 候选。';
        const errorBlock = glmFailedMessage
            ? `<div class="alert alert-warning ai-warning">GLM 总结失败，已显示本地预筛结果：${escapeHtml(glmFailedMessage)}</div>`
            : '';
        const notesHtml = notes.length
            ? `<ul class="ai-notes">${notes.map(note => `<li>${escapeHtml(note)}</li>`).join('')}</ul>`
            : '';

        setOutput([
            errorBlock,
            '<div class="ai-summary-block">',
            `<strong>总结</strong><p>${escapeHtml(summary)}</p>`,
            notesHtml,
            '</div>',
            streamCapture ? renderGlmStreamBlock(streamCapture) : '',
            renderRows(rows)
        ].join(''));
    }

    function renderLocalPreview(localScan) {
        renderResult({
            summary: `本地预筛得到 ${localScan.candidates.length} 个候选，等待 GLM 生成最终排序和理由。`,
            top10: localScan.shortlist.slice(0, 10).map((candidate, index) => ({
                id: candidate.id,
                rank: index + 1
            })),
            notes: localScan.errors.length ? [`部分股票读取失败：${localScan.errors.slice(0, 3).join('；')}`] : []
        }, localScan);
    }

    async function runCandidateScan() {
        const settings = getSettings();
        persistKey(settings);
        const runId = ++activeRunId;
        setStatus('扫描中');
        setProgress(2, '准备扫描股票列表');
        setOutput('<div class="ai-empty-state">正在扫描本地期权缓存...</div>');

        try {
            const localScan = await scanLocalCandidates(settings, runId);
            if (!localScan || runId !== activeRunId) return;
            if (localScan.candidates.length === 0) {
                setStatus('无候选');
                setProgress(100, '没有符合过滤条件的候选');
                setOutput('<div class="ai-empty-state ai-empty-state-error">没有找到符合当前过滤条件的期权候选，请放宽买价、相对差、持仓、价差或到期范围。</div>');
                return;
            }

            latestLocalScan = localScan;
            latestCandidateSettings = settings;
            latestScanSignature = getScanSignature(settings);
            candidateSortConfig = { ...DEFAULT_CANDIDATE_SORT };
            setStatus('候选完成');
            setProgress(100, `扫描完成，共 ${localScan.candidates.length} 个候选`);
            renderCandidateList(localScan, settings);
        } catch (error) {
            if (runId !== activeRunId) return;
            setStatus('失败');
            setProgress(100, '扫描失败');
            setOutput(`<div class="ai-empty-state ai-empty-state-error">扫描失败：${escapeHtml(error.message)}</div>`);
        }
    }

    async function runRecommendation() {
        const settings = getSettings();
        if (!settings.apiKey) {
            setStatus('缺少 Key');
            setOutput('<div class="ai-empty-state ai-empty-state-error">请先在页面顶部填写智谱 API Key。</div>');
            return;
        }

        persistKey(settings);
        const runId = ++activeRunId;
        const scanSignature = getScanSignature(settings);
        setStatus('准备分析');
        setProgress(4, '检查本地候选列表');

        try {
            let localScan = latestLocalScan;
            if (!localScan || latestScanSignature !== scanSignature) {
                setStatus('扫描中');
                setProgress(8, '筛选条件已变更，重新扫描候选');
                setOutput('<div class="ai-empty-state">正在扫描本地期权缓存...</div>');
                localScan = await scanLocalCandidates(settings, runId);
                if (!localScan || runId !== activeRunId) return;
                latestLocalScan = localScan;
                latestCandidateSettings = settings;
                latestScanSignature = scanSignature;
            }

            if (localScan.shortlist.length === 0) {
                setStatus('无候选');
                setProgress(100, '没有可发送给智谱的候选');
                setOutput('<div class="ai-empty-state ai-empty-state-error">没有找到符合当前过滤条件的期权候选，请先放宽筛选条件并重新扫描。</div>');
                return;
            }

            setStatus('调用 GLM');
            setProgress(72, `本地候选 ${localScan.candidates.length} 个，每股最多 ${settings.perSymbolLimit} 个，发送 ${localScan.shortlist.length} 个给智谱`);
            renderLocalPreview(localScan);
            const streamCapture = {
                reasoning: '',
                content: '',
                status: '等待智谱返回'
            };
            updateGlmStreamBlock(streamCapture);

            let aiResult;
            try {
                const glmResponse = await callGlm(settings, localScan, update => {
                    streamCapture.reasoning = update.reasoning;
                    streamCapture.content = update.content;
                    streamCapture.status = update.status;
                    updateGlmStreamBlock(streamCapture);
                });
                if (runId !== activeRunId) return;
                aiResult = glmResponse.aiResult;
                setStatus('完成');
                setProgress(100, 'AI 推荐已生成');
                renderResult(aiResult, localScan, '', glmResponse.streamCapture);
            } catch (glmError) {
                if (runId !== activeRunId) return;
                setStatus('本地结果');
                setProgress(100, 'GLM 调用失败，已显示本地预筛结果');
                streamCapture.status = '调用失败';
                renderResult(null, localScan, glmError.message, streamCapture);
            }
        } catch (error) {
            if (runId !== activeRunId) return;
            setStatus('失败');
            setProgress(100, '扫描失败');
            setOutput(`<div class="ai-empty-state ai-empty-state-error">扫描失败：${escapeHtml(error.message)}</div>`);
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
        const scanButton = $('scanAiCandidates');
        if (scanButton) {
            scanButton.addEventListener('click', runCandidateScan);
        }

        const runButton = $('runAiRecommendation');
        if (runButton) {
            runButton.addEventListener('click', runRecommendation);
        }

        const rememberInput = $('rememberGlmKey');
        if (rememberInput) {
            rememberInput.addEventListener('change', () => persistKey(getSettings()));
        }

        const keyInput = $('glmApiKey');
        if (keyInput) {
            keyInput.addEventListener('change', () => persistKey(getSettings()));
        }

        const output = $('aiRecommendationOutput');
        if (output) {
            output.addEventListener('click', event => {
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
        restoreKey();
        bindEvents();
    }

    window.aiRecommendations = {
        run: runRecommendation,
        scan: runCandidateScan,
        getSettings,
        getOverviewSymbols
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
