'use strict';
const { getDb } = require('./db');
const { id, nowIso } = require('./util');

function createNode({ slug, title, description = '' }) {
  const db = getDb();
  const row = { id: id('n'), slug, title, description, created_at: nowIso(), updated_at: nowIso() };
  db.prepare(`INSERT INTO nodes(id, slug, title, description, status, created_at, updated_at)
              VALUES (@id,@slug,@title,@description,'active',@created_at,@updated_at)`).run(row);
  return getNode(row.id);
}

function getNode(nodeId) {
  const db = getDb();
  return db.prepare(`SELECT * FROM nodes WHERE id=?`).get(nodeId)
      || db.prepare(`SELECT * FROM nodes WHERE slug=?`).get(nodeId);
}

function listNodes({ includeMerged = false } = {}) {
  const db = getDb();
  return db.prepare(includeMerged
    ? `SELECT * FROM nodes ORDER BY created_at`
    : `SELECT * FROM nodes WHERE status='active' ORDER BY created_at`).all();
}

/** 跟随 merged_into 解析到当前有效节点 */
function resolveNodeId(nodeId, hops = 10) {
  let cur = getNode(nodeId);
  while (cur && cur.status === 'merged' && cur.merged_into && hops-- > 0) {
    cur = getNode(cur.merged_into);
  }
  return cur ? cur.id : null;
}

function updateNode(nodeId, patch) {
  const db = getDb();
  const cur = getNode(nodeId);
  if (!cur) return null;
  const title = patch.title ?? cur.title;
  const description = patch.description ?? cur.description;
  const slug = patch.slug ?? cur.slug;
  db.prepare(`UPDATE nodes SET title=?, description=?, slug=?, updated_at=? WHERE id=?`)
    .run(title, description, slug, nowIso(), cur.id);
  return getNode(cur.id);
}

function listEdges() {
  return getDb().prepare(`SELECT * FROM edges ORDER BY created_at`).all();
}

class HttpError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status; this.code = code; this.details = details;
  }
}

/**
 * 新增前置关系（原子事务：环检测 + 写入）。
 * better-sqlite3 事务在 Node 事件循环中同步执行，
 * 因此并发 HTTP 请求下「检测+插入」不会被交错，成环关系不可能写入。
 */
function addEdge(fromId, toId, kind = 'hard') {
  const db = getDb();
  if (!['hard', 'weak'].includes(kind)) throw new HttpError(400, 'bad_kind', 'kind 必须是 hard 或 weak');
  const addTx = db.transaction(() => {
    const from = getNode(fromId), to = getNode(toId);
    if (!from) throw new HttpError(404, 'from_not_found', `前置节点不存在: ${fromId}`);
    if (!to) throw new HttpError(404, 'to_not_found', `目标节点不存在: ${toId}`);
    if (from.id === to.id) throw new HttpError(422, 'self_edge', '节点不能以前置指向自己');
    const dup = db.prepare(`SELECT id FROM edges WHERE from_node=? AND to_node=?`).get(from.id, to.id);
    if (dup) throw new HttpError(409, 'duplicate_edge', '该关系已存在');

    const { buildGraph, wouldCycle } = require('./dag');
    const graph = buildGraph(listNodes(), listEdges());
    if (wouldCycle(graph, from.id, to.id)) {
      throw new HttpError(422, 'cycle_detected', `新增 ${from.title} -> ${to.title} 会形成依赖环`,
        { from: from.id, to: to.id });
    }
    const eid = id('e');
    db.prepare(`INSERT INTO edges(id, from_node, to_node, kind, created_at) VALUES (?,?,?,?,?)`)
      .run(eid, from.id, to.id, kind, nowIso());
    return db.prepare(`SELECT * FROM edges WHERE id=?`).get(eid);
  });
  return addTx();
}

function removeEdge(edgeId) {
  const db = getDb();
  const e = db.prepare(`SELECT * FROM edges WHERE id=?`).get(edgeId);
  if (!e) throw new HttpError(404, 'edge_not_found', '关系不存在');
  db.prepare(`DELETE FROM edges WHERE id=?`).run(edgeId);
  return e;
}

/**
 * 节点合并：保留 target；source 标记 merged；证据链接与边迁移到 target；
 * 自环/重复边折叠；返回迁移明细供重算使用。
 */
