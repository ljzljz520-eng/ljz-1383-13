'use strict';

// 节点合并：source 并入 target。
// - 边重指并去重（保持 DAG：若重指会成环则拒绝并给出路径）
// - 证据/自评/计划挂接关系迁移到 target
// - source 标记 merged_into，不物理删除（历史可追溯）
// - 合并传播：target 及其全部后代重算

const { get, run, all, flush, audit, genId } = require('./db');
const graph = require('./graph');
const rules = require('./rules');
const worker = require('./worker');

function mergeNodes(sourceId, targetId, opts = {}) {
  if (sourceId === targetId) throw httpErr(400, '不能合并到自身');
  const source = get(`SELECT * FROM nodes WHERE id=?`, [sourceId]);
  const target = get(`SELECT * FROM nodes WHERE id=?`, [targetId]);
  if (!source || !target) throw httpErr(404, '节点不存在');
  if (source.merged_into || target.merged_into) throw httpErr(400, '请使用未合并的存活节点');

  const { fwd, rev } = graph.buildAdj();
  // 模拟重指后的环检测：
  // 1) source 的前置 p 改为指向 target：若 target 是 p 的传递后继的"反向"……
  //    新边 p->target 成环条件：target 能沿 fwd 到达 p（且 p != target）。
  // 2) source 的后继 c：新边 target->c 成环条件：c 能沿 fwd 到达 target。
  const sourceParents = [...(rev.get(sourceId) || [])].filter((p) => p !== targetId);
  const sourceChildren = [...(fwd.get(sourceId) || [])].filter((c) => c !== targetId);

  const targetExistingParents = new Set(rev.get(targetId) || []);
  const targetExistingChildren = new Set(fwd.get(targetId) || []);

  for (const p of sourceParents) {
    if (targetExistingParents.has(p)) continue; // 重指后是重复边，去重即可
    const cyc = graph.cyclePathIfAdded(p, targetId, fwd);
    if (cyc) throw httpErr(409, `合并会成环：${p} → ${targetId}，环路径 ${cyc.join(' → ')}`);
  }
  for (const c of sourceChildren) {
    if (targetExistingChildren.has(c)) continue;
    const cyc = graph.cyclePathIfAdded(targetId, c, fwd);
    if (cyc) throw httpErr(409, `合并会成环：${targetId} → ${c}，环路径 ${cyc.join(' → ')}`);
  }

  const now = opts.now || Date.now();

  // 迁移边：删旧边，按目标去重建新边
  run(`DELETE FROM edges WHERE parent_id=? OR child_id=?`, [sourceId, sourceId]);
  const edgeSet = new Set();
  for (const row of all(`SELECT parent_id, child_id FROM edges`)) edgeSet.add(row.parent_id + '|' + row.child_id);
  const addEdge = (p, c) => {
    const key = p + '|' + c;
    if (p === c || edgeSet.has(key)) return;
    edgeSet.add(key);
    run(`INSERT INTO edges (id,parent_id,child_id,created_at) VALUES (?,?,?,?)`, [genId('edge'), p, c, now]);
  };
  for (const p of sourceParents) addEdge(p, targetId);
  for (const c of sourceChildren) addEdge(targetId, c);

  // 迁移证据挂接（多对多去重由主键保证）
  const links = all(`SELECT evidence_id FROM evidence_nodes WHERE node_id=?`, [sourceId]);
  for (const l of links) {
    run(`INSERT OR IGNORE INTO evidence_nodes (evidence_id,node_id,created_at) VALUES (?,?,?)`, [l.evidence_id, targetId, now]);
  }
  run(`DELETE FROM evidence_nodes WHERE node_id=?`, [sourceId]);

  // 自评、计划迁移
  run(`UPDATE self_ratings SET node_id=? WHERE node_id=?`, [targetId, sourceId]);
  run(`UPDATE plans SET node_id=? WHERE node_id=?`, [targetId, sourceId]);
  // 旧评估结果保留（作为历史），不迁移到 target 行，因为主键不同。
  run(`UPDATE nodes SET merged_into=? WHERE id=?`, [targetId, sourceId]);

  audit('node.merge', 'node', sourceId, { into: targetId });

  // 传播重算：target 及后代（source 的后代已通过边重指进入 target 后代集合）
  const affected = worker.propagationSet([targetId]);
  const version = opts.version || rules.activeRuleVersion();
  const jobId = worker.enqueueRecompute(affected, version, { now, reason: `节点 ${sourceId} 合并入 ${targetId}` });
  flush();
  return { sourceId, targetId, affectedNodes: affected, recomputeJobId: jobId };
}

function httpErr(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

module.exports = { mergeNodes };
