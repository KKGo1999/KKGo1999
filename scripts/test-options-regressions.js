const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const core = require('../options/analysisCore.js');
const ai = require('../options/aiProviders.js');
const { createRequestGate } = require('../options/asyncControl.js');
const { normalizeEntry } = require('../options/historyStore.js');
const { buildSite } = require('./build-options-data.js');
const { packageSite, ROOT_FILES, OPTION_FILES } = require('./package-site.js');
const asOf = '2026-11-18T01:00:00Z';
const option = { contractSymbol: 'BILI261218P00015000', optionType: 'put', expiryDate: '2026-12-18',
    strike: 15, bid: 1, ask: 1.1, volume: 10, openInterest: 100 };
const scan = core.scanSnapshots([{
    symbol: 'BILI', quote: { price: 20, retrievedAt: asOf, sourceTimestamp: '2026-11-17 16:00:00' },
    optionsData: { options: [option], snapshotId: 'fixture', generatedAt: asOf, sourceTimestamp: '2026-11-17 16:00:00' }
}], core.DEFAULTS, { asOf });
const result = { summary: '分析完成', notes: ['延迟行情'], top10: [{
    id: scan.shortlist[0].id, rank: 1, reason: '流动性较好', risk: '股价下跌', confidence: '中'
}] };
const settings = { provider: 'openai', model: 'gpt-6.2-sol', apiKey: 'unit-test-only' };
function stream(events, size = 17) {
    const bytes = new TextEncoder().encode(events.map(event => 'data: ' + JSON.stringify(event) + '\r\n\r\n').join(''));
    return new Response(new ReadableStream({
        start(controller) {
            for (let i = 0; i < bytes.length; i += size) controller.enqueue(bytes.slice(i, i + size));
            controller.close();
        }
    }), { headers: { 'Content-Type': 'text/event-stream' } });
}
const completed = { type: 'response.completed', response: { status: 'completed', id: 'fixture-response',
    usage: { input_tokens: 100, output_tokens: 80 }, output: [{ content: [{ type: 'output_text', text: JSON.stringify(result) }] }] } };

test('matrix and candidates share calendar, fee, multiplier and annualization', () => {
    const metrics = core.optionMetrics('BILI', 20, option, asOf);
    assert.equal(metrics.daysToExpiry, 31);
    assert.equal(metrics.annualReturn, scan.candidates[0].annualReturn);
    assert.equal(core.optionMetrics('BILI', 20, { ...option, contractSymbol: 'BILI1261218P00015000' }, asOf), null);
    assert.equal(core.optionMetrics('BILI', 20, { ...option, bid: -1 }, asOf), null);
    assert.equal(core.optionMetrics('BILI', 20, { ...option, contractMultiplier: 10 }, asOf), null);
    assert.equal(core.optionMetrics('BILI', Number.MIN_VALUE, { ...option, optionType: 'call' }, asOf), null);
});

test('old, missing, future, mixed and cached data require confirmation; weekends do not', () => {
    assert.equal(scan.dataQuality.requiresConfirmation, false);
    const source = scan.sources[0];
    for (const change of [{ optionsGeneratedAt: '2020-01-01T00:00:00Z' }, { stockRetrievedAt: null },
        { optionsGeneratedAt: '2028-01-01T00:00:00Z' }, { optionsMode: 'cached-preview' },
        { stockSourceTimestamp: '2020-01-01 12:00:00' }]) {
        assert.equal(core.assessDataQuality([{ ...source, ...change }], asOf).requiresConfirmation, true);
    }
    assert.equal(core.assessDataQuality([source, { ...source, optionsSnapshotId: 'other' }], asOf).requiresConfirmation, true);
    const friday = { ...source, optionsGeneratedAt: '2026-11-13T21:00:00Z', stockRetrievedAt: '2026-11-13T21:00:00Z',
        stockSourceTimestamp: '2026-11-13 16:00:00', optionsSourceTimestamp: '2026-11-13 16:00:00' };
    assert.equal(core.assessDataQuality([friday], '2026-11-15T12:00:00Z').requiresConfirmation, false);
});

