'use strict';

// 技能证据图：全部表结构。
// 方向约定：edge(parent_id -> child_id) = parent 是 child 的前置（parent 先行、child 依赖 parent）。
const SCHEMA = `
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS nodes (
  id          TEXT PRIMARY KEY,
  title       TEXT NOT NULL,
  description TEXT DEFAULT '',
  merged_into TEXT REFERENCES nodes(id),
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS edges (
  id        TEXT PRIMARY KEY,
  parent_id TEXT NOT NULL REFERENCES nodes(id),
  child_id  TEXT NOT NULL REFERENCES nodes(id),
  created_at INTEGER NOT NULL,
  UNIQUE(parent_id, child_id),
  CHECK(parent_id <> child_id)
);
CREATE INDEX IF NOT EXISTS idx_edges_parent ON edges(parent_id);
CREATE INDEX IF NOT EXISTS idx_edges_child  ON edges(child_id);

-- ev_kind: 'work'(可验证成果) | 'cert'(证书) | 'artifact'(作品) | 'assessment'(外部测评)
-- is_public=0 的证据只参与计数，公开页绝不返回标题等内容。
CREATE TABLE IF NOT EXISTS evidence (
  id         TEXT PRIMARY KEY,
  title      TEXT NOT NULL,
  ev_kind    TEXT NOT NULL CHECK(ev_kind IN ('work','cert','artifact','assessment')),
  url        TEXT DEFAULT '',
  is_public  INTEGER NOT NULL DEFAULT 1,
  status     TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','expired','withdrawn')),
  valid_from INTEGER,
  valid_to   INTEGER,
  detail     TEXT DEFAULT '',
  created_at INTEGER NOT NULL
);

-- 一份证据可支持多个技能节点（多对多）。
CREATE TABLE IF NOT EXISTS evidence_nodes (
  evidence_id TEXT NOT NULL REFERENCES evidence(id),
  node_id     TEXT NOT NULL REFERENCES nodes(id),
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (evidence_id, node_id)
);
CREATE INDEX IF NOT EXISTS idx_en_evidence ON evidence_nodes(evidence_id);
CREATE INDEX IF NOT EXISTS idx_en_node     ON evidence_nodes(node_id);

-- 信息类型 1：自评分（1-5，明确标注为主观自评，不参与任何"总分"）。
CREATE TABLE IF NOT EXISTS self_ratings (
  id          TEXT PRIMARY KEY,
  node_id     TEXT NOT NULL REFERENCES nodes(id),
  score       INTEGER NOT NULL CHECK(score BETWEEN 1 AND 5),
  note        TEXT DEFAULT '',
  is_public   INTEGER NOT NULL DEFAULT 1,
  rated_at    INTEGER NOT NULL,
  created_at  INTEGER NOT NULL
);

-- 信息类型 3：计划目标（SMART 计划，不算成果）。
CREATE TABLE IF NOT EXISTS plans (
  id          TEXT PRIMARY KEY,
  node_id     TEXT NOT NULL REFERENCES nodes(id),
  title       TEXT NOT NULL,
  target_date INTEGER,
  status      TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','in_progress','done')),
  is_public   INTEGER NOT NULL DEFAULT 1,
  created_at  INTEGER NOT NULL
);

-- 计算规则版本。approach='rule_driven' 或 'evidence_only'。
-- 决策（见 docs/design-notes.md）：选择 rule_driven，evidence_only 仅作为对照记录。
CREATE TABLE IF NOT EXISTS rule_versions (
  version        TEXT PRIMARY KEY,
  approach       TEXT NOT NULL CHECK(approach IN ('rule_driven','evidence_only')),
  spec           TEXT NOT NULL,          -- JSON：规则细节
  note           TEXT DEFAULT '',
  active         INTEGER NOT NULL DEFAULT 0,
  activated_at   INTEGER
);

-- 每个节点在某个规则版本下的最近一次重新评估结果（三类信息分开，不存在总分）。
CREATE TABLE IF NOT EXISTS evaluations (
  node_id        TEXT NOT NULL REFERENCES nodes(id),
  rule_version   TEXT NOT NULL,
  updated_at     INTEGER NOT NULL,
  self_score     INTEGER,
  support_level  TEXT,                  -- 规则驱动的支持档位（不是分数）
  evidence_count INTEGER NOT NULL DEFAULT 0,
  strength       TEXT,                  -- v2：证据强度 strong/moderate/limited/none
  weakened       INTEGER NOT NULL DEFAULT 0, -- 沿依赖图透传的弱化（前置证书过期/作品撤下）
  weaken_reasons TEXT DEFAULT '[]',     -- JSON 数组：可定位的具体原因（节点+证据+路径）
  path_report    TEXT DEFAULT '{}',     -- JSON：支撑该节点的证据及其依赖路径
  plan_open      INTEGER NOT NULL DEFAULT 0,
  recompute_note TEXT DEFAULT '',       -- 本次重算说明（触发原因、影响范围）
  PRIMARY KEY (node_id, rule_version)
);

-- 异步作业（重算 / 规则升级）。picked_at 前的作业视为"迟到作业"。
CREATE TABLE IF NOT EXISTS jobs (
  id          TEXT PRIMARY KEY,
  job_type    TEXT NOT NULL CHECK(job_type IN ('recompute','activate_ruleset')),
  payload     TEXT NOT NULL DEFAULT '{}',
  status      TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','done','failed')),
  rule_version TEXT NOT NULL,          -- 入队时固化的规则版本（迟到作业按旧版本执行）
  not_before  INTEGER NOT NULL,        -- 最早可执行时间，支持测试延迟
  result      TEXT DEFAULT '{}',
  error       TEXT DEFAULT '',
  created_at  INTEGER NOT NULL,
  picked_at   INTEGER,
  finished_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status, not_before);

-- 不可变历史图快照：导出后冻结，证据私密则只保留脱敏占位。
CREATE TABLE IF NOT EXISTS exports (
  id           TEXT PRIMARY KEY,
  rule_version TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  label        TEXT DEFAULT '',
  snapshot     TEXT NOT NULL           -- JSON 全图快照
);

CREATE TABLE IF NOT EXISTS audit_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  action     TEXT NOT NULL,
  entity     TEXT DEFAULT '',
  entity_id  TEXT DEFAULT '',
  detail     TEXT DEFAULT '',
  created_at INTEGER NOT NULL
);
`;

module.exports = { SCHEMA };
