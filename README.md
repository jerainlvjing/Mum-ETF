# 国家队主力持仓 ETF 每日份额变化（Cloudflare 版）

功能与 Docker 版完全一致：每日记录 14 只宽基 ETF 的**场内份额**（上交所/深交所）和**流通市值**（东财，与东财客户端口径一致），用 ECharts 画最近 90 个交易日的份额变化曲线 + 右侧三列表格（份额/流通市值可排序、悬停高亮）。

架构：**Cloudflare Workers（后端+定时任务）+ D1（数据库）+ Workers Assets（前端静态页面）**，全免费额度即可运行。

## 项目结构

```
etf-shares-cf/
├── wrangler.toml       Worker 配置（D1 绑定 + 定时任务 + 静态资源）
├── schema.sql          D1 建表语句
├── package.json        依赖（xlsx，用于解析深交所 xlsx）
├── src/worker.js       后端：数据抓取 + API + 定时任务
└── static/index.html   前端页面
```

## 部署步骤（约 5 分钟）

### 1. 安装依赖 + 登录

```bash
cd etf-shares-cf
npm install          # 安装 xlsx 依赖
wrangler login       # 弹出浏览器登录 Cloudflare
```

### 2. 创建 D1 数据库

```bash
wrangler d1 create etf-shares
```

终端会输出一段 `database_id = "xxxx-xxxx-xxxx-xxxx"`，把它填进 `wrangler.toml` 的 `database_id` 字段。

### 3. 建表

```bash
wrangler d1 execute etf-shares --file=schema.sql --remote
```

### 4. 部署

```bash
wrangler deploy
```

部署成功后会输出访问地址，如 `https://etf-shares.你的账号.workers.dev`。

### 5. 首次回填历史数据

部署后数据库是空的，需要手动触发回填（**点两次**，每次回填 45 个交易日，两次共 90 天）：

- **方式一（网页）**：打开页面 → 点右上角「回填历史」按钮（前端会自动循环调用，直到补满 90 天）
- **方式二（命令行）**：
  ```bash
  curl -X POST "https://你的worker地址/api/backfill"
  curl -X POST "https://你的worker地址/api/backfill"
  ```

> 为什么分两次？Cloudflare Workers 免费版每个请求最多 50 个子请求（fetch），而上交所份额是逐日查询的（每天 1 次 fetch），所以单次回填上限设为 45 个交易日，90 天需要两次。

## 定时任务

已内置 Cron：**每个交易日（周一~周五）北京时间 23:30** 自动抓取当日份额+市值。无需额外配置。

## API

| 接口 | 方法 | 说明 |
|---|---|---|
| `/api/shares` | GET | 全部历史（按日期升序） |
| `/api/shares/latest` | GET | 最新一天快照 |
| `/api/collect` | POST | 手动抓取当日 |
| `/api/backfill` | POST | 回填一批历史（45 个交易日，可重复调用续接） |

## 配置

在 `wrangler.toml` 的 `[vars]` 里可改：

| 变量 | 默认 | 说明 |
|---|---|---|
| `ETF_CODES` | 14 只宽基 | 要记录的 ETF 代码，逗号分隔 |
| `BACKFILL_DAYS` | `90` | 回填目标天数 |

## 注意事项

1. **深交所数据用 xlsx 格式**，Worker 里用 SheetJS（`xlsx` 包）解析，已通过 `nodejs_compat` 兼容模式支持。
2. **免费版限制**：单请求 50 子请求、10ms CPU（I/O 等待不计入）。每天抓当天只需 4 次 fetch，远低于限制。
3. **回填耗时**：回填 45 天上交所是串行逐日查询，约需 30~50 秒，属正常。
4. **市值无历史**：东财只有当日流通市值，历史仅有份额，所以市值列历史日期显示 `--`，从部署日起每天累积。
5. 数据仅供行情参考，不构成投资建议。
