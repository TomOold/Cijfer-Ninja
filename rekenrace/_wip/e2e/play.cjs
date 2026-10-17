// Plays the real Rekenrace game through the DOM and checks behaviour, accessibility and layout.
// usage: NODE_PATH=$(npm root -g) node play.cjs [scenario-letter ...]      (no arguments = everything)
const fs = require('fs');
const { chromium, open, createPlayer, SHOTS, layoutAudit, contrastAudit, a11yScan } = require('./lib.cjs');
const shots = require('./shots.cjs');
const stress = require('./stress.cjs');

// ---------- tiny test harness ----------
const reports = [];
function makeT(name) {
  const rep = { name, lines: [], fails: 0 };
  reports.push(rep);
  return {
    check(label, ok, detail) {
      rep.lines.push((ok ? '  ok    ' : '  FAIL  ') + label + (ok || detail === undefined ? '' : '  -> ' + (typeof detail === 'string' ? detail : JSON.stringify(detail))));
      if (!ok) rep.fails++;
    },
    note(text) { rep.lines.push('  note  ' + text); },
    rep,
  };
}

// ---------- helpers ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const FIRST_FEEDBACK = ['Goed zo.', 'Dat klopt.', 'Juist.'];
const PLACE_RE = /^Je bent als (eerste|tweede|derde|vierde) over de finish gekomen\.$/;

async function spies(page) {
  await page.evaluate(() => {
    window.__snd = [];
    const play = RR.Sound.play;
    RR.Sound.play = function (n) { window.__snd.push(n); return play.apply(this, arguments); };
    window.__series = [];
    const series = RR.Questions.series;
    RR.Questions.series = function (o, c) {
      const r = series.apply(this, arguments);
      window.__series.push({ opts: JSON.parse(JSON.stringify(o)), count: c, list: r.map((q) => Object.assign({}, q)) });
      return r;
    };
  });
}

const S = (page, fn, arg) => page.evaluate(fn, arg);
const state = (page) => page.evaluate(() => { const R = RR.UI.state.race; return { screen: RR.UI.state.screen, phase: R && R.phase, index: R && R.index, races: RR.UI.state.races }; });

async function typeKeypad(page, text) { for (const ch of String(text)) await page.click(`#keypad [data-d="${ch}"]`); }
async function typeKeys(page, text) { for (const ch of String(text)) await page.keyboard.press(ch); }
const clickOk = (page) => page.click('#keypad [data-action="ok"]');
const waitAsk = (page, i, timeout = 25000) => page.waitForFunction((n) => { const R = RR.UI.state.race; return R && R.index === n && R.phase === 'ask'; }, i, { timeout });
const waitScreen = (page, id, timeout = 25000) => page.waitForSelector(`#s-${id}:not([hidden])`, { timeout });
const text = (page, sel) => page.evaluate((s) => { const e = document.querySelector(s); return e ? e.innerText.trim() : null; }, sel);

// Walks from the garage to the start card of a championship track or a free race.
async function toIntro(page, { mode = 'championship', track, focus, table } = {}) {
  if (mode === 'championship') {
    await page.click('#s-menu [data-to="banen"]');
    await page.click(track ? `.track[data-id="${track}"]` : '.track.is-next');
  } else {
    await page.click('#s-menu [data-to="vrij"]');
    if (track) await page.click(`label[for="track-${track}"]`);
    if (focus) await page.click(`label[for="focus-${focus}"]`);
    if (table !== undefined) await page.click(`label[for="table-${table}"]`);
    await page.click('[data-action="start-free"]');
  }
  await page.waitForSelector('#s-race[data-phase="intro"]');
}

// Plays the 10 sums. plan(i, q) -> array of 'right' | 'wrong' attempts for sum i (default ['right']).
async function playRace(page, t, plan, opts = {}) {
  const series = await page.evaluate(() => window.__series[window.__series.length - 1]);
  const list = series.list;
  const seen = [];
  for (let i = 0; i < list.length; i++) {
    await waitAsk(page, i);
    const q = list[i];
    const attempts = (plan && plan(i, q)) || ['right'];
    const info = { i, q, attempts, hint: null, explain: null };
    for (let a = 0; a < attempts.length; a++) {
      const val = attempts[a] === 'right' ? String(q.answer) : String(q.answer + 1);
      if (opts.keyboard) await typeKeys(page, val); else await typeKeypad(page, val);
      const shown = await text(page, '#answer-text');
      if (shown !== val) t.check(`sum ${i + 1}: answer box shows what was typed`, false, { shown, val });
      if (opts.keyboard) await page.keyboard.press('Enter'); else await clickOk(page);
      if (attempts[a] === 'wrong' && a === 0 && attempts.length > 1 && attempts[1] === 'right') {
        info.hint = await text(page, '#feedback');
      } else if (attempts[a] === 'wrong' && a === 0) {
        info.hint = await text(page, '#feedback');
      }
    }
    if (attempts.length === 2 && attempts[1] === 'wrong') {
      await page.waitForSelector('#s-race[data-phase="explain"]');
      info.explain = { answer: await text(page, '#explain-answer'), text: await text(page, '#explain-text') };
      if (opts.afterExplain) await opts.afterExplain(i, info);
      if (opts.keyboard) await page.keyboard.press('Enter'); else await page.click('#btn-next');
    }
    seen.push(info);
  }
  await waitScreen(page, 'finish');
  return seen;
}

async function noProblems(t, c, label = 'page') {
  const csp = await c.page.evaluate(() => window.__csp || []);
  t.check(label + ': no console errors/warnings, page errors or network requests', c.problems.length === 0, c.problems);
  t.check(label + ': no Content-Security-Policy violations', csp.length === 0, csp);
}

// ============================================================================
// A: start, player chooser, new player form, safety of names
// ============================================================================
async function sA(browser) {
  const t = makeT('A start and players');
  const c = await open(browser, { viewport: { width: 1024, height: 768 } });
  const p = c.page;
  await spies(p);
  t.check('<html lang="nl">', (await S(p, () => document.documentElement.lang)) === 'nl');
  t.check('page title is "Rekenrace"', (await p.title()) === 'Rekenrace');
  const csp = await S(p, () => (document.querySelector('meta[http-equiv="Content-Security-Policy"]') || {}).content);
  t.check('CSP meta exactly as specified', csp === "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; connect-src 'none'; media-src 'none'; base-uri 'none'; form-action 'none'", csp);
  t.check('nothing plays before the first gesture', (await S(p, () => RR.Sound.isUnlocked())) === false);
  t.check('first run goes straight to the new-player form', (await state(p)).screen === 'nieuw');
  t.check('focus moved to the screen heading', (await S(p, () => document.activeElement.id)) === 'h-nieuw');
  await p.waitForTimeout(150);
  t.check('aria-live region announces the screen', (await text(p, '#announce')) === 'Nieuwe speler');
  t.check('maxlength 12 on the name input', (await S(p, () => document.getElementById('in-name').maxLength)) === 12);
  t.check('visible label for the name input', (await text(p, 'label[for="in-name"]')) === 'Hoe heet je?');
  const heroes = await S(p, () => [...document.querySelectorAll('.hero-card')].map((e) => ({ img: (e.querySelector('img') || {}).src || '', name: e.querySelector('.hero-name').textContent, tag: e.querySelector('.hero-tag').textContent, radio: e.querySelector('input').type })));
  t.check('4 hero radio cards with kart pictures (data URLs), names and taglines', heroes.length === 4 && heroes.every((h) => h.img.startsWith('data:image/png') && h.radio === 'radio' && h.tag.length > 20), heroes.map((h) => h.name));
  t.check('hero names come from RR.Heroes', JSON.stringify(heroes.map((h) => h.name)) === JSON.stringify(await S(p, () => RR.Heroes.map((h) => h.name))));
  t.check('grade radios Groep 3-6, default Groep 4', JSON.stringify(await S(p, () => [...document.querySelectorAll('input[name=grade]')].map((i) => i.value + (i.checked ? '*' : '')))) === JSON.stringify(['3', '4*', '5', '6']));

  await p.click('#form-new button[type=submit]');
  t.check('empty submit: name error shown (Dutch) and focus in the name field', (await text(p, '#err-name')) === 'Vul eerst je naam in.' && (await S(p, () => document.activeElement.id)) === 'in-name');
  t.check('empty submit: hero error shown', (await text(p, '#err-hero')) === 'Kies een held om mee te racen.');
  t.check('errors are role=alert and linked to the input', (await S(p, () => document.getElementById('err-name').getAttribute('role') + '|' + document.getElementById('in-name').getAttribute('aria-describedby'))) === 'alert|hint-name err-name');

  // names are text, never markup
  await p.fill('#in-name', '<img src=x>');
  await p.click('label[for="hero-pad"]');
  await p.click('label[for="grade-3"]');
  await p.click('#form-new button[type=submit]');
  await waitScreen(p, 'menu');
  t.check('XSS name is shown as text in the garage', (await text(p, '#h-menu')) === 'Hoi, <img src=x>.' && (await S(p, () => document.querySelectorAll('img[src="x"]').length)) === 0);
  await p.click('[data-action="other-player"]');
  t.check('chooser shows the name as text', (await text(p, '.pcard-name')) === '<img src=x>' && (await S(p, () => document.querySelectorAll('.pcard-name img').length)) === 0);
  await p.click('[data-action="new-player"]');
  await p.fill('#in-name', ' <IMG SRC=X>');
  await p.click('label[for="hero-uil"]');
  await p.click('#form-new button[type=submit]');
  t.check('name_taken (case-insensitive, spaces trimmed) is explained in Dutch', /al een speler met die naam/.test((await text(p, '#err-name')) || ''), await text(p, '#err-name'));
  await p.fill('#in-name', 'Sien');
  await p.click('#form-new button[type=submit]');
  await waitScreen(p, 'menu');
  await p.click('[data-action="other-player"]');
  const cards = await S(p, () => [...document.querySelectorAll('.pcard')].map((e) => e.innerText.replace(/\s+/g, ' ').trim()));
  t.check('chooser: a card per player (head + name + Groep N) and a "Nieuwe speler" card', cards.length === 3 && cards[1] === 'Sien Groep 4' && cards[2].includes('Nieuwe speler') && cards[0] === '<img src=x> Groep 3', cards);
  t.check('player cards show a head portrait', (await S(p, () => [...document.querySelectorAll('.pcard-head')].every((i) => i.src.startsWith('data:image/png')))) === true);

  // fill to 8 players: the new-player card disappears
  await S(p, () => { const st = RR.UI.state.store; for (let i = 0; i < 6; i++) st.addPlayer({ name: 'Kind' + i, hero: 'egel', grade: 4 }); });
  await p.evaluate(() => RR.UI.show('spelers'));
  t.check('with 8 players there is no "Nieuwe speler" card', (await S(p, () => document.querySelectorAll('.pcard-new').length)) === 0);
  await S(p, () => { const st = RR.UI.state.store; st.players().filter((x) => /^Kind/.test(x.name)).forEach((x) => st.removePlayer(x.id)); });

  // never auto-login: reload with a stored selection
  await p.click('.pcard[data-action="pick-player"] >> nth=1');
  await waitScreen(p, 'menu');
  t.check('after picking, the store remembers the selection', (await S(p, () => RR.UI.state.store.current() && RR.UI.state.store.current().name)) === 'Sien');
  await p.reload();
  t.check('reload always lands on the chooser (no auto-login)', (await state(p)).screen === 'spelers' && (await S(p, () => RR.UI.state.store.current())) === null);
  t.check('players persisted over the reload', (await S(p, () => RR.UI.state.store.players().length)) === 2);
  await noProblems(t, c);
  await c.ctx.close();
}

