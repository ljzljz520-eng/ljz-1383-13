'use strict';
const repo = require('./repository');
const engine = require('./engine');
const clock = require('./clock');

const HANDLERS = {
  full_reevaluate(job) {
    const payload = JSON.parse(job.payload_json || '{}');
    return engine.fullRecompute({
      jobId: job.id, requestedVersion: job.requested_version, late: !!job.late,
      at: payload.at ? new Date(payload.at) : clock.now(),
    });
  },
  evidence_expiry_sweep(job) {
    const payload = JSON.parse(job.payload_json || '{}');
    return engine.sweepExpiry({
      jobId: job.id, late: !!job.late,
      at: payload.at ? new Date(payload.at) : clock.now(),
    });
  },
};

/** 处理所有到期作业。返回作业执行报告（迟到判定：作业 late=1 或当前版本已漂移） */
function processDueJobs() {
  const reports = [];
  for (const job of repo.dueJobs(clock.nowIso())) {
    const handler = HANDLERS[job.type];
    if (!handler) { repo.finishJob(job.id, null, 'no handler'); continue; }
    try {
      const result = handler(job);
      reports.push({ job_id: job.id, type: job.type, late: !!job.late, result });
      repo.finishJob(job.id, result);
    } catch (err) {
      reports.push({ job_id: job.id, type: job.type, error: err.message });
      repo.finishJob(job.id, null, err.message);
    }
  }
  return reports;
}

module.exports = { processDueJobs, HANDLERS };
