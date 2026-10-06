'use strict';

let graph = null;
const TOKEN_KEY = 'skill_graph_owner_token';
const $ = (id) => document.getElementById(id);
const logEl = $('log');

function token() { return localStorage.getItem(TOKEN_KEY) || 'demo-owner-token'; }
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function log(msg, ok = true) {
  const line = '[' + new Date().toLocaleTimeString() + '] ' + (typeof msg === 'string' ? msg : JSON.stringify(msg));
  logEl.textContent = line + '\n' + logEl.textContent;
  logEl.style.color = ok ? '#a7f3d0' : '#fca5a5';
}

async function call(path, method, body) {
  const opts = { method: method || 'GET', headers: { 'x-owner-token': token(), 'content-type': 'application/json' } };
  if (body) opts.body = JSON.stringify(body);
  const r = await fetch(path, opts);
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || r.status);
  return data;
}

function table(headers, rows) {
  return '<table><thead><tr>' + headers.map((h) => '<th>' + h + '</th>').join('') + '</tr></thead><tbody>' +
    rows.map((r) => '<tr>' + r.map((c) => '<td>' + c + '</td>').join('') + '</tr>').join('') + '</tbody></table>';
}

async function refresh() {
  graph = await call('/api/graph');
  const opts = graph.nodes.map((n) => '<option value="' + n.nodeId + '">' + esc(n.title) + '</option>').join('');
  for (const id of ['eParent', 'eChild', 'rNode', 'pNode', 'mSource', 'mTarget']) $(id).innerHTML = opts;
  $('evNodes').innerHTML = graph.nodes
    .map((n) => '<label class="hint" style="margin-right:10px"><input type="checkbox" value="' + n.nodeId + '" class="ev-node"> ' + esc(n.title) + '</label>')
    .join('');
  renderTables();
}

function renderTables() {
  $('nodeTable').innerHTML = table(
    ['ID', '标题', '支持档位', '自评', '成果', '计划', '弱化', '最近重算说明'],
    graph.nodes.map((n) => [
      esc(n.nodeId), esc(n.title), esc(n.supportLabel),
      n.selfScore != null ? n.selfScore + '/5' : '—',
      n.evidenceCount + (n.privateEvidenceCount ? ' <span class="tag">私密' + n.privateEvidenceCount + '</span>' : ''),
      n.planOpen,
      n.weakened ? '<span class="warn">⚠</span>' : '',
      '<span class="hint">' + esc(n.recomputeNote || '') + '</span>',
    ])
  );
  const titleOf = Object.fromEntries(graph.nodes.map((n) => [n.nodeId, n.title]));
  $('edgeTable').innerHTML = table(
    ['前置', '后置', '操作'],
    graph.edges.map((e) => [
      esc(titleOf[e.from]), esc(titleOf[e.to]),
      '<button class="btn small" data-del-edge="' + e.id + '">删除</button>',
    ])
  );
  // 证据表（管理视图：显示私密标题）
  Promise.all(graph.nodes.map((n) => n.nodeId)).then(() => {});
  loadEvidenceRows();
  loadSignals();
  loadJobs();
  loadRules();
  loadExports();
}

async function loadEvidenceRows() {
  // 管理端证据视图通过节点详情汇总成本较高；这里直接从图节点的 pathReport 收集
  const seen = new Map();
  for (const n of graph.nodes) {
    for (const e of n.pathReport || []) {
      if (!seen.has(e.evidenceId)) seen.set(e.evidenceId, { e, nodes: [] });
      seen.get(e.evidenceId).nodes.push(n.title);
    }
    for (const w of n.weakenReasons || []) {
      if (!w.masked && !seen.has(w.evidenceId)) seen.set(w.evidenceId, { e: w, nodes: [] });
      if (seen.has(w.evidenceId)) seen.get(w.evidenceId).nodes.push(n.title + '(弱化)');
    }
  }
  const rows = [];
  for (const [, v] of seen) {
    const e = v.e;
    rows.push([
      esc(e.title), '<span class="tag">' + esc(e.kindLabel || e.kind) + '</span>',
      esc([...new Set(v.nodes)].join('、')),
      e.strength ? '<span class="tag">' + e.strength + '</span>' : '',
      e.reason ? '<span class="warn">' + esc(e.reasonLabel) + '</span>' : '有效',
      '<button class="btn small" data-expire="' + e.evidenceId + '">标记到期</button> ' +
      '<button class="btn small" data-withdraw="' + e.evidenceId + '">撤下</button> ' +
      '<button class="btn small" data-restore="' + e.evidenceId + '">恢复</button>',
    ]);
  }
  $('evidenceTable').innerHTML = table(['标题', '类型', '支持的技能（多）', '强度', '状态', '操作'], rows);
}

