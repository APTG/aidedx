# Eval set v0 — `intents.jsonl`

Hand-labeled natural-language queries mapped to [`QueryIntent`](../src/lib/intent/query-intent.ts),
frozen as the **regression suite** reused by Spikes 1–2 (ASR, NLU) and the
deterministic matcher. This is the single highest-leverage artifact in the
project — see issue [#1 §14](https://github.com/APTG/aidedx/issues/1) and
[#3](https://github.com/APTG/aidedx/issues/3).

> **Numbers never come from an LLM.** These labels describe only _slot-filling_
> (language → structured intent). libdedx computes the physics downstream.

## Format

One JSON object per line (JSONL):

```jsonc
{
  "id": "rng-001", // stable, unique
  "text": "What is the range of 40 MeV protons in PMMA?",
  "audio": null, // optional; recorded-voice path filled LOCALLY in Spike 1
  "expected": {
    /* QueryIntent — see src/lib/intent/query-intent.ts */
  },
  "tags": ["direct", "quantity-csda-range", "single", "unit-MeV"],
}
```

`audio` is intentionally absent here. Voice clips are recorded on a local
machine during Spike 1 (ASR) and never committed — the eval set stays
text-first.

### `QueryIntent` (issue #1 §6)

The schema and its validators live in
[`src/lib/intent/query-intent.ts`](../src/lib/intent/query-intent.ts) so the
deterministic matcher, the LLM fallback, and this eval set all share one
definition. Fields:

| field         | notes                                                                                 |
| ------------- | ------------------------------------------------------------------------------------- |
| `quantity`    | `stoppingPower` \| `csdaRange` \| `energyFromRange` \| `energyFromStp`                |
| `compareDim`  | `none` \| `material` \| `particle` \| `program` \| `energy`                           |
| `particles[]` | `{ match, isotopeAssumed? }` — `match` is the raw phrase                              |
| `materials[]` | `{ match }`                                                                           |
| `energies[]`  | `{ value, unit, perNucleonAssumed? }`; unit ∈ keV/MeV/GeV/MeV/nucl/MeV/u              |
| `target?`     | **inverse queries only** — `{ value, unit }` for the given range / stopping power     |
| `program?`    | usually omitted → auto-select                                                         |
| `assumptions` | human-readable notes, e.g. `["carbon → ¹²C", "240 keV taken as total → 20 keV/nucl"]` |
| `confidence`  | producer confidence; **`1.0` for every gold label** (humans are certain)              |

**Deviation from the §6 draft:** `target` is an addition. The draft defined the
`energyFromRange` / `energyFromStp` quantities but had nowhere to store the
_given_ value of an inverse query (e.g. the "10 cm" in "what energy gives a
10 cm range in water?"). `target` holds it. `unit` is a free string because the
valid units differ by quantity (lengths like `cm`/`mm`/`g/cm2` for
`energyFromRange`; stopping-power units like `MeV/cm`/`MeV cm2/g`/`keV/um` for
`energyFromStp`).

### Labeling conventions

- **Isotope ambiguity.** A bare element name takes the dominant stable isotope
  and records it: `{ match: "carbon ion", isotopeAssumed: "¹²C" }` +
  `assumptions: ["carbon → ¹²C"]`. Defaults used: ¹²C, ⁴He, ²⁰Ne, ¹⁶O, ¹⁴N,
  ⁷Li, ⁴⁰Ar, ⁵⁶Fe. An _explicit_ isotope (`"carbon-13"`, `"helium-3"`) is taken
  verbatim with no assumption. `proton`/`alpha`/`deuteron` are unambiguous and
  carry no isotope assumption.
- **Total vs per-nucleon.** A bare energy on a multi-nucleon ion is read as
  **total** and flagged `perNucleonAssumed: false` with an assumption note
  (e.g. `"240 keV taken as total → 20 keV/nucl"`). The slot keeps the value/unit
  _as stated_; the resolver does the division. An explicit `/nucl` or `/u`
  energy is `perNucleonAssumed: true`. Protons (A = 1) omit the flag.
- **Comparisons.** Multiple values in one dimension set `compareDim` and a
  matching list length (≥ 2 materials / particles / energies).

## Tag taxonomy

A tag is **not** redundant with the intent — tags slice the set so spikes can
report accuracy per phenomenon (e.g. "deterministic coverage on `compare-*`",
"ASR error on `isotope-ambiguity`"). The validator rejects any tag outside this
list, so it stays a controlled vocabulary (source of truth: `EVAL_TAGS` in
`query-intent.ts`).

Each example carries **one phrasing**, **one quantity**, and **one comparison**
tag, plus any applicable unit / ambiguity / special tags.

| Group          | Tags                                                                                                       |
| -------------- | ---------------------------------------------------------------------------------------------------------- |
| **Phrasing**   | `direct`, `indirect`, `conversational-filler`                                                              |
| **Quantity**   | `quantity-stopping-power`, `quantity-csda-range`, `quantity-energy-from-range`, `quantity-energy-from-stp` |
| **Comparison** | `single`, `compare-material`, `compare-particle`, `compare-energy`, `compare-program`                      |
| **Units**      | `unit-keV`, `unit-MeV`, `unit-GeV`, `unit-mev-per-nucl`, `unit-mev-per-u`, `total-vs-per-nucleon`          |
| **Ambiguity**  | `isotope-ambiguity`, `has-assumption`, `program-specified`                                                 |
| **Special**    | `stress-test` (the two §7 sentences), `inverse-query`, `multi-energy`                                      |

Tag meanings:

- `direct` — the quantity word is present ("range", "stopping power", "dE/dx").
- `indirect` — quantity implied by idiom ("how far … will go", "how quickly …
  loses energy"). These are the LLM's job; the deterministic matcher leans on an
  idiom table.
- `conversational-filler` — politeness / hesitation wrapping the query ("um, so
  like…", "could you please…").
- `single` — exactly one entity per dimension (`compareDim: "none"`).
- `compare-*` — two or more entities in that dimension.
- `total-vs-per-nucleon` — a bare energy on a multi-nucleon ion that had to be
  interpreted as total.
- `isotope-ambiguity` — an element name that needed an isotope default.
- `has-assumption` — `assumptions[]` is non-empty (derivable, but handy for
  filtering the "surfaced assumption" UX tests).
- `program-specified` — the user named a program/model, or asked to compare
  programs.
- `inverse-query` — `energyFromRange` / `energyFromStp` (carries `target`).
- `multi-energy` — more than one energy in `energies[]`.
- `stress-test` — the two §7 worked examples; must always be present.

## Validating

The schema validator runs in CI (static-analysis job) and as a unit test:

```sh
pnpm validate:eval     # standalone Node CLI (prints tag coverage)
pnpm test              # Vitest also asserts ≥100 examples + required coverage
```

The validator checks JSON well-formedness, per-record schema conformance, id
uniqueness, tag-vocabulary membership, and the inverse-query `target` rule.

## Extending

1. Add lines to `intents.jsonl` (keep ids unique; prefix by category).
2. Use only tags from the taxonomy above (add new tags to `EVAL_TAGS` first if
   genuinely needed, and document them here).
3. Run `pnpm validate:eval` and `pnpm test`.
4. Keep the schema in `query-intent.ts` — do **not** fork it.
