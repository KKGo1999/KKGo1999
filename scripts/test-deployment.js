const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const YAML = require('yaml');
const { waitForPagesArtifact, RETRY_DELAYS } = require('./wait-pages-artifact.js');
const { fetchCboeOptions, buildSite } = require('./build-options-data.js');
const { formatRefreshSummary } = require('./summarize-options-refresh.js');

const artifact = { name: 'github-pages-123-2', id: 456, size: 1024 };
const quiet = { log() {}, warn() {} };
const ready = overrides => waitForPagesArtifact({ artifactName: artifact.name, artifactId: String(artifact.id),
    listArtifacts: async () => ({ artifacts: [artifact] }), log() {}, ...overrides });

test('Pages lookup waits for the exact build artifact and ignores older attempts', async () => {
    const waits = [];
    let calls = 0;
    const found = await ready({ wait: async ms => waits.push(ms), listArtifacts: async () => ({
        artifacts: ++calls < 3 ? [{ ...artifact, name: 'github-pages-123-1', id: 111 }] : [artifact]
    }) });
    assert.deepEqual(found, artifact);
    assert.equal(calls, 3);
    assert.deepEqual(waits, [5000, 10000]);
});

test('Pages lookup is bounded and never substitutes another artifact', async () => {
    let calls = 0;
    const waits = [];
    await assert.rejects(ready({ listArtifacts: async () => { calls++; return { artifacts: [] }; },
        wait: async ms => waits.push(ms) }), /after 6 lookups/);
    assert.equal(calls, 6);
    assert.deepEqual(waits, RETRY_DELAYS);
    for (const artifacts of [[{ ...artifact, id: 999 }], [artifact, artifact], [{ ...artifact, size: 0 }]]) {
        await assert.rejects(ready({ listArtifacts: async () => ({ artifacts }), wait: async () => assert.fail('must not retry') }));
    }
    await assert.rejects(ready({ listArtifacts: async () => ({}) }), /Invalid/);
    for (const value of [{ artifactId: '' }, { artifactName: 'github-pages' }, { artifactId: 'not-an-id' }]) {
        await assert.rejects(ready({ ...value, listArtifacts: async () => assert.fail('must validate first') }), /invalid/);
    }
});

test('Pages lookup retries temporary HTTP errors but fails promptly on permissions', async () => {
    for (const status of [408, 429, 503]) {
        let calls = 0;
        await ready({ wait: async () => {}, listArtifacts: async () => {
            if (++calls === 1) throw Object.assign(new Error('temporary'), { status });
            return { artifacts: [artifact] };
        } });
        assert.equal(calls, 2);
    }
    for (const status of [401, 403]) {
        let calls = 0;
        await assert.rejects(ready({ listArtifacts: async () => { calls++; throw Object.assign(new Error('denied'), { status }); },
            wait: async () => assert.fail('must not retry') }), /credentials/);
        assert.equal(calls, 1);
    }
});

