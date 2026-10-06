'use strict';
/*
 * 有向依赖图工具（允许多父节点，因此是 DAG 而非树）
 * 边方向： from_node = 前置(prerequisite) -> to_node = 依赖方(dependent)
 */

function buildGraph(nodes, edges, { includeMerged = false } = {}) {
  const activeNodes = new Map();
  for (const n of nodes) {
    if (!includeMerged && n.status === 'merged') continue;
    activeNodes.set(n.id, n);
  }
  const nodeIds = new Set(activeNodes.keys());
  const out = new Map(); // prereq -> [{to, kind, id}]
  const into = new Map(); // node -> [{from, kind, id}]
  for (const id of nodeIds) { out.set(id, []); into.set(id, []); }
  for (const e of edges) {
    if (!nodeIds.has(e.from_node) || !nodeIds.has(e.to_node)) continue;
    out.get(e.from_node).push(e);
    into.get(e.to_node).push(e);
  }
  return { nodes: activeNodes, out, into };
}

/** 从 start 沿 out 边是否能到达 target（BFS） */
function reaches(graph, start, target, kinds = null) {
  if (start === target) return true;
  const seen = new Set([start]);
  const queue = [start];
  while (queue.length) {
    const cur = queue.shift();
    for (const e of graph.out.get(cur) || []) {
      if (kinds && !kinds.includes(e.kind)) continue;
      if (e.to_node === target) return true;
      if (!seen.has(e.to_node)) { seen.add(e.to_node); queue.push(e.to_node); }
    }
  }
  return false;
}

/** 新增边 from->to 是否成环：to 已能沿依赖方向到达 from */
function wouldCycle(graph, from, to) {
  if (from === to) return true;
  return reaches(graph, to, from);
}

/** 现有图中环检测（返回一组环上的节点；空数组=无环） */
function findCycles(graph) {
  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Map([...graph.nodes.keys()].map((id) => [id, WHITE]));
  const stack = [];
  let cycleNodes = [];
  function dfs(u) {
    color.set(u, GRAY); stack.push(u);
    for (const e of graph.out.get(u) || []) {
      const v = e.to_node;
      if (color.get(v) === GRAY) {
        const idx = stack.indexOf(v);
        cycleNodes = stack.slice(idx).concat(v);
        return true;
      }
      if (color.get(v) === WHITE && dfs(v)) return true;
    }
    stack.pop(); color.set(u, BLACK);
    return false;
  }
  for (const id of graph.nodes.keys()) {
    if (color.get(id) === WHITE && dfs(id)) return cycleNodes;
  }
  return [];
}

/** BFS 最短依赖路径 from -> to；返回节点 id 数组或 null。kinds 过滤边类型 */
function shortestPath(graph, from, to, kinds = null) {
  if (from === to) return [from];
  const prev = new Map([[from, null]]);
  const queue = [from];
  while (queue.length) {
    const cur = queue.shift();
    for (const e of graph.out.get(cur) || []) {
      if (kinds && !kinds.includes(e.kind)) continue;
      if (!prev.has(e.to_node)) {
        prev.set(e.to_node, cur);
        if (e.to_node === to) {
          const path = [to];
          let p = cur;
          while (p != null) { path.unshift(p); p = prev.get(p); }
          return path;
        }
        queue.push(e.to_node);
      }
    }
  }
  return null;
}

/** 所有从 from 到 to 的简单路径（用于可定位的依赖路径，限制条数防爆） */
function allPaths(graph, from, to, kinds = null, limit = 20) {
  const results = [];
  (function dfs(node, trail, seen) {
    if (results.length >= limit) return;
    if (node === to) { results.push(trail.slice()); return; }
    for (const e of graph.out.get(node) || []) {
      if (kinds && !kinds.includes(e.kind)) continue;
      if (seen.has(e.to_node)) continue;
      seen.add(e.to_node); trail.push(e.to_node);
      dfs(e.to_node, trail, seen);
      trail.pop(); seen.delete(e.to_node);
    }
  })(from, [from], new Set([from]));
  return results;
}

/** 受影响集合：某节点变化后，沿 out（依赖它的下游）传播，含自身 */
function affectedDownstream(graph, nodeId, kinds = null) {
  const order = [];
  const seen = new Set([nodeId]);
  const queue = [nodeId];
  while (queue.length) {
    const cur = queue.shift();
    order.push(cur);
    for (const e of graph.out.get(cur) || []) {
      if (kinds && !kinds.includes(e.kind)) continue;
      if (!seen.has(e.to_node)) { seen.add(e.to_node); queue.push(e.to_node); }
    }
  }
  return order;
}

/** Kahn 拓扑序（前置在前）；有环时返回 null */
function topoOrder(graph) {
  const indeg = new Map([...graph.nodes.keys()].map((id) => [id, (graph.into.get(id) || []).length]));
  const queue = [...indeg.entries()].filter(([, d]) => d === 0).map(([id]) => id);
  const order = [];
  while (queue.length) {
    const u = queue.shift(); order.push(u);
    for (const e of graph.out.get(u) || []) {
      indeg.set(e.to_node, indeg.get(e.to_node) - 1);
      if (indeg.get(e.to_node) === 0) queue.push(e.to_node);
    }
  }
  return order.length === graph.nodes.size ? order : null;
}

/** 最长路径层数（桌面分层布局） */
function layers(graph) {
  const order = topoOrder(graph);
  if (!order) return { order: [...graph.nodes.keys()], rank: new Map() };
  const rank = new Map();
  for (const id of order) {
    let r = 0;
    for (const e of graph.into.get(id) || []) r = Math.max(r, (rank.get(e.from_node) ?? 0) + 1);
    rank.set(id, r);
  }
  return { order, rank };
}

/** 从根到 node 的前置路径（含边类型），用于定位缺口 */
function prerequisiteChains(graph, nodeId, limit = 10) {
  const results = [];
  (function dfs(cur, trailEdges, trailNodes, seen) {
    if (results.length >= limit) return;
    const prereqs = graph.into.get(cur) || [];
    if (prereqs.length === 0) { results.push({ nodes: trailNodes.slice(), edges: trailEdges.slice() }); return; }
    for (const e of prereqs) {
      if (seen.has(e.from_node)) continue;
      seen.add(e.from_node); trailEdges.push(e); trailNodes.unshift(e.from_node);
      dfs(e.from_node, trailEdges, trailNodes, seen);
      trailNodes.shift(); trailEdges.pop(); seen.delete(e.from_node);
    }
  })(nodeId, [], [nodeId], new Set([nodeId]));
  return results;
}

module.exports = {
  buildGraph, reaches, wouldCycle, findCycles, shortestPath, allPaths,
  affectedDownstream, topoOrder, layers, prerequisiteChains,
};