// ============================================================================
// B: championship track 1, all right; no auto-start; finish and stamp
// ============================================================================
async function sB(browser) {
  const t = makeT('B championship track 1, all correct');
  const c = await open(browser, { viewport: { width: 1024, height: 768 } });
  const p = c.page;
  await createPlayer(p, 'Sien', 'eekhoorn', 4);
  await spies(p);
  t.check('garage: hero greeting with the name', (await text(p, '#h-menu')) === 'Hoi, Sien.');
  t.check('garage: Kampioenschap subtitle names the next track', /Volgende baan: Tulpenveld/.test((await text(p, '#s-menu .menu-btn')) || ''));
  t.check('garage: four buttons and a quiet Ouders link', (await S(p, () => [...document.querySelectorAll('#s-menu .menu-btn')].map((b) => b.querySelector('.menu-title').textContent))).join('|') === 'Kampioenschap|Vrije race|Stempelkaart|Andere speler' && (await text(p, '#s-menu .foot button')) === 'Ouders');
  await toIntro(p);
  t.check('intro card: "Baan 1: Tulpenveld", blurb and Start', (await text(p, '#intro-title')) === 'Baan 1: Tulpenveld' && (await text(p, '#intro-blurb')).length > 20 && (await text(p, '#btn-start')) === 'Start');
  t.check('intro: no sums were generated before Start', (await S(p, () => window.__series.length)) === 0);
  await sleep(1500);
  t.check('intro: nothing starts by itself', (await state(p)).phase === 'intro');
  await p.keyboard.press('5');
  t.check('intro: stray digits are ignored', (await text(p, '#answer-text')) === '');
  const t0 = Date.now();
  await p.click('#btn-start');
  const ser = await S(p, () => window.__series.map((s) => ({ opts: s.opts, count: s.count })));
  t.check('series asked for 10 sums with grade 4, level = track id, focus mix', ser.length === 1 && ser[0].count === 10 && ser[0].opts.grade === 4 && ser[0].opts.level === 1 && ser[0].opts.focus === 'mix', ser);
  t.check("sound 'go' on Start", (await S(p, () => window.__snd)).includes('go'));
  t.check('progress text "Som 1 van 10"', (await text(p, '#race-progress')) === 'Som 1 van 10');
  t.check('race title "Baan 1: Tulpenveld"', (await text(p, '#race-title')) === 'Baan 1: Tulpenveld');
  await sleep(1500);
  t.check('ask: waits for the child (no timer)', (await state(p)).phase === 'ask' && (await state(p)).index === 0);
  const alt = await S(p, () => document.querySelector('canvas.scene').getAttribute('role') + '|' + document.querySelector('canvas.scene').getAttribute('aria-label'));
  t.check('scene canvas has role=img and a Dutch label', /^img\|.+/.test(alt), alt);

  // the question text is shown as given
  const list = (await S(p, () => window.__series[0].list));
  const shownQ = await text(p, '#q');
  t.check('question text shown as given', shownQ === list[0].text, { shownQ, given: list[0].text });
  // empty Klaar is ignored, max 5 digits, backspace, leading zeros
  await clickOk(p);
  t.check('Klaar with an empty field does nothing', (await state(p)).phase === 'ask' && !(await text(p, '#feedback')));
  await typeKeypad(p, '123456');
  t.check('answer box takes at most 5 digits', (await text(p, '#answer-text')) === '12345');
  await p.click('#keypad .key-del');
  await p.click('#keypad .key-del');
  t.check('backspace removes digits', (await text(p, '#answer-text')) === '123');
  await p.click('#keypad .key-del'); await p.click('#keypad .key-del'); await p.click('#keypad .key-del'); await p.click('#keypad .key-del');
  t.check('backspace on an empty field is harmless', (await text(p, '#answer-text')) === '');
  const seen = [];
  for (let i = 0; i < 10; i++) {
    await waitAsk(p, i);
    const q = list[i];
    t.check(`sum ${i + 1}: progress "Som ${i + 1} van 10"`, (await text(p, '#race-progress')) === `Som ${i + 1} van 10`);
    await typeKeypad(p, (i === 2 ? '00' : '') + q.answer);       // leading zeros are fine
    await clickOk(p);
    const fb = await text(p, '#feedback');
    seen.push(fb);
    t.check(`sum ${i + 1}: calm feedback "${fb}"`, FIRST_FEEDBACK.includes(fb), fb);
    const ph = (await state(p)).phase;
    t.check(`sum ${i + 1}: the kart glides straight after (phase ${ph})`, ph === 'gliding');
    if (i === 0) {
      await p.keyboard.press('7');
      await p.click('#keypad [data-d="3"]');
      await p.keyboard.press('Enter');
      await p.keyboard.press('Backspace');
      t.check('while gliding: digits, keypad, Enter and Backspace are ignored', (await text(p, '#answer-text')) === String(q.answer) && (await state(p)).phase === 'gliding');
    }
  }
  await waitScreen(p, 'finish');
  const tEnd = Date.now() - t0;
  const snd = await S(p, () => window.__snd);
  t.check("sounds: 'ok' and 'glide' were played, 'stamp' on the new stamp", snd.includes('ok') && snd.includes('glide') && snd.includes('stamp') && !snd.includes('almost'), snd.join(','));
  t.check('feedback rotates through the three calm sentences', new Set(seen).size === 3, seen);
  const fin = await text(p, '#s-finish');
  t.check('finish heading is a calm place sentence (perfect race wins)', (await text(p, '#h-finish')) === 'Je bent als eerste over de finish gekomen.', await text(p, '#h-finish'));
  t.check('finish: "10 van 10 goed in één keer"', /10 van 10 goed in één keer/.test(fin));
  t.check('finish: standings list of 4 with head portraits and the player marked', (await S(p, () => document.querySelectorAll('.stand-row').length)) === 4 && (await S(p, () => document.querySelectorAll('.stand-row img').length)) === 4 && /Sien \(jij\)/.test(fin));
  t.check('finish: stamp earned, named', /Je hebt de stempel van Tulpenveld gehaald\./.test(fin));
  t.check('finish: no practise list after a perfect race', !/Oefenen/.test(fin));
  t.check('finish: primary "Terug naar de garage", secondary "Nog een keer"', (await S(p, () => [...document.querySelectorAll('#s-finish .btn')].map((b) => b.textContent + ':' + b.classList.contains('primary')))).join('|') === 'Terug naar de garage:true|Nog een keer:false');
  t.check('finish: no confetti, no animation on the finish screen', (await S(p, () => [...document.querySelectorAll('#s-finish *')].every((e) => { const a = getComputedStyle(e).animationName; return a === 'none' || a === 'fade-in'; }))) === true);
  const st = await S(p, () => RR.UI.state.store.stamps());
  t.check('Store has the stamp for track 1 with place 1', st['1'] && st['1'].place === 1 && /^\d{4}-\d{2}-\d{2}$/.test(st['1'].date), st);
  t.note(`full race took ${Math.round(tEnd / 1000)}s`);
  await sleep(1200);
  t.check('after the finish nothing starts by itself', (await state(p)).screen === 'finish');
  // "Nog een keer" -> new start card on the same track, nothing auto-starts
  await p.click('[data-action="finish-again"]');
  await p.waitForSelector('#s-race[data-phase="intro"]');
  t.check('"Nog een keer" shows a new start card for the same track', (await text(p, '#intro-title')) === 'Baan 1: Tulpenveld');
  await noProblems(t, c);
  await c.ctx.close();
}

