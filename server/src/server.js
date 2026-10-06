'use strict';

const path = require('path');
const express = require('express');
const dbm = require('./db');
const rules = require('./rules');
const graph = require('./graph');
const worker = require('./worker');
const view = require('./view');
const { mergeNodes } = require('./merge');
const { seed } = require('./seed');

const PORT = process.env.PORT || 3000;
const TOKEN = process.env.OWNER_TOKEN || 'demo-owner-token';

const app = express();
app.use(express.json({ limit: '1mb' }));

function asyncH(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}
function requireOwner(req, res, next) {
  if (req.get('x-owner-token') !== TOKEN) return res.status(401).json({ error: '需要管理令牌（x-owner-token）' });
  next();
}

// ---------- 公开 ----------
app.get('/api/health', (req, res) => res.json({ ok: true, at: Date.now() }));

// 规则决策说明（含"规则驱动 vs 只展示证据强度"的选择记录）
app.get('/api/meta/policy', (req, res) => {
  const rows = dbm.all(`SELECT version, approach, spec, note, active, activated_at FROM rule_versions ORDER BY active DESC, version`);
  res.json({
    decision: 'rule_driven',
    decisionNote: '选择规则驱动汇总：三类信息（自评分/可验证成果/计划目标）分列，只给文字支持档位；不输出总分、不暗示客观认证。evidence_only 方案保留为对照，未启用。',
    activeVersion: rules.activeRuleVersion(),
    versions: rows.map((r) => ({
      version: r.version,
      approach: r.approach,
      note: r.note,
      active: !!r.active,
      activatedAt: r.activated_at,
      spec: JSON.parse(r.spec),
    })),
    noScoreStatement: '本站不存在综合技能分数；自评分明确标注为主观自评。',
  });
});

app.get('/api/graph', (req, res) => {
  const owner = req.get('x-owner-token') === TOKEN;
  res.json(view.graphView({ owner, version: req.query.version || null }));
});

// 节点详情：完整依赖路径 + 重新评估结果（可定位，而非统一"证据不足"标签）
app.get('/api/nodes/:id', (req, res) => {
  const owner = req.get('x-owner-token') === TOKEN;
  const version = req.query.version || rules.activeRuleVersion();
  const node = dbm.get(`SELECT * FROM nodes WHERE id=? AND merged_into IS NULL`, [req.params.id]);
  if (!node) {
    const merged = dbm.get(`SELECT * FROM nodes WHERE id=?`, [req.params.id]);
    if (merged && merged.merged_into) return res.status(410).json({ error: '节点已合并', mergedInto: merged.merged_into });
    return res.status(404).json({ error: '节点不存在' });
  }
  const ev = dbm.get(`SELECT * FROM evaluations WHERE node_id=? AND rule_version=?`, [node.id, version]);
  const rating = dbm.get(`SELECT * FROM self_ratings WHERE node_id=? ORDER BY rated_at DESC LIMIT 1`, [node.id]);
  const plans = dbm.all(`SELECT * FROM plans WHERE node_id=? ORDER BY created_at`, [node.id]).map((p) => ({
    id: p.id, title: p.title, target_date: p.target_date, status: p.status, is_public: !!p.is_public,
  }));

  const { rev, fwd } = graph.buildAdj();
  const anc = graph.ancestorPaths(node.id, rev);
  const titles = Object.fromEntries(dbm.all(`SELECT id,title FROM nodes`).map((r) => [r.id, r.title]));
  const dependencyPaths = [];
  for (const [ancId, routes] of anc) {
    if (ancId === node.id) continue;
    for (const route of routes) {
      dependencyPaths.push({
        ancestorId: ancId,
        ancestorTitle: titles[ancId] || ancId,
        route: route.concat(node.id),
        routeTitles: route.concat(node.id).map((id) => titles[id] || id),
      });
    }
  }
  const children = [...(fwd.get(node.id) || [])].map((id) => ({ id, title: titles[id] }));

  res.json({
    ...view.evaluationView(node, ev, { owner, ruleVersion: version, rating, plans }),
    description: node.description,
    parents: [...(rev.get(node.id) || [])].map((id) => ({ id, title: titles[id] })),
    children,
    dependencyPaths,
  });
});

