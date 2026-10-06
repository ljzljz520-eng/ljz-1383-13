'use strict';

// 评估引擎（规则驱动汇总）。
// 设计决策（docs/design-notes.md 决策 D1）：
//   在"规则驱动汇总"与"只展示证据强度"之间选择 rule_driven：
//   自评分 / 可验证成果 / 计划目标 是三类并列信息，分别展示，
//   规则只给出文字化的"支持档位"（support_level），绝不输出一个暗示客观认证的总分。
//   证据强度作为辅助字段保留；evidence_only 方案仅记录在 rule_versions 表中作为对照。

const { all, get, run } = require('./db');
const g = require('./graph');

const V1 = '1.0.0';
const V2 = '2.0.0';

const RULE_SPECS = {
  [V1]: {
    approach: 'rule_driven',
    note: 'v1：三信息分离 + 支持档位（verified_result/planned/self_asserted/no_signal）',
    tiers: false,
    doc: [
      '1. 沿依赖图收集本节点及全部传递前置节点上的证据；同一证据即使有多条依赖路径或挂在多个节点，只计一次（按 evidence_id 去重）。',
      '2. support_level：有任一有效可验证成果=verified_result；无成果但有进行中计划=planned；仅剩自评分=self_asserted；皆无=no_signal。',
      '3. 前置节点证书过期/作品撤下：不作为有效证据，并沿图透传为弱化原因（可定位到证据与路径）。',
      '4. 私密证据照常计数，公开视图只显示"另有 N 条私密证据"，不暴露标题。',
      '5. 自评分 1-5 原样展示且标注"主观自评"；计划目标单独展示。任何页面不出现综合总分。',
    ],
  },
  [V2]: {
    approach: 'rule_driven',
    note: 'v2：增加证据强度分层与临期风险，弱化原因更具体',
    tiers: true,
    doc: [
      '1. 继承 v1 的全图收集与证据去重规则。',
      '2. 证据强度：active 且带可核验链接=strong；active 无链接=moderate；30 天内到期=limited。',
      '3. support_level：strong→verified_strong，moderate→verified，limited→at_risk；其后回退 planned/self_asserted/no_signal。',
      '4. 弱化原因按依赖路径逐条列出（前置节点→…→本节点），明确区分"过期"与"撤下"。',
    ],
  },
};

const EVIDENCE_ONLY_SPEC = {
  approach: 'evidence_only',
  note: '备选方案（未采用）：不做任何汇总档位，只罗列证据与强度，由读者自行判断',
  doc: ['不计算 support_level，仅展示每条证据及其强度与依赖路径。'],
};

function effectiveStatus(ev, now) {
  const status = ev.stored_status !== undefined ? ev.stored_status : ev.status;
  if (status !== 'active') return status;
  if (ev.valid_to && ev.valid_to < now) return 'expired';
  if (ev.valid_from && ev.valid_from > now) return 'future';
  return 'active';
}

const KIND_LABEL = { cert: '证书', work: '工作成果', artifact: '作品', assessment: '外部测评' };

// 取节点挂载的证据（含去重前的归属节点）
function evidenceOn(nodeIds) {
  if (!nodeIds.size) return [];
  const ids = [...nodeIds];
  const ph = ids.map(() => '?').join(',');
  return all(
    `SELECT e.*, en.node_id AS attached_node
     FROM evidence e JOIN evidence_nodes en ON en.evidence_id = e.id
     WHERE en.node_id IN (${ph})`,
    ids
  );
}

function latestRating(nodeId) {
  return get(
    `SELECT * FROM self_ratings WHERE node_id = ? ORDER BY rated_at DESC, created_at DESC LIMIT 1`,
    [nodeId]
  );
}

function openPlans(nodeId) {
  return all(`SELECT * FROM plans WHERE node_id = ? AND status IN ('open','in_progress')`, [nodeId]);
}

