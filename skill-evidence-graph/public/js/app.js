'use strict';
const state = { graph: null, mode: 'rule', rule: null, rules: [], selected: null };
const $ = (s) => document.querySelector(s);
const SVGNS = 'http://www.w3.org/2000/svg';

const LVL_CLASS = { none: 'lvl-none', foundational: 'lvl-foundational', applied: 'lvl-applied', proven: 'lvl-proven' };
const LVL_TEXT = { none: '暂无依据', foundational: '基础', applied: '可应用', proven: '有充分验证' };

function toast(msg, isErr) {
  let t = $('#toast');
  if (!t) { t = document.createElement('div'); t.id = 'toast'; t.className = 'toast'; document.body.appendChild(t); }
  t.textContent = msg; t.className = 'toast show' + (isErr ? ' err' : '');
  clearTimeout(t._h); t._h = setTimeout(() => (t.className = 'toast'), 3200);
}

async function api(path, opts) {
  const res = await fetch(path, opts);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(body.message || res.statusText), { body, status: res.status });
  return body;
}

async function init() {
  state.rules = await api('/api/rules');
  const sel = $('#rule-select');
  sel.innerHTML = state.rules.map((r) => `<option value="${r.version}" ${r.active ? 'selected' : ''}>规则 v${r.version}${r.active ? '（当前）' : ''}</option>`).join('');
  sel.onchange = () => loadGraph(sel.value);
  $('#mode-rule').onclick = () => setMode('rule');
  $('#mode-evidence').onclick = () => setMode('evidence');
  await loadGraph(sel.value);
  loadExports();
  if (matchMedia('(max-width:860px)').matches) renderMobile();
  window.addEventListener('resize', debounce(() => { renderSvg(); renderMobile(); }, 200));
}

function setMode(m) {
  state.mode = m;
  $('#mode-rule').classList.toggle('active', m === 'rule');
  $('#mode-evidence').classList.toggle('active', m === 'evidence');
  $('#mode-rule').setAttribute('aria-selected', m === 'rule');
  $('#mode-evidence').setAttribute('aria-selected', m === 'evidence');
  renderBanner();
  renderSvg();
  if (state.selected) showDetail(state.selected);
  renderMobile();
}

async function loadGraph(version) {
  state.rule = version;
  state.graph = await api(`/api/graph?version=${version}`);
  renderBanner();
  renderSvg();
  renderMobile();
  const hint = $('#detail-panel .hint');
}
function debounce(fn, ms){let h;return(...a)=>{clearTimeout(h);h=setTimeout(()=>fn(...a),ms);};}

function renderBanner() {
  const r = state.rules.find((x) => x.version === state.rule);
  const modeTxt = state.mode === 'rule'
    ? '<b>规则驱动汇总</b>：节点级成熟度（非认证），每条结论可追溯到证据'
    : '<b>仅证据强度</b>：只展示计点明细，不显示等级判定/门控结论';
  $('#rule-banner').innerHTML = `当前口径 ${modeTxt} ｜ 计算规则版本 <b>v${state.rule}</b> — ${r ? r.notes : ''}`;
}

function levelOrPoints(n) {
  if (state.mode === 'evidence') {
    const d = n.points.direct_verifiable, i = n.points.inherited_verifiable;
    return `直接 ${fmt(d)} / 继承 ${fmt(i)}`;
  }
  return LVL_TEXT[n.level] + (n.gated ? ' ⚠门控' : '');
}
function fmt(x){return Math.round(x*100)/100;}

