#!/usr/bin/env node
// build.mjs — Vercel build step for the Interlock safety panel.
//
// A pure-static page cannot read Vercel env vars (they exist only at build /
// server runtime), so the build bakes them into the output as dist/config.js,
// which the panel imports. No npm dependencies — plain node:fs/path.
//
// Vercel project settings (for this repo):
//   Root Directory    : frontend
//   Framework Preset  : Other
//   Build Command     : node build.mjs
//   Output Directory  : dist
//   Environment Vars  : INTERLOCK_ADDRESS, VAULT_ADDRESS   (0x + 40 hex each)
//
// What it does:
//   1. copies the static site (index.html, style.css, *.js) into dist/
//   2. writes dist/config.js with the addresses resolved from the env vars
//      above, falling back to the committed defaults in ./config.js when an
//      env var is unset — so a bare build (or a preview with no vars) still
//      points at the deploy-card pair.
//   Addresses are passed through VERBATIM: studionet's registry is
//   case-sensitive, so copy the deployed address strings exactly as shown.
import { mkdirSync, copyFileSync, writeFileSync, readdirSync, statSync, readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { CONFIG as DEFAULTS } from "./config.js";

const here = dirname(fileURLToPath(import.meta.url));
const dist = join(here, "dist");
const IS_ADDR = (s) => /^0x[0-9a-fA-F]{40}$/.test(String(s ?? "").trim());

function resolveVar(name, fallback) {
  const raw = (process.env[name] ?? "").trim();
  if (!raw) return fallback;
  if (!IS_ADDR(raw)) {
    console.error(`[build] ${name}="${raw}" is not a valid contract address (expect 0x + 40 hex).`);
    process.exit(1);
  }
  return raw; // verbatim — studio-dev resolves contracts by EXACT address string (case-sensitive)
}

// The primary pair is now the v3 cross-chain stack's GenLayer leg, and the
// existing env var NAMES carry it: INTERLOCK_ADDRESS = interlock_v3,
// VAULT_ADDRESS = its evidence vault (demo_vault). No Vercel variable needs
// renaming for the pivot — only its value.
const config = {
  interlock: resolveVar("INTERLOCK_ADDRESS", DEFAULTS.interlock),
  vault: resolveVar("VAULT_ADDRESS", DEFAULTS.vault),
};

// The v3 cross-chain stack comes from frontend/demo-manifest.json — one file
// holding every address the cross-chain panel needs (GenLayer trio, Base vault
// + dispatcher, EIDs, RPCs). A demo reset rewrites that file and commits it, so
// no dashboard edit is ever needed for the 8+ v3 addresses. Env overrides exist
// for the two that change most (a re-armed or redeployed vault), and ONLY as
// overrides — the manifest stays the source of truth.
{
  const manifestPath = join(here, "demo-manifest.json");
  if (existsSync(manifestPath)) {
    let manifest;
    try {
      manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    } catch (e) {
      console.error(`[build] demo-manifest.json is not valid JSON: ${e.message}`);
      process.exit(1);
    }
    const baseVault = (process.env.BASE_VAULT_ADDRESS ?? "").trim();
    const baseDispatcher = (process.env.BASE_DISPATCHER_ADDRESS ?? "").trim();
    for (const [name, val] of [["BASE_VAULT_ADDRESS", baseVault], ["BASE_DISPATCHER_ADDRESS", baseDispatcher]]) {
      if (val && !IS_ADDR(val)) {
        console.error(`[build] ${name}="${val}" is not a valid address (expect 0x + 40 hex).`);
        process.exit(1);
      }
    }
    if (baseVault) manifest.base_sepolia.vault = baseVault;
    if (baseDispatcher) manifest.base_sepolia.dispatcher = baseDispatcher;

    // Fail loudly on a manifest that cannot drive the panel: a half-configured
    // cross-chain stack renders as a confident-looking empty panel, which is
    // worse than a build error.
    const need = [
      ["genlayer.interlock_v3", manifest.genlayer?.interlock_v3],
      ["genlayer.demo_vault", manifest.genlayer?.demo_vault],
      ["genlayer.bridge_sender", manifest.genlayer?.bridge_sender],
      ["base_sepolia.vault", manifest.base_sepolia?.vault],
      ["base_sepolia.eid", manifest.base_sepolia?.eid],
    ].filter(([, v]) => v == null || v === "");
    if (need.length) {
      console.error(`[build] demo-manifest.json is missing: ${need.map(([k]) => k).join(", ")}`);
      process.exit(1);
    }
    config.crosschain = manifest;
  } else {
    console.warn("[build] no frontend/demo-manifest.json — the cross-chain panel will render as unconfigured.");
    config.crosschain = null;
  }
}

// Optional exploit-lab pair (same-chain reference build, demoted below the
// cross-chain story). Both env vars must be set together; a lone one is a build
// error (a half-configured lab is worse than none). Unset → lab: null.
{
  const li = (process.env.LAB_INTERLOCK_ADDRESS ?? "").trim();
  const lv = (process.env.LAB_VAULT_ADDRESS ?? "").trim();
  if (li || lv) {
    if (!li || !lv) {
      console.error("[build] LAB_INTERLOCK_ADDRESS and LAB_VAULT_ADDRESS must be set together.");
      process.exit(1);
    }
    if (!IS_ADDR(li) || !IS_ADDR(lv)) {
      console.error("[build] lab addresses must be 0x + 40 hex each.");
      process.exit(1);
    }
    config.lab = { interlock: li, vault: lv };
  } else {
    config.lab = null;
  }
}

// 1. copy the static site (skip the build artifact, tooling, and hidden files)
mkdirSync(dist, { recursive: true });
const skip = new Set(["dist", "node_modules", "tools", "build.mjs", "package.json", "package-lock.json"]);
for (const name of readdirSync(here)) {
  if (name.startsWith(".") || skip.has(name)) continue;
  const p = join(here, name);
  if (statSync(p).isFile()) copyFileSync(p, join(dist, name));
}

// 2. bake the resolved config into the output the panel actually imports
writeFileSync(
  join(dist, "config.js"),
  "// GENERATED by build.mjs — do not edit.\n" +
    "// Source: Vercel env vars INTERLOCK_ADDRESS / VAULT_ADDRESS (and the\n" +
    "// optional LAB_INTERLOCK_ADDRESS / LAB_VAULT_ADDRESS pair), falling back\n" +
    "// to the committed defaults in frontend/config.js.\n" +
    `export const CONFIG = ${JSON.stringify(config, null, 2)};\n`,
);

console.log("[build] dist/ ready — panel will point at:");
console.log(`  genlayer guard (v3) ${config.interlock}`);
console.log(`  evidence vault      ${config.vault}`);
if (config.crosschain) {
  const m = config.crosschain;
  console.log(`  bridge sender       ${m.genlayer.bridge_sender}`);
  console.log(`  base vault          ${m.base_sepolia.vault}  (eid ${m.base_sepolia.eid}, chain ${m.base_sepolia.chain_id})`);
  console.log(`  base dispatcher     ${m.base_sepolia.dispatcher}`);
  console.log(`  manifest deployed   ${m.deployed_at ?? "(undated)"}`);
} else {
  console.log("  cross-chain         (no demo-manifest.json — panel renders as unconfigured)");
}
console.log(`  same-chain ref      ${config.lab ? config.lab.interlock + " / " + config.lab.vault : "(none — same-chain section inert)"}`);
