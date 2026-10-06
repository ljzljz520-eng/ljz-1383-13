# 技能证据图（Skill Evidence Graph）

个人展示站的「技能证据图」子系统：能力按**有向依赖图（DAG，允许多父）**组织，
每个节点分列三类信息——**主观自评分、可验证成果、计划目标**；规则驱动的「支持档位」只作文字化自我整理，
**不输出综合总分、不暗示客观认证**。

## 启动

```bash
cd server
npm install            # express + sql.js（WASM SQLite，无需原生编译）
npm start              # http://localhost:3000/app/skills.html
# 管理控制台：/app/admin.html （默认令牌 demo-owner-token，用 OWNER_TOKEN 环境变量修改）
npm test               # 8 项验收测试（每次使用临时数据库）
```

环境变量：`PORT` / `OWNER_TOKEN` / `DATA_DIR` / `AUTO_WORKER`（默认开，250ms 间隔）/ `WORKER_INTERVAL_MS`。

- 公开页：桌面端为可缩放平移的 SVG 依赖图；≤820px 自动切换为**按层折叠**结构。
- 旧静态站点仍可通过 `/site/index.html` 访问（主页导航已加入口）。

## 关键机制

| 需求 | 实现 |
|---|---|
| 多父能力结构 | `edges(parent→child)`，parent 为前置；全图 DAG |
| 新增关系检测环 | 串行写临界区内「DFS 环检测 + 插入」原子完成；成环返回 **409 与具体环路径** |
| 共享节点证据不重复加分 | 收集本节点+全部传递前置证据，按 `evidence_id` 去重（多节点挂载、多路径到达均只计一次） |
| 三种信息，不用总分 | `self_ratings`(1–5，标"主观") / `evidence`(可验证成果) / `plans`；只输出文字档位 |
| 规则选择并记录版本 | 选 **rule_driven**（见 `docs/design-notes.md` D1）；evidence_only 作对照存 `rule_versions`；`/api/meta/policy` 可查 |
| 证书到期/作品撤下 | 定时清扫 `valid_to`；状态变更沿正向边传播到**全部后代**，带可定位弱化原因（证据+依赖路径）重算 |
| 历史图保留当时依据 | 导出为不可变快照；私密证据在快照中仅为脱敏占位，后续变更不回改 |
| 并发添加成环关系 | 临界区互斥，恰有一方成功、另一方 409（验收测试 1） |
| 一证据支持多技能 | `evidence_nodes` 多对多；去重计数（验收测试 2） |
| 节点合并 | 边重指去重+环检测整笔回滚、证据/自评/计划迁移、`merged_into` 标记、后代重算（验收测试 5） |
| 规则升级时作业迟到 | 作业入队固化版本；升级后到期的旧作业按**入队版本**执行并标记 `late`（验收测试 6） |
| 部分证据私密 | 私密证据参与计数但公开 API 只给 `{masked:true}`，标题永不出现（含导出）（验收测试 3、7） |
| 可定位结果 | 节点详情返回全部依赖路径（前置→本节点）、逐证据路径、弱化原因与重算说明，而非统一"证据不足" |

## 规则版本

- **v1.0.0**（默认）：`verified_result → planned → self_asserted → no_signal`
- **v2.0.0**：证据强度 `strong/moderate/limited` → `verified_strong/verified/at_risk`，弱化原因更细。
  管理台「规则 / 作业」页可一键升级、构造迟到作业场景。

## 主要 API

公开（GET）：`/api/graph`、`/api/nodes/:id`、`/api/nodes/:id/reevaluate`、
`/api/exports`、`/api/exports/:id`、`/api/meta/policy`（带令牌头 `x-owner-token` 时返回管理视图）

管理（需 `x-owner-token`）：
`POST /api/admin/nodes`、`POST /api/admin/edges`、`DELETE /api/admin/edges/:id`、
`POST /api/admin/evidence`、`POST /api/admin/evidence/:id/link`、
`POST /api/admin/evidence/:id/status`（active/expired/withdrawn）、`PATCH /api/admin/evidence/:id`、
`POST /api/admin/ratings`、`POST /api/admin/plans`、`PATCH /api/admin/plans/:id`、
`POST /api/admin/nodes/merge`、`POST /api/admin/recompute`、
`POST /api/admin/rules/activate`、`POST /api/admin/maintenance/run-jobs`、
`GET /api/admin/jobs`、`POST /api/admin/exports`

## 存储

sql.js（WASM SQLite），文件持久化于 `server/data/skills.sqlite`（写事务后原子落盘）。
表结构见 `src/schema.js`。
