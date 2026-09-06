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
// contract — which is exactly what MetaMask (and ethers) can sign.

export const RPC_URL = "https://studio.genlayer.com/api";
export const CHAIN_ID = 61999; // studionet (GenLayer Studio Network)
export const CONSENSUS = "0xb7278A61aa25c888815aFC32Ad3cC52fF24fE575";
export const INITIAL_VALIDATORS = 5;
export const MAX_ROTATIONS = 3;
// Any address works for `from` on reads (studionet does not gate them).
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

/** Raw JSON-RPC POST to studionet. */
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

/** Read a view method: gen_call with an anonymous `from` (sim-variant envelope). */
export async function read(contract, method, args, from = ANON_FROM) {
  const result = await rpc("gen_call", [{
    type: "read", to: contract, from,
    data: callDataSim(method, args),
    transaction_hash_variant: "latest_nonfinal",
  }]);
  return glDecode(hexBytes(result));
}

/** Small helper: contract *str-address* views return checksummed hex strings; a
 *  UI comparing addresses should lowercase both sides. */
export const norm = (s) => String(s).toLowerCase();