test('official artifact SDK uses the internal ListArtifacts service with Actions runtime credentials', { timeout: 15000 }, async t => {
    const requests = [];
    const server = http.createServer(async (req, res) => {
        let body = '';
        for await (const chunk of req) body += chunk;
        requests.push({ path: req.url, method: req.method, body: JSON.parse(body), authorization: req.headers.authorization });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ artifacts: requests.length === 1 ? [] : [
            { name: artifact.name, databaseId: String(artifact.id), size: String(artifact.size) }
        ] }));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
    const token = ['e30', Buffer.from(JSON.stringify({ scp: 'Actions.Results:fixture-run:fixture-job' })).toString('base64url'), 'fixture'].join('.');
    const script = `require(${JSON.stringify(path.join(__dirname, 'wait-pages-artifact.js'))}).checkPagesArtifact().catch(error => { console.error(error); process.exitCode = 1; })`;
    const { stdout } = await promisify(execFile)(process.execPath, ['-e', script], { timeout: 12000,
        env: { ...process.env, ACTIONS_RESULTS_URL: `http://127.0.0.1:${server.address().port}`,
            ACTIONS_RUNTIME_TOKEN: token, GITHUB_SERVER_URL: 'https://github.com',
            no_proxy: '127.0.0.1', NO_PROXY: '127.0.0.1',
            PAGES_ARTIFACT_NAME: artifact.name, PAGES_ARTIFACT_ID: String(artifact.id) } });
    assert.match(stdout, /Pages artifact ready/);
    assert.equal(requests.length, 2);
    for (const request of requests) {
        assert.equal(request.path, '/twirp/github.actions.results.api.v1.ArtifactService/ListArtifacts');
        assert.equal(request.method, 'POST');
        assert.equal(request.authorization, 'Bearer ' + token);
        assert.deepEqual(request.body, { workflow_run_backend_id: 'fixture-run', workflow_job_run_backend_id: 'fixture-job' });
    }
});

test('workflow separates build/deploy and preserves build identity on deploy-only reruns', async () => {
    const workflow = YAML.parse(await fs.readFile(path.join(__dirname, '../.github/workflows/static.yml'), 'utf8'));
    const { build, deploy } = workflow.jobs;
    const step = (job, name) => job.steps.find(item => item.name === name);
    const byId = (job, id) => job.steps.find(item => item.id === id);
    assert.equal(deploy.needs, 'build');
    assert.equal(build.environment, undefined);
    assert.deepEqual(workflow.permissions, { contents: 'read' });
    assert.equal(deploy.environment.name, 'github-pages');
    assert.equal(deploy.permissions.pages, 'write');
    assert.equal(deploy.permissions['id-token'], 'write');
    assert.match(byId(build, 'artifact_name').run, /github-pages-\$\{GITHUB_RUN_ID\}-\$\{GITHUB_RUN_ATTEMPT\}/);
    assert.equal(build.outputs.artifact_name, '${{ steps.artifact_name.outputs.name }}');
    assert.equal(build.outputs.artifact_id, '${{ steps.upload.outputs.artifact_id }}');
    assert.equal(byId(build, 'upload').with.name, '${{ steps.artifact_name.outputs.name }}');
    const guard = step(deploy, 'Wait for Pages artifact');
    assert.equal(guard.env.PAGES_ARTIFACT_NAME, '${{ needs.build.outputs.artifact_name }}');
    assert.equal(guard.env.PAGES_ARTIFACT_ID, '${{ needs.build.outputs.artifact_id }}');
    assert.equal(guard['timeout-minutes'], 4);
    assert.equal(byId(deploy, 'deployment').with.artifact_name, '${{ needs.build.outputs.artifact_name }}');
    assert.ok(deploy.steps.indexOf(guard) < deploy.steps.indexOf(byId(deploy, 'deployment')));
    assert.equal(deploy.steps.filter(item => item.uses?.startsWith('actions/deploy-pages@')).length, 1);
    assert.equal(deploy.steps.some(item => item.uses?.startsWith('actions/upload-pages-artifact@')), false);
    assert.equal(byId(build, 'refresh')['continue-on-error'], true);
    assert.equal(byId(build, 'package_cached').if, "steps.refresh.outcome != 'success'");
    assert.match(step(build, 'Summarize options refresh').if, /!cancelled\(\)/);
    const reportPath = byId(build, 'refresh').env.OPTIONS_REFRESH_REPORT;
    assert.ok(reportPath.startsWith('${{ runner.temp }}'));
    assert.equal(step(build, 'Summarize options refresh').env.OPTIONS_REFRESH_REPORT, reportPath);
});

