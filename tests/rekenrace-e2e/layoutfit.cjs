// Fit probe for the race screen: plays real sums (long stories, long tips, long explanations) at one window size and
// reports, for the three phases ask / hint / explain, whether the screen scrolls or the Klaar / Volgende button is cut off.
// Used by play.cjs (scenario U) and on its own:
//   NODE_PATH=$(npm root -g) SIZES='[[1366,625],[390,740]]' N=30 node layoutfit.cjs
const { chromium, open, layoutAudit } = require('./lib.cjs');

// The window sizes the race screen has to fit at (laptops, tablets, phones in both directions).
const SIZES = [
  [1366, 768], [1366, 650], [1366, 625], [1280, 600], [1024, 768], [1024, 600], [844, 390], [667, 375],
  [390, 844], [390, 750], [390, 740], [390, 664], [375, 553], [360, 740], [360, 640], [320, 568]
];

// Runs in the page. Deterministic: every sum comes from a seeded generator, ties are broken by key.
// worst: the sums that need the most room (long story + long tip, long explanation, three-line tips of other kinds);
// spread: real stories spread evenly over all groups and levels (the same idea as the QA's storyfreq.cjs).
function pickInPage(arg) {
  const all = [];
  const F = RR.Questions.FOCI;
  for (let g = 3; g <= 6; g++) for (let l = 1; l <= 8; l++) for (let fi = 0; fi < F.length; fi++) for (let s = 1; s <= 8; s++) {
    RR.Questions.series({ grade: g, level: l, focus: F[fi] }, 10, RR.Rng.make(g * 977 + l * 31 + fi * 7919 + s)).forEach((q) => all.push(Object.assign({}, q)));
  }
  const seen = new Set();
  const uniq = all.filter((q) => (seen.has(q.key) ? false : seen.add(q.key)));
  const stories = uniq.filter((q) => q.text.indexOf('\n') >= 0);
  const others = uniq.filter((q) => q.text.indexOf('\n') < 0);
  const by = (list, fn, n) => list.slice().sort((a, b) => fn(b) - fn(a) || (a.key < b.key ? -1 : 1)).slice(0, n);
  const spread = (list, n) => { const step = Math.max(1, Math.floor(list.length / n)); return list.filter((_, i) => i % step === 0).slice(0, n); };
  const worst = [].concat(
    by(stories, (q) => q.text.length + q.hint.length, 3),
    by(stories, (q) => q.text.length, 2),
    by(stories, (q) => q.explain.length, 2),
    by(others, (q) => q.hint.length, 2),
    by(others, (q) => q.explain.length, 1)
  );
  const dedupe = (list) => { const s = new Set(); return list.filter((q) => (s.has(q.key) ? false : s.add(q.key))); };
  // exactly ten sums (one race) for the quick check in play.cjs: the hardest of every kind, then evenly spread stories
  const ten = dedupe([].concat(
    by(stories, (q) => q.text.length + q.hint.length, 3),
    by(stories, (q) => q.text.length, 1),
    by(stories, (q) => q.explain.length, 1),
    by(others, (q) => q.hint.length, 2),
    by(others, (q) => q.explain.length, 1),
    spread(stories.slice(Math.floor(stories.length / 3)), 4)
  )).slice(0, 10);
  return { worst: dedupe(worst), ten: ten, spread: spread(stories, arg.spread), stories: stories.length };
}

// Waits until the layout has settled: the scene fit is queued with requestAnimationFrame.
const settle = (page) => page.evaluate(() => new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(res, 40))))));

const measure = (page) => page.evaluate(() => {
  const s = document.getElementById('s-race');
  const ok = document.querySelector('.key-ok').getBoundingClientRect();
  const nx = document.getElementById('btn-next').getBoundingClientRect();
  const sc = document.querySelector('canvas.scene').getBoundingClientRect();
  const phase = s.dataset.phase;
  const btn = phase === 'explain' ? nx : ok;
  const doc = document.documentElement;
  const okEl = document.querySelector('.key-ok');
  return {
    d: s.scrollHeight - s.clientHeight,
    okClip: okEl.scrollWidth > okEl.clientWidth + 0.5,
    cut: Math.round(btn.bottom - innerHeight),
    page: doc.scrollHeight - innerHeight,
    scene: Math.round(sc.width),
    cls: doc.className
  };
});

