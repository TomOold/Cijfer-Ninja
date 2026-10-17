// Shared helpers for the Rekenrace browser tests.
const { chromium } = require('playwright');
const path = require('path');

const URL = 'file:///home/user/Cijfer-Ninja/rekenrace/index.html';
const SHOTS = path.join(__dirname, 'shots');

async function open(browser, opts = {}) {
  const ctx = await browser.newContext({
    viewport: opts.viewport || { width: 1024, height: 768 },
    reducedMotion: opts.reducedMotion ? 'reduce' : 'no-preference',
    deviceScaleFactor: opts.dpr || 1,
    hasTouch: !!opts.touch,
    isMobile: !!opts.mobile,
  });
  const page = await ctx.newPage();
  const problems = [];
  const requests = [];
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') problems.push('console.' + m.type() + ': ' + m.text()); });
  page.on('pageerror', (e) => problems.push('pageerror: ' + e.message));
  page.on('request', (r) => { const u = r.url(); if (!/^(data:|file:|about:|blob:)/.test(u)) problems.push('network request: ' + u); requests.push(u); });
  await page.addInitScript(() => {
    window.__csp = [];
    document.addEventListener('securitypolicyviolation', (e) => window.__csp.push(e.violatedDirective + ' ' + e.blockedURI));
  });
  if (opts.url !== false) await page.goto(opts.url || URL);
  return { ctx, page, problems, requests };
}

async function createPlayer(page, name, hero = 'egel', grade = 4) {
  // from the chooser or the empty-state form
  if (await page.locator('#s-spelers:not([hidden])').count()) {
    await page.click('[data-action="new-player"]');
  }
  await page.fill('#in-name', name);
  await page.check('#hero-' + hero, { force: true }).catch(async () => { await page.click('label[for="hero-' + hero + '"]'); });
  await page.click('label[for="grade-' + grade + '"]');
  await page.click('#form-new button[type=submit]');
  await page.waitForSelector('#s-menu:not([hidden])');
}

const screenId = (page) => page.evaluate(() => RR.UI.state.screen);

module.exports = { chromium, URL, SHOTS, open, createPlayer, screenId };

// ---------- audits that run inside the page ----------
// Horizontal scroll, race screen overflow, targets that are too small, things outside the viewport.
async function layoutAudit(page, opts = {}) {
  return page.evaluate((o) => {
    const issues = [];
    const vis = (el) => !!(el.offsetParent || getComputedStyle(el).position === 'fixed') && el.getClientRects().length > 0;
    const d = document.documentElement;
    if (d.scrollWidth > window.innerWidth + 1) issues.push('page scrolls horizontally: ' + d.scrollWidth + ' > ' + window.innerWidth);
    const cur = document.querySelector('.screen:not([hidden])');
    if (cur && cur.scrollWidth > cur.clientWidth + 1) issues.push('screen scrolls horizontally: ' + cur.scrollWidth + ' > ' + cur.clientWidth);
    if (cur && cur.id === 's-race' && cur.scrollHeight > cur.clientHeight + 1) issues.push('race screen scrolls vertically: ' + cur.scrollHeight + ' > ' + cur.clientHeight);
    if (cur && o.noScroll && cur.scrollHeight > cur.clientHeight + 1) issues.push('screen needs scrolling: ' + cur.scrollHeight + ' > ' + cur.clientHeight);
    // targets
    const targets = Array.from(document.querySelectorAll('.screen:not([hidden]) button, .titlebar button, dialog[open] button, .screen:not([hidden]) select, .screen:not([hidden]) .text-in, .screen:not([hidden]) .chip label, .screen:not([hidden]) .hero-card label, .screen:not([hidden]) .check, dialog[open] .check'));
    targets.forEach((el) => {
      if (!vis(el) || el.disabled) return;
      const r = el.getBoundingClientRect();
      if (r.width < 47.5 || r.height < 47.5) issues.push('small target ' + (el.id || el.className || el.tagName) + ' "' + (el.textContent || '').trim().slice(0, 20) + '" ' + Math.round(r.width) + 'x' + Math.round(r.height));
    });
    // race: everything the child needs must be inside the viewport
    if (cur && cur.id === 's-race') {
      ['#btn-pause', '#q', '#answer', '#keypad', '#btn-next', '#btn-start', 'canvas.scene'].forEach((sel) => {
        const el = document.querySelector(sel);
        if (!el || !vis(el)) return;
        const r = el.getBoundingClientRect();
        if (r.left < -0.5 || r.top < -0.5 || r.right > window.innerWidth + 0.5 || r.bottom > window.innerHeight + 0.5) issues.push(sel + ' outside the viewport: ' + [r.left, r.top, r.right, r.bottom].map(Math.round));
      });
      // no overlaps between the big blocks
      const boxes = ['#race-line', 'canvas.scene', '#q', '#answer', '#feedback', '#keypad', '#explain', '#intro'].map((s) => [s, document.querySelector(s)]).filter(([, el]) => el && vis(el) && getComputedStyle(el).visibility !== 'hidden');
      for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i][1].getBoundingClientRect(), b = boxes[j][1].getBoundingClientRect();
        const ox = Math.min(a.right, b.right) - Math.max(a.left, b.left), oy = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
        if (ox > 2 && oy > 2) issues.push('overlap ' + boxes[i][0] + ' / ' + boxes[j][0] + ' (' + Math.round(ox) + 'x' + Math.round(oy) + ')');
      }
      const ex = document.querySelector('#explain-text');
      if (ex && vis(ex) && ex.scrollHeight > ex.clientHeight + 1) issues.push('explain text is cut off: ' + ex.scrollHeight + ' > ' + ex.clientHeight);
    }
    return issues;
  }, opts);
}

