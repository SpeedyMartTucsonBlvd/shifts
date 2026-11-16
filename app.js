/* Speedy Mart Shift App */
"use strict";
const CFG = window.SHIFT_APP_CONFIG || {};
const API = CFG.apiUrl || "";
const $ = s => document.querySelector(s);
const $$ = s => Array.from(document.querySelectorAll(s));
const n = v => { const x = parseFloat(v); return isNaN(x) ? 0 : x; };
const r2 = v => Math.round(v * 100) / 100;
const money = v => (v < -0.004 ? "−" : "") + "$" + Math.abs(v).toFixed(2);
const signed = v => (v > 0.004 ? "+" : "") + money(v);
const pad3 = t => String(t).padStart(3, "0");
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : "id-" + Date.now() + "-" + Math.random().toString(16).slice(2));
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} },
  del(k) { try { localStorage.removeItem(k); } catch (e) {} }
};

// ---------- Fixed lists ----------
const COINS = [["pennies", "Pennies", 0.01, 50], ["nickels", "Nickels", 0.05, 40], ["dimes", "Dimes", 0.10, 50], ["quarters", "Quarters", 0.25, 40]];
const BILLS = [["ones", "Ones", 1], ["fives", "Fives", 5], ["tens", "Tens", 10], ["twenties", "Twenties", 20]];
const AMOUNTS = [["mixed", "$2 bills / half dollars / dollar coins"], ["big", "$50 / $100 bills"]];
const SAFE = [["r5", "Row 5 ($1)", "bundles of 20 × $1", 20], ["r7", "Row 7 ($5)", "bundles of 10 × $5", 50], ["r8", "Row 8 ($20)", "bundles of 3 × $20", 60]];
const POS_FIELDS = [["expected", "Expected cash in drawer"], ["posScratch", "Scratcher sales"], ["posDraw", "Lotto / draw game sales"], ["posPayout", "Lottery payouts"], ["drops", "Cash drops (total)"]];
const SHIFT_LOTTO = [["loaded", "Tickets loaded"]];
const EOD_LOTTO = [["begInv", "Beginning scratcher inventory"], ["endInv", "Ending scratcher inventory"], ["termDraw", "Draw game gross sales"], ["cashes", "Draw game cashes"], ["validations", "Scratcher validations"]];
const reportFields = () => POS_FIELDS.concat(SHIFT_LOTTO, D && D.last ? EOD_LOTTO : []);
const PRICES = [1, 2, 3, 5, 10, 20, 30, 50];
const STEPS = ["Count", "Lottery", "Reports", "Photos", "Review"];

// ---------- State ----------
let B = store.get("sm_boot", null);       // data from the sheet
let U = null;                              // signed-in person {name, pin, role, verified}
let S = { screen: "home", step: 0, shift: 1, date: null, name: "" };
let D = null;                              // the shift being closed or opened
let online = navigator.onLine;

function newCounts() {
  const c = {}; COINS.forEach(([k]) => { c[k + "_r"] = ""; c[k + "_l"] = ""; });
  BILLS.forEach(([k]) => c[k] = ""); AMOUNTS.forEach(([k]) => c[k] = ""); SAFE.forEach(([k]) => c[k] = "");
  return c;
}
function newDraft(kind) {
  return { kind, id: uuid(), counts: newCounts(), slots: {}, newGames: {}, reports: {}, photos: { pos: null, lotto: null, extra: [] }, last: false, note: "" };
}
const coinVal = (c, k) => { const [, , v, per] = COINS.find(x => x[0] === k); return (n(c[k + "_r"]) * per + n(c[k + "_l"])) * v; };
const regTotal = c => r2(COINS.reduce((a, [k]) => a + coinVal(c, k), 0) + BILLS.reduce((a, [k, , v]) => a + n(c[k]) * v, 0) + AMOUNTS.reduce((a, [k]) => a + n(c[k]), 0));
const safeTotal = c => r2(SAFE.reduce((a, [k, , , m]) => a + n(c[k]) * m, 0));

