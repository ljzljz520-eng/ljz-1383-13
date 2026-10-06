# 技能证据图（Skill Evidence Graph）

个人展示站的「技能证据图」：能力结构是**允许多父节点的有向依赖图（DAG）**；管理 API 把节点、
前置关系、证据与计划存入 SQLite；节点结论按**登记版本的规则**计算，而不是用一个总分暗示客观认证。

## 快速开始

```bash
npm install
npm run seed          # 写入演示数据（多父 DAG / 共享证据 / 私密证据 / 到期证书 / 计划）
npm start             # http://localhost:3000 （管理密钥默认 dev-admin-key）
npm test              # 10 项验收测试（node:test，使用临时库，互不影响）
npm run test:concurrency   # 并发成环压力脚本
```

- 展示页：<http://localhost:3000/>
- 管理控制台：<http://localhost:3000/admin.html>
- 历史快照：展示页底部链接，或 `/snapshot.html?id=<exportId>`

环境变量：`PORT`、`SEG_DB`（数据库路径）、`ADMIN_KEY`、`SEG_ALLOW_CLOCK=1`（测试时钟）。

## 浏览形态

| 宽屏（桌面图） | 窄屏（≤860px，移动折叠） |
| --- | --- |
| SVG 按最长路径分层绘制多父 DAG；硬前置实线、弱前置虚线；节点颜色为成熟度，阻塞节点红框 | 按依赖层折叠（`<details>`），层内节点再折叠展开同样的三区详情与路径 |
| 点击节点高亮入边，侧栏展示 ①可验证成果 ②自评分 ③计划目标、门控路径、影响范围 | 同一份详情，不做桌面图的缩放版 |

顶部可切换「规则驱动汇总 / 仅证据强度」：后者只显示原始计点，不显示等级与门控结论；
当前计算规则版本始终显示在横幅中。

## 三类信息（不合并为总分）

1. **自评分 `self`**：自评等级 + 置信度，独立展示，最多 +1 点置信加成（v2 要求有可验证成果垫底）。
2. **可验证成果 `verifiable`**：`certificate / project / article / work / other`，按子类权重计点；
   证据可挂多个节点（**一份证据支持多个技能**），可设 `private`、`expires_on`、`status`。
3. **计划目标 `plan`**：只作路线图展示，**永不参与定级**。

输出只有节点级四档「自评成熟度」：`none / foundational / applied / proven`，并在页面与 API 中
明确声明这是规则化自评、**不是客观认证**；系统不存在全局总分。

## 计算规则（已登记版本，见 `rules/registry.js`，并存入 `rule_versions` 表）

**设计抉择：选用「规则驱动汇总」**；「只展示证据强度」仅作为前端视图。理由与完整决策见
[docs-decisions.md](./docs-decisions.md)（D1）。

- **v1.0.0（当前默认）**：
  - 直接可验证成果按子类权重计点；硬前置门控要求每个硬前置 ≥ applied 且 ≥3 点，否则结论封顶 applied；
  - 证据沿**硬前置** BFS 继承，权重 ×0.5；**同一证据对同一节点只计一次**（多父共享不重复加分），
    每条继承证据带 `inherited_from` 与 `path`；
  - 自评分最高 +1；计划不计点；阈值 foundational≥1 / applied≥3 / proven≥6。
- **v2.0.0（升级）**：证书到期即失活、到期前 30 天线性衰减；4 年以上证据 ×0.5 新鲜度；
  弱前置不再门控只显示缺口；自评加成需要 2 点直接可验证成果垫底；阈值 proven 提升到 7。

每条评估结论带 `evidence_fingerprint`（依据的稳定哈希），可判断结论为何变化。

## 环检测与并发

- 边方向 `from(前置) -> to(依赖方)`。新增边在 **better-sqlite3 同步事务**内完成「建图→环检测→写入」，
  Node 事件循环中不会被并发请求交错；成环/自环返回 `422 cycle_detected|self_edge` 并定位两端。
- 验收：`test/acceptance.test.js` 用并发请求验证；`scripts/concurrency-check.js` 以 5 节点全排列、
  12 并发跑 20 条边，结果恒为 10 条合法边 + 10 次拒绝，图始终无环。

