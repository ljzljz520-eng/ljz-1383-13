'use strict';
/* 并发压力：多客户端同时提交成环/合法关系；结束后图必须仍为 DAG，且所有成环请求 422 */
const path = require('path');
const os = require('os');
const { openDb } = require('../src/db');
const { createApp } = require('../src/server');
const repo = require('../src/repository');
const dag = require('../src/dag');

const file = path.join(os.tmpdir(), `seg-conc-${Date.now()}.sqlite`);
process.env.SEG_DB = file; process.env.ADMIN_KEY = 'k'; process.env.SEG_ALLOW_CLOCK = '1';
openDb(file);

async function main() {
  const server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (body) => fetch(base + '/api/admin/edges', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-admin-key': 'k' }, body: JSON.stringify(body),
  }).then(async (r) => ({ status: r.status, body: await r.json() }));

  // 5 个节点
  const ids = [];
  for (let i = 0; i < 5; i++) {
    const r = await fetch(base + '/api/admin/nodes', { method: 'POST', headers: { 'content-type': 'application/json', 'x-admin-key': 'k' }, body: JSON.stringify({ slug: 'c' + i, title: 'C' + i }) });
    ids.push((await r.json()).node.id);
  }
  // 生成所有可能边，随机标记期望"尝试"；高并发发出
  const attempts = [];
  for (let i = 0; i < 5; i++) for (let j = 0; j < 5; j++) if (i !== j) attempts.push({ from: ids[i], to: ids[j] });
  // 打乱
  attempts.sort(() => Math.random() - 0.5);

  const BATCH = 12; // 12 个请求同时在途
  let accepted = 0, rejectedCycle = 0, rejectedDup = 0, other = 0;
  for (let i = 0; i < attempts.length; i += BATCH) {
    const slice = attempts.slice(i, i + BATCH);
    const rs = await Promise.all(slice.map((a) => post(a)));
    for (const r of rs) {
      if (r.status === 201) accepted++;
      else if (r.body.error === 'cycle_detected') rejectedCycle++;
      else if (r.body.error === 'duplicate_edge') rejectedDup++;
      else { other++; console.log('unexpected', r.status, r.body); }
    }
  }
  const graph = dag.buildGraph(repo.listNodes(), repo.listEdges());
  const cycles = dag.findCycles(graph);
  console.log({ accepted, rejectedCycle, rejectedDup, other, edgesInDb: repo.listEdges().length, hasCycle: cycles.length > 0 });
  server.close();
  if (cycles.length > 0 || other > 0) process.exit(1);
  if (accepted < 4) { console.error('too few accepted edges'); process.exit(1); }
  console.log('CONCURRENCY OK');
}
main().catch((e) => { console.error(e); process.exit(1); });
