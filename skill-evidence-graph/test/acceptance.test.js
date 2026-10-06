'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createApp } = require('../src/server');
const { openDb, getDb } = require('../src/db');
const repo = require('../src/repository');
const engine = require('../src/engine');
const jobs = require('../src/jobs');
const dag = require('../src/dag');
const { RULE_MAP } = require('../rules/registry');
const clock = require('../src/clock');
const { exportGraph, loadExport } = require('../src/exports');

const ADMIN = { 'x-admin-key': 'test-key' };
let base, server;

async function api(p, opts = {}) {
  const res = await fetch(base + p, {
    ...opts,
    headers: { 'content-type': 'application/json', ...(opts.headers || {}) },
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

function freshDb() {
  const file = path.join(os.tmpdir(), `seg-${Math.random().toString(36).slice(2)}.sqlite`);
  process.env.SEG_DB = file;
  process.env.ADMIN_KEY = 'test-key';
  process.env.SEG_ALLOW_CLOCK = '1';
  openDb(file);
}

test.before(async () => {
  freshDb();
  const app = createApp();
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
});

test.beforeEach(() => clock.reset());
test.after(() => { try { server.close(); } catch {} });

async function nodeApi(slug, title, description = '') {
  const r = await api('/api/admin/nodes', { method: 'POST', headers: ADMIN, body: JSON.stringify({ slug, title, description }) });
  assert.equal(r.status, 201, r.body.message);
  return r.body.node;
}
async function edgeApi(from, to, kind = 'hard') {
  return api('/api/admin/edges', { method: 'POST', headers: ADMIN, body: JSON.stringify({ from, to, kind }) });
}
async function evApi(data) {
  const r = await api('/api/admin/evidence', { method: 'POST', headers: ADMIN, body: JSON.stringify(data) });
  assert.equal(r.status, 201, r.body.message);
  return r.body;
}
async function levelOf(slug, scope = 'public') {
  const q = scope === 'owner' ? '&scope=owner' : '';
  const r = await api(`/api/nodes/${slug}?${q}`, { headers: scope === 'owner' ? ADMIN : {} });
  return r.body;
}

// 1) 并发添加成环关系：只有不成环的能写入，所有成环请求 422
test('并发添加成环关系：环被拒绝且图保持 DAG', async () => {
  const a = await nodeApi('a', 'A');
  const b = await nodeApi('b', 'B');
  const c = await nodeApi('c', 'C');
  // 先建 a->b
  const ok = await edgeApi('a', 'b'); assert.equal(ok.status, 201);
  // 并发：b->c（合法），c->a（在 a->b->c 后成环），b->a（在 a->b 存在时成环），a->a（自环）
  const attempts = [
    edgeApi('b', 'c'),
    edgeApi('c', 'a'),
    edgeApi('b', 'a'),
    edgeApi('a', 'a'),
  ];
  const results = await Promise.all(attempts);
  const codes = results.map((r) => r.status);
  assert.equal(codes[0], 201, 'b->c 应成功');
  for (let i = 1; i < results.length; i++) {
    const r = results[i];
    assert.equal(r.status, 422);
    assert.ok(['cycle_detected', 'self_edge'].includes(r.body.error));
    if (r.body.error === 'cycle_detected') {
      assert.ok(r.body.details?.from && r.body.details?.to, '错误须可定位到两个节点');
    }
  }
  // 具体成环（非自环）的那两条必须带 cycle_detected
  assert.equal(results[2].body.error, 'cycle_detected'); // b->a
  assert.equal(results[1].body.error, 'cycle_detected'); // c->a
  // 图必须仍是无环 DAG
  const graph = dag.buildGraph(repo.listNodes(), repo.listEdges());
  assert.deepEqual(dag.findCycles(graph), []);
});

// 2) 一份证据支持多个技能 + 共享节点证据不重复加分
test('一份证据支持多个技能；共享前置证据在下游只计一次', async () => {
  const x = await nodeApi('x', 'X 技能');
  const y = await nodeApi('y', 'Y 技能');
  const z = await nodeApi('z', 'Z 技能（多父）');
  await edgeApi('x', 'z'); await edgeApi('y', 'z');
  // 同一证据挂到 x 和 y（共享证据）
  const e = await evApi({ kind: 'verifiable', title: '共享证书', subtype: 'certificate', nodes: ['x', 'y'] });
  // 额外给 y 同一证据不应重复（link 幂等）
  await api(`/api/admin/evidence/${e.evidence.id}/link/y`, { method: 'POST', headers: ADMIN });
  await engine.recomputeAndPersist();
  const zd = await levelOf('z');
  // 继承证据应只有一条「共享证书」，计 1 点（2*0.5），而不是 2 点
  const inherited = zd.evidence.filter((v) => v.kind === 'verifiable' && v.inherited);
  assert.equal(inherited.length, 1, '共享证据在 z 只出现一次');
  assert.equal(zd.points.inherited_verifiable, 1);
});

// 3) 节点合并：边/证据迁移、自环折叠、合并节点返回 410 指引
test('节点合并：证据与边迁移，旧节点 410 指向新节点，下游重算', async () => {
  const p = await nodeApi('p', 'P 旧节点');
  const q = await nodeApi('q', 'Q 保留节点');
  const r = await nodeApi('r', 'R 下游');
  await edgeApi('p', 'r'); await edgeApi('q', 'r');
  await evApi({ kind: 'verifiable', title: 'P 的证书', subtype: 'certificate', nodes: ['p'] });
  const m = await api('/api/admin/nodes/merge', { method: 'POST', headers: ADMIN, body: JSON.stringify({ source: 'p', target: 'q' }) });
  assert.equal(m.status, 200);
  assert.equal(m.body.merge.source, p.id);
  // p->r 与 q->r 去重为一条
  const edges = repo.listEdges();
  assert.equal(edges.filter((e) => e.to_node === r.id).length, 1);
  // 证据迁移到 q
  const links = repo.listLinks().filter((l) => l.node_id === q.id);
  assert.ok(links.some((l) => repo.getEvidence(l.evidence_id).title === 'P 的证书'));
  // 旧节点公开接口 410 并给出当前位置
  const gone = await api('/api/nodes/p');
  assert.equal(gone.status, 410);
  assert.equal(gone.body.merged_into, q.id);
  // 重算覆盖 q 与 r
  const affected = m.body.reevaluation.affected;
  assert.ok(affected.includes(q.id) && affected.includes(r.id));
});

// 4) 规则升级 + 作业迟到（旧版本作业结果丢弃）
test('规则升级排队全图重算；迟到/过期作业标记 stale 不覆盖', async () => {
  // 立即激活 v2
  const act = await api('/api/admin/rules/2.0.0/activate', { method: 'POST', headers: ADMIN, body: JSON.stringify({ delay_ms: 0 }) });
  assert.equal(act.body.activated.to, '2.0.0');
  let reports = (await api('/api/admin/jobs/process', { method: 'POST', headers: ADMIN })).body.reports;
  assert.equal(reports.length, 1);
  assert.equal(reports[0].result.stale, false);
  // 当前图的评估版本已切换
  const g = await (await fetch(base + '/api/graph')).json();
  assert.equal(g.rule_version, '2.0.0');
  // 手工构造一个针对旧版本 1.0.0 的迟到作业
  repo.enqueueJob({ type: 'full_reevaluate', requestedVersion: '1.0.0', runAfter: new Date(Date.now() - 1000).toISOString(), late: true });
  reports = (await api('/api/admin/jobs/process', { method: 'POST', headers: ADMIN })).body.reports;
  assert.equal(reports[0].late, true);
  assert.equal(reports[0].result.stale, true);
  assert.match(reports[0].result.note, /迟到/);
  // 回滚到 v1 便于后续测试
  await api('/api/admin/rules/1.0.0/activate', { method: 'POST', headers: ADMIN, body: JSON.stringify({}) });
  await api('/api/admin/jobs/process', { method: 'POST', headers: ADMIN });
});

// 5) 部分证据私密：公开页不暴露标题，属主可见且计分
test('部分证据私密：公开页绝不出现私密标题，属主可见', async () => {
  const s = await nodeApi('s', 'S 技能');
  await evApi({ kind: 'verifiable', title: '公开作品', subtype: 'project', nodes: ['s'], private: false });
  await evApi({ kind: 'verifiable', title: '秘密客户保密项目-TOPSECRET', subtype: 'work', nodes: ['s'], private: true });
  const pub = await levelOf('s');
  const own = await levelOf('s', 'owner');
  const pubJson = JSON.stringify(pub);
  assert.ok(!pubJson.includes('TOPSECRET'), '公开响应任何位置不得含私密证据标题');
  assert.equal(pub.evidence.length, 1);
  assert.ok(own.evidence.some((e) => e.title.includes('TOPSECRET')));
  assert.ok(own.points.total > pub.points.total, '私密证据在属主作用域计分');
  // 图级接口也不能泄露
  const graphRaw = await (await fetch(base + '/api/graph')).text();
  assert.ok(!graphRaw.includes('TOPSECRET'));
  // 无管理密钥不能访问属主作用域
  const forbidden = await api('/api/nodes/s?scope=owner');
  assert.ok(!JSON.stringify(forbidden.body).includes('TOPSECRET'));
});

// 6) 证书到期/作品撤下沿依赖图重算，且给出逐节点前后差异（非统一标签）
test('证据撤下：沿依赖图重算，返回可定位的差异与阻塞路径', async () => {
  const d1 = await nodeApi('d1', 'D1 前置技能');
  const d2 = await nodeApi('d2', 'D2 下游技能');
  await edgeApi('d1', 'd2');
  const e = await evApi({ kind: 'verifiable', title: '可撤下的作品', subtype: 'project', nodes: ['d1'] });
  await engine.recomputeAndPersist();
  const before = await levelOf('d2');
  assert.ok(before.evidence.some((v) => v.inherited && v.title === '可撤下的作品'));
  const r = await api(`/api/admin/evidence/${e.evidence.id}/status`, { method: 'POST', headers: ADMIN, body: JSON.stringify({ status: 'withdrawn' }) });
  assert.equal(r.status, 200);
  // 重算同时覆盖 d1 与 d2
  const allAffected = r.body.reevaluation.map((x) => x.affected);
  assert.ok(allAffected.some((arr) => arr.includes(d1.id) && arr.includes(d2.id)));
  const after = await levelOf('d2');
  assert.ok(!after.evidence.some((v) => v.title === '可撤下的作品' && v.active !== false && v.points > 0));
  assert.ok(after.evidence.some((v) => v.title === '可撤下的作品' && v.active === false));
  // 差异是逐节点、带级别与指纹的，而不是统一"证据不足"
  const changes = r.body.reevaluation.flatMap((x) => x.changes);
  assert.ok(changes.some((c) => c.before && c.after && c.after.level));
  // 重评估历史可查
  const hist = await (await fetch(base + '/api/reevaluations')).json();
  assert.ok(hist.some((h) => h.trigger === 'evidence_withdrawn'));
});

// 7) 历史导出不可变：导出后撤下证据并升级规则，快照仍保留当时依据
test('历史导出不可变：撤下证据+规则升级后快照仍保留当时依据', async () => {
  const h1 = await nodeApi('h1', 'H1 技能');
  const created = await evApi({ kind: 'verifiable', title: '将要撤下但已入快照', subtype: 'project', nodes: ['h1'] });
  const xr = await api('/api/admin/exports', { method: 'POST', headers: ADMIN, body: JSON.stringify({ title: '历史时刻' }) });
  assert.equal(xr.status, 201);
  const snapId = xr.body.id;
  // 之后撤下证据 + 升级规则
  await api(`/api/admin/evidence/${created.evidence.id}/status`, { method: 'POST', headers: ADMIN, body: JSON.stringify({ status: 'withdrawn' }) });
  await api('/api/admin/rules/2.0.0/activate', { method: 'POST', headers: ADMIN, body: JSON.stringify({}) });
  await api('/api/admin/jobs/process', { method: 'POST', headers: ADMIN });
  const snap = await (await fetch(base + `/api/exports/${snapId}`)).json();
  assert.equal(snap.rule_version, '1.0.0', '快照固定为导出时版本');
  const node = snap.snapshot.nodes.find((n) => n.node_id === h1.id);
  const ev = node.evidence.find((v) => v.title === '将要撤下但已入快照');
  assert.ok(ev && ev.active === true && ev.points > 0, '快照保留当时依据且仍有效');
  // 当前图中该证据已失效
  const current = await levelOf('h1');
  assert.ok(current.evidence.find((v) => v.title === '将要撤下但已入快照').active === false);
  // 回到 v1
  await api('/api/admin/rules/1.0.0/activate', { method: 'POST', headers: ADMIN, body: JSON.stringify({}) });
  await api('/api/admin/jobs/process', { method: 'POST', headers: ADMIN });
});

// 8) 三类信息分立、无总分暗示认证；门控给出路径而非统一标签
test('计划不计点、自评独立；门控阻塞附可定位路径', async () => {
  const g1 = await nodeApi('g1', 'G1 弱前置技能');
  const g2 = await nodeApi('g2', 'G2 目标技能');
  await edgeApi('g1', 'g2'); // hard 前置
  // g1 什么证据都没有
  // g2：大量直接成果 + 自评 + 计划
  await evApi({ kind: 'verifiable', title: '成果A', subtype: 'project', nodes: ['g2'] });
  await evApi({ kind: 'verifiable', title: '成果B', subtype: 'work', nodes: ['g2'] });
  await evApi({ kind: 'verifiable', title: '成果C', subtype: 'certificate', nodes: ['g2'] });
  await evApi({ kind: 'self', title: '自评很高', self_level: 3, self_confidence: 1, nodes: ['g2'] });
  await evApi({ kind: 'plan', title: '未来大计划', plan_target_level: 3, plan_target_on: '2028-01-01', nodes: ['g2'] });
  await engine.recomputeAndPersist();
  const d = await levelOf('g2');
  // 计划绝不出现在计点结构
  assert.ok(!('plan' in d.points), 'points 中不含 plan 字段');
  assert.ok(d.plans.length === 1 && d.plans[0].title === '未来大计划');
  assert.equal(d.self.bonus <= 1, true);
  // raw 可能 proven，但被硬前置门控封顶
  assert.equal(['foundational', 'applied', 'proven'].includes(d.raw_level), true);
  assert.equal(d.gated, true);
  assert.equal(d.level, 'applied', '门控封顶至 applied');
  assert.ok(d.blockers[0].path && d.blockers[0].path.includes(g1.id), '阻塞项必须携带可定位路径');
  assert.ok(d.blockers[0].title === 'G1 弱前置技能');
  // 明确声明非认证
  const pathApi = await api('/api/paths/g1/g2?kind=hard');
  assert.deepEqual(pathApi.body.shortest_titles, ['G1 弱前置技能', 'G2 目标技能']);
});

test('规则登记记录了模式选择与版本', () => {
  assert.equal(RULE_MAP['1.0.0'].mode, 'rule-driven-summary');
  assert.equal(RULE_MAP['2.0.0'].mode, 'rule-driven-summary');
  assert.ok(RULE_MAP['1.0.0'].notes.includes('共享节点不重复加分'));
});

test('到期清扫作业会自动标记过期证据并重算', async () => {
  const k = await nodeApi('k1', 'K1');
  const created = await evApi({
    kind: 'verifiable', title: '将到期证书', subtype: 'certificate',
    issued_on: '2024-01-01', expires_on: '2026-09-01', nodes: ['k1'],
  });
  // v1 规则下 active 即有效；手动跑清扫（v2 已在测试中切回 v1）
  const reports = engine.sweepExpiry({});
  assert.ok(reports.some((r) => r.evidence_id === created.evidence.id));
  assert.equal(repo.getEvidence(created.evidence.id).status, 'expired');
});
