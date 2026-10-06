'use strict';

// 验收测试：并发成环 / 一证据多技能去重 / 节点合并 / 规则升级迟到作业 /
// 部分证据私密 / 到期撤下沿图重算 / 历史导出冻结。

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { spawn } = require('node:child_process');

const PORT = 3210 + Math.floor(Math.random() * 200);
const TOKEN = 'test-token';
const BASE = 'http://127.0.0.1:' + PORT;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skillgraph-'));

let serverProc;
let started = false;

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function req(p, opts = {}) {
  return new Promise((resolve, reject) => {
    const body = opts.body ? JSON.stringify(opts.body) : null;
    const r = http.request(
      BASE + p,
      {
        method: opts.method || 'GET',
        headers: {
          'content-type': 'application/json',
          ...(opts.owner ? { 'x-owner-token': TOKEN } : {}),
          ...(body ? { 'content-length': Buffer.byteLength(body) } : {}),
        },
      },
      (res) => {
        let buf = '';
        res.on('data', (d) => (buf += d));
        res.on('end', () => {
          let json = null;
          try { json = JSON.parse(buf); } catch {}
          resolve({ status: res.statusCode, json, text: buf });
        });
      }
    );
    r.on('error', reject);
    if (body) r.write(body);
    r.end();
  });
}

test.before(async () => {
  serverProc = spawn(process.execPath, ['-e', `
    process.env.PORT='${PORT}'; process.env.OWNER_TOKEN='${TOKEN}';
    process.env.AUTO_WORKER='0'; process.env.DATA_DIR='${dataDir.replace(/\\/g, '\\\\')}';
    require('./src/server').start();
  `], { cwd: path.join(__dirname, '..') });
  const out = [];
  await new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => reject(new Error('server timeout: ' + out.join(''))), 10000);
    serverProc.stdout.on('data', (d) => {
      out.push(d.toString());
      if (out.join('').includes('技能证据图服务')) { clearTimeout(timer); resolvePromise(); }
    });
    serverProc.stderr.on('data', (d) => out.push(d.toString()));
    serverProc.on('exit', (code) => reject(new Error('server exited ' + code + ': ' + out.join(''))));
  });
  started = true;
});