function parseRGB(s) { const m = s.match(/rgba?\(([^)]+)\)/); if (!m) return null; const p = m[1].split(',').map((x) => parseFloat(x)); return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 }; }

// Text contrast against the nearest solid background. Gradients and images are reported separately.
async function contrastAudit(page) {
  return page.evaluate(() => {
    const lum = (c) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b); };
    const parse = (s) => { const m = s.match(/rgba?\(([^)]+)\)/); if (!m) return null; const p = m[1].split(',').map((x) => parseFloat(x)); return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 }; };
    const out = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const seen = new Set();
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (!n.nodeValue.trim()) continue;
      const el = n.parentElement;
      if (!el || seen.has(el)) continue;
      seen.add(el);
      if (!el.offsetParent && getComputedStyle(el).position !== 'fixed') continue;
      if (el.closest('.sr-only, [hidden], script, style, noscript')) continue;
      const cs = getComputedStyle(el);
      if (cs.visibility === 'hidden') continue;
      if (el.closest('.is-locked, :disabled')) continue;          // inactive controls are exempt
      let bg = null, grad = false;
      for (let a = el; a; a = a.parentElement) {
        const s = getComputedStyle(a);
        if (s.backgroundImage && s.backgroundImage !== 'none' && /gradient/.test(s.backgroundImage)) { grad = true; break; }
        const c = parse(s.backgroundColor);
        if (c && c.a > 0.99) { bg = c; break; }
      }
      const fg = parse(cs.color);
      if (grad || !bg || !fg) { out.push({ skip: true, text: n.nodeValue.trim().slice(0, 24), why: grad ? 'gradient' : 'no bg' }); continue; }
      let op = 1;
      for (let a = el; a; a = a.parentElement) op *= parseFloat(getComputedStyle(a).opacity);
      if (op < 0.99) continue;
      const L1 = lum(fg), L2 = lum(bg);
      const ratio = (Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05);
      const px = parseFloat(cs.fontSize), bold = parseInt(cs.fontWeight, 10) >= 700;
      const large = px >= 24 || (px >= 18.66 && bold);
      out.push({ text: n.nodeValue.trim().slice(0, 24), ratio: Math.round(ratio * 100) / 100, need: large ? 3 : 4.5, ok: ratio >= (large ? 3 : 4.5), cls: el.className });
    }
    return out;
  });
}

// Names, labels, ids and headings: the basics a screen reader depends on.
async function a11yScan(page) {
  return page.evaluate(() => {
    const issues = [];
    const vis = (el) => !!(el.offsetParent || getComputedStyle(el).position === 'fixed') || el.matches('.vh, .sr-only');
    const nameOf = (el) => {
      const lb = el.getAttribute('aria-labelledby');
      if (lb) return lb.split(/\s+/).map((i) => (document.getElementById(i) || {}).textContent || '').join(' ').trim();
      if (el.getAttribute('aria-label')) return el.getAttribute('aria-label').trim();
      if (el.labels && el.labels.length) return Array.from(el.labels).map((l) => l.textContent).join(' ').trim();
      return (el.textContent || '').trim() || el.title || '';
    };
    document.querySelectorAll('button, input, select, textarea, [role=img], canvas').forEach((el) => {
      if (!vis(el) || el.closest('[hidden]')) return;
      if (!nameOf(el)) issues.push('no accessible name: <' + el.tagName.toLowerCase() + ' ' + (el.id || el.className) + '>');
    });
    document.querySelectorAll('img').forEach((el) => { if (!el.hasAttribute('alt')) issues.push('img without alt'); });
    const ids = {};
    document.querySelectorAll('[id]').forEach((el) => { if (ids[el.id]) issues.push('duplicate id ' + el.id); ids[el.id] = 1; });
    const h1 = Array.from(document.querySelectorAll('h1')).filter((h) => h.offsetParent !== null);
    if (h1.length !== 1) issues.push('visible h1 count = ' + h1.length);
    const cur = document.querySelector('.screen:not([hidden])');
    if (cur && !cur.getAttribute('aria-labelledby')) issues.push('screen has no aria-labelledby');
    if (cur && document.activeElement && !document.querySelector('dialog[open]') && !cur.contains(document.activeElement) && !document.activeElement.closest('.titlebar') && document.activeElement !== document.body) issues.push('focus is outside the screen: ' + document.activeElement.tagName);
    document.querySelectorAll('[aria-labelledby],[aria-describedby]').forEach((el) => {
      (el.getAttribute('aria-labelledby') || '').concat(' ', el.getAttribute('aria-describedby') || '').split(/\s+/).filter(Boolean).forEach((i) => { if (!document.getElementById(i)) issues.push('aria reference to missing id ' + i); });
    });
    return issues;
  });
}

Object.assign(module.exports, { layoutAudit, contrastAudit, a11yScan });
