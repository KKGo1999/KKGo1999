const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');
const { chromium, webkit } = require('playwright');
const core = require('../options/analysisCore.js');

const root = path.resolve(__dirname, '..');
const now = new Date().toISOString();
const expiry = new Date(Date.now() + 60 * 86400000).toISOString().slice(0, 10);
const stamp = now.slice(0, 19).replace('T', ' ');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
let server, origin;

before(async () => {
    server = http.createServer(async (req, res) => {
        let file = path.resolve(root, '.' + decodeURIComponent(new URL(req.url, 'http://local').pathname));
        if (!file.startsWith(root + path.sep) && file !== root) { res.writeHead(403).end(); return; }
        try {
            if ((await fs.stat(file)).isDirectory()) file = path.join(file, 'index.html');
            const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };
            res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream' });
            res.end(await fs.readFile(file));
        } catch { res.writeHead(404).end(); }
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    origin = 'http://127.0.0.1:' + server.address().port;
    await fs.mkdir(path.join(root, 'test-results'), { recursive: true });
});
after(async () => { if (server) await new Promise(resolve => server.close(resolve)); });

function chain(symbol, stale = false) {
    const contract = symbol + expiry.replaceAll('-', '').slice(2) + 'P00015000';
    const base = { optionType: 'put', expiryDate: expiry, strike: 15, bid: 1, ask: 1.1,
        openInterest: 100, volume: 10, contractMultiplier: 100 };
    return { schemaVersion: '1.1.0', symbol, generatedAt: stale ? '2020-01-01T00:00:00Z' : now,
        snapshotId: 'browser-fixture', sourceTimestamp: stale ? '2020-01-01 16:00:00' : stamp,
        options: [{ ...base, contractSymbol: contract },
            { ...base, strike: 16, contractSymbol: contract.replace('00015000', '00016000') },
            { ...base, strike: 17, contractSymbol: contract.replace('00015000', '00017000') },
            { ...base, strike: 14, contractSymbol: symbol + '1' + contract.slice(symbol.length) }] };
}
function quote(symbol) {
    const fields = Array(40).fill('');
    fields[3] = '20'; fields[4] = '19'; fields[30] = stamp; fields[31] = '1'; fields[32] = '5.26';
    return 'v_us' + symbol + '="' + fields.join('~') + '";';
}
function aiEvents(body, mode = 'success') {
    const openai = Array.isArray(body.input);
    const payload = JSON.parse(openai ? body.input[1].content : body.messages[1].content);
    const result = mode === 'invalid' ? {} : { summary: '测试推荐，仅依据提供的候选。', notes: ['报价需复核。'],
        top10: [{ id: payload.candidates[0].id, rank: 1, reason: '流动性与价格缓冲较好。', risk: '价格下跌及指派风险。', confidence: '中' }] };
    const text = JSON.stringify(result);
    const events = openai ? [
        { type: 'response.reasoning_summary_text.delta', delta: '测试推理摘要' },
        { type: 'response.output_text.delta', delta: text },
        { type: 'response.completed', response: { status: 'completed', id: 'test-response',
            usage: { input_tokens: 123, output_tokens: 45 }, output: [{ type: 'message', content: [{ type: 'output_text', text }] }] } }
    ] : [
        { choices: [{ delta: { reasoning_content: '测试 GLM thinking' } }] },
        { choices: [{ delta: { content: text } }] },
        { choices: [{ delta: {}, finish_reason: 'stop' }], usage: { total_tokens: 123 } }
    ];
    return events.map(event => 'data: ' + JSON.stringify(event) + '\r\n\r\n').join('') + 'data: [DONE]\r\n\r\n';
}

async function fixture(browser, options = {}) {
    const context = await browser.newContext({ viewport: options.viewport || { width: 1440, height: 1000 },
        colorScheme: options.dark ? 'dark' : 'light', acceptDownloads: true });
    const state = { mode: 'success', stale: false, slowBili: false, requests: [], quoteRequests: [], errors: [] };
    await context.route('**/*', async route => {
        const url = new URL(route.request().url());
        if (url.hostname === 'qt.gtimg.cn') {
            const symbol = url.href.split('=us')[1];
            state.quoteRequests.push(symbol);
            if (state.slowBili && symbol === 'BILI') await wait(800);
            await route.fulfill({ contentType: 'text/plain', body: quote(symbol) });
        } else if (url.hostname === 'web.ifzq.gtimg.cn') {
            const code = url.searchParams.get('param').split(',')[0];
            const day = Array.from({ length: 6 }, (_, i) => [now.slice(0, 4) + '-01-0' + (i + 2), 18, 18]);
            await route.fulfill({ json: { data: { [code]: { day } } } });
        } else if (url.pathname.match(/^\/options\/data\/options\/[^/]+\.json$/)) {
            const symbol = path.basename(url.pathname, '.json');
            if (state.slowBili && symbol === 'BILI') await wait(800);
            await route.fulfill({ json: chain(symbol, state.stale) });
        } else if (['api.openai.com', 'open.bigmodel.cn'].includes(url.hostname)) {
            const body = route.request().postDataJSON();
            state.requests.push({ url: url.href, body, authorization: route.request().headers().authorization });
            if (state.mode === 'slow') await wait(1000);
            await route.fulfill({ contentType: 'text/event-stream', body: aiEvents(body, state.mode) });
        } else if (url.origin === origin) await route.continue();
        else await route.abort();
    });
    const page = await context.newPage();
    page.setDefaultTimeout(10000);
    page.on('pageerror', error => state.errors.push(error.message));
    page.on('dialog', dialog => dialog.dismiss());
    await page.goto(origin + '/options/');
    await page.waitForFunction(() => document.querySelector('#price-AMD')?.textContent.startsWith('$'));
    assert.equal(await page.locator('#overviewTable tbody tr').count(), core.WATCHLIST.length);
    return { context, page, state };
}

async function scan(page) {
    await page.locator('#scanAiCandidates').click();
    await page.waitForFunction(() => document.querySelector('#aiRecommendationStatus').textContent === '候选完成');
    assert.ok(await page.locator('.ai-candidate-table tbody tr').count() > 10);
}
async function chooseStock(page, symbol) {
    await page.locator('#stockSelect').fill(symbol);
    await page.locator('#stockSelect').dispatchEvent('change');
}
async function expectStatus(page, text) {
    await page.waitForFunction(value => document.querySelector('#aiRecommendationStatus').textContent === value, text);
}
async function readHistory(page) {
    return page.evaluate(() => window.OptionsHistory.createStore().list());
}

for (const profile of [
    { name: 'chromium-desktop', engine: chromium, viewport: { width: 1440, height: 1000 } },
    { name: 'chromium-mobile-dark', engine: chromium, viewport: { width: 390, height: 844 }, dark: true },
    { name: 'webkit-mobile', engine: webkit, viewport: { width: 390, height: 844 } }
]) {
    test(profile.name + ': complete scan, AI, history, cancellation and responsive layout', { timeout: 120000 }, async () => {
        const browser = await profile.engine.launch();
        let context;
        try {
            const setup = await fixture(browser, profile);
            const { page, state } = setup; context = setup.context;
            assert.equal(await page.locator('html').getAttribute('data-theme'), profile.dark ? 'dark' : 'light');
            assert.equal(await page.locator('html').getAttribute('data-bs-theme'), profile.dark ? 'dark' : 'light');
            if (profile.dark) await page.waitForFunction(() => getComputedStyle(document.querySelector('#currentPrice')).color === 'rgb(248, 249, 250)');
            await page.locator('#aiProvider').selectOption('openai');
            assert.deepEqual(await page.locator('#aiModel option').evaluateAll(nodes => nodes.map(n => n.value)), ['gpt-6.2-sol', 'gpt-6.2-astra']);
            await page.locator('#aiApiKey').fill('test-openai-only');
            await scan(page);
            const exported = await page.evaluate(() => window.aiRecommendations.getScanExport());
            assert.ok(exported.counts.retained <= core.WATCHLIST.length * 3);
            assert.equal(exported.dataQuality.requiresConfirmation, false);
            assert.ok(!JSON.stringify(exported).includes('test-openai-only'));
            if (await page.locator('[data-ai-sort="localScore"]').isVisible()) await page.locator('[data-ai-sort="localScore"]').click();
            await page.locator('#runAiRecommendation').click();
            await expectStatus(page, '完成');
            await page.waitForFunction(() => document.querySelector('#toggleAiHistory').textContent.includes('(1)'));
            assert.equal(await page.locator('.ai-results-table tbody tr').count(), 1);
            assert.equal(await page.locator('#glmThinkingText').textContent(), '测试推理摘要');
            const entries = await readHistory(page);
            assert.equal(entries[0].model, 'gpt-6.2-sol');
            assert.equal(entries[0].provider, 'openai');
            assert.equal(entries[0].analysisData.counts.retained, exported.counts.retained);
            assert.equal(state.requests[0].authorization, 'Bearer test-openai-only');
            assert.ok(!JSON.stringify(entries).includes('test-openai-only'));
            assert.ok(!await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }).includes('test-openai-only')));

            await chooseStock(page, 'SOFI');
            await page.waitForSelector('#advancedResultTable');
            assert.equal(await page.locator('#advancedResultTable tbody tr').count(), 3);
            const metric = core.optionMetrics('SOFI', 20, chain('SOFI').options[0], now);
            assert.equal(await page.locator('#advancedResultTable [data-strike="15"] .advanced-return').textContent(), metric.annualReturn.toFixed(2) + '%');
            await page.evaluate(() => window.scrollTo(0, 0));
            await page.screenshot({ path: path.join(root, 'test-results', profile.name + '.png'), fullPage: true });
            assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true, 'page must not overflow horizontally');
            const rectangles = await page.locator('.page-title, .theme-switch-wrapper, #aiProvider, #aiModel, #aiApiKey').evaluateAll(nodes => nodes.map(node => {
                const r = node.getBoundingClientRect(); return { x: r.x, y: r.y, right: r.right, bottom: r.bottom };
            }));
            for (let i = 0; i < rectangles.length; i++) for (let j = i + 1; j < rectangles.length; j++) {
                const a = rectangles[i], b = rectangles[j];
                assert.ok(a.right <= b.x || b.right <= a.x || a.bottom <= b.y || b.bottom <= a.y, 'header controls overlap');
            }

            state.mode = 'invalid';
            await page.locator('#runAiRecommendation').click();
            await expectStatus(page, '本地结果');
            assert.match(await page.locator('#aiRecommendationOutput').textContent(), /非\s*AI\s*推荐/);
            assert.equal((await readHistory(page)).length, 1);

            state.mode = 'slow';
            await page.locator('#runAiRecommendation').click();
            await page.waitForFunction(() => !document.querySelector('#cancelAiAnalysis').hidden);
            await page.locator('#cancelAiAnalysis').click();
            await wait(1100);
            await expectStatus(page, '已取消');
            assert.equal((await readHistory(page)).length, 1);

            await page.locator('#aiProvider').selectOption('glm');
            assert.equal(await page.locator('#aiApiKey').inputValue(), '');
            assert.equal(await page.locator('#aiModelField').isVisible(), false);
            await page.locator('#aiApiKey').fill('test-glm-only');
            state.mode = 'success';
            await page.locator('#runAiRecommendation').click();
            await expectStatus(page, '完成');
            await page.waitForFunction(() => document.querySelector('#toggleAiHistory').textContent.includes('(2)'));
            assert.equal(state.requests.at(-1).authorization, 'Bearer test-glm-only');
            assert.equal(state.requests.at(-1).body.model, 'glm-5.3');
            await page.locator('#aiProvider').selectOption('openai');
            assert.equal(await page.locator('#aiApiKey').inputValue(), 'test-openai-only');
            await page.locator('#aiModel').selectOption('gpt-6.2-astra');
            await page.locator('#runAiRecommendation').click();
            await expectStatus(page, '完成');
            await page.waitForFunction(() => document.querySelector('#toggleAiHistory').textContent.includes('(3)'));
            assert.equal(state.requests.at(-1).body.model, 'gpt-6.2-astra');

            await page.locator('#toggleAiHistory').click();
            const downloadEvent = page.waitForEvent('download');
            await page.locator('#exportAiHistory').click();
            const downloaded = await downloadEvent;
            const backup = JSON.parse(await fs.readFile(await downloaded.path(), 'utf8'));
            assert.equal(backup.entries.length, 3);
            await page.locator('#aiHistoryFile').setInputFiles({ name: 'history.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(backup)) });
            await page.waitForFunction(() => document.querySelector('#aiHistoryStatus').textContent.includes('备份已合并'));
            assert.equal((await readHistory(page)).length, 3);
            await page.locator('[data-history-view]').first().click();
            await expectStatus(page, '历史记录');

            await page.reload();
            assert.equal(await page.locator('#aiApiKey').inputValue(), '');
            assert.equal((await readHistory(page)).length, 3);
            await page.setViewportSize({ width: 320, height: 720 });
            await page.locator('#aiProvider').selectOption('openai');
            assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
            assert.deepEqual(state.errors, []);
        } finally { await context?.close(); await browser.close(); }
    });
}