test('request bodies isolate providers and keys; only Sol and Astra are available', () => {
    assert.deepEqual(ai.PROVIDERS.openai.models.map(model => model.id), ['gpt-6.2-sol', 'gpt-6.2-astra']);
    for (const model of ai.PROVIDERS.openai.models) {
        const request = ai.buildRequest({ ...settings, model: model.id }, scan);
        assert.equal(request.url, 'https://api.openai.com/v1/responses');
        assert.equal(request.body.store, false);
        assert.equal(request.body.thinking, undefined);
        assert.equal(request.body.temperature, undefined);
        assert.equal(request.body.text.format.strict, true);
        assert.ok(!JSON.stringify(request.body).includes(settings.apiKey));
        const input = JSON.parse(request.body.input[1].content);
        assert.deepEqual(input.sources, scan.sources);
        assert.deepEqual(input.assumptions, core.ASSUMPTIONS);
    }
    const glm = ai.buildRequest({ ...settings, provider: 'glm', model: 'glm-5.3' }, scan);
    assert.ok(glm.url.startsWith('https://open.bigmodel.cn/'));
    assert.equal(glm.body.thinking.type, 'enabled');
    assert.equal(glm.body.input, undefined);
    assert.throws(() => ai.buildRequest({ ...settings, provider: 'unknown' }, scan));
});

test('invalid AI data is rejected and fewer than ten recommendations remain fewer than ten', () => {
    for (const value of [{}, { ...result, top10: [{ ...result.top10[0], id: 'invented' }] },
        { ...result, top10: [result.top10[0], result.top10[0]] },
        { ...result, top10: [{ ...result.top10[0], risk: '' }] }]) assert.throws(() => ai.validateResult(value, scan.shortlist));
    assert.equal(ai.validateResult(result, scan.shortlist).top10.length, 1);
    assert.equal(ai.validateResult({ ...result, top10: [] }, scan.shortlist).top10.length, 0);
});

test('OpenAI streams split UTF-8, summaries, final JSON and usage without double counting', async () => {
    const updates = [];
    const response = await ai.analyze(settings, scan, {
        onUpdate: update => updates.push(update),
        fetchImpl: async (url, request) => {
            assert.equal(request.headers.Authorization, 'Bearer unit-test-only');
            return stream([{ type: 'response.reasoning_summary_text.delta', delta: '风险摘要' },
                { type: 'response.output_text.delta', delta: JSON.stringify(result) }, completed], 1);
        }
    });
    assert.equal(response.streamCapture.reasoning, '风险摘要');
    assert.deepEqual(response.aiResult, result);
    assert.equal(response.streamCapture.content, JSON.stringify(result));
    assert.equal(response.streamCapture.usage.output_tokens, 80);
    assert.ok(updates.length > 1);
});

test('GLM stream remains supported', async () => {
    const response = await ai.analyze({ ...settings, provider: 'glm', model: 'glm-5.3' }, scan, {
        fetchImpl: async () => stream([
            { choices: [{ delta: { reasoning_content: '分析' } }] },
            { choices: [{ delta: { content: JSON.stringify(result) } }] },
            { choices: [{ delta: {}, finish_reason: 'stop' }], usage: { total_tokens: 80 } }
        ])
    });
    assert.deepEqual(response.aiResult, result);
    assert.equal(response.streamCapture.reasoning, '分析');
});

test('truncation, refusal, error events and early EOF never produce successful AI results', async () => {
    for (const events of [
        [{ type: 'response.output_text.delta', delta: JSON.stringify(result) }],
        [{ type: 'response.incomplete' }], [{ type: 'response.refusal.delta', delta: 'No' }],
        [{ type: 'response.failed' }], [{ error: { message: 'failed' } }],
        [{ type: 'response.completed', response: { status: 'completed', output: [{ content: [{ type: 'output_text', text: '{}' }] }] } }]
    ]) await assert.rejects(ai.analyze(settings, scan, { fetchImpl: async () => stream(events) }));
    await assert.rejects(ai.analyze({ ...settings, provider: 'glm', model: 'glm-5.3' }, scan,
        { fetchImpl: async () => stream([{ choices: [{ delta: {}, finish_reason: 'length' }] }]) }));
});

test('HTTP errors redact upstream text and key; no automatic retries', async () => {
    for (const status of [400, 401, 403, 404, 429, 500]) {
        let count = 0;
        await assert.rejects(ai.analyze(settings, scan, { fetchImpl: async () => {
            count++;
            return new Response(JSON.stringify({ error: { message: settings.apiKey } }), { status });
        } }), error => !error.message.includes(settings.apiKey));
        assert.equal(count, 1);
    }
});

