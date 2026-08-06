import {
  createPlayer,
  findPlayer,
  hashPin,
  json,
  sameSecret,
  savePlayer,
  validateCredentials,
} from "../lib/backend.mjs";

async function readBody(request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

export default {
  async fetch(request) {
    if (request.method === "GET") {
      return json({ ok: true, service: "nummers-ninja", storage: "supabase" });
    }
    if (request.method !== "POST") {
      return json({ ok: false, error: "method_not_allowed" }, 405);
    }

    const body = await readBody(request);
    if (!body) return json({ ok: false, error: "bad_request" }, 400);

    const credentials = validateCredentials(body.name, body.pin);
    if (!credentials.ok) return json({ ok: false, error: credentials.error }, 400);

    const { name, pin } = credentials;
    const pinHash = await hashPin(name, pin);

    try {
      let player = await findPlayer(name);

      if (body.action === "login") {
        if (!player) {
          try {
            player = await createPlayer(name, pinHash);
            return json({ ok: true, created: true, data: null });
          } catch (error) {
            if (error.status !== 409) throw error;
            player = await findPlayer(name);
          }
        }
        if (!player || !sameSecret(player.pin_hash, pinHash)) {
          return json({ ok: false, error: "wrong_pin" }, 403);
        }
        return json({ ok: true, created: false, data: player.data || null });
      }

      if (body.action === "report") {
        if (!player) return json({ ok: false, error: "no_such_player" }, 404);
        if (!sameSecret(player.pin_hash, pinHash)) {
          return json({ ok: false, error: "wrong_pin" }, 403);
        }
        return json({
          ok: true,
          data: player.data || null,
          updated: Date.parse(player.updated_at),
        });
      }

      if (body.action === "save") {
        if (!player) return json({ ok: false, error: "no_such_player" }, 404);
        if (!sameSecret(player.pin_hash, pinHash)) {
          return json({ ok: false, error: "wrong_pin" }, 403);
        }
        await savePlayer(name, body.data);
        return json({ ok: true });
      }

      return json({ ok: false, error: "unknown_action" }, 400);
    } catch (error) {
      if (error.code === "data_too_big") {
        return json({ ok: false, error: "data_too_big" }, 413);
      }
      console.error("player_api_error", error.message);
      return json({ ok: false, error: "service_unavailable" }, 503);
    }
  },
};