// sums: array of questions. Each one is played as: look (ask), wrong answer (hint), wrong answer (explain), Volgende.
// opts.fast: stub the glide so the next sum appears at once (the layout does not depend on the glide).
async function probe(browser, vp, sums, opts = {}) {
  const mobile = vp[0] < 900;
  const { page, ctx, problems } = await open(browser, { viewport: { width: vp[0], height: vp[1] }, mobile, touch: mobile, reducedMotion: opts.reducedMotion !== false });
  const res = { size: vp.join('x'), sums: sums.length, ask: 0, hint: 0, explain: 0, cutAsk: 0, cutHint: 0, cutExplain: 0, audit: [], worstPx: 0, cls: '', minScene: 1e9, maxScene: 0, jump: 0, jumpExplain: 0, problems, examples: [] };
  await page.evaluate(() => { const st = RR.UI.state.store; const r = st.addPlayer({ name: 'Sien', hero: 'eekhoorn', grade: 5 }); st.select(r.player.id); RR.UI.show('menu'); });
  if (opts.fast !== false) await page.evaluate(() => { const sc = RR.UI.state.scene; sc.advanceTo = () => Promise.resolve(); });
  for (let r = 0; r * 10 < sums.length; r++) {
    const batch = sums.slice(r * 10, r * 10 + 10);
    while (batch.length < 10) batch.push(batch[batch.length % Math.max(1, sums.length)]);
    await page.evaluate((b) => { RR.Questions.series = () => b.map((q, i) => Object.assign({}, q, { key: q.key + '#' + i })); }, batch);
    await page.evaluate(() => RR.UI.show('menu'));
    await page.click('#s-menu [data-to="vrij"]');
    await page.click('[data-action="start-free"]');
    await page.waitForSelector('#s-race[data-phase="intro"]');
    await page.click('#btn-start');
    for (let i = 0; i < 10; i++) {
      await page.waitForFunction((n) => { const R = RR.UI.state.race; return R && R.index === n && R.phase === 'ask' && performance.now() >= (R.keysFrom || 0); }, i, { timeout: 25000 });
      const label = batch[i].key.slice(0, 40);
      const widths = [];     // the picture's width in the three phases of this one sum: it must not change within a sum
      const flag = (phase, m, tag) => {
        res.cls = m.cls;
        widths.push(m.scene);
        res.minScene = Math.min(res.minScene, m.scene); res.maxScene = Math.max(res.maxScene, m.scene);
        const bad = m.d > 1 || m.page > 0 || m.cut > 0.5 || (phase !== 'explain' && m.okClip);
        if (bad) { res[phase]++; res.worstPx = Math.max(res.worstPx, m.d); if (m.cut > 0.5) res['cut' + tag]++; if (res.examples.length < 3) res.examples.push(`${phase} ${label} d=${m.d} cut=${m.cut}`); }
        return bad;
      };
      await settle(page);
      flag('ask', await measure(page), 'Ask');
      if (opts.audit) (await layoutAudit(page)).forEach((f) => res.audit.length < 6 && res.audit.push(`ask ${label}: ${f}`));
      await page.keyboard.type('88888'); await page.keyboard.press('Enter');
      await settle(page);
      flag('hint', await measure(page), 'Hint');
      if (opts.audit) (await layoutAudit(page)).forEach((f) => res.audit.length < 6 && res.audit.push(`hint ${label}: ${f}`));
      await page.keyboard.type('88888'); await page.keyboard.press('Enter');
      await page.waitForSelector('#s-race[data-phase="explain"]');
      await settle(page);
      flag('explain', await measure(page), 'Explain');
      // ask -> tip must not move the picture (the room for the tip is reserved); the explanation may need more room than the keypad had
      res.jump = Math.max(res.jump, Math.abs(widths[0] - widths[1]));
      res.jumpExplain = Math.max(res.jumpExplain, Math.abs(widths[0] - widths[2]));
      if (opts.audit) (await layoutAudit(page)).forEach((f) => res.audit.length < 6 && res.audit.push(`explain ${label}: ${f}`));
      if (opts.shot && i === 0 && r === 0) { /* screenshots are taken by the caller through opts.onSum */ }
      await page.evaluate(() => { RR.UI.state.race.explainFrom = 0; });
      await page.keyboard.press('Enter');
    }
    await page.waitForSelector('#s-finish:not([hidden])', { timeout: 25000 });
  }
  await ctx.close();
  return res;
}

async function samples(browser, spread) {
  const { page, ctx } = await open(browser, { viewport: { width: 1024, height: 768 } });
  const s = await page.evaluate(pickInPage, { spread });
  await ctx.close();
  return s;
}

module.exports = { SIZES, probe, samples, settle, measure };

if (require.main === module) {
  (async () => {
    const browser = await chromium.launch();
    const sizes = JSON.parse(process.env.SIZES || JSON.stringify(SIZES));
    const N = parseInt(process.env.N || '30', 10);
    const mode = process.env.MODE || 'both';          // worst | spread | both
    const s = await samples(browser, N);
    const sums = (mode === 'spread' ? [] : s.worst).concat(mode === 'worst' ? [] : s.spread);
    console.log(`${s.stories} distinct stories; probing ${sums.length} sums (${s.worst.length} worst-case + ${mode === 'worst' ? 0 : s.spread.length} spread) per size`);
    for (const vp of sizes) {
      const r = await probe(browser, vp, sums, { audit: !!process.env.AUDIT, fast: process.env.FAST !== '0' });
      console.log(r.size, `[${r.cls}]`, JSON.stringify({ ask: r.ask, hint: r.hint, explain: r.explain, cutAsk: r.cutAsk, cutHint: r.cutHint, cutExplain: r.cutExplain, worstPx: r.worstPx, scene: r.minScene + '-' + r.maxScene, jump: r.jump, jumpExplain: r.jumpExplain, examples: r.examples, audit: r.audit }), r.problems.length ? 'PROBLEMS ' + JSON.stringify(r.problems.slice(0, 3)) : '');
    }
    await browser.close();
  })();
}
