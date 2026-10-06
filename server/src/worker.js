'use strict';

// 异步作业：重算与规则升级。
// 关键语义：job.rule_version 在入队时固化；作业到期才执行——
// 若等待期间规则已升级，这就是"迟到作业"，仍按其入队版本计算并显式标注。

const { all, get, run, flush, audit, genId } = require('./db');
const rules = require('./rules');
const g = require('./graph');

function enqueueRecompute(nodeIds, version, opts = {}) {
  const id = genId('job');
  run(
    `INSERT INTO jobs (id, job_type, payload, status, rule_version, not_before, created_at)
     VALUES (?,?,?, 'queued', ?, ?, ?)`,
    [id, 'recompute', JSON.stringify({ nodeIds, reason: opts.reason || '', delay_version: opts.delayVersion || null }),
     version, (opts.now || Date.now()) + (opts.delayMs || 0), opts.now || Date.now()]
  );
  return id;
}

function enqueueActivate(version, opts = {}) {
  const id = genId('job');
  run(
    `INSERT INTO jobs (id, job_type, payload, status, rule_version, not_before, created_at)
     VALUES (?,?,?, 'queued', ?, ?, ?)`,
    [id, 'activate_ruleset', JSON.stringify({ version }), version,
     (opts.now || Date.now()) + (opts.delayMs || 0), opts.now || Date.now()]
  );
  return id;
}

// 执行所有到期作业，返回执行报告
function runDueJobs(opts = {}) {
  const now = opts.now || Date.now();
  const jobs = all(`SELECT * FROM jobs WHERE status='queued' AND not_before <= ? ORDER BY created_at, id`, [now]);
  const reports = [];
  for (const job of jobs) {
    run(`UPDATE jobs SET status=?, picked_at=? WHERE id=?`, [
      opts.dryRun ? 'queued' : 'done',
      now,
      job.id,
    ]);
    if (opts.dryRun) {
      reports.push({ id: job.id, type: job.job_type, late: false });
      continue;
    }
    try {
      const payload = JSON.parse(job.payload || '{}');
      const currentVersion = rules.activeRuleVersion();
      // 规则激活作业本身定义"当前版本"，永远不算迟到；
      // 只有排队中的重算作业，在规则升级之后才执行时才算迟到。
      const late = job.job_type === 'recompute' && currentVersion !== job.rule_version;
      let affected = [];

      if (job.job_type === 'recompute') {
        const ids = payload.nodeIds || [];
        const results = rules.recompute(ids, job.rule_version, {
          now,
          note: late
            ? `迟到作业：入队时为 v${job.rule_version}，执行时当前版本为 v${currentVersion}；按入队版本 v${job.rule_version} 计算（触发：${payload.reason || '变更'}）`
            : `重新评估（触发：${payload.reason || '变更'}）`,
        });
        affected = results.map((r) => r.nodeId);
      } else if (job.job_type === 'activate_ruleset') {
        // 激活规则集并对全部节点按新版本重算
        run(`UPDATE rule_versions SET active=0`);
        run(`UPDATE rule_versions SET active=1, activated_at=? WHERE version=?`, [now, payload.version]);
        const nodes = g.activeNodes();
        const results = rules.recompute(
          nodes.map((n) => n.id),
          payload.version,
          { now, note: `规则升级到 v${payload.version} 后的全量重算` }
        );
        affected = results.map((r) => r.nodeId);
        audit('ruleset.activate', 'rule_version', payload.version, `activated with ${affected.length} nodes`);
      }

      run(`UPDATE jobs SET status='done', finished_at=?, result=? WHERE id=?`, [
        now,
        JSON.stringify({ late, jobVersion: job.rule_version, currentVersion, affected }),
        job.id,
      ]);
      reports.push({ id: job.id, type: job.job_type, late, jobVersion: job.rule_version, currentVersion, affected });
    } catch (e) {
      run(`UPDATE jobs SET status='failed', finished_at=?, error=? WHERE id=?`, [now, String(e.stack || e), job.id]);
      reports.push({ id: job.id, type: job.job_type, error: String(e) });
    }
  }
  if (reports.length) flush();
  return reports;
}

// 计算某变更应传播的节点集（变更节点 + 全部后代）
function propagationSet(nodeIds) {
  const { fwd } = g.buildAdj();
  const set = new Set(nodeIds);
  for (const d of g.descendants(nodeIds, fwd)) set.add(d);
  return [...set];
}

module.exports = { enqueueRecompute, enqueueActivate, runDueJobs, propagationSet };
