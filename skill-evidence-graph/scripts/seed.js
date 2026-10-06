'use strict';
/* 演示数据：多父 DAG、共享证据、私密证据、将到期证书、计划目标 */
const { openDb } = require('../src/db');
const repo = require('../src/repository');
const engine = require('../src/engine');
const { exportGraph } = require('../src/exports');

openDb(process.env.SEG_DB || require('path').join(__dirname, '..', 'data.sqlite'));

const needSeed = repo.listNodes({ includeMerged: true }).length === 0;
if (!needSeed) { console.log('already seeded'); process.exit(0); }

function n(slug, title, description) { return repo.createNode({ slug, title, description }); }
const html = n('html', 'HTML/CSS 基础', '语义化标记与布局');
const js = n('js', 'JavaScript 核心', '语言模型、异步、DOM');
const dom = n('dom', '浏览器与 DOM', '事件、渲染、可访问性');
const fe = n('frontend', '前端工程', '组件化、构建、状态管理');
const d3 = n('dataviz', '数据可视化', 'D3/SVG、图层布局');
const node = n('nodejs', 'Node.js 服务端', 'HTTP、数据持久化');
const full = n('fullstack', '全栈开发', '前后端联调、数据建模');

// 多父：前端工程依赖 js/html/dom；可视化依赖 js/dom；全栈依赖 fe + node（多父）
repo.addEdge(html.id, fe.id, 'hard');
repo.addEdge(js.id, fe.id, 'hard');
repo.addEdge(dom.id, fe.id, 'hard');
repo.addEdge(js.id, d3.id, 'hard');
repo.addEdge(dom.id, d3.id, 'hard');
repo.addEdge(fe.id, full.id, 'hard');
repo.addEdge(node.id, full.id, 'hard');
repo.addEdge(html.id, dom.id, 'hard');
repo.addEdge(js.id, node.id, 'weak'); // 弱前置：提示不门控

// 证据
function ev(data, nodeIds) {
  const e = repo.createEvidence(data);
  nodeIds.forEach((x) => repo.linkEvidence(e.id, x));
  return e;
}
// 一份证据支持多个技能：同一开源项目同时支撑 frontend 与 node
const proj = ev({ kind: 'verifiable', title: '开源项目：实时看板（前端+API）', subtype: 'project',
  issuer: 'GitHub', url: 'https://example.com/dashboard', issued_on: '2025-03-01', private: 0 }, [fe.id, node.id]);
ev({ kind: 'verifiable', title: '技术博客：事件循环与异步调度', subtype: 'article', issued_on: '2024-09-10', private: 0 }, [js.id]);
ev({ kind: 'verifiable', title: '前端性能优化案例：LCP 3.8s→1.4s', subtype: 'work', issuer: '某 SaaS', issued_on: '2025-06-20', private: 0 }, [fe.id]);
ev({ kind: 'verifiable', title: 'MDN 学习路径证书', subtype: 'certificate', issuer: 'MDN',
  issued_on: '2023-01-10', expires_on: '2026-01-10', private: 0 }, [html.id]); // 已到期（按当前日期2026-10）
ev({ kind: 'verifiable', title: 'D3 分层图作品集（3 件）', subtype: 'project', issued_on: '2025-11-01', private: 0 }, [d3.id]);
ev({ kind: 'verifiable', title: '内部系统截图（仅属主可见的雇主证明）', subtype: 'work',
  issuer: '内部', issued_on: '2025-02-01', private: 1 }, [node.id]); // 私密证据
ev({ kind: 'verifiable', title: 'Express API 设计笔记', subtype: 'article', issued_on: '2025-08-15', private: 0 }, [node.id]);
ev({ kind: 'verifiable', title: '可访问性改造 PR 集', subtype: 'project', issued_on: '2024-05-01', private: 0 }, [dom.id]);

// 自评分（三类信息之一）
ev({ kind: 'self', title: '自评：前端工程可应用，置信度高', self_level: 2, self_confidence: 0.9, private: 0 }, [fe.id]);
ev({ kind: 'self', title: '自评：JS 核心可应用', self_level: 2, self_confidence: 0.7, private: 0 }, [js.id]);
ev({ kind: 'self', title: '自评：全栈基础（证据建设中）', self_level: 1, self_confidence: 0.6, private: 1 }, [full.id]);

// 计划目标（永不计点）
ev({ kind: 'plan', title: '计划：考取云开发者认证补强全栈', plan_target_level: 3, plan_target_on: '2027-06-30', private: 0 }, [full.id]);
ev({ kind: 'plan', title: '计划：发表可视化长文 2 篇', plan_target_level: 2, plan_target_on: '2027-03-01', private: 0 }, [d3.id]);

engine.recomputeAndPersist();
const x = exportGraph('初始导出 v1（2026-10-06 基线）');
console.log('seeded. export:', x.id, x.fingerprint.slice(0, 12));