// ---------- Dates ----------
function businessDate() {
  const h = B ? Number(B.dayStartHour) || 0 : 4;
  const d = new Date(Date.now() - h * 3600000);
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
}
function niceDate(k) { const [y, m, d] = k.split("-").map(Number); return new Date(y, m - 1, d).toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" }); }

// ---------- Talking to the sheet ----------
async function apiGet() {
  const res = await fetch(API + "?action=bootstrap", { redirect: "follow" });
  return res.json();
}
async function apiPost(body) {
  const res = await fetch(API, { method: "POST", redirect: "follow", headers: { "Content-Type": "text/plain;charset=utf-8" }, body: JSON.stringify(body) });
  return res.json();
}
async function refresh() {
  if (!API || /PASTE_/.test(API)) return;
  try { const b = await apiGet(); if (b && b.ok) { B = b; store.set("sm_boot", b); online = true; } }
  catch (e) { online = false; }
}

// Outbox: anything sent is saved on the device first, then sent. Survives no-signal and app restarts.
const DB = {
  db: null,
  open() {
    if (this.db) return Promise.resolve(this.db);
    return new Promise((ok, no) => {
      const r = indexedDB.open("sm-shifts", 1);
      r.onupgradeneeded = () => r.result.createObjectStore("outbox", { keyPath: "id" });
      r.onsuccess = () => { this.db = r.result; ok(this.db); };
      r.onerror = () => no(r.error);
    });
  },
  async tx(mode, fn) { const db = await this.open(); return new Promise((ok, no) => { const t = db.transaction("outbox", mode); const s = t.objectStore("outbox"); const out = fn(s); t.oncomplete = () => ok(out && out.result !== undefined ? out.result : out); t.onerror = () => no(t.error); }); },
  put(item) { return this.tx("readwrite", s => s.put(item)); },
  del(id) { return this.tx("readwrite", s => s.delete(id)); },
  all() { return this.tx("readonly", s => s.getAll()); }
};
let flushing = false;
async function flush() {
  if (flushing || !API || /PASTE_/.test(API)) return [];
  flushing = true; const results = [];
  try {
    const items = (await DB.all()).sort((a, b) => a.created - b.created);
    for (const it of items) {
      if (it.state === "held") continue;
      let res;
      try { res = await apiPost(it.body); online = true; }
      catch (e) { online = false; break; }
      if (res.ok) { await DB.del(it.id); results.push({ id: it.id, res }); }
      else { it.state = "held"; it.error = res.error || "The sheet didn't accept this."; it.res = res; await DB.put(it); results.push({ id: it.id, res }); }
    }
  } finally { flushing = false; await updateSync(); }
  return results;
}
async function updateSync() {
  let items = [];
  try { items = await DB.all(); } catch (e) {}
  const el = $("#sync");
  const held = items.filter(i => i.state === "held").length, waiting = items.length - held;
  if (!items.length && online) { el.hidden = true; return; }
  el.hidden = false;
  el.textContent = held ? held + " needs attention" : waiting ? waiting + " waiting to send" : "Offline";
  el.style.background = held ? "var(--bad-soft)" : ""; el.style.color = held ? "var(--bad)" : "";
}
window.addEventListener("online", () => { online = true; flush().then(refresh).then(render); });
window.addEventListener("offline", () => { online = false; updateSync(); });
setInterval(() => { flush(); }, 60000);

// ---------- Rendering ----------
function setBar(t, s, back) { $("#barTitle").textContent = t; $("#barSub").textContent = s; $("#backBtn").hidden = !back; }
function stepsBar() {
  const el = $("#steps");
  if (S.screen !== "close") { el.hidden = true; return; }
  el.hidden = false; el.innerHTML = STEPS.map((_, i) => `<span class="${i <= S.step ? "on" : ""}"></span>`).join("");
}
function render() {
  const sc = $("#screen"); stepsBar();
  const fn = SCREENS[S.screen] || SCREENS.home;
  sc.innerHTML = fn();
  (BINDS[S.screen] || (() => {}))();
  bindCommon();
}
let tt;
function toast(msg, ms) {
  let t = $(".toast"); if (!t) { t = document.createElement("div"); t.className = "toast"; t.setAttribute("role", "status"); document.body.appendChild(t); }
  t.textContent = msg; clearTimeout(tt); tt = setTimeout(() => t.remove(), ms || 4200);
}
function nav(nextLabel, nextDisabled) {
  return `<div class="btnrow"><button class="btn ghost" type="button" id="prev">Back</button><button class="btn" type="button" id="next" ${nextDisabled ? "disabled" : ""}>${nextLabel || "Next"}</button></div>`;
}
function bindCommon() {
  const p = $("#prev"); if (p) p.onclick = goBack;
  const nx = $("#next"); if (nx && S.screen === "close") nx.onclick = () => { S.step++; saveDraft(); render(); window.scrollTo(0, 0); };
  $$("input.amt").forEach(inp => inp.oninput = () => onAmt(inp));
}
function goBack() {
  if (S.screen === "close" && S.step > 0) { S.step--; render(); window.scrollTo(0, 0); return; }
  S.screen = "home"; render();
}
$("#backBtn").onclick = goBack;

const SCREENS = {}, BINDS = {};

// ---------- Home ----------
SCREENS.home = () => {
  setBar(B ? B.store : "Speedy Mart", "Shift app", false);
  if (!API || /PASTE_/.test(API)) return `<h2>Almost ready</h2><p class="hint">This app isn't connected to your Google Sheet yet. Open <b>config.js</b> and paste the web app URL from the setup guide.</p>`;
  if (!B) return `<h2>Can't reach the sheet</h2><p class="hint">Check the internet connection, then try again.</p><button class="btn" id="retry">Try again</button>`;
  S.date = S.date || businessDate();
  const staff = B.staff || [];
  const me = staff.find(s => s.name === S.name);
  const firstTime = me && !me.hasPin;
  const isToday = S.date === B.today;
  const doneShifts = isToday ? (B.todayShifts || []) : [];
  const opened = isToday ? (B.todayOpens || []) : [];
  const rows = [1, 2, 3].map(i => {
    const d = doneShifts.find(x => x.shift === i);
    const o = opened.find(x => x.shift === i);
    return `<div class="li"><span>Shift ${i}${d ? " · " + esc(d.cashier) : ""}</span>${d ? `<span class="pill ${Math.abs(d.total) > (B.limit || 6) ? "bad" : "good"}">Sent ${esc(d.at)} · ${signed(d.total)}${d.last ? " · last" : ""}</span>` : o ? `<span class="pill info">Opening counted</span>` : `<span class="pill warn">Not sent</span>`}</div>`;
  }).join("");
  return `<h2>Hi! Who's working?</h2>
  <div class="field"><label for="who">Name</label><select id="who"><option value="">Pick your name</option>${staff.map(s => `<option ${s.name === S.name ? "selected" : ""}>${esc(s.name)}</option>`).join("")}</select></div>
  <div class="field"><label for="pin">${firstTime ? "Pick a 4-digit PIN" : "PIN"}</label><input class="pin" id="pin" type="password" inputmode="numeric" pattern="[0-9]*" maxlength="4" autocomplete="off">
    ${firstTime ? `<p class="hint">First time signing in. Choose 4 digits you'll remember. You'll use them every shift.</p>` : ""}</div>
  <div class="field"><label>Shift</label><div class="seg" id="seg">${[1, 2, 3].map(i => `<button type="button" aria-pressed="${i === S.shift}" data-s="${i}">Shift ${i}</button>`).join("")}</div></div>
  <div class="field"><label>${niceDate(S.date)}${isToday ? " · today" : ""} <button class="link" id="chDate" type="button">change</button></label>
    <input type="date" id="dateIn" value="${S.date}" hidden>
    <div class="card">${rows}</div></div>
  <p class="hint bad" id="homeErr" hidden></p>
  <div class="stack" style="margin-top:auto">
    <button class="btn ghost" id="goOpen" type="button">Count my opening drawer (optional)</button>
    <button class="btn" id="goClose" type="button">Close my shift</button>
    ${me && /owner/i.test(me.role) ? `<button class="chip" id="goDrops" type="button">Count safe drops (owners)</button>` : ""}
    <button class="chip" id="goTest" type="button">Test the scanner</button>
    <button class="chip" id="goOutbox" type="button" hidden>Unsent shifts</button>
  </div>`;
};
BINDS.home = () => {
  const r = $("#retry"); if (r) r.onclick = async () => { await refresh(); render(); };
  if (!B) return;
  $("#who").onchange = e => { S.name = e.target.value; render(); };
  $$("#seg button").forEach(b => b.onclick = () => { S.shift = +b.dataset.s; $$("#seg button").forEach(x => x.setAttribute("aria-pressed", x === b)); });
  $("#chDate").onclick = () => { $("#dateIn").hidden = false; $("#dateIn").focus(); };
  $("#dateIn").onchange = e => { if (e.target.value) { S.date = e.target.value; render(); } };
  const go = (screen) => async () => {
    const ok = await signIn(); if (!ok) return;
    if (screen === "close") startClose();
    else if (screen === "open") { D = newDraft("open"); S.screen = "open"; render(); }
    else if (screen === "drops") { S.screen = "drops"; render(); loadDrops(); }
  };
  $("#goClose").onclick = go("close"); $("#goOpen").onclick = go("open");
  const gd = $("#goDrops"); if (gd) gd.onclick = go("drops");
  $("#goTest").onclick = () => { S.screen = "test"; render(); };
  DB.all().then(items => { const b = $("#goOutbox"); if (b && items.length) { b.hidden = false; b.textContent = `Unsent shifts (${items.length})`; b.onclick = () => { S.screen = "outbox"; render(); }; } }).catch(() => {});
};
async function signIn() {
  const err = $("#homeErr"); err.hidden = true;
  const pin = $("#pin").value.trim();
  if (!S.name) { err.textContent = "Pick your name first."; err.hidden = false; return false; }
  if (!/^\d{4}$/.test(pin)) { err.textContent = "Enter your 4-digit PIN."; err.hidden = false; return false; }
  const me = (B.staff || []).find(s => s.name === S.name) || {};
  try {
    const res = await apiPost({ action: "login", name: S.name, pin });
    if (!res.ok) { err.textContent = res.error || "That didn't work. Try again."; err.hidden = false; return false; }
    U = { name: S.name, pin, role: res.role, verified: true, lastClose: res.lastClose || null };
    if (res.firstTime) { toast("PIN saved. Use it every time you sign in."); refresh(); }
  } catch (e) {
    online = false;
    if (!me.hasPin) { err.textContent = "You need internet the first time you sign in, to set your PIN."; err.hidden = false; return false; }
    U = { name: S.name, pin, role: me.role, verified: false };
    toast("No internet. You can keep going; your PIN is checked when it sends.");
  }
  return true;
}
function signOut() { U = null; D = null; S.step = 0; S.screen = "home"; }

// ---------- Drafts (so a refresh doesn't lose a half-done close; photos aren't kept) ----------
function saveDraft() { if (D && D.kind === "close" && U) store.set("sm_draft_" + U.name, { D: { ...D, photos: { pos: null, lotto: null, extra: [] } }, S: { shift: S.shift, date: S.date, step: S.step }, at: Date.now() }); }
function startClose() {
  const saved = store.get("sm_draft_" + U.name, null);
  if (saved && Date.now() - saved.at < 12 * 3600000 && saved.S.shift === S.shift && saved.S.date === S.date) {
    D = saved.D; S.step = saved.S.step; toast("Picked up where you left off. Retake any photos.");
  } else { D = newDraft("close"); S.step = 0; }
  S.screen = "close"; render();
}

// ---------- Counting ----------
function countBlock(c) {
  return `<div class="group"><h3><span>Coins</span><span>rolls · loose</span></h3>
  ${COINS.map(([k, l, , per]) => `<div class="row coin"><div class="lbl">${l}<small>roll = ${per}</small></div>
    <input class="amt" id="c-${k}_r" inputmode="numeric" value="${esc(c[k + "_r"])}" placeholder="0" aria-label="${l} rolls">
    <input class="amt" id="c-${k}_l" inputmode="numeric" value="${esc(c[k + "_l"])}" placeholder="0" aria-label="${l} loose">
    <div class="val num" id="v-${k}">${money(coinVal(c, k))}</div></div>`).join("")}</div>
  <div class="group"><h3><span>Bills</span><span># of bills</span></h3>
  ${BILLS.map(([k, l, v]) => `<div class="row"><div class="lbl">${l}</div><input class="amt" id="c-${k}" inputmode="numeric" value="${esc(c[k])}" placeholder="0" aria-label="${l} count"><div class="val num" id="v-${k}">${money(n(c[k]) * v)}</div></div>`).join("")}
  ${AMOUNTS.map(([k, l]) => `<div class="row"><div class="lbl">${l}<small>$ amount</small></div><input class="amt" id="c-${k}" inputmode="decimal" value="${esc(c[k])}" placeholder="0.00" aria-label="${l} dollar amount"><div class="val num" id="v-${k}">${money(n(c[k]))}</div></div>`).join("")}
  <div class="total"><span>Register total</span><span class="num" id="regT">${money(regTotal(c))}</span></div></div>
  <div class="group"><h3><span>Safe</span><span># of bundles</span></h3>
  ${SAFE.map(([k, l, h, m]) => `<div class="row"><div class="lbl">${l}<small>${h}</small></div><input class="amt" id="c-${k}" inputmode="numeric" value="${esc(c[k])}" placeholder="0" aria-label="${l} bundles"><div class="val num" id="v-${k}">${money(n(c[k]) * m)}</div></div>`).join("")}
  <div class="total"><span>Safe total</span><span class="num" id="safeT">${money(safeTotal(c))}</span></div></div>`;
}
function onAmt(inp) {
  const [g, k] = inp.id.split("-");
  if (g === "c" && D) {
    D.counts[k] = inp.value;
    const base = k.replace(/_[rl]$/, ""), c = D.counts;
    const coin = COINS.find(x => x[0] === base), bill = BILLS.find(x => x[0] === base), safe = SAFE.find(x => x[0] === base);
    const v = coin ? coinVal(c, base) : bill ? n(c[base]) * bill[2] : safe ? n(c[base]) * safe[3] : n(c[base]);
    const el = $("#v-" + base); if (el) el.textContent = money(v);
    $("#regT").textContent = money(regTotal(c)); $("#safeT").textContent = money(safeTotal(c));
    if (S.screen === "open") $("#cmp").innerHTML = openCompare();
  }
  if (g === "r" && D) D.reports[k] = inp.value;
  saveDraft();
}

// ---------- Opening count ----------
function openCompare() {
  const lc = U && U.lastClose;
  if (!lc) return `<div><span>${U && !U.verified ? "No internet, so this can't be compared with the last close right now. It will still be saved." : "No earlier close to compare with yet."}</span></div>`;
  const dr = regTotal(D.counts) - lc.register, ds = safeTotal(D.counts) - lc.safe;
  const row = (l, v, last) => `<div><span>${l}<br><span class="hint">${esc(lc.cashier)} closed with ${money(last)}</span></span><span class="pill ${Math.abs(v) < 0.005 ? "good" : "bad"}">${Math.abs(v) < 0.005 ? "Matches" : signed(v)}</span></div>`;
  return row("Register vs last close", dr, lc.register) + row("Safe vs last close", ds, lc.safe);
}
SCREENS.open = () => {
  setBar(`Open Shift ${S.shift}`, `${U.name} · optional`, true);
  return `<h2>Opening count</h2><p class="hint">Optional. Count when it's quiet. The app checks your count against the last close.</p>
  ${countBlock(D.counts)}<div class="sum" id="cmp">${openCompare()}</div>
  <div class="btnrow"><button class="btn ghost" type="button" id="prev">Back</button><button class="btn" type="button" id="saveOpen">Save opening count</button></div>`;
};
BINDS.open = () => {
  $("#saveOpen").onclick = async () => {
    const body = { action: "open", id: D.id, name: U.name, pin: U.pin, date: S.date, shift: S.shift,
      registerTotal: regTotal(D.counts), safeTotal: safeTotal(D.counts), counts: D.counts };
    await DB.put({ id: D.id, kind: "open", created: Date.now(), body, label: `Opening count · Shift ${S.shift} · ${U.name}` });
    $("#saveOpen").disabled = true; $("#saveOpen").textContent = "Sending…";
    const res = (await flush()).find(x => x.id === D.id);
    signOut(); await refresh(); render();
    if (!res) toast("Saved on this device. It will send when the internet is back.");
    else if (res.res.ok) toast("Opening count saved." + (res.res.registerDiff !== "" && res.res.registerDiff !== undefined && Math.abs(res.res.registerDiff) > 0.004 ? ` Register is ${signed(res.res.registerDiff)} vs last close.` : " Matches last close."));
    else toast(res.res.error || "The sheet didn't accept it.");
  };
};

// ---------- Close: step 1 count ----------
function stepCount() {
  return `<h2>Count the drawer</h2><p class="hint">Count coins by roll and loose, bills by number. Totals add up as you type.</p>${countBlock(D.counts)}${nav()}`;
}

// ---------- Close: step 2 lottery ----------
function gameInfo(g) {
  if (!g) return null;
  const k = String(g);
  if (B.games && B.games[k]) return { price: B.games[k].price, per: B.games[k].per || B.packSizes[B.games[k].price] };
  if (D && D.newGames[k]) return { price: D.newGames[k], per: B.packSizes[D.newGames[k]] };
  return null;
}
function slotCalc(st) {
  const d = D.slots[st.slot];
  if (!d || d.end === null || d.end === undefined || d.end === "" || !(d.game || st.game) || !(d.pack || st.pack)) return { state: "todo" };
  const gEnd = gameInfo(d.game || st.game);
  if (!gEnd) return { state: "price" };
  if (st.ticket === null || !st.pack) return { state: "first", d };
  const gOld = gameInfo(st.game) || gEnd;
  const isNew = (d.pack || st.pack) !== st.pack;
  let sold, dollars;
  if (isNew) { const left = Math.max(0, (gOld.per || 0) - st.ticket); sold = left + d.end; dollars = left * gOld.price + d.end * gEnd.price; }
  else { sold = d.end - st.ticket; dollars = sold * gEnd.price; }
  return { state: sold < 0 ? "backwards" : "ok", sold, dollars: r2(dollars), isNew, d, price: gEnd.price };
}
function lotteryDollars() { return r2((B.slots || []).reduce((a, st) => { const c = slotCalc(st); return a + (c.state === "ok" ? c.dollars : 0); }, 0)); }
function stepLottery() {
  const slots = B.slots || [];
  const done = slots.filter(st => ["ok", "first"].includes(slotCalc(st).state)).length;
  return `<h2>Scan the scratchers</h2>
  <p class="hint">For each slot, tap <b>Scan</b> and take a photo of the long barcode on the back of the next ticket. If it won't read, tap <b>Type it</b>.</p>
  <div class="group"><h3><span>Slots</span><span>${done} of ${slots.length} done</span></h3><div class="slots">
  ${slots.map(st => {
    const c = slotCalc(st), d = D.slots[st.slot] || {}, g = gameInfo(d.game || st.game);
    const priceTag = g ? "$" + g.price : "";
    let main, meta = `Game ${esc(d.game || st.game || "?")} · Pack ${esc(d.pack || st.pack || "?")}`;
    if (c.state === "todo") main = st.ticket === null ? "No starting number yet" : `Was showing ${pad3(st.ticket)}`;
    else if (c.state === "first") main = `Starting number ${pad3(d.end)} saved`;
    else if (c.state === "price") main = `New game ${esc(d.game)}. What's the ticket price?`;
    else if (c.state === "backwards") main = `${pad3(st.ticket)} → ${pad3(d.end)}: number went down`;
    else main = `${pad3(st.ticket)} → ${pad3(d.end)} · ${c.sold} sold · ${money(c.dollars)}`;
    const pills = (c.isNew ? `<span class="pill info">New pack</span>` : "") + (c.state === "backwards" ? `<span class="pill bad">Rescan</span>` : "") + (c.state === "first" ? `<span class="pill info">First count</span>` : "");
    const extra = c.state === "price" ? `<div class="extra">${PRICES.map(p => `<button type="button" class="chip pr" data-n="${st.slot}" data-p="${p}">$${p}</button>`).join("")}</div>`
      : d.manual ? `<div class="extra">${st.game ? "" : `<input class="tgm" data-n="${st.slot}" inputmode="numeric" maxlength="4" placeholder="Game #" aria-label="Slot ${st.slot} game number" value="${esc(d.game || "")}">`}
          <input class="tix" data-n="${st.slot}" inputmode="numeric" maxlength="3" placeholder="Ticket # showing" aria-label="Slot ${st.slot} ticket number" value="${d.end ?? ""}">
          <input class="tpk" data-n="${st.slot}" inputmode="numeric" placeholder="${st.pack ? "Pack # (if new)" : "Pack #"}" aria-label="Slot ${st.slot} pack number" value="${d.pack && d.pack !== st.pack ? esc(d.pack) : ""}"></div>` : "";
    const doneBtn = ["ok", "first"].includes(c.state);
    return `<div class="slot"><div class="no">${st.slot}<small>${priceTag}</small></div>
      <div style="min-width:0"><div class="main">${main}</div><div class="meta">${meta} ${pills}</div></div>
      <div class="stack" style="gap:6px"><button type="button" class="chip scan ${doneBtn ? "done" : ""}" data-n="${st.slot}">${doneBtn ? "✓ " + pad3(d.end) : "Scan"}</button>
      ${d.manual ? "" : `<button type="button" class="link type" data-n="${st.slot}" style="font-size:13px">Type it</button>`}</div>${extra}</div>`;
  }).join("")}</div>
  <div class="total"><span>Scratcher sales scanned</span><span class="num">${money(lotteryDollars())}</span></div></div>
  ${done < slots.length ? `<p class="hint warn">${slots.length - done} slot${slots.length - done > 1 ? "s" : ""} not done. Unscanned slots count toward the next shift instead.</p>` : ""}
  ${nav()}`;
}
function bindLottery() {
  $$(".scan").forEach(b => b.onclick = () => pickBarcode(+b.dataset.n));
  $$(".type").forEach(b => b.onclick = () => { const k = +b.dataset.n; D.slots[k] = { ...(D.slots[k] || {}), manual: true }; render(); const i = $(`.tix[data-n="${k}"]`); if (i) i.focus(); });
  $$(".tix").forEach(i => i.onchange = () => {
    const k = +i.dataset.n, st = B.slots.find(s => s.slot === k), d = D.slots[k] || {};
    d.end = i.value === "" ? null : parseInt(i.value, 10); d.game = d.game || st.game; d.pack = d.pack || st.pack; D.slots[k] = d; saveDraft(); render();
  });
  $$(".tgm").forEach(i => i.onchange = () => {
    const k = +i.dataset.n, d = D.slots[k] || {}, v = i.value.replace(/\D/g, "");
    d.game = v ? v.padStart(4, "0") : ""; D.slots[k] = d; saveDraft(); render();
  });
  $$(".tpk").forEach(i => i.onchange = () => {
    const k = +i.dataset.n, st = B.slots.find(s => s.slot === k), d = D.slots[k] || {};
    d.pack = i.value.replace(/\D/g, "") ? i.value.replace(/\D/g, "").padStart(6, "0") : st.pack; d.game = d.game || st.game; D.slots[k] = d; saveDraft(); render();
  });
  $$(".pr").forEach(b => b.onclick = () => { const k = +b.dataset.n, d = D.slots[k]; D.newGames[d.game] = +b.dataset.p; saveDraft(); render(); });
}

// ---------- Barcode reading ----------
let pending = null;
const cam = $("#camIn");
function pickBarcode(slot) { pending = slot; cam.value = ""; cam.click(); }
cam.onchange = async () => {
  const f = cam.files[0]; if (!f) return;
  const slot = pending, btn = slot ? $(`.scan[data-n="${slot}"]`) : $("#testBtn");
  if (btn) { btn.textContent = "Reading…"; btn.classList.add("reading"); }
  const t0 = performance.now(); let res = null, err = "";
  try { res = await readBarcode(f); } catch (e) { err = (e && e.message) || String(e); }
  const ms = Math.round(performance.now() - t0), parsed = res ? parseTicket(res.text) : null;
  if (slot === null || S.screen === "test") { TESTS.unshift({ res, parsed, ms, err, img: URL.createObjectURL(f) }); render(); return; }
  const st = B.slots.find(s => s.slot === slot);
  if (!parsed) { D.slots[slot] = { ...(D.slots[slot] || {}), manual: true }; render(); toast(`Couldn't read slot ${slot}. Try again closer and flatter, or type the ticket number.`); return; }
  D.slots[slot] = { end: parsed.ticket, game: parsed.game, pack: parsed.pack };
  saveDraft(); render();
  if (st.game && parsed.game !== st.game) toast(`Slot ${slot} now has game ${parsed.game} (was ${st.game}). Counted as a new pack.`);
  else if (st.pack && parsed.pack !== st.pack) toast(`Slot ${slot}: new pack ${parsed.pack}. The old pack's leftover tickets count as sold.`);
};
function parseTicket(text) {
  const d = String(text || "").replace(/\D/g, ""); if (d.length < 13) return null;
  return { raw: d, game: d.slice(0, 4), pack: d.slice(4, 10), ticket: parseInt(d.slice(10, 13), 10) };
}
async function loadImg(file) { const img = new Image(); img.src = URL.createObjectURL(file); await img.decode(); return img; }
function canvasFrom(img, max, rot) {
  const sc = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
  const w = Math.round(img.naturalWidth * sc), h = Math.round(img.naturalHeight * sc);
  const c = document.createElement("canvas"); c.width = rot ? h : w; c.height = rot ? w : h;
  const x = c.getContext("2d", { willReadFrequently: true });
  if (rot) { x.translate(h / 2, w / 2); x.rotate(Math.PI / 2); x.drawImage(img, -w / 2, -h / 2, w, h); } else x.drawImage(img, 0, 0, w, h);
  return c;
}
async function readBarcode(file) {
  const img = await loadImg(file), tried = [];
  const good = t => String(t || "").replace(/\D/g, "").length >= 13;
  // 1. The phone's built-in reader (Android Chrome).
  if ("BarcodeDetector" in window) {
    try {
      const det = new BarcodeDetector({ formats: ["itf", "code_128"] });
      const found = (await det.detect(img)).sort((a, b) => b.rawValue.length - a.rawValue.length)[0];
      if (found && good(found.rawValue)) return { text: found.rawValue, format: found.format, engine: "phone" };
      tried.push("phone: none");
    } catch (e) { tried.push("phone: error"); }
  }
  // 2. zxing-cpp (WebAssembly). Strongest reader, works on iPhone.
  if (window.ZXingWASM && window.ZXingWASM.readBarcodes) {
    try {
      const res = await window.ZXingWASM.readBarcodes(file, { formats: ["ITF", "Code128"], tryHarder: true, tryRotate: true, tryInvert: false, tryDownscale: true, maxNumberOfSymbols: 4 });
      const hit = (res || []).filter(r => r.isValid !== false && good(r.text)).sort((a, b) => b.text.length - a.text.length)[0];
      if (hit) return { text: hit.text, format: hit.format, engine: "wasm" };
      tried.push("wasm: " + ((res || []).length ? (res || []).map(r => r.format + ":" + (r.text || "").length).join(",") : "none"));
    } catch (e) { tried.push("wasm: error " + ((e && e.message) || "").slice(0, 40)); }
  } else tried.push("wasm: not loaded");
  // 3. ZXing JavaScript, on the whole photo and on horizontal strips of it.
  if (window.ZXing) {
    const Z = window.ZXing, hints = new Map();
    hints.set(Z.DecodeHintType.POSSIBLE_FORMATS, [Z.BarcodeFormat.ITF, Z.BarcodeFormat.CODE_128]);
    hints.set(Z.DecodeHintType.TRY_HARDER, true);
    const reader = new Z.MultiFormatReader(); reader.setHints(hints);
    const attempt = (c) => {
      const data = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
      const lum = new Uint8ClampedArray(c.width * c.height);
      for (let i = 0, j = 0; i < lum.length; i++, j += 4) lum[i] = (data[j] * 306 + data[j + 1] * 601 + data[j + 2] * 117) >> 10;
      const src = new Z.RGBLuminanceSource(lum, c.width, c.height);
      for (const Bin of [Z.HybridBinarizer, Z.GlobalHistogramBinarizer]) {
        try { const r = reader.decode(new Z.BinaryBitmap(new Bin(src)), hints); if (good(r.getText())) return r; } catch (e) {}
      }
      return null;
    };
    for (const [max, rot] of [[2000, false], [2000, true], [1200, false], [1200, true], [3000, false]]) {
      const full = canvasFrom(img, max, rot);
      let r = attempt(full);
      // Strips: each a third of the height, overlapping, so the ticket's barcode fills more of the picture.
      for (let k = 0; !r && k < 5; k++) {
        const h = Math.round(full.height / 3), y = Math.round(k * full.height / 6);
        const strip = document.createElement("canvas"); strip.width = full.width; strip.height = Math.min(h, full.height - y);
        strip.getContext("2d", { willReadFrequently: true }).drawImage(full, 0, y, full.width, strip.height, 0, 0, full.width, strip.height);
        r = attempt(strip);
      }
      if (r) return { text: r.getText(), format: Z.BarcodeFormat[r.getBarcodeFormat()], engine: "js" };
    }
    tried.push("js: none");
  } else tried.push("js: not loaded");
  throw new Error("No barcode found (" + tried.join("; ") + ")");
}

