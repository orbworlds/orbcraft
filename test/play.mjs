#!/usr/bin/env node
// Orbcraft (index.html) in a headless browser, through its ?debug hooks (window.__oc): the Wilds boot
// into Haven with its keepers, portals and ruins; Haven's rules hold (no digging, building, fighting or monsters inside
// its walls); each keeper opens what it keeps; progression pays out (the daily reward, quests, achievements, the Wild
// Pass and Wild Pass+, treasure chests, coin and credit looks); the Wilds' changes are saved for everyone, for good (tagged
// store pages: one from another island counts as empty and is started over) and come back after a reload; dying leaves
// your pack where you fell; ruins' chests give once a month; the build island and Ten Nights are a portal away and lead back.
// Two players then share the Wilds (orb.room faked with a relay between two browser windows, orb.store shared through
// this process): they see each other, emote and chat, see each other's edits, can't fight in Haven or hurt a newcomer,
// can fight out in the Wilds, take a fallen player's pack, and see and fight each other's monsters. Then phones and
// tablets: a phone plays Haven and the Wilds by touch, and in every size (and Safari's engine, WebKit, where it's
// installed) everything fits and takes a tap, with a keeper's prompt and a tip up too.
//
//   node test/play.mjs [--quick: no two players] [--phones: only the phones and tablets]
import { webkit, devices } from 'playwright';
import { launch, routeCdn } from '@orbworlds/kit/browser';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GAME = path.join(root, 'index.html');
const URL = 'file://' + GAME + '?debug';
const quick = process.argv.includes('--quick'), phonesOnly = process.argv.includes('--phones');
let failures = 0;
const ok = (cond, what) => { console.log(`${cond ? '✓' : '✗'} ${what}`); if (!cond) failures++; };

// A stand-in for Orb's runtime: rooms relayed between the pages by this process, a store shared by them all (with list,
// as Orb's has), and a shop in memory.
function fakeOrb({ id, name }) {
  const store = (op, k, v, x) => window.__store(op, k, v, x);
  window.orb = {
    me: { id, name, color: '#5ed1ff', wears: [] },
    world: { id: 'test', name: 'Orbcraft' },
    room: {
      invited: null,
      invite: async (r) => `https://example.test/?room=${r}`,
      join(cb, opts = {}) {
        const topic = 'room:' + (opts.name || ''), self = { id: `${id}:${Math.random().toString(36).slice(2, 8)}`, name, color: '#5ed1ff' };
        const ch = { onmessage: null, postMessage: (data) => window.__relay?.(topic, data), close() { ch.closed = true; } };
        (window.__chans ||= []).push([topic, ch]);
        let state = null, left = false;
        const known = new Map();
        const peer = (p) => ({ id: p.id, name: p.name, color: p.color, wears: [], state: p.state, friend: false });
        ch.onmessage = (ev) => {
          const m = ev.data; if (left || !m || m.from?.id === self.id) return;
          if (m.t === 'hello' || m.t === 'state') {
            const had = known.has(m.from.id); known.set(m.from.id, { ...m.from, state: m.state });
            cb({ type: had ? 'state' : 'join', peer: peer(known.get(m.from.id)) });
            if (m.t === 'hello' && !m.reply) ch.postMessage({ t: 'hello', reply: true, from: self, state });
          } else if (m.t === 'msg') cb({ type: 'message', peer: peer(known.get(m.from.id) || m.from), data: m.data });
          else if (m.t === 'bye' && known.has(m.from.id)) { const p = known.get(m.from.id); known.delete(m.from.id); cb({ type: 'leave', peer: peer(p) }); }
        };
        setTimeout(() => { cb({ type: 'joined', self: peer(self), peers: [...known.values()].map(peer), live: true }); ch.postMessage({ t: 'hello', from: self, state }); }, 30);
        return {
          send: (data) => !left && ch.postMessage({ t: 'msg', from: self, data }),
          setState: (s) => { state = s; if (!left) ch.postMessage({ t: 'state', from: self, state: s }); },
          leave: () => { if (left) return; ch.postMessage({ t: 'bye', from: self }); left = true; ch.close(); },
        };
      },
    },
    store: { get: (k) => store('get', k), set: (k, v) => store('set', k, v), incr: (k, by = 1) => store('incr', k, by), push: (k, v, max = 50) => store('push', k, v, max), merge: (k, p) => store('merge', k, p), list: (pre) => store('list', pre) },
    shop: { owned: async () => window.__owned || [], items: async () => [], buy: async (item) => { (window.__owned ||= []).push(item); return { ok: true, item }; } },
    capture() {}, toast() {},
  };
}
const STORE = new Map();
let wildOffline = false;                               // writes to the Wilds' pages fail (the store out of reach)
function storeOp(op, k, v, x) {
  if (wildOffline && (op === 'merge' || op === 'set') && String(k).startsWith('w:')) throw new Error('offline');
  const cur = STORE.has(k) ? structuredClone(STORE.get(k)) : null;
  if (op === 'get') return cur;
  if (op === 'list') return Object.fromEntries([...STORE].filter(([key]) => key.startsWith(k)).map(([key, val]) => [key, structuredClone(val)]));
  if (op === 'set') { STORE.set(k, v); return v; }
  if (op === 'incr') { const n = (typeof cur === 'number' ? cur : 0) + (v ?? 1); STORE.set(k, n); return n; }
  if (op === 'push') { const l = Array.isArray(cur) ? cur : []; l.push(v); while (l.length > (x || 50)) l.shift(); STORE.set(k, l); return l; }
  if (op === 'merge') { const o = cur && typeof cur === 'object' && !Array.isArray(cur) ? cur : {}; for (const [a, b] of Object.entries(v || {})) { if (b === null) delete o[a]; else o[a] = b; } STORE.set(k, o); return o; }
  return null;
}

