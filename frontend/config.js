// config.js — deployment configuration for the Interlock safety panel.
//
// Where the addresses come from — two modes:
//
//   1. PLAIN STATIC SERVE (no build step): this file IS the config. The
//      defaults below are used as-is.
//
//   2. VERCEL WITH BUILD STEP (recommended for env-var control): `node
//      build.mjs` regenerates dist/config.js from the Vercel environment
//      variables INTERLOCK_ADDRESS and VAULT_ADDRESS. Set them in the Vercel
//      dashboard (Project → Settings → Environment Variables); when a var is
//      left unset the build falls back to the default in THIS file. The
//      committed file never needs editing for a Vercel deploy.
//
// IMPORTANT — studio-dev (chain 61997) resolves contracts by the EXACT address
// string (case-sensitive). These are the on-chain DEPLOY CARD pair exactly as
// deployed and verified live (see PROGRESS.md #27). Copy them verbatim into the
// env vars — never change the case. (Compare the field values the contracts
// return, they come back in this same casing.)
export const CONFIG = {
  interlock: "0x5065182839094a008208Ca34Fe9f1a3A84e19d21",
  vault: "0x5E498456dB246a36E9A7e45eF87E235e7eBB14c6",
  // The dedicated exploit-lab pair — a vault the demo owns, where a live borrow
  // can push coverage under 100% and TRIP the breaker (the "Watch it happen"
  // + "Try it yourself" paths). When `lab` is set the page's live instrument
  // points at it; when null it falls back to the deploy-card pair above.
  // This pair is deployed fresh per demo (see PROGRESS.md #17/#18); the card
  // is written to repo-root `lab-card.json` (gitignored) by the lab deployer.
  // Env vars LAB_INTERLOCK_ADDRESS / LAB_VAULT_ADDRESS override at build time
  // (both-or-error in build.mjs). On studio-dev the dedicated lab pair IS the
  // deploy-card pair above (deployed 2026-09-08, audit_len 4, coverage 271% —
  // healthy, RUNNING). Once a demo trips it the pair is spent — redeploy for
  // the next run (see PROGRESS.md / v3-crosschain/DEPLOY-NOTES.md).
  lab: {
    interlock: "0x5065182839094a008208Ca34Fe9f1a3A84e19d21",
    vault: "0x5E498456dB246a36E9A7e45eF87E235e7eBB14c6",
  },
};
