// Worst-case texts: finds the longest questions, hints and explanations the generator can make and
// plays them through the real race screen at one viewport, auditing the layout in every phase.
const { chromium, open, createPlayer, layoutAudit } = require('./lib.cjs');

async function pickWorst(page) {
  return page.evaluate(() => {
    const all = [];
    const F = RR.Questions.FOCI;
    for (let g = 3; g <= 6; g++) for (let l = 1; l <= 8; l++) for (let fi = 0; fi < F.length; fi++) for (let s = 1; s <= 12; s++) {
      RR.Questions.series({ grade: g, level: l, focus: F[fi] }, 10, RR.Rng.make(g * 100003 + l * 1009 + fi * 31 + s)).forEach((q) => all.push(q));
    }
    const lines = (q) => q.explain.split('\n').length;
    const by = (fn, n) => all.slice().sort((a, b) => fn(b) - fn(a)).slice(0, n);
    const picks = [].concat(
      by((q) => (q.text.indexOf('\n') >= 0 ? q.text.length : 0), 3),
      by((q) => (q.text.indexOf('\n') < 0 ? q.text.length : 0), 2),
      by((q) => q.explain.length, 3),
      by((q) => lines(q) * 1000 + q.explain.length, 1),
      by((q) => q.hint.length, 2),
      by((q) => (q.answer >= 1000 ? q.text.length : 0), 1)
    );
    const seen = {};
    const out = [];
    picks.forEach((q) => { if (!seen[q.key]) { seen[q.key] = 1; out.push(Object.assign({}, q)); } });
    return { picks: out.slice(0, 10), total: all.length, longest: { text: Math.max.apply(null, all.map((q) => q.text.length)), explain: Math.max.apply(null, all.map((q) => q.explain.length)), hint: Math.max.apply(null, all.map((q) => q.hint.length)) } };
  });
}

async function run(browser, name, vp) {
  const { page, problems, ctx } = await open(browser, { viewport: { width: vp.width, height: vp.height }, mobile: vp.mobile, touch: vp.touch });
  const issues = [];
  await createPlayer(page, 'Sien', 'eekhoorn', 6);
  const worst = await pickWorst(page);
  while (worst.picks.length < 10) worst.picks.push(Object.assign({}, worst.picks[0], { key: 'x' + worst.picks.length }));
  await page.evaluate((picks) => { RR.Questions.series = () => picks.map((q) => Object.assign({}, q)); }, worst.picks);
  await page.click('#s-menu [data-to="vrij"]');
  await page.click('[data-action="start-free"]');
  await page.waitForSelector('#s-race[data-phase="intro"]');
  const audit = async (label, extra) => {
    await page.waitForTimeout(120);
    (await layoutAudit(page, extra)).forEach((f) => issues.push(`${name}/${label}: ${f}`));
  };
  await audit('intro');
  await page.click('#btn-start');
  for (let i = 0; i < 10; i++) {
    await page.waitForFunction((n) => { const R = RR.UI.state.race; return R && R.index === n && R.phase === 'ask' && performance.now() >= (R.keysFrom || 0); }, i, { timeout: 25000 });
    const q = worst.picks[i];
    const lbl = `sum${i + 1}[${q.key}]`;
    await audit(lbl + '-ask');
    for (const ch of '88888') await page.click(`#keypad [data-d="${ch}"]`);
    await audit(lbl + '-5digits');
    await page.click('#keypad [data-action="ok"]');
    await audit(lbl + '-hint');
    if (i === 0) await page.screenshot({ path: `${require('./lib.cjs').SHOTS}/${name}-stress-hint.png` });
    for (const ch of '88888') await page.click(`#keypad [data-d="${ch}"]`);
    await page.click('#keypad [data-action="ok"]');
    await page.waitForSelector('#s-race[data-phase="explain"]');
    await audit(lbl + '-explain');
    if (i === 3) await page.screenshot({ path: `${require('./lib.cjs').SHOTS}/${name}-stress-explain.png` });
    await page.waitForFunction(() => { const R = RR.UI.state.race; return R && R.phase === 'explain' && performance.now() >= (R.explainFrom || 0); });
    await page.click('#btn-next');
  }
  await page.waitForSelector('#s-finish:not([hidden])', { timeout: 25000 });
  const csp = await page.evaluate(() => window.__csp);
  if (csp.length) problems.push('CSP: ' + csp.join(';'));
  await ctx.close();
  return { name, cases: worst.picks.length, issues, problems, longest: worst.longest };
}

module.exports = { run };

if (require.main === module) {
  (async () => {
    const shots = require('./shots.cjs');
    const names = process.argv.slice(2);
    const browser = await chromium.launch();
    const todo = Object.keys(shots.VPS).filter((n) => !names.length || names.includes(n));
    const res = await Promise.all(todo.map((n) => run(browser, n, shots.VPS[n])));
    res.forEach((r) => {
      console.log(r.name, r.cases, 'cases; longest:', JSON.stringify(r.longest));
      console.log(r.issues.length ? '  issues:\n   - ' + r.issues.join('\n   - ') : '  no layout issues');
      console.log(r.problems.length ? '  PROBLEMS: ' + r.problems.join('; ') : '  no console/network problems');
    });
    await browser.close();
  })();
}
