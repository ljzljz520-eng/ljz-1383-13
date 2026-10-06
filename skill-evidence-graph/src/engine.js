'use strict';
const repo = require('./repository');
const { RULE_MAP } = require('../rules/registry');
const { buildGraph, topoOrder, affectedDownstream, shortestPath } = require('./dag');
const { stableJson, sha1, LEVEL_INDEX, LEVELS } = require('./util');
const clock = require('./clock');

/** 证据当前是否有效（结构状态 + 规则下的到期判定） */
function isActive(ev, spec, at = clock.now()) {
  if (ev.status !== 'active') return { active: false, reason: ev.status };
  if (spec.expiryAware && ev.expires_on && new Date(ev.expires_on).getTime() <= at.getTime()) {
    return { active: false, reason: 'expired' };
  }
  return { active: true };
}

/** 公开页面可见：非私密（且结构状态 active；到期与否由规则决定，标题始终不暴露私密证据） */
function visiblePublic(ev) { return !ev.private; }

function levelForPoints(points, spec) {
  for (const t of spec.thresholds) if (points >= t.min) return t.level;
  return 'none';
}

/**
 * 全图评估。scope: 'owner'（含私密证据）| 'public'（私密证据整体剔除，标题不参与任何输出）
 * 返回 Map<nodeId, result>
 */