## 证书到期 / 作品撤下后的重新评估

`POST /api/admin/evidence/:id/status {status: expired|withdrawn|active}` 或到期清扫作业：

- 沿依赖图 BFS 得到全部受影响下游（含多父汇聚节点），在当前规则版本下重算两个作用域；
- 返回/记录**逐节点** `before→after`（级别、指纹、阻塞项、弱缺口项），阻塞项带
  从缺口前置到该节点的**可定位路径**（`GET /api/paths/:from/:to` 列出全部路径）；
- 不使用统一的「证据不足」标签。历史可查：`GET /api/reevaluations`。

## 规则升级与作业迟到

- `POST /api/admin/rules/:version/activate` 切换版本并排队全图重算作业（可延迟）。
- 作业携带 `requested_version`；执行时若已不是当前版本，结果标记 `stale` 并丢弃，绝不覆盖新结论；
  `late=1` 留痕。管理台可手工排入迟到作业演示（`POST /api/admin/jobs/enqueue`）。

## 历史图导出（不可变）

`POST /api/admin/exports` 冻结当时的规则版本、指纹与全部依据快照；之后证据撤下/到期、规则升级
都**不会**改变该快照（快照里过期/撤下的证据仍显示为导出时的有效依据）。`GET /api/exports/:id`
可查看，公开页面有只读查看器。

## 私密证据

- 公开作用域在**评估前整体剔除**私密证据：标题、URL 等任何字段都不出现在 `/api/graph`、
  `/api/nodes/*`、快照与重评估差异中（验收测试用标题关键字全文扫描保证）。
- 属主作用域需请求头 `x-admin-key`；无密钥访问 `?scope=owner` 自动退化为公开视图。

## 节点合并

`POST /api/admin/nodes/merge {source,target}`：证据链接迁移（重复折叠）、边重定向（自环删除、
重复边保留 hard）；事务完成后重算 target 及其全部下游；旧节点返回 `410 node_merged` 并指向新节点。

## 主要 API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/graph?version=` | 分层图 + 节点结论（公开，无私密证据） |
| GET | `/api/nodes/:idOrSlug` | 节点三区详情、门控、阻塞路径（`?scope=owner` 需密钥） |
| GET | `/api/paths/:from/:to?kind=hard` | 可定位依赖路径（最短 + 全部简单路径） |
| GET | `/api/affected/:nodeId` | 节点变化后的下游重算顺序 |
| GET | `/api/rules` `/api/rules/active` | 规则版本登记 |
| GET | `/api/reevaluations` | 重新评估历史（逐节点差异、late 标记） |
| GET/POST | `/api/exports[/:id]` | 不可变历史图 |
| POST | `/api/admin/nodes` `/api/admin/edges` `/api/admin/nodes/merge` | 结构写入（环检测） |
| POST/PATCH/DELETE | `/api/admin/evidence...` | 证据/自评/计划、链接、状态（撤下/到期触发重算） |
| POST | `/api/admin/rules/:v/activate` `/api/admin/jobs/process` `/api/admin/jobs/enqueue` | 规则升级与作业 |
| POST | `/api/admin/evidence/sweep` | 到期证书清扫（可延迟） |

## 目录

```
rules/registry.js      计算规则登记（模式选择、v1/v2 计算契约、版本说明）
src/db.js              SQLite schema 与规则版本登记
src/dag.js             DAG：环检测/路径/受影响集/拓扑分层
src/engine.js          评估引擎：去重继承、门控、双作用域、指纹、重算传播
src/repository.js      数据访问（写事务、加边环检测、节点合并）
src/jobs.js            作业处理（全图重算/到期清扫，迟到与 stale）
src/exports.js         不可变历史快照
src/server.js          HTTP API + 静态站点
public/                桌面图 / 移动折叠 / 管理台 / 快照查看器
test/                  验收测试（10 项）
scripts/seed.js        演示数据；scripts/concurrency-check.js 并发压力
docs-decisions.md      设计决策记录（D1–D10）
```
