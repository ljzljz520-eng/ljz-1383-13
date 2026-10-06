'use strict';
const $ = (s) => document.querySelector(s);
const key = () => $('#key').value.trim();
async function call(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: { 'content-type': 'application/json', 'x-admin-key': key(), ...(opts.headers || {}) },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(body.message || res.statusText), { body });
  return body;
}
function show(obj, isErr) {
  const pre = $('#out');
  pre.textContent = JSON.stringify(obj, null, 2);
  pre.classList.toggle('err', !!isErr);
}
async function wrap(fn) {
  try { show(await fn()); await loadState(); } catch (e) { show({ error: e.code || e.status, message: e.message, details: e.body?.details }, true); }
}
const createNode = () => wrap(() => call('/api/admin/nodes', { method: 'POST', body: JSON.stringify({ slug: $('#n-slug').value, title: $('#n-title').value, description: $('#n-desc').value }) }));
const mergeNodes = () => wrap(() => call('/api/admin/nodes/merge', { method: 'POST', body: JSON.stringify({ source: $('#m-source').value, target: $('#m-target').value }) }));
const addEdge = () => wrap(() => call('/api/admin/edges', { method: 'POST', body: JSON.stringify({ from: $('#e-from').value, to: $('#e-to').value, kind: $('#e-kind').value }) }));
function createEvidence() {
  const b = {
    kind: $('#ev-kind').value, title: $('#ev-title').value, subtype: $('#ev-subtype').value || null,
    issuer: $('#ev-issuer').value || null, issued_on: $('#ev-issued').value || null,
    expires_on: $('#ev-expires').value || null, private: $('#ev-private').checked,
    nodes: $('#ev-nodes').value.split(',').map((x) => x.trim()).filter(Boolean),
  };
  if (b.kind === 'self') { b.self_level = Number($('#ev-selflevel').value) || null; b.self_confidence = Number($('#ev-conf').value) || 0.8; }
  if (b.kind === 'plan') { b.plan_target_level = Number($('#ev-selflevel').value) || 2; b.plan_target_on = $('#ev-expires').value || null; }
  wrap(() => call('/api/admin/evidence', { method: 'POST', body: JSON.stringify(b) }));
}
const setStatus = () => wrap(() => call(`/api/admin/evidence/${$('#se-id').value}/status`, { method: 'POST', body: JSON.stringify({ status: $('#se-status').value }) }));
const activate = (v, delay) => wrap(() => call(`/api/admin/rules/${v}/activate`, { method: 'POST', body: JSON.stringify({ delay_ms: delay }) }));
const processJobs = () => wrap(() => call('/api/admin/jobs/process', { method: 'POST' }));
const sweep = (delay) => wrap(() => call('/api/admin/evidence/sweep', { method: 'POST', body: JSON.stringify({ delay_ms: delay }) }));
const doExport = () => wrap(() => call('/api/admin/exports', { method: 'POST', body: JSON.stringify({ title: $('#x-title').value || undefined }) }));

async function loadRules() {
  const rs = await (await fetch('/api/rules')).json();
  $('#rules').innerHTML = rs.map((r) => `<div class="kv">v${r.version} ${r.active ? '<b class="ok">[当前]</b>' : ''}<br>${r.notes}</div>`).join('<hr style="margin:.4rem 0">');
}
async function loadState() {
  const g = await (await fetch('/api/graph')).json();
  const jobs = await call('/api/admin/jobs').catch(() => []);
  show({
    rule: g.rule_version,
    nodes: g.nodes.map((n) => ({ id: n.id, slug: n.slug, title: n.title, level: n.level, status: n.prerequisite_status, parents: n.parents.map((p) => p.kind + ':' + p.id.slice(-4)) })),
    edges: g.edges.map((e) => `${e.from.slice(-4)} → ${e.to.slice(-4)} (${e.kind})`),
    queued_jobs: (jobs || []).slice(0, 5),
  });
}
loadRules(); loadState();