// ============================================================================
// C: wrong answers, hints, explanation, Volgende
// ============================================================================
async function sC(browser) {
  const t = makeT('C wrong answers, hint, explain, Volgende');
  const c = await open(browser, { viewport: { width: 1024, height: 768 } });
  const p = c.page;
  await createPlayer(p, 'Bram', 'pad', 5);
  await p.evaluate(() => RR.UI.state.store.stamp(1, 2));
  await spies(p);
  await toIntro(p);
  await p.click('#btn-start');
  const plan = (i) => (i === 0 ? ['wrong', 'right'] : i === 1 ? ['wrong', 'wrong'] : i === 2 ? ['wrong', 'right'] : ['right']);
  const info = await playRace(p, t, plan, {
    afterExplain: async () => {
      await sleep(2500);
      t.check('explain stays until Volgende is pressed (no auto-advance)', (await state(p)).phase === 'explain');
      t.check('explain: no sum timer, answer box cleared', (await text(p, '#answer-text')) === '');
    },
  });
  const [s0, s1, s2] = info;
  t.check('1st wrong: "Nog niet helemaal." plus the hint', s0.hint && s0.hint.startsWith('Nog niet helemaal.') && s0.hint.includes(s0.q.hint), s0.hint);
  t.check('hint never contains the answer as a number', ![s0, s1, s2].some((s) => new RegExp('(^|[^0-9])' + s.q.answer + '([^0-9]|$)').test(s.hint.replace('Nog niet helemaal.', ''))), info.map((s) => [s.hint, s.q.answer]));
  t.check('explain card: "Het antwoord is X."', s1.explain.answer === 'Het antwoord is ' + s1.q.answer + '.', s1.explain);
  t.check('explain card: explanation with line breaks preserved (one paragraph per line)', s1.explain.text.replace(/\n+/g, '\n') === s1.q.explain.replace(/\n+/g, '\n'), { got: s1.explain.text, want: s1.q.explain });
  const snd = await S(p, () => window.__snd);
  t.check("sounds: 'almost' on wrong answers", snd.filter((x) => x === 'almost').length === 4, snd.join(','));
  const fin = await text(p, '#s-finish');
  t.check('finish: "7 van 10 goed in één keer" (two second tries, one miss)', /7 van 10 goed in één keer/.test(fin), fin.slice(0, 300));
  t.check('finish: "Oefenen" lists the missed sum with its answer', /Oefenen/.test(fin) && fin.includes(s1.q.text.includes('?') && !s1.q.text.includes('\n') ? s1.q.text.replace('?', s1.q.answer) : String(s1.q.answer)), fin.slice(0, 400));
  t.check('finish: only the missed sum is listed (not the second-try one)', (await S(p, () => document.querySelectorAll('.practise-list li').length)) === 1);
  const stats = await S(p, () => ({ tricky: RR.UI.state.store.trickyKeys(8), open: RR.UI.state.store.openKeys(5), kinds: RR.UI.state.store.kindStats() }));
  t.check('store recorded the miss and the second try', stats.tricky.some((x) => x.key === s1.q.key) && stats.open.includes(s1.q.key) && stats.open.includes(s0.q.key), stats);
  const place = (await text(p, '#h-finish')).match(PLACE_RE);
  t.check('place sentence matches the pattern', !!place, await text(p, '#h-finish'));
  const stamp2 = await S(p, () => RR.UI.state.store.stamps());
  t.check('finishing in any place earns the stamp', !!stamp2['2'] && stamp2['2'].place >= 1 && stamp2['2'].place <= 4, stamp2);
  await noProblems(t, c);
  await c.ctx.close();
}

// ============================================================================
// D: free race, Tafels, table 7
// ============================================================================
async function sD(browser) {
  const t = makeT('D free race Tafels 7');
  const c = await open(browser, { viewport: { width: 1024, height: 768 } });
  const p = c.page;
  await createPlayer(p, 'Eva', 'uil', 4);
  await p.evaluate(() => RR.UI.state.store.stamp(1, 1));
  await spies(p);
  await p.click('#s-menu [data-to="vrij"]');
  const states = await S(p, () => [...document.querySelectorAll('input[name=track]')].map((i) => i.value + (i.disabled ? 'x' : '')));
  t.check('free race: only tracks up to the next one are choosable', states.join(',') === '1,2,3x,4x,5x,6x,7x,8x', states);
  t.check('free race: table group hidden until Tafels or Delen', (await S(p, () => document.getElementById('fs-table').hidden)) === true);
  await p.click('label[for="focus-times"]');
  t.check('free race: Tafels shows table chips Alle tafels + 1-10', (await S(p, () => !document.getElementById('fs-table').hidden && document.querySelectorAll('input[name=table]').length)) === 11);
  await p.click('label[for="focus-add"]');
  t.check('free race: hidden again for Optellen', (await S(p, () => document.getElementById('fs-table').hidden)) === true);
  await p.click('label[for="focus-times"]');
  await p.click('label[for="table-7"]');
  await p.click('label[for="track-2"]');
  await p.click('[data-action="start-free"]');
  await p.waitForSelector('#s-race[data-phase="intro"]');
  t.check('intro of a free race says so', /vrije race/i.test((await text(p, '#intro-extra')) || '') && /Tafel van 7/.test(await text(p, '#intro-extra')), await text(p, '#intro-extra'));
  await p.click('#btn-start');
  const ser = await S(p, () => window.__series[0]);
  t.check('series asked with grade 4, level = track 2, focus times, table 7', ser.opts.grade === 4 && ser.opts.level === 2 && ser.opts.focus === 'times' && ser.opts.table === 7, ser.opts);
  const involves7 = ser.list.map((q) => (/(^|[^0-9])7([^0-9]|$)/.test(q.text) || q.answer === 7));
  t.check('every question involves the 7 table', involves7.every(Boolean), ser.list.map((q) => q.text));
  t.check('titles say "Vrije race"', (await text(p, '#race-title')) === 'Vrije race: Molenpolder');
  const before = await S(p, () => JSON.stringify(RR.UI.state.store.stamps()));
  await playRace(p, t, null);
  t.check('free race: no stamp is awarded', (await S(p, () => JSON.stringify(RR.UI.state.store.stamps()))) === before);
  t.check('free race: finish screen has no stamp panel', (await S(p, () => document.querySelectorAll('.stamp-got').length)) === 0);
  t.check("free race: sound 'finish' (not 'stamp')", (await S(p, () => window.__snd.includes('finish') && !window.__snd.includes('stamp'))) === true);
  // Delen with a table
  await p.click('[data-action="finish-garage"]');
  await p.click('#s-menu [data-to="vrij"]');
  await p.click('label[for="focus-div"]');
  await p.click('label[for="table-4"]');
  await p.click('[data-action="start-free"]');
  await p.waitForSelector('#s-race[data-phase="intro"]');
  t.check('intro mentions the division table', /Delen met de tafel van 4/.test(await text(p, '#intro-extra')), await text(p, '#intro-extra'));
  await p.click('#btn-start');
  const ser2 = await S(p, () => window.__series[1]);
  t.check('Delen table 4: every question has the 4 in it', ser2.list.every((q) => /(^|[^0-9])4([^0-9]|$)/.test(q.text) || q.answer === 4), ser2.list.map((q) => q.text));
  await noProblems(t, c);
  await c.ctx.close();
}

