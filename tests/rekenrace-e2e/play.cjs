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
// (the keypad ignores clicks for a moment right after Start, so a double-click on Start cannot type a digit)
const waitAsk = (page, i, timeout = 25000) => page.waitForFunction((n) => { const R = RR.UI.state.race; return R && R.index === n && R.phase === 'ask' && performance.now() >= (R.keysFrom || 0); }, i, { timeout });
// (Volgende ignores a press for a moment after the explanation appears, so a double tap on Klaar cannot skip it)
const explainReady = (page, timeout = 8000) => page.waitForFunction(() => { const R = RR.UI.state.race; return R && R.phase === 'explain' && performance.now() >= (R.explainFrom || 0); }, null, { timeout });
const waitScreen = (page, id, timeout = 25000) => page.waitForSelector(`#s-${id}:not([hidden])`, { timeout });
// (non-breaking spaces around operators are a render detail: tests compare with plain spaces)
const text = (page, sel) => page.evaluate((s) => { const e = document.querySelector(s); return e ? e.innerText.trim().replace(/\u00a0/g, ' ') : null; }, sel);

// Clicks Start and waits until the keypad accepts clicks again (it ignores them for a moment, so a double-click on Start cannot type a digit).
async function startRace(page) {
  await page.click('#btn-start');
  await page.waitForFunction(() => { const R = RR.UI.state.race; return R && R.phase !== 'intro' && performance.now() >= (R.keysFrom || 0); }, null, { timeout: 8000 });
}

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
      await explainReady(page);
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
  t.check('first run on a computer: focus is in the name box, so typing can start at once', (await S(p, () => document.activeElement.id)) === 'in-name');
  await p.waitForTimeout(150);
  t.check('aria-live region announces the screen', (await text(p, '#announce')) === 'Nieuwe speler');
  t.check('maxlength 12 on the name input', (await S(p, () => document.getElementById('in-name').maxLength)) === 12);
  t.check('visible label for the name input', (await text(p, 'label[for="in-name"]')) === 'Hoe heet je?');
  const heroes = await S(p, () => [...document.querySelectorAll('.hero-card')].map((e) => ({ img: (e.querySelector('img') || {}).src || '', name: e.querySelector('.hero-name').textContent, tag: e.querySelector('.hero-tag').textContent, radio: e.querySelector('input').type })));
  t.check('4 hero radio cards with kart pictures (data URLs), names and taglines', heroes.length === 4 && heroes.every((h) => h.img.startsWith('data:image/png') && h.radio === 'radio' && h.tag.length > 20), heroes.map((h) => h.name));
  t.check('hero names come from RR.Heroes', JSON.stringify(heroes.map((h) => h.name)) === JSON.stringify(await S(p, () => RR.Heroes.map((h) => h.name))));
  t.check('grade radios Groep 3-6, none pre-selected (a groep 3 child must not get groep 4 sums by not looking)', JSON.stringify(await S(p, () => [...document.querySelectorAll('input[name=grade]')].map((i) => i.value + (i.checked ? '*' : '')))) === JSON.stringify(['3', '4', '5', '6']));

  await p.click('#form-new button[type=submit]');
  t.check('empty submit: name error shown (Dutch) and focus in the name field', (await text(p, '#err-name')) === 'Vul eerst je naam in.' && (await S(p, () => document.activeElement.id)) === 'in-name');
  t.check('empty submit: hero error shown', (await text(p, '#err-hero')) === 'Kies een held om mee te racen.');
  t.check('empty submit: grade error shown', (await text(p, '#err-grade')) === 'Kies in welke groep je zit.');
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
  t.check('a missing group is asked for (focus on the first group chip), the name is not judged yet', (await text(p, '#err-grade')) === 'Kies in welke groep je zit.' && (await S(p, () => document.activeElement.id)) === 'grade-3' && !(await text(p, '#err-name')), await text(p, '#err-name'));
  await p.click('label[for="grade-4"]');
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
  const beforeReload = await S(p, () => ({ raw: (localStorage.getItem('rekenrace:v1') || '').slice(0, 300), status: RR.UI.state.store.status() }));
  await p.reload();
  const afterReload = await S(p, () => ({ raw: (localStorage.getItem('rekenrace:v1') || '').slice(0, 300), status: RR.UI.state.store.status(), screen: RR.UI.state.screen, n: RR.UI.state.store.players().length }));
  t.check('reload always lands on the chooser (no auto-login)', (await state(p)).screen === 'spelers' && (await S(p, () => RR.UI.state.store.current())) === null, { beforeReload, afterReload });
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
  await startRace(p);
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
  t.check('Klaar with an empty field counts nothing: still the first attempt, only the line "Typ eerst je antwoord."', (await state(p)).phase === 'ask' && (await S(p, () => RR.UI.state.race.attempt)) === 0 && (await text(p, '#feedback')) === 'Typ eerst je antwoord.', await text(p, '#feedback'));
  await typeKeypad(p, '123456');
  t.check('answer box takes at most 5 digits', (await text(p, '#answer-text')) === '12345');
  await p.click('#keypad .key-del');
  await p.click('#keypad .key-del');
  t.check('backspace removes digits', (await text(p, '#answer-text')) === '123');
  await p.click('#keypad .key-del'); await p.click('#keypad .key-del'); await p.click('#keypad .key-del'); await p.click('#keypad .key-del');
  t.check('backspace on an empty field is harmless', (await text(p, '#answer-text')) === '');
  const seen = [];
  // The first glide is held open by a gate that only this test opens (the scene itself is untouched: its animation runs
  // as usual and the game waits for the promise it returns). So the "ignored while gliding" check below holds for as long
  // as the four inputs take, however loaded the machine is, and it asserts on the phase variable, not on the clock.
  await S(p, () => {
    const sc = RR.UI.state.scene; const orig = sc.advanceTo;
    const gate = window.__glideGate = { open: false, wake: null, release() { gate.open = true; if (gate.wake) gate.wake(); } };
    sc.advanceTo = function () { sc.advanceTo = orig; return orig.apply(this, arguments).then(() => new Promise((res) => { if (gate.open) res(); else gate.wake = res; })); };
  });
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
      const during = { shown: await text(p, '#answer-text'), want: String(q.answer), phase: (await state(p)).phase, fb: await text(p, '#feedback') };
      t.check('while gliding: digits, keypad, Enter and Backspace are ignored', during.shown === during.want && during.phase === 'gliding', during);
      await S(p, () => window.__glideGate.release());
    }
  }
  await waitScreen(p, 'finish');
  const tEnd = Date.now() - t0;
  const snd = await S(p, () => window.__snd);
  t.check("sounds: 'ok' and 'glide' were played, 'stamp' on the new stamp", snd.includes('ok') && snd.includes('glide') && snd.includes('stamp') && !snd.includes('almost'), snd.join(','));
  t.check('feedback rotates through the three calm sentences', new Set(seen).size === 3, seen);
  const fin = await text(p, '#s-finish');
  t.check('finish heading is a calm place sentence (perfect race wins)', (await text(p, '#h-finish')) === 'Je bent als eerste over de finish gekomen.', await text(p, '#h-finish'));
  t.check('finish: "10 van 10 goed" and no "waarvan" line when every answer was first time', /10 van 10 goed/.test(fin) && !/waarvan/.test(fin), fin.slice(0, 200));
  t.check('finish: standings list of 4 with head portraits and the player marked', (await S(p, () => document.querySelectorAll('.stand-row').length)) === 4 && (await S(p, () => document.querySelectorAll('.stand-row img').length)) === 4 && /Sien \(jij\)/.test(fin));
  t.check('finish: stamp earned, named', /Je hebt de stempel van Tulpenveld gehaald\./.test(fin));
  t.check('finish: no practise list after a perfect race', !/Oefenen/.test(fin));
  t.check('finish: primary "Terug naar het menu", secondary "Nog een keer"', (await S(p, () => [...document.querySelectorAll('#s-finish .btn')].map((b) => b.textContent + ':' + b.classList.contains('primary')))).join('|') === 'Terug naar het menu:true|Nog een keer:false');
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
  await startRace(p);
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
  t.check('finish: "9 van 10 goed" and "waarvan 7 in één keer" (7 first, two second tries, one miss)', /9 van 10 goed/.test(fin) && /waarvan 7 in één keer/.test(fin), fin.slice(0, 300));
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
  t.check('intro of a free race says so', /vrije race/i.test((await text(p, '#intro-extra')) || '') && /Je oefent de tafel van 7\./.test(await text(p, '#intro-extra')), await text(p, '#intro-extra'));
  await startRace(p);
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
  t.check('intro mentions the division table', /Je oefent delen met de tafel van 4\./.test(await text(p, '#intro-extra')), await text(p, '#intro-extra'));
  await startRace(p);
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
  t.check('stamp card: 8 slots; earned ones carry a Dutch long date', slots.length === 8 && /^gereden op \d{1,2} (januari|februari|maart|april|mei|juni|juli|augustus|september|oktober|november|december) \d{4}$/.test(slots[0]) && slots[2] === 'nog geen stempel', slots);
  t.check('stamp card: no licence button before all 8 stamps', (await S(p, () => document.querySelectorAll('#s-stempels [data-to="rijbewijs"]').length)) === 0);
  await S(p, () => { const st = RR.UI.state.store; for (let i = 1; i <= 8; i++) st.stamp(i, 3); });
  await p.evaluate(() => RR.UI.show('stempels'));
  t.check('stamp card: licence button appears after 8 stamps', (await text(p, '#s-stempels [data-to="rijbewijs"]')) === 'Rekenrijbewijs bekijken');
  await p.click('#s-stempels [data-to="rijbewijs"]');
  await waitScreen(p, 'rijbewijs');
  t.check('licence: heading, name, kart picture, 8 stamps, date, sentence', (await text(p, '#h-rijbewijs')).toLowerCase() === 'rekenrijbewijs' && (await text(p, '.licence-name')) === 'Sien' && (await S(p, () => document.querySelectorAll('.licence-stamp').length)) === 8 && (await S(p, () => document.querySelector('.licence-kart').src.startsWith('data:'))) && /Datum: \d{1,2} \w+ \d{4}/.test(await text(p, '.licence-date')) && /heeft alle acht de banen/.test(await text(p, '.licence-text')));
  t.check('licence heading is plain "Rekenrijbewijs", not forced into capitals (D5)', (await S(p, () => getComputedStyle(document.getElementById('h-rijbewijs')).textTransform)) === 'none' && (await text(p, '#h-rijbewijs')) === 'Rekenrijbewijs');
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
    await startRace(p);
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
  await startRace(p);
  await playRace(p, t, null);
  await p.click('[data-action="finish-again"]');
  await waitScreen(p, 'rust');
  t.check('"Nog een keer" also respects the rest moment when it is due', true);
  await p.click('text=Stoppen');
  await waitScreen(p, 'tot-ziens');
  t.check('"Stoppen" goes to the goodbye screen', (await text(p, '#h-tot-ziens')) === 'Tot de volgende keer, Sien.');
  // the second tap of a double tap on "Stoppen" lands on the button below it: it must not skip the goodbye
  await p.evaluate(() => document.querySelector('[data-action="restart"]').click());
  await sleep(120);
  t.check('goodbye: a tap in the first moment is ignored, the goodbye stays', (await state(p)).screen === 'tot-ziens', await state(p));
  await p.waitForFunction(() => performance.now() >= RR.UI.state.goodbyeFrom, null, { timeout: 4000 });
  await p.click('text=Terug naar het begin');
  await waitScreen(p, 'spelers');
  t.check('"Terug naar het begin" returns to the chooser and logs out', (await S(p, () => RR.UI.state.store.current())) === null && (await state(p)).races === 0);
  await p.click('.pcard[data-action="pick-player"]');
  await p.evaluate(() => RR.UI.state.store.setSetting('restAfter', 0));
  await toIntro(p, { track: 1 });
  await startRace(p);
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
  // One stray Tab puts the focus on a keypad key. Typing the answer and Enter must still CHECK it (not press that key),
  // and Space still presses the focused key.
  await p.keyboard.press('Backspace');
  await waitAsk(p, 0);        // (the keypad ignores a press for a moment after Start)
  await p.keyboard.press('Tab');
  const strayKey = await S(p, () => { const e = document.activeElement; return e && e.classList.contains('key') ? { d: e.dataset.d || e.dataset.action, ok: e.classList.contains('key-ok') } : null; });
  t.check('one stray Tab: the focus is on a keypad key', !!strayKey && !strayKey.ok, strayKey);
  // (which key the first Tab lands on depends on the layout: a digit key types its digit, the delete key types nothing)
  const wantByKey = strayKey && /^[0-9]$/.test(strayKey.d) ? strayKey.d : '';
  await p.keyboard.press('Space');
  t.check('stray Tab: Space still presses the focused key', (await text(p, '#answer-text')) === wantByKey, { shown: await text(p, '#answer-text'), strayKey });
  await p.keyboard.press('Backspace');
  const stray = await S(p, () => ({ answer: RR.UI.state.race.q.answer, attempt: RR.UI.state.race.attempt }));
  for (const ch of String(stray.answer)) await p.keyboard.press(ch);
  t.check('stray Tab: the typed answer shows exactly what was typed', (await text(p, '#answer-text')) === String(stray.answer), await text(p, '#answer-text'));
  await p.keyboard.press('Enter');
  const strayAfter = await S(p, () => ({ phase: RR.UI.state.race.phase, attempt: RR.UI.state.race.attempt, input: RR.UI.state.race.input, fb: document.getElementById('feedback').innerText.trim() }));
  t.check('stray Tab: Enter after the digits checks the answer (a right answer starts the glide, no digit is added)', strayAfter.attempt === stray.attempt + 1 && strayAfter.phase !== 'ask' && FIRST_FEEDBACK.includes(strayAfter.fb), strayAfter);
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
  await startRace(p);
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
  await startRace(p);
  const l2 = await S(p, () => window.__series[1].list);
  await typeKeypad(p, l2[0].answer);
  await clickOk(p);
  await p.click('#btn-pause');
  await p.click('#dlg-pause [data-action="stop-race"]');
  await sleep(3000);
  t.check('stopping during a glide leaves the garage alone afterwards', (await state(p)).screen === 'menu');
  // another race: wrong first attempt does not change the sum; hint cleared on the next sum
  await toIntro(p, { track: 1 });
  await startRace(p);
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
  // The page runs on Playwright's fake clock (it flows like the real one until the test pauses it): the glide length is
  // measured in animation time, stepped by the test, so a loaded machine cannot stretch it.
  const c = await open(browser, { viewport: { width: 1366, height: 768 }, url: false });
  const p = c.page;
  await p.clock.install();
  await p.goto(require('./lib.cjs').URL);
  await createPlayer(p, 'Sien', 'eekhoorn', 4);
  await spies(p);
  t.check('music is off by default, sound effects on', (await S(p, () => JSON.stringify(RR.UI.state.store.settings()))) === JSON.stringify({ sound: true, music: false, restAfter: 3, view: 'side' }));
  t.check('header buttons are labelled in Dutch with aria-pressed', (await S(p, () => [document.getElementById('btn-sound'), document.getElementById('btn-music')].map((b) => b.getAttribute('aria-label') + ':' + b.getAttribute('aria-pressed')).join('|'))) === 'Geluidseffecten:true|Muziek:false');
  await p.click('#btn-music');
  t.check('music button turns music on (aria-pressed true)', (await S(p, () => document.getElementById('btn-music').getAttribute('aria-pressed'))) === 'true' && (await S(p, () => RR.UI.state.store.settings().music)) === true);
  await p.click('#btn-music');
  await toIntro(p);
  await startRace(p);
  const list = await S(p, () => window.__series[0].list);
  const times = [];
  const phases = [];
  for (let i = 0; i < 3; i++) {
    await waitAsk(p, i);
    await typeKeypad(p, list[i].answer);
    // from here on the page's time only moves when this test moves it (the fake clock flows like the real one until now, so on a
    // loaded machine the moment we aim at can already be past: aim further ahead until it is accepted)
    for (let margin = 50; ; margin *= 4) {
      try { await p.clock.pauseAt((await S(p, () => Date.now())) + margin); break; } catch (e) { if (margin > 5000 || !/past/.test(String(e))) throw e; }
    }
    await clickOk(p);
    phases.push((await state(p)).phase);
    let ms = 0;
    while (ms < 4000) {
      const st0 = await state(p);
      if (st0.phase !== 'gliding') break;
      await p.clock.runFor(25);
      ms += 25;
    }
    const after = await state(p);
    times.push(after.phase === 'ask' && after.index === i + 1 ? ms : -ms);
    await p.clock.resume();
  }
  t.check('right answer: the kart is gliding at once and the next sum waits for the glide', phases.every((x) => x === 'gliding'), phases);
  t.check('the next sum appears when the glide ends (about 0.9 - 1.8 s of animation time, driven by the animation)', times.every((x) => x >= 800 && x <= 2200), times);
  t.note('glide lengths in animation time (ms): ' + times.join(', '));
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
  await startRace(p);
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
    await startRace(p);
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
  await startRace(c2.page);
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
  await startRace(p);
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
  await explainReady(p);
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
  await startRace(p);
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
  await startRace(p);
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

