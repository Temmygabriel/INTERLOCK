// gen.js — GenLayer wire codec for the browser (no dependencies).
//
// Mirrors what genlayer_py does on the wire so the panel can read contract
// state and broadcast real writes straight from the browser. Two parts:
//
//   1. The GenLayer *typed* value encoding (uleb128 length/type tags) used for
//      method calldata and for read results — see genlayer_py/abi/calldata.
//   2. The outer envelope: a call is RLP([encodedMethod, flag]) where `flag` is
//      leader_only (False = empty item 0x80 for consensus writes) — see callData
//      below.  That blob is passed either as gen_call.data (reads, sim variant)
//      or as the `_calldata` payload of the consensus-main addTransaction(...)
//      call (writes, in tx.js).
//
// A write is therefore an ordinary EVM transaction `to` the consensus-main
// contract — signable by any EIP-155 key. The app signs with the browser
// identity's ethers.Wallet (see identity.js); MetaMask is display-only.

export const RPC_URL = "https://studio-dev.genlayer.com/api";
export const CHAIN_ID = 61997; // studio-dev (GenLayer Studio Dev — chain 61997)
export const CONSENSUS = "0xb7278A61aa25c888815aFC32Ad3cC52fF24fE575";
export const INITIAL_VALIDATORS = 5;
export const MAX_ROTATIONS = 3;
// Any address works for `from` on reads (studio-dev does not gate them).
export const ANON_FROM = "0x" + "11".repeat(20);

// ---- type tags (genlayer_py/abi/calldata/consts.py) -------------------------
const TYPE_SPECIAL = 0, TYPE_PINT = 1, TYPE_NINT = 2, TYPE_BYTES = 3,
      TYPE_STR = 4, TYPE_ARR = 5, TYPE_MAP = 6;
const SPECIAL_NULL = 0, SPECIAL_FALSE = 8, SPECIAL_TRUE = 16, SPECIAL_ADDR = 24;

const te = new TextEncoder();
const td = new TextDecoder();

// --------------------------------------------------------------- uleb128 wire

function uleb(n) {
  // n: non-negative BigInt -> bytes
  const out = [];
  if (n === 0n) { out.push(0); return out; }
  while (n > 0n) {
    let b = Number(n & 0x7fn);
    n >>= 7n;
    if (n > 0n) b |= 0x80;
    out.push(b);
  }
  return out;
}

function readUleb(bytes, state) {
  let ret = 0n, off = 0n, b;
  do {
    b = bytes[state.i++];
    ret |= BigInt(b & 0x7f) << off;
    off += 7n;
  } while (b & 0x80);
  return ret;
}

// ------------------------------------------------------------- typed encode

export function glEncode(value) {
  const out = [];
  const push = (arr) => { for (const b of arr) out.push(b); };

  const impl = (v) => {
    if (v === null || v === undefined) { out.push(SPECIAL_NULL); return; }
    if (v === true) { out.push(SPECIAL_TRUE); return; }
    if (v === false) { out.push(SPECIAL_FALSE); return; }
    const t = typeof v;
    if (t === "number" || t === "bigint") {
      let n = BigInt(v);
      if (n >= 0n) push(uleb((n << 3n) | BigInt(TYPE_PINT)));
      else { n = -n - 1n; push(uleb((n << 3n) | BigInt(TYPE_NINT))); }
      return;
    }
    if (t === "string") {
      const b = te.encode(v);
      push(uleb((BigInt(b.length) << 3n) | BigInt(TYPE_STR)));
      push(b);
      return;
    }
    if (v instanceof Uint8Array) { // raw bytes (e.g. an address blob)
      push(uleb((BigInt(v.length) << 3n) | BigInt(TYPE_BYTES)));
      push(v);
      return;
    }
    if (Array.isArray(v)) {
      push(uleb((BigInt(v.length) << 3n) | BigInt(TYPE_ARR)));
      for (const x of v) impl(x);
      return;
    }
    if (v instanceof Map || (t === "object")) {
      const keys = Object.keys(v).sort();
      push(uleb((BigInt(keys.length) << 3n) | BigInt(TYPE_MAP)));
      for (const k of keys) {
        const kb = te.encode(k);
        push(uleb(BigInt(kb.length)));
        push(kb);
        impl(v[k]);
      }
      return;
    }
    throw new Error("genlayer encode: unsupported " + t);
  };

  impl(value);
  return Uint8Array.from(out);
}

