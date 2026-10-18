// Screenshots of the race screen (ask, hint, explain) with the worst-case sums, and of garage / finish, at given sizes.
//   NODE_PATH=$(npm root -g) SIZES='[[1366,625],[390,740]]' OUT=/path/dir [WHICH=0] [SCREENS=race,garage,finish] node shotrace.cjs
const fs = require('fs');
const path = require('path');
const { chromium, open } = require('./lib.cjs');
const { samples, settle } = require('./layoutfit.cjs');

const OUT = process.env.OUT || path.join(__dirname, 'shots');
fs.mkdirSync(OUT, { recursive: true });
const SIZES = JSON.parse(process.env.SIZES || '[[1366,625],[390,740],[320,568]]');
const WHICH = (process.env.WHICH || '0').split(',').map(Number);
const SCREENS = (process.env.SCREENS || 'race,garage,finish').split(',');

(async () => {
  const browser = await chromium.launch();
  const s = await samples(browser, 10);
  for (const vp of SIZES) {
    const tag = vp.join('x');
    const mobile = vp[0] < 900;
    const { page, ctx } = await open(browser, { viewport: { width: vp[0], height: vp[1] }, mobile, touch: mobile, reducedMotion: true });
    await page.evaluate(() => { const st = RR.UI.state.store; const r = st.addPlayer({ name: 'Sien', hero: 'eekhoorn', grade: 5 }); st.select(r.player.id); for (let i = 1; i <= 7; i++) st.stamp(i, 2); RR.UI.show('menu'); });
    if (SCREENS.includes('garage')) { await settle(page); await page.waitForTimeout(250); await page.screenshot({ path: `${OUT}/${tag}-garage.png` }); }
    if (SCREENS.includes('race')) {
      for (const w of WHICH) {
        const q = s.worst[w];
        await page.evaluate((qq) => { RR.UI.state.scene.advanceTo = () => Promise.resolve(); RR.Questions.series = () => Array(10).fill(0).map((_, i) => Object.assign({}, qq, { key: qq.key + '#' + i })); }, q);
        await page.evaluate(() => RR.UI.show('menu'));
        await page.click('#s-menu [data-to="vrij"]');
        await page.click('[data-action="start-free"]');
        await page.waitForSelector('#s-race[data-phase="intro"]');
        if (w === WHICH[0]) { await settle(page); await page.screenshot({ path: `${OUT}/${tag}-intro.png` }); }
        await page.click('#btn-start');
        await page.waitForFunction(() => { const R = RR.UI.state.race; return R && R.phase === 'ask' && performance.now() >= (R.keysFrom || 0); });
        await settle(page);
        await page.screenshot({ path: `${OUT}/${tag}-w${w}-ask.png` });
        await page.keyboard.type('88888'); await page.keyboard.press('Enter');
        await settle(page);
        await page.screenshot({ path: `${OUT}/${tag}-w${w}-hint.png` });
        await page.keyboard.type('88888'); await page.keyboard.press('Enter');
        await page.waitForSelector('#s-race[data-phase="explain"]');
        await settle(page);
        await page.screenshot({ path: `${OUT}/${tag}-w${w}-explain.png` });
        console.log(tag, 'worst', w, q.key, JSON.stringify(q.text.slice(0, 60)));
        await page.evaluate(() => { RR.UI.state.race.explainFrom = 0; });
      }
    }
    if (SCREENS.includes('finish')) {
      await page.evaluate(() => RR.UI.show('menu'));
      await page.click('#s-menu [data-to="banen"]');
      await page.click('.track.is-next');
      await page.click('#btn-start');
      for (let i = 0; i < 10; i++) {
        await page.waitForFunction((n) => { const R = RR.UI.state.race; return R && R.index === n && R.phase === 'ask' && performance.now() >= (R.keysFrom || 0); }, i, { timeout: 25000 });
        const a = await page.evaluate((n) => RR.UI.state.race.questions[n].answer, i);
        await page.keyboard.type(String(a)); await page.keyboard.press('Enter');
      }
      await page.waitForSelector('#s-finish:not([hidden])', { timeout: 25000 });
      await settle(page); await page.waitForTimeout(250);
      await page.screenshot({ path: `${OUT}/${tag}-finish.png` });
    }
    await ctx.close();
  }
  await browser.close();
})();