// ============================================================================
// E: reload, persistence, track list rules, stamp card, licence, print
// ============================================================================
async function sE(browser) {
  const t = makeT('E persistence, tracks, stamp card, licence');
  const c = await open(browser, { viewport: { width: 1024, height: 768 } });
  const p = c.page;
  await createPlayer(p, 'Sien', 'eekhoorn', 4);
  await p.evaluate(() => { const st = RR.UI.state.store; st.stamp(1, 2); st.stamp(2, 1); });
  await p.reload();
  await p.click('.pcard[data-action="pick-player"]');
  await waitScreen(p, 'menu');
  t.check('stamps survive a reload (garage shows 2 van 8)', /2 van 8 stempels/.test(await text(p, '#s-menu')), await text(p, '#s-menu'));
  await p.click('#s-menu [data-to="banen"]');
  const tracks = await S(p, () => [...document.querySelectorAll('.track')].map((b) => ({ id: b.dataset.id, dis: b.disabled, next: b.classList.contains('is-next'), icon: b.querySelector('img') ? 1 : 0, tag: (b.querySelector('.track-tag') || {}).textContent || '' })));
  t.check('8 tracks; only up to the next one (3) is playable', tracks.length === 8 && tracks.map((x) => x.dis).join() === 'false,false,false,true,true,true,true,true', tracks);
  t.check('track 3 is highlighted as next, 1-2 say "Stempel gehaald", locked say "Nog niet beschikbaar"', tracks[2].next && tracks[0].tag === 'Stempel gehaald' && tracks[3].tag === 'Nog niet beschikbaar' && tracks[2].tag === 'Volgende baan', tracks.map((x) => x.tag));
  const icons = await S(p, () => [...document.querySelectorAll('.track-icon')].map((i) => i.src.length));
  t.check('track icons are distinct images (stamp / empty stamp / lock)', new Set(icons).size >= 3, icons);
  const nextStyle = await S(p, () => { const e = document.querySelector('.track.is-next'); const cs = getComputedStyle(e); return cs.animationName + '|' + cs.transitionDuration; });
  t.check('next track is highlighted without animation', nextStyle.startsWith('none'), nextStyle);
  // replaying an earned track is allowed
  await p.click('.track[data-id="1"]');
  await p.waitForSelector('#s-race[data-phase="intro"]');
  t.check('replaying an earned track works', (await text(p, '#intro-title')) === 'Baan 1: Tulpenveld');
  await p.click('#s-race [data-action="nav"]').catch(() => {});
  await p.click('.titlebar [data-action="nav"]');
  await waitScreen(p, 'banen');
  t.check('"Terug" on the start card goes back to the track list', true);
  // stamp card
  await p.click('.titlebar [data-action="nav"]');
  await p.click('#s-menu [data-to="stempels"]');
  const slots = await S(p, () => [...document.querySelectorAll('.slot')].map((s) => s.querySelector('.slot-date').textContent));
  t.check('stamp card: 8 slots; earned ones carry a Dutch long date', slots.length === 8 && /^gereden op \d{1,2} (januari|februari|maart|april|mei|juni|juli|augustus|september|oktober|november|december) \d{4}$/.test(slots[0]) && slots[2] === 'nog niet gereden', slots);
  t.check('stamp card: no licence button before all 8 stamps', (await S(p, () => document.querySelectorAll('#s-stempels [data-to="rijbewijs"]').length)) === 0);
  await S(p, () => { const st = RR.UI.state.store; for (let i = 1; i <= 8; i++) st.stamp(i, 3); });
  await p.evaluate(() => RR.UI.show('stempels'));
  t.check('stamp card: licence button appears after 8 stamps', (await text(p, '#s-stempels [data-to="rijbewijs"]')) === 'Rekenrijbewijs bekijken');
  await p.click('#s-stempels [data-to="rijbewijs"]');
  await waitScreen(p, 'rijbewijs');
  t.check('licence: heading, name, kart picture, 8 stamps, date, sentence', (await text(p, '#h-rijbewijs')).toLowerCase() === 'rekenrijbewijs' && (await text(p, '.licence-name')) === 'Sien' && (await S(p, () => document.querySelectorAll('.licence-stamp').length)) === 8 && (await S(p, () => document.querySelector('.licence-kart').src.startsWith('data:'))) && /Datum: \d{1,2} \w+ \d{4}/.test(await text(p, '.licence-date')) && /heeft alle acht de banen/.test(await text(p, '.licence-text')));
  t.check('licence heading is rendered in capitals by CSS only', (await S(p, () => getComputedStyle(document.getElementById('h-rijbewijs')).textTransform)) === 'uppercase');
  await p.evaluate(() => { window.__printed = 0; window.print = () => { window.__printed++; }; });
  await p.click('[data-action="print"]');
  t.check('"Afdrukken" calls window.print()', (await S(p, () => window.__printed)) === 1);
  await p.emulateMedia({ media: 'print' });
  const pr = await S(p, () => ({ title: getComputedStyle(document.querySelector('.titlebar')).display, btns: getComputedStyle(document.querySelector('#s-rijbewijs .no-print')).display, licence: getComputedStyle(document.querySelector('.licence')).display, shown: [...document.querySelectorAll('.screen')].filter((s) => getComputedStyle(s).display !== 'none').map((s) => s.id) }));
  t.check('print: only the licence card is printed (no title bar, no buttons, no other screens)', pr.title === 'none' && pr.btns === 'none' && pr.licence !== 'none' && pr.shown.join() === 's-rijbewijs', pr);
  const pdf = await p.pdf({ preferCSSPageSize: true, printBackground: true });
  fs.writeFileSync(SHOTS + '/licence-print.pdf', pdf);
  const pages = (pdf.toString('latin1').match(/\/Type\s*\/Page[^s]/g) || []).length;
  t.check('print: the licence fits on one page', pages === 1, pages);
  await p.emulateMedia({ media: 'screen' });
  await noProblems(t, c);
  await c.ctx.close();
}

// ============================================================================
// F: parents screen
// ============================================================================
async function sF(browser) {
  const t = makeT('F parents');
  const c = await open(browser, { viewport: { width: 1024, height: 768 } });
  const p = c.page;
  await createPlayer(p, 'Sien', 'eekhoorn', 4);
  await p.click('[data-action="other-player"]');
  await createPlayer(p, 'Bram', 'pad', 5);
  await p.evaluate(() => {
    const st = RR.UI.state.store;
    st.stamp(1, 1);
    ['times:7x8', 'times:6x7', 'times:3x4', 'times:2x5'].forEach((k) => st.recordAnswer(k, 'times', 'first'));
    st.recordAnswer('times:7x8', 'times', 'miss'); st.recordAnswer('times:6x7', 'times', 'second');
    st.recordAnswer('add:47+36', 'add', 'miss');
  });
  await p.click('#s-menu .foot button');
  await waitScreen(p, 'ouders');
  t.check('parents: heading "Ouders", focus on it', (await text(p, '#h-ouders')) === 'Ouders' && (await S(p, () => document.activeElement.id)) === 'h-ouders');
  const cards = await S(p, () => [...document.querySelectorAll('.pl-card')].map((c) => c.querySelector('.pl-name').textContent));
  t.check('parents: a card per player', cards.join() === 'Sien,Bram', cards);
  const bram = await text(p, '.pl-card:nth-of-type(2)');
  t.check('parents: kind lines as plain text ("Tafels: 4 van 6 goed")', /Tafels: 4 van 6 goed/.test(bram) || /Tafels: \d+ van \d+ goed/.test(bram), bram.slice(0, 300));
  t.check('parents: kinds with no sums say "nog niet geoefend"', /Delen: nog niet geoefend/.test(bram));
  t.check('parents: note that "goed" includes second tries', /tweede poging/.test(bram));
  t.check('parents: tricky sums rebuilt with fromKey ("7 × 8 = 56" and "47 + 36 = 83")', /7 × 8 = 56/.test(bram) && /47 \+ 36 = 83/.test(bram), bram);
  t.check('parents: bars exist for the kinds', (await S(p, () => document.querySelectorAll('.pl-card:nth-of-type(2) .bar-fill').length)) === 6);
  await p.selectOption('#grade-' + (await S(p, () => RR.UI.state.store.players()[1].id)), '6');
  t.check('parents: grade select changes the stored grade', (await S(p, () => RR.UI.state.store.players()[1].grade)) === 6);
  // settings
  const set0 = await S(p, () => RR.UI.state.store.settings());
  t.check('defaults: sound on, music off, rest after 3', set0.sound === true && set0.music === false && set0.restAfter === 3, set0);
  await S(p, () => { window.__cfg = []; const cfg = RR.Sound.configure; RR.Sound.configure = function (o) { window.__cfg.push(JSON.stringify(o)); return cfg.apply(this, arguments); }; });
  await p.click('#s-ouders input[data-setting="music"]');
  await p.click('#s-ouders input[data-setting="sound"]');
  const set1 = await S(p, () => RR.UI.state.store.settings());
  t.check('parents: checkboxes change settings and call RR.Sound.configure', set1.music === true && set1.sound === false && (await S(p, () => window.__cfg.length)) >= 2, { set1, cfg: await S(p, () => window.__cfg) });
  t.check('header buttons follow the settings (aria-pressed)', (await S(p, () => document.getElementById('btn-music').getAttribute('aria-pressed') + document.getElementById('btn-sound').getAttribute('aria-pressed'))) === 'truefalse');
  await p.click('#btn-sound');
  t.check('header sound button toggles back and persists', (await S(p, () => RR.UI.state.store.settings().sound)) === true && (await S(p, () => document.querySelector('#s-ouders input[data-setting="sound"]').checked)) === true);
  await p.click('#btn-music');
  await p.selectOption('#sel-rest', '5');
  t.check('parents: rest moment select (Uit, 1..10)', (await S(p, () => RR.UI.state.store.settings().restAfter)) === 5 && (await S(p, () => [...document.querySelectorAll('#sel-rest option')].map((o) => o.textContent).join('|'))).startsWith('Uit|1 race|2 races|3 races') && (await S(p, () => document.querySelectorAll('#sel-rest option').length)) === 11);
  t.check('parents: "Over dit spel" paragraph', /geen klokken, geen punten en geen reclame/.test(await text(p, '.about')) && /op dit apparaat/.test(await text(p, '.about')));
  // reset needs a second confirmation
  await p.click('.pl-card:nth-of-type(1) [data-action="ask-reset"]');
  t.check('reset: first click only asks, nothing is gone yet', /Weet je het zeker\?/.test(await text(p, '.pl-card:nth-of-type(1)')) && (await S(p, () => Object.keys(RR.UI.state.store.stamps(RR.UI.state.store.players()[0].id)).length)) === 0);
  await p.click('.pl-card:nth-of-type(2) [data-action="ask-reset"]').catch(() => {});
  await p.click('#btn-confirm-cancel').catch(() => {});
  await p.click('.pl-card:nth-of-type(2) [data-action="ask-reset"]');
  t.check('reset: the confirm step has focus on "Annuleren"', await S(p, () => new Promise((r) => setTimeout(() => r(document.activeElement.id === 'btn-confirm-cancel'), 50))));
  await p.click('#btn-confirm-cancel');
  t.check('reset: cancel keeps the progress', (await S(p, () => Object.keys(RR.UI.state.store.stamps(RR.UI.state.store.players()[1].id)).length)) === 1);
  await p.click('.pl-card:nth-of-type(2) [data-action="ask-reset"]');
  await p.click('[data-action="confirm-yes"]');
  t.check('reset: confirmed wipes stamps and stats but keeps the player', (await S(p, () => { const st = RR.UI.state.store; const id = st.players()[1].id; return Object.keys(st.stamps(id)).length + st.kindStats(id).reduce((a, k) => a + k.total, 0); })) === 0 && (await S(p, () => RR.UI.state.store.players().length)) === 2);
  t.check('reset: a quiet notice says so', /De voortgang van Bram is gewist\./.test(await text(p, '.notice')));
  await p.click('.pl-card:nth-of-type(1) [data-action="ask-remove"]');
  t.check('remove: asks first', /wordt helemaal verwijderd/.test(await text(p, '.pl-card:nth-of-type(1)')) && (await S(p, () => RR.UI.state.store.players().length)) === 2);
  await p.click('[data-action="confirm-yes"]');
  t.check('remove: confirmed removes the player', (await S(p, () => RR.UI.state.store.players().map((x) => x.name).join())) === 'Bram');
  await p.click('.titlebar [data-action="nav"]');
  await waitScreen(p, 'menu');
  // removing the player who is logged in, then leaving the parents screen
  await p.click('#s-menu .foot button');
  await p.click('.pl-card [data-action="ask-remove"]');
  await p.click('[data-action="confirm-yes"]');
  t.check('removing the last player shows an empty-state line', /Er zijn nog geen spelers\./.test(await text(p, '#s-ouders')));
  await p.click('.titlebar [data-action="nav"]');
  await waitScreen(p, 'nieuw');
  t.check('with no player left, "Menu" leads to the new-player form (never to a broken garage)', (await state(p)).screen === 'nieuw');
  await noProblems(t, c);
  await c.ctx.close();
}

