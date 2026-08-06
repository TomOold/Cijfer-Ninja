import { json, listPlayers, sameSecret } from "../lib/backend.mjs";

const DAY = 86_400_000;

export default {
  async fetch(request) {
    if (request.method !== "GET") {
      return json({ ok: false, error: "method_not_allowed" }, 405);
    }

    const configuredToken = process.env.ADMIN_TOKEN || "";
    if (!configuredToken) {
      return json({ ok: false, error: "admin_not_configured" }, 503);
    }
    const url = new URL(request.url);
    const suppliedToken =
      request.headers.get("x-admin-token") || url.searchParams.get("token") || "";
    if (!sameSecret(suppliedToken, configuredToken)) {
      return json({ ok: false, error: "unauthorized" }, 401);
    }

    try {
      const players = await listPlayers();
      const now = Date.now();
      let active = 0;
      let neverSaved = 0;
      let active7 = 0;
      let active30 = 0;
      let new7 = 0;
      let new30 = 0;
      let totalSolved = 0;
      let maxLevel = 0;
      const roster = [];

      for (const player of players) {
        const created = Date.parse(player.created_at);
        const updated = Date.parse(player.updated_at);
        if (created > now - 7 * DAY) new7 += 1;
        if (created > now - 30 * DAY) new30 += 1;

        if (!player.data) {
          neverSaved += 1;
          continue;
        }

        active += 1;
        if (updated > now - 7 * DAY) active7 += 1;
        if (updated > now - 30 * DAY) active30 += 1;
        const solved = Object.keys(player.data.progress?.solved || {}).length;
        totalSolved += solved;
        maxLevel = Math.max(maxLevel, Number(player.data.level) || 1);
        roster.push({
          name: player.display_name,
          updated,
          created,
          level: Number(player.data.level) || 1,
          coins: Number(player.data.coins) || 0,
          solved,
        });
      }

      return json({
        ok: true,
        generated: now,
        total: players.length,
        active,
        neverSaved,
        active7,
        active30,
        new7,
        new30,
        totalSolved,
        maxLevel,
        roster: roster.slice(0, 100),
      });
    } catch (error) {
      console.error("admin_api_error", error.message);
      return json({ ok: false, error: "service_unavailable" }, 503);
    }
  },
};
