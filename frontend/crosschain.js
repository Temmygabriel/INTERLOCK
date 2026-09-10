// crosschain.js — reads for the v3 cross-chain panel.
//
// The v3 story spans three systems, so this module reads all three and hands
// app.js plain data (app.js owns the DOM):
//
//   1. GenLayer guard   interlock_v3.status() + the latest incident  (via gen.js)
//   2. Bridge           BridgeSender's outbox: how many TRIP messages are queued
//   3. Base Sepolia     BaseDemoVault state, read DIRECTLY from the browser
//
// Base Sepolia is read with ethers straight from the page. No proxy: the public
// Base RPCs return `Access-Control-Allow-Origin: *`, so the browser can talk to
// them directly. Every address comes from CONFIG.crosschain, which build.mjs
// bakes out of frontend/demo-manifest.json — a demo reset that redeploys the
// GenLayer trio or re-arms the vault needs no code change here.
//
// Reads never throw. A dead RPC, a CORS refusal, or an unconfigured manifest
// all come back as `{ ok: false, error }` so the panel can say what is actually
// wrong instead of rendering a confident zero.

import { read } from "./gen.js";
import { CONFIG } from "./config.js";

// The v3 addresses live in exactly one file: frontend/demo-manifest.json.
// Under Vercel, build.mjs bakes that file into dist/config.js, so CONFIG.crosschain
// is already populated. Served straight from frontend/ (a plain static serve, or
// opening the page during development) it is null — so we fetch the manifest
// ourselves. Either way there is one source of truth, and neither path duplicates
// an address.
export let CC = CONFIG.crosschain ?? null;

export const ccConfigured = () =>
  Boolean(CC && CC.genlayer?.interlock_v3 && CC.base_sepolia?.vault);

/** Idempotent. Resolves the manifest when the build step did not. */
export async function initCrossChain() {
  if (ccConfigured()) return true;
  try {
    const res = await fetch(new URL("./demo-manifest.json", import.meta.url));
    if (!res.ok) return false;
    const m = await res.json();
    // Same required fields build.mjs enforces — a half-configured manifest must
    // not render as a confident-looking empty panel.
    if (m?.genlayer?.interlock_v3 && m?.genlayer?.demo_vault && m?.genlayer?.bridge_sender &&
        m?.base_sepolia?.vault && m?.base_sepolia?.eid != null) {
      CC = m;
    }
  } catch {
    /* no manifest reachable — the panel renders as unconfigured */
  }
  return ccConfigured();
}

const ethers = () => globalThis.ethers;

// Base RPCs, in preference order. sepolia.base.org is canonical; the public
// mirrors are used only if it fails, and all three send CORS headers. Computed
// per call because the manifest may not have resolved when this module loaded.
const baseRpcs = () => {
  const fromManifest = CC?.base_sepolia?.rpc ? [CC.base_sepolia.rpc] : [];
  return fromManifest.concat([
    "https://base-sepolia-rpc.publicnode.com",
    "https://base-sepolia.drpc.org",
  ]);
};

const VAULT_ABI = [
  "function paused() view returns (bool)",
  "function coverage() view returns (uint256)",
  "function collateral() view returns (uint256)",
  "function debt() view returns (uint256)",
  "function auditLen() view returns (uint256)",
  "function bridgeReceiver() view returns (address)",
  "function owner() view returns (address)",
  "event VaultTripped(address indexed by)",
];

let provider = null;
let providerRpc = null;