function evaluateGraph({ ruleVersion = repo.activeRuleVersion(), scope = 'public', at = clock.now() } = {}) {
  const spec = RULE_MAP[ruleVersion];
  if (!spec) throw new Error(`未知规则版本 ${ruleVersion}`);

  const nodes = repo.listNodes();
  const edges = repo.listEdges();
  const graph = buildGraph(nodes, edges);
  const order = topoOrder(graph) || [...graph.nodes.keys()];

  const allEvidence = repo.listEvidence();
  const links = repo.listLinks();
  const linksByNode = new Map();
  for (const l of links) {
    if (!linksByNode.has(l.node_id)) linksByNode.set(l.node_id, []);
    linksByNode.get(l.node_id).push(l.evidence_id);
  }
  const evById = new Map(allEvidence.map((e) => [e.id, e]));

  // 作用域过滤：公开作用域在计算开始前整体剔除私密证据（标题永不进入结果）
  function scopedEvidence(evId) {
    const ev = evById.get(evId);
    if (!ev) return null;
    if (scope === 'public' && ev.private) return null;
    return ev;
  }

  // 新鲜度因子（v2）
  function freshness(ev) {
    if (!spec.expiryAware || !ev.issued_on) return 1;
    const ageDays = (at.getTime() - new Date(ev.issued_on).getTime()) / 86400000;
    return ageDays > spec.weights.freshnessDays ? spec.weights.freshnessFactor : 1;
  }
  // 到期衰减（v2：到期前 grace 窗口内线性衰减；到期即失活）
  function expiryFactor(ev) {
    if (!spec.expiryAware || ev.kind !== 'verifiable' || !ev.expires_on) return 1;
    const daysLeft = (new Date(ev.expires_on).getTime() - at.getTime()) / 86400000;
    if (daysLeft <= 0) return 0;
    if (daysLeft >= spec.weights.expiryGraceDays) return 1;
    return Math.max(0.5, daysLeft / spec.weights.expiryGraceDays);
  }

  function verifiablePoints(ev, inherited) {
    const base = spec.weights.verifiable[ev.subtype] ?? spec.weights.verifiable.other;
    let pts = base * freshness(ev) * expiryFactor(ev);
    if (inherited) pts *= spec.prereq.inheritedMultiplier;
    return pts;
  }

  const results = new Map();

  for (const nodeId of order) {
    // 1) 本节点直接证据
    const directIds = (linksByNode.get(nodeId) || []).map(scopedEvidence).filter(Boolean);
    const usedEvidence = new Map(); // evidence_id -> 贡献条目（去重关键：同一证据对同一节点只计一次）
    let directVerifiablePoints = 0;
    const breakdown = [];

    for (const ev of directIds) {
      const state = isActive(ev, spec, at);
      if (ev.kind === 'verifiable') {
        if (state.active) {
          const pts = verifiablePoints(ev, false);
          directVerifiablePoints += pts;
          const item = {
            evidence_id: ev.id, kind: ev.kind, title: ev.title, subtype: ev.subtype,
            issuer: ev.issuer, url: ev.url, private: !!ev.private, points: r1(pts),
            inherited: false, active: true,
          };
          usedEvidence.set(ev.id, item);
          breakdown.push(item);
        } else {
          breakdown.push({ evidence_id: ev.id, kind: ev.kind, title: ev.title, subtype: ev.subtype,
            private: !!ev.private, points: 0, inherited: false, active: false, inactive_reason: state.reason });
        }
      }
    }

    // 2) 沿硬前置继承（DAG 分层 BFS：每个证据在每个节点只计一次 -> 共享节点不重复加分）
    const hardInEdges = (graph.into.get(nodeId) || []).filter((e) => spec.prereq.inheritKinds.includes(e.kind));
    const bfs = hardInEdges.map((e) => ({ nid: e.from_node, depth: 1, via: [e.from_node, nodeId] }));
    const seen = new Set(hardInEdges.map((e) => e.from_node));
    let inheritedPoints = 0;
    while (bfs.length) {
      const { nid, depth, via } = bfs.shift();
      for (const eid of linksByNode.get(nid) || []) {
        const ev = scopedEvidence(eid);
        if (!ev || ev.kind !== 'verifiable') continue;
        if (usedEvidence.has(ev.id)) continue;          // 去重：多父/共享前置
        const state = isActive(ev, spec, at);
        const pts = state.active ? verifiablePoints(ev, true) : 0;
        inheritedPoints += pts;
        const item = {
          evidence_id: ev.id, kind: ev.kind, title: ev.title, subtype: ev.subtype,
          issuer: ev.issuer, url: ev.url, private: !!ev.private, points: r1(pts),
          inherited: true, inherited_from: nid, depth, path: via.slice(),
          active: state.active, inactive_reason: state.active ? undefined : state.reason,
        };
        usedEvidence.set(ev.id, item);
        breakdown.push(item);
      }
      for (const e of graph.into.get(nid) || []) {
        if (!spec.prereq.inheritKinds.includes(e.kind)) continue;
        if (seen.has(e.from_node)) continue;
        seen.add(e.from_node);
        bfs.push({ nid: e.from_node, depth: depth + 1, via: [e.from_node, ...via] });
      }
    }

    // 3) 自评分（独立信号；v2 要求有 2 点直接可验证成果垫底）
    const selfEv = directIds.find((e) => e.kind === 'self');
    let selfBonus = 0;
    let selfSignal = null;
    if (selfEv && isActive(selfEv, spec, at).active) {
      let allowed = true;
      if (spec.weights.selfRequiresDirectVerifiablePoints &&
          directVerifiablePoints < spec.weights.selfRequiresDirectVerifiablePoints) allowed = false;
      selfBonus = allowed ? Math.min(spec.weights.selfMaxBonus,
        spec.weights.selfBonus(selfEv.self_level, selfEv.self_confidence)) : 0;
      selfSignal = {
        evidence_id: selfEv.id, title: selfEv.title, private: !!selfEv.private,
        claimed_level: LEVELS[selfEv.self_level] ?? null,
        confidence: selfEv.self_confidence, bonus: selfBonus, counted: allowed,
        note: allowed ? null : 'v2：缺少足够的直接可验证成果垫底，自评分暂不加成',
      };
    }

    // 4) 计划目标（只展示，永不计点）
    const plans = directIds.filter((e) => e.kind === 'plan').map((e) => ({
      evidence_id: e.id, title: e.title, private: !!e.private,
      target_level: LEVELS[e.plan_target_level] ?? null, target_on: e.plan_target_on,
      url: e.url, active: isActive(e, spec, at).active,
    }));

    // 5) 前置门控（仅硬前置必须达到 applied/3点；弱前置只提示缺口）
    const blockers = [];
    const gaps = [];
    for (const e of graph.into.get(nodeId) || []) {
      const pr = results.get(e.from_node);
      if (!pr) continue;
      if (e.kind === 'hard') {
        const satisfied = pr.raw_points >= spec.prereq.minGatePoints
          && LEVEL_INDEX[pr.raw_level] >= LEVEL_INDEX[spec.prereq.minGateLevel];
        if (!satisfied) {
          blockers.push({
            node_id: e.from_node, title: graph.nodes.get(e.from_node).title,
            level: pr.raw_level, points: r2(pr.raw_points), edge: e.kind,
            required_level: spec.prereq.minGateLevel, required_points: spec.prereq.minGatePoints,
            path: shortestPath(graph, e.from_node, nodeId, ['hard']),
          });
        }
      } else if (spec.prereq.weakShowsGapOnly !== false) {
        const ok = LEVEL_INDEX[pr.rawLevel] >= LEVEL_INDEX[spec.prereq.minGateLevel];
        if (!ok) gaps.push({ node_id: e.from_node, title: graph.nodes.get(e.from_node).title,
          level: pr.raw_level, points: r2(pr.raw_points), edge: 'weak' });
      }
    }

    const rawPoints = directVerifiablePoints + inheritedPoints + selfBonus;
    const rawLevel = levelForPoints(rawPoints, spec);
    const gated = blockers.length > 0;
    let level = rawLevel;
    if (gated && LEVEL_INDEX[rawLevel] > LEVEL_INDEX[spec.prereq.minGateLevel]) {
      level = spec.prereq.minGateLevel; // 门控封顶
    }

    const node = graph.nodes.get(nodeId);
    const result = {
      node_id: nodeId,
      slug: node.slug,
      title: node.title,
      rule_version: ruleVersion,
      scope,
      points: {
        direct_verifiable: r2(directVerifiablePoints),
        inherited_verifiable: r2(inheritedPoints),
        self_bonus: selfBonus,
        // 明确：plan 不出现于计点结构
        total: r2(rawPoints),
      },
      raw_points: r2(rawPoints),
      raw_level: rawLevel,
      level,
      gated,
      prerequisite_status: gated ? 'blocked' : (gaps.length ? 'gap_warning' : 'satisfied'),
      blockers,
      gaps,
      evidence: breakdown,
      self: selfSignal,
      plans,
      private_count: scope === 'owner' ? breakdown.filter((b) => b.private).length : 0,
      computed_at: clock.nowIso(),
    };
    result.evidence_fingerprint = fingerprint(result);
    results.set(nodeId, result);
  }
  return { graph, results };
}