test('Cboe logs HTTP status and attempt count for retries and eventual success', async () => {
    const logs = [], waits = [];
    let calls = 0;
    const data = await fetchCboeOptions('BILI', { logger: { log: s => logs.push(s), warn: s => logs.push(s) },
        wait: async ms => waits.push(ms), fetchImpl: async (url, request) => {
            assert.equal(url, 'https://cdn.cboe.com/api/global/delayed_quotes/options/BILI.json');
            assert.ok(request.signal instanceof AbortSignal);
            return ++calls === 1 ? new Response('private upstream body', { status: 503 }) :
                Response.json({ data: { options: [] } });
        } });
    assert.deepEqual(data.data.options, []);
    assert.deepEqual(waits, [1000]);
    assert.match(logs[0], /attempt 1\/3, retries 0, HTTP 503/);
    assert.match(logs[1], /attempt 2\/3, retries 1, HTTP 200, success/);
    assert.ok(!logs.join('').includes('private upstream body'));
});

test('Cboe distinguishes HTTP errors, timeouts, network errors and malformed responses', async () => {
    for (const [failure, expected] of [
        [async () => new Response('private upstream body', { status: 403 }), /HTTP 403/],
        [async () => new Response('private upstream body', { status: 200 }), /HTTP 200; invalid JSON/],
        [async () => Response.json({ changed: true }), /HTTP 200; response has no options array/],
        [async () => { throw new DOMException('timeout', 'TimeoutError'); }, /no HTTP response; request timed out/],
        [async () => { throw new TypeError('fetch failed', { cause: { code: 'ECONNRESET' } }); }, /no HTTP response; fetch failed \(ECONNRESET\)/]
    ]) {
        const logs = [], waits = [];
        let calls = 0;
        await assert.rejects(fetchCboeOptions('BILI', { fetchImpl: async () => { calls++; return failure(); },
            wait: async ms => waits.push(ms), logger: { log: s => logs.push(s), warn: s => logs.push(s) } }), error => {
            assert.match(error.message, expected);
            assert.match(error.message, /attempts=3, retries=2/);
            assert.equal(error.attempts, 3);
            return true;
        });
        assert.equal(calls, 3);
        assert.deepEqual(waits, [1000, 2000]);
        assert.match(logs[2], /giving up/);
        assert.ok(!logs.join('').includes('private upstream body'));
    }
});

test('total refresh failure persists per-symbol diagnostics without overwriting the snapshot', async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'options-refresh-failure-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const dataDir = path.join(root, 'options/data');
    await fs.mkdir(dataDir, { recursive: true });
    const manifestPath = path.join(dataDir, 'options-manifest.json');
    const previous = JSON.stringify({ snapshotId: 'previous' });
    await fs.writeFile(manifestPath, previous);
    const reportPath = path.join(root, 'report.json');
    await assert.rejects(buildSite({ root, reportPath, symbols: ['BILI', 'SOFI'], logger: quiet,
        loadOptions: symbol => fetchCboeOptions(symbol, { logger: quiet, wait: async () => {},
            fetchImpl: async () => new Response('', { status: 403 }) }),
        loadQuote: async () => { throw new Error('quote offline'); }, loadYtd: async () => null
    }), /No options available/);
    assert.equal(await fs.readFile(manifestPath, 'utf8'), previous);
    const report = JSON.parse(await fs.readFile(reportPath, 'utf8'));
    assert.equal(report.totalSymbols, 2);
    assert.equal(report.availableSymbols, 0);
    assert.deepEqual(report.failures.map(item => item.symbol), ['BILI', 'SOFI']);
    for (const item of report.failures) {
        assert.match(item.errors.join('; '), /stock: quote offline/);
        assert.match(item.errors.join('; '), /HTTP 403.*attempts=3, retries=2/);
    }
});