// ------------------------------------------------------------- typed decode

export function glDecode(bytes, i0 = 0) {
  const state = { i: i0 };
  const impl = () => {
    const code = readUleb(bytes, state);
    const typ = Number(code & 7n);
    if (typ === TYPE_SPECIAL) {
      if (code === BigInt(SPECIAL_NULL)) return null;
      if (code === BigInt(SPECIAL_FALSE)) return false;
      if (code === BigInt(SPECIAL_TRUE)) return true;
      if (code === BigInt(SPECIAL_ADDR)) {
        const hex = [...bytes.slice(state.i, state.i + 20)]
          .map((b) => b.toString(16).padStart(2, "0")).join("");
        state.i += 20;
        return "0x" + hex;
      }
      throw new Error("genlayer decode: unknown special " + code);
    }
    const n = code >> 3n;
    if (typ === TYPE_PINT) return n;
    if (typ === TYPE_NINT) return -n - 1n;
    if (typ === TYPE_BYTES) {
      const b = bytes.slice(state.i, state.i + Number(n)); state.i += Number(n);
      return b;
    }
    if (typ === TYPE_STR) {
      const s = td.decode(bytes.slice(state.i, state.i + Number(n)));
      state.i += Number(n);
      return s;
    }
    if (typ === TYPE_ARR) {
      const arr = [];
      for (let k = 0n; k < n; k++) arr.push(impl());
      return arr;
    }
    if (typ === TYPE_MAP) {
      const obj = {};
      for (let k = 0n; k < n; k++) {
        const kl = readUleb(bytes, state);
        const key = td.decode(bytes.slice(state.i, state.i + Number(kl)));
        state.i += Number(kl);
        obj[key] = impl();
      }
      return obj;
    }
    throw new Error("genlayer decode: unknown type " + typ);
  };
  const out = impl();
  if (state.i !== bytes.length) throw new Error("genlayer decode: trailing bytes");
  return out;
}

// ----------------------------------------------------------------- RLP (outer envelope)

function rlpBytes(b) {
  if (b.length === 1 && b[0] < 0x80) return Array.from(b);
  if (b.length <= 55) return [0x80 + b.length, ...b];
  const lenHex = BigInt(b.length).toString(16);
  const lenBytes = (lenHex.length % 2 ? "0" : "") + lenHex;
  const ll = [...Uint8Array.from({ length: lenBytes.length / 2 }, (_, i) =>
    parseInt(lenBytes.slice(2 * i, 2 * i + 2), 16))];
  return [0xb7 + ll.length, ...ll, ...b];
}

/** RLP-encode the list `items` (array of Uint8Array). */
export function rlpList(items) {
  const payload = [];
  for (const it of items) payload.push(...rlpBytes(it));
  if (payload.length <= 55) return Uint8Array.from([0xc0 + payload.length, ...payload]);
  const lenHex = BigInt(payload.length).toString(16);
  const lenBytes = (lenHex.length % 2 ? "0" : "") + lenHex;
  const ll = Uint8Array.from({ length: lenBytes.length / 2 }, (_, i) =>
    parseInt(lenBytes.slice(2 * i, 2 * i + 2), 16));
  return Uint8Array.from([0xf7 + ll.length, ...ll, ...payload]);
}

const hexBytes = (s) =>
  Uint8Array.from((s.startsWith("0x") ? s.slice(2) : s).match(/.{2}/g) ?? [], (h) => parseInt(h, 16));

