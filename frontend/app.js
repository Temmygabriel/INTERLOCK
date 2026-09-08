// app.js — Interlock safety panel (live studionet wiring).
//
// Reads ONLY state the contracts already computed (status, params, audit
// entries, incidents) via the GenLayer wire codec — no judgment logic is
// duplicated client-side. A report signs nothing but an audit-log index; the
// report is judged by real validator consensus, and the panel shows the real
// outcome (false report → rejected; exploit → TRIPPED). studionet does not
// stream individual validator votes mid-flight, so the verdict checklist shows
// only real, verifiable phases — never fabricated chips.

import { read } from "./gen.js";
import { ensureStudionet, sendWrite } from "./tx.js";
import * as ID from "./identity.js";
import { CONFIG } from "./config.js";

// ----------------------------------------------------------------------------
// Target pair (vault + its Interlock guard). Resolved from ./config.js, which
// `node build.mjs` regenerates at deploy time from the Vercel env vars
// INTERLOCK_ADDRESS / VAULT_ADDRESS; the committed config.js defaults are the
// on-chain DEPLOY CARD pair (see PROGRESS.md).
// ----------------------------------------------------------------------------
// Which pair is the LIVE instrument? When a lab pair is configured (CONFIG.lab —
// set from env LAB_INTERLOCK_ADDRESS/LAB_VAULT_ADDRESS at build, or in the
// committed config.js), the instrument is the exploit-lab vault the demo owns and
// can TRIP. Without a lab the instrument is the deploy-card pair — the stable,
// always-running proof that the breaker refuses to trip on demand. Both paths
// below (Watch / Try) drive whichever pair is live, so a real trip is possible
// exactly when a lab is present.
const LAB = CONFIG.lab && CONFIG.lab.interlock && CONFIG.lab.vault ? CONFIG.lab : null;
const INTERLOCK = LAB ? LAB.interlock : CONFIG.interlock;
const VAULT = LAB ? LAB.vault : CONFIG.vault;
const PAIR_NAME = LAB ? "exploit-lab pair (demo vault)" : "deploy-card pair";

const $ = (id) => document.getElementById(id);
const canon = (a) => String(a).toLowerCase();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const pollMs = 8000;
const judgeTimeoutMs = 360_000; // studionet LLM round can take minutes

const big = (v) => (typeof v === "bigint" ? v.toString() : String(v ?? ""));
const num = (v) => Number(v ?? 0);

function fmtTime(v) {
  if (v == null) return "—";
  const s = big(v).replace("T", " ");
  // recorded naive timestamp from the VM — show it as-is (trimmed) to stay honest
  return s.length > 19 ? s.slice(0, 19) : s;
}
function clip(s, n = 160) {
  s = String(s ?? "");
  return s.length > n ? s.slice(0, n) + "…" : s;
}

// ------------------------------------------------------------------ plain
// v2 copy rule (spec §3.3): never offer a raw "audit #N" as an evidence *choice*.
// Every on-chain audit entry is translated into a real date and a plain sentence
// built from fields the contract already returns (op/amount/coverage/time), so a
// visitor picks an entry they can understand. After a verdict the log may still
// reference the entry by number — a locator back into that same dropdown.
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function humanTime(v) {
  if (v == null) return "—";
  const s = big(v).replace("T", " ");
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/);
  if (!m) return (s.length > 19 ? s.slice(0, 19) : s);
  const [, y, mo, d, hh, mi] = m;
  return `${MONTHS[+mo - 1]} ${+d}, ${y} · ${hh}:${mi}`;
}
function opVerb(e) {
  const op = String(e.op ?? "");
  const amt = e.amount != null ? num(e.amount) : 0;
  switch (op) {
    case "deposit": return "someone deposited " + amt + " GEN as collateral";
    case "borrow": return "someone borrowed " + amt + " GEN";
    case "withdraw": return "someone withdrew " + amt + " GEN";
    case "guardian_pause": return "the breaker paused the vault";
    case "governance_resume": return "governance resumed the vault";
    case "guardian_update": return "governance changed the vault's guardian";
    default: {
      // last resort: humanize a snake_case op rather than show raw bytes
      const pretty = op.replace(/_/g, " ");
      return pretty + (amt ? " of " + amt + " GEN" : "");
    }
  }
}
function coverageLine(e) {
  const c = e.coverage != null ? num(e.coverage) : null;
  if (c == null) return "";
  return c >= 100
    ? "The vault is " + c + "% backed — healthy."
    : "The vault is now only " + c + "% backed. This looks risky.";
}
function describeAudit(e) {
  return {
    when: humanTime(e.time),
    head: humanTime(e.time) + " — " + opVerb(e),
    tail: coverageLine(e),
    risky: e.coverage != null && num(e.coverage) < 100,
  };
}
// Human label for an incident effect token, so a verdict line never leaks a raw
// internal enum ("apply_pause") to the visitor.
function effVerb(e) {
  if (e === "apply_pause") return "vault paused";
  if (e === "noop_already_paused") return "already paused";
  if (e === "noop_false_report") return "no action — false report";
  const s = String(e || "").replace(/_/g, " ");
  return s || "no action";
}