test('cancel and timeout abort the underlying request', async () => {
    const fetchImpl = (url, { signal }) => new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => reject(new DOMException('Cancelled', 'AbortError')), { once: true });
    });
    const controller = new AbortController();
    const pending = ai.analyze(settings, scan, { fetchImpl, signal: controller.signal });
    controller.abort();
    await assert.rejects(pending, { name: 'AbortError' });
    await assert.rejects(ai.analyze(settings, scan, { fetchImpl, timeoutMs: 5 }), /超时/);
    const gate = createRequestGate();
    const first = gate.start();
    const second = gate.start();
    assert.equal(first.signal.aborted, true);
    assert.equal(gate.current(first), false);
    assert.equal(gate.current(second), true);
    gate.cancel();
    assert.equal(second.signal.aborted, true);
});

test('history preserves full text and strips credentials, including nested imports', () => {
    const entry = normalizeEntry({ id: 'history-1', createdAt: asOf, summary: result.summary, notes: [],
        settings: { apiKey: 'secret-test' }, apiKey: 'secret-test',
        analysisData: { nested: { authorization: 'secret-test' } },
        streamCapture: { reasoning: 'a'.repeat(70000), content: 'x' },
        rows: [{ ...result.top10[0], candidate: scan.shortlist[0] }] });
    assert.equal(entry.streamCapture.reasoning.length, 70000);
    assert.equal(entry.provider, 'glm');
    assert.ok(!JSON.stringify(entry).includes('secret-test'));
    assert.throws(() => normalizeEntry({ ...entry, rows: [{ candidate: { ...entry.rows[0].candidate, strike: '<script>' } }] }));
});

test('packaging uses a public allowlist and marks cached snapshots without inventing new quote times', async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'options-package-test-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const repo = path.resolve(__dirname, '..');
    for (const item of ROOT_FILES) await fs.cp(path.join(repo, item), path.join(root, item), { recursive: true });
    await fs.mkdir(path.join(root, 'options'), { recursive: true });
    for (const item of OPTION_FILES.filter(item => !['data', 'agent'].includes(item))) {
        await fs.cp(path.join(repo, 'options', item), path.join(root, 'options', item), { recursive: true });
    }
    await fs.cp(path.join(repo, 'options/agent'), path.join(root, 'options/agent'), {
        recursive: true, filter: source => !source.includes('/stocks/') && !source.endsWith('/stocks')
    });
    await buildSite({ root, asOf, symbols: ['BILI'],
        loadOptions: async () => ({ timestamp: '2026-11-17 16:00:00', data: { options: [
            { option: option.contractSymbol, bid: 1, ask: 1.1, open_interest: 100, volume: 10 }
        ] } }), loadQuote: async () => ({ price: 20, retrievedAt: asOf, sourceTimestamp: '2026-11-17 16:00:00' }),
        loadYtd: async () => ({ percent: 2, basePrice: 19, baseDate: '2026-01-02' }) });
    await fs.writeFile(path.join(root, '.env'), 'NOT-PUBLIC');
    const deployment = { runId: '123', commit: 'a'.repeat(40), publishedAt: '2026-11-18T02:00:00Z' };
    await packageSite(root, path.join(root, 'dist'), { cached: true, deployment });
    await assert.rejects(fs.access(path.join(root, 'dist/.env')));
    await assert.rejects(fs.access(path.join(root, 'dist/package.json')));
    const data = JSON.parse(await fs.readFile(path.join(root, 'dist/options/data/options/BILI.json'), 'utf8'));
    assert.equal(data.mode, 'cached-preview');
    assert.equal(data.generatedAt, asOf);
    const manifest = JSON.parse(await fs.readFile(path.join(root, 'dist/options/data/options-manifest.json'), 'utf8'));
    assert.deepEqual(manifest.deployment, deployment);
    assert.equal(manifest.generatedAt, asOf);
    const candidates = JSON.parse(await fs.readFile(path.join(root, 'dist/options/data/candidates.json'), 'utf8'));
    assert.equal(candidates.dataQuality.requiresConfirmation, true);
});