function r1(x) { return Math.round(x * 10) / 10; }
function r2(x) { return Math.round(x * 100) / 100; }

function fingerprint(result) {
  const basis = {
    v: result.rule_version,
    scope: result.scope,
    p: result.points,
    lvl: result.raw_level,
    gated: result.gated,
    blockers: result.blockers.map((b) => [b.node_id, b.level, b.points]),
    ev: result.evidence
      .filter((e) => e.active !== false)
      .map((e) => [e.evidence_id, e.points, e.inherited_from || null, !!e.private]),
    self: result.self ? [result.self.evidence_id, result.self.bonus, result.self.counted] : null,
  };
  return sha1(stableJson(basis));
}

/** 持久化全部节点两个作用域的评估，返回 Map（owner 结果用于内部 diff，public 用于展示） */
function recomputeAndPersist({ ruleVersion = repo.activeRuleVersion(), nodeIds = null, at = clock.now() } = {}) {
  const target = nodeIds ? new Set(nodeIds) : null;
  const changed = [];
  for (const scope of ['owner', 'public']) {
    const { results } = evaluateGraph({ ruleVersion, scope, at });
    for (const [nid, res] of results) {
      if (target && !target.has(nid)) continue;
      const prev = repo.getEvaluation(nid, ruleVersion, scope);
      const rec = {
        node_id: nid, rule_version: ruleVersion, scope,
        level: res.level, points: res.points, evidence_breakdown: res.evidence,
        prereq: res.prerequisite_status, blockers: res.blockers,
        fingerprint: res.evidence_fingerprint, computed_at: clock.nowIso(),
      };
      repo.saveEvaluation(rec);
      if (scope === 'owner' && (!prev || prev.evidence_fingerprint !== res.evidence_fingerprint || prev.level !== res.level)) {
        changed.push({
          node_id: nid,
          before: prev ? { level: prev.level, fingerprint: prev.evidence_fingerprint } : null,
          after: { level: res.level, fingerprint: res.evidence_fingerprint,
            raw_level: res.raw_level, raw_points: res.raw_points,
            prerequisite_status: res.prerequisite_status, blockers: res.blockers, gaps: res.gaps },
        });
      }
    }
  }
  return changed;
}