/** First Base RPC that answers eth_chainId, memoized for the page's lifetime. */
async function getProvider() {
  if (provider) return provider;
  const { JsonRpcProvider } = ethers();
  let lastErr = null;
  for (const rpc of baseRpcs()) {
    try {
      const p = new JsonRpcProvider(rpc, CC.base_sepolia.chain_id ?? 84532);
      await p.getBlockNumber(); // prove it actually answers before trusting it
      provider = p;
      providerRpc = rpc;
      return p;
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr ?? new Error("no Base Sepolia RPC answered");
}

export const baseRpcInUse = () => providerRpc;

/**
 * Read the Base Sepolia vault. `paused === true` is the whole point of the
 * demo — it is the brake physically engaged on a different chain.
 * @returns {Promise<{ok:boolean, error?:string, paused?:boolean, coverage?:number,
 *   collateral?:number, debt?:number, auditLen?:number, bridgeReceiver?:string|null,
 *   owner?:string|null, tripTx?:string|null}>}
 */
export async function readBaseVault() {
  if (!ccConfigured()) return { ok: false, error: "cross-chain stack not configured" };
  const addr = CC.base_sepolia.vault;
  try {
    const p = await getProvider();
    const v = new (ethers().Contract)(addr, VAULT_ABI, p);
    const [paused, coverage, collateral, debt, auditLen, bridgeReceiver, owner] =
      await Promise.all([
        v.paused(), v.coverage(), v.collateral(), v.debt(), v.auditLen(),
        v.bridgeReceiver().catch(() => null),
        v.owner().catch(() => null),
      ]);
    const out = {
      ok: true,
      paused,
      coverage: Number(coverage),
      collateral: Number(collateral),
      debt: Number(debt),
      auditLen: Number(auditLen),
      bridgeReceiver,
      owner,
      tripTx: null,
    };
    if (paused) out.tripTx = await findTripTx(p, v);
    return out;
  } catch (e) {
    return { ok: false, error: String(e?.shortMessage ?? e?.message ?? e) };
  }
}

// The Base trip tx is the strongest single piece of evidence in the demo (the
// LayerZero delivery that physically paused the vault), so try to surface a
// link to it. getLogs is best-effort: sepolia.base.org rejects wide ranges with
// 413 Payload Too Large, hence the small windows and the bounded scan. Failure
// is never fatal — the panel just links the vault address instead.
const LOG_WINDOW = 2000;
const LOG_WINDOWS = 8;

async function findTripTx(p, v) {
  try {
    const latest = await p.getBlockNumber();
    for (let i = 0; i < LOG_WINDOWS; i++) {
      const to = latest - i * LOG_WINDOW;
      const from = Math.max(0, to - LOG_WINDOW + 1);
      const logs = await v.queryFilter(v.filters.VaultTripped(), from, to);
      if (logs.length) return logs[logs.length - 1].transactionHash;
    }
  } catch {
    /* best-effort only */
  }
  return null;
}

/**
 * The GenLayer half: the guard's own state plus its latest incident. `status()`
 * is what the page trusts; the incident carries the cross-chain specifics
 * (which chain EID, which target contract, the coverage that triggered it).
 */
export async function readGuard() {
  if (!ccConfigured()) return { ok: false, error: "cross-chain stack not configured" };
  try {
    const status = await read(CC.genlayer.interlock_v3, "status");
    let incident = null;
    const n = Number(status?.incident_count ?? 0);
    if (n > 0) incident = await read(CC.genlayer.interlock_v3, "get_incident", [n - 1]);
    return { ok: true, status, incident };
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e) };
  }
}

/** The evidence vault on GenLayer — where the under-collateralized borrow lands. */
export async function readEvidenceVault() {
  if (!ccConfigured()) return { ok: false, error: "cross-chain stack not configured" };
  try {
    const params = await read(CC.genlayer.demo_vault, "params");
    return { ok: true, params };
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e) };
  }
}

/**
 * The bridge hop: how many TRIP messages the GenLayer outbox is holding, and the
 * newest message's envelope. An empty outbox is the normal pre-trip state; a
 * non-empty one means "consensus confirmed, waiting on the relay".
 */
export async function readBridge() {
  if (!ccConfigured()) return { ok: false, error: "cross-chain stack not configured" };
  try {
    const hashes = await read(CC.genlayer.bridge_sender, "get_message_hashes");
    const list = Array.isArray(hashes) ? hashes : [];
    let message = null;
    if (list.length) message = await read(CC.genlayer.bridge_sender, "get_message", [list[0]]);
    return { ok: true, count: list.length, hashes: list, message };
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e) };
  }
}

// ---- explorer links --------------------------------------------------------
const hex = (h) => (typeof h === "string" ? h : "0x" + Array.from(h ?? []).map((b) => b.toString(16).padStart(2, "0")).join(""));

export const baseAddressUrl = (a) => `${CC?.base_sepolia?.explorer ?? "https://sepolia.basescan.org"}/address/${a}`;
export const baseTxUrl = (h) => `${CC?.base_sepolia?.explorer ?? "https://sepolia.basescan.org"}/tx/${hex(h)}`;

/** Which chain EID the guard is configured to message (40245 = Base Sepolia). */
export const targetEid = () => Number(CC?.base_sepolia?.eid ?? 0);