const pages = new Set();
async function openPage(browser, who, device = { viewport: { width: 1100, height: 680 } }, { daily = false, context = null, seed = null } = {}) {
  const page = await (context || (await browser.newContext(device))).newPage();
  pages.add(page); page.on('close', () => pages.delete(page));
  await page.exposeFunction('__relay', (topic, data) => {
    for (const p of pages) if (p !== page) p.evaluate(([t, d]) => { for (const [tp, ch] of window.__chans || []) if (tp === t && !ch.closed) ch.onmessage?.({ data: d }); }, [topic, data]).catch(() => {});
  });
  await page.exposeFunction('__store', storeOp);
  await routeCdn(page);
  const errors = [];
  page.on('pageerror', (e) => errors.push(`${who}: ${e.message}\n${(e.stack || '').split('\n').slice(1, 4).join('\n')}`));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`${who} console: ${m.text()}`); });
  await page.addInitScript(fakeOrb, { id: `${who}-id`, name: who });
  if (seed) await page.addInitScript(([k, v]) => localStorage.setItem(k, JSON.stringify(v)), seed);   // what this device kept from before
  await page.goto(URL + (daily ? '' : '&nodaily'), { waitUntil: 'domcontentloaded', timeout: 90000 });   // waitWild says when it's ready
  await waitWild(page);
  await orbDock(page);
  return { page, errors };
}
const waitWild = (page) => page.waitForFunction(() => window.__oc?.game.mode === 'wild' && window.__oc.player && document.getElementById('loading').classList.contains('out'), null, { timeout: 90000 });
/** Daytime in the Wilds, for as long as the test needs (the shared clock shifted to mid-morning). */
const daytime = (page) => page.evaluate(() => { const o = window.__oc, c = o.wildClock(); o.clockShift = (o.clockShift || 0) - c.t + 60; });
/** Put someone outside Haven's east gate, standing on the ground (dx blocks further out). */
const outside = (page, dx = 0) => page.evaluate((dx) => {
  const o = window.__oc, w = o.world(), p = o.player, x = w.haven.x + 32 + dx, z = w.haven.z + 1;
  let y = 60; while (y > 1 && !o.getB(x, y - 1, z)) y--;
  Object.assign(p, { x: x + 0.5, y, ry: y, z: z + 0.5, vx: 0, vy: 0, vz: 0, prot: 0 });
  return [x, y, z];
}, dx);
/** Stand next to a keeper and let a frame see it. */
async function standBy(page, kind) {
  await page.evaluate((kind) => { const o = window.__oc, k = o.world().keepers.find((x) => x.kind === kind), p = o.player; Object.assign(p, { x: k.x + Math.sin(k.yaw) * 1.6, z: k.z + Math.cos(k.yaw) * 1.6, y: k.y, ry: k.y, vx: 0, vz: 0 }); }, kind);
  await page.waitForFunction((kind) => window.__oc.nearKeeper()?.kind === kind, kind, { timeout: 15000 });
}
const panelNow = (page) => page.evaluate(() => (document.getElementById('panel').classList.contains('on') ? document.getElementById('panelTitle').textContent : ''));
// Phones and tablets: real touches through Chromium's DevTools protocol (they arrive as touch and pointer events, and a
// tap clicks), in each size and both ways round.
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const ANDROID = 'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Mobile Safari/537.36';
const device = (width, height, userAgent = IPHONE) => ({ viewport: { width, height }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, userAgent });
async function fingers(page) {
  const cdp = await page.context().newCDPSession(page);
  const send = (type, pts) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts.map(([x, y], i) => ({ x, y, id: i + 1 })) });
  const at = (p) => (typeof p === 'string' ? page.$eval(p, (el) => { el.scrollIntoView({ block: 'nearest' }); const r = el.getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; }) : p);
  return {
    async tap(p) { await send('touchStart', [await at(p)]); await page.waitForTimeout(60); await send('touchEnd', []); await page.waitForTimeout(300); },
    async down(p) { await send('touchStart', [await at(p)]); await page.waitForTimeout(120); },
    async up() { await send('touchEnd', []); await page.waitForTimeout(120); },
    async drag(p0, [x1, y1], ms = 300, holdMs = 0) {
      const [x0, y0] = await at(p0);
      await send('touchStart', [[x0, y0]]);
      for (let i = 1; i <= 8; i++) { await send('touchMove', [[x0 + ((x1 - x0) * i) / 8, y0 + ((y1 - y0) * i) / 8]]); await page.waitForTimeout(ms / 8); }
      if (holdMs) await page.waitForTimeout(holdMs);
      await send('touchEnd', []); await page.waitForTimeout(150);
    },
  };
}
/** What's wrong on screen: each control should be inside the screen, big enough for a thumb, on top where it is (a tap
 *  there reaches it) and clear of the other controls and of the HUD's panels (`[controls, panels]`); the panels should
 *  be inside the screen and clear of each other. */
const auditControls = (page, [controls, panels = []]) => page.evaluate(([controls, panels]) => {
  const bad = [], seen = [], shown = (el) => { const s = getComputedStyle(el); return s.display !== 'none' && s.visibility !== 'hidden' && s.opacity !== '0' && !el.closest('.hidden') && el.getBoundingClientRect().width > 0; };
  const over = (r, r2) => Math.min(r.right, r2.right) - Math.max(r.left, r2.left) > 3 && Math.min(r.bottom, r2.bottom) - Math.max(r.top, r2.top) > 3;
  const offScreen = (r) => r.left < -1 || r.top < -1 || r.right > innerWidth + 1 || r.bottom > innerHeight + 1;
  // what of it shows: a list that scrolls clips what's scrolled away (a swipe brings it back)
  const inView = (el) => {
    let { left, top, right, bottom } = el.getBoundingClientRect();
    for (let a = el.parentElement; a && a !== document.body; a = a.parentElement) {
      if (!/auto|scroll|hidden/.test(getComputedStyle(a).overflow)) continue;
      const c = a.getBoundingClientRect(); left = Math.max(left, c.left); top = Math.max(top, c.top); right = Math.min(right, c.right); bottom = Math.min(bottom, c.bottom);
    }
    return right - left > 3 && bottom - top > 3 ? { left, top, right, bottom, width: right - left, height: bottom - top } : null;
  };
  const boxes = panels.flatMap((sel) => [...document.querySelectorAll(sel)].filter(shown).map((el) => [el.id || sel, el, el.getBoundingClientRect()]));
  for (const [i, [name, el, r]] of boxes.entries()) {
    if (offScreen(r)) bad.push(`${name} off screen`);
    for (const [n2, el2, r2] of boxes.slice(0, i)) if (!el.contains(el2) && !el2.contains(el) && over(r, r2)) bad.push(`${name} on ${n2}`);
  }
  const done = new Set();
  for (const sel of controls) for (const el of document.querySelectorAll(sel)) {
    if (!shown(el) || done.has(el)) continue;
    done.add(el);
    const r = inView(el), full = el.getBoundingClientRect(), name = el.id || el.getAttribute('aria-label') || sel;
    if (!r) continue;
    if (offScreen(r)) bad.push(`${name} off screen`);
    if (Math.min(full.width, full.height) < 36) bad.push(`${name} ${Math.round(full.width)}×${Math.round(full.height)} px`);
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    if (hit && !el.contains(hit)) bad.push(`${name} under ${hit.id || hit.className || hit.tagName}`);
    for (const [n2, r2] of seen) if (over(r, r2)) bad.push(`${name} on ${n2}`);
    for (const [n2, box, r2] of boxes) if (!box.contains(el) && over(r, r2)) bad.push(`${name} on ${n2}`);
    seen.push([name, r]);
  }
  return [...new Set(bad)];
}, [controls, panels]);
// The Wilds' controls round the edges (your card, the day's bar and the hearts are panels: nothing may sit on them).
// Orb's own button floats over the world on the right edge, 72% of the way down (src/components/orb/Orb.tsx): a
// stand-in for it (#orbDock, which takes no taps) is a panel too, so no control hides under it.
const WILD_CONTROLS = [['#blocksBtn', '#bMenu', '#bEmote', '#camBtn', '#muteBtn', '#pauseBtn', '#tBreak', '#tPlace', '#tJump', '#tSneak', '#lPrompt', '#hotbar .slot'],
  ['#lTop', '#wTop', '#chips', '#hearts', '#food', '#hotbar', '#orbDock']];