// ---------------------------------------------------------------- panel state

const housing = $("housing");
const setState = (s) => housing.dataset.state = s;

let st = null;        // interlock.status
let vp = null;        // vault params
let inFlight = false; // a report is being judged
let watchBusy = false; // the "watch it happen" loop is mid-run (borrow → report → trip)
let lastAuditLen = null;
let lastIncCount = null;
let mmAccount = null;         // connected MetaMask address — DISPLAY ONLY (never signs)

function renderStateWord(word, note, noteBad = false) {
  $("statusWord").textContent = word;
  const n = $("statusNote");
  n.textContent = note;
  n.classList.toggle("bad", noteBad);
}

// Single source of truth for which actions are enabled: a report (instrument or
// the Try card) needs the browser identity, nothing in flight, and a live vault;
// the Watch loop additionally needs a lab pair configured (else it falls back to
// an honest message) and the vault not already paused.
function syncButtons() {
  const id = ID.loadIdentity();
  const paused = !!(vp && vp.paused === true);
  const canReport = !!id && !inFlight && !paused;
  const reportBtn = $("reportBtn");
  if (reportBtn) reportBtn.disabled = !canReport;
  const tryBtn = $("tryRun");
  if (tryBtn) tryBtn.disabled = !canReport;
  const watchBtn = $("watchRun");
  if (watchBtn) watchBtn.disabled = inFlight || watchBusy || paused;
}

// ---------------------------------------------------------------- readouts

async function loadStatus() {
  const [s, v] = await Promise.all([
    read(INTERLOCK, "status"),
    read(VAULT, "params"),
  ]);
  st = s;
  vp = v;
  return { s, v };
}

function fmtAddr(a) { return ID.shortAddr(a); }

function applyReadouts(armed) {
  const cov = num(vp.coverage);
  $("roTarget").textContent = "DemoVault";
  $("roGuard").textContent = "guard " + fmtAddr(vp.guardian) + (armed ? " · armed" : " · NOT ARMED");
  $("roCoverage").textContent = cov + "%";
  $("roCoverage").style.color = cov < 100 ? "var(--tripped)" : "";
  $("roCollat").textContent = "supplied " + num(vp.collateral) + " · debt " + num(vp.debt) + " (GEN)";
  $("covFill").style.width = Math.max(0, Math.min(100, (cov / 2))) + "%"; // 200%+ = full
  $("roCovSub").textContent = cov < 100 ? "UNSAFE — below 100%" : "solvency threshold 100%";
  $("covFill").parentElement.classList.toggle("low", cov < 100);
  $("roLast").textContent = fmtTime(st.last_check_time || st.last_trip_at);
  $("roReports").textContent = "#" + num(st.report_count);
  $("roIncidents").textContent = "#" + num(st.incident_count);
  $("roBond").textContent = num(st.min_bond) + " GEN";
  $("fBond").textContent = num(st.min_bond) + " GEN";
  $("fSigner").textContent = activeSignerLabel();
}

function renderIncidents() {
  const list = $("incidentLog");
  const count = num(st.incident_count);
  list.innerHTML = "";
  if (!count) {
    list.innerHTML = '<li class="log-empty">— no incidents —</li>';
    return;
  }
  const start = Math.max(0, count - 12); // newest 12, oldest first in DOM
  // read the tail in parallel, then append in chronological order
  Promise.all(
    Array.from({ length: count - start }, (_, k) =>
      read(INTERLOCK, "get_incident", [start + k]).catch(() => null))
  ).then((incs) => {
    for (const inc of incs) {
      if (!inc || inc.found === false) continue;
      const li = document.createElement("li");
      li.className = "log-row";
      const isTrip = inc.kind === "TRIPPED";
      li.innerHTML =
        '<span class="l-num">#' + num(inc.report) + "</span>" +
        '<span class="l-tag">op ' + num(inc.op_index) + "</span>" +
        '<span class="l-kind ' + (isTrip ? "tripped" : "rejected") + '">' +
        (isTrip ? "TRIPPED" : "FALSE-REPORT") + "</span>" +
        '<span class="l-effect">' + (isTrip ? clip(inc.reason, 90) : "false report — rejected") + "</span>" +
        '<span class="l-time">' + fmtTime(inc.time) + "</span>";
      list.appendChild(li);
    }
  }).catch(() => {});
}

