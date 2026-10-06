let frozen = null;
function now() { return frozen ? new Date(frozen) : new Date(); }
function nowIso() { return now().toISOString(); }
function freeze(iso) { frozen = iso; }
function reset() { frozen = null; }
module.exports = { now, nowIso, freeze, reset };