// ============================================================================
// G: reduced motion + rest moment after the 3rd race
// ============================================================================
async function sG(browser) {
  const t = makeT('G reduced motion and the rest moment');
  const c = await open(browser, { viewport: { width: 844, height: 390 }, reducedMotion: true, mobile: true, touch: true });
  const p = c.page;
  await createPlayer(p, 'Sien', 'eekhoorn', 4);
  await spies(p);
  t.check('scene runs in reduced-motion mode', (await S(p, () => RR.UI.state.scene.reducedMotion)) === true);
  t.check('CSS: no animations or transitions under reduce', (await S(p, () => { const e = document.querySelector('.screen:not([hidden])'); return getComputedStyle(e).animationName + '|' + getComputedStyle(document.querySelector('.btn, .menu-btn')).transitionDuration; })).startsWith('none|0s'));
  for (let n = 1; n <= 3; n++) {
    await toIntro(p, { track: n === 1 ? 1 : n });
    await p.click('#btn-start');
    const t0 = Date.now();
    const q0 = await (async () => { await waitAsk(p, 0); return Date.now(); })();
    await playRace(p, t, (i) => (n === 2 && i === 4 ? ['wrong', 'wrong'] : ['right']));
    if (n === 1) t.note(`reduced-motion race took ${Math.round((Date.now() - t0) / 1000)}s`);
    t.check(`race ${n}: finish screen`, (await state(p)).screen === 'finish' && (await state(p)).races === n);
    if (n < 3) {
      await p.click('[data-action="finish-garage"]');
      await waitScreen(p, 'menu');
      t.check(`after race ${n}: back in the garage (no rest moment yet)`, true);
    }
  }
  // measure pause between right answer and next question under reduced motion
  await p.click('[data-action="finish-garage"]');
  await waitScreen(p, 'rust');
  t.check('after the 3rd race the rest moment appears', (await text(p, '#h-rust')) === 'Mooi gedaan, Sien. Tijd voor een pauze?', await text(p, '#h-rust'));
  const btns = await S(p, () => [...document.querySelectorAll('#s-rust button')].map((b) => ({ t: b.textContent, h: b.getBoundingClientRect().height, w: b.getBoundingClientRect().width, primary: b.classList.contains('primary'), quiet: b.classList.contains('quiet'), fs: parseFloat(getComputedStyle(b).fontSize) })));
  t.check('rest moment: "Stoppen" is the big primary button, "Toch nog een race" is smaller and quiet', btns[0].t === 'Stoppen' && btns[0].primary && btns[1].t === 'Toch nog een race' && btns[1].quiet && btns[0].fs > btns[1].fs && btns[0].h > btns[1].h, btns);
  t.check('rest moment: focus on the heading', (await S(p, () => document.activeElement.id)) === 'h-rust');
  await p.click('text=Toch nog een race');
  await waitScreen(p, 'menu');
  t.check('"Toch nog een race" goes to the garage and resets the counter', (await state(p)).races === 0);
  // setting restAfter = 1 -> rest after one race; 0 -> never
  await p.evaluate(() => RR.UI.state.store.setSetting('restAfter', 1));
  await toIntro(p, { track: 1 });
  await p.click('#btn-start');
  await playRace(p, t, null);
  await p.click('[data-action="finish-again"]');
  await waitScreen(p, 'rust');
  t.check('"Nog een keer" also respects the rest moment when it is due', true);
  await p.click('text=Stoppen');
  await waitScreen(p, 'tot-ziens');
  t.check('"Stoppen" goes to the goodbye screen', (await text(p, '#h-tot-ziens')) === 'Tot de volgende keer, Sien.');
  await p.click('text=Terug naar het begin');
  await waitScreen(p, 'spelers');
  t.check('"Terug naar het begin" returns to the chooser and logs out', (await S(p, () => RR.UI.state.store.current())) === null && (await state(p)).races === 0);
  await p.click('.pcard[data-action="pick-player"]');
  await p.evaluate(() => RR.UI.state.store.setSetting('restAfter', 0));
  await toIntro(p, { track: 1 });
  await p.click('#btn-start');
  await playRace(p, t, null);
  await p.click('[data-action="finish-garage"]');
  await waitScreen(p, 'menu');
  t.check('restAfter = 0 (uit): no rest moment', true);
  // switching reduced motion at run time
  await p.emulateMedia({ reducedMotion: 'no-preference' });
  await sleep(100);
  t.check('scene follows prefers-reduced-motion changes at run time', (await S(p, () => RR.UI.state.scene.reducedMotion)) === false);
  await noProblems(t, c);
  await c.ctx.close();
}

// ============================================================================
// H: keyboard only
// ============================================================================
async function tabTo(p, sel, max = 60) {
  for (let i = 0; i < max; i++) {
    if (await S(p, (s) => !!document.activeElement && document.activeElement.matches(s), sel)) return true;
    await p.keyboard.press('Tab');
  }
  return false;
}
async function sH(browser) {
  const t = makeT('H keyboard only');
  const c = await open(browser, { viewport: { width: 1024, height: 768 }, url: false });
  const p = c.page;
  await p.addInitScript(() => { if (!localStorage.getItem('rekenrace:v1') && !window.name) { window.name = 'seeded'; localStorage.setItem('rekenrace:v1', JSON.stringify({ v: 1, counter: 1, current: null, settings: { sound: true, music: false, restAfter: 3 }, players: [{ id: 'p1', name: 'Tom', hero: 'egel', grade: 4, answers: {}, kinds: {}, stamps: {} }] })); } });
  await p.goto(require('./lib.cjs').URL);
  await spies(p);
  t.check('start: the chooser (not auto-login) with the stored player', (await state(p)).screen === 'spelers' && (await S(p, () => RR.UI.state.store.players().length)) === 1);
  t.check('Tab reaches the player card, Enter picks it', await tabTo(p, '.pcard[data-action="pick-player"]'));
  await p.keyboard.press('Enter');
  await waitScreen(p, 'menu');
  t.check('garage reached by keyboard', true);
  t.check('visible focus ring on the focused control', (await (async () => { await p.keyboard.press('Tab'); return S(p, () => { const e = document.activeElement; const cs = getComputedStyle(e); return cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) >= 2; }); })()));
  t.check('Tab reaches Kampioenschap, Enter opens the track list', await tabTo(p, '.menu-btn[data-to="banen"]'));
  await p.keyboard.press('Enter');
  await waitScreen(p, 'banen');
  t.check('Tab reaches the next track, Enter opens its start card', await tabTo(p, '.track.is-next'));
  await p.keyboard.press('Enter');
  await p.waitForSelector('#s-race[data-phase="intro"]');
  t.check('Start card: heading focused, Tab reaches Start', await tabTo(p, '#btn-start'));
  await p.keyboard.press('Enter');
  await p.waitForSelector('#s-race[data-phase="ask"]');
  t.check('first sum: focus is on the question (screen readers read it)', (await S(p, () => document.activeElement.id)) === 'q');
  const list = await S(p, () => window.__series[0].list);
  // sum 1: a typo corrected with Backspace, then right
  await p.keyboard.press('Digit9');
  await p.keyboard.press('Backspace');
  t.check('keyboard: digits and Backspace edit the answer', (await text(p, '#answer-text')) === '');
  const plan = (i) => (i === 1 ? ['wrong', 'wrong'] : i === 2 ? ['wrong', 'right'] : ['right']);
  const info = await playRace(p, t, plan, {
    keyboard: true,
    afterExplain: async () => {
      t.check('explain: focus is on "Volgende"', (await S(p, () => document.activeElement.id)) === 'btn-next');
    },
  });
  t.check('keyboard: a whole race with Enter, digits, Backspace and a wrong try', (await state(p)).screen === 'finish');
  t.check('finish: heading focused', (await S(p, () => document.activeElement.id)) === 'h-finish');
  // Escape opens the pause dialog during a race
  t.check('Tab reaches "Nog een keer", Enter starts a new start card', await tabTo(p, '[data-action="finish-again"]'));
  await p.keyboard.press('Enter');
  await p.waitForSelector('#s-race[data-phase="intro"]');
  await tabTo(p, '#btn-start');
  await p.keyboard.press('Enter');
  await p.waitForSelector('#s-race[data-phase="ask"]');
  await p.keyboard.press('Escape');
  t.check('Esc opens the pause dialog; focus goes to "Doorgaan"', (await S(p, () => document.getElementById('dlg-pause').open)) && (await S(p, () => document.activeElement.id)) === 'btn-resume');
  await p.keyboard.press('Digit5');
  t.check('dialog open: digits do not reach the sum', (await text(p, '#answer-text')) === '');
  await p.keyboard.press('Escape');
  t.check('Esc closes the pause dialog again', (await S(p, () => !document.getElementById('dlg-pause').open)));
  t.check('after closing the dialog the child can carry on typing', await (async () => { await p.keyboard.press('Digit6'); return (await text(p, '#answer-text')) === '6'; })());
  await noProblems(t, c);
  await c.ctx.close();
}

