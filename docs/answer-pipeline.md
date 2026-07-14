# Answer pipeline: matcher → compute → NLG → UI state

Issue [#39](https://github.com/APTG/aidedx/issues/39) (the original wiring) ·
polish batch [#42](https://github.com/APTG/aidedx/issues/42) §2/§3/§4 (unit
conversion, error formatting).

[`docs/nlu.md`](./nlu.md) documents the first half of the pipeline — turning
text into a [`QueryIntent`](../src/lib/intent/query-intent.ts). This doc picks
up where that one stops: what happens to a `QueryIntent` _after_ it's been
produced, whether the text came from the typed query box or a Whisper
transcript (issue #37/#39 — both go through the exact same code path). That's
four stages: resolve real libdedx numbers, render them as plain-text answer
lines, and drive the small state machine the UI reads from.

## Layout

| File                                          | Role                                                          |
| --------------------------------------------- | ------------------------------------------------------------- |
| `src/lib/answer/answer-status.svelte.ts`      | orchestrator + reactive UI state (`answerStatus.submit()`)    |
| `src/lib/compute/compute.ts`                  | `QueryIntent` → real libdedx numbers (`computeIntent()`)      |
| `src/lib/nlg/render.ts`                       | `ComputeResult` → plain-text answer lines (`renderAnswer()`)  |
| `src/lib/format.ts`                           | number/unit formatting shared by `render.ts` and `compute.ts` |
| `src/lib/wasm/` (see [`wasm.md`](./wasm.md))  | the vendored libdedx WASM wrapper `compute.ts` calls into     |
| `src/lib/components/answer/AnswerCard.svelte` | renders `answerStatus`'s lines/message for the current phase  |

## Pipeline

```
text ──matchIntent()──▶ QueryIntent ──computeIntent()──▶ ComputeResult ──renderAnswer()──▶ string[]
        (matcher.ts)                    (compute.ts)                       (render.ts)
```

`answerStatus.submit(text)` (`answer-status.svelte.ts`) is the single entry
point for both the typed form and the mic transcript effect in
`+page.svelte` — there is exactly one code path from "text" to "answer"
regardless of how the text arrived.

1. **Match.** `matchIntent(text)` (deterministic NLU, see [`nlu.md`](./nlu.md))
   returns `{ intent, confidence, incomplete, … }` synchronously. If
   `intent.confidence` is below `CONFIDENCE_THRESHOLD` (0.55), `submit()`
   stops here: `phase` becomes `"unmatched"` and `message` is a fixed
   "couldn't understand" string suggesting a worked example. Nothing below
   this line ever sees a low-confidence guess.

2. **Compute.** `computeIntent(intent, service)` (`compute.ts`) resolves the
   intent's particle/material phrases to libdedx entity ids (the
   [alias tables](./aliases.md)), converts energies to MeV/nucl, auto-selects
   a stopping-power program (or honors an explicit one), and calls into the
   libdedx WASM wrapper (`service: LibdedxService`, see [`wasm.md`](./wasm.md)).
   Every number in the result originates in libdedx — never the LLM/matcher.

   - **Forward** quantities (`stoppingPower`, `csdaRange`) return one
     `ComputePoint` per requested energy, plus the series' `program` and
     material `density` (g/cm³, from `service.getDensity()`).
   - **Inverse** quantities (`energyFromRange`, `energyFromStp`) solve for the
     energy that produces the intent's `target` value.
   - Comparison queries (`compareDim !== "none"`) fan out into several
     `ComputeSeries` (one per compared material/particle/program) or, for
     `compareDim: "energy"`, one series with multiple points.
   - A **per-series failure** (energy out of libdedx's supported range, an
     unresolvable material, …) is recorded as `series.error` rather than
     thrown, so one bad leg of a comparison doesn't take down the others.
     Structural problems (an intent with no particle at all) throw
     `ComputeError` instead — those indicate a matcher bug, not a bad query.

3. **Render.** `renderAnswer(intent, result)` (`render.ts`) is a template
   lookup, not generated text: every number/unit/program name comes from the
   `ComputeResult`, and particle/material phrases are echoed back verbatim
   from the intent's own `match` strings (so the answer reflects the user's
   wording, not a re-derived canonical name). `compareDim: "none"` produces a
   single sentence; anything else produces a header line plus one
   `"- label: value (program)"` line per series/point. A trailing
   `assumptions[]` note (isotope defaults, total→per-nucleon reads) is
   appended when present.

4. **UI state.** `answerStatus`'s `phase` (`"idle" | "computing" | "answered" |
"unmatched" | "error"`) and `lines`/`message` are what `AnswerCard.svelte`
   renders. A monotonic `#requestId` guards the only `await` in `submit()`
   (`getService()`, which lazily loads the WASM module) — a slower, earlier
   `submit()`/`reset()` call can't clobber a faster, later one's result.

