// Node test for functions/api/admin.js — mock KV, assert the stats math + auth.
const { webcrypto } = require('crypto'); if (!global.crypto) global.crypto = webcrypto;
const admin = require('./functions/api/admin.js');

const DAY = 86400000, now = Date.now();
// mock KV populated with a known mix of players
const store = new Map();
function put(name, rec) { store.set(name, JSON.stringify(rec)); }
put('player:ray',  { created: now - 40*DAY, updated: now - 1*DAY,  data: { level: 4, coins: 300, progress: { solved: { a:1, b:1, c:1 } } } });
put('player:nova', { created: now - 3*DAY,  updated: now - 3*DAY,  data: { level: 2, coins: 50,  progress: { solved: { a:1 } } } });
put('player:old',  { created: now - 200*DAY, updated: now - 90*DAY, data: { level: 6, coins: 900, progress: { solved: { a:1, b:1 } } } });
put('player:ghost',{ created: now - 2*DAY,  updated: now - 2*DAY,  data: null });   // claimed, never saved
const KV = {
  async list({ prefix, cursor }) {
    const keys = [...store.keys()].filter(k => k.startsWith(prefix)).map(name => ({ name }));
    return { keys, list_complete: true, cursor: undefined };
  },
  async get(k) { return store.has(k) ? store.get(k) : null; },
};

let fails = 0;
const ck = (c, m, x) => { if (!c) { fails++; console.log('FAIL:', m, x || ''); } };

function req(headers, url) {
  return { request: { headers: { get: (h) => (headers || {})[h.toLowerCase()] || null }, url: url || 'https://x/api/admin' } };
}

(async () => {
  // no token configured -> fails closed
  let r = await admin.onRequestGet({ ...req({}), env: { NINJA_KV: KV } });
  ck(r.status === 503, 'no ADMIN_TOKEN -> 503');

  // wrong token -> 401
  r = await admin.onRequestGet({ ...req({ 'x-admin-token': 'nope' }), env: { NINJA_KV: KV, ADMIN_TOKEN: 'secret' } });
  ck(r.status === 401, 'wrong token -> 401');

  // right token via header -> stats
  r = await admin.onRequestGet({ ...req({ 'x-admin-token': 'secret' }), env: { NINJA_KV: KV, ADMIN_TOKEN: 'secret' } });
  ck(r.status === 200, 'right token -> 200');
  const j = JSON.parse(await r.text());
  ck(j.total === 4, 'total = 4', j.total);
  ck(j.active === 3, 'active = 3 (have data)', j.active);
  ck(j.neverSaved === 1, 'neverSaved = 1', j.neverSaved);
  ck(j.active7 === 2, 'active7 = 2 (ray + nova saved <7d)', j.active7);
  ck(j.active30 === 2, 'active30 = 2 (ray + nova; old is 90d)', j.active30);
  ck(j.new7 === 2, 'new7 = 2 (nova + ghost created <7d)', j.new7);
  ck(j.totalSolved === 6, 'totalSolved = 3+1+2', j.totalSolved);
  ck(j.maxLevel === 6, 'maxLevel = 6', j.maxLevel);
  ck(j.roster[0].name === 'ray', 'roster sorted by last-seen, ray first', j.roster[0] && j.roster[0].name);
  ck(j.roster.every(p => p.name.indexOf('player:') === -1), 'roster strips player: prefix');

  // token via query string also works
  r = await admin.onRequestGet({ ...req({}, 'https://x/api/admin?token=secret'), env: { NINJA_KV: KV, ADMIN_TOKEN: 'secret' } });
  ck(r.status === 200, 'query-string token works');

  console.log(fails === 0 ? 'ALL ADMIN TESTS PASSED' : fails + ' FAILURES');
  process.exit(fails ? 1 : 0);
})();