async function loadSignals() {
  const detail = await Promise.all(graph.nodes.map((n) => call('/api/nodes/' + n.nodeId)));
  const rRows = [], pRows = [];
  for (const d of detail) {
    if (d.selfScore != null) rRows.push([esc(d.title), d.selfScore + '/5', d.selfPublic ? '公开' : '<span class="warn">私密</span>', esc(d.selfNote || '')]);
    for (const p of d.plans || []) pRows.push([esc(d.title), esc(p.title), esc(p.status), p.is_public ? '公开' : '<span class="warn">私密</span>']);
  }
  $('signalsTable').innerHTML =
    '<h3 style="font-size:.85rem;margin:10px 0 6px">自评分</h3>' +
    table(['节点', '分数', '可见性', '说明'], rRows) +
    '<h3 style="font-size:.85rem;margin:14px 0 6px">计划</h3>' +
    table(['节点', '计划', '状态', '可见性'], pRows);
}

async function loadJobs() {
  const jobs = await call('/api/admin/jobs');
  $('jobsTable').innerHTML = table(
    ['类型', '状态', '入队规则', '迟到', '创建', '完成', '结果/错误'],
    jobs.slice(0, 30).map((j) => {
      const res = j.result ? JSON.parse(j.result) : {};
      return [
        esc(j.job_type), j.status === 'done' ? '<span class="ok">done</span>' : j.status,
        'v' + esc(j.rule_version),
        res.late ? '<span class="warn">迟到作业（按入队版本执行）</span>' : '',
        new Date(j.created_at).toLocaleTimeString(),
        j.finished_at ? new Date(j.finished_at).toLocaleTimeString() : '',
        '<span class="hint">' + esc((j.error || (j.result ? '影响 ' + ((res.affected || []).length) + ' 节点' : ''))) + '</span>',
      ];
    })
  );
}

async function loadRules() {
  const p = await fetch('/api/meta/policy').then((r) => r.json());
  $('ruleList').innerHTML = table(
    ['版本', '方案', '当前', '说明'],
    p.versions.map((v) => [
      'v' + esc(v.version),
      v.approach === 'rule_driven' ? '规则驱动汇总' : '只展示证据强度',
      v.active ? '<span class="ok">生效中</span>' : '',
      esc(v.note || ''),
    ])
  );
}

async function loadExports() {
  const list = await call('/api/exports');
  $('exportTable').innerHTML = table(
    ['标签', '规则', '创建时间', '链接'],
    list.map((x) => [
      esc(x.label || '—'), 'v' + esc(x.rule_version), new Date(x.created_at).toLocaleString(),
      '<a href="/api/exports/' + x.id + '" target="_blank">查看冻结快照 JSON</a>',
    ])
  );
}

// ---------- 事件 ----------
$('saveToken').onclick = () => { localStorage.setItem(TOKEN_KEY, $('token').value.trim()); $('tokenState').textContent = '已保存'; refresh(); };
$('token').value = token();

document.querySelectorAll('.tab').forEach((t) => {
  t.onclick = () => {
    document.querySelectorAll('.tab').forEach((x) => x.classList.remove('active'));
    t.classList.add('active');
    document.querySelectorAll('[data-panel]').forEach((p) => (p.hidden = p.dataset.panel !== t.dataset.tab));
  };
});

$('addNode').onclick = async () => {
  try { const r = await call('/api/admin/nodes', 'POST', { title: $('nTitle').value.trim(), description: $('nDesc').value.trim() }); log('节点已创建 ' + r.id); await refresh(); }
  catch (e) { log(e.message, false); }
};

$('addEdge').onclick = async () => {
  try {
    const r = await call('/api/admin/edges', 'POST', { parentId: $('eParent').value, childId: $('eChild').value });
    log(r.deduped ? '关系已存在（去重）' : '前置关系已添加，触发 ' + r.affectedNodes.length + ' 个节点重算');
    await refresh();
  } catch (e) { log('拒绝：' + e.message, false); }
};

$('addEvidence').onclick = async () => {
  try {
    const nodeIds = [...document.querySelectorAll('.ev-node:checked')].map((c) => c.value);
    const body = {
      title: $('evTitle').value.trim(), kind: $('evKind').value, url: $('evUrl').value.trim(),
      isPublic: $('evPublic').checked, nodeIds,
      validTo: $('evTo').value ? new Date($('evTo').value + 'T23:59:59').getTime() : null,
    };
    const r = await call('/api/admin/evidence', 'POST', body);
    log('证据已创建，影响传播到 ' + r.affectedNodes.length + ' 节点（含多父路径去重）');
    $('evTitle').value = '';
    await refresh();
  } catch (e) { log(e.message, false); }
};

