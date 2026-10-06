'use strict';
const id = new URLSearchParams(location.search).get('id');
const LVL_TEXT = { none: '暂无依据', foundational: '基础', applied: '可应用', proven: '有充分验证' };
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
(async () => {
  const res = await fetch(`/api/exports/${id}`);
  if (!res.ok) { document.querySelector('#box').textContent = '快照不存在'; return; }
  const x = await res.json();
  const s = x.snapshot;
  document.querySelector('#box').innerHTML = `
    <h2>${esc(x.title)}</h2>
    <p class="kv">导出于 ${x.created_at} ｜ 规则版本 <b>v${x.rule_version}</b> ｜ 指纹 <code>${x.fingerprint.slice(0,16)}…</code> ｜ 模式 ${s.mode}</p>
    ${s.nodes.map((n) => `
      <details class="mlayer" style="margin-top:.6rem">
        <summary><b>${esc(n.title)}</b>
          <span class="chip lvl-${n.level}">${LVL_TEXT[n.level]}</span>
          <span class="kv">直接 ${n.points.direct_verifiable} / 继承 ${n.points.inherited_verifiable} / 自评 ${n.points.self_bonus}</span>
        </summary>
        <div style="padding:.5rem 1rem">
          ${n.blockers.length ? `<div class="ev-item blocker"><div class="ev-title">⛔ 门控前置：${n.blockers.map((b)=>esc(b.title)).join('、')}</div>
            ${n.blockers.map((b)=>`<div class="path-box">${(b.path||[]).map(()=>'').join('')}${'路径：'}${(b.path||[]).join(' → ')}</div>`).join('')}</div>` : ''}
          <h3 class="section3">① 当时的可验证成果依据</h3>
          ${n.evidence.filter((e)=>e.kind==='verifiable').map((e)=>`
            <div class="ev-item ${e.active ? '' : 'inactive'}">
              <div class="ev-title">${esc(e.title)} <span class="tag verifiable">${esc(e.subtype||'成果')}</span>
                ${e.inherited?'<span class="tag inh">继承</span>':''}
                ${!e.active?`<span class="tag off">${({withdrawn:'已撤下',expired:'已到期'})[e.inactive_reason]||'失效'}</span>`:''}</div>
              <div class="ev-meta">计点 ${e.points}${e.inherited?` · 继承链 ${(e.path||[]).join(' → ')}`:''}</div>
            </div>`).join('') || '<div class="kv">无</div>'}
          <h3 class="section3">② 自评分</h3>
          ${n.self?`<div class="ev-item"><div class="ev-title">自评 ${LVL_TEXT[n.self.claimed_level]||''}，置信度 ${Math.round((n.self.confidence??0)*100)}%</div></div>`:'<div class="kv">无</div>'}
          <h3 class="section3">③ 计划</h3>
          ${n.plans.map((p)=>`<div class="ev-item"><div class="ev-title">${esc(p.title)} → ${LVL_TEXT[p.target_level]||p.target_level}（${p.target_on||''}）</div></div>`).join('') || '<div class="kv">无</div>'}
        </div>
      </details>`).join('')}
  `;
})();
