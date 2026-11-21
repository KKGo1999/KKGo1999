(function(root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    else root.OptionsGitHub = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function() {
    'use strict';
    const REPOSITORY = 'KKGo1999/KKGo1999';
    const API = 'https://api.github.com/repos/' + REPOSITORY + '/actions';
    const WORKFLOW = 'static.yml';
    const WORKFLOW_URL = 'https://github.com/' + REPOSITORY + '/actions/workflows/' + WORKFLOW;
    const LIVE_ORIGINS = ['https://www.kkgo1999.top', 'https://kkgo1999.top', 'https://kkgo1999.github.io'];
    const validRunId = id => Number.isSafeInteger(Number(id)) && Number(id) > 0 && /^\d+$/.test(String(id));
    function runUrl(id) { return validRunId(id) ? 'https://github.com/' + REPOSITORY + '/actions/runs/' + id : WORKFLOW_URL; }
    function abortError() { return new DOMException('Cancelled', 'AbortError'); }
    function delay(ms, signal) {
        return new Promise((resolve, reject) => {
            if (signal?.aborted) return reject(abortError());
            const done = () => { signal?.removeEventListener('abort', stop); resolve(); };
            const timer = setTimeout(done, ms);
            function stop() { clearTimeout(timer); signal.removeEventListener('abort', stop); reject(abortError()); }
            signal?.addEventListener('abort', stop, { once: true });
        });
    }
    function apiError(response) {
        const limited = response.status === 429 || response.headers.get('x-ratelimit-remaining') === '0' || response.headers.has('retry-after');
        const messages = {
            401: 'GitHub Token 无效或已过期。',
            403: 'GitHub 拒绝访问，请检查此仓库的 Actions 读写权限、账号授权或访问限制。',
            404: '无法访问目标仓库或工作流，请检查 Token 的仓库授权。',
            422: '工作流不接受此次触发，请确认 main 分支已启用 workflow_dispatch。'
        };
        return new Error(limited ? 'GitHub 请求受限，请稍后再检查进度；不会自动重试触发。' :
            messages[response.status] || 'GitHub 请求失败（HTTP ' + response.status + '）。');
    }

    function createClient({ fetchImpl = fetch, sleep = delay, now = Date.now,
        requestTimeoutMs = 20000, pollMs = 15000, maxWaitMs = 30 * 60 * 1000 } = {}) {
        async function request(path, token, signal, body) {
            if (signal?.aborted) throw abortError();
            const controller = new AbortController();
            const abort = () => controller.abort();
            signal?.addEventListener('abort', abort, { once: true });
            const timer = setTimeout(abort, requestTimeoutMs);
            let response;
            try {
                const headers = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2026-03-10' };
                if (token) headers.Authorization = 'Bearer ' + token;
                if (body) headers['Content-Type'] = 'application/json';
                response = await fetchImpl(API + path, { method: body ? 'POST' : 'GET', headers,
                    body: body ? JSON.stringify(body) : undefined, signal: controller.signal,
                    credentials: 'omit', redirect: 'error', cache: 'no-store', referrerPolicy: 'no-referrer' });
                if (!response.ok) throw apiError(response);
                if (response.status === 204) return null;
                return await response.json();
            } catch (error) {
                const uncertain = !!body && (!response || response.ok || response.status >= 500);
                const message = signal?.aborted ? '已停止本页等待，远端任务可能仍在运行。' :
                    controller.signal.aborted ? 'GitHub 请求超时。' :
                    error instanceof TypeError ? '无法连接 GitHub，请检查网络或浏览器限制。' :
                    response && !response.ok ? error.message : 'GitHub 返回内容无法确认。';
                const safeError = new Error(message + (uncertain ? '触发结果不确定，请先在 GitHub 确认，不要重复提交。' : ''));
                safeError.dispatchUncertain = uncertain;
                if (signal?.aborted) safeError.name = 'AbortError';
                throw safeError;
            } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
        }
        async function activeRun(token, signal) {
            const data = await request('/workflows/' + WORKFLOW + '/runs?branch=main&per_page=100', token, signal);
            if (!Array.isArray(data?.workflow_runs)) throw new Error('无法确认已有任务，未触发新的更新。');
            return data.workflow_runs.find(run => run.head_branch === 'main' && run.status !== 'completed' && validRunId(run.id)) || null;
        }
        async function start(token, signal, onDispatch = () => {}) {
            if (!String(token || '').trim()) throw new Error('请先配置 GitHub Token。');
            const existing = await activeRun(token, signal);
            if (existing) return { id: Number(existing.id), reused: true };
            onDispatch();
            const data = await request('/workflows/' + WORKFLOW + '/dispatches', token, signal, { ref: 'main' });
            if (!validRunId(data?.workflow_run_id)) {
                const error = new Error('GitHub 已接收触发，但未返回任务编号。请在 GitHub 查看，不要重复触发。');
                error.dispatchUncertain = true;
                throw error;
            }
            return { id: Number(data.workflow_run_id), reused: false };
        }
        async function watch(id, token, { signal, onUpdate = () => {} } = {}) {
            if (!validRunId(id)) throw new Error('任务编号无效。');
            const deadline = now() + maxWaitMs;
            while (now() < deadline) {
                const run = await request('/runs/' + id, token, signal);
                if (Number(run?.id) !== Number(id) || run.head_branch !== 'main' ||
                    run.path?.split('@')[0] !== '.github/workflows/' + WORKFLOW) throw new Error('任务信息不匹配，已停止跟踪。');
                if (run.status === 'completed') {
                    if (run.conclusion !== 'success') {
                        const reasons = { cancelled: '已取消，可能被后续部署替代', timed_out: '运行超时', failure: '运行失败' };
                        throw new Error('GitHub 任务' + (reasons[run.conclusion] || '未成功完成') + '，当前数据未确认更新。');
                    }
                    return run;
                }
                let phase = run.status === 'in_progress' ? '运行中' : '排队或等待批准';
                if (run.status === 'in_progress') {
                    const jobs = await request('/runs/' + id + '/jobs?per_page=100', token, signal);
                    if (jobs.jobs?.some(job => job.steps?.some(step => step.name === 'Deploy to GitHub Pages' && step.status === 'in_progress'))) phase = '部署中';
                }
                onUpdate(phase);
                await sleep(pollMs, signal);
            }
            throw new Error('等待超过 30 分钟，已停止本页轮询；远端任务可能仍在运行，可继续检查进度。');
        }
        return { start, activeRun, watch };
    }

    function validateManifest(value) {
        if (!value || !String(value.schemaVersion || '').startsWith('1.') ||
            typeof value.snapshotId !== 'string' || !value.snapshotId ||
            !Number.isFinite(Date.parse(value.generatedAt)) || !Array.isArray(value.symbols)) throw new Error('期权数据版本信息无效。');
        return value;
    }
    async function readManifest({ url = 'data/options-manifest.json', signal, fetchImpl = fetch } = {}) {
        const controller = new AbortController();
        const abort = () => controller.abort();
        if (signal?.aborted) throw abortError();
        signal?.addEventListener('abort', abort, { once: true });
        const timer = setTimeout(abort, 15000);
        try {
            const target = url + (url.includes('?') ? '&' : '?') + 'refresh=' + Date.now();
            const response = await fetchImpl(target, { signal: controller.signal, cache: 'no-store', credentials: 'omit', redirect: 'error' });
            if (!response.ok) throw new Error('尚未读取到站点期权快照。');
            return validateManifest(await response.json());
        } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
    }
    function inspectSnapshot(before, after, runId) {
        validateManifest(after);
        if (String(after.deployment?.runId) !== String(runId)) return { status: 'pending', message: '部署完成，等待站点同步该次发布。' };
        if (after.mode === 'cached-preview') return { status: 'warning', message: '期权抓取失败，本次部署仍使用旧缓存。' };
        if (after.snapshotId === before?.snapshotId || Date.parse(after.generatedAt) <= Date.parse(before?.generatedAt || 0)) {
            return { status: 'warning', message: '部署已完成，但期权快照未更新。' };
        }
        const missing = after.symbols.filter(item => !item.url || item.status !== 'available');
        if (after.failures?.length || missing.length) return { status: 'partial', message: '快照已更新，部分股票数据缺失，请复核。' };
        const oldTimes = new Map((before?.symbols || []).map(item => [item.symbol, item.sourceTimestamp]));
        const unchanged = before && after.symbols.every(item => item.sourceTimestamp === oldTimes.get(item.symbol));
        return { status: 'success', message: unchanged ? '已重新抓取；源站行情时间未变化，仍为延迟行情。' : '期权快照已更新，仍为延迟行情。' };
    }
    async function verifyDeployment(before, runId, { signal, read = readManifest, sleep = delay,
        now = Date.now, maxWaitMs = 180000, pollMs = 5000 } = {}) {
        const deadline = now() + maxWaitMs;
        while (now() < deadline) {
            if (signal?.aborted) throw abortError();
            let manifest;
            try { manifest = await read({ signal }); }
            catch (error) { if (signal?.aborted) throw error; }
            if (manifest) {
                const result = inspectSnapshot(before, manifest, runId);
                if (result.status !== 'pending') return { ...result, manifest };
            }
            await sleep(pollMs, signal);
        }
        throw new Error('部署已完成，但尚未读到该次站点发布，请稍后检查进度或打开 GitHub；未将旧数据标记为更新成功。');
    }
    return Object.freeze({ REPOSITORY, WORKFLOW_URL, LIVE_ORIGINS, runUrl, createClient, readManifest, inspectSnapshot, verifyDeployment });
});