/** 单节点沿依赖图的受影响重算（证书到期/作品撤下/合并/链接变更） */
function reevaluateFrom(triggerNodeId, { trigger, causeRef = null, jobId = null, late = false, at = clock.now() } = {}) {
  const version = repo.activeRuleVersion();
  const nodes = repo.listNodes();
  const edges = repo.listEdges();
  const graph = buildGraph(nodes, edges);
  const affected = affectedDownstream(graph, triggerNodeId, null);
  const changes = recomputeAndPersist({ ruleVersion: version, nodeIds: affected, at });
  const rec = repo.saveReevaluation({
    trigger, cause_ref: causeRef, rule_version: version, scope: 'public+owner',
    job_id: jobId, changes, late,
  });
  return { reevaluation_id: rec.id, trigger, trigger_node: triggerNodeId, affected, changes, late, rule_version: version };
}

/** 全图重算（规则升级作业）；若作业请求的规则版本已不是当前版本 -> 标记 stale，不覆盖 */
function fullRecompute({ jobId = null, requestedVersion = null, late = false, at = clock.now() } = {}) {
  const current = repo.activeRuleVersion();
  if (requestedVersion && requestedVersion !== current) {
    return { stale: true, job_id: jobId, requested: requestedVersion, current,
      note: '作业针对的旧规则版本已被升级取代，结果丢弃（迟到作业）' };
  }
  const changes = recomputeAndPersist({ ruleVersion: current, at });
  const rec = repo.saveReevaluation({
    trigger: 'rule_upgrade', cause_ref: current, rule_version: current, scope: 'public+owner',
    job_id: jobId, changes, late,
  });
  return { stale: false, reevaluation_id: rec.id, changes, late, rule_version: current };
}

/** 自动把已过 expires_on 但仍 active 的证书标记 expired，并触发逐节点重算（用于定时作业） */
function sweepExpiry({ at = clock.now(), late = false, jobId = null } = {}) {
  const due = repo.listEvidence().filter((e) =>
    e.kind === 'verifiable' && e.status === 'active' && e.expires_on &&
    new Date(e.expires_on).getTime() <= at.getTime());
  const reports = [];
  for (const ev of due) {
    repo.setEvidenceStatus(ev.id, 'expired');
    const nodeIds = [...new Set(repo.listLinks().filter((l) => l.evidence_id === ev.id).map((l) => l.node_id))];
    const changed = [];
    for (const nid of nodeIds) {
      changed.push(reevaluateFrom(nid, { trigger: 'evidence_expired', causeRef: ev.id, jobId, late, at }));
    }
    reports.push({ evidence_id: ev.id, title: ev.title, nodes: nodeIds, reports: changed });
  }
  return reports;
}

module.exports = {
  evaluateGraph, recomputeAndPersist, reevaluateFrom, fullRecompute, sweepExpiry,
  isActive, fingerprint,
};