// ---------- Close: step 3 reports ----------
function stepReports() {
  const np = (B.slots || []).map(slotCalc).filter(c => c.isNew).length;
  return `<h2>Numbers from the printouts</h2><p class="hint">Copy these from the POS shift report and the lottery machine's report. You'll take photos of both next.</p>
  ${[["POS shift report", POS_FIELDS], ["Lottery machine report", SHIFT_LOTTO]].map(([h, fs]) => fieldGroup(h, fs)).join("")}
  <label class="check"><input type="checkbox" id="lastR" ${D.last ? "checked" : ""}><span><b>Last shift of the day</b><br><span class="hint">Check this if you're closing out the day. You'll add the end-of-day lottery numbers.</span></span></label>
  ${D.last ? fieldGroup("Lottery report · end of day", EOD_LOTTO) : ""}
  <p class="hint">${np ? `You scanned ${np} new pack${np > 1 ? "s" : ""} this shift. Tickets loaded should include ${np > 1 ? "them" : "it"}.` : "No new packs scanned this shift."}</p>
  ${nav()}`;
}

function fieldGroup(h, fs) {
  return `<div class="group"><h3><span>${h}</span></h3>${fs.map(([k, l]) => `<div class="row two"><div class="lbl">${l}</div><input class="amt" id="r-${k}" inputmode="decimal" value="${esc(D.reports[k] ?? "")}" placeholder="0.00" aria-label="${l}"></div>`).join("")}</div>`;
}
function bindReports() { $("#lastR").onchange = e => { D.last = e.target.checked; saveDraft(); render(); }; }

