# dsh-ssq

双色球开奖数据插件（DeepSeek Harness / dsh bundle）：**查往期开奖**、**全量落盘**，并在**开奖夜（周二/周四/周日）自动抓取**，当时没开奖就按阶梯补抓。附带一个零依赖 CLI。

数据源：中国福利彩票官网 `findDrawNotice` 接口，2013-01-01 至今（约 2091 期），每期含 6 红 1 蓝、销售额、奖池，以及**一～六等奖各自的 中奖注数 / 单注奖金**。

```text
dsh-ssq/
├─ index.js            插件入口（工具 + 斜杠命令）
├─ lib/                config · tools · watch-ops · automation · archive · source · runtime · command · client(浏览器半侧)
├─ src/                数据层（官网客户端 / 规范化 / CSV·JSONL / 汇总），插件与 CLI 共用
├─ bin/ssq.mjs         CLI
├─ cordis.patch.yml    bundle 行（dsh 安装插件时读它）
├─ docs/               插件详情页（DETAIL*.md + preview.svg）
└─ .github/workflows/  ci（语法+产物） · release（YY.MM.NN 版本 → 打包 → Release）
```

## 安装

在 dsh 里作为 bundle 安装（插件页安装 `dsh-ssq`，或用 `plugin_manager` 指定本包目录 / 包名），然后在设置里配置。

要求：Node ≥ 18.17；**dsh ≥ 0.2.2-rc.5**（`engines.dsh` 声明）；dsh 需要 `tools`（数据工具）、`schedule`（自动任务）、`commands`（`/ssq-watch`）三个服务 —— 缺哪个就只跳过对应的入口。

### 兼容性

| dsh 版本 | 状态 |
| --- | --- |
| ≥ 0.2.2-rc.5 | ✅ 支持（当前） |
| ≤ 0.2.1-rc.3 | ❌ 不支持：Schedule 的宿主管理 API 已重做（`create(timing + target)`、`edit({ id, action })`、`catalog` 条目带 `target`/`status`），旧版签名会被新版服务拒绝 |

0.2.2 迁移时本插件改了三处：`create` 改为 `{ title, prompt, timing, target }` + `(request, actorSessionId, signal)`；删除任务改用 `edit({ id, action: 'delete' }, actorSessionId)`；任务归属从 `entry.sessionId` 改为 `entry.target.sessionId`（`status` 取值变为 `active|paused|ended`）。

## 配置（设置 → 双色球）

插件带浏览器半侧，设置面板里有独立分区，「插件」页的本插件行也有「配置」入口。保存写进 profile 的用户 patch，**下一次检查立即生效**，不用重启。

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| 首次检查时间 | `21:35` | 开奖日（周二/四/日）先跑这一次 |
| 开奖日 | `2,4,7` | ISO 星期，周一 1 … 周日 7 |
| 时区 | `Asia/Shanghai` | 所有墙钟按它换算成 UTC |
| 补抓间隔（分钟） | `5,15,45` | 相对当次检查 → 21:40 / 21:50 / 22:20 |
| 次日兜底时间 | `06:00` | 阶梯用尽后再查一次 |

**没有目录类配置**：数据层就在包内 `src/`；存档目录按下面的顺序自动决定：

1. 环境变量 `SSQ_DATA_DIR`（测试 / 高级用法）；
2. 包目录可写时：`<包目录>/data` —— 与 CLI 共用同一份；
3. 包目录不可写（只读挂载等）：`$DSH_HOME/ssq`（默认 `~/.dsh/ssq`）。

## 工具

| 工具 | 作用 | 依赖 |
| --- | --- | --- |
| `ssq_latest` | 最近 N 期（1–100，实时接口） | `tools` |
| `ssq_history` | 往期数据：期号区间 / 年份 / 日期区间 + 分页 | `tools` |
| `ssq_sync` | 拉一次完整快照（21 页 / ~2091 期 / ~3 秒）写盘 | `tools` |
| `ssq_check` | 检查某开奖日是否已发布；未发布则排补抓阶梯 | `tools`+`schedule` |
| `ssq_watch_enable` | 创建开奖夜周期任务 | `tools`+`schedule` |
| `ssq_watch_status` | 查看周期任务 / 待补抓 / 每期结论 | `tools`+`schedule` |
| `ssq_watch_disable` | 停用本会话的全部定时任务 | `tools`+`schedule` |