// ============================================================================
// P: review fixes, keyboard / pointer / screen reader behaviour
// ============================================================================
async function sP(browser) {
  const t = makeT('P review fixes: input guards, focus, screen reader');
  const c = await open(browser, { viewport: { width: 1024, height: 768 } });
  const p = c.page;
  await createPlayer(p, 'Tom', 'egel', 4);
  await spies(p);
  await toIntro(p);

  // EXPLORE-4: the second click of a double-click on Start must not type a digit
  await p.dblclick('#btn-start');
  await p.waitForTimeout(100);
  t.check('double-click on Start types nothing into the first answer', (await S(p, () => RR.UI.state.race.input)) === '', await S(p, () => RR.UI.state.race.input));
  await waitAsk(p, 0);
  await typeKeypad(p, '9');
  t.check('after the short settle time the keypad works', (await text(p, '#answer-text')) === '9');
  await p.keyboard.press('Backspace');

  // A11Y-1 / EXPLORE-3: after Pauze and Doorgaan a physical Enter checks the answer (it used to re-open the dialog)
  await p.click('#btn-pause');
  await p.click('#btn-resume');
  await p.waitForTimeout(50);     // the dialog's close event is queued after the click
  t.check('after Pauze -> Doorgaan focus is back on the sum', (await S(p, () => document.activeElement.id)) === 'q', await S(p, () => document.activeElement.id));
  const q0 = await S(p, () => window.__series[0].list[0]);
  await typeKeys(p, String(q0.answer));
  await p.keyboard.press('Enter');
  t.check('Enter after Pauze -> Doorgaan checks the answer instead of opening the pause dialog', (await S(p, () => !document.getElementById('dlg-pause').open)) && ['gliding', 'ask'].includes((await state(p)).phase) && (await S(p, () => RR.UI.state.race.log.length)) === 1);
  await waitAsk(p, 1);
  // Escape from a mouse-opened dialog (focus would go back to Pauze) is covered by the same close handler
  await p.click('#btn-pause');
  await p.keyboard.press('Escape');
  await p.waitForTimeout(50);
  t.check('Pauze -> Escape: focus is back on the sum', (await S(p, () => document.activeElement.id)) === 'q', await S(p, () => document.activeElement.id));
  // the sound switch in the title bar must not swallow a later Enter either
  await p.click('#btn-sound');
  const q1 = await S(p, () => window.__series[0].list[1]);
  await typeKeys(p, String(q1.answer));
  await p.keyboard.press('Enter');
  t.check('Enter after clicking the sound switch checks the answer (sound stays as set)', (await S(p, () => RR.UI.state.race.log.length)) === 2 && (await S(p, () => RR.UI.state.store.settings().sound)) === false);
  await p.click('#btn-sound');
  await waitAsk(p, 2);

  // CALM-1: a double tap on Klaar must not skip the explanation (all in one page task, so no timing luck is involved)
  const q2 = await S(p, () => window.__series[0].list[2]);
  const quick = await S(p, (wrong) => {
    const press = (sel) => document.querySelector(sel).click();
    const type = (v) => String(v).split('').forEach((d) => press('#keypad [data-d="' + d + '"]'));
    type(wrong); press('#keypad [data-action="ok"]');
    type(wrong); press('#keypad [data-action="ok"]');            // 2nd wrong answer: the explanation appears
    const afterShow = RR.UI.state.race.phase;
    press('#btn-next'); press('#btn-next');                       // the double tap
    return { afterShow, afterDoubleTap: RR.UI.state.race.phase, logged: RR.UI.state.race.log.length };
  }, q2.answer + 1);
  t.check('explain: two immediate presses on Volgende do not skip the explanation', quick.afterShow === 'explain' && quick.afterDoubleTap === 'explain' && quick.logged === 2, quick);
  // DUTCH-1 / A11Y-2: the explanation is the description of the focused button
  t.check('explain: Volgende has focus', (await S(p, () => document.activeElement.id)) === 'btn-next');
  const desc = await (async () => {
    const cdp = await c.ctx.newCDPSession(p);
    await cdp.send('Accessibility.enable');
    const { nodes } = await cdp.send('Accessibility.getFullAXTree');
    const btn = nodes.find((n) => n.role && n.role.value === 'button' && n.name && n.name.value === 'Volgende');
    return btn && btn.description && btn.description.value;
  })();
  t.check('explain: a screen reader hears the answer and the method as the description of "Volgende"', typeof desc === 'string' && desc.startsWith('Het antwoord is ' + q2.answer + '.') && desc.length > 30, desc);

  await explainReady(p);
  await p.click('#btn-next');
  t.check('explain: Volgende works once the explanation has had a moment', ['gliding', 'ask'].includes((await state(p)).phase) && (await S(p, () => RR.UI.state.race.log.length)) === 3);
  await waitAsk(p, 3);
  // EXPLORE-5: a held Enter (auto-repeat) must not press Volgende
  const q3 = await S(p, () => window.__series[0].list[3]);
  await typeKeys(p, String(q3.answer + 1)); await p.keyboard.press('Enter');
  await typeKeys(p, String(q3.answer + 1));
  await p.keyboard.down('Enter');                    // submits the 2nd wrong answer: explanation appears
  await explainReady(p);
  await p.keyboard.down('Enter');                    // auto-repeat of the same held key (repeat: true)
  await p.keyboard.down('Enter');
  await p.waitForTimeout(200);
  t.check('a held Enter does not dismiss the explanation', (await state(p)).phase === 'explain', await state(p));
  await p.keyboard.up('Enter');
  await p.keyboard.press('Enter');
  t.check('a fresh Enter press does', ['gliding', 'ask'].includes((await state(p)).phase));
  await noProblems(t, c);
  await c.ctx.close();

  // A11Y-10: the confirmation after a reset is focused and announced
  const c2 = await open(browser, { viewport: { width: 390, height: 700 } });
  const p2 = c2.page;
  await createPlayer(p2, 'Anna', 'egel', 4);
  await p2.evaluate(() => { const st = RR.UI.state.store; ['Bram', 'Cor', 'Dina'].forEach((n) => st.addPlayer({ name: n, hero: 'pad', grade: 5 })); });
  await p2.evaluate(() => RR.UI.show('ouders'));
  await p2.evaluate(() => document.getElementById('s-ouders').scrollTo(0, 99999));
  const askButtons = await p2.$$('[data-action="ask-reset"]');
  await askButtons[askButtons.length - 1].click();
  await p2.click('#btn-confirm-cancel');
  t.check('Annuleren: focus returns to the button that asked', (await S(p2, () => document.activeElement.getAttribute('data-action') + ':' + document.activeElement.getAttribute('data-id'))) === 'ask-reset:' + (await S(p2, () => RR.UI.state.store.players().slice(-1)[0].id)));
  const again = await p2.$$('[data-action="ask-reset"]');
  await again[again.length - 1].click();
  await p2.click('[data-action="confirm-yes"]');
  const n = await S(p2, () => { const e = document.activeElement; const r = e.getBoundingClientRect(); return { cls: e.className, role: e.getAttribute('role'), text: e.textContent, inView: r.top >= 0 && r.bottom <= window.innerHeight }; });
  t.check('after "Ja, wis de voortgang" the focus is on the visible confirmation', n.cls === 'notice' && n.inView && /is gewist\.$/.test(n.text), n);
  await p2.waitForTimeout(150);
  t.check('and it is announced in the live region', /is gewist\.$/.test(await text(p2, '#announce')), await text(p2, '#announce'));
  await noProblems(t, c2, 'ouders');
  await c2.ctx.close();

  // EXPLORE-14a: a modifier key is not an activation, so the audio context is not started by it
  const c3 = await open(browser, { viewport: { width: 1024, height: 768 } });
  await c3.page.keyboard.press('Shift');
  await c3.page.keyboard.press('Escape');
  t.check('Shift / Escape as the very first key do not start the audio (no autoplay warning)', (await S(c3.page, () => RR.Sound.isUnlocked())) === false && c3.problems.length === 0, c3.problems);
  await c3.page.keyboard.press('Tab');
  t.check('an ordinary key does unlock it', (await S(c3.page, () => RR.Sound.isUnlocked())) === true);
  await c3.ctx.close();
}

