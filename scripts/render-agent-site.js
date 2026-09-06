const fs = require('node:fs/promises');
const path = require('node:path');
const core = require('../options/analysisCore.js');

const PAGE_SIZE = 200;
const escape = value => String(value ?? '').replace(/[&<>"']/g, char =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const number = value => Number.isFinite(value) ? value.toFixed(2) : '未提供';
const money = value => Number.isFinite(value) ? '$' + value.toFixed(2) : '未提供';
const percent = value => Number.isFinite(value) ? value.toFixed(2) + '%' : '未提供';
const link = (url, label) => '<a href="' + escape(url) + '">' + escape(label) + '</a>';
const json = value => JSON.stringify(value, null, 2) + '\n';

async function write(root, relativePath, content) {
    const target = path.join(root, relativePath);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content);
}

function document(title, body, metadata, depth = '') {
    return '<!doctype html>\n<html lang="zh-CN"><head><meta charset="utf-8">' +
        '<meta name="viewport" content="width=device-width,initial-scale=1">' +
        '<meta name="description" content="期权分析公开数据：股票、期权链、默认筛选候选与计算口径。">' +
        '<title>' + escape(title) + ' | 期权分析</title>' +
        '<link rel="stylesheet" href="' + depth + 'agent.css?v=20260906-2">' +
        '<link rel="describedby" href="' + depth + 'llms.txt" type="text/plain">' +
        '</head><body><header><a href="' + depth + '../">期权分析</a><nav>' +
        link(depth + 'index.html', 'Agent 数据') + link(depth + 'fields.html', '字段与计算口径') +
        '</nav></header><main><h1>' + escape(title) + '</h1>' +
        '<p class="metadata">快照 ' + escape(metadata.snapshotId) + '<br>生成时间（UTC） ' +
        escape(metadata.generatedAt) + '</p>' +
        '<p class="notice">Cboe 延迟期权行情。生成时间不等于行情时间；原始行情时间未标时区，请勿视为实时成交报价。' +
        (metadata.mode === 'cached-preview' ? ' 当前为旧缓存预览。' : '') + '</p>' +
        body + '</main><footer>USD · 百分比 20 表示 20% · 公开默认数据与本机扫描结果分别生成。</footer></body></html>\n';
}

function table(caption, headings, rows) {
    return '<div class="table-scroll" tabindex="0" role="region" aria-label="' + escape(caption) + '">' +
        '<table><caption>' + escape(caption) + '</caption><thead><tr>' +
        headings.map(item => '<th scope="col">' + escape(item) + '</th>').join('') +
        '</tr></thead><tbody>' + (rows.length ? rows.map(row =>
            '<tr>' + row.map(cell => '<td>' + cell + '</td>').join('') + '</tr>').join('') :
            '<tr><td colspan="' + headings.length + '">无数据</td></tr>') + '</tbody></table></div>';
}

function quoteSummary(stock) {
    return '<p>股价 ' + money(stock.quote?.price) + ' · 日涨跌 ' + percent(stock.quote?.changePct) +
        ' · 年初至今 ' + percent(stock.ytdChangePct) + '</p><p class="metadata">股票行情时间（源站原文） ' +
        escape(stock.quote?.sourceTimestamp || '未提供') + '；期权行情时间（源站原文） ' +
        escape(stock.optionsSourceTimestamp || '未提供') + '</p>';
}

async function renderFieldsDocumentation(root, metadata) {
    const { Marked, Renderer } = await import('marked');
    const source = await fs.readFile(path.join(__dirname, '../options/agent/fields.md'), 'utf8');
    const renderer = new Renderer();
    const renderTable = renderer.table;
    renderer.table = function (token) {
        return '<div class="table-scroll" tabindex="0" role="region" aria-label="字段说明">' +
            renderTable.call(this, token) + '</div>';
    };
    const markdown = new Marked({ renderer });
    const tokens = markdown.lexer(source);
    const title = tokens[0]?.type === 'heading' && tokens[0].depth === 1
        ? tokens.shift().text : '字段与计算口径';
    const body = '<p class="links">' + link('fields.txt', '纯文本版本') +
        link('fields.md', 'Markdown 源文件') + '</p><article class="guide-content">' +
        markdown.parser(tokens) + '</article>';
    await write(root, 'options/agent/fields.html', document(title, body, metadata));
    await write(root, 'options/agent/fields.txt', source);
}

async function renderAgentSite(root, stocksData, scan, snapshots) {
    await renderFieldsDocumentation(root, stocksData);
    const meta = stocksData;
    const stockRows = [];
    for (const stock of stocksData.stocks) {
        const snapshot = snapshots.find(item => item.symbol === stock.symbol);
        const options = snapshot?.optionsData?.options || [];
        const groups = new Map();
        for (const option of options) {
            if (!groups.has(option.expiryDate)) groups.set(option.expiryDate, []);
            groups.get(option.expiryDate).push(option);
        }
        const expirations = [];
        for (const [expiryDate, contracts] of [...groups].sort(([a], [b]) => a.localeCompare(b))) {
            const pages = [];
            for (let offset = 0; offset < contracts.length; offset += PAGE_SIZE) {
                const part = contracts.slice(offset, offset + PAGE_SIZE);
                const pageNumber = Math.floor(offset / PAGE_SIZE) + 1;
                const pageCount = Math.ceil(contracts.length / PAGE_SIZE);
                const name = expiryDate + (pageNumber === 1 ? '' : '-' + pageNumber);
                const jsonUrl = '/options/data/options/' + stock.symbol + '/' + name + '.json';
                const htmlUrl = '/options/agent/stocks/' + stock.symbol + '/' + name + '.html';
                pages.push({ pageNumber, optionCount: part.length, jsonUrl, htmlUrl });
                await write(root, 'options/data/options/' + stock.symbol + '/' + name + '.json', json({
                    ...snapshot.optionsData, options: part, expiryDate, pageNumber, pageCount,
                    totalOptionsForExpiry: contracts.length,
                    nextPage: pageNumber < pageCount ? '/options/data/options/' + stock.symbol + '/' + expiryDate + '-' + (pageNumber + 1) + '.json' : null
                }));
                const pageLinks = Array.from({ length: pageCount }, (_, index) =>
                    link(expiryDate + (index ? '-' + (index + 1) : '') + '.html', '第 ' + (index + 1) + ' 页')).join(' ');
                const rows = part.map(option => [
                    escape(option.contractSymbol), option.optionType === 'put' ? '看跌 Put' : '看涨 Call',
                    number(option.strike), money(option.bid), money(option.ask), money(option.lastPrice),
                    escape(option.volume ?? '未提供'), escape(option.openInterest ?? '未提供'),
                    percent(option.impliedVolatility === null ? null : option.impliedVolatility * 100),
                    number(option.delta), number(option.gamma), number(option.theta), number(option.vega),
                    escape(option.contractMultiplier ?? '未确认'), escape(option.multiplierStatus),
                    escape(option.lastTradeDate || '未提供')
                ]);
                const body = '<p>' + link('../' + stock.symbol + '.html', stock.symbol + ' 全部到期日') +
                    ' · ' + link('../../../data/options/' + stock.symbol + '/' + name + '.json', '本页 JSON') + '</p>' +
                    quoteSummary(stock) + '<p>到期日 ' + expiryDate + '；共 ' + contracts.length + ' 条合约；第 ' +
                    pageNumber + '/' + pageCount + ' 页。</p><nav>' + pageLinks + '</nav>' +
                    table('期权报价，价格单位 USD/股', ['合约代码', '类型', '执行价', '买价', '卖价', '最近成交价',
                        '成交量', '持仓', '隐含波动率', 'Delta', 'Gamma', 'Theta', 'Vega', '合约乘数', '乘数依据', '最近成交时间'], rows);
                await write(root, 'options/agent/stocks/' + stock.symbol + '/' + name + '.html',
                    document(stock.symbol + ' · ' + expiryDate, body, meta, '../../'));
            }
            expirations.push({ expiryDate, optionCount: contracts.length, pages });
        }
        stock.expirations = expirations;
        const expiryRows = expirations.map(item => [
            escape(item.expiryDate), String(item.optionCount),
            item.pages.map(page => link(stock.symbol + '/' + path.basename(page.htmlUrl), '第 ' + page.pageNumber + ' 页')).join(' '),
            item.pages.map(page => link('../../data/options/' + stock.symbol + '/' + path.basename(page.jsonUrl), 'JSON ' + page.pageNumber)).join(' ')
        ]);
        const stockBody = '<p>' + (stock.inWatchlist ? '在当前概览及默认扫描列表中。' : '支持查询，未加入概览及默认扫描。') +
            '</p>' + quoteSummary(stock) +
            (stock.errors.length ? '<p class="error">' + escape(stock.errors.join('; ')) + '</p>' : '') +
            (stock.optionCount ? '<p>' + link('../../data/options/' + stock.symbol + '.json', '完整期权链 JSON') + '</p>' : '') +
            table('全部到期日（含已到期合约，按源站返回）', ['到期日', '合约数', '阅读', '结构化数据'], expiryRows);
        await write(root, 'options/agent/stocks/' + stock.symbol + '.html', document(stock.symbol, stockBody, meta, '../'));
        stockRows.push([
            link('stocks/' + stock.symbol + '.html', stock.symbol),
            stock.inWatchlist ? '概览 / 默认扫描' : '仅查询',
            money(stock.quote?.price), percent(stock.quote?.changePct), percent(stock.ytdChangePct),
            escape(stock.quote?.sourceTimestamp || '未提供'),
            escape(stock.optionsSourceTimestamp || '未提供'),
            String(stock.optionCount), escape(stock.status),
            stock.optionCount ? link('../data/options/' + stock.symbol + '.json', 'JSON') : '不可用'
        ]);
    }
    const candidateRows = scan.candidates.map((candidate, index) => [
        String(index + 1), link('stocks/' + candidate.symbol + '.html', candidate.symbol),
        escape(candidate.contractSymbol), escape(candidate.expiryDate), String(candidate.daysToExpiry),
        number(candidate.strike), percent(candidate.strikePct), money(candidate.bid), money(candidate.ask),
        percent(candidate.annualReturn), number(candidate.localScore), money(candidate.collateral),
        money(candidate.breakEven), escape(candidate.openInterest), escape(candidate.volume ?? '未提供')
    ]);
    const defaults = core.DEFAULTS;
    const body = '<p class="links">' + link('../data/stocks.json', '股票列表 JSON') +
        link('../data/candidates.json', '默认候选 JSON') + link('../data/options-manifest.json', '期权目录 JSON') + '</p>' +
        '<p>默认扫描 ' + scan.symbols.length + ' 只股票；数据状态 ' + escape(scan.status) + '。</p>' +
        (scan.errors.length ? '<p class="error">' + escape(scan.errors.join('; ')) + '</p>' : '') +
        '<section><h2>股票列表与期权入口</h2>' +
        table('支持股票及行情时间', ['股票', '范围', '价格', '日涨跌', '年初至今', '股票行情时间', '期权行情时间', '合约数', '状态', '完整链'], stockRows) +
        '</section><section><h2>默认候选</h2><p>现金担保卖 Put；' + defaults.minDays + '–' + defaults.maxDays +
        ' 天；买价至少 $' + defaults.minBid + '；年化至少 ' + defaults.minAnnualReturn + '%；相对差 ' +
        defaults.minStrikePct + '% 至 ' + defaults.maxStrikePct + '%；持仓至少 ' + defaults.minOpenInterest +
        '；最大价差 ' + defaults.maxSpreadPct + '%；平衡评分，每股最多 ' + defaults.perSymbolLimit + ' 条。</p>' +
        '<p>读取 ' + scan.counts.optionsRead + ' 条合约，符合条件 ' + scan.counts.matchedBeforeSymbolLimit +
        ' 条，单股限制后保留 ' + scan.counts.retained + ' 条；AI 发送上限 ' + defaults.candidateLimit +
        '。这是本地评分结果，未调用 AI。</p>' +
        table('按本地评分降序，年化为权利金简单年化', ['#', '股票', '合约代码', '到期日', '天数', '执行价',
            '相对差', '买价', '卖价', '年化', '本地评分', '资金占用', '盈亏平衡', '持仓', '成交量'], candidateRows) +
        '</section>';
    await write(root, 'options/agent/index.html', document('Agent 数据', body, meta));
    await write(root, 'options/data/stocks.json', json(stocksData));
}

module.exports = { renderAgentSite, renderFieldsDocumentation, PAGE_SIZE };
