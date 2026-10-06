'use strict';
/* jsdom 冒烟：加载真实页面与脚本（指向运行中的服务器），验证桌面图渲染、详情三区、移动折叠与私密隔离 */
const { JSDOM } = require('jsdom');
const fs = require('fs');
const path = require('path');

const BASE = process.env.BASE || 'http://localhost:3000';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getText(p) { return await (await fetch(BASE + p)).text(); }

async function main() {
  const html = await getText('/');
  const dom = new JSDOM(html, {
    url: BASE + '/',
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  });
  const { window } = dom;
  window.matchMedia = window.matchMedia || (() => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }));
  window.fetch = (u, o) => fetch(u.startsWith('http') ? u : BASE + u, o);
  window.Request = Request; window.Headers = Headers; window.Response = Response;
  window.eval(await getText('/js/app.js'));
  await sleep(600);
  const doc = window.document;
  const cards = doc.querySelectorAll('#graph-svg g.node-card');
  const edges = doc.querySelectorAll('#graph-svg path.edge-hard,#graph-svg path.edge-weak');
  console.log('desktop nodes rendered:', cards.length, 'edges:', edges.length);
  if (cards.length < 7) throw new Error('desktop graph did not render all nodes');
  if (!doc.querySelector('#rule-banner').textContent.includes('1.0.0')) throw new Error('rule banner missing');

  // click a node (fullstack = last-ish card) -> detail panel gets three sections
  const g = await (await fetch(BASE + '/api/graph')).json();
  const fsNode = g.nodes.find((n) => n.slug === 'fullstack');
  // trigger by calling selectNode indirectly: dispatch click on the card matching position
  // find card via order in svg = graph nodes order
  const idx = g.nodes.indexOf(fsNode);
  cards[idx].dispatchEvent(new window.Event('click', { bubbles: true }));
  await sleep(300);
  const panel = doc.querySelector('#detail-panel').textContent;
  for (const kw of ['① 可验证成果', '② 自评分', '③ 计划目标', '重新评估影响范围']) {
    if (!panel.includes(kw)) throw new Error('detail missing: ' + kw);
  }
  if (/TOPSECRET|内部系统截图/.test(panel)) throw new Error('PRIVATE TITLE LEAKED IN UI');
  console.log('detail panel three sections OK; no private title');

  // evidence-only mode: hides level verdict
  doc.querySelector('#mode-evidence').click();
  await sleep(100);
  if (!doc.querySelector('#rule-banner').textContent.includes('仅证据强度')) throw new Error('mode switch failed');
  console.log('evidence-only mode toggle OK');

  // mobile layers
  window.innerWidth = 500;
  // emulate resize path manually: force renderMobile by setting desktop hidden is hard;
  // instead directly verify mobile markup builder by toggling the mobile view hidden attr
  doc.querySelector('#desktop-view').style.display = 'none';
  doc.querySelector('#mobile-view').hidden = false;
  window.eval(`(${renderMobileTrigger.toString()})()`);
  await sleep(400);
  const layers = doc.querySelectorAll('#mobile-layers details.mlayer');
  console.log('mobile layer groups:', layers.length);
  if (layers.length < 3) throw new Error('mobile layers missing');

  // snapshot page
  const exportsList = await (await fetch(BASE + '/api/exports')).json();
  const sdom = new JSDOM(await getText('/snapshot.html?id=' + exportsList[0].id), {
    url: BASE + '/snapshot.html?id=' + exportsList[0].id, runScripts: 'outside-only', pretendToBeVisual: true,
  });
  sdom.window.fetch = (u, o) => fetch(u.startsWith('http') ? u : BASE + u, o);
  sdom.window.eval(await getText('/js/snapshot.js'));
  await sleep(300);
  const stext = sdom.window.document.querySelector('#box').textContent;
  if (!stext.includes('不可变') && !stext.includes('1.0.0')) throw new Error('snapshot render failed');
  console.log('snapshot viewer OK, rule pinned:', /规则版本\s*v?1\.0\.0/.test(stext));
  console.log('UI SMOKE OK');
}
function renderMobileTrigger() {
  // app.js 暴露的内部函数在 eval 作用域内不可直接访问；派发 resize 即可触发 debounce 重绘
  window.dispatchEvent(new Event('resize'));
}
main().catch((e) => { console.error('UI SMOKE FAIL', e); process.exit(1); });
