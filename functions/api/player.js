/*
 * Cloudflare Pages Function — Number Ninja save server
 * Route: /api/player   (this file lives at functions/api/player.js)
 *
 * Requires a KV namespace bound as  NINJA_KV  in the Pages project settings.
 * Stores one record per player, keyed by lowercased name.
 *
 * Actions (POST JSON):
 *   { action:"login", name, pin }            -> loads or creates the player
 *   { action:"save",  name, pin, data }      -> writes the player's progress
 *
 * PINs are never stored in plain text; we keep a salted SHA-256 hash only.
 */

const MAX_NAME = 20;
const MAX_DATA = 24000; // bytes — game state + learning stats, still blocks abuse

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function cleanName(n) {
  return String(n || "").trim().slice(0, MAX_NAME);
}
function keyFor(n) {
  return "player:" + cleanName(n).toLowerCase();
}
function validPin(p) {
  return /^[0-9]{4}$/.test(String(p || ""));
}

async function hashPin(name, pin) {
  const salt = "numberNinja:v1:" + cleanName(name).toLowerCase();
  const bytes = new TextEncoder().encode(salt + ":" + pin);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// constant-time-ish compare
function sameHash(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function onRequestPost(context) {
  const { request, env } = context;

  if (!env.NINJA_KV) {
    return json({ ok: false, error: "server_not_configured" }, 500);
  }

  let body;
  try {
    body = await request.json();
  } catch (e) {
    return json({ ok: false, error: "bad_request" }, 400);
  }

  const action = body.action;
  const name = cleanName(body.name);
  const pin = String(body.pin || "");

  if (!name) return json({ ok: false, error: "name_required" }, 400);
  if (!validPin(pin)) return json({ ok: false, error: "pin_must_be_4_digits" }, 400);

  const key = keyFor(name);
  const raw = await env.NINJA_KV.get(key);
  const record = raw ? JSON.parse(raw) : null;
  const pinHash = await hashPin(name, pin);

  if (action === "login") {
    if (!record) {
      // first time this name is used — claim it with this PIN
      const fresh = { pinHash, data: null, created: Date.now(), updated: Date.now() };
      await env.NINJA_KV.put(key, JSON.stringify(fresh));
      return json({ ok: true, created: true, data: null });
    }
    if (!sameHash(record.pinHash, pinHash)) {
      return json({ ok: false, error: "wrong_pin" }, 403);
    }
    return json({ ok: true, created: false, data: record.data || null });
  }

  if (action === "report") {
    // read-only: never creates an account (so a parent typo can't claim a name)
    if (!record) return json({ ok: false, error: "no_such_player" }, 404);
    if (!sameHash(record.pinHash, pinHash)) {
      return json({ ok: false, error: "wrong_pin" }, 403);
    }
    return json({ ok: true, data: record.data || null, updated: record.updated });
  }

  if (action === "save") {
    if (!record) return json({ ok: false, error: "no_such_player" }, 404);
    if (!sameHash(record.pinHash, pinHash)) {
      return json({ ok: false, error: "wrong_pin" }, 403);
    }
    let dataStr;
    try {
      dataStr = JSON.stringify(body.data || {});
    } catch (e) {
      return json({ ok: false, error: "bad_data" }, 400);
    }
    if (dataStr.length > MAX_DATA) return json({ ok: false, error: "data_too_big" }, 413);

    record.data = body.data || {};
    record.updated = Date.now();
    await env.NINJA_KV.put(key, JSON.stringify(record));
    return json({ ok: true });
  }

  return json({ ok: false, error: "unknown_action" }, 400);
}

// Friendly response for anyone opening the URL in a browser
export async function onRequestGet() {
  return json({ ok: true, service: "number-ninja", hint: "POST here with an action." });
}