function mergeNodes(sourceId, targetId) {
  const db = getDb();
  const mergeTx = db.transaction(() => {
    const source = resolveNodeId(sourceId), target = resolveNodeId(targetId);
    if (!source || !target) throw new HttpError(404, 'node_not_found', '节点不存在');
    if (source === target) throw new HttpError(422, 'same_node', '不能合并到自身');
    const movedEvidence = [];
    for (const link of db.prepare(`SELECT * FROM evidence_links WHERE node_id=?`).all(source)) {
      const exists = db.prepare(`SELECT id FROM evidence_links WHERE evidence_id=? AND node_id=?`)
        .get(link.evidence_id, target);
      if (exists) { db.prepare(`DELETE FROM evidence_links WHERE id=?`).run(link.id); }
      else {
        db.prepare(`UPDATE evidence_links SET node_id=? WHERE id=?`).run(target, link.id);
        movedEvidence.push(link.evidence_id);
      }
    }
    const movedEdges = [];
    for (const e of db.prepare(`SELECT * FROM edges WHERE from_node=? OR to_node=?`).all(source, source)) {
      const nf = e.from_node === source ? target : e.from_node;
      const nt = e.to_node === source ? target : e.to_node;
      if (nf === nt) { db.prepare(`DELETE FROM edges WHERE id=?`).run(e.id); movedEdges.push({ edge: e.id, folded: 'self' }); continue; }
      const dup = db.prepare(`SELECT id FROM edges WHERE from_node=? AND to_node=?`).get(nf, nt);
      if (dup) {
        // 保留更强(hard)的一条
        if (e.kind === 'hard') db.prepare(`UPDATE edges SET kind='hard' WHERE id=?`).run(dup.id);
        db.prepare(`DELETE FROM edges WHERE id=?`).run(e.id);
        movedEdges.push({ edge: e.id, folded: 'duplicate' });
      } else {
        db.prepare(`UPDATE edges SET from_node=?, to_node=? WHERE id=?`).run(nf, nt, e.id);
        movedEdges.push({ edge: e.id, folded: null });
      }
    }
    db.prepare(`UPDATE nodes SET status='merged', merged_into=?, updated_at=? WHERE id=?`)
      .run(target, nowIso(), source);
    return { source, target, movedEvidence, movedEdges };
  });
  return mergeTx();
}

function createEvidence(data) {
  const db = getDb();
  const eid = id('ev');
  db.prepare(`INSERT INTO evidence(
      id, kind, title, url, issuer, subtype, issued_on, expires_on, private, status,
      self_level, self_confidence, plan_target_level, plan_target_on, created_at, updated_at)
    VALUES (@id,@kind,@title,@url,@issuer,@subtype,@issued_on,@expires_on,@private,@status,
      @self_level,@self_confidence,@plan_target_level,@plan_target_on,@created_at,@updated_at)`).run({
    id: eid,
    kind: data.kind,
    title: data.title,
    url: data.url ?? null,
    issuer: data.issuer ?? null,
    subtype: data.subtype ?? null,
    issued_on: data.issued_on ?? null,
    expires_on: data.expires_on ?? null,
    private: data.private ? 1 : 0,
    status: data.status ?? 'active',
    self_level: data.self_level ?? null,
    self_confidence: data.self_confidence ?? null,
    plan_target_level: data.plan_target_level ?? null,
    plan_target_on: data.plan_target_on ?? null,
    created_at: nowIso(), updated_at: nowIso(),
  });
  return getEvidence(eid);
}

function getEvidence(eid) {
  return getDb().prepare(`SELECT * FROM evidence WHERE id=?`).get(eid);
}

function listEvidence({ includeInactive = true } = {}) {
  return getDb().prepare(includeInactive
    ? `SELECT * FROM evidence ORDER BY created_at`
    : `SELECT * FROM evidence WHERE status='active' ORDER BY created_at`).all();
}

