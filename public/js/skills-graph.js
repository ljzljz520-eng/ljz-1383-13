'use strict';

const API = '';
let state = { graph: null, scale: 1, tx: 0, ty: 0, selected: null };

const $ = (id) => document.getElementById(id);
const isDesktop = () => window.matchMedia('(min-width: 821px)').matches;

async function api(path, opts) {
  const r = await fetch(API + path, opts);
  if (!r.ok) {
    let msg = r.status;
    try { msg = (await r.json()).error || msg; } catch {}
    throw new Error(msg);
  }
  return r.json();
}

async function load() {
  state.graph = await api('/api/graph');
  $('ruleBadge').textContent = '计算规则 v' + state.graph.ruleVersion;
  if (isDesktop()) renderGraph(); else renderFold();
}

// ---------- 分层（拓扑层级） ----------
function layered(nodes, edges) {
  const byId = new Map(nodes.map((n) => [n.nodeId, n]));
  const parents = new Map(nodes.map((n) => [n.nodeId, []]));
  const children = new Map(nodes.map((n) => [n.nodeId, []]));
  for (const e of edges) {
    parents.get(e.to)?.push(e.from);
    children.get(e.from)?.push(e.to);
  }
  const level = new Map();
  const visiting = new Set();
  function lvl(id) {
    if (level.has(id)) return level.get(id);
    if (visiting.has(id)) return 0;
    visiting.add(id);
    const ps = parents.get(id) || [];
    const l = ps.length ? Math.max(...ps.map(lvl)) + 1 : 0;
    visiting.delete(id);
    level.set(id, l);
    return l;
  }
  nodes.forEach((n) => lvl(n.nodeId));
  const layers = [];
  for (const [id, l] of level) {
    (layers[l] = layers[l] || []).push(id);
  }
  // 层内按共享父节点聚拢的简单排序（保持种子顺序）
  return { layers: layers.filter(Boolean), byId, parents, children };
}

// ---------- 桌面图 ----------
const NODE_W = 210, NODE_H = 78, GAP_X = 60, GAP_Y = 110;

function renderGraph() {
  const { nodes, edges } = state.graph;
  const { layers } = layered(nodes, edges);
  const layerW = layers.map((l) => l.length * NODE_W + (l.length - 1) * GAP_X);
  const maxW = Math.max(...layerW);
  const pos = new Map();
  const nodeLayer = $('nodeLayer');
  nodeLayer.innerHTML = '';
  layers.forEach((ids, li) => {
    const w = ids.length * NODE_W + (ids.length - 1) * GAP_X;
    let x0 = (maxW - w) / 2;
    const y = 40 + li * (NODE_H + GAP_Y);
    ids.forEach((id, k) => {
      const x = x0 + k * (NODE_W + GAP_X);
      pos.set(id, { x, y });
      nodeLayer.appendChild(buildNodeEl(state.graph.nodes.find((n) => n.nodeId === id), x, y));
    });
  });

  // SVG 尺寸
  const svg = $('edges');
  const totalH = 40 + layers.length * (NODE_H + GAP_Y);
  const totalW = maxW + 120;
  svg.setAttribute('viewBox', `0 0 ${totalW} ${totalH}`);
  svg.setAttribute('width', totalW);
  svg.setAttribute('height', totalH);
  const layerEl = $('edgeLayer');
  layerEl.innerHTML = '';
  const weakenedTargets = new Set();
  for (const e of edges) {
    const a = pos.get(e.from), b = pos.get(e.to);
    if (!a || !b) continue;
    const x1 = a.x + NODE_W / 2, y1 = a.y + NODE_H;
    const x2 = b.x + NODE_W / 2, y2 = b.y;
    const my = (y1 + y2) / 2;
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', `M${x1},${y1} C${x1},${my} ${x2},${my} ${x2},${y2 - 4}`);
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke', '#64748b');
    path.setAttribute('stroke-width', '1.6');
    path.setAttribute('marker-end', 'url(#arrow)');
    path.setAttribute('opacity', '0.7');
    layerEl.appendChild(path);
  }
  applyTransform();
}

