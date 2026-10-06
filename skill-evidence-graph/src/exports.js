'use strict';
const repo = require('./repository');
const engine = require('./engine');
const { stableJson, sha1 } = require('./util');
const clock = require('./clock');

/**
 * 不可变历史图导出：冻结当时的规则版本、节点结论与「当时依据」。
 * 之后证书到期/作品撤下/规则升级都不会改变该快照。
 */
function exportGraph(title = `导出 @ ${clock.nowIso()}`) {
  const version = repo.activeRuleVersion();
  const { graph, results } = engine.evaluateGraph({ ruleVersion: version, scope: 'public' });
  const snapshotNodes = [...results.values()].map((r) => ({
    node_id: r.node_id, slug: r.slug, title: r.title,
    level: r.level, raw_level: r.raw_level, points: r.points,
    prerequisite_status: r.prerequisite_status,
    blockers: r.blockers, gaps: r.gaps,
    self: r.self ? { claimed_level: r.self.claimed_level, confidence: r.self.confidence } : null,
    plans: r.plans.map((p) => ({ title: p.title, target_level: p.target_level, target_on: p.target_on })),
    evidence: r.evidence.map((e) => ({
      evidence_id: e.evidence_id, title: e.title, kind: e.kind, subtype: e.subtype,
      points: e.points, active: e.active !== false, inactive_reason: e.inactive_reason || null,
      inherited: e.inherited, inherited_from: e.inherited_from || null, path: e.path || null,
      issuer: e.issuer || null, url: e.url || null,
    })),
  }));
  const edges = repo.listEdges()
    .filter((e) => graph.nodes.has(e.from_node) && graph.nodes.has(e.to_node))
    .map((e) => ({ from: e.from_node, to: e.to_node, kind: e.kind }));
  const snapshot = {
    exported_at: clock.nowIso(), rule_version: version, mode: 'rule-driven-summary',
    nodes: snapshotNodes, edges,
  };
  const fp = sha1(stableJson(snapshot));
  return repo.saveExport({ title, rule_version: version, fingerprint: fp, snapshot });
}

function loadExport(idOrFp) {
  const row = repo.getExport(idOrFp);
  return row ? { ...row, snapshot: JSON.parse(row.snapshot_json) } : null;
}

module.exports = { exportGraph, loadExport };