// ---------- Close: step 4 photos ----------
const PH = $("#photoIn"); let photoTarget = null;
const camIcon = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/></svg>`;
function stepPhotos() {
  const tile = (k, l) => D.photos[k] ? `<button type="button" class="shot has" data-k="${k}"><img src="${D.photos[k]}" alt=""><span class="ok">✓ ${l} · tap to retake</span></button>`
    : `<button type="button" class="shot" data-k="${k}">${camIcon}${l}</button>`;
  return `<h2>Snap the paperwork</h2><p class="hint">Tap a box to take a photo. They're saved to the shift photos folder in Google Drive.</p>
  <div class="shots">${tile("pos", "POS shift report")}${tile("lotto", "Lottery machine report")}
  <button type="button" class="shot wide" data-k="extra">${camIcon}Anything else (optional), like scratcher activation slips</button></div>
  ${D.photos.extra.length ? `<div class="thumbs">${D.photos.extra.map(src => `<img src="${src}" alt="Extra photo">`).join("")}</div><button class="link" id="clrExtra" type="button">Remove the extra photos</button>` : ""}
  <p class="hint">The POS report and lottery report photos are required.</p>
  ${nav()}`;
}
function bindPhotos() {
  $$(".shot").forEach(b => b.onclick = () => { photoTarget = b.dataset.k; PH.value = ""; PH.click(); });
  const c = $("#clrExtra"); if (c) c.onclick = () => { D.photos.extra = []; render(); };
}
PH.onchange = async () => {
  const f = PH.files[0]; if (!f || !D) return;
  const data = await shrink(f);
  if (photoTarget === "extra") D.photos.extra.push(data); else D.photos[photoTarget] = data;
  render();
};
async function shrink(file) {
  const img = await loadImg(file), max = 1600, sc = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
  const c = document.createElement("canvas"); c.width = Math.round(img.naturalWidth * sc); c.height = Math.round(img.naturalHeight * sc);
  c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
  return c.toDataURL("image/jpeg", 0.72);
}

// ---------- Close: step 5 review ----------
function calc() {
  const r = D.reports, lot = lotteryDollars();
  const others = S.date === B.today ? (B.todayShifts || []).filter(x => x.shift !== S.shift) : [];
  const sum = k => others.reduce((a, x) => a + (Number(x[k]) || 0), 0);
  const lines = [
    ["Scratchers (POS − scanned)", r2(n(r.posScratch) - lot)],
    ["Register (counted − expected)", r2(regTotal(D.counts) - n(r.expected))]
  ];
  let inv = null;
  if (D.last) {
    // Draw games, payouts and inventory come from the lottery report once a day, so they're checked for the whole day.
    lines.push(["Draw games (day's POS − lottery report)", r2(n(r.posDraw) + sum("posDraw") - n(r.termDraw))]);
    lines.push(["Payouts (lottery report − day's POS)", r2(n(r.cashes) + n(r.validations) - n(r.posPayout) - sum("posPayout"))]);
    inv = r2(n(r.begInv) + n(r.loaded) + sum("loaded") - n(r.endInv) - lot - sum("scanned"));
  }
  const total = r2(lines.reduce((a, l) => a + l[1], 0));
  return { lines, total, day: r2(total + others.reduce((a, x) => a + x.total, 0)), inv, lot };
}
function stepReview() {
  const c = calc(), limit = B.limit || 6, off = Math.abs(c.day) > limit;
  const missing = [!D.photos.pos && "POS report photo", !D.photos.lotto && "lottery report photo"].filter(Boolean);
  const notDone = (B.slots || []).filter(st => !["ok", "first"].includes(slotCalc(st).state)).length;
  const blank = reportFields().filter(([k]) => D.reports[k] === undefined || D.reports[k] === "").map(x => x[1]);
  return `<h2>Check and send</h2>
  <div class="sum">${c.lines.map(([l, v]) => `<div><span>${l}</span><span class="num ${v < -0.004 ? "neg" : v > 0.004 ? "pos" : ""}">${signed(v)}</span></div>`).join("")}
  <div style="font-weight:700"><span>Shift ${S.shift} over / short</span><span class="num">${signed(c.total)}</span></div></div>
  <div class="sum">${c.inv === null ? `<div><span>Draw games, payouts and inventory</span><span class="pill info">Checked at end of day</span></div>` : `<div><span>Cross-check: day's scans vs lottery inventory</span><span class="pill ${Math.abs(c.inv) < 0.01 ? "good" : "warn"}">${Math.abs(c.inv) < 0.01 ? "Match" : "Off " + signed(c.inv)}</span></div>`}
  <div><span>Register / safe counted</span><span class="num">${money(regTotal(D.counts))} / ${money(safeTotal(D.counts))}</span></div></div>
  ${missing.length || notDone || blank.length ? `<div class="verdict info"><b>Before you send</b><span>${[missing.length ? "Missing: " + missing.join(", ") + "." : "", notDone ? notDone + " lottery slot" + (notDone > 1 ? "s" : "") + " not scanned." : "", blank.length ? "Blank: " + blank.join(", ") + "." : ""].filter(Boolean).join(" ")}</span></div>` : ""}
  <label class="check"><input type="checkbox" id="last" ${D.last ? "checked" : ""}><span><b>Last shift of the day</b><br><span class="hint">Closes out ${niceDate(S.date)}. ${D.last ? "End-of-day lottery numbers are on the Reports step." : "Some days that's Shift 2, some days Shift 3."}</span></span></label>
  <div class="verdict ${off ? "flag" : "ok"}"><b>${D.last ? "Day total" : "Day so far"} ${signed(c.day)}</b>
  <span>${off ? `That's more than ${money(limit)}. Recount the drawer and re-scan before sending. If it's still off, add a note.` : `Within ${money(limit)}.`}</span></div>
  <div class="field"><label for="note">Note for the owners (optional)</label><input type="text" id="note" value="${esc(D.note)}" placeholder="e.g. customer paid with a torn $20"></div>
  <div class="btnrow"><button class="btn ghost" type="button" id="prev">Back</button><button class="btn" type="button" id="send">Send shift</button></div>`;
}
function bindReview() {
  $("#last").onchange = e => { D.last = e.target.checked; saveDraft(); render(); };
  $("#note").oninput = e => { D.note = e.target.value; saveDraft(); };
  $("#send").onclick = () => sendClose(false);
}
async function sendClose(correction) {
  const btn = $("#send"); if (btn) { btn.disabled = true; btn.textContent = "Sending…"; }
  const photos = [];
  if (D.photos.pos) photos.push({ label: "POS report", data: D.photos.pos });
  if (D.photos.lotto) photos.push({ label: "Lottery report", data: D.photos.lotto });
  D.photos.extra.forEach((p, i) => photos.push({ label: "Other " + (i + 1), data: p }));
  const slots = (B.slots || []).map(st => { const d = D.slots[st.slot]; return d && d.end !== null && d.end !== undefined && d.end !== "" ? { slot: st.slot, game: d.game || st.game, pack: d.pack || st.pack, end: d.end, price: (gameInfo(d.game || st.game) || {}).price } : null; }).filter(Boolean);
  const reports = {}; reportFields().forEach(([k]) => reports[k] = n(D.reports[k]));
  const body = { action: "close", id: D.id, name: U.name, pin: U.pin, date: S.date, shift: S.shift, last: D.last, correction,
    registerTotal: regTotal(D.counts), safeTotal: safeTotal(D.counts), counts: D.counts, reports, slots,
    newGames: Object.entries(D.newGames).map(([game, price]) => ({ game, price })), note: D.note, photos };
  const local = calc();
  await DB.put({ id: D.id, kind: "close", created: Date.now(), body, label: `Shift ${S.shift} · ${niceDate(S.date)} · ${U.name}` });
  const res = (await flush()).find(x => x.id === D.id);
  if (res && !res.res.ok && res.res.alreadySent) { S.screen = "dupe"; S.dupe = res.res; render(); return; }
  store.del("sm_draft_" + U.name);
  S.result = res ? res.res : null; S.local = local; S.sentAs = { name: U.name, shift: S.shift, date: S.date };
  S.screen = "done"; U = null; render(); refresh().then(() => { if (S.screen === "done") render(); });
}

SCREENS.close = () => {
  setBar(`Close Shift ${S.shift}`, `${U.name} · ${niceDate(S.date)} · Step ${S.step + 1} of 5`, true);
  return [stepCount, stepLottery, stepReports, stepPhotos, stepReview][S.step]();
};
BINDS.close = () => { [null, bindLottery, bindReports, bindPhotos, bindReview][S.step]?.(); };

SCREENS.dupe = () => {
  setBar("Already sent", `Shift ${S.shift} · ${niceDate(S.date)}`, false);
  const d = S.dupe || {};
  return `<h2>Shift ${S.shift} was already sent</h2>
  <p class="hint">${esc(d.by || "Someone")} sent Shift ${S.shift} for ${niceDate(S.date)}${d.at ? " at " + esc(d.at) : ""}. Did you pick the wrong shift, or are you fixing a mistake?</p>
  <div class="stack" style="margin-top:auto">
    <button class="btn" id="asCorr" type="button">Send mine as a correction</button>
    <button class="btn ghost" id="pickShift" type="button">I picked the wrong shift</button></div>`;
};
BINDS.dupe = () => {
  $("#asCorr").onclick = async () => { await DB.del(D.id); D.id = uuid(); S.screen = "close"; S.step = 4; render(); sendClose(true); };
  $("#pickShift").onclick = async () => { await DB.del(D.id); D.id = uuid(); S.screen = "shiftpick"; render(); };
};
SCREENS.shiftpick = () => {
  setBar("Pick your shift", U ? U.name : "", false);
  return `<h2>Which shift are you closing?</h2><div class="seg" id="seg2">${[1, 2, 3].map(i => `<button type="button" aria-pressed="${i === S.shift}" data-s="${i}">Shift ${i}</button>`).join("")}</div>
  <div class="btnrow"><button class="btn ghost" type="button" id="cancelPick">Cancel</button><button class="btn" type="button" id="resend">Send shift</button></div>`;
};
BINDS.shiftpick = () => {
  $$("#seg2 button").forEach(b => b.onclick = () => { S.shift = +b.dataset.s; render(); });
  $("#cancelPick").onclick = () => { S.screen = "close"; S.step = 4; render(); };
  $("#resend").onclick = () => { S.screen = "close"; S.step = 4; render(); sendClose(false); };
};

SCREENS.done = () => {
  setBar("Shift sent", "Thanks!", false);
  const r = S.result, a = S.sentAs || {};
  if (!r) return `<div class="center"><div class="big-ok" style="background:var(--warn-soft);color:var(--warn)">↻</div>
    <h2>Saved on this device</h2><p class="hint">There's no internet right now. Shift ${a.shift} will send by itself when the connection is back. Don't close the shift again.</p></div>
    <button class="btn" id="home" type="button">Done</button>`;
  if (!r.ok) return `<div class="center"><div class="big-ok" style="background:var(--bad-soft);color:var(--bad)">!</div>
    <h2>The sheet didn't accept it</h2><p class="hint">${esc(r.error || "")}</p><p class="hint">It's saved on this device under "Unsent shifts." An owner can retry it from there.</p></div>
    <button class="btn" id="home" type="button">Done</button>`;
  const res = r.result || {};
  const off = res.limit !== undefined && Math.abs(res.dayTotal) > res.limit;
  return `<div class="center"><div class="big-ok" style="background:var(--good-soft);color:var(--good)">✓</div>
    <h2>Shift ${a.shift} sent${r.replaced ? " (correction)" : ""}</h2>
    <p class="hint">Your shift: <b>${signed(res.total || 0)}</b>. Day so far: <b>${signed(res.dayTotal || 0)}</b>${off ? ". That's over the limit, so the owners will see it." : "."}</p>
    <p class="hint">You've been signed out.</p></div>
    <button class="btn" id="home" type="button">Done</button>`;
};
BINDS.done = () => { $("#home").onclick = () => { signOut(); render(); }; };

// ---------- Safe drops (owners) ----------
let DROPS = null;
async function loadDrops() {
  DROPS = null;
  try { const r = await apiPost({ action: "drops", name: U.name, pin: U.pin }); DROPS = r.ok ? r.drops : { error: r.error }; }
  catch (e) { DROPS = { error: "Counting drops needs the internet. Try again when you're connected." }; }
  if (S.screen === "drops") render();
}
SCREENS.drops = () => {
  setBar("Safe drops", "Owners · " + (U ? U.name : ""), true);
  if (!DROPS) return `<h2>Count the safe drops</h2><p class="hint">Loading the last three weeks…</p>`;
  if (DROPS.error) return `<h2>Count the safe drops</h2><p class="hint bad">${esc(DROPS.error)}</p><div style="margin-top:auto"><button class="btn ghost" id="prev" type="button">Back</button></div>`;
  const byDay = {}; DROPS.forEach(x => (byDay[x.date] = byDay[x.date] || []).push(x));
  const days = Object.keys(byDay).sort().reverse();
  return `<h2>Count the safe drops</h2>
  <p class="hint">Count each shift's drop bag on its own and enter it on that shift's line. Saved as soon as you leave the box.</p>
  ${days.length ? days.map(day => {
    const list = byDay[day].sort((a, b) => a.shift - b.shift), counted = list.filter(x => x.counted !== null);
    const diff = r2(counted.reduce((a, x) => a + x.counted - x.pos, 0));
    const head = !counted.length ? "Not counted" : counted.length < list.length ? "Partly counted" : Math.abs(diff) < 0.005 ? "✓ Day matches" : "Day " + signed(diff);
    return `<div class="group"><h3><span>${niceDate(day)}</span><span>${head}</span></h3>
    <div class="colhead" style="grid-template-columns:minmax(0,1fr) 84px 100px"><span></span><span>POS</span><span>Counted</span></div>
    ${list.map(x => { const df = x.counted === null ? null : r2(x.counted - x.pos);
      return `<div class="row"><div class="lbl">Shift ${x.shift} · ${esc(x.cashier)}<small>${df === null ? "Not counted yet" : Math.abs(df) < 0.005 ? "✓ Matches" : `<span class="neg">${signed(df)}</span>`}</small></div>
      <div class="val num">${money(x.pos)}</div><input class="dc" data-id="${esc(x.id)}" inputmode="decimal" value="${x.counted ?? ""}" placeholder="Counted" aria-label="${niceDate(day)} shift ${x.shift} drops counted" style="text-align:right;min-height:42px;padding:8px 10px"></div>`; }).join("")}</div>`;
  }).join("") : `<p class="hint">No drops from the last three weeks yet.</p>`}
  <p class="hint">Any difference is added to that day's over/short.</p>
  <div style="margin-top:auto"><button class="btn ghost" id="prev" type="button">Back</button></div>`;
};
BINDS.drops = () => {
  $$("input.dc").forEach(i => i.onchange = async () => {
    const x = DROPS.find(d => d.id === i.dataset.id); if (!x) return;
    const val = i.value.trim() === "" ? "" : n(i.value);
    try {
      const r = await apiPost({ action: "countDrop", name: U.name, pin: U.pin, shiftId: x.id, counted: val });
      if (!r.ok) { toast(r.error || "Didn't save."); return; }
      x.counted = val === "" ? null : val; render(); toast("Saved.");
    } catch (e) { toast("No internet. That count didn't save."); }
  });
};

// ---------- Unsent shifts ----------
SCREENS.outbox = () => {
  setBar("Unsent shifts", "Saved on this device", true);
  return `<h2>Unsent shifts</h2><p class="hint">These are saved on this device. Ones waiting for internet send by themselves.</p><div id="obList" class="stack"><p class="hint">Loading…</p></div>
  <div class="stack" style="margin-top:auto"><button class="btn" id="obRetry" type="button">Try sending now</button><button class="btn ghost" id="prev" type="button">Back</button></div>`;
};
BINDS.outbox = async () => {
  const items = await DB.all();
  $("#obList").innerHTML = items.length ? items.map(i => `<div class="card"><div class="li"><span><b>${esc(i.label)}</b><br><span class="hint ${i.state === "held" ? "bad" : ""}">${i.state === "held" ? esc(i.error) : "Waiting for internet"}</span></span>
    ${i.state === "held" ? `<span class="stack" style="gap:4px"><button class="chip ob-retry" data-id="${i.id}" type="button">Retry</button><button class="link ob-del" data-id="${i.id}" type="button">Delete</button></span>` : ""}</div></div>`).join("") : `<p class="hint">Nothing waiting. Everything has been sent.</p>`;
  $$(".ob-retry").forEach(b => b.onclick = async () => { const it = items.find(x => x.id === b.dataset.id); it.state = ""; await DB.put(it); await flush(); render(); });
  $$(".ob-del").forEach(b => {
    b.onclick = async () => {
      if (b.dataset.confirm) { await DB.del(b.dataset.id); await updateSync(); render(); }
      else { b.dataset.confirm = "1"; b.textContent = "Tap again to delete"; }
    };
  });
  $("#obRetry").onclick = async () => { for (const it of items) { if (it.state === "held") { it.state = ""; await DB.put(it); } } await flush(); render(); };
};

// ---------- Scanner test ----------
const TESTS = [];
SCREENS.test = () => {
  setBar("Scanner test", "Try it on real tickets", true);
  return `<h2>Scanner test</h2>
  <p class="hint">Take a photo of the long barcode on the back of a ticket. Fill most of the screen with it, keep it flat, and use good light.</p>
  <button class="btn" id="testBtn" type="button">Take a photo of a barcode</button>
  ${TESTS.length ? `<div class="group"><h3><span>Results</span><span>${TESTS.filter(t => t.parsed).length} of ${TESTS.length} read</span></h3>
  ${TESTS.map(t => `<div class="slot" style="grid-template-columns:56px minmax(0,1fr)"><img src="${t.img}" alt="" style="width:56px;height:56px;object-fit:cover;border-radius:8px">
   <div style="min-width:0">${t.parsed ? `<div class="main">Game ${t.parsed.game} · Pack ${t.parsed.pack} · Ticket ${pad3(t.parsed.ticket)}</div>
   <div class="meta" style="word-break:break-all">Raw: ${t.parsed.raw} · ${esc(t.res.format)} · ${esc(t.res.engine || "")} · ${t.ms} ms</div>`
    : `<div class="main neg">Couldn't read it</div><div class="meta" style="word-break:break-all">${t.res ? `Read "${esc(t.res.text)}" but it's too short` : esc(t.err)} · ${t.ms} ms</div>`}</div></div>`).join("")}</div>
  <p class="hint">Check each result against the number printed under the barcode, like 1530-107551-027.</p>` : ""}
  <div style="margin-top:auto"><button class="btn ghost" id="prev" type="button">Back</button></div>`;
};
BINDS.test = () => { $("#testBtn").onclick = () => pickBarcode(null); };

// ---------- Start ----------
(async function start() {
  if ("serviceWorker" in navigator && location.protocol === "https:") navigator.serviceWorker.register("sw.js").catch(() => {});
  render();
  await refresh();
  render();
  await flush();
  await updateSync();
})();