function renderSvg() {
  const svg = $('#graph-svg');
  svg.innerHTML = '';
  const g = state.graph; if (!g) return;
  const byId = Object.fromEntries(g.nodes.map((n) => [n.id, n]));
  const W = 210, H = 74, GAP_X = 60, GAP_Y = 26;
  const cols = new Map();
  for (const n of g.nodes) {
    if (!cols.has(n.rank)) cols.set(n.rank, []);
    cols.get(n.rank).push(n);
  }
  const ranks = [...cols.keys()].sort((a, b) => a - b);
  const maxRows = Math.max(...[...cols.values()].map((c) => c.length));
  svg.setAttribute('viewBox', `0 0 ${(ranks.length) * (W + GAP_X) + 40} ${maxRows * (H + GAP_Y) + 40}`);
  const pos = new Map();
  ranks.forEach((rk, ci) => {
    const col = cols.get(rk);
    col.forEach((n, ri) => {
      pos.set(n.id, { x: 30 + ci * (W + GAP_X), y: 20 + ri * (H + GAP_Y) });
    });
  });

  // edges first
  for (const e of g.edges) {
    const a = pos.get(e.from), b = pos.get(e.to); if (!a || !b) continue;
    const path = document.createElementNS(SVGNS, 'path');
    const x1 = a.x + W, y1 = a.y + H / 2, x2 = b.x, y2 = b.y + H / 2;
    const mx = (x1 + x2) / 2;
    path.setAttribute('d', `M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}`);
    path.setAttribute('class', e.kind === 'weak' ? 'edge-weak' : 'edge-hard');
    path.dataset.from = e.from; path.dataset.to = e.to;
    svg.appendChild(path);
  }

  for (const n of g.nodes) {
    const p = pos.get(n.id);
    const gEl = document.createElementNS(SVGNS, 'g');
    gEl.setAttribute('class', `node-card ${n.prerequisite_status === 'blocked' ? 'blocked' : ''}`);
    gEl.setAttribute('transform', `translate(${p.x},${p.y})`);
    gEl.onclick = () => selectNode(n.id);
    const rect = document.createElementNS(SVGNS, 'rect');
    rect.setAttribute('width', W); rect.setAttribute('height', H);
    gEl.appendChild(rect);
    const t = document.createElementNS(SVGNS, 'text');
    t.setAttribute('x', 10); t.setAttribute('y', 22); t.setAttribute('class', 'ntitle');
    t.textContent = n.title.length > 12 ? n.title.slice(0, 11) + '…' : n.title;
    gEl.appendChild(t);
    const m = document.createElementNS(SVGNS, 'text');
    m.setAttribute('x', 10); m.setAttribute('y', 44); m.setAttribute('class', 'nmeta');
    m.textContent = levelOrPoints(n);
    gEl.appendChild(m);
    const c = document.createElementNS(SVGNS, 'circle');
    c.setAttribute('cx', W - 18); c.setAttribute('cy', 18); c.setAttribute('r', 7);
    c.setAttribute('fill', `var(--${LVL_CLASS[n.level].replace('lvl-','')})`);
    if (state.mode === 'evidence') c.setAttribute('fill', '#8892c8');
    gEl.appendChild(c);
    if (n.prerequisite_status === 'blocked') {
      const b = document.createElementNS(SVGNS, 'text');
      b.setAttribute('x', W - 44); b.setAttribute('y', 22); b.setAttribute('class', 'badge');
      b.setAttribute('fill', 'var(--danger)'); b.textContent = 'BLOCKED';
      gEl.appendChild(b);
    }
    svg.appendChild(gEl);
  }
}

async function selectNode(id) {
  state.selected = id;
  const g = state.graph;
  // 高亮命中边
  document.querySelectorAll('.edge-hard,.edge-weak').forEach((p) => {
    p.classList.toggle('edge-hit', p.dataset.to === id);
  });
  showDetail(id);
}

async function showDetail(idOrSlug, mount) {
  const panel = mount || $('#detail-panel');
  try {
    const d = await api(`/api/nodes/${idOrSlug}?version=${state.rule}`);
    panel.innerHTML = detailHtml(d);
    panel.querySelectorAll('[data-pathfrom]').forEach(async (el) => {
      const from = el.dataset.pathfrom, to = d.node_id;
      try {
        const p = await api(`/api/paths/${from}/${to}?kind=hard`);
        el.querySelector('.path-box').innerHTML =
          `📍 <b>可定位前置路径</b>（共 ${p.count} 条）：<br>` +
          p.all_paths_titles.slice(0, 5).map((row, i) => `${i + 1}. ${row.join(' → ')}`).join('<br>');
      } catch (_) {}
    });
    panel.querySelectorAll('[data-affected]').forEach(async (el) => {
      const a = await api(`/api/affected/${d.node_id}`);
      el.querySelector('.path-box').innerHTML = `🔁 <b>本节点变化后沿依赖图重算顺序</b>：<br>${
        a.affected.map((x, i) => `${i}. ${x.title} <span class="kv">[${LVL_TEXT[x.level] || x.level || '—'}]</span>`).join(' → ')}`;
    });
  } catch (err) {
    if (err.status === 410 && err.body?.merged_into) showDetail(err.body.merged_into, panel);
    else panel.innerHTML = `<div class="hint err">${err.message}</div>`;
  }
}

