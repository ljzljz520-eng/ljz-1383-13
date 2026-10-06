const path = require('path');
const Database = require('better-sqlite3');
const { nowIso } = require('./util');
const { RULE_SPECS } = require('../rules/registry');

let db;

function openDb(dbPath = process.env.SEG_DB || path.join(__dirname, '..', 'data.sqlite')) {
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  migrate(db);
  return db;
}

function getDb() {
  if (!db) throw new Error('DB not initialized');
  return db;
}

function migrate(db) {
  db.exec(`
  CREATE TABLE IF NOT EXISTS nodes (
    id TEXT PRIMARY KEY,
    slug TEXT UNIQUE NOT NULL,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'active',
    merged_into TEXT REFERENCES nodes(id),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS edges (
    id TEXT PRIMARY KEY,
    from_node TEXT NOT NULL REFERENCES nodes(id),
    to_node TEXT NOT NULL REFERENCES nodes(id),
    kind TEXT NOT NULL DEFAULT 'hard',
    created_at TEXT NOT NULL,
    UNIQUE(from_node, to_node)
  );

  CREATE TABLE IF NOT EXISTS evidence (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK(kind IN ('self','verifiable','plan')),
    title TEXT NOT NULL,
    url TEXT,
    issuer TEXT,
    subtype TEXT,
    issued_on TEXT,
    expires_on TEXT,
    private INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'active',
    self_level INTEGER,
    self_confidence REAL,
    plan_target_level INTEGER,
    plan_target_on TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS evidence_links (
    id TEXT PRIMARY KEY,
    evidence_id TEXT NOT NULL REFERENCES evidence(id) ON DELETE CASCADE,
    node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    UNIQUE(evidence_id, node_id)
  );

  CREATE TABLE IF NOT EXISTS rule_versions (
    version TEXT PRIMARY KEY,
    active INTEGER NOT NULL DEFAULT 0,
    activated_at TEXT,
    notes TEXT NOT NULL DEFAULT '',
    spec_json TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS evaluations (
    node_id TEXT NOT NULL,
    rule_version TEXT NOT NULL,
    scope TEXT NOT NULL,
    level TEXT NOT NULL,
    points_json TEXT NOT NULL,
    evidence_breakdown_json TEXT NOT NULL,
    prerequisite_status TEXT NOT NULL,
    blockers_json TEXT NOT NULL,
    evidence_fingerprint TEXT NOT NULL,
    computed_at TEXT NOT NULL,
    PRIMARY KEY (node_id, rule_version, scope)
  );

  CREATE TABLE IF NOT EXISTS reevaluations (
    id TEXT PRIMARY KEY,
    trigger TEXT NOT NULL,
    cause_ref TEXT,
    rule_version TEXT NOT NULL,
    scope TEXT NOT NULL,
    job_id TEXT,
    changes_json TEXT NOT NULL,
    late INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS graph_exports (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    rule_version TEXT NOT NULL,
    fingerprint TEXT NOT NULL,
    snapshot_json TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS jobs (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    payload_json TEXT NOT NULL DEFAULT '{}',
    requested_version TEXT,
    run_after TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'queued',
    late INTEGER NOT NULL DEFAULT 0,
    result_json TEXT,
    error TEXT,
    created_at TEXT NOT NULL,
    finished_at TEXT
  );
  `);

  // Register rule specs (code-defined; spec_json is the recorded calculation contract)
  const ins = db.prepare(
    `INSERT INTO rule_versions(version, active, activated_at, notes, spec_json)
     VALUES (@version, 0, NULL, @notes, @spec)
     ON CONFLICT(version) DO UPDATE SET notes=@notes, spec_json=@spec`
  );
  for (const spec of RULE_SPECS) {
    ins.run({ version: spec.version, notes: spec.notes, spec: JSON.stringify(spec) });
  }
  const active = db.prepare(`SELECT version FROM rule_versions WHERE active=1`).get();
  if (!active) {
    db.prepare(`UPDATE rule_versions SET active=1, activated_at=? WHERE version=?`).run(nowIso(), '1.0.0');
  }
}

module.exports = { openDb, getDb };