function rebuildAuditSelect(preserve) {
  const sel = $("fIndex");
  const trySel = $("tryIndex");
  const alen = num(vp.audit_len);
  const cur = preserve != null ? preserve : sel.value;
  sel.innerHTML = "";
  $("fIndexOf").textContent = "of " + alen + " on-chain entries";
  sel.disabled = alen === 0;
  if (trySel) { trySel.innerHTML = ""; trySel.disabled = alen === 0; }
  if (!alen) { $("evidencePreview").hidden = true; syncButtons(); return; }
  // render plain-language options: read every entry, describe it in a sentence.
  // (The demo vault keeps a short log; parallel reads are fine here.) The
  // instrument dropdown and the Try-card dropdown always show the same entries.
  function addOption(select, i) {
    const o = document.createElement("option");
    o.value = String(i);
    o.textContent = "loading entry " + (i + 1) + "…";
    select.appendChild(o);
  }
  for (let i = 0; i < alen; i++) {
    addOption(sel, i);
    if (trySel) addOption(trySel, i);
  }
  Promise.all(
    Array.from({ length: alen }, (_, i) =>
      read(VAULT, "get_audit_entry", [i]).catch(() => null))
  ).then((entries) => {
    let riskyDefault = null;
    entries.forEach((e, i) => {
      if (!e || e.found === false) return; // leave "unreadable" placeholder on a failed read
      const d = describeAudit(e);
      const label = clip(d.head + (d.tail ? " · " + d.tail : ""), 150);
      const o = sel.querySelector('option[value="' + i + '"]');
      if (o) o.textContent = label;
      if (trySel) { const t = trySel.querySelector('option[value="' + i + '"]'); if (t) t.textContent = label; }
      if (d.risky) riskyDefault = i; // default to the newest risky-looking entry
    });
    if (cur != null && Number(cur) < alen) {
      sel.value = String(cur);
    } else if (riskyDefault != null) {
      sel.value = String(riskyDefault);
    } else {
      sel.value = String(alen - 1); // newest
    }
    if (trySel) trySel.value = String(riskyDefault != null ? riskyDefault : Math.max(0, alen - 1));
    syncButtons();
    refreshEvidence();
  });
}

async function refreshEvidence() {
  const idx = Number($("fIndex").value ?? 0);
  try {
    const e = await read(VAULT, "get_audit_entry", [idx]);
    const box = $("evidencePreview");
    if (!e || e.found === false) { box.hidden = true; return; }
    box.hidden = false;
    const d = describeAudit(e);
    const risky = d.risky;
    const rows = $("evRows");
    rows.innerHTML =
      '<strong style="color:' + (risky ? "var(--danger)" : "var(--ink)") + '">' + d.head + "</strong>" +
      (d.tail ? "<br>" + d.tail : "") +
      '<br><span class="ro-sub">entry ' + num(e.seq ?? idx) + " on the vault audit log · coverage " + num(e.coverage) + "%</span>";
  } catch { $("evidencePreview").hidden = true; }
}

// ---------------------------------------------------------------- verdict

function verdictTrip(inc) {
  setState("tripped");
  renderStateWord("TRIPPED",
    "Exploit confirmed by validator consensus · vault paused · resume is governance-only");
  const v = $("verdict");
  v.hidden = false;
  v.className = "verdict trip mono";
  const cov = inc.coverage_after != null && inc.coverage_after >= 0 ? " · coverage " + num(inc.coverage_after) + "% after" : "";
  v.innerHTML =
    '<span class="big">EXPLOIT CONFIRMED — VAULT PAUSED</span>' +
    '<span class="det">audit entry #' + num(inc.op_index) + " · " + effVerb(inc.effect) +
    cov + " · " + fmtTime(inc.time) + "</span>";
}

function verdictReject(inc) {
  setState("running");
  renderStateWord("RUNNING",
    "Judgment complete — the reported entry is healthy. The breaker will not trip on demand.");
  const v = $("verdict");
  v.hidden = false;
  v.className = "verdict reject mono";
  v.innerHTML =
    '<span class="big">FALSE REPORT — REJECTED</span>' +
    '<span class="det">audit entry #' + num(inc.op_index) + " was ruled healthy · bond forfeited · reason: " +
    clip(inc.reason, 140) + "</span>";
}

