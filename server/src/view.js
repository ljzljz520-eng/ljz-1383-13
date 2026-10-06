'use strict';

// 视图序列化：公开视图对私密证据/自评/计划做脱敏。
// 规则：私密证据照常参与计数与档位判定，但公开数据里绝不返回标题、链接等可识别内容，
// 只以占位符表示"此处存在 N 条私密证据"。

const { all, get } = require('./db');
const rules = require('./rules');

function privateEvidenceIds() {
  const rows = all(`SELECT id FROM evidence WHERE is_public = 0`);
  return new Set(rows.map((r) => r.id));
}

function maskEvidenceList(list, privSet) {
  let hidden = 0;
  const out = [];
  for (const e of list || []) {
    if (privSet.has(e.evidenceId)) {
      hidden += 1;
      out.push({
        masked: true,
        attachedPath: e.attachedPath || [],
        attachedPathTitles: e.attachedPathTitles || [],
        reason: e.reason || undefined,
        reasonLabel: e.reason ? '某条私密证据：' + e.reasonLabel : undefined,
      });
      continue;
    }
    out.push(e);
  }
  return { items: out, hiddenCount: hidden };
}

// rating: 最新自评行（或 null）；plans: 该节点计划数组（详情用）
function evaluationView(node, ev, { owner = false, ruleVersion, rating = null, plans = null } = {}) {
  if (!ev) {
    return {
      nodeId: node.id,
      title: node.title,
      ruleVersion,
      supportLevel: 'never_evaluated',
      supportLabel: '尚未评估',
      selfScore: null,
      evidenceCount: 0,
      planOpen: 0,
      pathReport: [],
      weakenReasons: [],
    };
  }
  const pathReport = JSON.parse(ev.path_report || '[]');
  const weaken = JSON.parse(ev.weaken_reasons || '[]');

  if (owner) {
    return {
      nodeId: node.id,
      title: node.title,
      ruleVersion: ev.rule_version,
      updatedAt: ev.updated_at,
      selfScore: ev.self_score,
      selfNote: rating ? rating.note : '',
      selfPublic: rating ? !!rating.is_public : true,
      supportLevel: ev.support_level,
      supportLabel: rules.SUPPORT_LABEL[ev.support_level] || ev.support_level,
      strength: ev.strength,
      evidenceCount: ev.evidence_count,
      weakened: !!ev.weakened,
      weakenReasons: weaken,
      pathReport,
      plans,
      planOpen: ev.plan_open,
      recomputeNote: ev.recompute_note,
    };
  }

  const privSet = privateEvidenceIds();
  const pr = maskEvidenceList(pathReport, privSet);
  const wk = maskEvidenceList(weaken, privSet);
  const publicPlans = (plans || []).filter((p) => p.is_public);

  return {
    nodeId: node.id,
    title: node.title,
    ruleVersion: ev.rule_version,
    updatedAt: ev.updated_at,
    selfScore: rating && rating.is_public ? rating.score : null,
    selfNote: rating && rating.is_public ? rating.note : '',
    supportLevel: ev.support_level,
    supportLabel: rules.SUPPORT_LABEL[ev.support_level] || ev.support_level,
    strength: ev.strength,
    evidenceCount: ev.evidence_count,
    privateEvidenceCount: pr.hiddenCount,
    weakened: !!ev.weakened,
    weakenReasons: wk.items,
    pathReport: pr.items,
    plans: publicPlans.map((p) => ({ id: p.id, title: p.title, target_date: p.target_date, status: p.status })),
    planOpen: ev.plan_open,
    recomputeNote: ev.recompute_note,
    disclaimer: '支持档位为按既定规则的自我整理，不是客观认证，也不存在总分。',
  };
}

function latestRatings() {
  const rows = all(`SELECT r.* FROM self_ratings r
    JOIN (SELECT node_id, MAX(rated_at) m FROM self_ratings GROUP BY node_id) x
      ON x.node_id=r.node_id AND x.m=r.rated_at`);
  return new Map(rows.map((r) => [r.node_id, r]));
}

function graphView({ owner = false, version = null } = {}) {
  const ver = version || rules.activeRuleVersion();
  const nodes = all(`SELECT * FROM nodes WHERE merged_into IS NULL ORDER BY created_at, id`);
  const edges = all(
    `SELECT e.* FROM edges e
     JOIN nodes p ON p.id=e.parent_id JOIN nodes c ON c.id=e.child_id
     WHERE p.merged_into IS NULL AND c.merged_into IS NULL`
  );
  const evs = all(`SELECT * FROM evaluations WHERE rule_version=?`, [ver]);
  const evMap = new Map(evs.map((e) => [e.node_id, e]));
  const ratingMap = latestRatings();
  const approachRow = get(`SELECT approach, note FROM rule_versions WHERE version=?`, [ver]);
  return {
    ruleVersion: ver,
    approach: approachRow ? approachRow.approach : 'rule_driven',
    approachNote: approachRow ? approachRow.note : '',
    nodes: nodes.map((n) => {
      const v = evaluationView(n, evMap.get(n.id), {
        owner,
        ruleVersion: ver,
        rating: ratingMap.get(n.id) || null,
      });
      v.pathReport = (v.pathReport || []).slice(0, 6);
      v.weakenReasons = (v.weakenReasons || []).slice(0, 6);
      return v;
    }),
    edges: edges.map((e) => ({ id: e.id, from: e.parent_id, to: e.child_id })),
  };
}

module.exports = { evaluationView, graphView, maskEvidenceList, privateEvidenceIds, latestRatings };
