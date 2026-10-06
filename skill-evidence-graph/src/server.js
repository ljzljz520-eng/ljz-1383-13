'use strict';
const express = require('express');
const path = require('path');
const repo = require('./repository');
const engine = require('./engine');
const jobs = require('./jobs');
const { exportGraph, loadExport } = require('./exports');
const dag = require('./dag');
const { RULE_MAP } = require('../rules/registry');
const clock = require('./clock');

function createApp() {
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use(express.static(path.join(__dirname, '..', 'public')));

  const ADMIN_KEY = process.env.ADMIN_KEY || 'dev-admin-key';
  function requireAdmin(req, res, next) {
    if ((req.get('x-admin-key') || req.query.key) !== ADMIN_KEY)
      return res.status(401).json({ error: 'unauthorized', message: '管理接口需要 x-admin-key' });
    next();
  }

  function handle(fn) {
    return (req, res, next) => Promise.resolve(fn(req, res)).catch(next);
  }

  // ---------- 公开 API（私密证据完全不出现，标题绝不暴露） ----------
  app.get('/api/health', (req, res) => res.json({ ok: true, now: clock.nowIso() }));

  app.get('/api/rules/active', handle((req, res) => {
    const v = repo.activeRuleVersion();
    res.json({ active_version: v, mode: 'rule-driven-summary', spec: RULE_MAP[v] });
  }));
  app.get('/api/rules', handle((req, res) =>
    res.json(repo.listRules().map((r) => ({ version: r.version, active: !!r.active, activated_at: r.activated_at, notes: r.notes, spec: JSON.parse(r.spec_json) })))));

  app.get('/api/graph', handle((req, res) => {
    const v = req.query.version || repo.activeRuleVersion();
    const { graph, results } = engine.evaluateGraph({ ruleVersion: v, scope: 'public' });
    const { order, rank } = dag.layers(graph);
    res.json({
      rule_version: v, mode: 'rule-driven-summary', computed_at: clock.nowIso(),
      nodes: order.map((id) => {
        const r = results.get(id);
        const n = graph.nodes.get(id);
        return {
          id, slug: n.slug, title: n.title, description: n.description,
          rank: rank.get(id),
          level: r.level, raw_level: r.raw_level, points: r.points,
          prerequisite_status: r.prerequisite_status, blockers: r.blockers, gaps: r.gaps,
          parents: (graph.into.get(id) || []).map((e) => ({ id: e.from_node, kind: e.kind })),
          children: (graph.out.get(id) || []).map((e) => ({ id: e.to_node, kind: e.kind })),
        };
      }),
      edges: [...graph.nodes.keys()].flatMap((id) =>
        (graph.out.get(id) || []).map((e) => ({ id: e.id, from: id, to: e.to_node, kind: e.kind }))),
    });
  }));

  app.get('/api/nodes/:idOrSlug', handle((req, res) => {
    const v = req.query.version || repo.activeRuleVersion();
    const scope = req.query.scope === 'owner' && (req.get('x-admin-key') || req.query.key) === (process.env.ADMIN_KEY || 'dev-admin-key') ? 'owner' : 'public';
    const node = repo.getNode(req.params.idOrSlug);
    if (!node || (node.status === 'merged' && !req.query.include_merged)) {
      if (node && node.status === 'merged') return res.status(410).json({
        error: 'node_merged', message: '该节点已合并', merged_into: node.merged_into,
        current: `/api/nodes/${node.merged_into}`,
      });
      return res.status(404).json({ error: 'not_found' });
    }
    if (node.status === 'merged') return res.status(410).json({
      error: 'node_merged', message: '该节点已合并', merged_into: node.merged_into,
      current: `/api/nodes/${node.merged_into}`,
    });
    const { results } = engine.evaluateGraph({ ruleVersion: v, scope });
    const r = results.get(node.id);
    if (!r) return res.status(404).json({ error: 'not_active' });
    res.json({
      ...r,
      description: node.description,
      private_visible: scope === 'owner',
      // 私密证据在 public 作用域下根本不会出现在 evidence/plans/self 中
    });
  }));

  /** 可定位的依赖路径：from(前置) -> to(依赖方)，支持多路径（多父 DAG） */
  app.get('/api/paths/:from/:to', handle((req, res) => {
    const nodes = repo.listNodes();
    const graph = dag.buildGraph(nodes, repo.listEdges());
    const from = repo.getNode(req.params.from), to = repo.getNode(req.params.to);
    if (!from || !to) return res.status(404).json({ error: 'not_found' });
    const kinds = req.query.kind ? req.query.kind.split(',') : null;
    const one = dag.shortestPath(graph, from.id, to.id, kinds);
    if (!one) return res.status(404).json({ error: 'no_path', message: `${from.title} 与 ${to.title} 之间不存在依赖路径` });
    const all = dag.allPaths(graph, from.id, to.id, kinds, 30);
    const titleOf = Object.fromEntries(nodes.map((n) => [n.id, { title: n.title, slug: n.slug }]));
    res.json({
      from: from.id, to: to.id, kinds: kinds || ['hard', 'weak'],
      shortest: one, shortest_titles: one.map((id) => titleOf[id]?.title),
      all_paths: all,
      all_paths_titles: all.map((p) => p.map((id) => titleOf[id]?.title)),
      count: all.length,
    });
  }));

  /** 受影响分析：某证据/节点变化会沿依赖图影响哪些下游节点 */
  app.get('/api/affected/:nodeId', handle((req, res) => {
    const graph = dag.buildGraph(repo.listNodes(), repo.listEdges());
    const node = repo.getNode(req.params.nodeId);
    if (!node) return res.status(404).json({ error: 'not_found' });
    const affected = dag.affectedDownstream(graph, node.id, null);
    const v = repo.activeRuleVersion();
    const { results } = engine.evaluateGraph({ ruleVersion: v, scope: 'public' });
    res.json({
      origin: node.id, origin_title: node.title,
      affected: affected.map((id, i) => ({ id, depth: i === 0 ? 0 : null,
        title: graph.nodes.get(id)?.title, level: results.get(id)?.level,
        status: results.get(id)?.prerequisite_status })),
    });
  }));

  app.get('/api/reevaluations', handle((req, res) =>
    res.json(repo.listReevaluations().map((r) => ({ ...r, changes: JSON.parse(r.changes_json), late: !!r.late })))));

  app.get('/api/exports', handle((req, res) => res.json(repo.listExports())));
  app.get('/api/exports/:id', handle((req, res) => {
    const row = loadExport(req.params.id);
    if (!row) return res.status(404).json({ error: 'not_found' });
    res.json({ id: row.id, title: row.title, rule_version: row.rule_version, fingerprint: row.fingerprint, created_at: row.created_at, snapshot: row.snapshot });
  }));

  // ---------- 管理 API ----------
  app.post('/api/admin/nodes', requireAdmin, handle((req, res) => {
    const { slug, title, description } = req.body || {};
    if (!slug || !title) return res.status(400).json({ error: 'bad_request', message: 'slug/title 必填' });
    const node = repo.createNode({ slug, title, description });
    const out = engine.reevaluateFrom(node.id, { trigger: 'node_created', causeRef: node.id });
    res.status(201).json({ node, reevaluation: out });
  }));

  app.patch('/api/admin/nodes/:id', requireAdmin, handle((req, res) => {
    const node = repo.updateNode(req.params.id, req.body || {});
    if (!node) return res.status(404).json({ error: 'not_found' });
    res.json(node);
  }));

  /** 新增前置关系；成环 -> 422 cycle_detected（事务内检测，并发安全） */
  app.post('/api/admin/edges', requireAdmin, handle((req, res) => {
    const { from, to, kind } = req.body || {};
    if (!from || !to) return res.status(400).json({ error: 'bad_request', message: 'from/to 必填' });
    const edge = repo.addEdge(from, to, kind);
    const out = engine.reevaluateFrom(to, { trigger: 'edge_added', causeRef: edge.id });
    res.status(201).json({ edge, reevaluation: out });
  }));

  app.delete('/api/admin/edges/:id', requireAdmin, handle((req, res) => {
    const edge = repo.removeEdge(req.params.id);
    const out = engine.reevaluateFrom(edge.to_node, { trigger: 'edge_removed', causeRef: edge.id });
    res.json({ edge, reevaluation: out });
  }));

  app.post('/api/admin/nodes/merge', requireAdmin, handle((req, res) => {
    const { source, target } = req.body || {};
    if (!source || !target) return res.status(400).json({ error: 'bad_request', message: 'source/target 必填' });
    const result = repo.mergeNodes(source, target);
    // 合并后：目标节点及其下游全部重算
    const out = engine.reevaluateFrom(result.target, { trigger: 'node_merged', causeRef: result.source });
    res.json({ merge: result, reevaluation: out });
  }));

  app.post('/api/admin/evidence', requireAdmin, handle((req, res) => {
    const b = req.body || {};
    if (!b.kind || !b.title) return res.status(400).json({ error: 'bad_request', message: 'kind/title 必填' });
    if (!['self', 'verifiable', 'plan'].includes(b.kind))
      return res.status(400).json({ error: 'bad_kind', message: "kind 必须是 self/verifiable/plan" });
    const ev = repo.createEvidence(b);
    let reev = null;
    if (Array.isArray(b.nodes)) {
      for (const nid of b.nodes) repo.linkEvidence(ev.id, nid);
      // 一份证据支持多个技能：每个技能节点及其下游各自重算
      reev = b.nodes.map((nid) => engine.reevaluateFrom(nid, { trigger: 'evidence_linked', causeRef: ev.id }));
    }
    res.status(201).json({ evidence: ev, linked_nodes: b.nodes || [], reevaluation: reev });
  }));

  app.patch('/api/admin/evidence/:id', requireAdmin, handle((req, res) => {
    const ev = repo.updateEvidence(req.params.id, req.body || {});
    const nodeIds = [...new Set(repo.listLinks().filter((l) => l.evidence_id === ev.id).map((l) => l.node_id))];
    const reev = nodeIds.map((nid) => engine.reevaluateFrom(nid, { trigger: 'evidence_updated', causeRef: ev.id }));
    res.json({ evidence: ev, reevaluation: reev });
  }));

  /** 证书到期 / 作品撤下：标记后沿依赖图重算受影响节点，输出逐节点前后差异 */
  app.post('/api/admin/evidence/:id/status', requireAdmin, handle((req, res) => {
    const { status } = req.body || {};
    const ev = repo.setEvidenceStatus(req.params.id, status);
    const nodeIds = [...new Set(repo.listLinks().filter((l) => l.evidence_id === ev.id).map((l) => l.node_id))];
    const trigger = status === 'expired' ? 'evidence_expired' : status === 'withdrawn' ? 'evidence_withdrawn' : 'evidence_reactivated';
    const reev = nodeIds.map((nid) => engine.reevaluateFrom(nid, { trigger, causeRef: ev.id }));
    res.json({ evidence: ev, reevaluation: reev });
  }));

  app.post('/api/admin/evidence/:id/link/:nodeId', requireAdmin, handle((req, res) => {
    const link = repo.linkEvidence(req.params.id, req.params.nodeId);
    const out = engine.reevaluateFrom(link.node_id, { trigger: 'evidence_linked', causeRef: link.evidence_id });
    res.status(201).json({ link, reevaluation: out });
  }));

  app.delete('/api/admin/evidence/:id/link/:nodeId', requireAdmin, handle((req, res) => {
    repo.unlinkEvidence(req.params.id, req.params.nodeId);
    const out = engine.reevaluateFrom(req.params.nodeId, { trigger: 'evidence_unlinked', causeRef: req.params.id });
    res.json({ reevaluation: out });
  }));

  /** 规则升级：切换版本并为全图重算排队；可指定延迟以演示「作业迟到」 */
  app.post('/api/admin/rules/:version/activate', requireAdmin, handle((req, res) => {
    const delayMs = Number(req.body?.delay_ms || 0);
    const { prev, next } = repo.activateRule(req.params.version);
    const runAfter = new Date(clock.now().getTime() + delayMs).toISOString();
    const job = repo.enqueueJob({ type: 'full_reevaluate', requestedVersion: next, runAfter });
    res.json({ activated: { from: prev, to: next }, job: { id: job.id, run_after: job.run_after, status: job.status } });
  }));

  app.post('/api/admin/jobs/process', requireAdmin, handle((req, res) => res.json({ reports: jobs.processDueJobs() })));
  app.post('/api/admin/jobs/enqueue', requireAdmin, handle((req, res) => {
    const { type = 'full_reevaluate', version, late = true, at } = req.body || {};
    const job = repo.enqueueJob({
      type, requestedVersion: version || repo.activeRuleVersion(),
      runAfter: at || new Date(clock.now().getTime() - 1000).toISOString(), late,
    });
    res.status(201).json({ job: { id: job.id, type: job.type, requested_version: job.requested_version, late: !!job.late } });
  }));
  app.get('/api/admin/jobs', requireAdmin, handle((req, res) => res.json(repo.listJobs())));

  /** 手动排队一次到期清扫（可延迟，演示规则升级期间证书过期作业迟到） */
  app.post('/api/admin/evidence/sweep', requireAdmin, handle((req, res) => {
    const delayMs = Number(req.body?.delay_ms || 0);
    const runAfter = new Date(clock.now().getTime() + delayMs).toISOString();
    const job = repo.enqueueJob({ type: 'evidence_expiry_sweep', requestedVersion: repo.activeRuleVersion(), runAfter });
    res.status(201).json({ job: { id: job.id, run_after: job.run_after } });
  }));

  app.post('/api/admin/reevaluate/:nodeId', requireAdmin, handle((req, res) => {
    res.json(engine.reevaluateFrom(req.params.nodeId, { trigger: 'manual' }));
  }));

  app.post('/api/admin/exports', requireAdmin, handle((req, res) => {
    const row = exportGraph(req.body?.title);
    res.status(201).json({ id: row.id, title: row.title, rule_version: row.rule_version, fingerprint: row.fingerprint, created_at: row.created_at });
  }));


  // 测试专用：冻结/恢复系统时钟（需管理密钥，仅 SEG_ALLOW_CLOCK=1 时开放）
  if (process.env.SEG_ALLOW_CLOCK === '1') {
    app.post('/api/test/clock', requireAdmin, (req, res) => {
      if (req.body?.iso) { clock.freeze(req.body.iso); } else { clock.reset(); }
      res.json({ now: clock.nowIso() });
    });
  }

  app.use('/api', (err, req, res, next) => {
    if (err.status) return res.status(err.status).json({ error: err.code, message: err.message, details: err.details });
    console.error(err);
    res.status(500).json({ error: 'internal', message: err.message });
  });
  app.use((err, req, res, next) => {
    if (err.status) return res.status(err.status).json({ error: err.code, message: err.message, details: err.details });
    console.error(err);
    res.status(500).json({ error: 'internal', message: err.message });
  });
  app.use((req, res) => res.status(404).json({ error: 'not_found', path: req.path }));
  return app;
}

module.exports = { createApp };