function verdictFail(msg) {
  const wasTripped = vp && vp.paused === true;
  setState(wasTripped ? "tripped" : "running");
  renderStateWord(wasTripped ? "TRIPPED" : "RUNNING", wasTripped
    ? "Exploit confirmed — vault paused."
    : "A report did not settle (see below). The breaker is still running — nothing tripped.");
  const v = $("verdict");
  v.hidden = false;
  v.className = "verdict reject mono";
  v.innerHTML = '<span class="big">REPORT DID NOT SETTLE</span><span class="det">' + clip(msg, 300) + "</span>";
}

// checklist (real phases only)
function setPhase(el, state, t) {
  el.className = "chk " + state;
  const tick = el.querySelector(".tick");
  const txt = el.querySelector(".chk-t");
  tick.textContent = state === "done" ? "✓" : state === "now" ? "…" : "";
  if (t != null) txt.textContent = t;
}

async function submitReport(idxParam) {
  if (inFlight) return null;
  let id = ID.loadIdentity();
  if (!id) { ID.createIdentity(); renderIdentity(); id = ID.loadIdentity(); }
  // The browser identity is the sole report signer (MetaMask is display-only).
  // idxParam is the audit entry to report (the Try card passes its own choice);
  // when omitted, the instrument dropdown (#fIndex) is used.
  const idx = idxParam != null ? Number(idxParam) : Number($("fIndex").value ?? 0);
  const bond = BigInt(num(st.min_bond));

  inFlight = true;
  syncButtons();
  $("reportMsg").textContent = "";
  $("verdict").hidden = true;
  setState("checking");
  renderStateWord("CHECKING", "Judging audit entry #" + idx + " — real validator LLM round in progress…");
  $("evidencePreview").hidden = false;

  const cl = $("checklist");
  cl.hidden = false;
  cl.innerHTML =
    '<div class="chk"><span class="tick"></span><span>Pinned read — evidence entry #' + idx + '</span><span class="chk-t"></span></div>' +
    '<div class="chk"><span class="tick"></span><span>Broadcast report + bond</span><span class="chk-t"></span></div>' +
    '<div class="chk"><span class="tick"></span><span>Validator consensus — awaiting verdict</span><span class="chk-t"></span></div>';
  const [p1, p2, p3] = cl.querySelectorAll(".chk");

  const reporter = id.address;
  const before = num(st.report_count);

  // 1 · pinned read — same on-chain view the guard pins; verify the index exists
  setPhase(p1, "now");
  let entryOk = false;
  try {
    const e = await read(VAULT, "get_audit_entry", [idx]);
    entryOk = !!(e && e.found !== false);
  } catch { entryOk = false; }
  await sleep(300);
  setPhase(p1, "done", entryOk ? "verified" : "read failed");

  // 2 · sign + broadcast — the browser identity signs offline (never leaves this
  // machine) and raw-broadcasts. studionet is gasless with virtual value, so a
  // 0-balance key settles a bonded report.
  setPhase(p2, "now");
  let txId = null;
  const t0 = Date.now();
  try {
    const wallet = ID.signer();
    txId = await sendWrite(wallet, INTERLOCK, "report_exploit", [idx], { value: bond });
    setPhase(p2, "done", "tx " + ID.shortAddr(txId) + " · submitted");
  } catch (e) {
    setPhase(p2, "", "failed");
    inFlight = false;
    syncButtons();
    verdictFail("broadcast failed: " + (e?.message ?? e));
    return "failed";
  }

  // 3 · wait for the report to land (report_count increments) or vault to pause
  setPhase(p3, "now", "0s");
  const deadline = Date.now() + judgeTimeoutMs;
  let finished = null;
  while (Date.now() < deadline) {
    await sleep(pollMs);
    try {
      const s = await read(INTERLOCK, "status");
      const vnow = await read(VAULT, "params");
      st = s; vp = vnow;
      applyReadouts(canon(vnow.guardian) === canon(INTERLOCK));
      const elapsed = Math.round((Date.now() - t0) / 1000);
      setPhase(p3, "now", elapsed + "s");
      if (num(s.report_count) > before || vnow.paused === true) {
        finished = { s, vnow };
        break;
      }
    } catch { /* studionet drops connections — retry */ }
  }
  if (!finished) {
    inFlight = false;
    syncButtons();
    setPhase(p3, "", "timeout");
    verdictFail("no verdict after " + Math.round(judgeTimeoutMs / 1000) + "s — the round may still finalize; the readouts above are live.");
    return "failed";
  }

  // resolve — find the incident OUR report produced (match reporter address)
  setPhase(p3, "done", "verdict in");
  await sleep(400);
  let ourInc = null;
  const count = num(finished.s.incident_count);
  try {
    for (let i = 0; i < count; i++) {
      const inc = await read(INTERLOCK, "get_incident", [i]);
      if (!inc || inc.found === false) continue;
      const rep = await read(INTERLOCK, "get_report", [num(inc.report) - 1]).catch(() => null);
      if (rep && canon(rep.reporter) === canon(reporter) && rep.op_index === idx) { ourInc = inc; break; }
    }
  } catch { ourInc = null; }
  if (!ourInc) { ourInc = { kind: finished.vnow.paused ? "TRIPPED" : "FALSE_REPORT_REJECTED", op_index: idx, effect: "", reason: "", time: st.last_check_time }; }

  inFlight = false;
  let outcome;
  if (ourInc.kind === "TRIPPED") {
    outcome = "tripped";
    verdictTrip(ourInc);
    const rb = await read(INTERLOCK, "refundable_of", [canon(reporter)]).catch(() => 0n);
    $("reportMsg").textContent = "Honest report — your bond (" + num(st.min_bond) + " GEN) is escrowed and refundable (" + big(rb) + " escrowed).";
    $("reportMsg").className = "report-msg good";
  } else {
    outcome = "rejected";
    verdictReject(ourInc);
    $("reportMsg").textContent = "Bond forfeited and locked in the breaker — a false report has no refund path. This is proof the breaker cannot be tripped on demand.";
    $("reportMsg").className = "report-msg";
  }
  syncButtons();
  await refreshEverything();
  return outcome;
}