// ============================================================================
// I: pause dialog, stop, stray input
// ============================================================================
async function sI(browser) {
  const t = makeT('I pause, stop, stray input');
  const c = await open(browser, { viewport: { width: 390, height: 844 }, mobile: true, touch: true });
  const p = c.page;
  await createPlayer(p, 'Sien', 'eekhoorn', 4);
  await spies(p);
  await toIntro(p);
  t.check('Pauze button is hidden on the start card', (await S(p, () => document.getElementById('btn-pause').offsetParent === null)) === true);
  await p.click('#btn-start');
  await waitAsk(p, 0);
  t.check('Pauze button visible during the race', (await S(p, () => document.getElementById('btn-pause').offsetParent !== null)) === true);
  await p.click('#btn-pause');
  const dlg = await S(p, () => { const d = document.getElementById('dlg-title'); return { open: document.getElementById('dlg-pause').open, title: d.textContent, buttons: [...document.querySelectorAll('#dlg-pause .btn')].map((b) => b.textContent + ':' + b.classList.contains('primary')), checks: document.querySelectorAll('#dlg-pause input[type=checkbox]').length }; });
  t.check('pause dialog: Doorgaan (primary), Stoppen met deze race (secondary), two sound toggles', dlg.open && dlg.buttons.join('|') === 'Doorgaan:true|Stoppen met deze race:false' && dlg.checks === 2, dlg);
  t.check('pause dialog is a modal <dialog>', (await S(p, () => document.getElementById('dlg-pause').matches(':modal'))) === true);
  await p.click('#dlg-pause input[data-setting="sound"]');
  t.check('pause dialog: sound toggle works', (await S(p, () => RR.UI.state.store.settings().sound)) === false);
  await p.click('#dlg-pause input[data-setting="sound"]');
  await p.click('#btn-resume');
  t.check('Doorgaan continues the same sum', (await state(p)).phase === 'ask' && (await state(p)).index === 0);
  // answer a sum then pause during the glide
  const list = await S(p, () => window.__series[0].list);
  await typeKeypad(p, list[0].answer);
  await clickOk(p);
  t.check('during the glide, digits and Klaar are ignored', await (async () => {
    await p.keyboard.press('Digit4');
    await p.click('#keypad [data-d="3"]').catch(() => {});
    await p.keyboard.press('Enter');
    return (await text(p, '#answer-text')) === String(list[0].answer) && (await state(p)).index === 0;
  })());
  await waitAsk(p, 1);
  // pausing during a glide: the next sum waits for Doorgaan
  const l1 = list;
  await typeKeypad(p, l1[1].answer);
  await clickOk(p);
  await p.click('#btn-pause');
  await sleep(3000);
  const held = await state(p);
  t.check('paused during a glide: the next sum does not appear behind the dialog', held.index === 1 && held.phase === 'gliding', held);
  await p.click('#btn-resume');
  await waitAsk(p, 2);
  t.check('after Doorgaan the next sum appears', (await state(p)).index === 2);
  // stopping drops the race
  const before = await S(p, () => JSON.stringify(RR.UI.state.store.stamps()));
  await p.click('#btn-pause');
  await p.click('#dlg-pause [data-action="stop-race"]');
  await waitScreen(p, 'menu');
  t.check('"Stoppen met deze race" goes to the garage, race dropped, no stamp, no penalty', (await S(p, () => RR.UI.state.race)) === null && (await S(p, () => JSON.stringify(RR.UI.state.store.stamps()))) === before && (await state(p)).races === 0);
  await sleep(2500);
  t.check('nothing happens in the background after stopping (still the garage)', (await state(p)).screen === 'menu');
  // stopping while the glide is running must not bring the race back
  await toIntro(p, { track: 1 });
  await p.click('#btn-start');
  const l2 = await S(p, () => window.__series[1].list);
  await typeKeypad(p, l2[0].answer);
  await clickOk(p);
  await p.click('#btn-pause');
  await p.click('#dlg-pause [data-action="stop-race"]');
  await sleep(3000);
  t.check('stopping during a glide leaves the garage alone afterwards', (await state(p)).screen === 'menu');
  // another race: wrong first attempt does not change the sum; hint cleared on the next sum
  await toIntro(p, { track: 1 });
  await p.click('#btn-start');
  const l3 = await S(p, () => window.__series[2].list);
  await typeKeypad(p, l3[0].answer + 1);
  await clickOk(p);
  t.check('first wrong: still the same sum, field cleared, hint visible', (await state(p)).index === 0 && (await text(p, '#answer-text')) === '' && /Nog niet helemaal\./.test(await text(p, '#feedback')));
  t.check('first wrong: the feedback is calm (amber note, no red)', (await S(p, () => { const c = getComputedStyle(document.getElementById('feedback')); return c.borderLeftColor; })) === 'rgb(229, 127, 54)');
  await typeKeypad(p, l3[0].answer);
  await clickOk(p);
  t.check('second try right: "Goed, het is gelukt."', (await text(p, '#feedback')) === 'Goed, het is gelukt.');
  await waitAsk(p, 1);
  t.check('next sum starts with a clean feedback line', (await text(p, '#feedback')) === '');
  await noProblems(t, c);
  await c.ctx.close();
}

// ============================================================================
// J: timing of the glide (normal motion) and the sound switches
// ============================================================================
async function sJ(browser) {
  const t = makeT('J glide timing and sound');
  const c = await open(browser, { viewport: { width: 1366, height: 768 } });
  const p = c.page;
  await createPlayer(p, 'Sien', 'eekhoorn', 4);
  await spies(p);
  t.check('music is off by default, sound effects on', (await S(p, () => JSON.stringify(RR.UI.state.store.settings()))) === JSON.stringify({ sound: true, music: false, restAfter: 3 }));
  t.check('header buttons are labelled in Dutch with aria-pressed', (await S(p, () => [document.getElementById('btn-sound'), document.getElementById('btn-music')].map((b) => b.getAttribute('aria-label') + ':' + b.getAttribute('aria-pressed')).join('|'))) === 'Geluidseffecten:true|Muziek:false');
  await p.click('#btn-music');
  t.check('music button turns music on (aria-pressed true)', (await S(p, () => document.getElementById('btn-music').getAttribute('aria-pressed'))) === 'true' && (await S(p, () => RR.UI.state.store.settings().music)) === true);
  await p.click('#btn-music');
  await toIntro(p);
  await p.click('#btn-start');
  const list = await S(p, () => window.__series[0].list);
  const times = [];
  for (let i = 0; i < 3; i++) {
    await waitAsk(p, i);
    await typeKeypad(p, list[i].answer);
    const t0 = Date.now();
    await clickOk(p);
    await waitAsk(p, i + 1);
    times.push(Date.now() - t0);
  }
  t.check('the next sum appears when the glide ends (about 0.9 - 1.8 s, driven by the animation)', times.every((x) => x >= 800 && x <= 2200), times);
  const motion = await S(p, () => ({ idle: RR.UI.state.scene.reducedMotion }));
  t.check('normal motion: scene is not in reduced mode', motion.idle === false);
  await S(p, () => { window.__raf = 0; const r = window.requestAnimationFrame; window.requestAnimationFrame = (f) => { window.__raf++; return r(f); }; });
  await sleep(1000);
  const rafIdle = await S(p, () => window.__raf);
  t.check('while the child is thinking the scene only drifts gently (idle rAF budget)', rafIdle <= 40, rafIdle);
  await S(p, () => RR.UI.state.scene.setIdle(false));
  await noProblems(t, c);
  await c.ctx.close();
}