function detailHtml(d) {
  const evidenceMode = state.mode === 'evidence';
  const evidences = d.evidence.filter((e) => e.kind === 'verifiable');
  const evHtml = evidences.length ? evidences.map((e) => `
    <div class="ev-item ${e.active === false ? 'inactive' : ''}">
      <span class="pts ${!e.points ? 'ptszero' : ''}">+${fmt(e.points)}</span>
      <div class="ev-title">${escapeHtml(e.title)}
        <span class="tag verifiable">${e.subtype || '成果'}</span>
        ${e.inherited ? '<span class="tag inh">继承</span>' : ''}
        ${e.active === false ? `<span class="tag off">${({ withdrawn: '已撤下', expired: '已到期' })[e.inactive_reason] || '失效'}</span>` : ''}
      </div>
      <div class="ev-meta">${e.issuer ? `颁发/来源：${escapeHtml(e.issuer)}` : ''}${e.url ? ` · <a href="${escapeHtml(e.url)}" target="_blank" rel="noopener">链接</a>` : ''}</div>
      ${e.inherited ? `<div class="ev-meta">继承自前置节点（×0.5），依据链：${(e.path || []).join(' → ')}</div>` : ''}
    </div>`).join('') : '<div class="kv">暂无可验证成果</div>';

  const selfHtml = d.self ? `
    <div class="ev-item">
      <span class="pts ${!d.self.bonus ? 'ptszero' : ''}">+${d.self.bonus}（封顶1）</span>
      <div class="ev-title">${escapeHtml(d.self.title)}<span class="tag self">自评分</span></div>
      <div class="ev-meta">自评等级：${LVL_TEXT[d.self.claimed_level] || d.self.claimed_level}；置信度：${Math.round((d.self.confidence ?? 0) * 100)}%
        ${d.self.counted ? '' : ' · <span class="tag off">未计入</span>'}</div>
      ${d.self.note ? `<div class="ev-meta err">${d.self.note}</div>` : ''}
    </div>` : '<div class="kv">暂无自评分</div>';

  const planHtml = d.plans.length ? d.plans.map((p) => `
    <div class="ev-item">
      <div class="ev-title">${escapeHtml(p.title)}<span class="tag plan">计划</span><span class="tag">不计点</span></div>
      <div class="ev-meta">目标：${LVL_TEXT[p.target_level] || p.target_level}${p.target_on ? ` · 计划完成 ${p.target_on}` : ''}</div>
    </div>`).join('') : '<div class="kv">暂无计划目标</div>';

  const gateHtml = evidenceMode ? '' : `
    <div class="section3">
      <h3>前置依赖评估</h3>
      <div>
        <span class="chip ${d.prerequisite_status === 'blocked' ? 'block' : d.prerequisite_status === 'gap_warning' ? 'gap' : ''}">
          ${({ satisfied: '前置满足', blocked: '被前置门控', gap_warning: '弱前置有缺口' })[d.prerequisite_status]}
        </span>
        <span class="kv">原始判定 ${LVL_TEXT[d.raw_level]}(${fmt(d.raw_points)}点)${d.gated ? '，门控封顶至「可应用」' : ''}</span>
      </div>
      ${d.blockers.map((b) => `
        <div class="ev-item blocker" data-pathfrom="${b.node_id}">
          <div class="ev-title">⛔ ${escapeHtml(b.title)} <span class="tag off">硬前置缺口</span></div>
          <div class="ev-meta">当前 ${LVL_TEXT[b.level]}(${fmt(b.points)}点)，要求 ≥ ${LVL_TEXT[b.required_level]} 且 ≥ ${b.required_points}点</div>
          <div class="path-box">正在定位依赖路径…</div>
        </div>`).join('')}
      ${d.gaps.map((b) => `
        <div class="ev-item gapbox">
          <div class="ev-title">△ ${escapeHtml(b.title)} <span class="tag plan">弱前置</span></div>
          <div class="ev-meta">当前 ${LVL_TEXT[b.level]}(${fmt(b.points)}点)，不门控，仅提示建议补强</div>
        </div>`).join('')}
    </div>`;

  return `
    <h2>${escapeHtml(d.title)}</h2>
    <div>
      <span class="chip ${LVL_CLASS[d.level]}">${evidenceMode ? '证据强度视图（不判级）' : LVL_TEXT[d.level]}</span>
      <span class="kv">规则 <b>v${d.rule_version}</b> · 直接 ${fmt(d.points.direct_verifiable)} + 继承 ${fmt(d.points.inherited_verifiable)} + 自评 ${d.points.self_bonus} = <b>${fmt(d.points.total)}</b></span>
    </div>
    <p class="dp-desc">${escapeHtml(d.description || '')}（该等级为规则化自评成熟度，非客观认证）</p>
    <div class="section3"><h3>① 可验证成果 ${evidenceMode ? '' : `（${evidences.filter((e) => e.active !== false).length} 条有效）`}</h3>${evHtml}</div>
    <div class="section3"><h3>② 自评分（独立信号，不与成果混为总分）</h3>${selfHtml}</div>
    <div class="section3"><h3>③ 计划目标（路线图，不参与定级）</h3>${planHtml}</div>
    ${gateHtml}
    <div class="section3" data-affected="1"><h3>重新评估影响范围</h3><div class="path-box">计算中…</div></div>
  `;
}