$('addRating').onclick = async () => {
  try {
    await call('/api/admin/ratings', 'POST', {
      nodeId: $('rNode').value, score: Number($('rScore').value), note: $('rNote').value.trim(), isPublic: $('rPublic').checked,
    });
    log('自评分已记录（明确标注为主观自评，不产生总分）'); await refresh();
  } catch (e) { log(e.message, false); }
};

$('addPlan').onclick = async () => {
  try {
    await call('/api/admin/plans', 'POST', {
      nodeId: $('pNode').value, title: $('pTitle').value.trim(),
      targetDate: $('pDate').value ? new Date($('pDate').value + 'T23:59:59').getTime() : null,
      isPublic: $('pPublic').checked,
    });
    log('计划目标已添加'); $('pTitle').value = ''; await refresh();
  } catch (e) { log(e.message, false); }
};

$('doMerge').onclick = async () => {
  try {
    const r = await call('/api/admin/nodes/merge', 'POST', { sourceId: $('mSource').value, targetId: $('mTarget').value });
    log('合并完成：' + r.sourceId + ' → ' + r.targetId + '，重算 ' + r.affectedNodes.length + ' 节点'); await refresh();
  } catch (e) { log('合并被拒绝：' + e.message, false); }
};

document.addEventListener('click', async (e) => {
  const edge = e.target.dataset.delEdge;
  const ev = e.target.dataset;
  try {
    if (edge) { const r = await call('/api/admin/edges/' + edge, 'DELETE'); log('边已删除，重算 ' + r.affectedNodes.length + ' 节点'); }
    if (ev.expire || ev.withdraw || ev.restore) {
      const id = ev.expire || ev.withdraw || ev.restore;
      const status = ev.expire ? 'expired' : ev.withdraw ? 'withdrawn' : 'active';
      const r = await call('/api/admin/evidence/' + id + '/status', 'POST', { status });
      log('证据状态→' + status + '，沿依赖图重算 ' + r.affectedNodes.length + ' 节点：' + r.affectedNodes.join(','));
    }
    if (edge || ev.expire || ev.withdraw || ev.restore) await refresh();
  } catch (err2) { log(err2.message, false); }
});

document.querySelectorAll('[data-activate]').forEach((b) => {
  b.onclick = async () => {
    try { const r = await call('/api/admin/rules/activate', 'POST', { version: b.dataset.activate, delayMs: 0 }); log('规则激活作业已入队（立即到期）: ' + r.jobId); await refresh(); }
    catch (e) { log(e.message, false); }
  };
});

$('activateV2Late').onclick = async () => {
  try { await call('/api/admin/rules/activate', 'POST', { version: '2.0.0', delayMs: 3000 }); log('v2 激活作业已入队，3 秒后到期（在此之前可观察排队状态）'); }
  catch (e) { log(e.message, false); }
};

$('enqueueRecomputeV1Delay').onclick = async () => {
  try {
    await call('/api/admin/recompute', 'POST', { delayMs: 4000, reason: '演示：规则升级前入队的旧版本作业' });
    log('已入队 v1 延迟重算（4s）。3 秒后请点"升级 v2.0.0（立即）"，旧作业到期时将作为迟到作业按 v1 执行。');
  } catch (e) { log(e.message, false); }
};

$('runJobs').onclick = async () => {
  try { const r = await call('/api/admin/maintenance/run-jobs', 'POST', {}); log({ sweptExpired: r.sweptExpired, jobs: r.jobReports.map((j) => j.id + (j.late ? '(迟到,v' + j.jobVersion + ')' : '')) }); await refresh(); }
  catch (e) { log(e.message, false); }
};
$('refreshJobs').onclick = () => refresh();
$('recomputeAll').onclick = async () => {
  try { await call('/api/admin/recompute', 'POST', { reason: '管理端手动全量重算' }); log('全量重算已入队'); } catch (e) { log(e.message, false); }
};

$('createExport').onclick = async () => {
  try { const r = await call('/api/admin/exports', 'POST', { label: $('expLabel').value.trim() }); log('历史导出已冻结：' + r.id + '（v' + r.ruleVersion + '）'); $('expLabel').value = ''; await refresh(); }
  catch (e) { log(e.message, false); }
};

refresh().catch((e) => log('初始化失败：' + e.message, false));
