// identity.js — browser-stored identity (the default signer) + optional
// MetaMask *display*.
//
// Design intent (see repo root aegis-wallet-integration.md, used ONLY as a
// reference for the browser-keypair pattern — this is Interlock, not Aegis):
//   * Every transaction is signed by a keypair this page generated and stores in
//     this browser (localStorage). Nothing is sent to a wallet provider to sign.
//   * MetaMask is optional and DISPLAY-ONLY: if the user has it, we show the
//     connected account so the honest truth is visible — but the browser
//     identity stays the frictionless default signer.
//   * The header chip is honest about state: a filled dot means an identity
//     exists in this browser; a hollow dot means none.
//
// The key never leaves this browser and never touches the network. Copying it
// lets you recover the identity on another machine.

const STORAGE_KEY = "interlock.identity.v1";

const eth = () => {
  if (!globalThis.ethers) throw new Error("ethers not loaded");
  return globalThis.ethers;
};

// `eth()` returns the ethers namespace; a Wallet is a normal class so it is
// constructed with `new`. Writing `new eth().Wallet(k)` would try to construct
// the arrow helper instead — that is why every Wallet is built through this.
const walletFromKey = (k) => new (eth().Wallet)(k);

/** Read the stored identity (or null). */
export function loadIdentity() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const { k } = JSON.parse(raw);
    if (!k) return null;
    const wallet = walletFromKey(k);
    return { address: wallet.address.toLowerCase(), key: k };
  } catch {
    return null;
  }
}

/** Generate + persist a fresh identity. Returns it. */
export function createIdentity() {
  const wallet = eth().Wallet.createRandom();
  const id = { address: wallet.address.toLowerCase(), key: wallet.privateKey };
  persist(id);
  return id;
}

function persist(id) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify({ k: id.key })); } catch {}
}

/** Import an existing private key (hex, with or without 0x). Returns {ok, id|err}. */
export function importIdentity(keyHex) {
  try {
    let k = keyHex.trim();
    if (!/^0x[0-9a-fA-F]{64}$/.test(k)) k = "0x" + k;
    const wallet = walletFromKey(k);
    const id = { address: wallet.address.toLowerCase(), key: wallet.privateKey };
    persist(id);
    return { ok: true, id };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}

/** Delete the stored identity. */
export function clearIdentity() {
  try { localStorage.removeItem(STORAGE_KEY); } catch {}
}

/** ethers Wallet for the current identity (throws if none). */
export function signer() {
  const id = loadIdentity();
  if (!id) throw new Error("no identity — create one first");
  return walletFromKey(id.key);
}

/** Wrap an EIP-1193 provider (MetaMask) as a minimal signer for tx.js.
 * getAddress() returns the connected account (canonical lowercase); request()
 * forwards RPC calls straight to MetaMask. The key never leaves MetaMask —
 * eth_sendTransaction signs inside the wallet, then returns the tx hash. */
export function makeMetaMaskSigner(provider, account) {
  const address = String(account).toLowerCase();
  return {
    kind: "metamask",
    address,
    async getAddress() { return address; },
    request(o) { return provider.request(o); },
  };
}

export function shortAddr(a) {
  if (a == null) return "—";
  const s = String(a).toLowerCase();
  return s.startsWith("0x") ? s.slice(0, 6) + "…" + s.slice(-4) : s;
}

export function checksum(a) {
  try { return eth().getAddress(a); } catch { return String(a); }
}
