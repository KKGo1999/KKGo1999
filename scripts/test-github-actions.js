const test = require('node:test');
const assert = require('node:assert/strict');
const github = require('../options/githubActions.js');
const token = 'test-github-token-only';
const json = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), { status, headers });
const run = { id: 123, head_branch: 'main', path: '.github/workflows/static.yml', status: 'completed', conclusion: 'success' };
const manifest = { schemaVersion: '1.1.0', snapshotId: 'old', generatedAt: '2026-11-18T10:00:00Z',
    mode: 'published-default', symbols: [{ symbol: 'BILI', status: 'available', url: '/options/data/options/BILI.json', sourceTimestamp: '2026-11-18 09:00:00' }] };
const fresh = { ...manifest, snapshotId: 'new', generatedAt: '2026-11-18T11:00:00Z', deployment: { runId: '123' } };

test('dispatch is restricted to the fixed repository, workflow and main; token stays in GitHub headers', async () => {
    const calls = [];
    const client = github.createClient({ fetchImpl: async (url, options) => {
        calls.push({ url, options });
        assert.ok(url.startsWith('https://api.github.com/repos/KKGo1999/KKGo1999/actions/'));
        assert.equal(options.headers.Authorization, 'Bearer ' + token);
        assert.equal(options.credentials, 'omit');
        assert.equal(options.redirect, 'error');
        assert.equal(options.headers['X-GitHub-Api-Version'], '2026-03-10');
        assert.ok(!String(options.body).includes(token));
        return options.method === 'POST' ? json({ workflow_run_id: 123 }) : json({ workflow_runs: [] });
    } });
    assert.deepEqual(await client.start(token), { id: 123, reused: false });
    assert.equal(calls.length, 2);
    assert.equal(calls[1].url, 'https://api.github.com/repos/KKGo1999/KKGo1999/actions/workflows/static.yml/dispatches');
    assert.deepEqual(JSON.parse(calls[1].options.body), { ref: 'main' });
    assert.equal(github.runUrl('https://untrusted.invalid'), github.WORKFLOW_URL);
    await assert.rejects(client.start(''), /Token/);
});

test('an active push, schedule or manual run is reused without a POST', async () => {
    for (const status of ['queued', 'in_progress', 'waiting', 'pending', 'requested']) {
        const calls = [];
        const client = github.createClient({ fetchImpl: async (url, options) => {
            calls.push(options.method);
            return json({ workflow_runs: [{ ...run, status, conclusion: null }] });
        } });
        assert.deepEqual(await client.start(token), { id: 123, reused: true });
        assert.deepEqual(calls, ['GET']);
    }
});

test('auth, permissions, limits and invalid responses fail without leaking upstream text or retrying', async () => {
    for (const status of [401, 403, 404, 422, 429, 500]) {
        let calls = 0;
        const client = github.createClient({ fetchImpl: async () => { calls++; return json({ message: token }, status); } });
        await assert.rejects(client.start(token), error => !error.message.includes(token) && !error.dispatchUncertain);
        assert.equal(calls, 1);
    }
    const client = github.createClient({ fetchImpl: async () => json({ wrong: [] }) });
    await assert.rejects(client.start(token), /未触发/);
});

test('ambiguous dispatch outcomes never trigger a second POST', async () => {
    for (const outcome of ['network', 'empty', 'malformed', 'server']) {
        let posts = 0;
        const client = github.createClient({ fetchImpl: async (url, options) => {
            if (options.method === 'GET') return json({ workflow_runs: [] });
            posts++;
            if (outcome === 'network') throw new TypeError(token);
            if (outcome === 'empty') return new Response(null, { status: 204 });
            return json({ message: token }, outcome === 'server' ? 500 : 200);
        } });
        await assert.rejects(client.start(token), error => error.dispatchUncertain && !error.message.includes(token));
        assert.equal(posts, 1);
    }
});

