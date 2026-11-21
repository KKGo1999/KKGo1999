document.addEventListener('DOMContentLoaded', () => {
    const github = window.OptionsGitHub;
    const client = github.createClient();
    const $ = id => document.getElementById(id);
    const button = $('updateOptionsData');
    const tokenInput = $('githubToken');
    let manifest = null;
    let baseline = null;
    let runId = null;
    let controller = null;
    let dispatchUncertain = false;

    function status(message, kind = 'pending') {
        $('optionsUpdateStatus').textContent = message;
        $('optionsUpdateStatus').dataset.kind = kind;
    }
    function busy(value) {
        button.disabled = value || dispatchUncertain;
        $('checkOptionsUpdate').disabled = value;
        $('stopOptionsUpdate').hidden = !value;
        tokenInput.readOnly = value;
        $('optionsDataToolbar').setAttribute('aria-busy', String(value));
    }
    function showManifest(value) {
        manifest = value;
        const times = value.symbols.map(item => item.sourceTimestamp).filter(Boolean).sort();
        const date = new Date(value.generatedAt).toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC');
        $('optionsSnapshotTime').textContent = '快照生成：' + date + (value.mode === 'cached-preview' ? '（旧缓存）' : '');
        $('optionsSourceTime').textContent = times.length ? 'Cboe 行情：' + times[0] +
            (times[0] === times.at(-1) ? '' : ' 至 ' + times.at(-1)) + '（源站时区未确认）' : 'Cboe 行情时间未知';
    }
    function showRun(id) {
        $('optionsUpdateRun').href = github.runUrl(id);
        $('optionsUpdateRun').hidden = false;
        $('checkOptionsUpdate').hidden = false;
    }
    function stop(message) {
        controller?.abort();
        controller = null;
        if (dispatchUncertain) showRun(runId);
        busy(false);
        status(message, 'warning');
    }
    async function perform(resume, active) {
        const token = tokenInput.value.trim();
        const signal = active.signal;
        const current = () => controller === active && !signal.aborted;
        try {
            if (!resume) {
                runId = null;
                $('optionsUpdateRun').hidden = true;
                $('checkOptionsUpdate').hidden = true;
                status('读取当前快照…');
                try { baseline = await github.readManifest({ signal }); }
                catch (error) { if (signal.aborted) throw error; baseline = manifest; }
                if (!current()) return;
                if (baseline) showManifest(baseline);
                status('检查是否已有更新任务…');
                // A lost POST response must not be retried automatically.
                let task;
                try { task = await client.start(token, signal, () => { dispatchUncertain = true; }); }
                catch (error) { if (!error.dispatchUncertain) dispatchUncertain = false; throw error; }
                if (!current()) return;
                dispatchUncertain = false;
                runId = task.id;
                showRun(runId);
                status(task.reused ? '已有任务正在运行，直接跟踪，不重复触发。' : '已提交 GitHub 更新任务。');
            } else if (!runId) {
                const task = await client.activeRun(token, signal);
                if (!current()) return;
                if (!task) throw new Error('未找到运行中任务。请打开 GitHub 确认之前的触发结果。');
                runId = Number(task.id);
                dispatchUncertain = false;
                showRun(runId);
                baseline = manifest;
            }
            await client.watch(runId, token, { signal, onUpdate: phase => { if (current()) status(phase + '，任务 #' + runId); } });
            if (!current()) return;
            if (!github.LIVE_ORIGINS.includes(location.origin)) {
                status('线上部署已完成。本地预览数据不会自动同步，请打开线上页面查看。', 'warning');
                return;
            }
            status('部署完成，核对新快照…');
            const result = await github.verifyDeployment(baseline, runId, { signal });
            if (!current()) return;
            showManifest(result.manifest);
            dispatchUncertain = false;
            status(result.message, result.status);
            if (['success', 'partial'].includes(result.status)) {
                document.dispatchEvent(new CustomEvent('optionsDataUpdated', { detail: { snapshotId: result.manifest.snapshotId } }));
            }
        } catch (error) {
            if (!current()) return;
            if (error.dispatchUncertain) { dispatchUncertain = true; showRun(runId); }
            status(error.message, 'error');
        } finally { if (current()) { controller = null; busy(false); } }
    }
    async function begin(resume = false) {
        if (controller) return;
        if (!tokenInput.value.trim()) {
            $('githubSettings').open = true;
            tokenInput.focus();
            status('请先填写仅授权此仓库 Actions 读写权限的 GitHub Token。', 'warning');
            return;
        }
        if (!resume && !window.confirm('将触发 KKGo1999/KKGo1999 的行情抓取和网站部署，所有访客会使用更新后的数据。是否继续？')) return;
        const active = new AbortController();
        controller = active;
        busy(true);
        const execute = async lock => {
            if (!lock) {
                if (controller === active) { controller = null; busy(false); status('另一标签页正在更新，请在该标签页查看进度。', 'warning'); }
                return;
            }
            if (!active.signal.aborted) await perform(resume, active);
        };
        try {
            if (navigator.locks) await navigator.locks.request('kkgo-options-update', { ifAvailable: true }, execute);
            else await execute(true);
        } catch {
            if (controller === active) stop('无法启动更新检查，请重试。');
        }
    }
    button.addEventListener('click', () => begin());
    $('checkOptionsUpdate').addEventListener('click', () => begin(true));
    $('stopOptionsUpdate').addEventListener('click', () => stop('已停止本页跟踪，不会取消 GitHub 任务。可继续检查进度。'));
    $('clearGithubToken').addEventListener('click', () => {
        stop('GitHub Token 已清除；已提交的远端任务不会取消。');
        tokenInput.value = '';
    });
    window.addEventListener('pagehide', () => { stop('已停止本页跟踪。'); tokenInput.value = ''; });
    const initialRead = new AbortController();
    github.readManifest({ signal: initialRead.signal }).then(value => {
        if (!controller && !runId) showManifest(value);
    }).catch(() => { $('optionsSnapshotTime').textContent = '暂时无法读取期权快照时间'; });
});
