// Random clicking and typing across the whole game: nothing may throw, hang or end up in two screens at once.
const { chromium, open, SHOTS } = require('./lib.cjs');

function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

async function run(browser, seed, steps) {
  const rand = rng(seed);
  const sizes = [[390, 844], [844, 390], [1024, 768], [1366, 768], [360, 640]];
  const c = await open(browser, { viewport: { width: 1024, height: 768 }, reducedMotion: seed % 2 === 0 });
  const p = c.page;
  const log = [];
  const bad = [];
  const visited = new Set();
  for (let i = 0; i < steps; i++) {
    const r = rand();
    try {
      if (r < 0.55) {
        const handles = await p.$$('button:not([disabled]), label.chip, label[for^="hero-"], select, input[type=checkbox]');
        const vis = [];
        for (const h of handles) if (await h.isVisible()) vis.push(h);
        if (vis.length) {
          const h = vis[Math.floor(rand() * vis.length)];
          const desc = await h.evaluate((e) => (e.id || e.className || e.tagName) + ':' + (e.textContent || '').trim().slice(0, 18));
          log.push('click ' + desc);
          await h.click({ timeout: 800, force: false }).catch(() => {});
        }
      } else if (r < 0.8) {
        const keys = ['Digit1', 'Digit7', 'Digit0', 'Backspace', 'Enter', 'Escape', 'Tab', 'Space', 'Digit9', 'Shift+Tab'];
        const k = keys[Math.floor(rand() * keys.length)];
        log.push('key ' + k);
        await p.keyboard.press(k);
      } else if (r < 0.86) {
        const name = ['Mo', 'Zoë', 'Bo-Bo', 'Anna Lisa', 'X'][Math.floor(rand() * 5)];
        const inp = await p.$('#in-name');
        if (inp && (await inp.isVisible())) { log.push('type name ' + name); await inp.fill(name); }
      } else if (r < 0.9) {
        const [w, h] = sizes[Math.floor(rand() * sizes.length)];
        log.push('resize ' + w + 'x' + h);
        await p.setViewportSize({ width: w, height: h });
      } else {
        await p.waitForTimeout(150 + Math.floor(rand() * 600));
      }
      const st = await p.evaluate(() => ({ visible: [...document.querySelectorAll('.screen:not([hidden])')].map((s) => s.id), screen: RR.UI.state.screen, heading: !!document.querySelector('.screen:not([hidden]) .screen-title'), dlg: document.getElementById('dlg-pause').open, phase: RR.UI.state.race && RR.UI.state.race.phase }));
      visited.add(st.screen);
      if (st.visible.length !== 1 || st.visible[0] !== 's-' + st.screen) bad.push(`step ${i}: visible screens ${st.visible} vs state ${st.screen} after ${log[log.length - 1]}`);
      if (!st.heading) bad.push(`step ${i}: no heading on ${st.screen}`);
      if (st.dlg && st.screen !== 'race') bad.push(`step ${i}: pause dialog open on ${st.screen}`);
    } catch (e) {
      bad.push(`step ${i}: ${String(e.message).split('\n')[0]}`);
    }
  }
  // after all that the game must still be usable: back to the start and into a race
  await p.evaluate(() => { const st = RR.UI.state.store; if (!st.players().length) st.addPlayer({ name: 'Eind', hero: 'egel', grade: 4 }); if (document.getElementById('dlg-pause').open) document.getElementById('dlg-pause').close(); RR.UI.show('spelers'); });
  const csp = await p.evaluate(() => window.__csp);
  await c.ctx.close();
  return { seed, problems: c.problems, bad, csp, visited: [...visited].sort().join(','), steps };
}

(async () => {
  const browser = await chromium.launch();
  const seeds = (process.argv[2] || '1,2,3,4').split(',').map(Number);
  const steps = Number(process.argv[3] || 350);
  const res = await Promise.all(seeds.map((s) => run(browser, s, steps)));
  let fail = 0;
  res.forEach((r) => {
    console.log(`seed ${r.seed}: ${r.steps} steps, screens visited: ${r.visited}`);
    if (r.problems.length) { fail++; console.log('  console/network problems:', r.problems.slice(0, 5)); }
    if (r.bad.length) { fail++; console.log('  bad states:', r.bad.slice(0, 8)); }
    if (r.csp.length) { fail++; console.log('  CSP:', r.csp); }
  });
  await browser.close();
  console.log(fail ? 'MONKEY FAILED' : 'monkey ok');
  process.exit(fail ? 1 : 0);
})();
