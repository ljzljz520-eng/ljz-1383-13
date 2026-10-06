'use strict';

// 有向依赖图算法。边方向：parent(前置) -> child(后置)。
const { all, get } = require('./db');

function activeNodes() {
  return all(`SELECT * FROM nodes WHERE merged_into IS NULL ORDER BY created_at, id`);
}

// 邻接表（含已合并节点，合并算法内部需要）
function buildAdj() {
  const nodes = all(`SELECT id, merged_into FROM nodes`);
  const edges = all(`SELECT id, parent_id, child_id FROM edges`);
  const fwd = new Map(); // parent -> children
  const rev = new Map(); // child -> parents
  for (const n of nodes) {
    fwd.set(n.id, new Set());
    rev.set(n.id, new Set());
  }
  for (const e of edges) {
    fwd.get(e.parent_id)?.add(e.child_id);
    rev.get(e.child_id)?.add(e.parent_id);
  }
  return { nodes, edges, fwd, rev };
}

// 沿 merged_into 链找到最终存活节点
function resolveTarget(nodeId) {
  const seen = new Set();
  let cur = nodeId;
  while (true) {
    const row = get(`SELECT merged_into FROM nodes WHERE id = ?`, [cur]);
    if (!row || !row.merged_into) return row ? cur : null;
    if (seen.has(cur)) return cur;
    seen.add(cur);
    cur = row.merged_into;
  }
}

// 环检测：若加入 parent->child 会成环，返回环上的节点路径（含具体定位），否则 null。
// 检查方式：child 若已是 parent 的（传递）前置，则成环。
function cyclePathIfAdded(parentId, childId, fwd) {
  if (parentId === childId) return [parentId, childId];
  // 从 child 沿 fwd（child 是 ... 的前置）走，若能到 parent，则路径 child -> ... -> parent，
  // 加上新边 parent -> child 构成环。
  const MAX = 500;
  const stack = [[childId, [childId]]];
  const seen = new Set();
  while (stack.length) {
    const [node, path] = stack.pop();
    if (seen.has(node)) continue;
    seen.add(node);
    if (path.length > MAX) continue;
    for (const next of fwd.get(node) || []) {
      const np = path.concat(next);
      if (next === parentId) return np.concat(childId); // 环闭合：... -> parent -> child
      stack.push([next, np]);
    }
  }
  return null;
}

// 后代（传递后继）：节点变化后需要重算的集合
function descendants(rootIds, fwd) {
  const out = new Set();
  const q = [...rootIds];
  const seen = new Set();
  while (q.length) {
    const n = q.shift();
    for (const c of fwd.get(n) || []) {
      if (!seen.has(c)) {
        seen.add(c);
        out.add(c);
        q.push(c);
      }
    }
  }
  return out;
}

const MAX_PATHS = 24;
const MAX_DEPTH = 14;

// 从 start 到所有可达（传递）前置的简单路径（沿 rev 上行）。
// 返回 Map<ancestorId, number[][]>，自身记为 []（节点自身的证据路径为"直接支持"）。
function ancestorPaths(startId, rev) {
  const paths = new Map();
  paths.set(startId, [[]]);
  function dfs(node, trail, seen) {
    if (trail.length >= MAX_DEPTH) return;
    for (const p of rev.get(node) || []) {
      if (seen.has(p)) continue; // 简单路径，防环（正常图无环，这是防御）
      const route = [p].concat(trail); // 从前置到 start 的顺序
      if (!paths.has(p)) paths.set(p, []);
      const arr = paths.get(p);
      if (arr.length < MAX_PATHS) arr.push(route);
      const seen2 = new Set(seen);
      seen2.add(p);
      dfs(p, route, seen2);
    }
  }
  dfs(startId, [], new Set([startId]));
  return paths;
}

module.exports = {
  activeNodes,
  buildAdj,
  resolveTarget,
  cyclePathIfAdded,
  descendants,
  ancestorPaths,
};