test('partial refresh keeps diagnostics for missing contracts while publishing available symbols', async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'options-refresh-partial-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const reportPath = path.join(root, 'report.json');
    const result = await buildSite({ root, reportPath, asOf: '2026-11-21T00:00:00Z', symbols: ['BILI', 'SOFI'], logger: quiet,
        loadOptions: async symbol => ({ data: { options: symbol === 'BILI' ? [
            { option: 'BILI261218P00015000', bid: 1, ask: 1.1, open_interest: 100 }
        ] : [] } }), loadQuote: async () => ({ price: 20 }), loadYtd: async () => null });
    assert.equal(result.manifest.symbols[0].optionCount, 1);
    const report = JSON.parse(await fs.readFile(reportPath, 'utf8'));
    assert.equal(report.availableSymbols, 1);
    assert.deepEqual(report.failures, [{ symbol: 'SOFI', errors: ['options: no parseable contracts'] }]);
});

test('run summary distinguishes cached, partial, fresh and unpackaged results', () => {
    const manifest = { snapshotId: 'old', generatedAt: '2026-11-19T00:00:00Z', mode: 'cached-preview' };
    const report = { totalSymbols: 19, availableSymbols: 0, failures: [{ symbol: 'BILI', errors: ['HTTP 403; attempts=3, retries=2'] }] };
    const cached = formatRefreshSummary({ refreshOutcome: 'failure', packageOutcome: 'success', report, manifest });
    assert.equal(cached.cached, true);
    assert.match(cached.markdown, /沿用旧缓存/);
    assert.match(cached.markdown, /2026-11-19T00:00:00Z/);
    assert.match(cached.markdown, /0\/19/);
    assert.match(cached.markdown, /HTTP 403; attempts=3, retries=2/);
    assert.match(cached.markdown, /不代表网站部署成功/);
    for (const failures of [[], report.failures]) {
        const fresh = formatRefreshSummary({ refreshOutcome: 'success', packageOutcome: 'success',
            report: { ...report, failures }, manifest: { ...manifest, mode: 'published-default' } });
        assert.equal(fresh.cached, false);
        assert.match(fresh.markdown, /新快照已打包/);
        assert.equal(fresh.markdown.includes('部分股票'), failures.length > 0);
    }
    const missing = formatRefreshSummary({ refreshOutcome: 'failure', packageOutcome: 'failure', manifest });
    assert.equal(missing.cached, false);
    assert.match(missing.markdown, /未生成可部署/);
    assert.match(missing.markdown, /可能超时/);
    const escaped = formatRefreshSummary({ report: { ...report, failures: [{ symbol: '<script>', errors: ['x|y\n::error::bad'] }] } });
    assert.ok(!escaped.markdown.includes('<script>'));
    assert.ok(!escaped.markdown.includes('\n::error'));
    assert.match(escaped.markdown, /x&#124;y/);
});

test('summary command appends the cache warning and survives a missing diagnostic report', async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'options-summary-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    await fs.mkdir(path.join(root, 'dist/options/data'), { recursive: true });
    await fs.writeFile(path.join(root, 'dist/options/data/options-manifest.json'), JSON.stringify({
        mode: 'cached-preview', snapshotId: 'previous', generatedAt: '2026-11-19T00:00:00Z'
    }));
    const summaryPath = path.join(root, 'summary.md');
    await fs.writeFile(summaryPath, 'Existing summary\n');
    const { stderr } = await promisify(execFile)(process.execPath, [path.join(__dirname, 'summarize-options-refresh.js')], {
        cwd: root, env: { ...process.env, OPTIONS_REFRESH_REPORT: path.join(root, 'missing.json'),
            GITHUB_STEP_SUMMARY: summaryPath, OPTIONS_REFRESH_OUTCOME: 'failure', OPTIONS_PACKAGE_OUTCOME: 'success' }
    });
    const summary = await fs.readFile(summaryPath, 'utf8');
    assert.ok(summary.startsWith('Existing summary\n'));
    assert.match(summary, /沿用旧缓存/);
    assert.match(summary, /可能超时/);
    assert.match(stderr, /::warning title=期权数据未更新/);
});
