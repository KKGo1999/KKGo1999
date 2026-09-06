# 期权分析工具

一个功能强大的期权分析工具，使用HTML、JavaScript和CSS实现，可以分析期权价格、希腊字母指标以及复杂的期权组合策略。

## 功能特点

- **期权链分析**：查看不同到期日和执行价的期权价格、隐含波动率和希腊字母
- **复杂策略分析**：支持多种期权组合策略
  - 垂直价差 (牛市看涨价差、熊市看跌价差等)
  - 铁鹰策略 (Iron Condor)
  - 蝶式策略 (Butterfly Spread)
  - 跨式策略 (Straddle)
- **数据源支持**：
  - 腾讯财经免费公开行情接口（无需 API Key）
  - 部署时生成的 Cboe 延迟期权链静态缓存（无需 API Key）


## 设置指南

### Agent 数据入口

从项目根目录执行：

```sh
npm ci --ignore-scripts --no-audit --no-fund
node --test scripts/test-options-agent.js
node scripts/build-options-data.js
python3 -m http.server 8766 --bind 127.0.0.1
```

访问 http://127.0.0.1:8766/options/agent/ 可读取无需 JavaScript 的股票、默认候选和期权分页；主页面底部也提供入口。构建需要 Node.js 24+ 及腾讯、Cboe 的网络访问。

股票清单、默认参数和筛选评分共用 options/analysisCore.js。只需修改其中 WATCHLIST / SUPPORTED_SYMBOLS，再重新构建；页面概览、扫描和 Agent 目录会使用同一清单。

构建会生成 options/data/ 和 options/agent/ 下的 index.html、stocks/、fields.html、fields.txt，这些产物不提交 Git，GitHub Actions 测试通过后重新生成并随站点部署。个别股票失败会保留失败记录；全部期权获取失败则阻止本次发布。

主页面扫描后可“复制分析数据”或“下载 JSON”。导出保存扫描时的条件及结果，不包含 API Key、AI History；公开默认候选不会随着本机输入框的修改而变化。字段、公式、时间口径和分页规则见 [Agent 数据说明](https://www.kkgo1999.top/options/agent/fields.html)。

字段说明仅维护 [fields.md 源文件](agent/fields.md)，构建时通过 Marked 生成完整的静态 HTML，并原样复制为 text/plain 的 fields.txt。Agent 优先读取 fields.html，遇到读取工具格式兼容问题时改读 fields.txt，无需依赖 text/markdown 或执行 JavaScript。

### 1. 免费数据源

应用默认从腾讯财经免费公开接口抓取美股报价，并在 GitHub Pages 部署时从 Cboe 延迟行情生成期权链静态 JSON，不需要 Tradier 账户或 API Key。浏览器读取同源缓存文件，避免直接请求第三方期权接口时遇到 CORS 或代理连接失败。

> 注意：腾讯财经和 Cboe 延迟行情都不是本项目可控的官方 SLA 数据服务，接口可用性、延迟和字段完整度可能变化；如果用于真实交易，请自行核验行情来源。

### 2. 运行应用程序

本应用是纯前端项目，无需复杂的设置：

1. 确保所有文件都在同一个目录下
2. 在浏览器中直接打开`index.html`文件
3. 或者使用简单的HTTP服务器（如VS Code的Live Server扩展）来托管项目

## 使用说明

### 期权链分析

1. 在"期权链分析"选项卡中，选择一个股票符号（例如TSLA、NVDA等）
2. 选择期权到期日
3. 选择期权类型（看涨或看跌）
4. 期权链表格将显示不同执行价的期权详细信息
5. 点击任意期权行，在下方查看详细图表分析

### API密钥配置

无需配置 API 密钥。页面右上角会显示当前使用的免费数据源。

## 数据源说明

应用程序支持两种数据模式：

1. **腾讯财经免费公开行情接口**：
   - 获取股票最新报价和涨跌幅
   - 无需 API Key
   - 响应带浏览器可用的 CORS 头，适合纯前端直接请求

2. **Cboe 延迟期权链静态缓存**：
   - GitHub Actions 部署前从 Cboe delayed quotes JSON 生成同源缓存文件
   - 解析合约名、执行价、最新价、买卖价、成交量、未平仓量、隐含波动率和希腊字母
   - 定时工作流会在美股交易时段刷新并重新部署缓存

当前数据源状态会在期权链表格上方显示。

## 技术实现

- **前端框架**：HTML5, CSS3, JavaScript (ES6+)
- **UI组件**：Bootstrap 5
- **数学模型**：Black-Scholes期权定价模型
- **API集成**：腾讯财经行情接口 + Cboe 延迟期权链静态缓存

## 免责声明