test('stock-switch race, stale confirmation, long history, migration and storage failure', { timeout: 90000 }, async () => {
    const browser = await chromium.launch();
    let context;
    try {
        const setup = await fixture(browser); const { page, state } = setup; context = setup.context;
        await page.evaluate(() => window.apiService.pageCache.clear());
        state.slowBili = true;
        await chooseStock(page, 'BILI');
        await wait(100);
        await chooseStock(page, 'SOFI');
        await page.waitForSelector('#advancedResultTable');
        await wait(1000);
        assert.equal(await page.evaluate(() => window.optionsStockState.symbol), 'SOFI');
        assert.match(await page.locator('#advancedAnalysisTitle').textContent(), /SOFI/);
        state.slowBili = false; state.stale = true;
        await scan(page);
        await page.locator('#aiApiKey').fill('test-no-billing');
        await page.locator('#runAiRecommendation').click();
        await expectStatus(page, '待复核数据');
        assert.equal(state.requests.length, 0);

        const longHistory = await page.evaluate(async () => {
            const entry = { id: 'legacy-first', createdAt: new Date().toISOString(), summary: '旧版', rows: [], notes: [],
                streamCapture: { reasoning: 'x'.repeat(70000), content: '完整结果' } };
            localStorage.setItem('kkgo1999.aiAnalysisHistory', JSON.stringify([entry]));
            const store = window.OptionsHistory.createStore({ name: 'migration-test' });
            await store.ready;
            for (let i = 0; i < 55; i++) await store.put({ ...entry, id: 'version-' + i });
            const entries = await store.list();
            await store.importFile(JSON.stringify({ schemaVersion: 1, entries }));
            let rejected = false;
            try { await store.importFile(JSON.stringify({ schemaVersion: 1, entries: [{ bad: true }] })); } catch { rejected = true; }
            return { count: (await store.list()).length, migrated: localStorage.getItem('kkgo1999.aiAnalysisHistory') === null,
                length: entries[0].streamCapture.reasoning.length, rejected };
        });
        assert.deepEqual(longHistory, { count: 56, migrated: true, length: 70000, rejected: true });

        await page.addInitScript(() => {
            localStorage.setItem('kkgo1999.glmCodingPlanKey', 'legacy-test-key');
            const original = IDBObjectStore.prototype.put;
            IDBObjectStore.prototype.put = function(value, ...args) {
                if (this.name === 'entries') throw new DOMException('Test quota full', 'QuotaExceededError');
                return original.call(this, value, ...args);
            };
        });
        state.stale = false;
        await page.reload();
        assert.equal(await page.locator('#aiApiKey').inputValue(), 'legacy-test-key');
        assert.equal(await page.evaluate(() => localStorage.getItem('kkgo1999.glmCodingPlanKey')), null);
        await page.locator('#runAiRecommendation').click();
        await expectStatus(page, '完成');
        await page.waitForFunction(() => document.querySelector('#aiHistoryStatus').textContent.includes('失败'));
        assert.equal(await page.locator('#aiHistoryStatus').isVisible(), true);
        assert.equal(await page.locator('#exportCurrentAi').isVisible(), true);
        assert.equal((await readHistory(page)).length, 0);
        assert.deepEqual(state.errors, []);
    } finally { await context?.close(); await browser.close(); }
});

test('home and shortcut pages do not run broken theme scripts', async () => {
    const browser = await chromium.launch();
    try {
        const page = await browser.newPage();
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        await page.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
        await page.goto(origin + '/');
        await page.goto(origin + '/redirect/gpt_shortcut.html');
        assert.deepEqual(errors, []);
    } finally { await browser.close(); }
});
