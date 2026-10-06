'use strict';

// 演示数据：多父依赖图 + 一份证据支持多个技能 + 公开/私密证据。
const { run, get, flush, genId } = require('./db');
const rules = require('./rules');
const worker = require('./worker');

function seed() {
  if (get(`SELECT 1 FROM nodes LIMIT 1`)) return false;
  const now = Date.now();
  const day = 864e5;

  const addNode = (id, title, description) =>
    run(`INSERT INTO nodes (id,title,description,created_at) VALUES (?,?,?,?)`, [id, title, description, now]);
  const addEdge = (p, c) =>
    run(`INSERT INTO edges (id,parent_id,child_id,created_at) VALUES (?,?,?,?)`, [genId('edge'), p, c, now]);
  const addEv = (e) =>
    run(
      `INSERT INTO evidence (id,title,ev_kind,url,is_public,status,valid_from,valid_to,detail,created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [e.id, e.title, e.kind, e.url || '', e.pub === false ? 0 : 1, e.status || 'active',
       e.from || null, e.to || null, e.detail || '', now]
    );
  const link = (ev, node) =>
    run(`INSERT INTO evidence_nodes (evidence_id,node_id,created_at) VALUES (?,?,?)`, [ev, node, now]);
  const rating = (node, score, note, pub = true) =>
    run(`INSERT INTO self_ratings (id,node_id,score,note,is_public,rated_at,created_at)
        VALUES (?,?,?,?,?,?,?)`, [genId('rate'), node, score, note, pub ? 1 : 0, now, now]);
  const plan = (node, title, target, pub = true) =>
    run(`INSERT INTO plans (id,node_id,title,target_date,status,is_public,created_at)
        VALUES (?,?,?,?, 'open', ?, ?)`, [genId('plan'), node, title, target, pub ? 1 : 0, now]);

  // 节点（能力允许多父）
  addNode('js', 'JavaScript 基础', '语言核心与异步模型');
  addNode('ts', 'TypeScript', '类型系统与工程化');
  addNode('css', 'CSS / 布局', '响应式、Grid/Flex');
  addNode('node', 'Node.js 服务端', 'HTTP、数据库、作业队列');
  addNode('react', 'React 前端', '组件模型与状态管理');
  addNode('fullstack', '全栈应用交付', '端到端独立交付能力（父：node/react）');
  addNode('graphviz', '图数据建模', 'DAG、环检测、传播重算');

  // 边（前置 -> 后置）；fullstack 多父
  addEdge('js', 'ts');
  addEdge('js', 'node');
  addEdge('js', 'react');
  addEdge('ts', 'react');
  addEdge('css', 'react');
  addEdge('node', 'fullstack');
  addEdge('react', 'fullstack');
  addEdge('graphviz', 'fullstack');
  addEdge('node', 'graphviz');

  // 证据
  addEv({ id: 'ev_cert_js', title: 'JavaScript 高级程序认证（示例）', kind: 'cert', url: 'https://example.org/cert/js', to: now + 400 * day });
  link('ev_cert_js', 'js');

  addEv({ id: 'ev_oss', title: '开源 DAG 工具库（示例仓库）', kind: 'artifact', url: 'https://example.org/repo/dagkit' });
  // 一份证据支持多个技能
  link('ev_oss', 'graphviz');
  link('ev_oss', 'node');

  addEv({ id: 'ev_app', title: '全栈任务看板上线项目（示例）', kind: 'work', url: 'https://example.org/projects/board' });
  link('ev_app', 'fullstack');

  addEv({ id: 'ev_old_cert', title: '已过期的 Node 证书（示例，演示到期传播）', kind: 'cert', url: 'https://example.org/cert/old-node', status: 'expired', to: now - 30 * day });
  link('ev_old_cert', 'node');

  addEv({ id: 'ev_private', title: '【私密】内部绩效评审记录', kind: 'assessment', pub: false, detail: '公开页只能看到存在性，标题不暴露' });
  link('ev_private', 'fullstack');

  // 自评分与计划（三类信息分开）
  rating('js', 4, '能独立排查事件循环相关问题');
  rating('node', 4, '做过服务端 API 与异步作业', false);
  rating('react', 3, '熟悉 hooks，大型状态管理仍在练');
  plan('ts', '完成严格模式迁移', now + 90 * day);
  plan('graphviz', '补一篇环检测算法笔记', now + 30 * day, false);

  // 两个规则版本：v1 激活，v2 已定义未激活
  const v1 = rules.RULE_SPECS[rules.V1];
  const v2 = rules.RULE_SPECS[rules.V2];
  run(`INSERT INTO rule_versions (version,approach,spec,note,active,activated_at) VALUES (?,?,?,?,1,?)`,
    [rules.V1, v1.approach, JSON.stringify(v1), v1.note, now]);
  run(`INSERT INTO rule_versions (version,approach,spec,note,active) VALUES (?,?,?,?,0)`,
    [rules.V2, v2.approach, JSON.stringify(v2), v2.note]);
  run(`INSERT INTO rule_versions (version,approach,spec,note,active) VALUES (?,?,?,?,0)`,
    ['0.9.0-evidence-only', rules.EVIDENCE_ONLY_SPEC.approach, JSON.stringify(rules.EVIDENCE_ONLY_SPEC),
     '对照方案：只展示证据强度、不做汇总（未采用）']);

  // 初始全量评估
  const nodes = ['js', 'ts', 'css', 'node', 'react', 'fullstack', 'graphviz'];
  rules.recompute(nodes, rules.V1, { now, note: '初始评估' });
  flush();
  return true;
}

module.exports = { seed };
