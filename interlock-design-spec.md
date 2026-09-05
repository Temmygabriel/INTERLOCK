# Interlock — UI/UX & Frontend Design Spec

A design brief, not just a feature list — read section 1 before building any component.

---

## 1. The Design Concept

**Interlock looks like a real industrial safety panel — the kind bolted next to a
factory machine, with a status light and a reset that physically locks out when the
system trips.** A real safety interlock (a machine guard switch, an elevator door
interlock) has one job: the instant something dangerous is detected, it cuts power
automatically, and the reset is deliberately hard to reach — often requiring a key or
an authorized person — so nobody can casually undo the safety trip.

That physical object is the entire visual language here. The status light IS the
health of the target contract. The reset button IS the "unpause requires humans, not
AI" rule — and it should look *physically* locked when tripped, not just grayed out.

This is a deliberately different material reference than Preflight's paper inspection
tag or Ballast's brass ship instrument — industrial control-panel hardware, not
aviation paperwork or maritime brass.

**The one memorable moment, in 30 seconds:** the status light snaps from green to red
the instant consensus confirms a trip, and a physical-looking bar visibly slides
across the reset button with a "LOCKED — GOVERNANCE ONLY" label. No caption needed —
the panel itself tells the whole safety story.

### Self-check against generic AI-design defaults
- ❌ Not a dark-mode fintech dashboard with rounded cards.
- ❌ Not a reskin of Preflight or Ballast — different material, different domain.
- ✅ The status light, the readout, and the lock bar are all functionally real —
  every element maps to an actual state, nothing is decorative.

---

## 2. Design Tokens

### Color (safety-panel accurate, not decorative)
| Token | Hex | Use |
|---|---|---|
| `panel-housing` | `#26282B` | Base background — gunmetal panel housing |
| `panel-face` | `#3A3D40` | The panel surface itself, slightly lighter than housing |
| `status-running` | `#3B8B4A` | Status light when healthy, RUNNING state |
| `status-tripped` | `#C23B2E` | Status light when tripped, TRIPPED state |
| `hazard-yellow` | `#D9A22C` | Hazard stripe accents only — used sparingly, never as a fill |
| `readout-text` | `#E7E4DC` | Digital readout text on the panel face |

No colors beyond this set. Hazard yellow is a stripe accent at panel edges only —
never a background or text color, or it stops reading as a warning stripe.

### Type
- **Panel labels / headers:** Archivo Black (Google Fonts, free) — a stenciled,
  industrial-strength weight that reads like machine-part labeling.
- **Digital readouts** (coverage ratio, block numbers, timestamps): IBM Plex Mono —
  functionally motivated, real control-panel readouts are digital/monospace.
- Only these two typefaces. Body copy uses Archivo (regular weight, not Black).

### Layout concept
- A single panel object, centered, dark housing around it — this reads as one
  physical device sitting on a wall, not a dashboard of many floating cards.

---

## 3. Screens

### 3.1 The Panel (default view)

```
┌──────────────────────────────────────────────┐
│  ▮▮▮▮  INTERLOCK  ▮▮▮▮                          │
│                                                  │
│         ┌───────────┐                           │
│         │  ● RUNNING │   <- status light         │
│         └───────────┘                           │
│                                                  │
│   TARGET      DemoVault                         │
│   COVERAGE    142%                              │
│   LAST CHECK  block 9,102,441                    │
│                                                  │
│   ┌──────────────────────────┐                  │
│   │   RESET — LOCKED           │                 │
│   │   GOVERNANCE ONLY           │                │
│   └──────────────────────────┘                  │
└──────────────────────────────────────────────┘
```
- Status light is a filled circle, `status-running` green normally.
- Reset is shown locked/disabled by default — this is intentional, not a bug in the
  demo: Interlock's own logic can never unlock it.

### 3.2 Report Evidence (submission screen)

```
   ┌──────────────────────────────────┐
   │  REPORT SUSPECTED EXPLOIT           │
   │  ──────────────────────────────     │
   │  Target contract   [ DemoVault  ]    │
   │  Evidence tx hash   [ 0x8f2a...  ]   │
   │  Bond               [ 5 GEN      ]   │
   │                                       │
   │        [ Submit report ]             │
   └──────────────────────────────────┘
```

### 3.3 Verdict in progress (the hero animation)

```
   ┌──────────────────────────────────┐
   │  ● RUNNING  →  checking…             │
   │                                       │
   │  Pinned read       ✓ verified         │
   │  AI judgment         voting…            │
   └──────────────────────────────────┘
```
Validator votes resolve one at a time, similar in spirit to a checklist filling in —
each vote appears as a small chip landing (✓ agree / ✗ disagree), not a spinner.

### 3.4 Tripped state (the moment that matters)

```
   ┌──────────────────────────────────┐
   │         ● TRIPPED                    │
   │                                       │
   │   TARGET      DemoVault               │
   │   COVERAGE    38%  (was 142%)          │
   │   TRIPPED AT  block 9,102,447           │
   │                                        │
   │   ┌──────────────────────────┐         │
   │   │ ▓▓▓ RESET — LOCKED ▓▓▓      │        │
   │   │   GOVERNANCE ONLY            │       │
   │   └──────────────────────────┘         │
   └──────────────────────────────────┘
```
The status light flips red, the reset button's lock bar visibly slides across
(animated, ~500ms), and the coverage readout shows the before/after numbers plainly —
this is the moment a judge should remember.

### 3.5 Incident log (history view)

```
   ┌──────────────────────────────────┐
   │  INCIDENT LOG                        │
   │  ──────────────────────────────      │
   │  #003  DemoVault  TRIPPED  block 9,102,447 │
   │  #002  DemoVault  cleared  block 9,004,112 │
   │  #001  DemoVault  false report  rejected   │
   └──────────────────────────────────┘
```
A flat list, like a real safety-system event log — not a card grid.

---

## 4. Copy Guidelines

- Status vocabulary is fixed: **RUNNING**, **CHECKING**, **TRIPPED**. Never swap for
  generic words like "active/inactive."
- The reset button always says "LOCKED — GOVERNANCE ONLY" when tripped — never soften
  this to "Reset (coming soon)" or similar; the lock is a permanent design property,
  not a missing feature.
- A rejected/false report shows plainly as "false report — rejected," not hidden —
  this proves the system doesn't trip on demand.

---

## 5. Motion — the one deliberate moment

Only two built animations: (1) validator vote chips landing one at a time during
judgment, and (2) the status light flip plus the lock bar sliding across the reset
button on a confirmed trip. Everything else stays static and undecorated. Respect
`prefers-reduced-motion` — skip straight to the resolved state if set.

---

## 6. Build Notes for Claude Code / DeepSeek

- Fonts via `next/font/google`: Archivo Black (headers), IBM Plex Mono (readouts).
- The lock bar can be a simple `<div>` that translates across the button via CSS
  `transform: translateX()` — no animation library needed.
- No icon library needed — ✓ / ✗ and the status dot are simple shapes/typed
  characters, consistent with the control-panel-readout concept.
- If time is short, cut the incident log's polish before cutting the trip animation —
  the light-flip-and-lock is what makes this memorable in 30 seconds.
- This frontend only ever reads state the Intelligent Contract already computed
  (status, coverage ratio, last check block) — it does not duplicate any pinned-read
  or judgment logic client-side.