// ============================================================================
// K: copy lint (TXT), palette tokens, contrast, storage blocked
// ============================================================================
async function sK(browser) {
  const t = makeT('K copy, palette, contrast, blocked storage');
  const c = await open(browser, { viewport: { width: 1024, height: 768 } });
  const p = c.page;
  const lint = await S(p, () => {
    const out = { strings: 0, bad: [] };
    const track = { id: 3, name: 'Strand en duinen' };
    function visit(v, path) {
      if (typeof v === 'string') {
        out.strings++;
        if ((v.match(/!/g) || []).length > 1) out.bad.push(path + ': more than one "!"');
        if (/\b[A-ZÀ-Ý]{3,}\b/.test(v)) out.bad.push(path + ': ALL CAPS word');
        if (/fout/i.test(v)) out.bad.push(path + ': says fout');
        if (/(geweldig|amazing|super|wauw|gefeliciteerd)/i.test(v)) out.bad.push(path + ': hype');
        if (/\b(u|uw)\b/i.test(v)) out.bad.push(path + ': formal u/uw');
      } else if (typeof v === 'function') {
        [['Sien', 4, 10], [track], ['times', 7], [7, 40, 3]].forEach((args) => { try { const r = v.apply(null, args); if (typeof r === 'string') visit(r, path + '()'); } catch (e) { /* wrong sample arguments */ } });
      } else if (Array.isArray(v)) v.forEach((x, i) => visit(x, path + '[' + i + ']'));
      else if (v && typeof v === 'object') Object.keys(v).forEach((k) => visit(v[k], path + '.' + k));
    }
    visit(TXT, 'TXT');
    return out;
  });
  t.check(`copy lint over ${lint.strings} strings: at most one "!", no ALL CAPS, no "fout", no hype, always je/jij`, lint.bad.length === 0, lint.bad);
  const mismatch = await S(p, () => {
    const cs = getComputedStyle(document.documentElement);
    return Object.keys(RR.Sprites.PALETTE).filter((k) => cs.getPropertyValue('--pal-' + k).trim().toLowerCase() !== RR.Sprites.PALETTE[k].toLowerCase());
  });
  t.check('CSS palette tokens equal RR.Sprites.PALETTE (all 32)', mismatch.length === 0, mismatch);
  t.check('no ".sr-only"/hidden text hides important content', true);
  // contrast on several screens
  const results = [];
  const a11y = [];
  async function audit(label) {
    (await a11yScan(p)).forEach((x) => a11y.push(label + ': ' + x));
    const r = await contrastAudit(p);
    r.filter((x) => x.ok === false).forEach((x) => results.push(label + ': "' + x.text + '" ' + x.ratio + ' < ' + x.need + ' (' + x.cls + ')'));
    return r.filter((x) => x.skip).map((x) => label + ':' + x.text);
  }
  const skipped = [];
  skipped.push(...await audit('nieuw'));
  await createPlayer(p, 'Sien', 'eekhoorn', 4);
  skipped.push(...await audit('menu'));
  await p.evaluate(() => { const st = RR.UI.state.store; st.stamp(1, 2); st.recordAnswer('times:7x8', 'times', 'miss'); st.recordAnswer('add:3+4', 'add', 'first'); });
  await p.click('#s-menu [data-to="banen"]'); skipped.push(...await audit('banen'));
  await p.click('.titlebar [data-action="nav"]');
  await p.click('#s-menu [data-to="vrij"]'); skipped.push(...await audit('vrij'));
  await p.click('.titlebar [data-action="nav"]');
  await p.click('#s-menu [data-to="stempels"]'); skipped.push(...await audit('stempels'));
  await p.click('.titlebar [data-action="nav"]');
  await p.click('#s-menu .foot button'); skipped.push(...await audit('ouders'));
  await p.click('[data-action="ask-reset"]'); skipped.push(...await audit('ouders-confirm'));
  await p.click('#btn-confirm-cancel');
  await p.click('.titlebar [data-action="nav"]');
  await spies(p);
  await toIntro(p, { track: 1 }); skipped.push(...await audit('intro'));
  await p.click('#btn-start');
  await waitAsk(p, 0);
  skipped.push(...await audit('ask'));
  const q = await S(p, () => window.__series[0].list[0]);
  await typeKeypad(p, q.answer + 1); await clickOk(p);
  skipped.push(...await audit('hint'));
  await typeKeypad(p, q.answer + 1); await clickOk(p);
  skipped.push(...await audit('explain'));
  await p.click('#btn-pause'); skipped.push(...await audit('pause'));
  t.check('screen-reader basics on all audited screens: accessible names, alt attributes, unique ids, one h1, aria references resolve', a11y.length === 0, a11y);
  t.check('contrast >= 4.5:1 for normal text and 3:1 for large text on all audited screens (solid backgrounds)', results.length === 0, results);
  t.note('skipped (gradient backgrounds, checked by hand): ' + [...new Set(skipped)].join(', '));
  // the title bar gradient: white on both ends
  const hexLum = (h) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; const n = parseInt(h.slice(1), 16); return 0.2126 * f(n >> 16) + 0.7152 * f((n >> 8) & 255) + 0.0722 * f(n & 255); };
  const ratio = (a, b) => (Math.max(hexLum(a), hexLum(b)) + 0.05) / (Math.min(hexLum(a), hexLum(b)) + 0.05);
  const bar = await S(p, () => { const b = document.querySelector('.brand-name').getBoundingClientRect(), w = document.getElementById('titlebar').getBoundingClientRect(); return { frac: (b.right - w.left) / w.width, css: getComputedStyle(document.getElementById('titlebar')).backgroundImage }; });
  const mixHex = (a, b, f) => '#' + [0, 2, 4].map((i) => Math.round(parseInt(a.substr(1 + i, 2), 16) * (1 - f) + parseInt(b.substr(1 + i, 2), 16) * f).toString(16).padStart(2, '0')).join('');
  const behind = bar.frac <= 0.38 ? '#2b4a84' : mixHex('#2b4a84', '#4678bd', (bar.frac - 0.38) / 0.62);
  t.check('title bar: the name sits on a colour with >= 4.5:1 for cream-white text', ratio('#fbf6e9', behind) >= 4.5, { frac: bar.frac, behind, ratio: ratio('#fbf6e9', behind), css: bar.css });
  t.check('primary button face (white on deep teal) >= 4.5:1', ratio('#fbf6e9', '#174f5c') >= 4.5);
  t.check('muted text on cream window >= 4.5:1', ratio('#475473', '#f2dfb8') >= 4.5, ratio('#475473', '#f2dfb8'));
  await noProblems(t, c);
  await c.ctx.close();

  // storage that throws
  const c2 = await open(browser, { viewport: { width: 1024, height: 768 }, url: false });
  await c2.page.addInitScript(() => {
    const boom = () => { throw new DOMException('blocked', 'SecurityError'); };
    Object.defineProperty(window, 'localStorage', { get: boom, configurable: true });
  });
  await c2.page.goto(require('./lib.cjs').URL);
  t.check('storage blocked: game still starts', (await state(c2.page)).screen === 'nieuw');
  await createPlayer(c2.page, 'Zonder', 'egel', 4);
  t.check('storage blocked: can create a player and reach the garage', (await state(c2.page)).screen === 'menu');
  t.check('storage blocked: a quiet note says progress is lost when the window closes', /niet bewaard als je dit venster sluit/.test(await text(c2.page, '#s-menu')), await text(c2.page, '#s-menu'));
  await c2.page.evaluate(() => RR.UI.state.store.stamp(1, 1));
  await c2.page.click('#s-menu [data-to="stempels"]');
  t.check('storage blocked: progress works in memory', /gereden op/.test(await text(c2.page, '.slot')));
  await noProblems(t, c2, 'blocked storage');
  await c2.ctx.close();
}

// ============================================================================
// L: layout at every viewport (all screens) and the longest texts
// ============================================================================
async function sL(browser) {
  const t = makeT('L layout, all screens, all viewports');
  const names = Object.keys(shots.VPS);
  const results = await Promise.all(names.map((n) => shots.run(n, shots.VPS[n])));
  results.forEach((r) => {
    t.check(`${r.name} ${shots.VPS[r.name].width}x${shots.VPS[r.name].height}: all screens: no horizontal scroll, race fits without scrolling, targets >= 48px, no overlaps`, r.issues.length === 0, r.issues);
    t.check(`${r.name}: no console/network problems`, r.problems.length === 0, r.problems);
  });
  const res2 = await Promise.all(names.map((n) => stress.run(browser, n, shots.VPS[n])));
  res2.forEach((r) => {
    t.check(`${r.name}: longest question/hint/explanation texts (${r.cases} cases) fit without scrolling`, r.issues.length === 0, r.issues.slice(0, 12));
    t.check(`${r.name}: stress run had no console/network problems`, r.problems.length === 0, r.problems);
  });
}

