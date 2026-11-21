const fs = require('node:fs/promises');
const path = require('node:path');

function cell(value) {
    return String(value ?? 'unknown').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/\|/g, '&#124;').replace(/`/g, '&#96;').replace(/[\r\n\u0000-\u001f\u007f]/g, ' ');
}

function formatRefreshSummary({ refreshOutcome, packageOutcome, report, manifest }) {
    const packaged = packageOutcome === 'success' && manifest;
    const cached = packaged && manifest.mode === 'cached-preview';
    const lines = ['## 期权数据更新', ''];
    if (cached) lines.push('**沿用旧缓存：本次抓取失败，打包内容不是新行情。**');
    else if (packaged && refreshOutcome === 'success') {
        lines.push(report?.failures?.length ? '**新快照已打包，但部分股票数据获取失败。**' : '**新快照已打包。**');
    } else lines.push('**本次未生成可部署的发布包。** 数据抓取或打包未完成，请检查步骤日志。');
    lines.push('', '此处仅表示数据打包结果，不代表网站部署成功。');
    if (packaged) lines.push('', `- 快照：${cell(manifest.snapshotId)}`, `- 原始生成时间：${cell(manifest.generatedAt)}`);
    if (report) {
        lines.push('', `本次获得期权的股票：${report.availableSymbols}/${report.totalSymbols}。`);
        if (report.failures.length) {
            lines.push('', '| 股票 | 本次抓取错误 |', '| --- | --- |');
            for (const failure of report.failures) lines.push(`| ${cell(failure.symbol)} | ${cell(failure.errors.join('; '))} |`);
        }
    } else lines.push('', '未取得本次完整诊断报告，任务可能超时或提前退出；请查看抓取步骤日志。');
    return { markdown: lines.join('\n') + '\n', cached: !!cached };
}

async function readJson(file) {
    if (!file) return null;
    try { return JSON.parse(await fs.readFile(file, 'utf8')); }
    catch (error) {
        if (error.code !== 'ENOENT') console.warn('Unable to read refresh summary input: ' + path.basename(file));
        return null;
    }
}

async function summarizeRefresh(env = process.env) {
    const report = await readJson(env.OPTIONS_REFRESH_REPORT);
    const manifest = await readJson(path.resolve('dist/options/data/options-manifest.json'));
    const result = formatRefreshSummary({ refreshOutcome: env.OPTIONS_REFRESH_OUTCOME,
        packageOutcome: env.OPTIONS_PACKAGE_OUTCOME, report, manifest });
    if (env.GITHUB_STEP_SUMMARY) await fs.appendFile(env.GITHUB_STEP_SUMMARY, result.markdown);
    else console.log(result.markdown);
    if (result.cached) console.warn('::warning title=期权数据未更新::沿用旧缓存；网站部署成功也不表示本次获得了新行情。');
}

if (require.main === module) summarizeRefresh().catch(error => { console.error(error); process.exitCode = 1; });
module.exports = { formatRefreshSummary, summarizeRefresh };
