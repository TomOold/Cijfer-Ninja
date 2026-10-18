// Takes a screenshot of every screen at several viewports. usage: node shots.cjs [vp-name ...]
const { chromium, open, createPlayer, SHOTS, layoutAudit } = require('./lib.cjs');

const VPS = {
  phone: { width: 390, height: 844, mobile: true, touch: true },
  land: { width: 844, height: 390, mobile: true, touch: true },
  tab: { width: 1024, height: 768 },
  lap: { width: 1366, height: 768 },
  big: { width: 1920, height: 1080 },
};

async function typeAnswer(page, text) {
  for (const ch of String(text)) await page.click(`#keypad [data-d="${ch}"]`);
}

async function run(name, vp, only) {
  const browser = await chromium.launch();
  const { page, problems } = await open(browser, { viewport: { width: vp.width, height: vp.height }, mobile: vp.mobile, touch: vp.touch });
  const issues = [];
  const snap = async (n, wait = 350) => {
    await page.waitForTimeout(wait);
    await page.screenshot({ path: `${SHOTS}/${name}-${n}.png` });
    const found = await layoutAudit(page);
    found.forEach((f) => issues.push(`${name}/${n}: ${f}`));
  };
  const want = (n) => !only || only.includes(n);

  // first run: empty store -> straight to the form
  await snap('01-nieuw');
  await page.click('#form-new button[type=submit]');
  await snap('02-nieuw-fouten', 100);
  await page.fill('#in-name', 'Sien');
  await page.click('label[for="hero-eekhoorn"]');
  await page.click('label[for="grade-4"]');
  await snap('03-nieuw-gevuld', 100);
  await page.click('#form-new button[type=submit]');
  await page.waitForSelector('#s-menu:not([hidden])');
  await page.click('[data-action="other-player"]');
  await createPlayer(page, 'Bram', 'pad', 5);
  await page.click('[data-action="other-player"]');
  await snap('04-spelers');
  await page.click('.pcard[data-action="pick-player"]');
  await page.waitForSelector('#s-menu:not([hidden])');
  await snap('05-menu', 700);

  // some progress
  await page.evaluate(() => {
    const st = RR.UI.state.store;
    st.stamp(1, 2); st.stamp(2, 1); st.stamp(3, 3);
    const rec = (k, kind, o) => st.recordAnswer(k, kind, o);
    ['add:47+36', 'add:12+9', 'sub:83-47', 'times:7x8', 'times:6x7', 'div:56:8'].forEach((k) => rec(k, k.split(':')[0], 'first'));
    rec('times:7x8', 'times', 'miss'); rec('times:6x7', 'times', 'second'); rec('div:56:8', 'div', 'miss'); rec('sub:83-47', 'sub', 'miss');
  });
  await page.click('[data-action="to"][data-to="banen"]');
  await snap('06-banen');
  await page.click('[data-action="nav"]');
  await page.click('[data-action="to"][data-to="vrij"]');
  await page.click('label[for="focus-times"]');
  await snap('07-vrij');

  // free race, tafel van 7
  await page.click('label[for="table-7"]');
  await page.click('[data-action="start-free"]');
  await snap('08-race-intro', 600);
  await page.evaluate(() => {
    window.__qs = null;
    const orig = RR.Questions.series;
    RR.Questions.series = function () { const r = orig.apply(this, arguments); window.__qs = r; return r; };
  });
  await page.click('#btn-start');
  await snap('09-race-ask', 500);
  const qs = await page.evaluate(() => window.__qs.map((q) => ({ text: q.text, answer: q.answer })));
  await typeAnswer(page, '9');
  await snap('10-race-typed', 100);
  await page.click('#keypad [data-action="ok"]');
  await snap('11-race-hint', 200);
  await typeAnswer(page, '8');
  await page.click('#keypad [data-action="ok"]');
  await snap('12-race-explain', 200);
  await page.waitForTimeout(700);
  await page.click('#btn-next');
  await page.waitForSelector('#s-race[data-phase="ask"]', { timeout: 8000 });
  // right answer, then mid-glide shot
  await typeAnswer(page, qs[1].answer);
  await page.click('#keypad [data-action="ok"]');
  await snap('13-race-glide', 450);
  await page.waitForSelector('#s-race[data-phase="ask"]', { timeout: 8000 });
  await snap('14-race-next', 100);
  // pause dialog
  await page.click('#btn-pause');
  await snap('15-pause', 200);
  await page.click('#btn-resume');
  // play through
  for (let i = 2; i < 10; i++) {
    await page.waitForSelector('#s-race[data-phase="ask"]', { timeout: 8000 });
    await typeAnswer(page, qs[i].answer);
    await page.click('#keypad [data-action="ok"]');
  }
  await page.waitForSelector('#s-finish:not([hidden])', { timeout: 15000 });
  await snap('16-finish-vrij', 400);
  await page.click('[data-action="finish-garage"]');
  await page.waitForSelector('#s-menu:not([hidden])');

  // championship race with a story-heavy track for the long texts
  await page.evaluate(() => { const st = RR.UI.state.store; for (let i = 4; i <= 7; i++) st.stamp(i, 2); });
  await page.click('[data-action="to"][data-to="banen"]');
  await snap('17-banen-meer', 100);
  await page.click('.track.is-next');
  await page.click('#btn-start');
  await page.waitForSelector('#s-race[data-phase="ask"]');
  await snap('18-race-track8', 600);
  for (let i = 0; i < 10; i++) {
    await page.waitForSelector('#s-race[data-phase="ask"]', { timeout: 8000 });
    const ans = await page.evaluate((i) => RR.UI.state.race.questions[i].answer, i);
    await typeAnswer(page, ans);
    await page.click('#keypad [data-action="ok"]');
  }
  await page.waitForSelector('#s-finish:not([hidden])', { timeout: 15000 });
  await snap('19-finish-kampioen', 500);
  await page.click('[data-action="finish-garage"]');
  await page.waitForSelector('#s-menu:not([hidden])');
  await page.click('[data-action="to"][data-to="stempels"]');
  await snap('20-stempels');
  await page.click('[data-action="to"][data-to="rijbewijs"]');
  await snap('21-rijbewijs');
  await page.click('[data-action="nav"]');
  await page.waitForSelector('#s-stempels:not([hidden])');
  await page.click('[data-action="nav"]');
  await page.waitForSelector('#s-menu:not([hidden])');
  await page.click('[data-action="parents"]');
  await snap('22-ouders');
  await page.click('[data-action="ask-reset"]');
  await snap('23-ouders-bevestig', 400);
  await page.click('[data-action="confirm-cancel"]');
  await page.click('[data-action="nav"]');
  await page.evaluate(() => { RR.UI.state.races = 3; });
  await page.evaluate(() => RR.UI.show('rust'));
  await snap('24-rust');
  await page.click('[data-action="rest-stop"]');
  await snap('25-totziens');
  const csp = await page.evaluate(() => window.__csp);
  if (csp.length) problems.push('CSP violations: ' + csp.join('; '));
  await browser.close();
  return { name, problems, issues };
}

module.exports = { run, VPS };

if (require.main === module) {
  (async () => {
    const names = process.argv.slice(2);
    const todo = Object.keys(VPS).filter((n) => !names.length || names.includes(n));
    const results = await Promise.all(todo.map((n) => run(n, VPS[n])));
    results.forEach((r) => {
      console.log(r.name, r.problems.length ? 'PROBLEMS:\n  ' + r.problems.join('\n  ') : 'no console/network problems');
      console.log(r.issues.length ? '  layout issues:\n   - ' + r.issues.join('\n   - ') : '  no layout issues');
    });
  })();
}