// ...and with a tip, a banner or a toast up, those too (nothing may sit on them, nor they on each other)
const WITH_POPS = [WILD_CONTROLS[0], [...WILD_CONTROLS[1], '#tip', '#banner', '#toast']];
/** Until the tip, the banner and the toast are done fading in or out (mid-fade, one that's on its way out still counts). */
const settled = (page) => page.waitForFunction(() => ['tip', 'banner', 'toast'].every((id) => ['0', '1'].includes(getComputedStyle(document.getElementById(id)).opacity)), null, { timeout: 5000 }).catch(() => {});
const auditPops = async (page) => { await settled(page); return auditControls(page, WITH_POPS); };
const HAVEN_TIP = 'Welcome to <b>Haven</b> — talk to the keepers, then walk out through a gate into the <b>Wilds</b>';
const orbDock = (page) => page.evaluate(() => {
  const d = document.getElementById('orbDock') || document.body.appendChild(Object.assign(document.createElement('div'), { id: 'orbDock' }));
  d.style.cssText = 'position:fixed;width:56px;height:56px;right:18px;top:calc(18px + (100% - 92px) * 0.72);pointer-events:none;z-index:-1';
});
const PANELS = ['quests', 'pass', 'wardrobe', 'chests', 'boards', 'travel'];
/** Each panel, the pack and the Vault on their own: inside the screen, and their buttons take a tap (a list may scroll). */
async function auditPanels(page) {
  const problems = [];
  for (const id of PANELS) {
    await page.evaluate((id) => window.__oc.openPanel(id), id); await page.waitForTimeout(450);
    await page.waitForFunction(() => document.getElementById('panel').getAnimations().every((a) => a.playState !== 'running'), null, { timeout: 3000 }).catch(() => {});   // (it slides in)
    problems.push(...(await auditControls(page, [['#panelClose', '#panelNav button', '#panelTabs button', '#panelBody .btn:not([disabled])', '#panelBody .cos'], ['#panel']])).map((x) => `${id}: ${x}`));
  }
  await page.evaluate(() => window.__oc.closePanel());
  for (const id of ['svInv', 'vault']) {
    await page.evaluate((id) => window.__oc.openDialog(id), id); await page.waitForTimeout(250);
    problems.push(...(await auditControls(page, [[`#${id} .ibtn`, `#${id} .svs`, `#${id} .tabs button`], [`#${id}`]])).map((x) => `${id}: ${x}`));
    await page.evaluate(() => window.__oc.closeDialog());
  }
  await page.evaluate(() => window.__oc.openDaily()); await page.waitForTimeout(600);
  problems.push(...(await auditControls(page, [['#dClaim', '#dLater'], ['.dailycard']])).map((x) => `daily: ${x}`));
  await page.evaluate(() => document.getElementById('dLater').click()); await page.waitForTimeout(600);
  return problems;
}