// The GenLayer SDK serializes a method call as RLP([calldata.encode({method,args}),
// leader_only]) using the python `rlp` lib, where `False` RLP-encodes to the EMPTY
// bytes item 0x80 (falsy).  A literal 0x00 byte would RLP-decode to b"\x00", which is
// truthy and flips leader_only=True — silently disabling validator re-derivation for
// consensus writes.  So the second item must be an empty bytes item (rlpBytes([]) -> 0x80).
export function callData(method, args) {
  const obj = args ? { method, args } : { method };
  const encoded = glEncode(obj);
  const rlp = rlpList([encoded, new Uint8Array(0)]); // leader_only = False -> 0x80
  return "0x" + [...rlp].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Read calls use the SDK's sim/write-variant envelope: second element is a raw 0x00
// byte (see genlayer_py simulate_write_contract).  Reads run no consensus, so the
// flag is inert, but match the SDK wire form exactly for parity.
function callDataSim(method, args) {
  const obj = args ? { method, args } : { method };
  const encoded = glEncode(obj);
  const rlp = rlpList([encoded, Uint8Array.of(0)]);
  return "0x" + [...rlp].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ------------------------------------------------------------------- RPC

/** Raw JSON-RPC POST to studionet. NO retry, no timeout override — callers in the
 *  write path (nonce/gas/broadcast) must never be auto-retried. */
export async function rpc(method, params) {
  const res = await fetch(RPC_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method, params }),
  });
  const j = await res.json();
  if (j.error) throw new Error(`${method}: ${j.error.message}`);
  return j.result;
}

// studionet intermittently stalls one in ~6 reads (~10s, then "fetch failed");
// an immediate retry always recovers (probed 2026-09-07). View reads are pure
// gen_call sims — side-effect-free — so a bounded timeout + ONE retry is safe and
// keeps the live panel from flashing a network-error frame every poll. Network /
// transport failures retry; RPC-level errors (decode, method) throw immediately —
// they are deterministic and would fail again.
const NET_FAIL = /fetch failed|Failed to fetch|ECONNRESET|ENOTFOUND|ETIMEDOUT|aborted|AbortError|timeout|network/i;
const READ_TIMEOUT_MS = 20_000;

async function rpcReadOnce(method, params) {
  const ctl = new AbortController();
  const to = setTimeout(() => ctl.abort(), READ_TIMEOUT_MS);
  try {
    const res = await fetch(RPC_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: ctl.signal,
      body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method, params }),
    });
    const j = await res.json();
    if (j.error) throw new Error(`${method}: ${j.error.message}`);
    return j.result;
  } finally {
    clearTimeout(to);
  }
}

/** Read a view method: gen_call with an anonymous `from` (sim-variant envelope).
 *  One automatic retry on a transport-level failure (see rpcReadOnce); never
 *  retries an RPC-level error, and never used by writes. */
export async function read(contract, method, args, from = ANON_FROM) {
  const params = [{
    type: "read", to: contract, from,
    data: callDataSim(method, args),
    transaction_hash_variant: "latest-nonfinal",
  }];
  try {
    return glDecode(hexBytes(await rpcReadOnce("gen_call", params)));
  } catch (e) {
    if (!NET_FAIL.test(String(e?.message ?? e))) throw e;
    await new Promise((r) => setTimeout(r, 600));
    return glDecode(hexBytes(await rpcReadOnce("gen_call", params)));
  }
}

/** Small helper: contract *str-address* views return checksummed hex strings; a
 *  UI comparing addresses should lowercase both sides. */
export const norm = (s) => String(s).toLowerCase();

// ------------------------------------------------------ v0.6 fee estimation
//
// studio-dev (v0.6 RC) runs FEE-AWARE consensus: every write must be wrapped in
// consensus-main's new addTransaction(fees-tuple) or it is silently dropped.
// The browser cannot compute the fee packet itself (it needs the internal
// apply_pause message allocation), but it does NOT have to: the server's own
// `sim_getFeeConfig` defaultFees, echoed back as the sim's initial `fees`,
// makes `sim_estimateTransactionFees` return a `recommendedPreset` that carries
// the authoritative distribution + feeValue + messageAllocations (verified
// 2026-09-08 — a report encoded from that preset SETTLED on studio-dev). These
// helpers just fetch those two server answers losslessly.

/** JSON.parse that preserves u256 integers. The fee RPCs return values like
 *  messageAllocations[].parentIndex = 2^256-1 as an UNQUOTED decimal literal;
 *  res.json() would round it to an imprecise JS Number and break ethers.
 *  Integer literals with >=16 digits are re-parsed as BigInt. */