// 单节点评估。version 决定规则；now 便于测试注入时间。
function evaluateNode(nodeId, version, now) {
  const { fwd, rev } = g.buildAdj();
  const pathsByNode = g.ancestorPaths(nodeId, rev); // node -> 路由数组（前置→本节点顺序）
  const raw = evidenceOn(new Set(pathsByNode.keys()));

  // 按 evidence_id 去重合并路径：同一证据可能挂在多个节点、每个节点又有多条路径
  const byId = new Map();
  for (const row of raw) {
    const routes = pathsByNode.get(row.attached_node) || [[]];
    if (!byId.has(row.id)) {
      byId.set(row.id, {
        id: row.id,
        title: row.title,
        kind: row.ev_kind,
        kindLabel: KIND_LABEL[row.ev_kind],
        url: row.url,
        is_public: !!row.is_public,
        stored_status: row.status,
        valid_to: row.valid_to,
        valid_from: row.valid_from,
        attached: new Map(), // node -> routes
      });
    }
    const item = byId.get(row.id);
    item.attached.set(row.attached_node, (item.attached.get(row.attached_node) || []).concat(routes));
  }

  const active = [];
  const weaken = [];
  for (const ev of byId.values()) {
    const estatus = effectiveStatus(ev, now);
    // 选一条展示路径：优先最短路径（最近的前置），直接挂载为 []
    let bestRoute = null;
    for (const [node, routes] of ev.attached) {
      for (const r of routes) {
        if (bestRoute === null || r.length < bestRoute.length) bestRoute = r;
      }
    }
    const pathNodeTitles = titleMap([...pathNodes(bestRoute)]);
    const base = {
      evidenceId: ev.id,
      title: ev.title,
      kind: ev.kind,
      kindLabel: ev.kindLabel,
      url: ev.url,
      is_public: ev.is_public,
      attachedPath: bestRoute || [],
      attachedPathTitles: (bestRoute || []).map((id) => pathNodeTitles[id] || id),
    };
    if (estatus === 'active') {
      active.push({ ...base, aboutToExpire: ev.valid_to && ev.valid_to - now <= 30 * 864e5 });
    } else if (estatus === 'expired' || estatus === 'withdrawn') {
      // 证书到期 / 作品撤下：沿依赖图透传为可定位的弱化原因
      weaken.push({
        ...base,
        reason: estatus,
        reasonLabel: estatus === 'expired' ? '证书/证据已到期' : '作品已撤下',
        valid_to: ev.valid_to,
      });
    }
  }

  const rating = latestRating(nodeId);
  const plans = openPlans(nodeId);
  const activeCount = active.length;

  // 强度（v2）
  let strength = 'none';
  for (const a of active) {
    const tier = a.aboutToExpire ? 'limited' : a.url ? 'strong' : 'moderate';
    a.strength = tier;
    if (tier === 'strong') strength = 'strong';
    else if (tier === 'moderate' && strength !== 'strong') strength = 'moderate';
    else if (tier === 'limited' && strength === 'none') strength = 'limited';
  }

  let supportLevel;
  if (version === V2) {
    supportLevel =
      strength === 'strong'
        ? 'verified_strong'
        : strength === 'moderate'
          ? 'verified'
          : strength === 'limited'
            ? 'at_risk'
            : plans.length
              ? 'planned'
              : rating
                ? 'self_asserted'
                : 'no_signal';
  } else {
    supportLevel = activeCount
      ? 'verified_result'
      : plans.length
        ? 'planned'
        : rating
          ? 'self_asserted'
          : 'no_signal';
  }

  return {
    nodeId,
    ruleVersion: version,
    selfScore: rating ? rating.score : null,
    selfRatingPublic: rating ? !!rating.is_public : false,
    selfNote: rating ? rating.note : '',
    supportLevel,
    strength,
    evidenceCount: activeCount,
    privateCount: active.filter((a) => !a.is_public).length,
    weakened: weaken.length > 0 ? 1 : 0,
    weakenReasons: weaken,
    pathReport: active,
    planOpen: plans.length,
    plans: plans.map((p) => ({ id: p.id, title: p.title, target_date: p.target_date, status: p.status, is_public: !!p.is_public })),
  };
}

function pathNodes(route) {
  return new Set(route || []);
}
function titleMap(ids) {
  if (!ids.length) return {};
  const ph = ids.map(() => '?').join(',');
  const rows = all(`SELECT id, title FROM nodes WHERE id IN (${ph})`, ids);
  return Object.fromEntries(rows.map((r) => [r.id, r.title]));
}

const SUPPORT_LABEL = {
  verified_result: '有可验证成果支撑',
  verified_strong: '成果支撑 · 可独立核验',
  verified: '成果支撑',
  at_risk: '成果有效但临期',
  planned: '已列入计划，尚无成果',
  self_asserted: '仅自评主张',
  no_signal: '暂无信号',
};

// 持久化评估结果
function saveEvaluation(res, extra = {}) {
  run(
    `INSERT INTO evaluations
       (node_id, rule_version, updated_at, self_score, support_level, evidence_count,
        strength, weakened, weaken_reasons, path_report, plan_open, recompute_note)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(node_id, rule_version) DO UPDATE SET
       updated_at=excluded.updated_at, self_score=excluded.self_score,
       support_level=excluded.support_level, evidence_count=excluded.evidence_count,
       strength=excluded.strength, weakened=excluded.weakened,
       weaken_reasons=excluded.weaken_reasons, path_report=excluded.path_report,
       plan_open=excluded.plan_open, recompute_note=excluded.recompute_note`,
    [
      res.nodeId,
      res.ruleVersion,
      Date.now(),
      res.selfScore,
      res.supportLevel,
      res.evidenceCount,
      res.strength,
      res.weakened,
      JSON.stringify(res.weakenReasons),
      JSON.stringify(res.pathReport),
      res.planOpen,
      extra.note || '',
    ]
  );
}

// 重算一批节点（默认当前激活版本）
function recompute(nodeIds, version, opts = {}) {
  const now = opts.now || Date.now();
  const out = [];
  for (const id of nodeIds) {
    const mergedTarget = g.resolveTarget(id);
    if (!mergedTarget) continue;
    const res = evaluateNode(mergedTarget, version, now);
    saveEvaluation(res, { note: opts.note || '' });
    out.push(res);
  }
  return out;
}

function activeRuleVersion() {
  const row = get(`SELECT * FROM rule_versions WHERE active = 1`);
  return row ? row.version : V1;
}

// 证书/证据到期清扫：把日期已过但仍为 active 的证据标记 expired
function sweepExpiry(now = Date.now()) {
  const rows = all(`SELECT id FROM evidence WHERE status='active' AND valid_to IS NOT NULL AND valid_to < ?`, [now]);
  for (const r of rows) {
    run(`UPDATE evidence SET status='expired' WHERE id=?`, [r.id]);
  }
  return rows.map((r) => r.id);
}

module.exports = {
  V1,
  V2,
  RULE_SPECS,
  EVIDENCE_ONLY_SPEC,
  SUPPORT_LABEL,
  KIND_LABEL,
  evaluateNode,
  recompute,
  activeRuleVersion,
  sweepExpiry,
  effectiveStatus,
  saveEvaluation,
};
