const crypto = require('crypto');

function id(prefix) {
  return `${prefix}_${crypto.randomBytes(6).toString('hex')}`;
}

function sha1(obj) {
  return crypto.createHash('sha1').update(typeof obj === 'string' ? obj : JSON.stringify(obj)).digest('hex');
}

// Simple deterministic JSON (sorted keys) for fingerprints / snapshots
function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${stableJson(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

const LEVELS = ['none', 'foundational', 'applied', 'proven'];
const LEVEL_INDEX = Object.fromEntries(LEVELS.map((l, i) => [l, i]));

function nowIso() {
  return new Date().toISOString();
}

function daysBetween(aIso, bIso) {
  return (new Date(bIso).getTime() - new Date(aIso).getTime()) / 86400000;
}

module.exports = { id, sha1, stableJson, LEVELS, LEVEL_INDEX, nowIso, daysBetween };