function linkEvidence(evidenceId, nodeId) {
  const db = getDb();
  const ev = getEvidence(evidenceId), node = getNode(nodeId);
  if (!ev) throw new HttpError(404, 'evidence_not_found', '证据不存在');
  if (!node) throw new HttpError(404, 'node_not_found', '节点不存在');
  const lid = id('el');
  db.prepare(`INSERT INTO evidence_links(id, evidence_id, node_id, created_at) VALUES (?,?,?,?)
              ON CONFLICT(evidence_id, node_id) DO NOTHING`).run(lid, ev.id, node.id, nowIso());
  return { id: lid, evidence_id: ev.id, node_id: node.id };
}

function unlinkEvidence(evidenceId, nodeId) {
  getDb().prepare(`DELETE FROM evidence_links WHERE evidence_id=? AND node_id=?`).run(evidenceId, nodeId);
}

function listLinks() {
  return getDb().prepare(`SELECT * FROM evidence_links`).all();
}

/** 修改证据状态：active | withdrawn | expired（证书到期 / 作品撤下） */
function setEvidenceStatus(evidenceId, status) {
  const db = getDb();
  if (!['active', 'withdrawn', 'expired'].includes(status))
    throw new HttpError(400, 'bad_status', '状态必须是 active/withdrawn/expired');
  const ev = getEvidence(evidenceId);
  if (!ev) throw new HttpError(404, 'evidence_not_found', '证据不存在');
  db.prepare(`UPDATE evidence SET status=?, updated_at=? WHERE id=?`).run(status, nowIso(), ev.id);
  return getEvidence(ev.id);
}

function updateEvidence(evidenceId, patch) {
  const db = getDb();
  const cur = getEvidence(evidenceId);
  if (!cur) throw new HttpError(404, 'evidence_not_found', '证据不存在');
  const fields = ['title', 'url', 'issuer', 'subtype', 'issued_on', 'expires_on',
    'self_level', 'self_confidence', 'plan_target_level', 'plan_target_on'];
  const next = { ...cur };
  for (const f of fields) if (patch[f] !== undefined) next[f] = patch[f];
  if (patch.private !== undefined) next.private = patch.private ? 1 : 0;
  db.prepare(`UPDATE evidence SET title=?,url=?,issuer=?,subtype=?,issued_on=?,expires_on=?,
      private=?,self_level=?,self_confidence=?,plan_target_level=?,plan_target_on=?,updated_at=?
    WHERE id=?`).run(next.title, next.url, next.issuer, next.subtype, next.issued_on, next.expires_on,
      next.private, next.self_level, next.self_confidence, next.plan_target_level, next.plan_target_on,
      nowIso(), cur.id);
  return getEvidence(cur.id);
}

function listRules() {
  return getDb().prepare(`SELECT version, active, activated_at, notes, spec_json FROM rule_versions ORDER BY version`).all();
}
function activeRuleVersion() {
  return getDb().prepare(`SELECT version FROM rule_versions WHERE active=1`).get().version;
}

/**
 * 激活新规则版本（规则升级）。
 * 返回 {prev, next}，调用方负责排队全图重算作业（按当前时钟标记迟到行为）。
 */
function activateRule(version) {
  const db = getDb();
  const tx = db.transaction(() => {
    const exists = db.prepare(`SELECT version FROM rule_versions WHERE version=?`).get(version);
    if (!exists) throw new HttpError(404, 'rule_not_found', `规则版本不存在: ${version}`);
    const prev = activeRuleVersion();
    db.prepare(`UPDATE rule_versions SET active=0`).run();
    db.prepare(`UPDATE rule_versions SET active=1, activated_at=? WHERE version=?`).run(nowIso(), version);
    return { prev, next: version };
  });
  return tx();
}

function saveEvaluation(rec) {
  getDb().prepare(`INSERT INTO evaluations(node_id, rule_version, scope, level, points_json,
      evidence_breakdown_json, prerequisite_status, blockers_json, evidence_fingerprint, computed_at)
    VALUES (@node_id,@rule_version,@scope,@level,@points_json,@breakdown,@prereq,@blockers,@fingerprint,@computed_at)
    ON CONFLICT(node_id, rule_version, scope) DO UPDATE SET
      level=excluded.level, points_json=excluded.points_json,
      evidence_breakdown_json=excluded.evidence_breakdown_json,
      prerequisite_status=excluded.prerequisite_status, blockers_json=excluded.blockers_json,
      evidence_fingerprint=excluded.evidence_fingerprint, computed_at=excluded.computed_at`).run({
    ...rec,
    points_json: JSON.stringify(rec.points),
    breakdown: JSON.stringify(rec.evidence_breakdown),
    blockers: JSON.stringify(rec.blockers),
  });
}
function getEvaluation(nodeId, version, scope) {
  return getDb().prepare(`SELECT * FROM evaluations WHERE node_id=? AND rule_version=? AND scope=?`)
    .get(nodeId, version, scope);
}
function listEvaluations(version, scope) {
  return getDb().prepare(`SELECT * FROM evaluations WHERE rule_version=? AND scope=?`).all(version, scope);
}

