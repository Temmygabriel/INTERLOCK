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
const INTERLOCK = CONFIG.interlock;
const VAULT = CONFIG.vault;

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
// v2 copy rule (spec §3.3): never show a raw "audit #N" to a visitor. Every
// on-chain audit entry is translated into a real date and a plain sentence
// built from fields the contract already returns (op/amount/coverage/time).
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
    case "set_guardian": return "governance changed the vault's guardian";
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

// ---------------------------------------------------------------- panel state

const housing = $("housing");
const setState = (s) => housing.dataset.state = s;

let st = null;        // interlock.status
let vp = null;        // vault params
let inFlight = false; // a report is being judged
let lastAuditLen = null;
let lastIncCount = null;
let mmSigner = null;          // active MetaMask signer (once connected)
let mmAccount = null;         // connected MetaMask address (canonical lowercase)
let signerMode = "browser";   // "browser" | "metamask" — who signs reports

function renderStateWord(word, note, noteBad = false) {
  $("statusWord").textContent = word;
  const n = $("statusNote");
  n.textContent = note;
  n.classList.toggle("bad", noteBad);
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
  const alen = num(vp.audit_len);
  const cur = preserve != null ? preserve : sel.value;
  sel.innerHTML = "";
  $("fIndexOf").textContent = "of " + alen + " on-chain entries";
  sel.disabled = alen === 0;
  if (!alen) { $("evidencePreview").hidden = true; return; }
  // render plain-language options: read every entry, describe it in a sentence.
  // (The demo vault keeps a short log; parallel reads are fine here.)
  for (let i = 0; i < alen; i++) {
    const o = document.createElement("option");
    o.value = String(i);
    o.textContent = "loading entry " + (i + 1) + "…";
    sel.appendChild(o);
  }
  Promise.all(
    Array.from({ length: alen }, (_, i) =>
      read(VAULT, "get_audit_entry", [i]).catch(() => null))
  ).then((entries) => {
    let riskyDefault = null;
    entries.forEach((e, i) => {
      const o = sel.querySelector('option[value="' + i + '"]');
      if (!o) return;
      if (!e || e.found === false) { o.textContent = "entry " + (i + 1) + " — unreadable"; return; }
      const d = describeAudit(e);
      o.textContent = clip(d.head + (d.tail ? " · " + d.tail : ""), 150);
      if (d.risky) riskyDefault = i; // default to the newest risky-looking entry
    });
    if (cur != null && Number(cur) < alen) {
      sel.value = String(cur);
    } else if (riskyDefault != null) {
      sel.value = String(riskyDefault);
    } else {
      sel.value = String(alen - 1); // newest
    }
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
  v.innerHTML =
    '<span class="big">EXPLOIT CONFIRMED — VAULT PAUSED</span>' +
    '<span class="det">audit #' + num(inc.op_index) + " · effect " + inc.effect +
    " · " + fmtTime(inc.time) + "</span>";
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
    '<span class="det">audit #' + num(inc.op_index) + " was ruled healthy · bond forfeited · reason: " +
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

async function submitReport() {
  if (inFlight) return;
  const id = ID.loadIdentity();
  if (!id) { ID.createIdentity(); renderIdentity(); }
  const useMM = signerMode === "metamask" && mmSigner; // MetaMask confirm-popup signer
  const idx = Number($("fIndex").value ?? 0);
  const bond = BigInt(num(st.min_bond));

  inFlight = true;
  const submitBtn = $("reportBtn");
  submitBtn.disabled = true;
  $("reportMsg").textContent = "";
  $("verdict").hidden = true;
  setState("checking");
  renderStateWord("CHECKING", "Judging audit #" + idx + " — real validator LLM round in progress…");
  $("evidencePreview").hidden = false;

  const cl = $("checklist");
  cl.hidden = false;
  cl.innerHTML =
    '<div class="chk"><span class="tick"></span><span>Pinned read — evidence entry #' + idx + '</span><span class="chk-t"></span></div>' +
    '<div class="chk"><span class="tick"></span><span>Broadcast report + bond</span><span class="chk-t"></span></div>' +
    '<div class="chk"><span class="tick"></span><span>Validator consensus — awaiting verdict</span><span class="chk-t"></span></div>';
  const [p1, p2, p3] = cl.querySelectorAll(".chk");

  const reporter = useMM ? mmAccount : id.address;
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

  // 2 · sign + broadcast (browser identity signs offline; MetaMask shows a
  // confirm popup for the bond — expected, it is a payable report)
  setPhase(p2, "now");
  let txId = null;
  const t0 = Date.now();
  try {
    const wallet = useMM ? mmSigner : ID.signer();
    txId = await sendWrite(wallet, INTERLOCK, "report_exploit", [idx], { value: bond });
    setPhase(p2, "done", "tx " + ID.shortAddr(txId) + " · submitted");
  } catch (e) {
    setPhase(p2, "", "failed");
    inFlight = false;
    verdictFail("broadcast failed: " + (e?.message ?? e));
    submitBtn.disabled = false;
    return;
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
    setPhase(p3, "", "timeout");
    verdictFail("no verdict after " + Math.round(judgeTimeoutMs / 1000) + "s — the round may still finalize; the readouts above are live.");
    submitBtn.disabled = false;
    return;
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
  if (ourInc.kind === "TRIPPED") {
    verdictTrip(ourInc);
    const rb = await read(INTERLOCK, "refundable_of", [canon(reporter)]).catch(() => 0n);
    $("reportMsg").textContent = "Honest report — your bond (" + num(st.min_bond) + " GEN) is escrowed and refundable (" + big(rb) + " escrowed).";
    $("reportMsg").className = "report-msg good";
  } else {
    verdictReject(ourInc);
    $("reportMsg").textContent = "Bond forfeited to the vault's resilience fund — no refund path exists. This is proof the breaker cannot be tripped on demand.";
    $("reportMsg").className = "report-msg";
  }
  submitBtn.disabled = false;
  await refreshEverything();
}

// ---------------------------------------------------------------- identity

function activeSignerLabel() {
  if (signerMode === "metamask" && mmSigner) return ID.shortAddr(mmAccount);
  const id = ID.loadIdentity();
  return id ? ID.shortAddr(id.address) : "—";
}

// v2 §3.4 — the honesty notice is dynamic, never a static claim.
function signerSentence() {
  if (signerMode === "metamask" && mmSigner) {
    return "Every report is signed by whichever identity is active above — right now, MetaMask (" +
      ID.shortAddr(mmAccount) + "). Each report opens a MetaMask confirm for the report bond — 0 network fee (studionet is gasless).";
  }
  const id = ID.loadIdentity();
  if (id) {
    return "Every report is signed by whichever identity is active above — right now, your browser identity (" +
      ID.shortAddr(id.address) + "). It never leaves this browser.";
  }
  return "Every report is signed by whichever identity is active above. Create a browser identity below, or connect MetaMask.";
}

// Both signer rows are always visible (MetaMask is not gated); the MetaMask row
// only enables once a wallet account is connected.
function syncSignerUI() {
  const onMM = signerMode === "metamask" && !!mmSigner;
  $("selBrowser").checked = !onMM;
  $("selMetamask").checked = onMM;
  $("selMetamask").disabled = !mmSigner;
  $("signerLine").textContent = signerSentence();
}

function renderIdentity() {
  const id = ID.loadIdentity();
  const has = !!id;
  const ready = has || !!mmSigner;
  $("idChip").classList.toggle("has-id", ready);
  $("idDot").classList.toggle("has-id", ready);
  $("popDot").classList.toggle("has-id", has);
  const active = activeSignerLabel();
  $("idAddr").textContent = active !== "—" ? active : (has ? ID.shortAddr(id.address) : "no signer");
  $("popAddr").textContent = has ? ID.checksum(id.address) : (mmSigner ? ID.checksum(mmAccount) : "—");
  $("popKey").textContent = has ? "••••" + id.key.slice(-4) : "—";
  $("revealKey").hidden = !has;
  $("copyKey").hidden = !has;
  $("copyAddr").hidden = !has && !mmSigner;
  $("idCreate").hidden = has;
  $("idRegen").hidden = !has;
  $("idClear").hidden = !has;
  $("fSigner").textContent = active;
  syncSignerUI();
  const canSign = has || (mmSigner && signerMode === "metamask");
  $("reportBtn").disabled = !canSign || inFlight || (vp && vp.paused === true);
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

  // MetaMask — optional but NOT gated: both signer rows are always visible in
  // the dropdown (§3.4). The MetaMask row enables once an account is connected.
  // studionet (chain 61999 = 0xF22F, gasless) is added + selected first so the
  // wallet shows a zero network fee instead of re-estimating / re-typing the tx
  // (the report is sent as an explicit legacy type-0x0 request — see tx.js).
  const mm = typeof window.ethereum !== "undefined" && window.ethereum;
  const mmAddrEl = $("mmAddr"), mmNote = $("mmNote"), mmBtn = $("mmConnect");
  const selMetamask = $("selMetamask");

  function updateMMNote() {
    if (!mm) {
      mmNote.textContent = "No MetaMask wallet detected — optional. Your browser identity signs every report.";
    } else if (!mmSigner) {
      mmNote.textContent = "Connect to enable MetaMask signing. studionet (chain 61999) is added automatically — it is gasless, so a confirm shows a 0 network fee.";
    } else if (signerMode === "metamask") {
      mmNote.textContent = "Connected — reports are signed with MetaMask. Each report opens a MetaMask confirm for the report bond at 0 network fee.";
    } else {
      mmNote.textContent = "Connected. Pick the MetaMask row above to sign reports with this account.";
    }
  }

  function setSignerMode(m) {
    if (m === "metamask") {
      if (!mmSigner) { // honest: a disconnected wallet cannot sign
        selMetamask.checked = false;
        $("selBrowser").checked = true;
        mmNote.textContent = "Connect MetaMask first, then pick it to sign.";
        return;
      }
      signerMode = "metamask";
    } else {
      signerMode = "browser";
    }
    renderIdentity();
    updateMMNote();
  }
  $("selBrowser").addEventListener("change", () => { if ($("selBrowser").checked) setSignerMode("browser"); });
  selMetamask.addEventListener("change", () => { if (selMetamask.checked) setSignerMode("metamask"); });

  if (!mm) {
    mmBtn.disabled = true;
    selMetamask.disabled = true;
    updateMMNote();
    return;
  }
  mmBtn.addEventListener("click", async () => {
    mmBtn.disabled = true;
    try {
      const accs = await mm.request({ method: "eth_requestAccounts" });
      const a = accs?.[0];
      if (!a) throw new Error("no account returned");
      await ensureStudionet(mm); // wallet now knows studionet → 0 fee, legacy 0x0
      mmAccount = String(a).toLowerCase();
      mmSigner = ID.makeMetaMaskSigner(mm, mmAccount);
      mmAddrEl.textContent = ID.shortAddr(mmAccount) + " · " + ID.checksum(mmAccount).slice(0, 8) + "…";
      mmAddrEl.classList.add("on");
      mmBtn.textContent = "CONNECTED";
      mmBtn.disabled = true;
      renderIdentity(); // enables (and can auto-select) the MetaMask row
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
    $("netline").textContent = "studionet · chain 61999 · interlock " + INTERLOCK + " · vault " + VAULT;

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
      renderStateWord("TRIPPED",
        "Exploit confirmed by validator consensus · vault paused · resume is governance-only");
      const last = await read(INTERLOCK, "get_incident", [num(s.incident_count) - 1]).catch(() => null);
      if (last && last.kind === "TRIPPED") {
        $("reportMsg").textContent = "Confirmed at audit #" + num(last.op_index) + " · effect " + last.effect + " · " + fmtTime(last.time);
        $("reportMsg").className = "report-msg good";
      }
    } else if (s.last_check_time) {
      setState("running");
      renderStateWord("RUNNING",
        armed
          ? "Breaker armed · consensus is watching every operation on the vault"
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
$("reportBtn").addEventListener("click", submitReport);

// Path A — "Watch it happen". Becomes the automatic borrow → report → trip loop
// once the exploit-lab pair (CONFIG.lab, task #17) is deployed and #18 wires it.
// Until then, stay honest: the live vault only holds healthy entries, so a watch
// round demonstrates the breaker REFUSING to trip — which is itself proof it
// cannot be tripped on demand.
async function watchDemo() {
  const s = $("watchStatus");
  if (CONFIG.lab) {
    s.textContent = "Exploit-lab pair detected — the auto borrow → report → trip loop is wired from here (task #18). The manual path below is live right now.";
    return;
  }
  s.textContent = "The exploit-lab vault (a pair where a real borrow drops coverage under 100%) is not deployed yet, so a live round here is a report on the healthy vault — real validator consensus, and it will REFUSE to trip. Run one yourself below: pick the newest entry and press Report.";
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