function buildNodeEl(n, x, y) {
  const el = document.createElement('div');
  el.className = `gnode lv-${n.supportLevel}` + (n.weakened ? ' weak' : '');
  el.style.left = x + 'px';
  el.style.top = y + 'px';
  el.dataset.id = n.nodeId;
  const self = n.selfScore ? `<span class="mini self">自评 ${n.selfScore}</span>` : '';
  const ev = n.evidenceCount ? `<span class="mini ev">成果 ${n.evidenceCount}</span>` : '';
  const priv = n.privateEvidenceCount ? `<span class="mini priv" title="另有私密证据，不展示标题">私密 ${n.privateEvidenceCount}</span>` : '';
  const plan = n.planOpen ? `<span class="mini plan">计划 ${n.planOpen}</span>` : '';
  const weak = n.weakened ? '<span class="mini weak">⚠ 前置弱化</span>' : '';
  el.innerHTML = `<div class="g-title"><span class="dot"></span>${escapeHtml(n.title)}</div>
    <div class="g-meta">${self}${ev}${plan}${priv}${weak}</div>`;
  el.onclick = () => openDrawer(n.nodeId);
  makeNodeDraggable(el);
  return el;
}

function applyTransform() {
  const nl = $('nodeLayer');
  nl.style.transformOrigin = '0 0';
  nl.style.transform = `translate(${state.tx}px,${state.ty}px) scale(${state.scale})`;
  const el = $('edgeLayer');
  el.setAttribute('transform', `translate(${state.tx},${state.ty}) scale(${state.scale})`);
}

// 节点拖动（布局微调）
function makeNodeDraggable(el) {
  let sx, sy, ox, oy, moved = false;
  el.addEventListener('mousedown', (e) => {
    moved = false;
    sx = e.clientX; sy = e.clientY; ox = parseFloat(el.style.left); oy = parseFloat(el.style.top);
    const move = (ev) => {
      const dx = (ev.clientX - sx) / state.scale, dy = (ev.clientY - sy) / state.scale;
      if (Math.abs(ev.clientX - sx) + Math.abs(ev.clientY - sy) > 4) moved = true;
      el.style.left = ox + dx + 'px'; el.style.top = oy + dy + 'px';
      redrawEdgesFor(el.dataset.id);
    };
    const up = () => {
      document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', up);
      setTimeout(() => (moved = false), 0);
    };
    document.addEventListener('mousemove', move); document.addEventListener('mouseup', up);
  });
  el.addEventListener('click', (e) => { if (moved) { e.stopPropagation(); e.preventDefault(); } }, true);
}

function redrawEdgesFor(id) {
  const el = document.querySelector(`.gnode[data-id="${id}"]`);
  if (!el) return;
  const posOf = (nid) => {
    const node = document.querySelector(`.gnode[data-id="${nid}"]`);
    return node ? { x: parseFloat(node.style.left), y: parseFloat(node.style.top) } : null;
  };
  document.querySelectorAll('#edgeLayer path').forEach((p) => p.remove());
  const layerEl = $('edgeLayer');
  for (const e of state.graph.edges) {
    const a = posOf(e.from), b = posOf(e.to);
    if (!a || !b) continue;
    const x1 = a.x + NODE_W / 2, y1 = a.y + NODE_H, x2 = b.x + NODE_W / 2, y2 = b.y;
    const my = (y1 + y2) / 2;
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', `M${x1},${y1} C${x1},${my} ${x2},${my} ${x2},${y2 - 4}`);
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke', '#64748b');
    path.setAttribute('stroke-width', '1.6');
    path.setAttribute('marker-end', 'url(#arrow)');
    path.setAttribute('opacity', '0.7');
    layerEl.appendChild(path);
  }
}