// ---------------------------------------------------------------- identity

function activeSignerLabel() {
  const id = ID.loadIdentity();
  return id ? ID.shortAddr(id.address) : "—";
}

// v2 §3.4 — the honesty notice is dynamic, never a static claim. The browser
// identity signs every report; MetaMask (if connected) is DISPLAY ONLY — a report
// carries a GEN bond as `value`, and studionet has no faucet to fund a MetaMask
// wallet, so MetaMask is never asked to sign.
function signerSentence() {
  const id = ID.loadIdentity();
  if (!id) return "Every report is signed by the browser identity above. Create it below.";
  let s = "Every report is signed by your browser identity (" + ID.shortAddr(id.address) +
    ") — it never leaves this browser.";
  if (mmAccount) s += " MetaMask (" + ID.shortAddr(mmAccount) + ") is connected for display only and never signs.";
  return s;
}

// MetaMask is display-only, so the browser identity is always the report signer
// and the signer row never switches.
function syncSignerUI() {
  $("selBrowser").checked = true;
  $("signerLine").textContent = signerSentence();
}

function renderIdentity() {
  const id = ID.loadIdentity();
  const has = !!id;
  const active = activeSignerLabel();
  $("idChip").classList.toggle("has-id", has);
  $("idDot").classList.toggle("has-id", has);
  $("popDot").classList.toggle("has-id", has);
  $("idAddr").textContent = has ? active : (mmAccount ? ID.shortAddr(mmAccount) + " · display" : "no signer");
  $("popAddr").textContent = has ? ID.checksum(id.address) : (mmAccount ? ID.checksum(mmAccount) : "—");
  $("popKey").textContent = has ? "••••" + id.key.slice(-4) : "—";
  $("revealKey").hidden = !has;
  $("copyKey").hidden = !has;
  $("copyAddr").hidden = !has && !mmAccount;
  $("idCreate").hidden = has;
  $("idRegen").hidden = !has;
  $("idClear").hidden = !has;
  $("fSigner").textContent = active;
  syncSignerUI();
  syncButtons(); // report/try/watch enablement (browser identity is the only signer)
}

async function copyText(s) {
  try { await navigator.clipboard.writeText(s); return true; }
  catch {
    const ta = document.createElement("textarea");
    ta.value = s; document.body.appendChild(ta); ta.select();
    let ok = false;
    try { ok = document.execCommand("copy"); } catch { ok = false; }
    ta.remove(); return ok;
  }
}
const flash = (btn, txt, ms = 900) => { const o = btn.textContent; btn.textContent = txt; setTimeout(() => btn.textContent = o, ms); };

function closePop() { $("idPop").hidden = true; $("idChip").setAttribute("aria-expanded", "false"); }