function renderMobile() {
  const mount = $('#mobile-layers');
  if (!state.graph) return;
  const desktopVisible = $('#desktop-view').getBoundingClientRect &&
    $('#desktop-view').checkVisibility ? $('#desktop-view').checkVisibility() : $('#desktop-view').style.display !== 'none';
  if (desktopVisible && window.innerWidth > 860) return;
  const cols = new Map();
  for (const n of state.graph.nodes) {
    if (!cols.has(n.rank)) cols.set(n.rank, []);
    cols.get(n.rank).push(n);
  }
  mount.innerHTML = [...cols.entries()].sort((a, b) => a[0] - b[0]).map(([rk, ns], i) => `
    <details class="mlayer" ${i < 2 ? 'open' : ''}>
      <summary><span>第 ${rk + 1} 层 · ${ns.map((n) => n.title).join(' / ')}</span><span>${ns.length} 项</span></summary>
      ${ns.map((n) => `
        <details class="mnode">
          <summary>
            <span class="dot ${LVL_CLASS[n.level]}"></span>
            <span class="mnode-title">${n.title}</span>
            <div class="ev-meta">${levelOrPoints(n)} ${n.prerequisite_status === 'blocked' ? '· ⛔前置缺口' : ''}</div>
            <div class="ev-meta">前置：${n.parents.length ? n.parents.map((p) => {
              const pn = state.graph.nodes.find((x) => x.id === p.id);
              return (p.kind === 'weak' ? '△' : '') + (pn ? pn.title : p.id);
            }).join('，') : '无'}</div>
          </summary>
          <div class="mnode-body" data-node="${n.id}"><div class="hint">加载中…</div></div>
        </details>`).join('')}
    </details>`).join('');
  mount.querySelectorAll('.mnode').forEach((el) => {
    el.addEventListener('toggle', function () {
      if (this.open) {
        const body = this.querySelector('.mnode-body');
        if (body.dataset.loaded) return;
        body.dataset.loaded = '1';
        showDetail(body.dataset.node, body);
      }
    });
  });
}

async function loadExports() {
  const list = await api('/api/exports');
  $('#export-list').innerHTML = list.length ? '历史图（不可变快照，保留当时依据）：' +
    list.slice(0, 6).map((x) => `<a href="/snapshot.html?id=${x.id}">📦 ${x.title.replace(/</g, '')} · v${x.rule_version}</a>`).join(' | ')
    : '';
}
function escapeHtml(s){return String(s ?? '').replace(/[&<>"']/g,(c)=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
init().catch((e) => toast(e.message, true));
