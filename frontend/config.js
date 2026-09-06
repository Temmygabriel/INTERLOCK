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
};