function wireIdentity() {
  const pop = $("idPop");
  const chip = $("idChip");
  chip.addEventListener("click", (e) => {
    e.stopPropagation();
    const will = pop.hidden;
    pop.hidden = !will;
    chip.setAttribute("aria-expanded", String(will));
  });
  document.addEventListener("click", (e) => {
    if (!pop.hidden && !pop.contains(e.target) && e.target !== chip) closePop();
  });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closePop(); });

  $("copyAddr").addEventListener("click", async () => {
    const id = ID.loadIdentity(); if (!id) return;
    await copyText(ID.checksum(id.address)); flash($("copyAddr"), "COPIED");
  });
  $("copyKey").addEventListener("click", async () => {
    const id = ID.loadIdentity(); if (!id) return;
    await copyText(id.key); flash($("copyKey"), "COPIED");
  });
  let revealed = false;
  $("revealKey").addEventListener("click", () => {
    const id = ID.loadIdentity(); if (!id) return;
    revealed = !revealed;
    $("popKey").textContent = revealed ? id.key : "••••" + id.key.slice(-4);
    $("revealKey").textContent = revealed ? "HIDE" : "SHOW";
  });

  $("idCreate").addEventListener("click", () => { ID.createIdentity(); renderIdentity(); closePop(); });
  $("idRegen").addEventListener("click", () => {
    if (confirm("Generate a NEW identity? The current address will stop being your signer.")) {
      ID.createIdentity(); renderIdentity();
      $("reportMsg").textContent = "New identity active: " + ID.shortAddr(ID.loadIdentity().address);
      $("reportMsg").className = "report-msg good";
    }
  });
  $("idClear").addEventListener("click", () => {
    if (confirm("Remove the browser identity? This panel will create a fresh one on next use.")) {
      ID.clearIdentity(); renderIdentity();
    }
  });
  $("idImport").addEventListener("click", () => { $("importBox").hidden = !$("importBox").hidden; });
  $("importCancel").addEventListener("click", () => { $("importBox").hidden = true; $("importMsg").textContent = ""; });
  $("importApply").addEventListener("click", () => {
    const r = ID.importIdentity($("importKey").value);
    if (r.ok) {
      $("importBox").hidden = true; $("importMsg").textContent = "";
      $("importKey").value = ""; renderIdentity();
      $("reportMsg").textContent = "Imported identity: " + ID.shortAddr(r.id.address);
      $("reportMsg").className = "report-msg good";
    } else {
      $("importMsg").textContent = r.error;
    }
  });

  // MetaMask — DISPLAY ONLY (Aegis pattern): connecting shows the wallet address
  // but never signs. A report is a payable write that carries a GEN bond as
  // `value`; studionet has no faucet for arbitrary wallets, so MetaMask's own
  // balance check would refuse the transfer. The browser identity is the sole
  // report signer. studionet (chain 61999 = 0xF22F, gasless) is still added on
  // connect so the wallet displays the right network.
  const mm = typeof window.ethereum !== "undefined" && window.ethereum;
  const mmAddrEl = $("mmAddr"), mmNote = $("mmNote"), mmBtn = $("mmConnect");

  function updateMMNote() {
    if (!mm) {
      mmNote.textContent = "No MetaMask wallet detected — optional and display-only. Your browser identity signs every report.";
    } else if (!mmAccount) {
      mmNote.textContent = "Connect to show your wallet address (display only). It never signs — reports are signed by the browser identity, and studionet has no faucet to fund a wallet for the report bond.";
    } else {
      mmNote.textContent = "Connected for display only — this wallet is never asked to sign. Reports are signed by the browser identity above.";
    }
  }

  if (!mm) {
    mmBtn.disabled = true;
    updateMMNote();
    return;
  }
  mmBtn.addEventListener("click", async () => {
    mmBtn.disabled = true;
    try {
      const accs = await mm.request({ method: "eth_requestAccounts" });
      const a = accs?.[0];
      if (!a) throw new Error("no account returned");
      await ensureStudionet(mm).catch(() => {}); // best-effort: wallet shows studionet for display
      mmAccount = String(a).toLowerCase();
      mmAddrEl.textContent = ID.shortAddr(mmAccount) + " · " + ID.checksum(mmAccount).slice(0, 8) + "…";
      mmAddrEl.classList.add("on");
      mmBtn.textContent = "CONNECTED";
      mmBtn.disabled = true;
      renderIdentity();
      updateMMNote();
    } catch (e) {
      mmBtn.disabled = false;
      mmNote.textContent = "Connection declined: " + (e?.message ?? e).slice(0, 80);
    }
  });
}

// ---------------------------------------------------------------- poll loop

