'use strict';

// sql.js（WASM SQLite）封装。
// sql.js 是内存数据库 + 显式持久化：每次写事务结束后 flush() 到文件。
// 单 Node 进程 + 一个串行写入队列即可保证事务原子性与并发安全。

const fs = require('fs');
const path = require('path');
const initSqlJs = require('sql.js');
const { SCHEMA } = require('./schema');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const DB_FILE = path.join(DATA_DIR, 'skills.sqlite');

let db = null;

// 简单的进程内串行队列（写临界区：检查类操作与写入必须整体互斥，
// 例如"先检测环再插边"必须原子完成，避免并发下双方同时通过检查）。
let chain = Promise.resolve();
function tx(fn) {
  const run = chain.then(() => fn());
  // 队列不因单次失败而断裂
  chain = run.then(
    () => {},
    () => {}
  );
  return run;
}

async function getDb() {
  if (db) return db;
  const SQL = await initSqlJs();
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (fs.existsSync(DB_FILE)) {
    const buf = fs.readFileSync(DB_FILE);
    db = new SQL.Database(buf);
  } else {
    db = new SQL.Database();
  }
  db.run(SCHEMA);
  return db;
}

function flush() {
  const data = db.export();
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, Buffer.from(data));
  fs.renameSync(tmp, DB_FILE);
}

function all(sql, params = []) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}
function get(sql, params = []) {
  return all(sql, params)[0] || null;
}
function run(sql, params = []) {
  db.run(sql, params);
}

function genId(prefix) {
  return prefix + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function audit(action, entity, entityId, detail) {
  run(
    `INSERT INTO audit_log (action, entity, entity_id, detail, created_at)
     VALUES (?,?,?,?,?)`,
    [action, entity || '', entityId || '', typeof detail === 'string' ? detail : JSON.stringify(detail), Date.now()]
  );
}

module.exports = { getDb, flush, all, get, run, tx, genId, audit, DB_FILE };