test.after(() => {
  if (serverProc) serverProc.kill();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

async function runJobs() {
  const r = await req('/api/admin/maintenance/run-jobs', { method: 'POST', owner: true, body: {} });
  assert.equal(r.status, 200, 'run-jobs failed: ' + r.text);
  return r.json;
}

async function makeNode(title) {
  const r = await req('/api/admin/nodes', { method: 'POST', owner: true, body: { title } });
  assert.equal(r.status, 201, r.text);
  return r.json.id;
}

// ---------- 1. 并发添加"成环"关系：一个成功，另一个必须 409 ----------
test('并发成环：两条互相成环的边并发提交，恰有一条被拒绝并给出环路径', async () => {
  const a = await makeNode('A');
  const b = await makeNode('B');
  // 已有 a->b 后，再并发 b->a 与 a->b(重复) 无意义；
  // 真正并发场景：两条边各自单独都不成环，合在一起成环：
  // 边1 x->y, 边2 y->x（无前置时单独提交都不会立即成环，但两条并发时第二条必成环）
  const [r1, r2] = await Promise.all([
    req('/api/admin/edges', { method: 'POST', owner: true, body: { parentId: a, childId: b } }),
    req('/api/admin/edges', { method: 'POST', owner: true, body: { parentId: b, childId: a } }),
  ]);
  const statuses = [r1.status, r2.status].sort();
  assert.deepEqual(statuses, [201, 409], '应恰好一条成功一条 409，实际 ' + JSON.stringify([r1.status, r2.status]));
  const rejected = r1.status === 409 ? r1 : r2;
  assert.match(rejected.json.error, /环/);
  // 拒绝响应必须可定位环
  assert.ok(rejected.json.error.includes('→') || rejected.json.error.includes('->'), '环路径缺失');
  const g = (await req('/api/graph')).json;
  assert.equal(g.edges.length, 10, "只应有一条新边落库，实际 " + g.edges.length);
});

// ---------- 2. 一份证据支持多个技能 + 共享节点证据不重复加分 ----------
test('一证据多技能：同一证据沿多条依赖路径只计一次', async () => {
  const g0 = (await req('/api/graph')).json;
  const fs0 = g0.nodes.find((n) => n.nodeId === 'fullstack');
  // ev_oss 挂在 graphviz 和 node，两者都是 fullstack 的前置；
  // ev_cert_js 在 js（经 node、react、ts 多条路径到达 fullstack）。
  // 去重后 fullstack 的有效证据应为 4：ev_app、ev_oss、ev_cert_js、ev_private（私密计数）
  assert.equal(fs0.evidenceCount, 4, '共享证据被重复计数了: ' + fs0.evidenceCount);
  assert.equal(fs0.privateEvidenceCount, 1);

  // 再把同一份 ev_app 额外挂到 node（fullstack 既直接拥有又经 node 间接拥有），计数不应增加
  const before = fs0.evidenceCount;
  const link = await req('/api/admin/evidence/ev_app/link', { method: 'POST', owner: true, body: { nodeId: 'node' } });
  assert.equal(link.status, 200);
  await runJobs();
  const g1 = (await req('/api/graph')).json;
  const fs1 = g1.nodes.find((n) => n.nodeId === 'fullstack');
  assert.equal(fs1.evidenceCount, before, '多挂一次导致重复计数');
});

// ---------- 3. 公开页面绝不暴露私密证据标题 ----------
test('部分证据私密：公开视图无标题泄露，但计入数量与档位', async () => {
  const pub = (await req('/api/graph')).json;
  const text = JSON.stringify(pub);
  assert.ok(!text.includes('内部绩效评审记录'), '私密证据标题泄露到公开图！');
  const fs = pub.nodes.find((n) => n.nodeId === 'fullstack');
  const masked = fs.pathReport.find((p) => p.masked);
  assert.ok(masked, '缺少私密证据占位');
  assert.equal(masked.title, undefined, '占位对象带了标题');
  // 数量仍包含私密（4 条有效），档位仍为成果支撑
  assert.equal(fs.evidenceCount, 4);
  assert.match(fs.supportLevel, /verified/);
  // 详情接口同样不泄露
  const detail = (await req('/api/nodes/fullstack')).json;
  assert.ok(!JSON.stringify(detail).includes('内部绩效评审记录'));
  // 管理视图可见真实标题
  const admin = (await req('/api/graph', { owner: true })).json;
  assert.ok(JSON.stringify(admin).includes('内部绩效评审记录'), '管理视图应能看到私密标题');
  // 无令牌访问管理接口被拒
  assert.equal((await req('/api/admin/nodes', { method: 'POST', body: { title: 'x' } })).status, 401);
});

// ---------- 4. 证书到期 / 作品撤下：沿依赖图重算受影响节点，结果可定位 ----------
test('证据到期与撤下：受影响节点沿图重算，弱化原因带依赖路径', async () => {
  // ev_cert_js 在 js；撤下它应影响 js 的全部后代：ts,node,react,fullstack(+graphviz?)
  const r = await req('/api/admin/evidence/ev_cert_js/status', { method: 'POST', owner: true, body: { status: 'withdrawn' } });
  assert.equal(r.status, 200);
  const affected = r.json.affectedNodes;
  // js 本身 + 后代 ts,node,react,fullstack,graphviz（graphviz 经 node 到达）
  for (const must of ['js', 'ts', 'node', 'react', 'fullstack', 'graphviz']) {
    assert.ok(affected.includes(must), '传播缺少节点 ' + must + '，实际 ' + affected);
  }
  await runJobs();
  const g = (await req('/api/graph')).json;
  const fs = g.nodes.find((n) => n.nodeId === 'fullstack');
  // fullstack 弱化，且原因可定位到证据与路径（不是统一"证据不足"标签）
  assert.equal(fs.weakened, true);
  const reason = fs.weakenReasons.find((w) => (w.title || '').includes('JavaScript 高级程序认证'));
  assert.ok(reason, '弱化原因中缺少被撤下的证书');
  assert.equal(reason.reason, 'withdrawn');
  assert.ok(reason.attachedPathTitles.length >= 1, '缺少依赖路径定位');
  // supportLevel 仍可因 ev_app/ev_oss 保持成果支撑，但带弱化标记
  assert.match(fs.supportLevel, /verified/);
  // 恢复后该撤下原因消失（注意 node 上另有一条种子"已过期证书"，弱化标记本身可能仍在）
  await req('/api/admin/evidence/ev_cert_js/status', { method: 'POST', owner: true, body: { status: 'active' } });
  await runJobs();
  const g2 = (await req('/api/graph')).json;
  const fs2 = g2.nodes.find((n) => n.nodeId === 'fullstack');
  assert.ok(
    !fs2.weakenReasons.some((w) => (w.title || '').includes('JavaScript 高级程序认证')),
    '恢复后撤下原因仍残留'
  );

  // 节点详情给出具体重算说明而非统一标签
  const detail = (await req('/api/nodes/fullstack')).json;
  assert.ok(detail.recomputeNote && detail.recomputeNote.length > 0);
  assert.ok(detail.dependencyPaths.length > 0, '依赖路径为空');
});

// ---------- 5. 节点合并：边/证据迁移、去重、传播重算 ----------
test('节点合并：关系与证据迁移到目标，source 标记合并，图保持 DAG', async () => {
  // 合并 css -> js（css 的后继 react 会变成 js->react，但 js 已经是 react 的前置：重复边去重）
  const r = await req('/api/admin/nodes/merge', { method: 'POST', owner: true, body: { sourceId: 'css', targetId: 'js' } });
  assert.equal(r.status, 200, r.text);
  assert.ok(r.json.affectedNodes.includes('react'));
  assert.ok(r.json.affectedNodes.includes('fullstack'));
  await runJobs();
  const g = (await req('/api/graph')).json;
  assert.ok(!g.nodes.some((n) => n.nodeId === 'css'), '已合并节点仍出现在图中');
  // 不应产生重复边 js->react
  const dup = g.edges.filter((e) => e.from === 'js' && e.to === 'react');
  assert.equal(dup.length, 1, '合并产生了重复边');
  // 旧 id 访问返回 410 合并指引
  const gone = await req('/api/nodes/css');
  assert.equal(gone.status, 410);
  assert.equal(gone.json.mergedInto, 'js');

  // 会成环的合并被拒绝：把后代 fullstack 并入祖先 js：
  // fullstack 的父（node 等）与 js 之间已有 js→…→node 路径，重指 node→js 即成环
  const cyclic = await req('/api/admin/nodes/merge', { method: 'POST', owner: true, body: { sourceId: 'fullstack', targetId: 'js' } });
  assert.equal(cyclic.status, 409);
  assert.match(cyclic.json.error, /环/);
});

// ---------- 6. 规则升级 + 迟到作业 ----------
test('规则升级到 v2：全量重算，新档位含强度；迟到作业按入队版本 v1 执行并标注', async () => {
  // 6a. 入队一个延迟 1.5s 的 v1 重算
  const delayed = await req('/api/admin/recompute', {
    method: 'POST', owner: true,
    body: { delayMs: 1500, reason: '升级前排队的旧作业' },
  });
  assert.equal(delayed.status, 202);

  // 6b. 立即激活 v2 并立即执行（activate 作业无延迟，马上到期）
  const act = await req('/api/admin/rules/activate', { method: 'POST', owner: true, body: { version: '2.0.0', delayMs: 0 } });
  assert.equal(act.status, 202);
  const exec1 = await runJobs(); // 只执行 v2 激活；v1 重算尚未到期
  const activateReport = exec1.jobReports.find((j) => j.type === 'activate_ruleset');
  assert.ok(activateReport, '激活作业未执行');
  assert.equal(activateReport.late, false);

  const gv2 = (await req('/api/graph')).json;
  assert.equal(gv2.ruleVersion, '2.0.0');
  const fs = gv2.nodes.find((n) => n.nodeId === 'fullstack');
  assert.equal(fs.strength, 'strong', '带 URL 的证据应给 strong 强度');
  assert.match(fs.supportLevel, /verified_strong|verified/);

  // 6c. 等待迟到作业到期后执行：应按 v1 计算并被标记 late
  await sleep(1700);
  const exec2 = await runJobs();
  const lateReport = exec2.jobReports.find((j) => j.type === 'recompute');
  assert.ok(lateReport, '迟到重算作业未执行');
  assert.equal(lateReport.late, true, '迟到标记缺失');
  assert.equal(lateReport.jobVersion, '1.0.0');
  assert.equal(lateReport.currentVersion, '2.0.0');
  // 作业结果行记录了迟到
  const jobs = (await req('/api/admin/jobs', { owner: true })).json;
  const lateJob = jobs.find((j) => j.result && JSON.parse(j.result).late === true);
  assert.ok(lateJob, 'jobs 表未持久化迟到信息');
});

// ---------- 7. 历史导出冻结：之后撤下证据不改变快照 ----------
test('历史导出：快照保留当时依据，后续变更不回改；私密标题从不入快照', async () => {
  const exp = await req('/api/admin/exports', { method: 'POST', owner: true, body: { label: '验收冻结点' } });
  assert.equal(exp.status, 201);
  const id = exp.json.id;
  const before = (await req('/api/exports/' + id)).json;
  const beforeFs = before.snapshot.nodes.find((n) => n.nodeId === 'fullstack');
  const countAtFreeze = beforeFs.evidenceCount;
  assert.ok(!JSON.stringify(before).includes('内部绩效评审记录'), '导出快照混入私密标题');

  // 撤下 ev_app，再重算当前图
  await req('/api/admin/evidence/ev_app/status', { method: 'POST', owner: true, body: { status: 'withdrawn' } });
  await runJobs();
  const nowGraph = (await req('/api/graph')).json;
  const nowFs = nowGraph.nodes.find((n) => n.nodeId === 'fullstack');
  assert.notEqual(nowFs.evidenceCount, countAtFreeze, '当前图理应发生变化以形成对照');

  // 历史快照保持冻结时的值
  const after = (await req('/api/exports/' + id)).json;
  const afterFs = after.snapshot.nodes.find((n) => n.nodeId === 'fullstack');
  assert.equal(afterFs.evidenceCount, countAtFreeze, '历史导出被后续变更回改');
  assert.equal(after.snapshot.frozen, true);
});

// ---------- 8. 政策接口记录方案选择与规则版本 ----------
test('规则决策可追溯：记录 rule_driven 选择、不做总分声明与各版本规则', async () => {
  const p = (await req('/api/meta/policy')).json;
  assert.equal(p.decision, 'rule_driven');
  assert.match(p.noScoreStatement, /不存在综合技能分数/);
  const approaches = p.versions.map((v) => v.approach);
  assert.ok(approaches.includes('evidence_only'), '应保留 evidence_only 对照方案记录');
  const v2 = p.versions.find((v) => v.version === '2.0.0');
  assert.ok(v2.spec.doc && v2.spec.doc.length >= 3, '规则文本缺失');
  assert.equal(v2.active, true);
});