// 画布平移缩放
function bindCanvas() {
  const canvas = $('canvas');
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const delta = -e.deltaY * 0.0012;
    const ns = Math.min(2.2, Math.max(0.4, state.scale * (1 + delta)));
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left, my = e.clientY - rect.top;
    state.tx = mx - ((mx - state.tx) * ns) / state.scale;
    state.ty = my - ((my - state.ty) * ns) / state.scale;
    state.scale = ns;
    applyTransform();
  }, { passive: false });
  let panning = false, sx, sy;
  canvas.addEventListener('mousedown', (e) => {
    if (e.target.closest('.gnode')) return;
    panning = true; sx = e.clientX - state.tx; sy = e.clientY - state.ty;
    canvas.style.cursor = 'grabbing';
  });
  window.addEventListener('mousemove', (e) => {
    if (!panning) return;
    state.tx = e.clientX - sx; state.ty = e.clientY - sy; applyTransform();
  });
  window.addEventListener('mouseup', () => { panning = false; canvas.style.cursor = ''; });
}

// ---------- 移动端折叠 ----------
function renderFold() {
  const { nodes, edges } = state.graph;
  const { layers, byId, parents } = layered(nodes, edges);
  const root = $('foldLayers');
  root.innerHTML = '';
  layers.forEach((ids, li) => {
    const sec = document.createElement('div');
    sec.className = 'fold-layer';
    sec.innerHTML = `<h3>第 ${li + 1} 层 · ${li === 0 ? '基础前置' : '依赖上层能力'}</h3>`;
    ids.forEach((id) => sec.appendChild(buildFoldCard(byId.get(id), parents.get(id) || [], byId)));
    root.appendChild(sec);
  });
}

function buildFoldCard(n, parentIds, byId) {
  const card = document.createElement('div');
  card.className = 'fold-card' + (n.weakened ? ' weak' : '');
  const self = n.selfScore ? `<span class="mini self">自评 ${n.selfScore}</span>` : '';
  const ev = n.evidenceCount ? `<span class="mini ev">成果 ${n.evidenceCount}</span>` : '';
  const priv = n.privateEvidenceCount ? `<span class="mini priv">私密 ${n.privateEvidenceCount}</span>` : '';
  const plan = n.planOpen ? `<span class="mini plan">计划 ${n.planOpen}</span>` : '';
  const weak = n.weakened ? '<span class="mini weak">⚠ 前置弱化</span>' : '';
  const pTitles = parentIds.map((p) => byId.get(p)?.title).filter(Boolean);
  card.innerHTML = `
    <div class="fold-head">
      <div><b>${escapeHtml(n.title)}</b><div class="hint"><span class="dot lv-${n.supportLevel}"></span>${n.supportLabel}</div></div>
      <span class="arrow">▶</span>
    </div>
    <div class="fold-body">
      <div>${self}${ev}${plan}${priv}${weak}</div>
      ${pTitles.length ? `<div class="parents-line">前置：${pTitles.map(escapeHtml).join('、')}</div>` : ''}
      ${n.recomputeNote ? `<div class="parents-line">最近重算：${escapeHtml(n.recomputeNote)}</div>` : ''}
      <div style="margin-top:8px"><button class="btn small" data-id="${n.nodeId}">查看证据与依赖路径</button></div>
    </div>`;
  card.querySelector('.fold-head').onclick = () => card.classList.toggle('open');
  card.querySelector('button').onclick = (e) => { e.stopPropagation(); openDrawer(n.nodeId); };
  return card;
}