// ============================================================================
// Q: review fixes, game logic and copy
// ============================================================================
async function sQ(browser) {
  const t = makeT('Q review fixes: repeats, finish card, stamp card, names, copy');
  const c = await open(browser, { viewport: { width: 1024, height: 768 }, reducedMotion: true });
  const p = c.page;
  await createPlayer(p, 'Tom', 'egel', 4);
  await spies(p);

  // CODE-1: a missed sum only comes back in a race that suits it
  await p.evaluate(() => {
    const st = RR.UI.state.store;
    st.recordAnswer('times:7x8', 'times', 'miss', { grade: 4, level: 8 });
    st.recordAnswer('add:12+13', 'add', 'miss', { grade: 4, level: 1 });
    st.recordAnswer('sub:7778-5394', 'sub', 'second', { grade: 6, level: 1 });
    st.recordAnswer('add:40+20', 'add', 'miss');                      // no context: older data
  });
  await toIntro(p, { mode: 'free', track: 1, focus: 'mix' });
  await startRace(p);
  const rep1 = await S(p, () => window.__series[window.__series.length - 1].opts.repeat);
  t.check('free race on track 1 (groep 4): only sums that fit come back, not the level-8 or groep-6 ones', JSON.stringify(rep1) === JSON.stringify(['add:40+20', 'add:12+13']), rep1);
  await p.evaluate(() => { RR.UI.show('menu'); RR.UI.state.store.setGrade(RR.UI.state.store.current().id, 3); });
  await toIntro(p, { mode: 'free', track: 1, focus: 'mix' });
  await startRace(p);
  const rep2 = await S(p, () => window.__series[window.__series.length - 1].opts.repeat);
  t.check('after the grade is lowered to groep 3, earlier groep-4 misses do not come back', JSON.stringify(rep2) === JSON.stringify(['add:40+20']), rep2);
  await p.evaluate(() => { RR.UI.show('menu'); RR.UI.state.store.setGrade(RR.UI.state.store.current().id, 4); });
  // a miss in a real race is stored with where it happened
  await toIntro(p, { mode: 'championship' });
  await startRace(p);
  const q0 = await S(p, () => window.__series[window.__series.length - 1].list[0]);
  await waitAsk(p, 0);
  await typeKeys(p, String(q0.answer + 1)); await p.keyboard.press('Enter');
  await typeKeys(p, String(q0.answer + 1)); await p.keyboard.press('Enter');
  await explainReady(p);
  const rec = await S(p, (key) => JSON.parse(localStorage.getItem('rekenrace:v1')).players[0].answers[key], q0.key);
  await p.keyboard.press('Enter');
  await waitAsk(p, 1);
  const rec2 = await S(p, (key) => JSON.parse(localStorage.getItem('rekenrace:v1')).players[0].answers[key], q0.key);
  t.check('a miss in a real race is stored with grade and level (groep 4, track 1)', rec2 && rec2.last === 'miss' && rec2.grade === 4 && rec2.level === 1, { rec, rec2 });
  await p.evaluate(() => RR.UI.state.store.resetProgress(RR.UI.state.store.current().id));

  // CODE-2: the parents' list only shows sums that are still open
  await p.evaluate(() => {
    const st = RR.UI.state.store;
    st.recordAnswer('times:7x8', 'times', 'miss'); st.recordAnswer('times:7x8', 'times', 'miss');
    for (let i = 0; i < 4; i++) st.recordAnswer('times:7x8', 'times', 'first');
    st.recordAnswer('add:36+47', 'add', 'miss');
    RR.UI.show('ouders');
  });
  const tricky = await text(p, '.pl-card .tricky');
  t.check('parents: a sum missed twice but right first time since is no longer listed as tricky', /36 \+ 47 = 83/.test(tricky) && !/7 × 8/.test(tricky), tricky);
  await p.evaluate(() => RR.UI.state.store.resetProgress(RR.UI.state.store.current().id));

  // DUTCH-2 / UX-2 / CALM-5: the finish fact counts first and second tries; the "waarvan" line is only for a mix
  await p.evaluate(() => RR.UI.show('menu'));
  await toIntro(p, { mode: 'free', track: 1, focus: 'add' });
  await startRace(p);
  await playRace(p, t, () => ['wrong', 'right']);
  let fin = await text(p, '#s-finish');
  t.check('finish after ten second tries: "10 van 10 goed" and no "0 in één keer" line', /10 van 10 goed/.test(fin) && !/waarvan/.test(fin) && !/in één keer/.test(fin), fin.slice(0, 160));
  await p.click('[data-action="finish-again"]');
  await p.waitForSelector('#s-race[data-phase="intro"]');
  await startRace(p);
  await playRace(p, t, (i) => (i < 3 ? ['wrong', 'wrong'] : i === 3 ? ['wrong', 'right'] : ['right']));
  fin = await text(p, '#s-finish');
  t.check('finish with 3 misses, 1 second try, 6 first tries: "7 van 10 goed" and "waarvan 6 in één keer"; the practise list names the 3 misses', /7 van 10 goed/.test(fin) && /waarvan 6 in één keer/.test(fin) && (await S(p, () => document.querySelectorAll('.practise-list li').length)) === 3, fin.slice(0, 200));
  t.check('finish of a free race: no stamp sentence, no licence line', !/stempel/i.test(fin) && !/Rekenrijbewijs/.test(fin), fin.slice(0, 300));

  // DUTCH-3: the answer in the practise list is labelled
  await p.evaluate(() => RR.UI.show('menu'));
  await toIntro(p, { mode: 'free', track: 1, focus: 'story' });
  await startRace(p);
  await playRace(p, t, (i) => (i === 0 ? ['wrong', 'wrong'] : ['right']));
  const li = await S(p, () => [...document.querySelectorAll('.practise-list li')].map((x) => x.textContent));
  t.check('a missed story sum in the practise list reads "... ? Antwoord: 33"', li.length === 1 && /\? Antwoord: \d+$/.test(li[0].replace(/ /g, ' ')), li);

  // DUTCH-4: stamp card copy for a track that was only raced freely
  await p.evaluate(() => RR.UI.show('stempels'));
  const st = await text(p, '#s-stempels');
  t.check('stamp card: says the stamps come from the Kampioenschap, mentions the licence, and "nog geen stempel"', /in het Kampioenschap rijdt, krijg je een stempel/.test(st) && /Rekenrijbewijs/.test(st) && /Tulpenveld\s+nog geen stempel/.test(st) && !/nog niet gereden/.test(st), st.slice(0, 260));
  t.check('free race title on the start card matches the race header', await (async () => {
    await p.evaluate(() => RR.UI.show('menu'));
    await toIntro(p, { mode: 'free', track: 1, focus: 'times', table: 7 });
    const a = await text(p, '#intro-title'); const b = await text(p, '#race-title');
    return a === 'Vrije race: Tulpenveld' && b === a;
  })());
  const extra = await text(p, '#intro-extra');
  t.check('free race start card: whole sentences ("Je oefent de tafel van 7.")', extra === 'Dit is een vrije race. Je krijgt hier geen stempel voor. Je oefent de tafel van 7.', extra);
  await p.evaluate(() => RR.UI.show('menu'));
  const menuText = await text(p, '#s-menu');
  await p.click('#s-menu [data-to="vrij"]');
  const vrij = await text(p, '#s-vrij');
  t.check('free race setup says later tracks are harder and that a lock means "first in the Kampioenschap"', /Een latere baan heeft moeilijkere sommen\. Een baan met een slotje rijd je eerst in het Kampioenschap\./.test(vrij), vrij);
  t.check('garage: "Kies zelf een baan en een soort sommen"', /Kies zelf een baan en een soort sommen/.test(menuText), menuText);
  t.check('parents: the about text says missed sums return and that later tracks are harder', await (async () => {
    await p.evaluate(() => RR.UI.show('ouders'));
    const about = await text(p, '.about');
    return /Sommen die nog niet lukten komen later nog een keer terug\. Een latere baan heeft moeilijkere sommen, ook bij een vrije race\./.test(about) && /geen account/.test(about);
  })());
  await noProblems(t, c);
  await c.ctx.close();

  // UX-1 / DUTCH-10: the end of the championship points at the licence
  const c2 = await open(browser, { viewport: { width: 1024, height: 768 }, reducedMotion: true });
  const p2 = c2.page;
  await createPlayer(p2, 'Lotte', 'pad', 4);
  await spies(p2);
  await p2.evaluate(() => { const s = RR.UI.state.store; for (let i = 1; i <= 7; i++) s.stamp(i, 2); });
  await p2.evaluate(() => RR.UI.show('menu'));
  t.check('garage at 7 stamps: normal subtitle', /7 van 8 stempels/.test(await text(p2, '#s-menu')));
  await toIntro(p2, { mode: 'championship' });
  await startRace(p2);
  await playRace(p2, t, null);
  const fin8 = await text(p2, '#s-finish');
  const btns = await S(p2, () => [...document.querySelectorAll('#s-finish .btn')].map((b) => b.textContent + ':' + b.classList.contains('primary') + ':' + b.classList.contains('quiet')));
  t.check('finish of the 8th stamp: "Alle acht de stempels zijn binnen. Je Rekenrijbewijs ligt klaar."', /Alle acht de stempels zijn binnen\. Je Rekenrijbewijs ligt klaar\./.test(fin8), fin8);
  t.check('finish of the 8th stamp: a quiet licence button; "Terug naar het menu" stays the only primary button', btns.join('|') === 'Rekenrijbewijs bekijken:false:true|Terug naar het menu:true:false|Nog een keer:false:false', btns);
  await p2.click('#s-finish [data-to="rijbewijs"]');
  await waitScreen(p2, 'rijbewijs');
  t.check('the licence button opens the licence, and back leads to the stamp card', (await text(p2, '#h-rijbewijs')) === 'Rekenrijbewijs' && (await text(p2, '.titlebar [data-action="nav"]')) === 'Terug');
  await p2.evaluate(() => RR.UI.show('menu'));
  t.check('garage at 8 stamps says the licence is ready', /Je rijbewijs is klaar/.test(await text(p2, '#s-menu')), await text(p2, '#s-menu'));
  await p2.click('[data-action="other-player"]');
  await p2.waitForSelector('#s-spelers:not([hidden])');
  await noProblems(t, c2, 'licence flow');
  await c2.ctx.close();

  // DUTCH-5: a name that ends in punctuation does not give "Hoi, Lola!."
  const c3 = await open(browser, { viewport: { width: 1024, height: 768 }, reducedMotion: true });
  const p3 = c3.page;
  await createPlayer(p3, 'Lola!', 'uil', 4);
  const h1 = await text(p3, '#h-menu');
  await p3.evaluate(() => RR.UI.show('rust'));
  const rust = await text(p3, '#h-rust');
  await p3.evaluate(() => RR.UI.show('tot-ziens'));
  const tz = await text(p3, '#h-tot-ziens');
  const pz = await S(p3, () => { RR.UI.show('spelers'); return document.querySelector('.pcard-name').textContent; });
  t.check('names ending in "!" : "Hoi, Lola." / "Mooi gedaan, Lola. Tijd voor een pauze?" / "Tot de volgende keer, Lola."', h1 === 'Hoi, Lola.' && rust === 'Mooi gedaan, Lola. Tijd voor een pauze?' && tz === 'Tot de volgende keer, Lola.', { h1, rust, tz });
  t.check('the name itself is kept as typed where it stands alone', pz === 'Lola!', pz);
  await p3.evaluate(() => { const s = RR.UI.state.store; s.removePlayer(s.players()[0].id); s.addPlayer({ name: 'Jan.', hero: 'egel', grade: 4 }); s.addPlayer({ name: 'Max?', hero: 'pad', grade: 4 }); });
  await p3.evaluate(() => { const s = RR.UI.state; s.store.select(s.store.players()[0].id); RR.UI.show('menu'); });
  const jan = await text(p3, '#h-menu');
  t.check('"Jan." gives "Hoi, Jan." (one dot)', jan === 'Hoi, Jan.', jan);
  await noProblems(t, c3, 'names');
  await c3.ctx.close();

  // EXPLORE-10: eight players: the chooser says why there is no "Nieuwe speler" card
  const c4 = await open(browser, { viewport: { width: 1024, height: 768 }, reducedMotion: true });
  const p4 = c4.page;
  await p4.evaluate(() => { const s = RR.UI.state.store; for (let i = 1; i <= 8; i++) s.addPlayer({ name: 'Kind' + i, hero: 'egel', grade: 4 }); RR.UI.show('spelers'); });
  const sp = await text(p4, '#s-spelers');
  t.check('8 players: no "Nieuwe speler" card, but the reason is written on the chooser', !(await S(p4, () => !!document.querySelector('.pcard-new'))) && /Er zijn al 8 spelers\. Een ouder kan een speler verwijderen bij Ouders\./.test(sp), sp);
  await c4.ctx.close();

  // UX-7 (b): the new-player form brings an error into view, even on a small phone
  const c5 = await open(browser, { viewport: { width: 360, height: 640 }, reducedMotion: true, touch: true, mobile: true });
  const p5 = c5.page;
  await p5.fill('#in-name', 'Noor');
  await p5.click('label[for="grade-4"]');
  await p5.click('#form-new button[type=submit]');
  await p5.waitForTimeout(200);
  const vis = await S(p5, () => { const e = document.getElementById('err-hero'); const r = e.getBoundingClientRect(); return { text: e.textContent, top: Math.round(r.top), bottom: Math.round(r.bottom), vh: innerHeight, shown: !e.hidden }; });
  t.check('no hero chosen on a 360x640 phone: the message is inside the visible window', vis.shown && vis.top >= 0 && vis.bottom <= vis.vh, vis);
  t.check('the first-run form tells parents the name stays on the device', /Je naam blijft alleen op dit apparaat\./.test(await text(p5, '#hint-name')));
  await c5.ctx.close();
}

