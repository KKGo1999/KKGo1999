const fs = require('node:fs/promises');
const path = require('node:path');

const ROOT_FILES = ['index.html', 'css', 'img', 'redirect', 'llms.txt'];
const OPTION_FILES = ['index.html', 'simple.html', 'styles.css', 'app.js', 'apiService.js', 'analysisCore.js',
    'asyncControl.js', 'aiProviders.js', 'historyStore.js', 'aiRecommendations.js', 'advancedAnalysisFix.js',
    'githubActions.js', 'dataRefresh.js',
    'vendor', 'icons', 'agent', 'data'];

async function packageSite(root = path.resolve(__dirname, '..'), destination = path.join(root, 'dist'), { cached = false, deployment = null } = {}) {
    if (path.resolve(root) === path.resolve(destination)) throw new Error('Output must not replace source');
    await fs.access(path.join(root, 'options/data/options-manifest.json'));
    await fs.rm(destination, { recursive: true, force: true });
    await fs.mkdir(path.join(destination, 'options'), { recursive: true });
    for (const item of ROOT_FILES) await fs.cp(path.join(root, item), path.join(destination, item), { recursive: true });
    for (const item of OPTION_FILES) await fs.cp(path.join(root, 'options', item), path.join(destination, 'options', item), { recursive: true });
    // Documentation is generated with current code even when data refresh is unavailable.
    const { renderAgentSite } = require('./render-agent-site.js');
    const core = require('../options/analysisCore.js');
    const stocksData = JSON.parse(await fs.readFile(path.join(root, 'options/data/stocks.json'), 'utf8'));
    if (cached) stocksData.mode = 'cached-preview';
    const snapshots = [];
    for (const stock of stocksData.stocks) {
        let optionsData = null;
        if (stock.optionsUrl) {
            optionsData = JSON.parse(await fs.readFile(path.join(root, 'options/data/options', stock.symbol + '.json'), 'utf8'));
            if (cached) optionsData.mode = 'cached-preview';
            await fs.writeFile(path.join(destination, 'options/data/options', stock.symbol + '.json'), JSON.stringify(optionsData));
        }
        snapshots.push({ symbol: stock.symbol, quote: stock.quote, optionsData, error: stock.errors.join('; ') });
    }
    const scan = core.scanSnapshots(snapshots.filter(item => core.WATCHLIST.includes(item.symbol)), core.DEFAULTS,
        { asOf: stocksData.generatedAt, snapshotId: stocksData.snapshotId, scope: 'published-default' });
    // Regenerate candidates and their HTML together when calculation code changes.
    await fs.writeFile(path.join(destination, 'options/data/candidates.json'), JSON.stringify(core.exportScan(scan), null, 2));
    await renderAgentSite(destination, stocksData, scan, snapshots);
    const manifestPath = path.join(destination, 'options/data/options-manifest.json');
    const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
    if (cached) manifest.mode = 'cached-preview';
    if (deployment) manifest.deployment = { runId: String(deployment.runId), commit: deployment.commit, publishedAt: deployment.publishedAt };
    manifest.fieldsUrl = '/options/agent/fields.html';
    manifest.fieldsTextUrl = '/options/agent/fields.txt';
    await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2));
    console.log('Static site packaged in ' + destination);
}

if (require.main === module) packageSite(undefined, undefined, {
    cached: process.argv.includes('--cached'),
    deployment: process.env.GITHUB_RUN_ID ? { runId: process.env.GITHUB_RUN_ID,
        commit: process.env.GITHUB_SHA, publishedAt: new Date().toISOString() } : null
})
    .catch(error => { console.error(error); process.exitCode = 1; });
module.exports = { packageSite, ROOT_FILES, OPTION_FILES };
