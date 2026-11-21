# 期权分析数据说明

推荐读取 [HTML 版本](fields.html)。读取工具不支持 Markdown 或 HTML 时，可使用 [纯文本版本](fields.txt)。三个版本的字段说明来自同一份源文件，无需执行 JavaScript。

## 入口与范围

- [股票和期权目录](./)：不执行 JavaScript 即可读取，股票详情列出所有到期日及分页链接。
- [stocks.json](../data/stocks.json)：全部支持查询的股票；watchlist 和每条记录的 inWatchlist 明确当前概览及默认扫描范围。
- [candidates.json](../data/candidates.json)：默认条件下的本地扫描结果，没有调用智谱或其他模型。
- [options-manifest.json](../data/options-manifest.json)：所有支持股票的可用状态，包括失败股票。
- 每股完整期权链：/options/data/options/{SYMBOL}.json，保留源站返回的全部合约，包括已到期和非标准合约。
- 每股/每到期日分页：以 stocks.json 的 expirations[].pages[] 为准，每页最多 200 条；JSON 的 nextPage 指向下一页，最后一页为 null。

所有路径是静态文件。给 URL 添加 ?minDays=30 不会在服务端执行筛选。程序可下载完整链自行计算；浏览器用户可在主页面扫描后复制或下载本次结果。

## 快照和时间

schemaVersion=1.1.0 是数据格式版本（兼容 1.x，新增 dataQuality）；snapshotId 标识一次构建，股票、完整链、分页、默认候选、HTML 使用相同 ID。读取过程中若 ID 不一致，应重新读取目录，避免混用部署版本。

generatedAt 是生成/分析时刻，采用带 Z 的 UTC ISO 8601 格式。retrievedAt 是实际抓取时刻；浏览器缓存命中时保留最初抓取时间。二者均不是交易所行情时刻。

sourceTimestamp、lastTradeDate 保留上游原文。上游没有明确时区，因此 sourceTimeZone=null，不能擅自加 Z 或将其作为 UTC。即使网页刚刷新，报价也可能来自上个交易日。isDelayed=true 表示 Cboe 延迟行情，不承诺固定延迟分钟数。

默认工作流在工作日 UTC 13:20 至 22:50 的每小时第 20、50 分钟计划更新，也可在代码推送或手动运行时更新。实际时间受排队、源站、市场休市影响；请读取文件时间，不要推断一定每半小时更新成功。

analysisDate 按 America/New_York 的日历日期确定。到期天数等于到期日期与该日期的日历日差，避免用户所在时区或夏令时改变排序；不表示距离最后可交易时刻的精确小时数。

mode=cached-preview 标识刷新失败后使用的旧快照，或明确标识的旧缓存预览，不是新行情；保留原 generatedAt 和源站时间。正常构建为 published-default。

options-manifest.json 的可选 deployment 字段包含 GitHub 任务编号 runId、代码提交 commit 和打包时间 publishedAt，用于网页核对指定任务是否已发布；本地构建可以没有此字段。publishedAt 不替代 generatedAt 或行情时间；即使部署编号改变，也可能仍是 cached-preview 旧缓存。公开清单不包含 GitHub Token。

dataQuality 包含 status、requiresConfirmation、maxAgeHours、sourceTimeZone 和 issues。当前阈值为 96 小时；缓存生成/股价抓取时间缺失、过旧或异常未来、源站原始日期超过 4 天、混合快照或 cached-preview 都会告警。源站时间只检查日期，不推测时区。该规则是提示，不保证阈值内数据可交易；浏览器在付费 AI 请求前要求确认告警或部分失败，Agent 也应明确披露这些限制。

## 股票字段

| 字段 | 含义 |
|---|---|
| symbol / inWatchlist | 股票代码 / 是否在概览和默认扫描列表 |
| quote.price | 股价，USD/股 |
| quote.change / quote.changePct | 日价格变化 / 日涨跌百分数 |
| quote.source / sourceUrl | 行情来源及原始地址 |
| quote.sourceTimestamp / retrievedAt | 源站行情时间原文 / 抓取时间 |
| ytdChangePct | 相对本年度第一条可用日 K 线收盘价的变化，沿用主页面口径 |
| ytdBasePrice / ytdBaseDate | 该比较基准的收盘价与日期；不是保证使用上年最后交易日 |
| optionCount / expirations | 期权总数 / 到期日及完整分页目录 |
| status / errors | 股票、期权和年初基准的可用性及失败原因 |

百分数字段均使用百分数值：20 表示 20%，-15 表示 -15%。缺失值为 null，不是 0；失败股票不会从目录中消失。

## 期权字段