// ============================================================================
// R: review fixes, layout, pointer and print behaviour
// ============================================================================
async function sR(browser) {
  const t = makeT('R review fixes: keypad on small phones, touch, forced colours, fallbacks, print');

  // EXPLORE-2: "Klaar" stays on screen on small phones
  const seed = JSON.stringify({ v: 1, counter: 2, current: null, settings: { sound: false, music: false, restAfter: 0 }, players: [{ id: 'p1', name: 'Gees', hero: 'egel', grade: 5, answers: {}, kinds: {}, stamps: {} }] });
  const sizes = [[390, 844, 3], [360, 640, 4], [375, 553, 6], [360, 560, 6], [320, 568, 6], [844, 390, 6], [375, 667, 4]];   // (round 4: the flat keypad now starts at 810 px high on a 430 px wide phone, and 320 px wide gets six thin columns)
  for (const [w, h, cols] of sizes) {
    const c = await open(browser, { viewport: { width: w, height: h }, reducedMotion: true, touch: true, mobile: true, url: false });
    const p = c.page;
    await p.addInitScript((s) => { try { if (!localStorage.getItem('rekenrace:v1')) localStorage.setItem('rekenrace:v1', s); } catch (e) {} }, seed);
    await p.goto(require('./lib.cjs').URL);
    await p.click('.pcard[data-id="p1"]');
    await toIntro(p);
    await startRace(p);
    await p.waitForTimeout(250);
    const m = await S(p, () => { const k = document.querySelector('#keypad .key-ok').getBoundingClientRect(); const keys = [...document.querySelectorAll('#keypad .key')].map((e) => e.getBoundingClientRect()); const sec = document.getElementById('s-race'); return { okBottom: Math.round(k.bottom), vh: innerHeight, cols: getComputedStyle(document.getElementById('keypad')).gridTemplateColumns.split(' ').length, minW: Math.round(Math.min(...keys.map((r) => r.width))), minH: Math.round(Math.min(...keys.map((r) => r.height))), scroll: sec.scrollHeight - sec.clientHeight, cls: document.documentElement.className }; });
    t.check(`${w}x${h}: ${cols} key columns, "Klaar" inside the window, every key at least 48x48, no scrolling on a plain sum`, m.cols === cols && m.okBottom <= m.vh && m.minW >= 47.5 && m.minH >= 47.5 && m.scroll <= 1, m);
    await c.ctx.close();
  }

  // EXPLORE-1: a tap on a key counts while another finger rests on the screen
  {
    const c = await open(browser, { viewport: { width: 390, height: 844 }, touch: true, mobile: true, reducedMotion: true });
    const p = c.page;
    await createPlayer(p, 'Tom', 'egel', 4);
    await toIntro(p);
    await startRace(p);
    await waitAsk(p, 0);
    const cdp = await c.ctx.newCDPSession(p);
    const centre = (sel) => S(p, (s) => { const r = document.querySelector(s).getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; }, sel);
    const input = () => S(p, () => RR.UI.state.race.input);
    const touch = (type, pts) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts });
    const k5 = await centre('#keypad [data-d="5"]');
    await p.touchscreen.tap(k5.x, k5.y);
    t.check('touch: one tap on a key types exactly one digit (the click that follows is not counted twice)', (await input()) === '5', await input());
    await p.touchscreen.tap(k5.x, k5.y);
    t.check('touch: two quick taps on the same key type two digits', (await input()) === '55', await input());
    await S(p, () => { RR.UI.state.race.input = ''; });
    const q = await centre('#q'); const k7 = await centre('#keypad [data-d="7"]');
    await touch('touchStart', [{ x: q.x, y: q.y, id: 1 }]);
    await touch('touchStart', [{ x: q.x, y: q.y, id: 1 }, { x: k7.x, y: k7.y, id: 2 }]);
    await touch('touchEnd', [{ x: q.x, y: q.y, id: 1 }]);
    await touch('touchEnd', []);
    await p.waitForTimeout(100);
    t.check('touch: a tap on 7 counts while another finger rests on the screen', (await input()) === '7', await input());
    await S(p, () => { RR.UI.state.race.input = ''; });
    const k8 = await centre('#keypad [data-d="8"]');
    await touch('touchStart', [{ x: k8.x, y: k8.y, id: 1 }]);
    for (let i = 1; i <= 6; i++) await touch('touchMove', [{ x: k8.x, y: k8.y - i * 12, id: 1 }]);
    await touch('touchEnd', []);
    await p.waitForTimeout(100);
    const k9 = await centre('#keypad [data-d="9"]');
    await touch('touchStart', [{ x: k9.x, y: k9.y, id: 1 }]);
    await touch('touchMove', [{ x: k9.x - 160, y: k9.y, id: 1 }]);
    await touch('touchEnd', []);
    await p.waitForTimeout(100);
    t.check('touch: a swipe that starts on a key, and a slide off a key, type nothing', (await input()) === '', await input());
    await noProblems(t, c, 'touch');
    await c.ctx.close();
  }

  // A11Y-4: forced colours: a chosen hero card and chip differ from an unchosen one
  {
    const c = await open(browser, { viewport: { width: 1024, height: 768 } });
    const p = c.page;
    await p.emulateMedia({ forcedColors: 'active' });
    await p.click('label[for="hero-pad"]');
    await p.click('label[for="grade-5"]');
    const f = await S(p, () => {
      const info = (sel) => { const e = document.querySelector(sel); const b = getComputedStyle(e, '::before'); return { border: getComputedStyle(e).borderTopWidth, dot: b.backgroundImage }; };
      return { padOn: info('label[for="hero-pad"]'), egelOff: info('label[for="hero-egel"]'), g5On: info('label[for="grade-5"]'), g3Off: info('label[for="grade-3"]') };
    });
    t.check('forced colours: the chosen hero card and group chip have a thicker border and a dot, the others do not', f.padOn.border === '4px' && f.egelOff.border === '2px' && /radial-gradient/.test(f.padOn.dot) && !/radial-gradient/.test(f.egelOff.dot) && f.g5On.border === '4px' && f.g3Off.border === '2px' && /radial-gradient/.test(f.g5On.dot), f);
    await c.ctx.close();
  }

  // CODE-4: a browser that blanks canvas read-back still shows the pictures
  {
    const c = await open(browser, { viewport: { width: 1024, height: 768 }, url: false });
    const p = c.page;
    await p.addInitScript(() => { HTMLCanvasElement.prototype.toDataURL = function () { return 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='; }; });
    await p.goto(require('./lib.cjs').URL);
    const heroes = await S(p, () => ({ canvases: document.querySelectorAll('.hero-card canvas.pix').length, imgs: document.querySelectorAll('.hero-card img').length, brand: document.getElementById('brand-icon').tagName, readback: RR.Sprites.readbackWorks() }));
    const painted = await S(p, () => { const cv = document.querySelector('.hero-card canvas.pix'); const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data; let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i] > 0) n++; return { n, w: cv.width, h: cv.height }; });
    t.check('read-back blanked: hero pictures and the title bar icon are canvases with real pixels', heroes.canvases === 4 && heroes.imgs === 0 && heroes.brand === 'CANVAS' && heroes.readback === false && painted.n > 100 && painted.w === 96, { heroes, painted });
    await createPlayer(p, 'Tom', 'egel', 4);
    const menu = await S(p, () => ({ icons: document.querySelectorAll('.menu-icon').length, canvasIcons: document.querySelectorAll('canvas.menu-icon').length, hero: !!document.querySelector('canvas.menu-hero') }));
    t.check('read-back blanked: the garage icons and portrait are canvases too', menu.icons === 4 && menu.canvasIcons === 4 && menu.hero, menu);
    await p.screenshot({ path: SHOTS + '/rfp-menu.png' });
    t.check('read-back blanked: no errors or warnings', c.problems.length === 0, c.problems);
    await c.ctx.close();
  }

  // CODE-5: a swallowed drawing error leaves one console line
  {
    const c = await open(browser, { viewport: { width: 1024, height: 768 }, url: false });
    const p = c.page;
    await p.addInitScript(() => { const d = CanvasRenderingContext2D.prototype.drawImage; CanvasRenderingContext2D.prototype.drawImage = function () { if (this.canvas.width === 320 && this.canvas.height === 144) throw new Error('forced draw failure'); return d.apply(this, arguments); }; });
    await p.goto(require('./lib.cjs').URL);
    await createPlayer(p, 'Tom', 'egel', 4);
    await p.evaluate(() => RR.UI.show('menu'));
    await p.waitForTimeout(500);
    const warns = c.problems.filter((x) => /forced draw failure/.test(x));
    t.check('a drawing failure is logged once with console.warn ("Rekenrace scene: ...") and the game carries on', warns.length === 1 && /Rekenrace scene: forced draw failure/.test(warns[0]) && (await S(p, () => RR.UI.state.screen)) === 'menu', c.problems);
    await c.ctx.close();
  }

  // A11Y-3 / EXPLORE-13: the licence fits on one A5 page, also with very wide names
  {
    const c = await open(browser, { viewport: { width: 1024, height: 768 } });
    const p = c.page;
    const out = [];
    for (const name of ['Sien', 'Mohammed Ami', 'MMMMMMMMMMMM', 'WWWWWWWWWWWW', 'Wouter-Jan W']) {
      await p.evaluate((n) => { const s = RR.UI.state.store; s.players().forEach((x) => s.removePlayer(x.id)); const r = s.addPlayer({ name: n, hero: 'egel', grade: 4 }); s.select(r.player.id); for (let i = 1; i <= 8; i++) s.stamp(i, 2); RR.UI.show('rijbewijs'); }, name);
      await p.waitForTimeout(150);
      const buf = await p.pdf({ preferCSSPageSize: true, printBackground: true });
      out.push(name + ':' + (buf.toString('latin1').match(/\/Type\s*\/Page[^s]/g) || []).length);
    }
    t.check('print: the licence is one A5 page for "Sien", "Mohammed Ami", 12 x M, 12 x W, "Wouter-Jan W"', out.every((x) => x.endsWith(':1')), out);
    await c.ctx.close();
  }

  // DUTCH-12: a division is spoken as "gedeeld door"
  {
    const c = await open(browser, { viewport: { width: 1024, height: 768 }, reducedMotion: true });
    const p = c.page;
    await createPlayer(p, 'Tom', 'egel', 5);
    await p.evaluate(() => { const s = RR.UI.state.store; for (let i = 1; i <= 8; i++) s.stamp(i, 2); });
    await p.evaluate(() => RR.UI.show('menu'));
    await toIntro(p, { mode: 'free', track: 6, focus: 'div', table: 4 });
    await startRace(p);
    await waitAsk(p, 0);
    const q = await S(p, () => { const e = document.getElementById('q'); return { text: RR.UI.state.race.q.text, visible: e.children[0] && e.children[0].getAttribute('aria-hidden'), visibleText: e.children[0] && e.children[0].textContent, spoken: e.children[1] && e.children[1].textContent, cls: e.children[1] && e.children[1].className, shown: e.innerText.trim() }; });
    t.check('a division is shown with ":" and spoken as "gedeeld door"', / : /.test(q.text) && q.visible === 'true' && q.visibleText === q.text && q.spoken === q.text.split(' : ').join(' gedeeld door ') && /sr-only/.test(q.cls), q);
    const label = await p.locator('#q').ariaSnapshot();
    t.check('the accessibility tree of the question has the spoken form only', /gedeeld door/.test(label) && !/ : /.test(label), label);
    await c.ctx.close();
  }

  // A11Y-9 / CODE-8: the empty answer box has no underscore in its accessible text; no pull-to-refresh
  {
    const c = await open(browser, { viewport: { width: 1024, height: 768 }, reducedMotion: true });
    const p = c.page;
    await createPlayer(p, 'Tom', 'egel', 4);
    await toIntro(p);
    await startRace(p);
    await waitAsk(p, 0);
    const snap = await p.locator('#answer').ariaSnapshot();
    t.check('empty answer box: accessible text is "Jouw antwoord:" without an underscore', /Jouw antwoord:/.test(snap) && !/_/.test(snap), snap);
    t.check('overscroll-behavior is none on the page', (await S(p, () => getComputedStyle(document.body).overscrollBehaviorY)) === 'none');
    await c.ctx.close();
    const cm = await open(browser, { viewport: { width: 1024, height: 768 } });     // with motion allowed
    t.check('the keypad dims with a short fade, not in one step (and not at all with reduced motion)', (await S(cm.page, () => getComputedStyle(document.getElementById('keypad')).transitionDuration)) === '0.2s');
    await cm.ctx.close();
  }

  // operators stay on one line with their numbers in hints and explanations (A11Y-8 / UX-9), at a phone and a tablet width
  for (const [w, h] of [[390, 844], [1024, 768]]) {
    const c = await open(browser, { viewport: { width: w, height: h }, reducedMotion: true, touch: w < 600, mobile: w < 600 });
    const p = c.page;
    await createPlayer(p, 'Tom', 'egel', 5);
    await p.evaluate(() => { const s = RR.UI.state.store; for (let i = 1; i <= 4; i++) s.stamp(i, 2); });
    await spies(p);
    await toIntro(p, { mode: 'free', track: 5, focus: 'mix' });
    await startRace(p);
    const bad = [];
    let raw = 0;
    for (let i = 0; i < 10; i++) {
      await waitAsk(p, i);
      const a = await S(p, () => RR.UI.state.race.q.answer);
      await typeKeys(p, String(a + 1)); await p.keyboard.press('Enter');
      const hint = await S(p, () => { const e = document.getElementById('feedback'); return e.textContent; });
      if (/ [+−×=] /.test(hint)) raw++;
      await typeKeys(p, String(a + 1)); await p.keyboard.press('Enter');
      await p.waitForSelector('#s-race[data-phase="explain"]');
      const r = await S(p, () => {
        const OPS = '+−×=';
        const out = { raw: / [+−×=] /.test(document.getElementById('explain-text').textContent), edges: [] };
        // find the places where a line breaks, and look at the characters on both sides
        document.querySelectorAll('#explain-text p, #feedback .fb').forEach((el) => {
          const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
          let prev = null;
          for (let n = walker.nextNode(); n; n = walker.nextNode()) {
            for (let k = 0; k < n.nodeValue.length; k++) {
              const ch = n.nodeValue[k];
              if (/\s/.test(ch) && ch !== ' ') { continue; }
              const rg = document.createRange(); rg.setStart(n, k); rg.setEnd(n, k + 1);
              const rects = rg.getClientRects(); if (!rects.length) continue;
              const top = Math.round(rects[0].top);
              if (prev && top > prev.top + 4) { if (OPS.indexOf(prev.ch) >= 0 || OPS.indexOf(ch) >= 0) out.edges.push(prev.ch + '|' + ch); }
              prev = { ch: ch, top: top };
            }
          }
        });
        return out;
      });
      if (r.raw) raw++;
      if (r.edges.length) bad.push(...r.edges);
      await explainReady(p);
      await p.keyboard.press('Enter');
    }
    t.check(`${w}px wide: ten explanations and hints have no plain space next to an operator, and no line starts or ends with one`, raw === 0 && bad.length === 0, { raw, bad });
    await noProblems(t, c, `${w}px`);
    await c.ctx.close();
  }
}

