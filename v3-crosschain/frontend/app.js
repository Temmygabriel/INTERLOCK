// Interlock v3 — cross-chain extension (experimental).
// Plain JS, no build step. Reads BaseDemoVault state on Base Sepolia over a
// public RPC. Degrades gracefully to manual Basescan instructions when the RPC
// is unreachable (CORS / offline).

(function () {
  "use strict";

  const BASE_SEPOLIA_RPC = "https://sepolia.base.org";
  const CHAIN_ID = 84532;
  const EXPLORER = "https://sepolia.basescan.org/address/";

  // Minimal read-only ABI for BaseDemoVault.
  const VAULT_ABI = [
    "function paused() view returns (bool)",
    "function coverage() view returns (uint256)",
    "function collateral() view returns (uint256)",
    "function debt() view returns (uint256)",
    "function auditLen() view returns (uint256)",
    "function bridgeReceiver() view returns (address)",
    "function owner() view returns (address)",
  ];

  const form = document.getElementById("vault-form");
  const input = document.getElementById("vault-address");
  const btn = document.getElementById("check-btn");
  const errBox = document.getElementById("vault-error");
  const table = document.getElementById("vault-table");
  const scanLink = document.getElementById("basescan-link");

  function setError(message) {
    errBox.textContent = message;
    errBox.hidden = false;
    table.hidden = true;
    scanLink.hidden = true;
  }

  function clearError() {
    errBox.hidden = true;
  }

  function setCell(id, value) {
    const el = document.getElementById(id);
    if (el) el.textContent = value;
  }

  function isAddress(value) {
    return /^0x[a-fA-F0-9]{40}$/.test(value || "");
  }

  function buildScanLink(address) {
    const a = document.createElement("a");
    a.href = EXPLORER + address;
    a.target = "_blank";
    a.rel = "noopener";
    a.textContent = "Open on Basescan (Base Sepolia)";
    scanLink.replaceChildren(a);
    scanLink.hidden = false;
  }

  async function readState(address) {
    if (typeof window.ethers === "undefined") {
      throw new Error(
        "ethers.js could not be loaded from the CDN (offline?). Use the Basescan link to verify the state instead."
      );
    }
    const provider = new window.ethers.JsonRpcProvider(BASE_SEPOLIA_RPC, CHAIN_ID);
    const vault = new window.ethers.Contract(address, VAULT_ABI, provider);

    // Parallel read; any revert here means the address is not a BaseDemoVault.
    const [paused, coverage, collateral, debt, auditLen, bridgeReceiver] =
      await Promise.all([
        vault.paused(),
        vault.coverage(),
        vault.collateral(),
        vault.debt(),
        vault.auditLen(),
        vault.bridgeReceiver(),
      ]);

    return {
      paused,
      coverage,
      collateral,
      debt,
      auditLen,
      bridgeReceiver,
    };
  }

  function render(s) {
    clearError();
    table.hidden = false;

    const badge = document.createElement("span");
    badge.className = "badge " + (s.paused ? "on" : "off");
    badge.textContent = s.paused ? "TRUE — tripped" : "false";
    setCell("s-paused", badge.outerHTML);

    setCell("s-coverage", s.coverage.toString() + "%");
    setCell("s-collateral", s.collateral.toString());
    setCell("s-debt", s.debt.toString());
    setCell("s-audit", s.auditLen.toString());
    setCell("s-bridge-receiver", s.bridgeReceiver);
  }

  async function check() {
    const address = (input.value || "").trim();
    if (!isAddress(address)) {
      setError("Enter a valid 0x address for the deployed BaseDemoVault on Base Sepolia.");
      return;
    }
    btn.disabled = true;
    btn.textContent = "Checking…";
    try {
      const s = await readState(address);
      render(s);
      buildScanLink(address);
    } catch (err) {
      setError(
        "Could not read on-chain state: " +
          (err && err.message ? err.message : err) +
          ". If this is a CORS/offline issue, verify the state manually on Basescan instead."
      );
      buildScanLink(address);
    } finally {
      btn.disabled = false;
      btn.textContent = "Check state";
    }
  }

  // Prefill from ?vault=0x... query param.
  const params = new URLSearchParams(window.location.search);
  const qvault = params.get("vault");
  if (qvault && isAddress(qvault)) {
    input.value = qvault;
    check();
  }

  form.addEventListener("submit", function (e) {
    e.preventDefault();
    check();
  });
})();