let busy = false;
async function tick() {
  if (busy) return;
  busy = true;
  try {
    const s = await read(INTERLOCK, "status");
    const v = await read(VAULT, "params");
    st = s; vp = v;
    const armed = canon(v.guardian) === canon(INTERLOCK);
    applyReadouts(armed);
    $("netline").textContent = "studionet · chain 61999 · " + PAIR_NAME + " · interlock " + INTERLOCK + " · vault " + VAULT;

    if (inFlight) {
      // during judgment only the numbers refresh; the resolver drives the state
      return;
    }
    // only touch derived views when they actually changed (studionet round-trips)
    const alen = num(vp.audit_len);
    const icnt = num(st.incident_count);
    if (alen !== lastAuditLen) { rebuildAuditSelect(null); lastAuditLen = alen; }
    if (icnt !== lastIncCount) { renderIncidents(); lastIncCount = icnt; }

    if (v.paused === true || s.tripped === true) {
      setState("tripped");
      syncButtons(); // paused — nothing more to report until governance resumes
      renderStateWord("TRIPPED",
        "Exploit confirmed by validator consensus · vault paused · resume is governance-only");
      const last = await read(INTERLOCK, "get_incident", [num(s.incident_count) - 1]).catch(() => null);
      if (last && last.kind === "TRIPPED") {
        $("reportMsg").textContent = "Confirmed at audit entry #" + num(last.op_index) + " · " + effVerb(last.effect) + " · " + fmtTime(last.time);
        $("reportMsg").className = "report-msg good";
      }
    } else if (s.last_check_time) {
      setState("running");
      renderStateWord("RUNNING",
        armed
          ? "Breaker armed · a bonded report on any audit entry goes to a consensus judgment"
          : "Vault live, but this Interlock is NOT its guardian — the breaker is not installed");
    } else {
      setState("running");
      renderStateWord("RUNNING", "Breaker armed · no checks yet · waiting for a report");
    }
  } catch (e) {
    $("netline").textContent = "studionet · chain 61999 · network error — retrying… (" + clip(e?.message ?? e, 60) + ")";
  } finally {
    busy = false;
  }
}

async function refreshEverything() {
  try {
    const s = await read(INTERLOCK, "status");
    const v = await read(VAULT, "params");
    st = s; vp = v;
    applyReadouts(canon(v.guardian) === canon(INTERLOCK));
    rebuildAuditSelect($("fIndex").value);
    lastAuditLen = num(vp.audit_len);
    renderIncidents();
    lastIncCount = num(st.incident_count);
  } catch { /* background — next tick handles it */ }
}

$("fIndex").addEventListener("change", refreshEvidence);
$("reportBtn").addEventListener("click", () => submitReport());

// Path B — "Try it yourself". The Try card's own dropdown + report button drive
// the exact same real machinery as the instrument form; the phases and verdict
// render on the instrument (scrolled into view) so both paths stay visibly the
// same product underneath.
$("tryRun").addEventListener("click", async () => {
  const st = $("tryStatus");
  const sel = $("tryIndex");
  if (!sel || sel.disabled) return;
  const idx = Number(sel.value);
  if (inFlight || watchBusy || !ID.loadIdentity() || (vp && vp.paused === true) || Number.isNaN(idx)) return;
  st.textContent = "Reporting entry " + (idx + 1) + " — live phases appear on the instrument below…";
  $("fIndex").value = String(idx); // keep the pinned-read preview aligned
  refreshEvidence();
  $("housing").scrollIntoView({ behavior: "smooth", block: "center" });
  const out = await submitReport(idx);
  if (out === "tripped") st.textContent = "✓ EXPLOIT CONFIRMED — vault paused. Validator consensus just tripped the breaker.";
  else if (out === "rejected") st.textContent = "Ruled healthy — rejected, bond forfeited. It refuses to trip on demand.";
  else if (out === "failed") st.textContent = "The report did not settle cleanly — see the verdict on the instrument.";
  else st.textContent = "Nothing to report right now — check the identity chip and vault state.";
});