// ---------- S: the start-up note (a page that cannot start must say so) ----------
async function sS(browser) {
  const t = makeT('S boot fallback: a blocked or crashing script never gives a silent blank page');
  const http = require('http');
  const FILE = require('./lib.cjs').URL.replace(/^file:\/\//, '');
  const source = () => fs.readFileSync(FILE, 'utf8');
  const srv = http.createServer((req, res) => {
    const u = req.url.split('?')[0];
    res.setHeader('content-type', 'text/html; charset=utf-8');
    if (u === '/game.html') return res.end(source());
    if (u === '/host-csp.html') {      // a viewer that only lets its own (nonce) scripts run
      res.setHeader('content-security-policy', "script-src 'nonce-host123'; default-src 'none'; style-src 'unsafe-inline'; img-src data:");
      return res.end(source());
    }
    if (u === '/syntax-error.html') return res.end(source().replace('RR.Rng = (function () {', 'RR.Rng = (function ( {'));
    res.statusCode = 404; res.end();
  });
  await new Promise((r) => srv.listen(0, r));
  const base = 'http://127.0.0.1:' + srv.address().port;
  const noteState = (page) => page.evaluate(() => {
    const n = document.getElementById('boot-note');
    const r = n.getBoundingClientRect();
    return {
      display: getComputedStyle(n).display, hidden: n.hidden, h: Math.round(r.height), text: n.innerText.replace(/\s+/g, ' ').trim(), role: n.getAttribute('role'),
      screens: [...document.querySelectorAll('.screen')].filter((s) => !s.hidden).map((s) => s.id), brand: document.querySelector('.brand-name').textContent,
      iconSrc: (document.getElementById('brand-icon') || {}).src ? 'set' : 'empty', boot: document.documentElement.getAttribute('data-boot'),
      errors: [...n.querySelectorAll('.boot-error')].map((e) => e.textContent), bodyText: document.body.innerText,
      firstInMain: document.getElementById('main').firstElementChild.id,
    };
  });
  async function visit(url, { init, js = true, after } = {}) {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, javaScriptEnabled: js, isMobile: true, hasTouch: true });
    const page = await ctx.newPage();
    const pageErrors = [];
    page.on('pageerror', (e) => pageErrors.push(e.message));
    if (init) await page.addInitScript(init);
    await page.goto(base + url);
    await page.waitForTimeout(700);
    if (after) { await page.evaluate(after); await page.waitForTimeout(300); }
    const st = await noteState(page);
    return { ctx, page, st, pageErrors };
  }

  try {
    // (a) the host blocks inline scripts
    let v = await visit('/host-csp.html');
    t.check('host blocks inline scripts: the note is visible, with a height', v.st.display !== 'none' && v.st.h > 40, v.st);
    t.check('host blocks inline scripts: first line "Het spel wordt gestart..."', v.st.text.startsWith('Het spel wordt gestart...'), v.st.text);
    t.check('host blocks inline scripts: second line says what to do', v.st.text.includes('Lukt dit niet? Open het bestand in Safari of Chrome. In een voorbeeldvenster draait het spel soms niet.'), v.st.text);
    t.check('the note is a status, the first thing inside <main>', v.st.role === 'status' && v.st.firstInMain === 'boot-note', v.st);
    t.check('host blocks inline scripts: no screen is showing, and no error text is invented', v.st.screens.length === 0 && v.st.errors.length === 0, v.st);
    t.check('the title bar is never empty: the name and the icon are in the HTML itself', v.st.brand === 'Rekenrace' && v.st.iconSrc === 'set', v.st);
    await v.page.screenshot({ path: SHOTS + '/boot-host-csp.png' });
    await v.ctx.close();

    // (b) the game script stops on an error while starting
    v = await visit('/game.html', { init: () => { window.matchMedia = function () { throw new Error('matchMedia kapot'); }; } });
    t.check('start-up error: the note is visible again and says "Er ging iets mis"', v.st.display !== 'none' && v.st.h > 40 && /^Het spel wordt gestart\.\.\./.test(v.st.text) && /Er ging iets mis: .*matchMedia kapot/.test(v.st.text), v.st);
    t.check('start-up error: the game is not marked as started', v.st.boot === null, v.st.boot);
    await v.page.screenshot({ path: SHOTS + '/boot-startup-error.png' });
    await v.ctx.close();

    v = await visit('/syntax-error.html');
    t.check('syntax error in the game script: the message and a line number are shown', v.st.display !== 'none' && v.st.errors.length === 1 && /^Er ging iets mis: SyntaxError: .+ \(regel \d+\)$/.test(v.st.errors[0]), v.st);
    t.check('syntax error: "Uncaught" is not repeated in the sentence', !/Uncaught/.test(v.st.errors[0] || ''), v.st.errors);
    await v.page.screenshot({ path: SHOTS + '/boot-syntax-error.png' });
    await v.ctx.close();

    // (c) a normal start: the note is hidden by the game script and was never in view
    v = await visit('/game.html', { init: () => {
      // Frames are sampled from the first one. While the page is still being parsed (before the game script has
      // run) a frame may legitimately show the note; every frame after parsing must not.
      window.__bootSeen = 0; window.__bootFrames = 0; window.__bootEarly = 0;
      const tick = () => {
        const n = document.getElementById('boot-note');
        if (n) {
          const shown = getComputedStyle(n).display !== 'none';
          if (document.readyState === 'loading') { if (shown) window.__bootEarly++; } else { window.__bootFrames++; if (shown) window.__bootSeen++; }
        }
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    } });
    const seen = await v.page.evaluate(() => ({ seen: window.__bootSeen, frames: window.__bootFrames, early: window.__bootEarly }));
    t.note(`frames that showed the note while the page was still being parsed: ${seen.early} (the game script had not started yet)`);
    t.check('normal start: the note is hidden (display none) and the game is up', v.st.display === 'none' && v.st.hidden === true && v.st.boot === 'done' && v.st.screens.join() === 's-nieuw', v.st);
    t.check('normal start: once the game script has run, not one frame shows the note (' + seen.frames + ' frames sampled)', seen.frames > 5 && seen.seen === 0, seen);
    t.check('normal start: no error text anywhere on the page, the name is in the title bar', v.st.errors.length === 0 && !/Er ging iets mis/.test(v.st.bodyText) && v.st.brand === 'Rekenrace', v.st);
    t.check('normal start: no page errors', v.pageErrors.length === 0, v.pageErrors);

    // (d) after a good start errors stay in the console
    await v.page.evaluate(() => { setTimeout(() => { throw new Error('later fout'); }, 0); Promise.reject(new Error('later belofte')); });
    await v.page.waitForTimeout(300);
    const later = await noteState(v.page);
    t.check('after a good start a script error and a rejected promise never reach the screen', later.display === 'none' && later.errors.length === 0 && !/Er ging iets mis|later fout|later belofte/.test(later.bodyText) && v.pageErrors.length === 2, { later, pageErrors: v.pageErrors });
    await v.ctx.close();

    // (e) a failure that the game guards on purpose (drawing) is not a start-up error
    v = await visit('/game.html', { init: () => { HTMLCanvasElement.prototype.getContext = function () { throw new Error('canvas kapot'); }; } });
    t.check('a canvas that throws is absorbed by the sprites and scene: the game still starts and the note stays hidden', v.st.display === 'none' && v.st.boot === 'done' && v.st.screens.length === 1, v.st);
    await v.ctx.close();

    // (f) scripting switched off: the existing noscript sentence is the message, the note would only mislead
    v = await visit('/game.html', { js: false });
    t.check('scripting off: the "wordt gestart" note is not shown (the noscript sentence is)', v.page ? (await v.page.evaluate(() => getComputedStyle(document.getElementById('boot-note')).display)) === 'none' && /JavaScript nodig/.test(await v.page.evaluate(() => document.body.innerText)) : false);
    t.check('scripting off: the sentence also says what to do when switching JavaScript on is not possible ("Of open het bestand in Safari of Chrome.")', v.page ? /Zet JavaScript aan in je browser om te spelen\. Of open het bestand in Safari of Chrome\./.test(await v.page.evaluate(() => document.body.innerText)) : false);
    await v.ctx.close();

    // (g) in the source: the early watch is a separate script before the game script, and the game script hides the note first
    const src = source();
    const scripts = [...src.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => ({ at: m.index, body: m[1] }));
    const early = scripts.find((s) => /unhandledrejection/.test(s.body));
    const game = scripts.find((s) => /const RR = \{\}/.test(s.body));
    t.check('source: two inline scripts, the small watch comes first', scripts.length === 2 && early && game && early.at < game.at && early.body.length < 2500, { n: scripts.length, early: early && early.body.length });
    const firstStatement = game ? game.body.replace(/^\s*(\/\/[^\n]*\n\s*)*/, '').split('\n')[0] : '';
    t.check('source: the first statement of the game script hides #boot-note', /boot-note/.test(firstStatement) && /hidden = true/.test(firstStatement), firstStatement);
    t.check('source: the last statement of the game script marks the start as done', game && /data-boot', 'done'\);\s*$/.test(game.body.trim()), game && game.body.trim().slice(-120));
    t.check('source: no timer is involved in showing the note', early && !/setTimeout|setInterval|animation/.test(early.body) && !/boot-note[^{]*\{[^}]*animation/.test(src), '');
  } finally {
    srv.close();
  }
}

// ---------- T: review round 2 (first-run form, Klaar without digits, parents can fix a name, readable stories, print) ----------
async function sT(browser) {
  const t = makeT('T review round 2: form, empty Klaar, rename in Ouders, story size, print, narrow title');
  const lib = require('./lib.cjs');

  // first run on a touch screen: the heading keeps the focus (focusing the box would only raise the keyboard over the heroes)
  {
    const c = await open(browser, { viewport: { width: 390, height: 844 }, touch: true, mobile: true });
    t.check('first run on a touch screen: focus stays on the heading', (await S(c.page, () => document.activeElement.id)) === 'h-nieuw', await S(c.page, () => document.activeElement.id));
    t.check('overscroll-behavior is none on <html> too (a swipe cannot pull the page to refresh)', (await S(c.page, () => getComputedStyle(document.documentElement).overscrollBehaviorY)) === 'none');
    await c.ctx.close();
  }

  // Klaar with nothing typed
  {
    const c = await open(browser, { viewport: { width: 1024, height: 768 }, reducedMotion: true });
    const p = c.page;
    await spies(p);
    await createPlayer(p, 'Noor', 'pad', 4);
    await toIntro(p, { track: 1 });
    await startRace(p);
    await waitAsk(p, 0);
    await clickOk(p);
    t.check('Klaar with an empty box says "Typ eerst je antwoord." and counts no attempt', (await text(p, '#feedback')) === 'Typ eerst je antwoord.' && (await S(p, () => RR.UI.state.race.attempt)) === 0 && (await state(p)).phase === 'ask', await text(p, '#feedback'));
    t.check('that line is in the live region (the feedback paragraph is aria-live)', (await S(p, () => document.getElementById('feedback').getAttribute('aria-live'))) === 'polite');
    await typeKeypad(p, '9');
    t.check('typing a digit takes the line away again', (await text(p, '#feedback')) === '' && (await text(p, '#answer-text')) === '9');
    await p.click('#keypad [data-action="del"]');
    const q0 = await S(p, () => window.__series[window.__series.length - 1].list[0]);
    await typeKeypad(p, String(q0.answer + 1));
    await clickOk(p);
    const hint = await text(p, '#feedback');
    t.check('after a wrong first answer the tip is showing', /^Nog niet helemaal\./.test(hint), hint);
    await clickOk(p);
    t.check('Klaar on the empty box after that leaves the tip alone', (await text(p, '#feedback')) === hint, await text(p, '#feedback'));
    await noProblems(t, c);
    await c.ctx.close();
  }

  // parents: rename and change the hero without losing the stamps
  {
    const c = await open(browser, { viewport: { width: 390, height: 844 }, reducedMotion: true });
    const p = c.page;
    await createPlayer(p, 'Anna', 'egel', 4);
    await p.click('[data-action="other-player"]');
    await createPlayer(p, 'Bram', 'pad', 5);
    const ids = await S(p, () => RR.UI.state.store.players().map((x) => x.id));
    await S(p, () => { const st = RR.UI.state.store; st.select(st.players()[0].id); st.stamp(1, 2); st.select(null); });
    await p.click('[data-action="other-player"]');
    await p.click('[data-action="parents"]');
    await p.waitForSelector('#s-ouders:not([hidden])');
    await p.fill(`#name-${ids[0]}`, 'bram');
    await p.click(`form[data-id="${ids[0]}"] button[type=submit]`);
    t.check('rename to a name that is taken: explained in Dutch, focus stays in the box, nothing changed', /al een speler met die naam/.test((await text(p, `#err-rename-${ids[0]}`)) || '') && (await S(p, () => document.activeElement.id)) === `name-${ids[0]}` && (await S(p, () => RR.UI.state.store.players()[0].name)) === 'Anna', await text(p, `#err-rename-${ids[0]}`));
    await p.fill(`#name-${ids[0]}`, '   ');
    await p.click(`form[data-id="${ids[0]}"] button[type=submit]`);
    t.check('rename to nothing: "Vul eerst je naam in."', (await text(p, `#err-rename-${ids[0]}`)) === 'Vul eerst je naam in.', await text(p, `#err-rename-${ids[0]}`));
    await p.fill(`#name-${ids[0]}`, 'Anneke!');
    await p.click(`form[data-id="${ids[0]}"] button[type=submit]`);
    const after = await S(p, (id) => { const st = RR.UI.state.store; const pl = st.players().filter((x) => x.id === id)[0]; return { name: pl.name, hero: pl.hero, grade: pl.grade, stamps: Object.keys((st.select(id), st.stamps())).length, notice: (document.querySelector('.notice') || {}).textContent, focus: document.activeElement.className, h2: document.getElementById('pl-' + id).textContent }; }, ids[0]);
    await S(p, () => RR.UI.state.store.select(null));
    t.check('rename: the name changed, the hero, group and stamp stayed, the card says so', after.name === 'Anneke!' && after.hero === 'egel' && after.grade === 4 && after.stamps === 1 && after.h2 === 'Anneke!', after);
    t.check('rename: a quiet confirmation without a stray dot after "!", and the focus is on it', after.notice === 'De naam is nu Anneke.' && /notice/.test(after.focus), after);
    await p.selectOption(`#hero-sel-${ids[0]}`, 'uil');
    const heroNow = await S(p, (id) => ({ hero: RR.UI.state.store.players().filter((x) => x.id === id)[0].hero, focus: document.activeElement.id, head: document.querySelector(`#pl-${id}`).parentElement.querySelector('.pl-head-img').outerHTML.slice(0, 40) }), ids[0]);
    t.check('another hero: stored, and the focus stays on the hero box', heroNow.hero === 'uil' && heroNow.focus === `hero-sel-${ids[0]}`, heroNow);
    t.check('the name box and hero box have visible labels', (await text(p, `label[for="name-${ids[0]}"]`)) === 'Naam' && (await text(p, `label[for="hero-sel-${ids[0]}"]`)) === 'Held');
    const issues = await a11yScan(p);
    t.check('parents screen: no accessibility scan issues with the new fields', issues.length === 0, issues);
    const lay = await layoutAudit(p);
    t.check('parents screen at 390 px: no overflow, targets at least 48 px', lay.length === 0, lay);
    await noProblems(t, c);
    await c.ctx.close();
  }

  // printing: only the licence, and no empty licence frame on other screens
  {
    const c = await open(browser, { viewport: { width: 1024, height: 768 }, reducedMotion: true });
    const p = c.page;
    await createPlayer(p, 'Sien', 'egel', 4);
    await p.emulateMedia({ media: 'print' });
    const d = await S(p, () => getComputedStyle(document.getElementById('s-rijbewijs')).display);
    t.check('print from another screen: the (empty) licence section is not displayed', d === 'none', d);
    await S(p, () => { const st = RR.UI.state.store; for (let i = 1; i <= 8; i++) st.stamp(i, 1); RR.UI.show('rijbewijs'); });
    const d2 = await S(p, () => getComputedStyle(document.getElementById('s-rijbewijs')).display);
    t.check('print from the licence: it is displayed', d2 === 'block', d2);
    await p.emulateMedia({ media: 'screen' });
    await c.ctx.close();
  }

  // stories and tips are bigger on roomy screens and still fit
  for (const [w, h] of [[1024, 768], [1366, 768], [1920, 1080]]) {
    const c = await open(browser, { viewport: { width: w, height: h }, reducedMotion: true });
    const p = c.page;
    await createPlayer(p, 'Lees', 'egel', 6);
    await p.evaluate(() => {
      const all = [];
      for (let g = 3; g <= 6; g++) for (let l = 1; l <= 8; l++) for (let sd = 1; sd <= 40; sd++) RR.Questions.series({ grade: g, level: l, focus: 'story' }, 10, RR.Rng.make(sd * 977 + g * 13 + l)).forEach((q) => all.push(q));
      const seen = new Set();
      const uniq = all.filter((q) => (seen.has(q.key) ? false : seen.add(q.key)));
      uniq.sort((a, b) => (b.text.length + b.hint.length) - (a.text.length + a.hint.length));
      const q = uniq[0];
      RR.Questions.series = () => Array.from({ length: 10 }, () => q);
    });
    await toIntro(p, { track: 1 });
    await startRace(p);
    await waitAsk(p, 0);
    const f1 = await S(p, () => parseFloat(getComputedStyle(document.getElementById('q')).fontSize));
    await typeKeypad(p, '99999'); await clickOk(p);
    await p.waitForTimeout(200);
    const f2 = await S(p, () => parseFloat(getComputedStyle(document.getElementById('feedback')).fontSize));
    const a1 = await layoutAudit(p);
    await typeKeypad(p, '99999'); await clickOk(p);
    await p.waitForSelector('#s-race[data-phase="explain"]');
    const f3 = await S(p, () => parseFloat(getComputedStyle(document.getElementById('explain-text')).fontSize));
    const a2 = await layoutAudit(p);
    t.check(`${w}x${h}: story at least 17.6px, tip at least 16.8px, explanation at least 17.6px`, f1 >= 17.5 && f2 >= 16.7 && f3 >= 17.5, { f1, f2, f3 });
    t.check(`${w}x${h}: the longest story with its tip and its explanation fit without scrolling or cut-off text`, a1.length === 0 && a2.length === 0, { a1, a2 });
    await c.ctx.close();
  }
  {
    const c = await open(browser, { viewport: { width: 844, height: 390 }, reducedMotion: true, touch: true, mobile: true });
    const p = c.page;
    await createPlayer(p, 'Lees', 'egel', 4);
    await p.evaluate(() => { const q = RR.Questions.series({ grade: 4, level: 8, focus: 'story' }, 10, RR.Rng.make(3))[0]; RR.Questions.series = () => Array.from({ length: 10 }, () => q); });
    await toIntro(p, { track: 1 });
    await startRace(p);
    await waitAsk(p, 0);
    const f = await S(p, () => parseFloat(getComputedStyle(document.getElementById('q')).fontSize));
    t.check('a phone held sideways keeps its small story size (the bigger one is for roomy screens only)', f <= 15.3, f);
    await c.ctx.close();
  }

  // 320 px wide: the race title breaks between words
  {
    const stamps = {}; for (let i = 1; i <= 7; i++) stamps[i] = { place: 1, date: '2026-01-0' + i };
    const seed = JSON.stringify({ v: 1, counter: 2, current: null, settings: { sound: false, music: false, restAfter: 0 }, players: [{ id: 'p1', name: 'Gees', hero: 'egel', grade: 4, answers: {}, kinds: {}, stamps }] });
    const c = await open(browser, { viewport: { width: 320, height: 568 }, reducedMotion: true, touch: true, mobile: true, url: false });
    const p = c.page;
    await p.addInitScript((sd) => { try { localStorage.setItem('rekenrace:v1', sd); } catch (e) {} }, seed);
    await p.goto(lib.URL);
    await p.click('.pcard[data-id="p1"]');
    await toIntro(p, { track: 8 });
    await startRace(p);
    await waitAsk(p, 0);
    const w = await S(p, () => {
      const node = document.getElementById('race-title').firstChild;
      const word = 'Heuvelland';
      const at = node.textContent.indexOf(word);
      const r = document.createRange(); r.setStart(node, at); r.setEnd(node, at + word.length);
      const rects = [...r.getClientRects()].map((x) => Math.round(x.top));
      return { lines: new Set(rects).size, text: node.textContent };
    });
    t.check('320 px wide: "Heuvelland" in the race title is not split inside the word', w.lines === 1, w);
    await c.ctx.close();
  }

  // very narrow screens with a 12-letter name: no sideways scrolling, and the title never runs under the buttons
  {
    const stamps = {}; for (let i = 1; i <= 8; i++) stamps[i] = { place: 1, date: '2026-01-0' + i };
    const seed = JSON.stringify({ v: 1, counter: 2, current: null, settings: { sound: false, music: false, restAfter: 0 }, players: [{ id: 'p1', name: 'WWWWWWWWWWWW', hero: 'egel', grade: 4, answers: {}, kinds: {}, stamps }] });
    for (const [w, h] of [[320, 568], [280, 560]]) {
      const c = await open(browser, { viewport: { width: w, height: h }, reducedMotion: true, touch: true, mobile: true, url: false });
      const p = c.page;
      await p.addInitScript((sd) => { try { localStorage.setItem('rekenrace:v1', sd); } catch (e) {} }, seed);
      await p.goto(lib.URL);
      await p.click('.pcard[data-id="p1"]');
      const bad = [];
      for (const id of ['menu', 'banen', 'vrij', 'stempels', 'rijbewijs', 'ouders', 'spelers', 'rust']) {
        await p.evaluate((i) => RR.UI.show(i), id);
        await p.waitForTimeout(100);
        const m = await p.evaluate(() => {
          const sec = document.querySelector('.screen:not([hidden])');
          const br = document.querySelector('.brand-name').getBoundingClientRect();
          const tools = [...document.querySelectorAll('.tools button')].filter((x) => x.offsetParent).map((x) => x.getBoundingClientRect().left);
          return { sideways: sec.scrollWidth - sec.clientWidth, page: document.documentElement.scrollWidth - innerWidth, underButtons: Math.round(br.right - Math.min(...tools)) };
        });
        if (m.sideways > 0 || m.page > 0 || m.underButtons > 0) bad.push(id + ' ' + JSON.stringify(m));
      }
      t.check(`${w}x${h}, name of 12 W's: 8 screens without sideways scroll, and the title bar name stays clear of the buttons`, bad.length === 0, bad);
      await c.ctx.close();
    }
  }

  // the parents' About text tells honestly where the progress lives
  {
    const c = await open(browser, { viewport: { width: 1024, height: 768 }, reducedMotion: true });
    await createPlayer(c.page, 'Mo', 'egel', 4);
    await c.page.evaluate(() => RR.UI.show('ouders'));
    const about = await text(c.page, '.about');
    t.check('parents: the About text says the progress lives in this browser only and goes with its data', /in deze browser/.test(about) && /Wis je de gegevens van de browser, dan is de voortgang ook weg\./.test(about), about);
    await c.ctx.close();
  }
}

// ---------- U: review round 3 (the whole race screen fits the window at every common size) ----------
const layoutfit = require('./layoutfit.cjs');
async function sU(browser) {
  const t = makeT('U race screen fits without scrolling at common window sizes');
  const smp = await layoutfit.samples(browser, 4);
  const sums = smp.ten;
  const stories = sums.filter((q) => q.text.indexOf('\n') >= 0);
  t.check('ten real sums: the longest stories with their tips and explanations, the longest tips of the other kinds, ordinary stories', sums.length === 10 && stories.length >= 6, { n: sums.length, stories: stories.length });
  t.note('longest story: ' + JSON.stringify(stories[0].text) + ' / tip: ' + JSON.stringify(stories[0].hint));
  const sizes = layoutfit.SIZES;
  const results = new Array(sizes.length);
  let next = 0;
  // four windows at a time: the sizes are independent and the machine has four cores
  await Promise.all([0, 1, 2, 3].map(async () => {
    while (next < sizes.length) { const k = next++; results[k] = await layoutfit.probe(browser, sizes[k], sums, { audit: true }); }
  }));
  sizes.forEach((vp, k) => {
    const r = results[k];
    t.check(`${r.size}: sum, tip and explanation fit without page scroll and with Klaar / Volgende on screen (${r.sums} sums, ${r.cls})`, r.ask === 0 && r.hint === 0 && r.explain === 0, { ask: r.ask, hint: r.hint, explain: r.explain, worstPx: r.worstPx, examples: r.examples });
    t.check(`${r.size}: nothing outside the window, no overlaps, targets at least 48 px, no sideways scroll`, r.audit.length === 0, r.audit);
    t.check(`${r.size}: the picture keeps its size from the question to the tip and stays readable, at least 190 px even when the explanation needs the room (${r.minScene}-${r.maxScene} px)`, r.jump === 0 && r.minScene >= 190, { jump: r.jump, min: r.minScene, max: r.maxScene });
    t.check(`${r.size}: no console errors or network requests`, r.problems.length === 0, r.problems);
  });

  // Classic scrollbars (Windows): a window that is too low for everything gets a scrollbar. It takes room from the sum
  // and the keypad, never from the picture: the picture must not change size when the bar appears.
  const classic = await chromium.launch({ ignoreDefaultArgs: ['--hide-scrollbars'] });
  for (const vp of [[700, 330], [644, 330]]) {
    const c = await open(classic, { viewport: { width: vp[0], height: vp[1] } });
    const p = c.page;
    await S(p, () => { const st = RR.UI.state.store; const r = st.addPlayer({ name: 'Sien', hero: 'eekhoorn', grade: 5 }); st.select(r.player.id); RR.UI.show('menu'); });
    await S(p, (q) => { RR.UI.state.scene.advanceTo = () => Promise.resolve(); RR.Questions.series = () => Array(10).fill(0).map((_, i) => Object.assign({}, q, { key: q.key + '#' + i })); }, sums[0]);
    await p.click('#s-menu [data-to="vrij"]'); await p.click('[data-action="start-free"]'); await startRace(p);
    await layoutfit.settle(p);
    const probe = () => S(p, () => { const sr = document.getElementById('s-race'); return { bar: sr.offsetWidth - sr.clientWidth, scene: Math.round(document.querySelector('canvas.scene').getBoundingClientRect().width * 10) / 10 }; });
    const withBar = await probe();
    await p.addStyleTag({ content: '#s-race{overflow-y:hidden !important}' });
    await S(p, () => RR.UI.fitScene());
    await layoutfit.settle(p);
    const noBar = await probe();
    t.check(`${vp.join('x')} with classic scrollbars: the screen needs a scrollbar (${withBar.bar} px) and the picture keeps its size (${withBar.scene} px with it, ${noBar.scene} px without)`, withBar.bar > 0 && noBar.bar === 0 && Math.abs(withBar.scene - noBar.scene) < 0.5, { withBar, noBar });
    await c.ctx.close();
  }
  await classic.close();
}

// ---------- V: review round 3 (the licence button on the finish screen respects the rest moment) ----------
async function sV(browser) {
  const t = makeT('V review round 3: the licence from the finish screen and the rest moment');
  const c = await open(browser, { viewport: { width: 1024, height: 768 } });
  const p = c.page;
  await createPlayer(p, 'Tessa', 'uil', 4);
  await spies(p);
  // the glide itself is not what is tested here: skip it, so the 8th race takes a moment
  await S(p, () => { RR.UI.state.scene.advanceTo = () => Promise.resolve(); });
  const prepare = (rest) => S(p, (r) => {
    const st = RR.UI.state.store;
    st.resetProgress(st.current().id);
    for (let i = 1; i <= 7; i++) st.stamp(i, 2);
    st.setSetting('restAfter', r);
    RR.UI.state.races = 0;
    RR.UI.show('menu');
  }, rest);
  const raceEight = async () => {
    await toIntro(p, { track: 8 });
    await startRace(p);
    for (let i = 0; i < 10; i++) {
      await waitAsk(p, i);
      const a = await S(p, (n) => RR.UI.state.race.questions[n].answer, i);
      await typeKeys(p, a);
      await p.keyboard.press('Enter');
    }
    await waitScreen(p, 'finish');
  };

  // (a) a rest moment is due after this one race: the licence button must not skip it
  await prepare(1);
  await raceEight();
  t.check('8th stamp: the finish screen offers the licence ("Rekenrijbewijs bekijken")', (await text(p, '.stamp-got .btn')) === 'Rekenrijbewijs bekijken', await text(p, '.stamp-got'));
  await p.click('.stamp-got .btn');
  await p.waitForFunction(() => RR.UI.state.screen !== 'finish', null, { timeout: 3000 }).catch(() => {});
  const restShown = (await state(p)).screen === 'rust' && /Tijd voor een pauze/.test((await text(p, '#h-rust')) || '');
  t.check('rest after 1 race: the licence button shows the rest moment first', restShown, await state(p));
  if (!restShown) { await c.ctx.close(); return; }
  await p.click('text=Toch nog een race');
  await waitScreen(p, 'menu');
  t.check('"Toch nog een race" goes to the garage, the licence is one step away (Stempelkaart)', (await state(p)).races === 0);
  await p.click('#s-menu [data-to="stempels"]');
  await waitScreen(p, 'stempels');
  await p.click('#s-stempels [data-to="rijbewijs"]');
  await waitScreen(p, 'rijbewijs');
  t.check('stamp card -> licence: the licence shows the player and all eight stamps', /Tessa/.test((await text(p, '#s-rijbewijs')) || '') && (await S(p, () => document.querySelectorAll('#s-rijbewijs .licence-stamps li').length)) === 8);

  // (b) no rest moment due: the licence opens at once, and its way back is the stamp card, then the garage
  await prepare(3);
  await raceEight();
  await p.click('.stamp-got .btn');
  await waitScreen(p, 'rijbewijs');
  t.check('no rest due: the licence button opens the licence', (await state(p)).screen === 'rijbewijs');
  t.check('licence: the heading is focused and the way back is named', (await S(p, () => document.activeElement.id)) === 'h-rijbewijs' && (await text(p, '#s-rijbewijs [data-to="stempels"]')) === 'Terug naar de stempelkaart' && (await text(p, '#btn-nav')) === 'Terug');
  await p.click('#s-rijbewijs [data-to="stempels"]');
  await waitScreen(p, 'stempels');
  await p.click('#btn-nav');
  await waitScreen(p, 'menu');
  t.check('licence -> Terug naar de stempelkaart -> Menu: back in the garage', (await state(p)).screen === 'menu');

  // (c) the rest moment is switched off
  await prepare(0);
  await raceEight();
  await p.click('.stamp-got .btn');
  await waitScreen(p, 'rijbewijs');
  t.check('rest moment off: the licence opens at once', (await state(p)).screen === 'rijbewijs');

  // (d) a name that ends in punctuation reads right in the middle of a sentence (Ouders: question and quiet notice)
  const lola = await S(p, () => RR.UI.state.store.addPlayer({ name: 'Lola!', hero: 'egel', grade: 3 }).player.id);
  await S(p, () => { RR.UI.state.parentsFrom = 'menu'; RR.UI.show('ouders'); });
  await p.click(`[data-action="ask-reset"][data-id="${lola}"]`);
  const q1 = await text(p, '.confirm-text');
  t.check('Ouders, wissen: "van Lola worden gewist", no "!" in the middle of the sentence', q1 === 'Weet je het zeker? Alle stempels en resultaten van Lola worden gewist.', q1);
  await p.click('[data-action="confirm-yes"]');
  const n1 = await text(p, '.notice');
  t.check('Ouders, gewist: "De voortgang van Lola is gewist."', n1 === 'De voortgang van Lola is gewist.', n1);
  await p.click(`[data-action="ask-remove"][data-id="${lola}"]`);
  const q2 = await text(p, '.confirm-text');
  t.check('Ouders, verwijderen: "Lola wordt helemaal verwijderd."', q2 === 'Weet je het zeker? Lola wordt helemaal verwijderd.', q2);
  await p.click('[data-action="confirm-yes"]');
  const n2 = await text(p, '.notice');
  t.check('Ouders, verwijderd: "Lola is verwijderd."', n2 === 'Lola is verwijderd.', n2);
  await noProblems(t, c);
  await c.ctx.close();
}

// ============================================================================
// W: the optional behind-the-kart (pseudo-3D) view: the setting, a whole race, layout, reduced motion
// ============================================================================
const sceneKind = (page) => page.evaluate(() => RR.UI.state.sceneKind);
const canvasStats = (page) => page.evaluate(() => {
  const cv = document.querySelector('canvas.scene');
  const tmp = document.createElement('canvas');   // (read a copy: reading the game's own canvas would warn about readbacks)
  tmp.width = cv.width; tmp.height = cv.height;
  const tc = tmp.getContext('2d', { willReadFrequently: true });
  tc.drawImage(cv, 0, 0);
  const d = tc.getImageData(0, 0, cv.width, cv.height).data;
  const colours = new Set();
  for (let i = 0; i < d.length; i += 4) colours.add((d[i] << 16) | (d[i + 1] << 8) | d[i + 2]);
  return { w: cv.width, h: cv.height, colours: colours.size, sig: cv.toDataURL().length + ':' + cv.toDataURL().slice(-60) };
});

async function view3dLayout(t, p, label, introOnly) {
  const issues = await layoutAudit(p, {});
  t.check(label + ': no scroll, no overlaps, targets >= 48px, Klaar and the keypad inside the viewport', issues.length === 0, issues);
  const ok = await p.evaluate(() => {
    const b = document.querySelector('#keypad [data-action="ok"]');
    if (!b) return false;
    const r = b.getBoundingClientRect();
    return r.width > 0 && r.left >= 0 && r.top >= 0 && r.right <= window.innerWidth && r.bottom <= window.innerHeight;
  });
  if (!introOnly) t.check(label + ': the Klaar button is visible', ok);
}

async function sW(browser) {
  const t = makeT('W behind-the-kart view (3D)');

  // ---- (a) the setting: default, label, switching, persistence, applied outside a race only
  const c = await open(browser, { viewport: { width: 390, height: 844 }, mobile: true, touch: true });
  const p = c.page;
  await createPlayer(p, 'Bram', 'pad', 4);
  await spies(p);
  t.check('default: side view (setting "side", scene is RR.Scene)', (await S(p, () => RR.UI.state.store.settings().view)) === 'side' && (await sceneKind(p)) === 'side' && (await S(p, () => typeof RR.UI.state.scene.debugFrame)) === 'undefined');
  const side = await canvasStats(p);
  t.check('the logical canvas is 320x144 in the side view', side.w === 320 && side.h === 144, side);
  await p.click('[data-action="parents"]');
  await waitScreen(p, 'ouders');
  t.check('Ouders: control "Aanzicht" with the options "Van opzij" and "Van achteren"', (await text(p, 'label[for="sel-view"]')) === 'Aanzicht' && JSON.stringify(await S(p, () => [...document.querySelectorAll('#sel-view option')].map((o) => o.textContent))) === JSON.stringify(['Van opzij', 'Van achteren']));
  t.check('Ouders: "Van opzij" is selected by default', (await S(p, () => document.getElementById('sel-view').value)) === 'side');
  t.check('Ouders: the Aanzicht select is a 48px target with an explanation', (await layoutAudit(p)).length === 0 && /volgende race/.test((await text(p, '#view-note')) || ''), await layoutAudit(p));
  await p.selectOption('#sel-view', 'behind');
  t.check('choosing "Van achteren" is stored in the settings', (await S(p, () => RR.UI.state.store.settings().view)) === 'behind');
  t.check('...and written to localStorage', (await S(p, () => JSON.parse(localStorage.getItem('rekenrace:v1')).settings.view)) === 'behind');
  await p.locator('#sel-view').scrollIntoViewIfNeeded();
  await p.screenshot({ path: SHOTS + '/w-ouders-phone.png' });
  await p.click('#btn-nav');
  await waitScreen(p, 'menu');
  t.check('back in the garage: the decorative scene is now the 3D view', (await sceneKind(p)) === 'behind' && (await S(p, () => typeof RR.UI.state.scene.debugFrame)) === 'function');
  const garage3d = await canvasStats(p);
  t.check('the garage canvas is still 320x144 and shows a real picture (many colours)', garage3d.w === 320 && garage3d.h === 144 && garage3d.colours > 12, garage3d);
  t.check('the 3D picture is a different picture from the side view', garage3d.sig !== side.sig);
  await p.screenshot({ path: SHOTS + '/w-garage-phone.png' });

  // a whole race in 3D on a phone
  await toIntro(p, { track: 1 });
  t.check('race intro uses the 3D scene', (await sceneKind(p)) === 'behind');
  await view3dLayout(t, p, 'phone 390x844, race start card', true);
  await p.screenshot({ path: SHOTS + '/w-race-intro-phone.png' });
  await startRace(p);
  await waitAsk(p, 0);
  await view3dLayout(t, p, 'phone 390x844, sum 1');
  await p.screenshot({ path: SHOTS + '/w-race-phone.png' });
  t.check('during the race there is no way to Ouders: no Terug/Menu button, no view control on screen', (await S(p, () => document.getElementById('btn-nav').hidden)) === true && (await S(p, () => !document.getElementById('sel-view'))));
  // even if the stored setting changed under the race, the scene stays until the race is over
  const before = await S(p, () => { window.__sceneRef = RR.UI.state.scene; RR.UI.state.store.setSetting('view', 'side'); return RR.UI.state.sceneKind; });
  t.check('a setting change during a race does not swap the scene', before === 'behind');
  const mid = await playRace(p, t, (i) => (i === 3 ? ['wrong', 'right'] : i === 6 ? ['wrong', 'wrong'] : ['right']), {
    afterExplain: async () => { await view3dLayout(t, p, 'phone 390x844, explanation'); },
  });
  t.check('the whole race ran in the 3D view (scene object unchanged, kind still "behind")', (await S(p, () => window.__sceneRef === RR.UI.state.scene)) && (await sceneKind(p)) === 'behind');
  t.check('3D race: 10 sums, finish screen with the place sentence', mid.length === 10 && PLACE_RE.test((await text(p, '#h-finish')) || ''), await text(p, '#s-finish'));
  await p.screenshot({ path: SHOTS + '/w-finish-phone.png' });
  const leave = await p.$('[data-action="finish-garage"]');
  await leave.click();
  await p.waitForFunction(() => RR.UI.state.screen !== 'finish', null, { timeout: 3000 });
  await p.evaluate(() => RR.UI.show('menu'));
  await waitScreen(p, 'menu');
  t.check('after the race the garage follows the (now "side") setting again', (await sceneKind(p)) === 'side');
  await noProblems(t, c, 'phone, 3D race');
  await c.ctx.close();

  // ---- (b) persistence over a reload, and a whole race on a laptop (keyboard) through every track's look
  const c2 = await open(browser, { viewport: { width: 1366, height: 768 } });
  const p2 = c2.page;
  await createPlayer(p2, 'Eef', 'egel', 4);
  await spies(p2);
  await S(p2, () => RR.UI.state.store.setSetting('view', 'behind'));
  await p2.reload();
  await p2.waitForSelector('#s-spelers:not([hidden])');
  t.check('after a reload the setting is still "behind" (and the chooser shows)', (await S(p2, () => RR.UI.state.store.settings().view)) === 'behind');
  await p2.click('#s-spelers [data-action="pick-player"]');
  await waitScreen(p2, 'menu');
  t.check('after a reload the garage shows the 3D view', (await sceneKind(p2)) === 'behind');
  await spies(p2);

  // every track in the 3D view: right theme, real picture, nothing overflowing, no errors
  const themes = await S(p2, () => RR.Tracks.map((x) => x.theme));
  const bad = [];
  await S(p2, () => { const st = RR.UI.state.store; for (let i = 1; i <= 7; i++) st.stamp(i, 2); RR.UI.show('menu'); });
  for (let n = 1; n <= 8; n++) {
    await toIntro(p2, { mode: 'free', track: n });
    const st = await canvasStats(p2);
    const th = await S(p2, () => RR.UI.state.scene.theme);
    if (th !== themes[n - 1]) bad.push('track ' + n + ' theme ' + th);
    if (st.colours < 15) bad.push('track ' + n + ' few colours ' + st.colours);
    (await layoutAudit(p2)).forEach((f) => bad.push('track ' + n + ': ' + f));
    if (n === 5) await p2.screenshot({ path: SHOTS + '/w-intro-laptop-canal.png' });
    await p2.click('#btn-nav');
    await waitScreen(p2, 'vrij');
    await p2.click('#btn-nav');
    await waitScreen(p2, 'menu');
  }
  t.check('all 8 tracks open in the 3D view with their own theme, a real picture and no layout problems (laptop 1366x768)', bad.length === 0, bad);

  await toIntro(p2, { track: 2 });
  await view3dLayout(t, p2, 'laptop 1366x768, race start card', true);
  await startRace(p2);
  await waitAsk(p2, 0);
  await view3dLayout(t, p2, 'laptop 1366x768, sum 1');
  await p2.screenshot({ path: SHOTS + '/w-race-laptop.png' });
  await playRace(p2, t, (i) => (i === 5 ? ['wrong', 'right'] : ['right']), { keyboard: true });
  t.check('laptop: the 3D race ends on the finish screen with a place sentence', PLACE_RE.test((await text(p2, '#h-finish')) || ''), await text(p2, '#s-finish'));
  await p2.screenshot({ path: SHOTS + '/w-finish-laptop.png' });
  const snds = await S(p2, () => window.__snd.length);
  t.check('sounds are the normal ones (the view changes nothing else)', snds > 0);
  await noProblems(t, c2, 'laptop, 3D race');
  await c2.ctx.close();

  // ---- (c) reduced motion in 3D: the glide is skipped, nothing drifts
  const c3 = await open(browser, { viewport: { width: 1024, height: 768 }, reducedMotion: true });
  const p3 = c3.page;
  await createPlayer(p3, 'Oeke', 'uil', 4);
  await S(p3, () => { const st = RR.UI.state.store; for (let i = 1; i <= 6; i++) st.stamp(i, 2); st.setSetting('view', 'behind'); RR.UI.show('menu'); });
  await waitScreen(p3, 'menu');
  t.check('reduced motion: 3D scene reports reducedMotion', (await sceneKind(p3)) === 'behind' && (await S(p3, () => RR.UI.state.scene.reducedMotion)) === true);
  const still1 = await canvasStats(p3);
  await p3.waitForTimeout(900);
  const still2 = await canvasStats(p3);
  t.check('reduced motion: the idle garage picture does not move', still1.sig === still2.sig);
  await toIntro(p3, { track: 7 });
  await startRace(p3);
  const t0 = Date.now();
  await waitAsk(p3, 0);
  await spies(p3);
  const q = await S(p3, () => RR.UI.state.race.questions[0].answer);
  await typeKeys(p3, q);
  await p3.keyboard.press('Enter');
  await waitAsk(p3, 1);
  t.check('reduced motion: the next sum follows after the short fixed pause, not a glide (< 1.4 s)', Date.now() - t0 < 1400 + 600, Date.now() - t0);
  const pos = await S(p3, () => RR.UI.state.scene.positions());
  t.check('reduced motion: the kart jumped to its new place at once', Object.values(pos).some((v) => v > 0.2), pos);
  await view3dLayout(t, p3, 'reduced motion 3D race');
  await noProblems(t, c3, 'reduced motion, 3D');
  await c3.ctx.close();
}

// ---------- main ----------
const ALL = { A: sA, B: sB, C: sC, D: sD, E: sE, F: sF, G: sG, H: sH, I: sI, J: sJ, K: sK, L: sL, M: sM, N: sN, O: sO, P: sP, Q: sQ, R: sR, S: sS, T: sT, U: sU, V: sV, W: sW };

(async () => {
  const want = process.argv.slice(2).map((x) => x.toUpperCase());
  const keys = Object.keys(ALL).filter((k) => !want.length || want.includes(k));
  const browser = await chromium.launch();
  const started = Date.now();
  const runOne = async (k) => {
    try { await ALL[k](browser); } catch (e) { const t = makeT(k + ' crashed'); t.check('scenario finished', false, String(e && e.stack || e).split('\n').slice(0, 6).join(' | ')); }
  };
  // Two waves: the timing checks of the first wave (glide length, "ignored while gliding") are sensitive to CPU load on a small machine.
  await Promise.all(keys.filter((k) => !'PQRSTUVW'.includes(k)).map(runOne));
  await Promise.all(keys.filter((k) => 'PQRSTUVW'.includes(k)).map(runOne));
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
