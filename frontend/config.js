// config.js — deployment configuration for the Interlock safety panel.
//
// Where the addresses come from — two modes:
//
//   1. PLAIN STATIC SERVE (no build step): this file IS the config, and
//      demo-manifest.json supplies the cross-chain half.
//
//   2. VERCEL WITH BUILD STEP (recommended): `node build.mjs` regenerates
//      dist/config.js from the Vercel environment variables. Set them in the
//      Vercel dashboard (Project → Settings → Environment Variables). When a var
//      is left unset the build falls back to the defaults in THIS file, so a
//      bare build still points at the deployed demo.
//
// THE PIVOT (2026-09-10): v3 IS the product. The primary pair below is the v3
// CROSS-CHAIN stack's GenLayer leg, and it rides the SAME env var names the
// same-chain build used — INTERLOCK_ADDRESS = interlock_v3, VAULT_ADDRESS = its
// evidence vault. Nothing in the Vercel dashboard needs renaming; only the two
// values change. The cross-chain addresses (bridge sender, Base vault,
// dispatcher, EIDs) are NOT env vars: they come from demo-manifest.json via
// build.mjs, because there are too many of them and they all move together
// whenever the demo is reset.
//
// IMPORTANT — studio-dev (chain 61997) resolves contracts by the EXACT address
// string (case-sensitive). Copy deployed addresses verbatim; never change case.
// (Compare with canon() — lowercase BOTH sides only when comparing.)
export const CONFIG = {
  // GenLayer guard (interlock_v3) — validator consensus, bonded reports, and the
  // TRIP emission. This is the v3 stack, not the same-chain interlock.py.
  interlock: "0xB4502c37FC60660c701e3e814A2CC079693E151f",
  // The evidence vault on GenLayer: the under-collateralized borrow that
  // consensus classifies lives in ITS audit log. It is NOT the vault that gets
  // paused — the pause happens on Base Sepolia (see demo-manifest.json).
  vault: "0x0a38c14029E1f60b2E3FFEcBaa5E4ad11a460b69",

  // Populated by build.mjs from demo-manifest.json. Listed here so a plain
  // static serve (no build step) still resolves the cross-chain panel.
  crosschain: null,

  // The SAME-CHAIN reference build (interlock.py + DemoVault, one chain, no
  // bridge) — kept and demoted below the cross-chain story. It is populated ONLY
  // by the LAB_INTERLOCK_ADDRESS / LAB_VAULT_ADDRESS env vars and deliberately
  // does NOT fall back to the pair above: the primary pair is now the v3 stack,
  // and silently pointing the same-chain instrument at it would misrepresent
  // which system the section is describing.
  lab: null,
};