// 实时重算预览（不写库）：展示"若现在重新评估会得到什么"
app.get('/api/nodes/:id/reevaluate', (req, res) => {
  const owner = req.get('x-owner-token') === TOKEN;
  const version = req.query.version || rules.activeRuleVersion();
  const node = dbm.get(`SELECT * FROM nodes WHERE id=? AND merged_into IS NULL`, [req.params.id]);
  if (!node) return res.status(404).json({ error: '节点不存在' });
  const result = rules.evaluateNode(node.id, version, Date.now());
  const { rev } = graph.buildAdj();
  const anc = graph.ancestorPaths(node.id, rev);
  res.json({
    nodeId: node.id,
    title: node.title,
    ruleVersion: result.ruleVersion,
    supportLevel: result.supportLevel,
    supportLabel: rules.SUPPORT_LABEL[result.supportLevel],
    strength: result.strength,
    evidenceCount: result.evidenceCount,
    weakened: !!result.weakened,
    weakenReasons: owner ? result.weakenReasons : view.maskEvidenceList(result.weakenReasons, view.privateEvidenceIds()).items,
    pathReport: owner ? result.pathReport : view.maskEvidenceList(result.pathReport, view.privateEvidenceIds()).items,
    ancestorCount: anc.size - 1,
  });
});

// 历史导出（公开可查看；创建时的快照冻结，私密证据在导出内即脱敏）
app.get('/api/exports', (req, res) => {
  const rows = dbm.all(`SELECT id, rule_version, created_at, label FROM exports ORDER BY created_at DESC`);
  res.json(rows);
});
app.get('/api/exports/:id', (req, res) => {
  const row = dbm.get(`SELECT * FROM exports WHERE id=?`, [req.params.id]);
  if (!row) return res.status(404).json({ error: '导出不存在' });
  res.json({ id: row.id, ruleVersion: row.rule_version, createdAt: row.created_at, label: row.label, snapshot: JSON.parse(row.snapshot) });
});

// ---------- 管理 API（串行化写临界区）----------
function writeTx(fn) {
  return dbm.tx(async () => {
    const out = await fn();
    dbm.flush();
    return out;
  });
}

app.post('/api/admin/nodes', requireOwner, asyncH(async (req, res) => {
  const { title, description = '' } = req.body || {};
  if (!title) return res.status(400).json({ error: 'title 必填' });
  const out = await writeTx(() => {
    const id = dbm.genId('node');
    dbm.run(`INSERT INTO nodes (id,title,description,created_at) VALUES (?,?,?,?)`, [id, title, description, Date.now()]);
    dbm.audit('node.create', 'node', id, { title });
    return { id };
  });
  res.status(201).json(out);
}));

// 新增前置关系（环检测 + 并发安全：检查与插入在同一串行临界区）
app.post('/api/admin/edges', requireOwner, asyncH(async (req, res) => {
  const { parentId, childId } = req.body || {};
  if (!parentId || !childId) return res.status(400).json({ error: 'parentId, childId 必填' });
  const out = await writeTx(() => {
    const p = dbm.get(`SELECT id FROM nodes WHERE id=? AND merged_into IS NULL`, [parentId]);
    const c = dbm.get(`SELECT id FROM nodes WHERE id=? AND merged_into IS NULL`, [childId]);
    if (!p || !c) throw notFound('节点不存在');
    const { fwd } = graph.buildAdj();
    const cyc = graph.cyclePathIfAdded(parentId, childId, fwd);
    if (cyc) throw conflict(`该前置关系会形成环：${cyc.join(' → ')}（方向：前置→后置）`);
    const dup = dbm.get(`SELECT id FROM edges WHERE parent_id=? AND child_id=?`, [parentId, childId]);
    if (dup) return { id: dup.id, deduped: true };
    const id = dbm.genId('edge');
    dbm.run(`INSERT INTO edges (id,parent_id,child_id,created_at) VALUES (?,?,?,?)`, [id, parentId, childId, Date.now()]);
    dbm.audit('edge.create', 'edge', id, { parentId, childId });
    const affected = worker.propagationSet([childId]);
    const jobId = worker.enqueueRecompute(affected, rules.activeRuleVersion(), { reason: `新增前置 ${parentId}→${childId}` });
    return { id, cyclePath: null, recomputeJobId: jobId, affectedNodes: affected };
  });
  res.status(201).json(out);
}));

app.delete('/api/admin/edges/:id', requireOwner, asyncH(async (req, res) => {
  const out = await writeTx(() => {
    const edge = dbm.get(`SELECT * FROM edges WHERE id=?`, [req.params.id]);
    if (!edge) throw notFound('边不存在');
    dbm.run(`DELETE FROM edges WHERE id=?`, [req.params.id]);
    dbm.audit('edge.delete', 'edge', req.params.id, { parentId: edge.parent_id, childId: edge.child_id });
    const affected = worker.propagationSet([edge.child_id]);
    const jobId = worker.enqueueRecompute(affected, rules.activeRuleVersion(), { reason: `删除前置 ${edge.parent_id}→${edge.child_id}` });
    return { recomputeJobId: jobId, affectedNodes: affected };
  });
  res.json(out);
}));

