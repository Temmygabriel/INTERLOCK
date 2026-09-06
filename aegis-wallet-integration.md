# Aegis wallet integration — design spec

*Distilled from the Rigor frontend (`components/IdentityBadge.tsx`, `components/Header.tsx`, `lib/identity.ts`). Use as a brief for the Aegis build.*

Design the wallet connection area for my app the way Rigor does it.

## Context

GenLayer (a chain where MetaMask can't sign — the app signs with a keypair created/stored IN THE BROWSER). So the UI must not pretend to be a normal "connect MetaMask" wallet — it's an honest browser-identity chip.

## Placement

A single compact chip in the top-right of the header, inside the nav, next to the page links. Rest of the header is the wordmark on the left.

## Closed state (the chip, one component, ~24px tall)

- A small "seal" dot icon, then the short address in monospace (e.g. `0x1A2B…9f3C`, first 4 + last 4 chars).
- A thin vertical divider, then a tiny caret that flips ▲/▼.
- While the identity is still loading/not ready: show "connecting…" muted.
- Whole chip is a single button — click toggles the menu.

## Open state (dropdown under the chip, right-aligned, ~320px wide)

Reads like a panel of labeled sections, each with a small UPPERCASE, letter-spaced, faint-gray micro-label, separated by hairline dividers. In order:

1. **Address row** — micro-label says the source ("Browser identity", or "MetaMask (display only)" if one was connected). The full address sits in a monospace "well" box (slightly recessed background), truncated with ellipsis, with a small ghost "Copy" button that flips to "Copied" for ~2s.

2. **Honesty notice** — a short margin-note callout (slightly indented, tinted background) stating plainly: *"Every transaction is signed by your browser-stored identity, not MetaMask."* No small print hiding it.

3. **Private key** — a ghost "Show private key" button. When revealed, show the full 64-hex key in a monospace box (`userSelect: all` so one click selects it) with "Copy private key", plus a warning: stored only in this browser; clear site data or switch devices and you lose it — save it if it holds funds.

4. **Recover wallet** — ghost "Import from private key" button that expands an inline form: a password-type monospace input, LIVE validation that previews the address that key would recover ("Recovers: 0x…") BEFORE the user commits, inline error in red for a bad key, then Recover / Cancel buttons. If the pasted key is already the active one, confirm and say "nothing changed" instead of churning. Recovering swaps the whole signer.

5. **MetaMask (optional, display-only)** — a "Connect MetaMask (display only)" button. If connected, its address shows as reference with a "Signer (actual): …" line underneath clarifying it is NOT what signs. If MetaMask isn't installed, show a short inline error. This section exists to answer "why can't I just use MetaMask?" honestly, not to be a real wallet flow.

6. **Danger** — at the very bottom, a red ghost "Generate new identity" button. Confirm dialog warns the current address stays on-chain but this browser will act as a different address from now on.

## Visual language

Academic / research aesthetic, not crypto-neon. Monospace throughout for anything technical (addresses, keys, micro-labels). Faint uppercase labels, hairline dividers, recessed "well" inputs, small ghost buttons. Error text in red, success/confirmation in green. Dropdown has a subtle raised-gradient background, hairline border, soft card shadow, rounded corners; closes on outside click and resets all ephemeral state (shown key, copied flags, import form) each time it reopens.

## Mechanics

The identity is a real keypair generated on first visit and persisted in localStorage (never send the private key anywhere). Everything signs locally with that key. The badge and menu are one self-contained client component fed by a small auth/identity provider (`ready` flag + `identity` + `reset` + `importIdentity`).

Don't build a fake "connected ✓" green dot when nothing network-y happened — the state is: *identity exists (you have a signer)* vs *doesn't*. Keep it honest, quiet, and readable.
