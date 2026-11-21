# 期权分析

纯静态网页：股票概览、卖方权利金矩阵、候选筛选、AI 分析和浏览器本地历史。无需后端，不提供交易下单。

## 本地运行

需要 Node.js 24+；行情构建需要访问腾讯财经和 Cboe。

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm test
npx playwright install chromium webkit
npm run test:browser
npm run build:data
npm run build
python3 -m http.server 8766 --bind 127.0.0.1 --directory dist
```

访问 http://127.0.0.1:8766/options/ 。不要通过 file:// 打开，页面需要同源 HTTP 数据。浏览器测试使用固定行情和模拟模型，不需要密钥、不产生 API 费用。它验证 Chromium 和 WebKit，不替代实体手机测试。

## 使用流程

- 选择股票自动显示矩阵；股票切换会取消旧请求，矩阵和扫描共用日期及收益公式。
- “扫描候选”不调用 AI。默认 Put、30–200 天、买价至少 $1、简单年化至少 20%、执行价相对差 -60% 至 -15%、每股最多 3 个候选。
- “AI分析 Top 10”发送本地评分靠前的候选，上限可设置。显示返回文字和推理内容；OpenAI 仅展示 API 提供的推理摘要，不是完整内部推理。
- AI 只能引用已发送候选；不足 10 个不会本地补齐。返回无效、被截断或请求失败时只显示明确标注的本地结果，不保存为成功推荐。
- 取消、切换服务商或模型会中止旧请求。中止前的 API 用量仍可能计费。

## AI 服务商与密钥

- 智谱：中国 Coding Plan，固定模型 glm-5.3，固定官方 Coding API 地址。
- OpenAI：Responses API，仅 GPT-6.2 Sol（默认）和 GPT-6.2 Astra；不提供 Terra / Luna。使用推理 medium、流式响应和结构化输出。模型权限取决于 API 项目和账户。
- 模型配置核对日期：2026-11-18。参见 [Sol](https://developers.openai.com/api/docs/models/gpt-6.2-sol) 和 [Astra](https://developers.openai.com/api/docs/models/gpt-6.2-astra)。

密钥只放在当前页面内存中；刷新清除，不写入 localStorage、sessionStorage、历史、导出或公共文件。两个服务商的临时密钥独立，点击“清除”会同时清除。旧版保存在浏览器的智谱密钥会迁移到本次页面内存，并删除旧持久副本。

浏览器直连并不能提供服务端级密钥隔离；浏览器扩展、同源恶意代码、共享设备仍有风险。页面只加载本站脚本，以 CSP 限制连接地址，不使用第三方 AI 代理。建议使用单独项目密钥、限制额度并及时轮换。网络/CORS、账号权限、地区限制、额度不足会明确报错；不自动重试收费请求。

## 手动更新期权

页面顶部的“更新期权数据”会调用 GitHub 官方 REST API，固定触发 KKGo1999/KKGo1999 的 static.yml、main 分支。现有“最新股票价格”的刷新仍只更新股价，不触发部署。操作需要确认，会更新所有访客使用的线上数据；不调用 AI、不提交交易。

1. 在 [GitHub 创建 fine-grained Token](https://github.com/settings/personal-access-tokens/new)，选择资源所有者 KKGo1999。
2. Repository access 仅选择 KKGo1999/KKGo1999；Repository permissions 中 Actions 设置 Read and write，并设置较短有效期。不需要 Contents 写权限。
3. 在页面的“GitHub 配置”填写 Token，再点击“更新期权数据”。具体权限要求见 [官方工作流触发接口](https://docs.github.com/en/rest/actions/workflows#create-a-workflow-dispatch-event)。

GitHub Token 与 AI Key 独立，只放在当前页面内存中；刷新、关闭页面或清除会移除，不写入浏览器持久存储、历史或导出。只通过 Authorization 请求头发送到 api.github.com，连接限制由 CSP 控制。浏览器扩展和同源代码仍有读取风险；Actions 写权限也不只限于这个按钮，请勿在不信任的页面配置。

已有运行中任务时直接跟踪，不重复触发；支持 Web Locks 的浏览器还阻止同源多标签页同时操作。此机制不是跨设备的全局锁；定时任务或别的设备仍可能创建新任务，现有 GitHub concurrency 策略可能取消旧任务。页面会显示相应状态。

页面每 15 秒检查一次运行状态，最长跟踪 30 分钟；部署后最多等待 3 分钟核对当前站点的发布编号和快照。新快照到达后刷新矩阵，并在已有扫描结果时重扫本地候选，不自动调用收费 AI。若行情时间没变化、部分股票失败或沿用旧缓存，会分别提示，工作流成功不等于行情已更新。

“停止跟踪”仅停止本页等待，不取消 GitHub 上的任务；可用“检查进度”继续。触发请求超时或响应无法确认时不自动重试，以免重复部署，请先检查 GitHub。页面刷新后跟踪状态会丢失，但再次操作前仍检查已有任务。

本地预览可以触发线上工作流，但线上部署不会修改本地文件；此时页面只确认线上部署完成，不宣称本地数据更新。读取本地新行情仍需运行 npm run build:data 和 npm run build。

## 数据与收益口径

股价来自腾讯财经；期权链来自部署时构建的 Cboe 延迟快照。两者时间可能不同，不是实时可成交报价。

- 日期按 America/New_York 的日历日计算，矩阵与扫描使用同一个 analysisCore.js。
- 采用标准 100 股/张、每张 $1 费用假设；非标准根代码和调整合约不进入分析。
- 年化仅是权利金简单年化，不包含股票损益、股息、交割等，不等于备兑 Call 总收益或盈利概率。
- 展示行情原始时间、抓取时间及快照生成时间；源站时区未确认，不擅自视作 UTC。
- 缓存/抓取时间超过 96 小时、缺少时间、异常未来时间、旧缓存模式、混合快照或部分股票失败时，AI 分析前须确认。96 小时只是保守提示阈值，不表示阈值内行情适合交易。

## 历史与备份

完整成功结果写入 IndexedDB：保留模型、提示词版本、输入快照、筛选条件、推荐和返回文字。没有自动删除第 50 条或截断 60,000 字的限制，但仍受浏览器容量约束。旧版 localStorage 历史成功迁移后才删除旧副本。

“历史记录”支持查看、删除、导出和导入；重复 ID 不覆盖。导入会校验数据并剔除密钥字段，单文件最多 50 MB。写入失败时保留当前结果并显示错误，可用“导出本次 AI 结果”备份。清理网站数据、无痕模式或更换浏览器可能丢失记录，请定期导出。历史按域名隔离，本地预览与线上网站不共享。

## Agent 与构建

入口为 /options/agent/，无需 JavaScript。JSON 清单、期权分页和字段说明见 [agent/fields.md](agent/fields.md)，构建生成同内容的 fields.html 和 fields.txt。公开数据不包含密钥或 AI 历史。

股票清单与计算规则维护在 analysisCore.js；页面、扫描与构建共用。aiProviders.js 负责模型协议，historyStore.js 负责存储，asyncControl.js 负责请求取消。旧 optionsCalculator.js / optionStrategies.js 不再被主页面加载。

GitHub Actions 在发布前运行逻辑测试；代码推送和手动发布还运行浏览器测试。只打包显式允许的文件到 dist/，不发布源脚本、依赖目录、测试或配置。行情构建失败时，从最近成功缓存重新生成页面并标记 mode=cached-preview，保留原行情和生成时间；无有效缓存则停止发布。

数据、生成的 Agent 页面、dist/ 和测试截图不提交。定时工作流仍可能因排队、网络或上游接口不可用而延迟，必须读取实际时间及错误信息。

## 风险提示

本项目是研究与筛选工具，不保证数据准确性、收益或流动性。真实交易前，应在券商独立核验合约、报价、交割物、费用与风险；AI 推荐不能替代判断。