| 字段 | 含义 |
|---|---|
| contractSymbol | 源站合约代码，用于精确定位合约 |
| optionType / expiryDate / strike | put 或 call / YYYY-MM-DD 到期日 / 执行价 USD/股 |
| bid / ask / lastPrice | 买方出价 / 卖方要价 / 最近成交价，均为 USD/股 |
| volume / openInterest | 源站成交量 / 持仓量，单位张 |
| impliedVolatility | 源站隐含波动率，小数值；0.5 表示 50% |
| delta / gamma / theta / vega | 源站原始 Greeks，不重新缩放，不用于本地评分；源站未附明细单位 |
| lastTradeDate | 最近成交时间原文，不等于当前买卖报价时间 |
| contractMultiplier / multiplierStatus | 标准根代码暂按 100 股/张假设；调整根代码为 null，且不进入候选 |
| underlyingQuote | 本次构建使用的股价及其来源时间，供复核筛选计算 |

100 股/张是标准合约假设，不是对每份合约交割物的独立确认。非标准或调整合约仍保留在原始链中，默认候选排除它们。

## 筛选及数量

filters 保存实际使用的参数，默认：现金担保卖 Put，平衡偏好，30–200 天，买价至少 $1，年化至少 20%，相对差 -60% 至 -15%，持仓至少 1，最大价差 45%，每股最多 3 条，AI 发送上限 40 条。上下限包含边界。

买价、卖价、执行价、股价或持仓缺失时不生成候选；卖价小于买价、净权利金不为正、已到期、非标准根代码也不生成候选。成交量缺失时保留 null，仅评分的成交量贡献按 0 处理。

candidates 是全部通过筛选后，再按每股上限截取的列表；shortlistIds 是该列表前 candidateLimit 条的候选 ID，按顺序引用 candidates，不重复完整记录。两者均不等于完整期权链，也不是 AI 返回的 Top 10。

counts.optionsRead 是已读取合约数；matchedBeforeSymbolLimit 是单股截取前匹配数；retained 是截取后数；excludedBySymbolLimit 是单股截取剔除数；aiShortlist 是拟发给模型的数量。perSymbol 提供各股票相同统计；sources 保留每股来源及计算价格。

候选按 localScore 降序，同分按 contractSymbol 字符序升序。表格交互排序只改变展示，导出仍保持该可复现顺序。

## 收益公式

矩阵、候选扫描和 Agent 构建共用 analysisCore.js 的权利金收益口径。记股价 S、执行价 K、买方出价 B、卖方要价 A、到期天数 D、合约乘数 M=100：

- 净权利金/股 N = B - 0.01。费用假设为 $0.01/股，即标准合约 $1/张，不是实际券商费率。
- 价差 spreadPct = (A - B) / ((A + B) / 2) × 100。
- 相对差 strikePct = (K / S - 1) × 100。
- 净权利金/张 premiumDollars = N × M。
- 资金占用 collateral：现金担保卖 Put 为 K × M；备兑卖 Call 为 S × M，假设按该股价持有股票。
- 简单年化 annualReturn = premiumDollars / collateral × 365 / D × 100。
- 盈亏平衡 breakEven：Put 为 K - N；备兑 Call 为 S - N。
- 缓冲 downsideProtectionPct：Put 为 (S - breakEven) / S × 100；备兑 Call 为 N / S × 100。

年化仅把净权利金按时间折算，不含股价变化、被指派交割、股息或其他损益，尤其不等于备兑 Call 的总收益，也不是收益保证。

## 本地评分

assumptions.scoreVersion=2.0.0。权重沿用原有模型，版本变化标记统一日期、缺失值、非标准合约和同分排序规则。评分不是概率。

设 Y=年化、P=缓冲、L=log10(持仓+1)×1.8+log10((成交量或0)+1)×0.9、W=价差×0.08；
T=到期天数小于21时1.8，否则0；U=到期天数大于75时0.8，否则0；
V=Put时max(0,相对差)×1.7，Call时max(0,-相对差)×1.7。

- 平衡：Y×0.92 + P×0.7 + L - W - V×1.25 - T×0.6 - U。
- 保守：Y×0.72 + P×1.15 + L - W×1.35 - V×1.8 - T - U。
- 激进：Y×1.12 + P×0.35 + L×0.7 - W×0.65 - V - U。

复核时使用同一快照、generatedAt 和 filters 调用公开的 [analysisCore.js](../analysisCore.js) 中 scanSnapshots；浏览器与构建脚本使用同一实现。

## 公开数据与个人导出

公开候选的 scope=published-default。本机扫描的 scope=browser-scan；它保存扫描开始时间、扫描时的筛选条件及实际读取的数据来源。随后修改输入框不会改变已完成扫描的导出内容。

只有完整读取且具备股价的股票参与计算。扫描 status=partial 表示部分股票无法计算，unavailable 表示全部不可计算；0 个候选本身不是抓取失败。YTD 缺失会影响股票目录状态，但不影响无需 YTD 的候选计算。

每次构建先完整生成暂存输出再发布。个别股票失败会发布明确缺失信息；全部期权失败则构建失败，保留之前的数据，因此要始终核对时间。

导出包含行情、候选和筛选条件；不包含 API Key、浏览器存储或 AI History。数据入口提供只读查询，不调用模型、不执行交易。