// ---------- 详情抽屉 ----------
async function openDrawer(id) {
  state.selected = id;
  document.querySelectorAll('.gnode.selected').forEach((n) => n.classList.remove('selected'));
  document.querySelector(`.gnode[data-id="${id}"]`)?.classList.add('selected');
  const d = await api('/api/nodes/' + id);
  $('drawer').hidden = false;
  $('dTitle').textContent = d.title;
  const chip = $('dLevel');
  chip.textContent = d.supportLabel;
  chip.className = 'level-chip lv-' + d.supportLevel;
  $('dDesc').textContent = d.description || '';
  $('dReevalNote').textContent = d.recomputeNote ? `最近重新评估：${d.recomputeNote}` : '';
  $('dReevalNote').style.display = d.recomputeNote ? 'block' : 'none';
  $('dSelf').textContent = d.selfScore ? d.selfScore + ' / 5' : '未填写';
  $('dSelf').title = d.selfNote || '';
  $('dEvCount').textContent = d.evidenceCount;
  const privHint = d.privateEvidenceCount ? `（含 ${d.privateEvidenceCount} 条私密证据，不公开标题）` : '';
  $('dEvHint').textContent = (d.strength && d.strength !== 'none' ? '强度：' + strengthLabel(d.strength) + ' ' : '') + privHint;
  $('dPlanCount').textContent = d.planOpen;

  // 弱化
  const wk = $('dWeaken');
  if (d.weakened && d.weakenReasons.length) {
    wk.hidden = false;
    wk.innerHTML = '<h4>⚠ 沿依赖图发现的弱化因素</h4><ul>' + d.weakenReasons.map((w) =>
      `<li>${w.masked ? '某条私密证据' : escapeHtml(w.title)} — <b>${escapeHtml(w.reasonLabel || '')}</b>
       <div class="hint">依赖路径：${(w.attachedPathTitles.length ? w.attachedPathTitles.concat([d.title]) : [d.title]).map(escapeHtml).join(' → ')}</div></li>`
    ).join('') + '</ul>';
  } else wk.hidden = true;

  // 证据
  $('dEvidence').innerHTML = (d.pathReport || []).map((e) => {
    if (e.masked) {
      return `<li class="masked">🔒 私密证据（标题不公开）
        <div class="ev-path">依赖路径：${(e.attachedPathTitles.length ? e.attachedPathTitles.concat([d.title]) : [d.title]).map(escapeHtml).join(' → ')}</div></li>`;
    }
    const path = e.attachedPathTitles.length
      ? e.attachedPathTitles.concat([d.title]).join(' → ')
      : '直接挂载于本技能';
    return `<li>${e.url ? `<a href="${escapeAttr(e.url)}" target="_blank" rel="noopener">${escapeHtml(e.title)}</a>` : escapeHtml(e.title)}
      <span class="ev-kind">${escapeHtml(e.kindLabel)}</span>${e.strength ? `<span class="str-${e.strength}">（${strengthLabel(e.strength)}）</span>` : ''}
      <div class="ev-path">依赖路径：${path.split(' → ').map(escapeHtml).join(' → ')}</div></li>`;
  }).join('') || '<li class="hint">暂无有效可验证成果</li>';

  // 计划
  $('dPlans').innerHTML = (d.plans || []).map((p) =>
    `<li>${escapeHtml(p.title)} <span class="hint">[${planStatus(p.status)}${p.target_date ? ' · 目标 ' + fmtDate(p.target_date) : ''}]</span></li>`
  ).join('') || '<li class="hint">暂无公开计划</li>';

  // 依赖路径
  $('dPaths').innerHTML = (d.dependencyPaths || []).map((p) =>
    `<li>· <b>${escapeHtml(p.ancestorTitle)}</b>：${p.routeTitles.map(escapeHtml).join(' → ')}</li>`
  ).join('') || '<li class="hint">无前置节点</li>';
  $('reevalOut').textContent = '';
}

$('drawerClose').onclick = () => { $('drawer').hidden = true; document.querySelectorAll('.gnode.selected').forEach((n) => n.classList.remove('selected')); };
$('reevalBtn').onclick = async () => {
  const r = await api('/api/nodes/' + state.selected + '/reevaluate');
  const parts = [`档位：${r.supportLabel}`, `有效成果：${r.evidenceCount}`, r.weakened ? `⚠ ${r.weakenReasons.length} 条弱化` : '无弱化', `规则 v${r.ruleVersion}`];
  $('reevalOut').textContent = '实时结果 → ' + parts.join(' · ');
};