// Path A — "Watch it happen". With an exploit-lab pair configured (CONFIG.lab)
// one click pushes a REAL risky borrow into the demo vault (a transaction signed
// by the browser identity), reports the new entry, and shows the breaker trip on
// real validator consensus — no further clicks, matching the card's promise.
// Without a lab it stays honest: there is nothing risky on-chain to trip, so it
// points you at the live healthy vault instead.
async function watchDemo() {
  const s = $("watchStatus");
  if (watchBusy || inFlight) return;
  if (!LAB) {
    s.textContent = "No exploit-lab vault is configured, so a live round here would only report a healthy entry — real consensus, and it would REFUSE to trip. Drive a report yourself in the Try card below.";
    return;
  }
  let id = ID.loadIdentity();
  if (!id) { ID.createIdentity(); renderIdentity(); id = ID.loadIdentity(); }
  if (vp && vp.paused === true) {
    s.textContent = "The demo vault is already paused by a confirmed trip. Redeploy the exploit-lab pair for another run.";
    return;
  }

  watchBusy = true;
  syncButtons();
  s.className = "demo-status";
  try {
    let p = (vp && vp.audit_len != null && vp.paused === false) ? vp : await read(VAULT, "params").catch(() => null);
    if (!p || p.paused === true) { s.textContent = "The demo vault is not in a reportable state — refresh and try again."; return; }

    let idx;
    if (num(p.coverage) >= 100) {
      // 1 · push a borrow large enough to under-collateralize the vault. borrow is
      // permissionless on the demo vault (that absence of a health check IS the
      // exploit), and studionet settles writes from a 0-balance key.
      const len0 = num(p.audit_len);
      const amount = num(p.collateral); // new debt = debt + collateral > collateral ⇒ coverage < 100%
      s.textContent = "Step 1/3 — pushing a risky " + amount + " GEN borrow into the demo vault (real transaction, signed by your browser identity)…";
      let tx;
      try {
        tx = await sendWrite(ID.signer(), VAULT, "borrow", [amount], { value: 0 });
      } catch (e) {
        s.textContent = "The risky borrow failed to broadcast: " + clip(e?.message ?? e, 90);
        return;
      }
      s.textContent = "Step 1/3 — borrow broadcast (tx " + ID.shortAddr(tx) + "). Waiting for it to land on-chain…";
      const deadline = Date.now() + judgeTimeoutMs;
      idx = null;
      while (Date.now() < deadline) {
        await sleep(pollMs);
        try {
          const pn = await read(VAULT, "params");
          vp = pn;
          applyReadouts(canon(pn.guardian) === canon(INTERLOCK));
          if (num(pn.audit_len) > len0 && num(pn.coverage) < 100) { idx = num(pn.audit_len) - 1; break; }
        } catch { /* studionet drops connections — retry */ }
      }
      if (idx == null) {
        s.textContent = "The borrow never settled on-chain (timeout). The breaker is still running — nothing tripped.";
        return;
      }
      s.textContent = "Step 2/3 — the borrow landed: the demo vault is now only " + num(vp.coverage) + "% backed. Reporting it to the breaker…";
    } else {
      // already under 100% (left risky from an earlier run) — report the newest entry
      idx = num(p.audit_len) - 1;
      s.textContent = "Step 2/3 — the demo vault is already under 100% backed (entry " + (idx + 1) + "). Reporting it to the breaker…";
    }

    // 2 · report through the same real machinery (renders the live checklist and
    // verdict on the instrument). Keep the pinned-read preview aligned.
    $("fIndex").value = String(idx);
    refreshEvidence();
    const out = await submitReport(idx);
    if (out === "tripped") {
      s.textContent = "✓ TRIPPED. Validator consensus confirmed the under-collateralized borrow and paused the demo vault. The lab is spent — redeploy for the next run.";
    } else if (out === "rejected") {
      s.textContent = "The breaker ruled this borrow healthy and refused to trip (bond forfeited). The demo vault is still live.";
    } else {
      s.textContent = "The report did not settle cleanly — see the verdict on the instrument.";
    }
  } finally {
    watchBusy = false;
    syncButtons();
  }
}
$("watchRun").addEventListener("click", watchDemo);

(async function init() {
  wireIdentity();
  if (!ID.loadIdentity()) { ID.createIdentity(); } // frictionless default signer
  renderIdentity();

  $("reportMsg").textContent = "Contacting studionet…";
  setState("running");
  renderStateWord("RUNNING", "connecting to studionet…");

  let connected = false;
  for (let i = 0; i < 5 && !connected; i++) {
    try {
      const s = await read(INTERLOCK, "status");
      const v = await read(VAULT, "params");
      if (s && v) connected = true;
    } catch { await sleep(1200); }
  }
  if (!connected) {
    setState("offline");
    renderStateWord("OFFLINE", "cannot reach studionet — confirm the page is served over HTTPS and the RPC is up");
    $("netline").textContent = "studionet · chain 61999 · unreachable — retrying";
    setInterval(tick, pollMs);
    return;
  }
  $("reportMsg").textContent = "";       // clear the connecting placeholder
  $("reportMsg").className = "report-msg";
  await tick();
  setInterval(tick, pollMs);
})();
