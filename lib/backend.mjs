const MAX_NAME = 20;
const MAX_DATA_BYTES = 24000;

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing environment variable: ${name}`);
  return value;
}

function cleanName(value) {
  return Array.from(String(value || "").trim().normalize("NFKC"))
    .slice(0, MAX_NAME)
    .join("");
}

function nameKey(value) {
  return cleanName(value).toLocaleLowerCase("nl-NL");
}

function validPin(value) {
  return /^[0-9]{4}$/.test(String(value || ""));
}

function bytesToHex(bytes) {
  return Array.from(new Uint8Array(bytes), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

export async function hashPin(name, pin) {
  const pepper = requiredEnv("PIN_PEPPER");
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(pepper),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(`numberNinja:v2:${nameKey(name)}:${pin}`),
  );
  return bytesToHex(digest);
}

export function sameSecret(left, right) {
  if (
    typeof left !== "string" ||
    typeof right !== "string" ||
    left.length !== right.length
  ) {
    return false;
  }
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

function supabaseHeaders(extra = {}) {
  const key = requiredEnv("SUPABASE_SERVICE_ROLE_KEY");
  return {
    apikey: key,
    authorization: `Bearer ${key}`,
    "content-type": "application/json",
    ...extra,
  };
}

async function supabase(path, options = {}) {
  const base = requiredEnv("SUPABASE_URL").replace(/\/$/, "");
  const response = await fetch(`${base}/rest/v1/${path}`, {
    ...options,
    headers: supabaseHeaders(options.headers),
  });
  if (!response.ok) {
    const detail = await response.text();
    const error = new Error(`Supabase request failed (${response.status})`);
    error.status = response.status;
    error.detail = detail;
    throw error;
  }
  if (response.status === 204) return null;
  return response.json();
}

export async function findPlayer(name) {
  const rows = await supabase(
    `players?name_key=eq.${encodeURIComponent(nameKey(name))}&select=name_key,display_name,pin_hash,data,created_at,updated_at&limit=1`,
  );
  return rows[0] || null;
}

export async function createPlayer(name, pinHash) {
  const rows = await supabase("players?select=name_key,display_name,pin_hash,data,created_at,updated_at", {
    method: "POST",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify({
      name_key: nameKey(name),
      display_name: cleanName(name),
      pin_hash: pinHash,
      data: null,
    }),
  });
  return rows[0];
}

export async function savePlayer(name, data) {
  const payload = JSON.stringify(data || {});
  if (new TextEncoder().encode(payload).byteLength > MAX_DATA_BYTES) {
    const error = new Error("data_too_big");
    error.code = "data_too_big";
    throw error;
  }
  await supabase(`players?name_key=eq.${encodeURIComponent(nameKey(name))}`, {
    method: "PATCH",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({ data: data || {}, updated_at: new Date().toISOString() }),
  });
}

export async function listPlayers() {
  return supabase(
    "players?select=display_name,created_at,updated_at,data&order=updated_at.desc&limit=10000",
  );
}

export function validateCredentials(name, pin) {
  const cleaned = cleanName(name);
  if (!cleaned) return { ok: false, error: "name_required" };
  if (!validPin(pin)) return { ok: false, error: "pin_must_be_4_digits" };
  return { ok: true, name: cleaned, pin: String(pin) };
}

export function json(data, status = 200) {
  return Response.json(data, {
    status,
    headers: {
      "cache-control": "no-store",
      "content-type": "application/json; charset=utf-8",
    },
  });
}