function saveReevaluation(rec) {
  const rid = id('re');
  getDb().prepare(`INSERT INTO reevaluations(id, trigger, cause_ref, rule_version, scope, job_id, changes_json, late, created_at)
    VALUES (?,?,?,?,?,?,?,?,?)`).run(rid, rec.trigger, rec.cause_ref ?? null, rec.rule_version,
      rec.scope, rec.job_id ?? null, JSON.stringify(rec.changes), rec.late ? 1 : 0, nowIso());
  return getDb().prepare(`SELECT * FROM reevaluations WHERE id=?`).get(rid);
}
function listReevaluations() {
  return getDb().prepare(`SELECT * FROM reevaluations ORDER BY created_at DESC LIMIT 100`).all();
}

function saveExport(rec) {
  const xid = id('x');
  getDb().prepare(`INSERT INTO graph_exports(id, title, rule_version, fingerprint, snapshot_json, created_at)
    VALUES (?,?,?,?,?,?)`).run(xid, rec.title, rec.rule_version, rec.fingerprint, JSON.stringify(rec.snapshot), nowIso());
  return getDb().prepare(`SELECT * FROM graph_exports WHERE id=?`).get(xid);
}
function getExport(xid) {
  return getDb().prepare(`SELECT * FROM graph_exports WHERE id=?`).get(xid);
}
function listExports() {
  return getDb().prepare(`SELECT id, title, rule_version, fingerprint, created_at FROM graph_exports ORDER BY created_at DESC`).all();
}

function enqueueJob({ type, payload = {}, requestedVersion, runAfter = null, late = false }) {
  const db = getDb();
  const jid = id('j');
  db.prepare(`INSERT INTO jobs(id, type, payload_json, requested_version, run_after, status, late, created_at)
    VALUES (?,?,?,?,?, 'queued', ?, ?)`).run(jid, type, JSON.stringify(payload), requestedVersion ?? null,
      runAfter ?? nowIso(), late ? 1 : 0, nowIso());
  return db.prepare(`SELECT * FROM jobs WHERE id=?`).get(jid);
}
function dueJobs(atIso = nowIso()) {
  return getDb().prepare(`SELECT * FROM jobs WHERE status='queued' AND run_after<=? ORDER BY created_at`).all(atIso);
}
function getJob(jid) { return getDb().prepare(`SELECT * FROM jobs WHERE id=?`).get(jid); }
function listJobs() { return getDb().prepare(`SELECT * FROM jobs ORDER BY created_at DESC LIMIT 100`).all(); }
function finishJob(jid, result, error = null) {
  const db = getDb();
  db.prepare(`UPDATE jobs SET status=?, result_json=?, error=?, finished_at=? WHERE id=?`)
    .run(error ? 'failed' : 'done', result ? JSON.stringify(result) : null, error, nowIso(), jid);
  return getJob(jid);
}
function staleQueuedCount(version) {
  return getDb().prepare(`SELECT COUNT(*) c FROM jobs WHERE status='queued' AND requested_version IS NOT NULL AND requested_version<>?`)
    .get(version).c;
}

module.exports = {
  HttpError,
  createNode, getNode, listNodes, updateNode, resolveNodeId, mergeNodes,
  listEdges, addEdge, removeEdge,
  createEvidence, getEvidence, listEvidence, updateEvidence, setEvidenceStatus,
  linkEvidence, unlinkEvidence, listLinks,
  listRules, activeRuleVersion, activateRule,
  saveEvaluation, getEvaluation, listEvaluations,
  saveReevaluation, listReevaluations,
  saveExport, getExport, listExports,
  enqueueJob, dueJobs, getJob, listJobs, finishJob, staleQueuedCount,
};