function strengthLabel(s) { return { strong: '可独立核验', moderate: '有效但缺核验链接', limited: '临期', none: '无' }[s] || s; }
function planStatus(s) { return { open: '待启动', in_progress: '进行中', done: '已完成' }[s] || s; }
function fmtDate(ts) { return new Date(ts).toISOString().slice(0, 10); }
function escapeHtml(s) { return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function escapeAttr(s) { return escapeHtml(s); }

// ---------- 策略/历史弹层 ----------
$('policyLink').onclick = async (e) => {
  e.preventDefault();
  const p = await api('/api/meta/policy');
  $('modalTitle').textContent = '计算规则与版本决策';
  $('modalBody').innerHTML = `
    <p><b>方案选择：</b>${escapeHtml(p.decision === 'rule_driven' ? '规则驱动汇总' : p.decision)}</p>
    <p class="muted">${escapeHtml(p.decisionNote)}</p>
    <p class="muted">${escapeHtml(p.noScoreStatement)}</p>
    <h4>规则版本</h4>
    ${p.versions.map((v) => `
      <div class="export-item">
        <b>v${escapeHtml(v.version)}</b> ${v.active ? '<span class="mini ev">当前生效</span>' : ''}
        <span class="hint">（${v.approach === 'rule_driven' ? '规则驱动' : '只展示证据强度'}）</span>
        <div class="muted" style="margin:4px 0">${escapeHtml(v.note || '')}</div>
        <ul class="policy-rule">${(v.spec.doc || []).map((d) => `<li>${escapeHtml(d)}</li>`).join('')}</ul>
      </div>`).join('')}`;
  $('modalMask').hidden = false;
};

$('historyBtn').onclick = async () => {
  const list = await api('/api/exports');
  $('modalTitle').textContent = '历史图导出（快照冻结，保留当时依据）';
  $('modalBody').innerHTML = list.length ? list.map((x) =>
    `<div class="export-item" data-id="${x.id}">
      <b>${escapeHtml(x.label || '未命名导出')}</b>
      <div class="hint">${fmtDate(x.created_at)} · 规则 v${escapeHtml(x.rule_version)}</div>
    </div>`).join('') : '<p class="muted">还没有历史导出（管理端可创建）。</p>';
  $('modalBody').querySelectorAll('.export-item').forEach((el) => {
    el.onclick = async () => {
      const ex = await api('/api/exports/' + el.dataset.id);
      $('modalTitle').textContent = '导出快照 · ' + (ex.label || ex.id);
      $('modalBody').innerHTML = `<p class="muted">冻结于 ${fmtDate(ex.createdAt)} · 规则 v${escapeHtml(ex.ruleVersion)} ·
        之后的变更（如证书到期）不影响本快照；私密证据标题从未写入快照。</p>
        <div id="snapLayers"></div>`;
      const root = $('snapLayers');
      const { layers, byId } = layered(ex.snapshot.nodes, ex.snapshot.edges);
      layers.forEach((ids, li) => {
        const sec = document.createElement('div');
        sec.className = 'fold-layer';
        sec.innerHTML = `<h3>第 ${li + 1} 层</h3>`;
        ids.forEach((id) => {
          const n = byId.get(id);
          const d = document.createElement('div');
          d.className = 'fold-card';
          d.innerHTML = `<div class="fold-head"><div><b>${escapeHtml(n.title)}</b>
            <div class="hint">${escapeHtml(n.supportLabel)} · 成果 ${n.evidenceCount}${n.privateEvidenceCount ? ` · 私密 ${n.privateEvidenceCount}` : ''}${n.weakened ? ' · ⚠弱化' : ''}</div></div></div>
            <div class="fold-body"><ul class="ev-list">${(n.pathReport || []).map((e) => e.masked
              ? '<li class="masked">🔒 私密证据（标题不公开）</li>'
              : `<li>${escapeHtml(e.title)}<div class="ev-path">${(e.attachedPathTitles || []).join(' → ') || '直接挂载'}</div></li>`).join('') || '<li class="hint">无</li>'}</ul></div>`;
          d.querySelector('.fold-head').onclick = () => d.classList.toggle('open');
          sec.appendChild(d);
        });
        root.appendChild(sec);
      });
    };
  });
  $('modalMask').hidden = false;
};
$('modalClose').onclick = () => ($('modalMask').hidden = true);
$('modalMask').addEventListener('click', (e) => { if (e.target.id === 'modalMask') $('modalMask').hidden = true; });

window.addEventListener('resize', () => {
  if (!state.graph) return;
  if (isDesktop()) { $('foldView').hidden = true; $('graphView').hidden = false; renderGraph(); }
  else { $('graphView').hidden = true; $('foldView').hidden = false; renderFold(); }
});

bindCanvas();
load().catch((e) => { document.body.insertAdjacentHTML('afterbegin', `<div style="padding:20px;color:#fca5a5">加载失败：${escapeHtml(e.message)}</div>`); });