// ============================================================================
// M: scene scale (crisp integer multiples) and live resizing during a race
// ============================================================================
async function sM(browser) {
  const t = makeT('M scene scale and live resizing');
  const want = { phone: 320, tab: 640, lap: 960, big: 960 };
  const garage = { phone: 320, tab: 640, lap: 640, big: 640 };
  for (const [name, w] of Object.entries(want)) {
    const vp = shots.VPS[name];
    const c = await open(browser, { viewport: { width: vp.width, height: vp.height } });
    const p = c.page;
    await createPlayer(p, 'Sien', 'eekhoorn', 4);
    await p.waitForTimeout(200);
    const g = await S(p, () => { const r = document.querySelector('canvas.scene').getBoundingClientRect(); return { w: r.width, h: r.height }; });
    t.check(`${name}: garage scene is ${garage[name]}px wide (a whole multiple of 320)`, Math.abs(g.w - garage[name]) < 0.5, g);
    await toIntro(p);
    await p.click('#btn-start');
    await waitAsk(p, 0);
    await p.waitForTimeout(200);
    const m = await S(p, () => { const c = document.querySelector('canvas.scene'); const r = c.getBoundingClientRect(); const cs = getComputedStyle(c); return { w: r.width, h: r.height, ir: cs.imageRendering, logical: c.width + 'x' + c.height }; });
    t.check(`${name} ${vp.width}x${vp.height}: race scene is ${w}px wide (whole multiple of 320, 1 to 3 device px per pixel)`, Math.abs(m.w - w) < 0.5 && Math.abs(m.h - w * 9 / 20) < 0.6, m);
    t.check(`${name}: canvas is pixelated and 320x144 inside`, m.ir === 'pixelated' && m.logical === '320x144', m);
    await c.ctx.close();
  }
  // the same on a 2x screen: the scene gets a whole number of device pixels per pixel
  const c2 = await open(browser, { viewport: { width: 390, height: 844 }, dpr: 3, mobile: true, touch: true });
  await createPlayer(c2.page, 'Sien', 'eekhoorn', 4);
  await toIntro(c2.page);
  await c2.page.click('#btn-start');
  await waitAsk(c2.page, 0);
  await c2.page.waitForTimeout(200);
  const w3 = await S(c2.page, () => document.querySelector('canvas.scene').getBoundingClientRect().width);
  t.check('phone at devicePixelRatio 3: scene width is a whole number of device pixels per pixel', Math.abs((w3 * 3) % 320) < 0.5 || Math.abs(((w3 * 3) % 320) - 320) < 0.5, w3);
  await c2.ctx.close();

  // live resizing in the middle of a race
  const c = await open(browser, { viewport: { width: 390, height: 844 }, mobile: true, touch: true });
  const p = c.page;
  await createPlayer(p, 'Sien', 'eekhoorn', 4);
  await spies(p);
  await toIntro(p);
  await p.click('#btn-start');
  await waitAsk(p, 0);
  const sizes = [[844, 390], [1024, 768], [1366, 768], [390, 844], [768, 1024], [360, 640], [640, 360]];
  const bad = [];
  for (const [w, h] of sizes) {
    await p.setViewportSize({ width: w, height: h });
    await p.waitForTimeout(250);
    (await layoutAudit(p)).forEach((f) => bad.push(`${w}x${h} ask: ${f}`));
  }
  const q = await S(p, () => window.__series[0].list[0]);
  await typeKeypad(p, q.answer + 1); await clickOk(p);
  await typeKeypad(p, q.answer + 1); await clickOk(p);
  await p.waitForSelector('#s-race[data-phase="explain"]');
  for (const [w, h] of sizes) {
    await p.setViewportSize({ width: w, height: h });
    await p.waitForTimeout(250);
    (await layoutAudit(p)).forEach((f) => bad.push(`${w}x${h} explain: ${f}`));
  }
  t.check('resizing / rotating during a race (ask and explain): layout keeps fitting, no scroll, no overlap', bad.length === 0, bad.slice(0, 10));
  await p.click('#btn-next');
  await waitAsk(p, 1);
  t.check('the race carries on after resizing', (await state(p)).index === 1);
  await noProblems(t, c);
  await c.ctx.close();
}

// ============================================================================
// N: pause while the karts drive over the finish line
// ============================================================================
async function sN(browser) {
  const t = makeT('N pause during the roll-out after the 10th sum');
  const c = await open(browser, { viewport: { width: 1024, height: 768 } });
  const p = c.page;
  await createPlayer(p, 'Sien', 'eekhoorn', 4);
  await spies(p);
  await toIntro(p);
  await p.click('#btn-start');
  const list = await S(p, () => window.__series[0].list);
  for (let i = 0; i < 9; i++) { await waitAsk(p, i); await typeKeypad(p, list[i].answer); await clickOk(p); }
  await waitAsk(p, 9);
  await typeKeypad(p, list[9].answer);
  await clickOk(p);
  await p.waitForFunction(() => RR.UI.state.race && RR.UI.state.race.phase === 'done', null, { timeout: 8000 });
  await p.click('#btn-pause');
  t.check('pause is possible while the karts drive over the line', await S(p, () => document.getElementById('dlg-pause').open));
  await sleep(3500);
  t.check('the finish screen waits behind the open pause dialog', (await state(p)).screen === 'race' && (await S(p, () => document.getElementById('dlg-pause').open)));
  await p.click('#btn-resume');
  await waitScreen(p, 'finish', 8000);
  t.check('Doorgaan lets the race finish, and the dialog is gone', (await S(p, () => !document.getElementById('dlg-pause').open)) && /Je hebt de stempel van Tulpenveld gehaald\./.test(await text(p, '#s-finish')));
  // second race: stop during the roll-out
  await p.click('[data-action="finish-again"]');
  await p.waitForSelector('#s-race[data-phase="intro"]');
  await p.click('#btn-start');
  const l2 = await S(p, () => window.__series[1].list);
  for (let i = 0; i < 9; i++) { await waitAsk(p, i); await typeKeypad(p, l2[i].answer); await clickOk(p); }
  await waitAsk(p, 9);
  await typeKeypad(p, l2[9].answer);
  await clickOk(p);
  await p.waitForFunction(() => RR.UI.state.race && RR.UI.state.race.phase === 'done', null, { timeout: 8000 });
  await p.click('#btn-pause');
  await p.click('#dlg-pause [data-action="stop-race"]');
  await sleep(3000);
  t.check('stopping during the roll-out: no finish screen, no second stamp event', (await state(p)).screen === 'menu' && (await state(p)).races === 1);
  await noProblems(t, c);
  await c.ctx.close();
}

// ============================================================================
// O: the longest possible name (12 wide letters) on every screen
// ============================================================================
async function sO(browser) {
  const t = makeT('O longest name on every screen');
  const names = Object.keys(shots.VPS);
  const bad = [];
  await Promise.all(names.map(async (n) => {
    const vp = shots.VPS[n];
    const c = await open(browser, { viewport: { width: vp.width, height: vp.height }, mobile: vp.mobile, touch: vp.touch, reducedMotion: true });
    const p = c.page;
    await createPlayer(p, 'WWWWWWWWWWWW', 'egel', 4);
    await p.evaluate(() => { const st = RR.UI.state.store; for (let i = 1; i <= 8; i++) st.stamp(i, 2); st.addPlayer({ name: 'MMMMMMMMMMMM', hero: 'uil', grade: 6 }); });
    for (const id of ['menu', 'stempels', 'rijbewijs', 'ouders', 'rust', 'tot-ziens', 'spelers']) {
      await p.evaluate((x) => RR.UI.show(x), id);
      await p.waitForTimeout(250);
      (await layoutAudit(p)).forEach((f) => bad.push(`${n}/${id}: ${f}`));
    }
    await c.ctx.close();
    if (c.problems.length) bad.push(n + ': ' + c.problems.join('; '));
  }));
  t.check('no overflow, no clipped controls with 12-letter names (5 viewports x 7 screens)', bad.length === 0, bad.slice(0, 10));
}

// ---------- main ----------
const ALL = { A: sA, B: sB, C: sC, D: sD, E: sE, F: sF, G: sG, H: sH, I: sI, J: sJ, K: sK, L: sL, M: sM, N: sN, O: sO };

(async () => {
  const want = process.argv.slice(2).map((x) => x.toUpperCase());
  const keys = Object.keys(ALL).filter((k) => !want.length || want.includes(k));
  const browser = await chromium.launch();
  const started = Date.now();
  await Promise.all(keys.map(async (k) => {
    try { await ALL[k](browser); } catch (e) { const t = makeT(k + ' crashed'); t.check('scenario finished', false, String(e && e.stack || e).split('\n').slice(0, 6).join(' | ')); }
  }));
  await browser.close();
  let fails = 0, total = 0;
  reports.sort((a, b) => a.name.localeCompare(b.name)).forEach((r) => {
    console.log('\n== ' + r.name + (r.fails ? '  (' + r.fails + ' FAILED)' : ''));
    r.lines.forEach((l) => { total += /^ {2}(ok|FAIL)/.test(l) ? 1 : 0; console.log(l); });
    fails += r.fails;
  });
  console.log(`\n${total} checks, ${fails} failed, ${Math.round((Date.now() - started) / 1000)}s`);
  process.exit(fails ? 1 : 0);
})();