export function losslessParse(text) {
  const out = [];
  const isDigit = (c) => c >= "0" && c <= "9";
  let i = 0, inStr = false;
  while (i < text.length) {
    const ch = text[i];
    if (inStr) {
      out.push(ch);
      if (ch === "\\") { if (i + 1 < text.length) { out.push(text[i + 1]); i += 2; } else i++; continue; }
      if (ch === '"') inStr = false;
      i++;
      continue;
    }
    if (ch === '"') { inStr = true; out.push(ch); i++; continue; }
    if (ch === "-" || isDigit(ch)) {
      let j = i + (ch === "-" ? 1 : 0);
      let frac = false, exp = false;
      while (j < text.length && isDigit(text[j])) j++;
      if (j < text.length && text[j] === ".") { frac = true; j++; while (j < text.length && isDigit(text[j])) j++; }
      if (j < text.length && (text[j] === "e" || text[j] === "E")) {
        exp = true; j++;
        if (j < text.length && (text[j] === "+" || text[j] === "-")) j++;
        while (j < text.length && isDigit(text[j])) j++;
      }
      const token = text.slice(i, j);
      // integer literal (no dot/exponent) with a 16+ digit magnitude
      const intPart = token.replace(/^[-+]?/, "").split(/[.eE]/)[0];
      out.push(!frac && !exp && intPart.length >= 16 ? JSON.stringify(token) : token);
      i = j;
      continue;
    }
    out.push(ch); i++;
  }
  return JSON.parse(out.join(""), (k, v) =>
    (typeof v === "string" && /^-?\d{16,}$/.test(v)) ? BigInt(v) : v);
}

async function rpcLossless(method, params) {
  const res = await fetch(RPC_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method, params }),
  });
  const j = losslessParse(await res.text());
  if (j.error) throw new Error(`${method}: ${j.error.message}`);
  return j.result;
}

const FEE_NET = /fetch failed|Failed to fetch|ECONNRESET|ENOTFOUND|ETIMEDOUT|aborted|AbortError|timeout|502|Bad gateway|Internal|Method not found|invalid json/i;

// The two fee RPCs sit behind a flaky studio-dev gateway: bounded transport
// retry is safe here (both are read-only simulations — nothing is signed yet).
async function rpcFeeRetry(method, params, tries = 4) {
  let last;
  for (let t = 0; t < tries; t++) {
    try { return await rpcLossless(method, params); }
    catch (e) {
      last = e;
      if (!FEE_NET.test(String(e?.message ?? e))) throw e;
      await new Promise((r) => setTimeout(r, 1500 * (t + 1)));
    }
  }
  throw last;
}

/** sim_getFeeConfig result (lossless). Its `defaultFees` is echoed back as the
 *  write-sim's initial fees — no policy math needed on our side. */
export async function feeConfig() {
  return rpcFeeRetry("sim_getFeeConfig", []);
}

/** sim_estimateTransactionFees for a WRITE, returning the authoritative
 *  recommendedPreset (lossless) to encode into the addTransaction tuple.
 *  @param to    the target contract (interlock / vault)
 *  @param from  the REAL signer address (consensus uses it as the tx sender)
 *  @param data  the RLP([glEncode({method,args}),0x80]) blob (callData)
 *  @param value the user value carried (report bond / 0) — wei
 *  @param defaultFees feeConfig().defaultFees — echoed verbatim */
export async function estimateWriteFees(to, from, data, value, defaultFees) {
  const fees = JSON.parse(JSON.stringify(defaultFees ?? {}, (k, v) =>
    typeof v === "bigint" ? Number(v) : v)); // BigInt leaves -> Number (all < 2^53)
  const params = [{
    type: "write", to, from, data,
    transaction_hash_variant: "latest-nonfinal",
    value: "0x" + BigInt(value).toString(16),
    fees,
  }];
  const res = await rpcFeeRetry("sim_estimateTransactionFees", params);
  return res?.recommendedPreset ?? null;
}
