# Deterministic NLU matcher + coverage harness

Issue [#5](https://github.com/APTG/aidedx/issues/5) · part of #1 §6/§7 · Spike 2
(deterministic half).

The matcher turns a natural-language query into a
[`QueryIntent`](../src/lib/intent/query-intent.ts) using **only** a hand-written
grammar plus the libdedx [alias tables](./aliases.md) — no model. It is the
lower, certain half of the planned hybrid (deterministic ⊕ LLM) NLU. The
coverage harness measures how far it gets over the frozen
[eval set](../eval/README.md), which is the empirical justification for how much
LLM the project still needs.

## Layout

| File                          | Role                                                        |
| ----------------------------- | ----------------------------------------------------------- |
| `src/lib/intent/matcher.ts`   | the matcher: `matchIntent(text)` → `{ intent, … }`          |
| `src/lib/intent/coverage.ts`  | semantic comparison + report aggregation (`runCoverage`)    |
| `scripts/coverage-intents.ts` | CLI: `pnpm coverage:intents` (prints coverage % and misses) |

Both the matcher and the future LLM emit the **same** `QueryIntent` shape, so all
downstream code (resolver, compute, NLG) is producer-agnostic. The schema itself
is unchanged from issue #3 (#12) and treated as the single source of truth.

## Pipeline

1. **Quantity** — direct keywords (`stopping power`, `dE/dx`, `range`, `CSDA`),
   an **indirect-idiom table** (`"how far … will go"` → `csdaRange`,
   `"how quickly … loses energy"` → `stoppingPower`), and an inverse-query
   detector (`"what energy gives a 10 cm range …"` → `energyFromRange` /
   `energyFromStp`, populating `target`).
2. **Energies / target** — a number+unit grammar. Units fold to the schema enum
   (`keV` / `MeV` / `GeV` / `MeV/nucl` / `MeV/u`). Shared-unit value lists
   (`"50, 100, and 150 MeV"`) expand to one slot each.
3. **Particles** — named particles (`proton`, `alpha`, `deuteron`),
   `"<element> ion(s)"` heads, and coordinated lists (`"carbon and neon ions"`),
   resolved against the particle alias table.
4. **Materials** — an n-gram scan resolved against the material alias table,
   over the spans not already claimed by particles/energies.
5. **compareDim** — program-name detection (≥2 of ASTAR/PSTAR/Bethe/ICRU/…) then
   entity multiplicity (energy → material → particle).
6. **Resolver** — fuzzy-matches slots to real libdedx entities and fills
   `assumptions[]` and a calibrated `confidence`.

### Recorded assumptions

- **Isotope defaults.** A bare element ion takes its dominant stable isotope and
  records it (`"carbon → ¹²C"`); the slot carries `isotopeAssumed`.
- **Total vs per-nucleon.** A bare energy on a heavy (element-named) ion is read
  as **total**, flagged `perNucleonAssumed: false`, with a note
  (`"1200 MeV taken as total → 100 MeV/nucl"`). An explicit `/nucl` or `/u`
  energy is `perNucleonAssumed: true`. Named light particles (proton, alpha,
  deuteron) carry no per-nucleon flag.

## Coverage harness

```sh
pnpm coverage:intents            # prints coverage %, per-tag breakdown, misses
pnpm coverage:intents --threshold 90   # also fail if slot coverage < 90%
```

Comparison is **semantic, not string equality**: particles and materials are
compared by the libdedx entity they resolve to, so a correct `"carbon"` vs the
gold's `"carbon ions"` is not a miss — raw phrasing is cosmetic, the resolved
entity is not. Two figures are reported:

- **slot coverage** — quantity, compareDim, particles, materials, energies,
  target (entity identity; ignores phrasing & assumptions);
- **exact-intent** — slot coverage **and** assumptions.

It also prints a per-tag breakdown, a confidence-calibration table, and the
explicit list of **misses** — the candidates a future LLM (Spike 2) must cover.

## CI

`pnpm coverage:intents` runs in the CI `static-analysis` job as a **reported,
non-blocking** metric (`continue-on-error: true`; the script always exits 0). It
surfaces the number without gating the build, so a coverage regression is
visible in the logs but never red-lights an unrelated PR.

## Status (eval v0)

The deterministic matcher currently reaches **100% exact-intent coverage** of
eval v0 (0 misses). That is itself the finding: the v0 set lives within
deterministic reach, so scoping the LLM's territory (Spike 2) needs **harder,
adversarial** examples — novel idioms, ambiguous coordination, free-form units —
added to `eval/intents.jsonl`. The harness will surface them as misses the
moment they exist.