test('watch reports queue, running and deployment phases, and validates the exact run', async () => {
    let readCount = 0;
    const phases = [];
    const client = github.createClient({ sleep: async () => {}, fetchImpl: async url => {
        if (url.includes('/jobs?')) return json({ jobs: [{ steps: readCount === 3 ? [{ name: 'Deploy to GitHub Pages', status: 'in_progress' }] : [] }] });
        const status = ['queued', 'in_progress', 'in_progress', 'completed'][readCount++];
        return json({ ...run, status });
    } });
    assert.equal((await client.watch(123, token, { onUpdate: phase => phases.push(phase) })).id, 123);
    assert.deepEqual(phases, ['排队或等待批准', '运行中', '部署中']);
    for (const changed of [{ id: 456 }, { head_branch: 'other' }, { path: '.github/workflows/other.yml' }]) {
        await assert.rejects(github.createClient({ fetchImpl: async () => json({ ...run, ...changed }) }).watch(123, token), /不匹配/);
    }
    for (const conclusion of ['failure', 'cancelled', 'timed_out', 'skipped']) {
        await assert.rejects(github.createClient({ fetchImpl: async () => json({ ...run, conclusion }) }).watch(123, token), /未确认更新/);
    }
});

test('local stopping aborts an outstanding GitHub fetch and never sends remote cancel', async () => {
    const controller = new AbortController();
    const started = Promise.withResolvers();
    let actualSignal;
    const client = github.createClient({ fetchImpl: (url, options) => {
        assert.equal(options.method, 'GET');
        actualSignal = options.signal;
        started.resolve();
        return new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(new DOMException('', 'AbortError'))));
    } });
    const pending = client.watch(123, token, { signal: controller.signal });
    await started.promise;
    controller.abort();
    await assert.rejects(pending, { name: 'AbortError' });
    assert.equal(actualSignal.aborted, true);
});

test('site verification distinguishes exact publication, fallback, partial data and unchanged quote times', () => {
    assert.equal(github.inspectSnapshot(manifest, fresh, 999).status, 'pending');
    assert.match(github.inspectSnapshot(manifest, fresh, 123).message, /时间未变化/);
    assert.equal(github.inspectSnapshot(manifest, { ...fresh, mode: 'cached-preview' }, 123).status, 'warning');
    assert.equal(github.inspectSnapshot(manifest, { ...manifest, deployment: { runId: '123' } }, 123).status, 'warning');
    assert.equal(github.inspectSnapshot(manifest, { ...fresh, failures: [{ symbol: 'BILI' }] }, 123).status, 'partial');
    assert.throws(() => github.inspectSnapshot(manifest, {}, 123));
});

test('publication polling waits for the matching deployment and never authenticates data reads', async () => {
    let clock = 0, reads = 0;
    const result = await github.verifyDeployment(manifest, 123, {
        now: () => clock, sleep: async () => { clock += 1; }, maxWaitMs: 3,
        read: async () => ++reads === 1 ? manifest : fresh
    });
    assert.equal(result.status, 'success');
    assert.equal(reads, 2);
    await github.readManifest({ fetchImpl: async (url, options) => {
        assert.match(url, /^data\/options-manifest\.json\?refresh=\d+$/);
        assert.equal(options.headers, undefined);
        assert.equal(options.cache, 'no-store');
        return json(fresh);
    } });
    clock = 0;
    await assert.rejects(github.verifyDeployment(manifest, 123, {
        now: () => clock, sleep: async () => { clock++; }, maxWaitMs: 2, read: async () => manifest
    }), /未将旧数据标记为更新成功/);
});

test('refreshed option chains must match the confirmed deployment snapshot', async () => {
    const APIService = require('../options/apiService.js');
    const api = new APIService();
    api.expectedOptionsSnapshotId = 'new';
    assert.equal(api.getOptionsDataUrl('BILI'), 'data/options/BILI.json?snapshot=new');
    const data = { schemaVersion: '1.1.0', symbol: 'BILI', options: [{}], snapshotId: 'old' };
    api.fetchJson = async () => data;
    await assert.rejects(api.getOptionsData('BILI'), /尚未与新快照同步/);
    data.snapshotId = 'new';
    assert.equal((await api.getOptionsData('BILI')).snapshotId, 'new');
});
