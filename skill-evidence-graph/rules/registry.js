'use strict';
/*
 * 计算规则登记 (rule registry)
 * ---------------------------------------------------------------------------
 * 设计抉择：采用「规则驱动汇总」，不采用「只展示证据强度」。
 * 理由：访客需要可比较的成熟度信号与缺口路径；规则驱动模式把每条结论
 *       追溯到具体证据，并随规则版本固定，避免一个"总分"被误读为客观认证。
 *       「只展示证据强度」仍作为前端切换视图(evidence-only)提供原始数据，
 *       但系统主判结论由本登记中的规则生成。
 *
 * 三类信息互不合并成总分：
 *   - self       自评分（仅作置信度修正，最高 +1 点封顶）
 *   - verifiable 可验证成果（证书/作品/文章等，按子类权重计点）
 *   - plan       计划目标（永不参与定级，单独展示为路线图）
 *
 * 所有结论是节点级、规则版本化的「自评成熟度」，不是客观认证。
 */

const RULE_SPECS = [
  {
    version: '1.0.0',
    mode: 'rule-driven-summary',
    activatedByDefault: true,
    notes: '首版规则：硬前置门控；证据沿硬前置继承(0.5权重，每条证据对每个节点只计一次，共享节点不重复加分)；自评分封顶+1；计划不计分。',
    weights: {
      verifiable: { certificate: 2, project: 2, article: 1, work: 2, other: 1 },
      inheritedMultiplier: 0.5,
      selfMaxBonus: 1,
      selfBonus: (self_level, self_confidence) => {
        if (self_level == null) return 0;
        const conf = self_confidence == null ? 0.6 : self_confidence;
        return self_level >= 2 ? Math.round(conf) : 0;
      },
    },
    thresholds: [
      { level: 'proven', min: 6 },
      { level: 'applied', min: 3 },
      { level: 'foundational', min: 1 },
      { level: 'none', min: 0 },
    ],
    expiryAware: false,
    prereq: {
      gate: true,
      inherit: true,
      inheritKinds: ['hard'],
      inheritedMultiplier: 0.5,
      minGateLevel: 'applied',
      minGatePoints: 3,
    },
    evidence: {
      countedKinds: ['self', 'verifiable'],
      privateCountsForOwner: true,
      privateInPublic: false,
    },
    levelLabel: { none: '暂无依据', foundational: '基础', applied: '可应用', proven: '有充分验证' },
  },
  {
    version: '2.0.0',
    mode: 'rule-driven-summary',
    activatedByDefault: false,
    notes: '规则升级：证书到期感知(到期即失活，到期前30天线性衰减)；证据新鲜度(4年内x1，之后x0.5)；弱前置不门控只显示缺口；自评分需可验证成果垫底才给加成；升级时排队的旧版本作业按迟到处理。',
    weights: {
      verifiable: { certificate: 2, project: 2, article: 1, work: 3, other: 1 },
      inheritedMultiplier: 0.5,
      selfMaxBonus: 1,
      selfRequiresDirectVerifiablePoints: 2,
      freshnessDays: 1461,
      freshnessFactor: 0.5,
      expiryGraceDays: 30,
      selfBonus: (self_level, self_confidence) => {
        if (self_level == null) return 0;
        const conf = self_confidence == null ? 0.6 : self_confidence;
        return self_level >= 2 ? Math.round(conf) : 0;
      },
    },
    thresholds: [
      { level: 'proven', min: 7 },
      { level: 'applied', min: 3 },
      { level: 'foundational', min: 1 },
      { level: 'none', min: 0 },
    ],
    expiryAware: true,
    prereq: {
      gate: true,
      inherit: true,
      inheritKinds: ['hard'],
      inheritedMultiplier: 0.5,
      minGateLevel: 'applied',
      minGatePoints: 3,
      weakShowsGapOnly: true,
    },
    evidence: {
      countedKinds: ['self', 'verifiable'],
      privateCountsForOwner: true,
      privateInPublic: false,
    },
    levelLabel: { none: '暂无依据', foundational: '基础', applied: '可应用', proven: '有充分验证' },
  },
];

const RULE_MAP = Object.fromEntries(RULE_SPECS.map((r) => [r.version, r]));

module.exports = { RULE_SPECS, RULE_MAP };
