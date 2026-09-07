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
// IMPORTANT — studionet resolves contracts by the EXACT address string
// (case-sensitive). These are the on-chain DEPLOY CARD pair exactly as
// deployed (chain 61999, gasless; persists on studionet — see PROGRESS.md).
// Copy them verbatim into the env vars — never change the case. (Compare the
// field values the contracts return, they come back in this same casing.)
export const CONFIG = {
  interlock: "0x2fB65F934618a17320c288d684aaB97dC00Ac300",
  vault: "0xCCB1fa65e9A85023324ccaA7aa44959b5BA448a7",
  // The dedicated exploit-lab pair — a vault the demo owns, where a live borrow
  // can push coverage under 100% and TRIP the breaker (the "Watch it happen"
  // + "Try it yourself" paths). When `lab` is set the page's live instrument
  // points at it; when null it falls back to the deploy-card pair above.
  // This pair is deployed fresh per demo (see PROGRESS.md #17/#18); the card
  // is written to repo-root `lab-card.json` (gitignored) by
  // `tests/integration/test_lab_deploy.py`. Env vars LAB_INTERLOCK_ADDRESS /
  // LAB_VAULT_ADDRESS override at build time (both-or-error in build.mjs).
  lab: {
    interlock: "0x970a345e99800D5eb9b49E3599396a0faC633FdC",
    vault: "0x429Ada2BC4a6E240418ECE8b883CE7060C0ff15A",
  },
};