// 证据：创建、挂接多节点、更新状态（到期/撤下触发沿图重算）、可见性
app.post('/api/admin/evidence', requireOwner, asyncH(async (req, res) => {
  const b = req.body || {};
  if (!b.title || !b.kind) return res.status(400).json({ error: 'title, kind 必填' });
  if (!['work', 'cert', 'artifact', 'assessment'].includes(b.kind)) return res.status(400).json({ error: 'kind 非法' });
  const out = await writeTx(() => {
    const id = dbm.genId('ev');
    dbm.run(
      `INSERT INTO evidence (id,title,ev_kind,url,is_public,status,valid_from,valid_to,detail,created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [id, b.title, b.kind, b.url || '', b.isPublic === false ? 0 : 1, 'active',
       b.validFrom || null, b.validTo || null, b.detail || '', Date.now()]
    );
    for (const nodeId of b.nodeIds || []) {
      const n = dbm.get(`SELECT id FROM nodes WHERE id=? AND merged_into IS NULL`, [nodeId]);
      if (!n) throw notFound('挂接节点不存在: ' + nodeId);
      dbm.run(`INSERT INTO evidence_nodes (evidence_id,node_id,created_at) VALUES (?,?,?)`, [id, nodeId, Date.now()]);
    }
    dbm.audit('evidence.create', 'evidence', id, { title: b.title, nodeIds: b.nodeIds });
    const affected = worker.propagationSet(b.nodeIds || []);
    const jobId = worker.enqueueRecompute(affected, rules.activeRuleVersion(), { reason: `新增证据《${b.title}》` });
    return { id, affectedNodes: affected, recomputeJobId: jobId };
  });
  res.status(201).json(out);
}));

app.post('/api/admin/evidence/:id/link', requireOwner, asyncH(async (req, res) => {
  const out = await writeTx(() => {
    const ev = dbm.get(`SELECT id FROM evidence WHERE id=?`, [req.params.id]);
    if (!ev) throw notFound('证据不存在');
    const nodeId = req.body.nodeId;
    const n = dbm.get(`SELECT id FROM nodes WHERE id=? AND merged_into IS NULL`, [nodeId]);
    if (!n) throw notFound('节点不存在');
    dbm.run(`INSERT OR IGNORE INTO evidence_nodes (evidence_id,node_id,created_at) VALUES (?,?,?)`, [req.params.id, nodeId, Date.now()]);
    const affected = worker.propagationSet([nodeId]);
    const jobId = worker.enqueueRecompute(affected, rules.activeRuleVersion(), { reason: `证据 ${req.params.id} 增挂技能 ${nodeId}` });
    return { affectedNodes: affected, recomputeJobId: jobId };
  });
  res.json(out);
}));

// 状态变更：active / expired(证书到期) / withdrawn(作品撤下) -> 沿依赖图重算挂载节点及全部后代
app.post('/api/admin/evidence/:id/status', requireOwner, asyncH(async (req, res) => {
  const status = req.body.status;
  if (!['active', 'expired', 'withdrawn'].includes(status)) return res.status(400).json({ error: 'status 非法' });
  const out = await writeTx(() => {
    const ev = dbm.get(`SELECT * FROM evidence WHERE id=?`, [req.params.id]);
    if (!ev) throw notFound('证据不存在');
    dbm.run(`UPDATE evidence SET status=? WHERE id=?`, [status, req.params.id]);
    dbm.audit('evidence.status', 'evidence', req.params.id, { from: ev.status, to: status });
    const attached = dbm.all(`SELECT node_id FROM evidence_nodes WHERE node_id IN (SELECT id FROM nodes WHERE merged_into IS NULL) AND evidence_id=?`, [req.params.id]);
    const roots = attached.map((r) => r.node_id);
    const affected = worker.propagationSet(roots);
    const reason = status === 'withdrawn' ? `作品/证据撤下《${ev.title}》` : status === 'expired' ? `证书/证据到期《${ev.title}》` : `证据恢复有效《${ev.title}》`;
    const jobId = worker.enqueueRecompute(affected, rules.activeRuleVersion(), { reason });
    return { status, roots, affectedNodes: affected, recomputeJobId: jobId };
  });
  res.json(out);
}));

app.patch('/api/admin/evidence/:id', requireOwner, asyncH(async (req, res) => {
  const out = await writeTx(() => {
    const ev = dbm.get(`SELECT * FROM evidence WHERE id=?`, [req.params.id]);
    if (!ev) throw notFound('证据不存在');
    const b = req.body || {};
    const fields = [];
    const vals = [];
    for (const [k, col] of [['title', 'title'], ['url', 'url'], ['detail', 'detail'], ['validTo', 'valid_to'], ['validFrom', 'valid_from']]) {
      if (b[k] !== undefined) { fields.push(`${col}=?`); vals.push(b[k]); }
    }
    if (b.isPublic !== undefined) { fields.push('is_public=?'); vals.push(b.isPublic ? 1 : 0); }
    if (fields.length) { vals.push(req.params.id); dbm.run(`UPDATE evidence SET ${fields.join(',')} WHERE id=?`, vals); }
    dbm.audit('evidence.update', 'evidence', req.params.id, b);
    return { ok: true };
  });
  res.json(out);
}));

app.post('/api/admin/ratings', requireOwner, asyncH(async (req, res) => {
  const { nodeId, score, note = '', isPublic = true } = req.body || {};
  if (!nodeId || !(score >= 1 && score <= 5)) return res.status(400).json({ error: 'nodeId 与 score(1-5) 必填' });
  const out = await writeTx(() => {
    const id = dbm.genId('rate');
    dbm.run(`INSERT INTO self_ratings (id,node_id,score,note,is_public,rated_at,created_at) VALUES (?,?,?,?,?,?,?)`,
      [id, nodeId, score, note, isPublic ? 1 : 0, Date.now(), Date.now()]);
    const affected = worker.propagationSet([nodeId]);
    const jobId = worker.enqueueRecompute(affected, rules.activeRuleVersion(), { reason: '自评分更新（仅展示，不影响档位）' });
    return { id, recomputeJobId: jobId };
  });
  res.status(201).json(out);
}));

app.post('/api/admin/plans', requireOwner, asyncH(async (req, res) => {
  const { nodeId, title, targetDate = null, isPublic = true, status = 'open' } = req.body || {};
  if (!nodeId || !title) return res.status(400).json({ error: 'nodeId, title 必填' });
  const out = await writeTx(() => {
    const id = dbm.genId('plan');
    dbm.run(`INSERT INTO plans (id,node_id,title,target_date,status,is_public,created_at) VALUES (?,?,?,?,?,?,?)`,
      [id, nodeId, title, targetDate, status, isPublic ? 1 : 0, Date.now()]);
    const affected = worker.propagationSet([nodeId]);
    const jobId = worker.enqueueRecompute(affected, rules.activeRuleVersion(), { reason: `新增计划《${title}》` });
    return { id, recomputeJobId: jobId };
  });
  res.status(201).json(out);
}));

app.patch('/api/admin/plans/:id', requireOwner, asyncH(async (req, res) => {
  const out = await writeTx(() => {
    const p = dbm.get(`SELECT * FROM plans WHERE id=?`, [req.params.id]);
    if (!p) throw notFound('计划不存在');
    const status = req.body.status;
    if (status && ['open', 'in_progress', 'done'].includes(status)) dbm.run(`UPDATE plans SET status=? WHERE id=?`, [status, req.params.id]);
    const affected = worker.propagationSet([p.node_id]);
    const jobId = worker.enqueueRecompute(affected, rules.activeRuleVersion(), { reason: `计划状态变更 ${req.params.id}` });
    return { recomputeJobId: jobId };
  });
  res.json(out);
}));

// 节点合并
app.post('/api/admin/nodes/merge', requireOwner, asyncH(async (req, res) => {
  const { sourceId, targetId } = req.body || {};
  if (!sourceId || !targetId) return res.status(400).json({ error: 'sourceId, targetId 必填' });
  const out = await writeTx(() => mergeNodes(sourceId, targetId));
  res.json(out);
}));

// 触发重算（可指定节点；不传则全量）
app.post('/api/admin/recompute', requireOwner, asyncH(async (req, res) => {
  const { nodeIds = null, delayMs = 0, reason = '手动触发' } = req.body || {};
  const out = await writeTx(() => {
    const ids = nodeIds && nodeIds.length ? nodeIds : graph.activeNodes().map((n) => n.id);
    const jobId = worker.enqueueRecompute(ids, rules.activeRuleVersion(), { delayMs, reason });
    return { jobId, delayMs, nodeCount: ids.length, runAt: Date.now() + delayMs };
  });
  res.status(202).json(out);
}));

// 规则升级（activate 作业；delayMs 用于构造"迟到作业"场景）
app.post('/api/admin/rules/activate', requireOwner, asyncH(async (req, res) => {
  const { version, delayMs = 0 } = req.body || {};
  if (![rules.V1, rules.V2].includes(version)) return res.status(400).json({ error: `version 必须是 ${rules.V1} 或 ${rules.V2}` });
  const out = await writeTx(() => {
    const exists = dbm.get(`SELECT version FROM rule_versions WHERE version=?`, [version]);
    if (!exists) throw notFound('规则版本不存在');
    const jobId = worker.enqueueActivate(version, { delayMs });
    dbm.audit('ruleset.enqueue', 'rule_version', version, { delayMs });
    return { jobId, delayMs, runAt: Date.now() + delayMs };
  });
  res.status(202).json(out);
}));

// 到期清扫 + 执行到期作业（维护端点）
app.post('/api/admin/maintenance/run-jobs', requireOwner, asyncH(async (req, res) => {
  const out = await writeTx(() => {
    const expired = rules.sweepExpiry();
    if (expired.length) {
      const attached = new Set();
      for (const id of expired) {
        for (const r of dbm.all(`SELECT node_id FROM evidence_nodes WHERE evidence_id=?`, [id])) attached.add(r.node_id);
      }
      const affected = worker.propagationSet([...attached]);
      if (affected.length) worker.enqueueRecompute(affected, rules.activeRuleVersion(), { reason: `定时清扫：${expired.length} 条证据到期` });
    }
    const reports = worker.runDueJobs({ now: Date.now(), dryRun: !!req.body.dryRun });
    return { sweptExpired: expired, jobReports: reports };
  });
  res.json(out);
}));

app.get('/api/admin/jobs', requireOwner, (req, res) => {
  res.json(dbm.all(`SELECT id,job_type,status,rule_version,not_before,picked_at,finished_at,result,error,created_at FROM jobs ORDER BY created_at DESC LIMIT 100`));
});

// 创建历史图导出（快照冻结；快照内在存储时即对私密证据脱敏，保证永不外泄标题）
app.post('/api/admin/exports', requireOwner, asyncH(async (req, res) => {
  const out = await writeTx(() => {
    const gv = view.graphView({ owner: false }); // 强制公开视图快照
    const id = dbm.genId('exp');
    const label = req.body.label || '';
    dbm.run(`INSERT INTO exports (id,rule_version,created_at,label,snapshot) VALUES (?,?,?,?,?)`,
      [id, gv.ruleVersion, Date.now(), label, JSON.stringify({ ...gv, frozen: true, freezeNote: '导出后图结构与评估结果不再变化；新变更请重新导出。' })]);
    dbm.audit('export.create', 'export', id, { version: gv.ruleVersion });
    return { id, ruleVersion: gv.ruleVersion };
  });
  res.status(201).json(out);
}));

function notFound(msg) { const e = new Error(msg); e.status = 404; return e; }
function conflict(msg) { const e = new Error(msg); e.status = 409; return e; }

// 静态资源：技能图页面（public/）与原站点根目录（/site）
app.use('/app', express.static(path.join(__dirname, '..', '..', 'public')));
app.use('/site', express.static(path.join(__dirname, '..', '..')));
app.get('/', (req, res) => res.redirect('/app/skills.html'));

app.use((err, req, res, next) => {
  const status = err.status || 500;
  if (status === 500) console.error(err);
  res.status(status).json({ error: err.message || '服务器错误' });
});

let timer = null;
async function start() {
  await dbm.getDb();
  seed();
  const auto = process.env.AUTO_WORKER !== '0';
  if (auto) {
    timer = setInterval(() => {
      dbm.tx(() => {
        const expired = rules.sweepExpiry();
        if (expired.length) {
          const attached = new Set();
          for (const id of expired) {
            for (const r of dbm.all(`SELECT node_id FROM evidence_nodes WHERE evidence_id=?`, [id])) attached.add(r.node_id);
          }
          const affected = worker.propagationSet([...attached]);
          if (affected.length) worker.enqueueRecompute(affected, rules.activeRuleVersion(), { reason: `定时清扫：${expired.length} 条证据到期` });
        }
        const reports = worker.runDueJobs();
        if (reports.length || expired.length) console.log('[worker] ran', { expired, jobs: reports.length });
      }).catch(() => {});
    }, Number(process.env.WORKER_INTERVAL_MS || 250));
  }
  app.listen(PORT, () => console.log(`技能证据图服务: http://localhost:${PORT}/app/skills.html`));
}

if (require.main === module) start();

module.exports = { app, start };