## Display units: converting away from libdedx's native units

libdedx's native output units are **mass-normalized**: stopping power in
MeV·cm²/g, CSDA range in g/cm² (areal density). Physicists read tables in
these units, but they're not what most users expect from a conversational
answer — dedx_web's convention (and issue #42 §2/§3) is **linear** stopping
power in keV/µm and a **physical length** for range, auto-scaled to whichever
of nm/µm/mm/cm/m/km reads best for the magnitude. Both conversions need the
target material's density (g/cm³), which is why `ComputeSeries` carries a
`density?: number` field (populated in both `forwardSeries()` and
`inverseSeries()` via `service.getDensity(material.id)`).

The actual conversion happens in `render.ts`'s `valueText()`, using helpers
from `format.ts`:

- `stoppingPowerToKevPerUm(massStpMevCm2PerG, densityGPerCm3)` — MeV·cm²/g ×
  g/cm³ = MeV/cm, then a flat ×0.1 to keV/µm.
- `csdaRangeToCm(csdaRangeGPerCm2, densityGPerCm3)` — divides the areal range
  by density to get a physical length in cm.
- `formatLengthCm(cm)` — auto-scales that length to nm/µm/mm/cm/m/km, picking
  the largest unit whose magnitude is still ≥ 1 (falling back to nm for
  anything smaller than that).

When `density` is `undefined` (`getDensity()` failed for that material —
libdedx doesn't have density data for every entry), `valueText()` falls back
to the native MeV·cm²/g / g/cm² unit rather than fabricating a conversion.
Inverse-quantity results (`energyFromRange`/`energyFromStp`) are unaffected —
they render the solved-for energy in MeV/nucl either way.

`format.ts` also has a generic significant-figure formatter
(`formatSignificant`, 4 sig figs) that `render.ts`'s public `formatNumber` and
the two unit-scaling helpers above all share, and `formatEnergyPerNucleon`
(keV/MeV/GeV per nucleon), used below for readable out-of-range errors rather
than for answer values.

## Error messages

Two kinds of "this query didn't work" surface through the same
`series.error` → `renderAnswer()` → `AnswerCard` path, but originate in
different layers:

- **Out-of-range energy.** `compute.ts`'s `energyBoundsError()` checks every
  requested energy against `service.getMinEnergy()`/`getMaxEnergy()` for the
  chosen (program, particle) _before_ calling into the WASM integrator, so an
  absurd energy (e.g. `1e7` MeV) fails fast with a clear message instead of
  invoking a potentially expensive/recursive calculation. libdedx's bounds
  come back as raw MeV/nucl floats (`0.0002500000118743628`); the message
  formats both ends with `formatEnergyPerNucleon()` — "outside the valid
  range 250 keV/nucl to 250 MeV/nucl for this program/particle" — instead of
  dumping `[0.00025, 250]` verbatim (issue #42 §4).
- **Everything else** (unresolvable material/particle, a failed WASM call, a
  missing inverse target) is caught and stored as `series.error` at the point
  it happens, with the underlying error's own message.

`render.ts` never reformats `series.error` beyond interpolating it into the
sentence (`compareLine()`, `singleSentence()`) — the message has to already
be presentable by the time it reaches `series.error`.

## Input validation

Two independent guards keep a malformed value from silently reaching
`computeIntent()`:

- **`matcher.ts`.** The energy grammar's `\d+` never captures a leading sign,
  so without an explicit check, "-100 MeV" would silently parse as "100 MeV"
  — the minus sign just disappears rather than producing an error. Every
  extracted energy is checked for a `-` sign directly before it
  (`isNegativeAt()`); a negative energy is dropped from the `energies[]`
  slot entirely (its span still excluded from material matching, so the unit
  token isn't re-mined as a material name). Dropping the slot makes the
  intent `incomplete`, which caps `confidence` at 0.4 — well below the 0.55
  gate in `answer-status.svelte.ts` — so the query reads as "couldn't
  understand" rather than quietly running with the sign stripped off.
- **`validateQueryIntent()`** (`query-intent.ts`) enforces the same
  "positive finite number" rule on `energies[].value` and `target.value` at
  the schema level, independent of which producer (matcher or a future LLM
  fallback) built the intent. This is what `eval/intents.jsonl` and
  `scripts/validate-intents.ts` check against — it doesn't run on the live
  `matchIntent()` output, so the matcher-level guard above is what actually
  protects the running app.

## See also

- [`docs/nlu.md`](./nlu.md) — the matcher/coverage half (text → `QueryIntent`).
- [`docs/aliases.md`](./aliases.md) — the particle/material alias tables
  `compute.ts` resolves phrases against.
- [`docs/wasm.md`](./wasm.md) — the `LibdedxService` contract `compute.ts`
  calls into.
