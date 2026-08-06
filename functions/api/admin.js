/*
 * Cloudflare Pages Function — Number Ninja admin stats
 * Route: /api/admin   (this file lives at functions/api/admin.js)
 *
 * Read-only. Walks every player record in NINJA_KV and returns platform stats.
 * Gated by a secret: set ADMIN_TOKEN as an environment variable on the Pages
 * project. Requests must send it as the  x-admin-token  header or a ?token=  query.
 *
 * If ADMIN_TOKEN is not set, the endpoint refuses to run (fails closed).
 */

const DAY = 86400000;

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

// constant-time-ish compare so the token can't be timing-probed
function sameToken(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function onRequestGet(context) {
  const { request, env } = context;
  if (!env.NINJA_KV) return json({ ok: false, error: "server_not_configured" }, 500);
  if (!env.ADMIN_TOKEN) return json({ ok: false, error: "admin_not_configured" }, 503);

  const url = new URL(request.url);
  const token = request.headers.get("x-admin-token") || url.searchParams.get("token") || "";
  if (!sameToken(token, env.ADMIN_TOKEN)) return json({ ok: false, error: "unauthorized" }, 401);

  // 1) collect every player key (paginated)
  const names = [];
  let cursor;
  for (let guard = 0; guard < 100; guard++) {
    const res = await env.NINJA_KV.list({ prefix: "player:", cursor });
    for (const k of res.keys) names.push(k.name);
    if (res.list_complete || !res.cursor) break;
    cursor = res.cursor;
  }

  // 2) read each record (bounded concurrency so we stay well inside limits)
  const now = Date.now();
  let active = 0, neverSaved = 0, active7 = 0, active30 = 0, new7 = 0, new30 = 0;
  let totalSolved = 0, maxLevel = 0;
  const roster = [];
  const CONC = 25;
  for (let i = 0; i < names.length; i += CONC) {
    const recs = await Promise.all(
      names.slice(i, i + CONC).map(async (name) => {
        const raw = await env.NINJA_KV.get(name);
        return { name, rec: raw ? JSON.parse(raw) : null };
      })
    );
    for (const { name, rec } of recs) {
      if (!rec) continue;
      const created = rec.created || 0;
      const updated = rec.updated || created;
      if (created > now - 7 * DAY) new7++;
      if (created > now - 30 * DAY) new30++;
      const d = rec.data;
      if (d) {
        active++;
        if (updated > now - 7 * DAY) active7++;
        if (updated > now - 30 * DAY) active30++;
        const solved = d.progress && d.progress.solved ? Object.keys(d.progress.solved).length : 0;
        totalSolved += solved;
        if ((d.level || 0) > maxLevel) maxLevel = d.level || 0;
        roster.push({ name: name.replace(/^player:/, ""), updated, created, level: d.level || 1, coins: d.coins || 0, solved });
      } else {
        neverSaved++;
      }
    }
  }
  roster.sort((a, b) => b.updated - a.updated);

  return json({
    ok: true,
    generated: now,
    total: names.length,   // names ever claimed
    active,                // have saved progress at least once
    neverSaved,            // claimed a name, never saved
    active7, active30,     // active (saved) in the last 7 / 30 days
    new7, new30,           // accounts created in the last 7 / 30 days
    totalSolved,           // problems solved across all players
    maxLevel,
    roster: roster.slice(0, 100),
  });
}