const browser = await launch();
try {
  if (!phonesOnly) {
    // --- a career from before October 2026's economy (level 40 on the old curve, 3,000 coins, tier 3 of this month's
    // pass), opened before anyone else so it shares no room with them ------------------------------------------------
    const oldXp = (L) => { let t = 0; for (let l = 1; l < L; l++) t += 100 + 25 * Math.min(l - 1, 20); return t; }, thisMonth = new Date().toISOString().slice(0, 7);
    const vet = await openPage(browser, 'veteran', undefined, { seed: ['oc:prof', { v: 1, xp: oldXp(40) + 5, coins: 3000, seasons: [thisMonth], ach: { level: 3, owned: 2, seasons: 1 }, pass: { s: thisMonth, xp: 1250, free: [], prem: [] } }] });
    const mig = await vet.page.evaluate(() => { const o = window.__oc; return { level: o.level(), coins: o.profile.coins, tier: o.passTier(), econ: o.profile.econ }; });
    await vet.page.context().close();
    ok(mig.level === 40 && mig.coins === 20000 && mig.tier === 3 && mig.econ === 1 && !vet.errors.length, `a career from before the new economy keeps its level (40), what its coins could buy (3,000 → 20,000) and its Wild Pass tier (${JSON.stringify(mig)})`);

    // --- the Wilds, from Haven --------------------------------------------------------------------------------------
    const A = await openPage(browser, 'Ana', undefined, { daily: true });
    const P = A.page;
    const boot = await P.evaluate(() => { const o = window.__oc, w = o.world(); return { kind: w.kind, season: w.season, keepers: w.keepers.map((k) => k.kind), portals: w.portals.length, ruins: w.ruins.length, inHaven: o.inHaven(o.player.x, o.player.z), npcs: o.ents.filter((e) => e.keeper).length }; });
    ok(boot.kind === 'wild' && boot.season === '2026-10' && boot.inHaven, `Orbcraft opens in Haven, in the Wilds that are kept for good (${boot.season}, whatever the month)`);
    ok(boot.keepers.length === 9 && boot.npcs === 9 && boot.portals === 2, `Haven has its nine keepers and two portals (${boot.keepers.join(', ')})`);
    ok(boot.ruins >= 6, `the Wilds have ruins with chests (${boot.ruins})`);
    await P.waitForTimeout(2200);
    ok(await P.evaluate(() => document.getElementById('daily').classList.contains('hidden') && document.querySelector('#bMenu .badge').classList.contains('on')), 'a new player isn\'t greeted by the daily reward: it waits on the menu\'s badge');
    await P.evaluate(() => window.__oc.openDaily()); await P.waitForTimeout(300);
    const coins0 = await P.evaluate(() => window.__oc.profile.coins);
    await P.click('#dClaim'); await P.waitForTimeout(400);
    ok(await P.evaluate((c0) => { const o = window.__oc; return o.profile.coins === c0 + 50 && o.profile.login.streak === 1; }, coins0), 'claiming it pays 50 coins and starts a streak');
    await daytime(P);

    // --- Haven's rules ----------------------------------------------------------------------------------------------
    const rules = await P.evaluate(() => {
      const o = window.__oc, w = o.world(), h = w.haven, p = o.player, x = h.x + 5, z = h.z + 5, y = h.y - 1;
      const before = o.getB(x, y, z);
      const placed = o.placeBlock(p, x, y + 1, z, o.B.STONE);
      p.hp = 20; o.takeHit(p, 6, { name: 'Bo', id: 'p:bo', team: 1, pid: 'bo' }, {});
      const hpPvp = p.hp;
      o.takeHit(p, 6, { name: 'Zombie', id: 'm1', team: -2, pid: '' }, {});
      const hpMob = p.hp;
      return { before, now: o.getB(x, y, z), placed, hpPvp, hpMob, prot: o.protectedAt(x, z) };
    });
    ok(rules.prot && !rules.placed && rules.now === rules.before, 'nobody can build or dig in Haven');
    ok(rules.hpPvp === 20 && rules.hpMob === 20, 'nobody gets hurt in Haven, by a player or a monster');
    const mobOut = await P.evaluate(async () => {
      const o = window.__oc, w = o.world(), h = w.haven, p = o.player;
      // a zombie at the east gate, you just inside: it can't follow you in
      p.x = h.x + 17.5; p.z = h.z + 0.5;
      let y = 60; const zx = h.x + 26, zz = h.z; while (y > 1 && !o.getB(zx, y - 1, zz)) y--;
      const z = o.spawnMob('zombie', zx + 0.5, y, zz + 0.5); z.ai.target = p; z.ai.think = 99;
      await new Promise((r) => setTimeout(r, 6000));
      const d = o.havenDist(z.x, z.z); if (o.ents.includes(z) && z.hp > 0) z.hp = 0;
      return { d, protect: 23 };
    });
    ok(mobOut.d > mobOut.protect, `monsters can't get into Haven (one at the gate stays ${mobOut.d} blocks out)`);

    // --- the keepers ------------------------------------------------------------------------------------------------
    const want = { quests: 'Quests', pass: 'Wild Pass', wardrobe: 'Wardrobe', chests: 'Treasure chests', boards: 'Best players', build: 'Travel', surv: 'Travel' };
    for (const [kind, title] of Object.entries(want)) {
      await standBy(P, kind); await P.keyboard.press('KeyE'); await P.waitForTimeout(250);
      ok(await panelNow(P) === title, `E by the ${kind} keeper opens ${title}`);
      await P.evaluate(() => window.__oc.closePanel());
    }
    await standBy(P, 'vault'); await P.keyboard.press('KeyE'); await P.waitForTimeout(250);
    ok(await P.evaluate(() => window.__oc.game && document.getElementById('vault').classList.contains('on')), 'E by the Vault keeper opens the Vault');
    await P.evaluate(() => window.__oc.closeDialog());
    await standBy(P, 'daily'); await P.click('#lPrompt'); await P.waitForTimeout(700);
    ok(await P.evaluate(() => !document.getElementById('daily').classList.contains('hidden')), 'a click on the prompt by the daily keeper shows the daily reward (claimed: back tomorrow)');
    await P.click('#dLater'); await P.waitForTimeout(600);

    // --- progression ------------------------------------------------------------------------------------------------
    const prog = await P.evaluate(async () => {
      const o = window.__oc, p = o.player, w = o.world(), out = {};
      // a diamond out in the Wilds, with an iron pickaxe in your pack
      const x = w.haven.x + 40, z = w.haven.z + 2; let y = 50; while (y > 2 && !o.getB(x, y, z)) y--;
      Object.assign(p, { x: x + 0.5, y: y + 1, ry: y + 1, z: z + 1.5 });
      o.addItem('pick2', 1); o.svGear?.(p);
      o.setBlock(x, y, z, o.B.DIAMOND_ORE);
      p.pick = 3;
      const xp0 = o.profile.xp, dia0 = o.profile.stats.dia;
      o.breakBlock(p, x, y, z);
      await new Promise((r) => setTimeout(r, 500));
      out.dia = o.profile.stats.dia - dia0; out.xp = o.profile.xp - xp0; out.got = o.countItem('diamond');
      out.diaAch = o.profile.ach.dia | 0;
      // quests: whatever today's are, doing them pays
      const d = o.dailies(), q = d.list[0], c0 = o.profile.coins;
      o.countQuests({ [q.id]: 9999 });
      out.questDone = o.dailies().list[0].done; out.questCoins = o.profile.coins - c0;
      // the Wild Pass: XP fills it, a tier's reward claims
      o.addXp(1300); out.tier = o.passTier();
      out.claimed = !!o.claimPass(1, false);
      // treasure chests: one opened is a look (or coins)
      o.profile.boxes = 2; const own0 = o.profile.owned.length, cc = o.profile.coins;
      o.openBoxAnim(); await new Promise((r) => setTimeout(r, 2200));
      out.box = o.profile.owned.length > own0 || o.profile.coins > cc;
      document.getElementById('boxDone').click();
      // a coin look, then a credit one, worn and seen in your room state
      o.profile.coins += 5000; o.openPanel('wardrobe');
      const coinLook = o.COS.find((c) => c.how === 'coins' && c.type === 'cape' && !o.owns(c.type, c.id));
      document.querySelector('[data-ptab="cape"]').click();
      document.querySelector(`[data-act="cos"][data-v="${coinLook.id}"]`).click();
      document.querySelector('[data-act="coins"]').click();
      out.coinLook = o.worn('cape') === coinLook.id;
      document.querySelector('[data-act="cos"][data-v="cape-dragon"]')?.click();
      document.querySelector('[data-act="credits"]')?.click();
      await new Promise((r) => setTimeout(r, 600));
      out.credit = o.creditOwned.has('cape-dragon') && o.worn('cape') === 'cape-dragon';
      o.closePanel();
      out.wear = o.player.wear.cape;
      return out;
    });
    ok(prog.dia === 1 && prog.got >= 1 && prog.xp >= 15, `a diamond mined counts (+${prog.xp} XP, in your pack)`);
    ok(prog.diaAch >= 1, 'the first diamond is an achievement (Diamond Hands I)');
    ok(prog.questDone && prog.questCoins > 0, `a finished quest pays (+${prog.questCoins} coins)`);
    ok(prog.tier >= 2 && prog.claimed, `XP fills the Wild Pass (tier ${prog.tier}), and its rewards claim`);
    ok(prog.box, 'a treasure chest opens to a look (or coins)');
    ok(prog.coinLook, 'a look bought with coins is worn at once');
    ok(prog.credit && prog.wear === 'cape-dragon', 'a look bought with Orb credits (the Dragon Cape) is yours and worn');
    // the Wild Pass a year on: the same month's season, its title yours already, pays coins for it instead
    const again = await P.evaluate(() => {
      const o = window.__oc, year = () => { o.passTier(); Object.assign(o.profile.pass, { xp: 600 * 15, free: [], prem: [] }); };
      year(); const title = o.claimPass(15, false)?.look?.[1];
      year(); o.openPanel('pass');
      const shown = [...document.querySelectorAll('#panel .prew')].filter((c) => c.textContent.includes('yours already')).length;
      const c0 = o.profile.coins, o0 = o.profile.owned.length, r = o.claimPass(15, false);
      o.closePanel();
      return { title, r, coins: o.profile.coins - c0, owned: o.profile.owned.length - o0, shown };
    });
    ok(again.title === `title-s${new Date().getUTCMonth()}` && again.r?.c === 800 && again.coins === 800 && !again.owned && again.shown === 1, `a season comes back with its month: a year on, its title (yours already) pays 800 coins instead, as a rare from a treasure chest would, and the pass shows it (${JSON.stringify(again)})`);
    // --- the Wilds' changes: saved, season-tagged, and back after a reload ------------------------------------------
    const edit = await P.evaluate(async () => {
      const o = window.__oc, w = o.world(), p = o.player, x = w.haven.x + 44, z = w.haven.z + 9; let y = 50; while (y > 2 && !o.getB(x, y, z)) y--;
      Object.assign(p, { x: x + 0.5, y: y + 1, ry: y + 1, z: z + 1.5 });
      const b = o.getB(x, y, z); o.breakBlock(p, x, y, z);
      if (!o.placeBlock(p, x, y + 3, z + 3, o.B.STONE)) o.setBlock(x, y + 3, z + 3, o.B.STONE);
      await new Promise((r) => setTimeout(r, 5000));
      return { x, y, z, b, now: o.getB(x, y, z), season: w.season };
    });
    const saved = [...STORE].filter(([k]) => k.startsWith('w:'));
    ok(saved.length && saved.every(([, v]) => v._s === edit.season), `the Wilds' changes are saved in the store, tagged with the season (${saved.map(([k]) => k).join(', ')})`);
    await P.reload(); await waitWild(P);
    await P.waitForFunction(() => window.__oc.wsave.loaded, null, { timeout: 30000 });
    ok(await P.evaluate((e) => window.__oc.getB(e.x, e.y, e.z) === 0, edit), 'after a reload, the block you broke is still gone');
    // an older season's page in the same area: counts as empty, and the next change there starts it over
    const area = `${(edit.x + 3) >> 4}:${edit.z >> 4}`, [cx, cz] = area.split(':').map(Number), oldKey = `w:${cx >> 1}:${cx}:${cz}:0`;
    STORE.set(oldKey, { _s: '2020-01', [(((edit.x + 3) & 15) + 16 * ((edit.z & 15) + 16 * (edit.y + 6))).toString(36)]: 4 });
    const stale = await P.evaluate(async (e) => {
      const o = window.__oc; await o.loadWildEdits();
      const ghost = o.getB(e.x + 3, e.y + 6, e.z);
      o.setBlock(e.x + 3, e.y + 1, e.z, o.B.PLANKS); o.wsave.pending.clear();
      const { cellKey } = { cellKey: (x, y, z) => ((x & 15) + 16 * ((z & 15) + 16 * y)).toString(36) };
      o.wsave.pending.set(`${(e.x + 3) >> 4}:${e.z >> 4}`, { [cellKey(e.x + 3, e.y + 1, e.z)]: o.B.PLANKS });
      o.wsave.t = 0; await o.flushWild();
      return { ghost };
    }, edit);
    const after = STORE.get(oldKey);
    ok(stale.ghost !== 4 && after?._s === edit.season && !Object.values(after).includes(4), 'a page from an earlier season counts as empty, and the next change there starts it over');
    // the store out of reach: a block broken just before a reload stays broken (kept on the device, sent once it can be),
    // so what it gave can't be had again by mining it again
    wildOffline = true;
    const gone = await P.evaluate(async () => {
      const o = window.__oc, w = o.world(), p = o.player, x = w.haven.x + 52, z = w.haven.z - 14; let y = 50; while (y > 2 && !o.getB(x, y, z)) y--;
      Object.assign(p, { x: x + 0.5, y: y + 1, ry: y + 1, z: z + 1.5 });
      const b = o.getB(x, y, z); o.breakBlock(p, x, y, z);
      await new Promise((r) => setTimeout(r, 2600));                  // a write was tried, and failed
      return { x, y, z, b, now: o.getB(x, y, z) };
    });
    await P.reload(); await waitWild(P);
    await P.waitForFunction(() => window.__oc.wsave.loaded, null, { timeout: 30000 });
    const keptB = await P.evaluate((g) => window.__oc.getB(g.x, g.y, g.z), gone);
    wildOffline = false;
    const cellKey = ((gone.x & 15) + 16 * ((gone.z & 15) + 16 * gone.y)).toString(36), areaRe = new RegExp(`^w:\\d+:${gone.x >> 4}:${gone.z >> 4}:\\d+$`);
    const landed = async () => { for (let i = 0; i < 40; i++) { if ([...STORE].some(([k, v]) => areaRe.test(k) && v[cellKey] === gone.now)) return true; await new Promise((r) => setTimeout(r, 250)); } return false; };
    ok(gone.now !== gone.b && keptB === gone.now && await landed(), `a block broken just before a reload, with the store out of reach, stays broken after it and reaches the store once it can (${JSON.stringify({ ...gone, keptB })})`);

    // --- falling: your pack stays where you fell ------------------------------------------------------------------
    await daytime(P);
    const fall = await P.evaluate(async () => {
      const o = window.__oc, p = o.player;
      o.wild.inv.fill(null); o.addItem('cobble', 20); o.addItem('pick1', 1); o.addItem('apple', 3); o.wild.fresh = 0; o.wild.freshGone = true;
      const w = o.world(), x = w.haven.x + 36, z = w.haven.z - 6; let y = 60; while (y > 1 && !o.getB(x, y - 1, z)) y--;
      Object.assign(p, { x: x + 0.5, y, ry: y, z: z + 0.5, vx: 0, vy: 0, vz: 0, prot: 0 });
      await new Promise((r) => setTimeout(r, 300));
      o.wildDie(p, 'kill');
      const bag = o.wild.bags[0], left = o.wild.inv.filter(Boolean).map((s) => s.id), bagItems = bag.items.map((s) => s.id);
      await new Promise((r) => setTimeout(r, 6500));
      const home = o.inHaven(p.x, p.z) && !p.dead;
      Object.assign(p, { x: bag.x, y: bag.y, ry: bag.y, z: bag.z, vx: 0, vz: 0 });
      await new Promise((r) => setTimeout(r, 800));
      return { bagItems, left, home, back: o.countItem('cobble'), bags: o.wild.bags.length };
    });
    ok(fall.bagItems.includes('cobble') && fall.bagItems.includes('apple') && !fall.bagItems.includes('pick1') && fall.left.includes('pick1'), 'dying out there leaves your pack where you fell — but not your tools');
    ok(fall.home, 'and you come back in Haven');
    ok(fall.back === 20 && fall.bags === 0, 'walking back over your pack takes it all back');
    // a pack left behind outlives a reload (it runs out on the clock either way)
    await P.evaluate(() => { const o = window.__oc, p = o.player; o.wild.inv.fill(null); o.addItem('cobble', 7); o.wild.fresh = 0; const w = o.world(); Object.assign(p, { x: w.haven.x + 36.5, z: w.haven.z - 5.5, prot: 0 }); o.wildDie(p, 'kill'); });
    await P.reload(); await waitWild(P);
    const pack = await P.evaluate(() => { const o = window.__oc, b = o.wild.bags[0]; return { n: o.wild.bags.length, items: b?.items.map((s) => `${s.id}×${s.n}`).join(), cobble: o.countItem('cobble') }; });
    ok(pack.n === 1 && pack.items === 'cobble×7' && pack.cobble === 0, `a pack left where you fell is still there after a reload (${JSON.stringify(pack)})`);
    await P.evaluate(() => { const o = window.__oc, b = o.wild.bags[0]; if (b) Object.assign(o.player, { x: b.x, y: b.y, ry: b.y, z: b.z, vx: 0, vz: 0 }); });
    await P.waitForFunction(() => window.__oc.countItem('cobble') === 7, null, { timeout: 10000 }).catch(() => {});

    // --- your pack, the bow, packs handed over, your room ------------------------------------------------------------
    const kit = await P.evaluate(async () => {
      const o = window.__oc, out = {};
      o.wild.inv.fill(null); o.addItem('bow', 1); o.addItem('arrow', 3); o.addItem('apple', 2); o.setSel(0);
      o.openDialog('svInv');                                          // the pack screen shows what you carry in the Wilds
      out.screen = [...document.querySelectorAll('#svSlots [data-s]')].map((b) => b.getAttribute('aria-label')).filter((l) => l !== 'Empty');
      o.closeDialog();
      // hold until the bow is drawn and let go until it's shot: by the game's own state, not a fixed time (a slow
      // machine draws a frame in more than the half-second a quick one takes to draw the bow)
      const until = async (f) => { for (let t = 0; t < 200 && !f(); t++) await new Promise((r) => setTimeout(r, 50)); };
      for (let k = 0; k < 2; k++) { o.input.place = true; await until(() => o.player.draw >= 0.4); o.input.place = false; await until(() => o.player.draw === 0); }
      out.arrows = o.countItem('arrow');                              // two shots, two arrows
      const d0 = o.countItem('diamond');
      o.receiveLoot({ b: 7, it: [['diamond', 5]] }, 'stranger');      // a pack nobody asked for
      out.uninvited = o.countItem('diamond') - d0;
      o.wild.takeAt['stranger:7'] = Date.now();
      o.receiveLoot({ b: 7, it: [['diamond', 2]] }, 'stranger'); o.receiveLoot({ b: 7, it: [['diamond', 2]] }, 'stranger');
      out.asked = o.countItem('diamond') - d0;                        // one you did, once
      out.room = o.net.wrName; out.season = o.world().season;
      return out;
    });
    const names = await P.evaluate(() => ['bow', 'arrow', 'apple'].map((id) => window.__oc.ITEMS[id].name));
    ok(names.every((n) => kit.screen.includes(n)), `the pack screen in the Wilds shows what you carry there (${kit.screen.join(', ')})`);
    ok(kit.arrows === 1, `in the Wilds each arrow you shoot is used up (3 arrows, 2 shots: ${kit.arrows} left)`);
    ok(kit.uninvited === 0 && kit.asked === 2, `a pack handed over counts only if you asked for it, and only once (${JSON.stringify({ uninvited: kit.uninvited, asked: kit.asked })})`);
    ok(kit.room === `wild-${kit.season}`, `the Wilds' room is the island's own (${kit.room})`);

    // --- ruins: a chest each, once a month ---------------------------------------------------------------------------
    const ruin = await P.evaluate(() => {
      const o = window.__oc, r = o.world().ruins[0], n0 = o.wild.inv.filter(Boolean).length, c0 = o.profile.stats.ruins;
      o.lootRuin(r); const n1 = o.wild.inv.filter(Boolean).length; o.lootRuin(r); const n2 = o.wild.inv.filter(Boolean).length;
      return { got: n1 > n0, again: n2 === n1, count: o.profile.stats.ruins - c0, kind: r.kind, unbreakable: !o.world().ruins.length || o.getB(r.x, r.y, r.z) === o.B.CHEST };
    });
    ok(ruin.got && ruin.again && ruin.count === 1, `a ruin's chest (a ${ruin.kind}) gives once a month`);

    // --- the Hall of Fame keeps two years of seasons (one stored value), whatever the year ---------------------------
    const month = (back) => { const d = new Date(); d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() - back); return d.toISOString().slice(0, 7); };
    STORE.set('oc:hof', Object.fromEntries(Array.from({ length: 30 }, (_, i) => [month(i + 2), [['Champion' + i, 5000 + i, 'default', 'none', 'none']]])));
    STORE.set('oc:sb', { ...(STORE.get('oc:sb') || {}), 'last-month': ['Lastly', 4321, 3, 9, 1, month(1), 'default', 'none', 'cape-dragon'] });
    await P.evaluate(() => window.__oc.refreshBoards()); await P.waitForTimeout(500);
    const hof = STORE.get('oc:hof') || {}, kept = Object.keys(hof).sort();
    ok(kept.length === 24 && kept[0] === month(24) && JSON.stringify(hof[month(1)]) === '[["Lastly",4321]]' && JSON.stringify(hof).length < 8192,
      `last month's champions go up in the Hall of Fame, and seasons over two years old come down (${kept.length} seasons, ${kept[0]}–${kept.at(-1)}, ${JSON.stringify(hof).length} bytes)`);

    // --- the build island and Ten Nights: a portal away, and back --------------------------------------------------
    await P.evaluate(() => window.__oc.openPanel('travel')); await P.waitForTimeout(500);
    await P.evaluate(() => document.querySelector('[data-act="go-build"]').click());
    await P.waitForFunction(() => window.__oc.game.mode === 'build' && window.__oc.player, null, { timeout: 30000 });
    ok(true, 'Go in the travel panel takes you to the build island');
    await P.evaluate(() => window.__oc.leaveToHaven()); await waitWild(P);
    // through the build portal and back: out in front of it, not sent straight back to the build island
    await P.evaluate(() => { const o = window.__oc, pt = o.world().portals.find((p) => p.kind === 'build'); Object.assign(o.player, { x: pt.x, y: pt.y, ry: pt.y, z: pt.z + 0.3, vx: 0, vz: 0 }); });
    await P.waitForFunction(() => window.__oc.game.mode === 'build' && window.__oc.player, null, { timeout: 30000 });
    await P.waitForTimeout(1800);                                    // the portal can take you again by now
    await P.evaluate(() => window.__oc.leaveToHaven()); await waitWild(P); await P.waitForTimeout(2500);
    const back = await P.evaluate(() => { const o = window.__oc, pt = o.world().portals.find((p) => p.kind === 'build'); return { mode: o.game.mode, dz: o.player.z - pt.z }; });
    ok(back.mode === 'wild' && back.dz > 2, `back from the build island you stay in Haven, in front of its portal (${back.mode}, ${back.dz.toFixed(1)} blocks out)`);
    await P.evaluate(() => window.__oc.openPanel('travel')); await P.waitForTimeout(500);
    await P.evaluate(() => document.querySelector('[data-act="tn-new"]').click());
    await P.waitForFunction(() => window.__oc.game.mode === 'surv' && window.__oc.player, null, { timeout: 30000 });
    ok(true, 'New run in the travel panel starts Ten Nights');
    const tn = await P.evaluate(() => { const o = window.__oc, x0 = o.profile.xp; o.svEnd('win'); return { won: o.profile.stats.tnWins, xp: o.profile.xp - x0 }; });
    ok(tn.won === 1 && tn.xp >= 150, `winning Ten Nights goes on your career (+${tn.xp} XP)`);
    await P.waitForTimeout(800);
    await P.click('#toMenu'); await waitWild(P);
    ok(true, 'Back to Haven from its end screen');
    ok(!A.errors.length, `no errors on your own${A.errors.length ? ':\n' + A.errors.slice(0, 6).join('\n') : ''}`);

    if (!quick) {
      // --- two players in the Wilds ---------------------------------------------------------------------------------
      const B = await openPage(browser, 'Bo');
      const Q = B.page;
      await Promise.all([daytime(P), daytime(Q)]);
      await P.waitForFunction(() => window.__oc.net.players.size === 1, null, { timeout: 20000 });
      await Q.waitForFunction(() => window.__oc.net.players.size === 1, null, { timeout: 20000 });
      ok(true, 'Ana and Bo see each other in Haven');
      await P.evaluate(() => { window.__oc.doEmote('wave'); window.__oc.doChat(0); });
      await Q.waitForFunction(() => { const e = [...window.__oc.net.players.values()][0]; return e?.emote?.id === 'wave'; }, null, { timeout: 10000 });
      ok(await Q.evaluate(() => !!document.querySelector('#bubbles .bubble')), 'Ana waves and says hi, and Bo sees it');
      // live edits
      const at = await outside(P, 4);
      await outside(Q, 2);
      await P.waitForTimeout(800);
      await P.evaluate((a) => { const o = window.__oc; o.breakBlock(o.player, a[0], a[1] - 1, a[2] + 2); }, at);
      await Q.waitForFunction((a) => window.__oc.getB(a[0], a[1] - 1, a[2] + 2) === 0 || window.__oc.getB(a[0], a[1] - 1, a[2] + 2) === window.__oc.B.WATER, at, { timeout: 10000 });
      ok(true, 'a block Ana breaks out in the Wilds is gone on Bo\'s screen too');
      // fights: a newcomer can't be hurt; then they can
      const hit = async () => {
        await P.evaluate(() => { const o = window.__oc, b = [...o.net.players.values()][0]; o.player.atkCd = 0; o.hurt(b, 5, o.player, { kx: 0, kz: 0, ky: 0 }); });
        await P.waitForTimeout(800);
        return Q.evaluate(() => window.__oc.player.hp);
      };
      await Q.evaluate(() => { const o = window.__oc; o.player.hp = 20; o.wild.fresh = 120; o.wild.freshGone = false; o.publishWild(true); });
      await P.waitForTimeout(600);
      ok(await hit() === 20, 'a newcomer (Bo, in his first minutes) can\'t be hurt by other players');
      await Q.evaluate(() => { const o = window.__oc; o.wild.fresh = 0; o.wild.freshGone = true; o.publishWild(true); });
      await P.waitForTimeout(600);
      const hp1 = await hit();
      ok(hp1 < 20 && await Q.evaluate(() => window.__oc.wild.tag > 0), `out in the Wilds Ana's blow hurts Bo (${hp1} hearts left) and starts a fight`);
      // in Haven: no
      await Q.evaluate(() => { const o = window.__oc, w = o.world(); o.player.hp = 20; o.wild.tag = 0; Object.assign(o.player, { x: w.haven.x + 3.5, z: w.haven.z + 3.5, y: w.haven.y, ry: w.haven.y }); o.publishWild(true); });
      await P.evaluate(() => { const o = window.__oc, w = o.world(); o.wild.tag = 0; Object.assign(o.player, { x: w.haven.x + 4.5, z: w.haven.z + 3.5, y: w.haven.y, ry: w.haven.y }); });
      await P.waitForTimeout(900);
      ok(await hit() === 20, 'in Haven, nobody can hurt anybody');
      // a fall and a pack taken
      await outside(Q, 6); await outside(P, 6);
      await P.waitForTimeout(800);
      await Q.evaluate(() => { const o = window.__oc; o.wild.inv.fill(null); o.addItem('diamond', 3); o.addItem('sword2', 1); o.publishWild(true); });
      await P.waitForTimeout(800);
      await hit();                                                     // Ana's blow, then Bo falls (to her: she hit him last)
      await Q.evaluate(() => { const o = window.__oc; o.player.lastHit = { name: 'Ana', id: 'p:ana', pid: [...o.net.players.keys()][0], team: 1, at: o.game.time }; o.wildDie(o.player, 'kill'); });
      await P.waitForFunction(() => window.__oc.net.rbags.size === 1, null, { timeout: 10000 });
      ok(true, 'Bo falls, and his pack lies there for Ana to see');
      ok(await P.evaluate(() => window.__oc.profile.stats.pvp === 1), 'Ana gets the credit for defeating Bo');
      await P.evaluate(() => { const o = window.__oc, b = [...o.net.rbags.values()][0]; Object.assign(o.player, { x: b.x, y: b.y, ry: b.y, z: b.z, vx: 0, vz: 0 }); });
      await P.waitForFunction(() => window.__oc.countItem('diamond') >= 3, null, { timeout: 10000 });
      ok(await Q.evaluate(() => window.__oc.wild.bags.length === 0 && window.__oc.countItem('sword2') === 1), 'Ana takes Bo\'s pack (his sword stays his)');
      await Q.waitForFunction(() => !window.__oc.player.dead, null, { timeout: 15000 });
      // monsters: Ana's zombie, seen and fought by Bo
      await daytime(P); await outside(P, 2); await outside(Q, 2);
      await P.waitForTimeout(800);                                // (each sees where the other went)
      await P.evaluate(() => { const o = window.__oc, p = o.player; const z = o.spawnMob('spider', p.x + 3, p.y, p.z + 3); z.hp = z.maxHp = 16; z.ai.target = null; z.ai.think = 999; window.__z = z; o.publishWild(true); });
      // (by day Ana's game has pigs about too: Bo goes for the spider)
      const spider = () => [...window.__oc.net.rmobs.values()].find((e) => e.mob === 'spider');
      await Q.waitForFunction(`!!(${spider})()`, null, { timeout: 10000 });
      ok(true, 'Bo sees the spider Ana\'s game runs');
      await P.waitForFunction(() => { const o = window.__oc, e = [...o.net.players.values()][0]; return e && Math.hypot(e.x - o.player.x, e.z - o.player.z) < 8; }, null, { timeout: 10000 });
      await Q.evaluate(`window.__oc.hurt((${spider})(), 6, window.__oc.player, { kx: 0, kz: 0, ky: 0 })`);
      await P.waitForFunction(() => window.__z.hp < 16, null, { timeout: 10000 });
      ok(true, 'Bo\'s blow lands on Ana\'s spider');
      const mobs0 = await Q.evaluate(() => window.__oc.profile.stats.mobs);
      await Q.evaluate(`window.__oc.hurt((${spider})(), 30, window.__oc.player, { kx: 0, kz: 0, ky: 0 })`);
      await Q.waitForFunction((m0) => window.__oc.profile.stats.mobs > m0, mobs0, { timeout: 10000 });
      ok(true, 'and when Bo finishes it, the kill is his');
      ok(!B.errors.length && !A.errors.length, `no errors with two players${[...A.errors, ...B.errors].length ? ':\n' + [...A.errors, ...B.errors].slice(0, 6).join('\n') : ''}`);
      await Q.context().close();
    }
    await P.context().close();
  }

  // --- a phone, by touch: Haven and the Wilds ---------------------------------------------------------------------------
  const Ph = await openPage(browser, 'phone', device(390, 844));
  const P = Ph.page, f = await fingers(P);
  await daytime(P);
  await f.tap([195, 420]);                                       // a first touch: the game knows it's a phone now
  await P.waitForTimeout(500);
  let bad = await auditControls(P, WILD_CONTROLS);
  ok(!bad.length, `Haven fits a phone held upright, and each of its buttons takes a tap${bad.length ? ' — ' + bad.join(', ') : ''}`);
  const z0 = await P.evaluate(() => window.__oc.player.z);
  await f.drag([90, 640], [90, 540], 300, 2500);
  ok(await P.evaluate((z0) => window.__oc.player.z < z0 - 0.5, z0), 'the left thumb walks');
  await standBy(P, 'wardrobe');
  await P.evaluate((t) => window.__oc.tip(t, 8000), HAVEN_TIP); await P.waitForTimeout(700);
  bad = await auditPops(P);
  ok(!bad.length, `by a keeper, its prompt and a tip stay clear of the thumbs and each other${bad.length ? ' — ' + bad.join(', ') : ''}`);
  await f.tap('#lPrompt');
  ok(await panelNow(P) === 'Wardrobe', 'a tap on the prompt by the Wardrobe keeper opens the Wardrobe');
  bad = await auditPanels(P);
  ok(!bad.length, `every panel, the pack and the Vault fit the phone and their buttons take a tap${bad.length ? ' — ' + bad.join(', ') : ''}`);
  await f.tap('#blocksBtn');
  ok(await P.evaluate(() => document.getElementById('svInv').classList.contains('on')), 'the pack button opens your pack and crafting');
  await f.tap('#svClose');
  await f.tap('#bEmote'); await f.tap('#emoteMenu [data-em="wave"]');
  ok(await P.evaluate(() => window.__oc.player.emote?.id === 'wave'), 'the emote button waves');
  await outside(P); await P.waitForTimeout(1500);
  bad = await auditControls(P, WILD_CONTROLS);
  ok(!bad.length, `out in the Wilds, the controls fit the phone${bad.length ? ' — ' + bad.join(', ') : ''}`);
  await P.evaluate(() => { window.__oc.cam.pitch = -1.2; });
  await f.down('#tBreak'); await P.waitForTimeout(2500); await f.up();
  ok(await P.evaluate(() => window.__oc.profile.stats.mined > 0), 'holding the dig button digs');
  ok(!Ph.errors.length, `no errors on the phone${Ph.errors.length ? ':\n' + Ph.errors.slice(0, 6).join('\n') : ''}`);
  await P.context().close();

  // --- every screen size: Haven, its panels, and the Wilds ----------------------------------------------------------
  const sizes = [['iPhone SE', device(375, 667)], ['small Android', device(360, 740, ANDROID)], ['Pixel 7', device(412, 915, ANDROID)], ['iPhone SE sideways', device(667, 375)],
    ['iPhone 14 sideways', device(844, 390)], ['Pixel 7 sideways', device(915, 412, ANDROID)], ['iPad', device(820, 1180)], ['iPad sideways', device(1180, 820)], ['laptop', { viewport: { width: 1280, height: 720 } }]];
  for (const [name, d] of sizes) {
    const { page: S, errors: se } = await openPage(browser, 'size', d);
    await daytime(S);
    if (d.hasTouch) { const sf = await fingers(S); await sf.tap([d.viewport.width / 2, d.viewport.height * 0.45]); }
    await S.waitForTimeout(400);
    const problems = [...(await auditControls(S, WILD_CONTROLS)).map((x) => 'Haven: ' + x), ...(await auditPanels(S))];
    // by a keeper (its prompt up) with a tip showing; out in the Wilds, its banner and then the lesson about them; dawn
    // after a night out there, which brings a banner and a toast at once
    await standBy(S, 'wardrobe');
    await S.evaluate((t) => window.__oc.tip(t, 60000), HAVEN_TIP); await S.waitForTimeout(700);
    problems.push(...(await auditPops(S)).map((x) => 'by a keeper: ' + x));
    await outside(S);
    const isOn = (id) => document.getElementById(id).classList.contains('on');
    await S.waitForFunction(`(${isOn})('banner') && /^Out here/.test(document.getElementById('tip').textContent)`, null, { timeout: 10000 }).catch(() => problems.push('no banner and lesson on the way out'));
    await S.waitForTimeout(900);
    problems.push(...(await auditPops(S)).map((x) => 'the Wilds, its banner up: ' + x));
    await S.waitForFunction(`!(${isOn})('banner')`, null, { timeout: 10000 }); await S.waitForTimeout(800);
    problems.push(...(await auditPops(S)).map((x) => 'the Wilds, the lesson up: ' + x));
    await S.evaluate(() => window.__oc.nightSurvived()); await S.waitForTimeout(800);
    problems.push(...(await auditPops(S)).map((x) => 'dawn: ' + x));
    const shown = d.hasTouch ? problems : problems.filter((x) => !/ \d+×\d+ px$/.test(x));   // a mouse doesn't need thumb-sized buttons
    ok(!shown.length && !se.length, `${name} (${d.viewport.width}×${d.viewport.height}): everything fits${d.hasTouch ? ' and takes a tap' : ''}${shown.length ? ' — ' + shown.join(', ') : ''}${se.length ? '\n' + se.slice(0, 3).join('\n') : ''}`);
    await S.context().close();
  }

  // --- Safari's engine (WebKit), if it's installed here ----------------------------------------------------------------
  const wk = await webkit.launch().catch(() => null);
  if (!wk) console.log('– WebKit isn’t installed here (npx playwright install webkit): skipped Safari’s engine');
  else {
    const W = await (await wk.newContext({ ...devices['iPhone 14'] })).newPage();
    await routeCdn(W);
    const we = [];
    W.on('pageerror', (e) => we.push(e.message));
    await W.goto(URL + '&nodaily');
    await W.waitForFunction(() => window.__oc?.game.mode === 'wild' && document.getElementById('loading').classList.contains('out'), null, { timeout: 180000 });
    await orbDock(W); await daytime(W);
    await W.tap('canvas', { position: { x: 200, y: 400 } });
    await W.waitForTimeout(600);
    const wbad = await auditControls(W, WILD_CONTROLS);
    await W.tap('#bMenu'); await W.waitForTimeout(400);
    const menu = await W.evaluate(() => document.getElementById('panel').classList.contains('on'));
    ok(!wbad.length && menu && !we.length, `in WebKit on an iPhone: Haven by taps, the menu opens, and every control fits${wbad.length ? ' — ' + wbad.join(', ') : ''}${we.length ? '\n' + we.slice(0, 3).join('\n') : ''}`);
    await wk.close();
  }
} finally {
  await browser.close();
}
console.log(failures ? `\n${failures} failed` : '\nall passed');
process.exit(failures ? 1 : 0);