## 斜杠命令

```text
/ssq-watch on       # 在当前会话启用
/ssq-watch status   # 查看（默认）
/ssq-watch off      # 停用并删除任务
```

任务绑在**发起它的会话**上：在哪个会话启用，提醒就投递到哪个会话，抓到的号码与奖级也写回那个会话。

## 抓取策略：每次都是完整快照

`ssq_check` / `ssq_sync` 每次都从官网拉**完整快照**（21 页、约 2091 期、约 3 秒、1.7 MB），按期号合并去重后整体重写存档：

- **不会重复**：期号是主键，`Map` 合并 + 读盘去重；读-改-写走每个存档目录一条写队列，并发调用不会互相覆盖。
- **不会漏**：每次都是官网的完整状态 —— 某期晚两天公布、中间缺一期、存档落后 N 期、甚至存档被删，都在下一次检查时自动对齐。
- 代价：每次检查 21 个请求。开奖夜最多 5 次（21:35 → 21:40 / 21:50 / 22:20 → 次日 06:00），分散在 4 小时以上。

官网 CDN 有频次风控（请求偏密时 302 自跳转并下发 `C3VK` 挑战 cookie，`Max-Age=300`），`src/cwl.mjs` 内置了极简 Cookie Jar + 一跳重放来应对；默认 2 并发 / 120ms 间隔。

## CLI

```bash
node bin/ssq.mjs info                  # 数据源信息 + 当前期数
node bin/ssq.mjs latest --count 5      # 最近 5 期（含各奖级）
node bin/ssq.mjs fetch                 # 全量落盘到 data/
node bin/ssq.mjs check                 # 校验已落盘数据（期号唯一/倒序/6 奖级/日期）
node bin/ssq.mjs watch                 # 开奖夜蹲点，测「开奖后多久能查到」
```

## 数据文件

| 文件 | 内容 |
| --- | --- |
| `ssq_draws.jsonl` | 每行一条完整记录（主存档） |
| `ssq_draws.csv` | 27 列宽表，可直接进 Excel / SQLite / pandas |
| `summary.json` / `latest.json` | 汇总与最近 10 期 |
| `watch-state.json` | 插件状态：周期任务 id、每期补抓任务 id、检查结论 |

## 开发

```bash
npm run syntax   # 语法检查（插件、浏览器半侧、数据层、CLI）
npm test         # 36 项冒烟测试（需要能访问 cwl.gov.cn）
```

测试用 `SSQ_DATA_DIR` 指向临时目录，不会写进仓库 `data/`。

## 发布

版本号规则 **YY.MM.NN**：`YY` 年份后两位、`MM` 月份、`NN` 当月第 N 次发布（01 起，两位数补零，如 `v26.11.01`）。npm 不接受前导零，所以 package.json 与 npm 包名用规范化形式（`26.11.1`），tag 与 Release 用补零形式。

- `workflow_dispatch`：自动算 `YY.MM`，`NN` 取「本月已有 tag 最大值 + 1」，也可手填；可选是否跑冒烟测试、是否发 Release。
- 推 tag `v26.11.03`：直接使用 tag 上的版本号。

工作流会：语法检查 → `npm version` 写版本 → `npm pack` → 校验产物清单 → 上传 artifact → 建 GitHub Release。这个插件没有编译步骤，所以「构建」就是版本注入 + 打包校验。

## 数据源的两个坑

1. **奖金带中文注解**：部分期次一等奖是 `5250000（含加奖250000）`，直接 `Number()` 会变 `NaN`；本项目拆成 `prize` + `prizeNote`（CSV 落在 `t1_prize_note`）。
2. **2013 年之前没有**：接口固定从 `2013001` 开始，更早的期次不在这个源里。

## License

MIT
