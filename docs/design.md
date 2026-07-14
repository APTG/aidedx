# Voice-first, fully-local AI front-end to libdedx — design & prototyping plan

> Originally filed as [issue #1](https://github.com/APTG/aidedx/issues/1) on 2026-06-25 — the
> project's founding design doc. Captured here as the versioned reference that other issues and
> docs cite as "Part of #1 §N": a GitHub issue body isn't diffable or linked from code the way a
> file in `docs/` is, so this page is now the source of truth for the design, and the issue itself
> is closed.
>
> **This is the original plan, preserved close to verbatim** (only the now-obsolete
> draft-in-`dedx_web` transfer note has been dropped, and one lost template placeholder in §5 has
> been reconstructed). Several premises below have since been revised by real measurement — most
> substantially in [`docs/voice-pipeline-feasibility.md`](./voice-pipeline-feasibility.md) §4
> ("What changed vs the issue #1 design and why"), which is the doc to read for the _current_
> architecture. Treat this page as history: it explains why the project is shaped the way it is,
> not necessarily what it does today.

## 1. Summary

Build **aidedx** — a standalone, voice-first web app that lets a user _speak_ a stopping-power /
range question and get an answer computed by **libdedx**, with **all inference running locally in
the browser** (no audio, no text, nothing leaves the device).

Example interaction:

> 🎤 _"What is the range of 40 MeV protons in PMMA?"_
> → _"The CSDA range of a 40 MeV proton in PMMA is 1.42 g/cm², about 12 mm."_ (spoken + displayed,
> with an "Open full plot →" link into dedx_web)

The app targets users with capable local hardware (e.g. Apple-silicon MacBooks) but **must also
work, more slowly, on machines without a GPU**.

## 2. Motivation

- dedx_web is precise but form-driven; a conversational entry point lowers the barrier for quick
  "what's the range of X in Y?" questions.
- **Privacy is a first-class feature**, not a nice-to-have: nothing is sent to any server. This is
  a genuine differentiator for clinical / research users.
- It is a showcase for fully client-side ML on a static host (GitHub Pages / Cyfronet), with no
  backend to run or pay for.

## 3. Goals / non-goals

**Goals**

- Speech → answer, entirely client-side.
- Handle a **wide variety of natural phrasings**, including indirect wording and **comparison**
  queries (multiple materials / particles / energies).
- Graceful degradation: works without WebGPU (CPU/WASM), and falls back to typed input when speech
  is unavailable.
- **Trustworthy & correctable**: every parsed slot and every assumption is shown and editable.
  Numbers always come from libdedx — never from the LLM.
- Reuse libdedx and interoperate with dedx_web (deep links).

**Non-goals (for v1)**

- General physics chit-chat / open-ended Q&A.
- Letting the LLM compute or estimate physical quantities.
- Multi-turn dialogue memory beyond a simple per-session transcript.
- Mobile-first optimization (desktop with a mic is the primary target).

## 4. Hard constraints / principles

1. **No network inference.** ASR, NLU, and TTS all run locally. The only network traffic is the
   one-time download of model weights (cached thereafter).
2. **The LLM never produces numbers.** Its sole job is _slot-filling_: turn language into a
   structured `QueryIntent`. libdedx does all physics.
3. **Every assumption is surfaced.** Isotope defaults, total-vs-per-nucleon energy interpretation,
   auto-selected program — all shown as editable chips with a human-readable note.
4. **Static-host friendly.** Deployable to GitHub Pages / Cyfronet; no server-side component.

## 5. Architecture (pipeline)

```
🎤 mic (getUserMedia + voice-activity detection to trim silence)
   │
   ▼
ASR   speech → text     Whisper via transformers.js (WebGPU; WASM/CPU fallback)
   │                    NOT the browser Web Speech API (Chrome streams audio to Google)
   ▼
NLU   text → intent     HYBRID:
   │                      (a) deterministic matcher  (grammar + units + synonym tables)
   │                      (b) small local LLM fallback for low-confidence / odd phrasing
   │                          → grammar-constrained JSON decoding
   │                    Output: QueryIntent (see §6)
   ▼
Resolver intent → IDs   fuzzy-match slots against the real libdedx entity lists +
   │                    alias/synonym tables; apply + record assumptions
   ▼
Compute                 LibdedxService (vendored from dedx_web). Supports single &
   │                    comparison (multi-material / -particle / -program) queries.
   ▼
NLG   result → text     templated sentence: "{quantity} of a {energy} {particle} in
   │                    {material} is {value} ({program})."
   ▼
TTS   text → speech     SpeechSynthesis (local) or Piper/Kokoro WASM
   │
   ▼
UI    transcript turn   recognized text + editable slot chips + answer + "Open in dedx_web →"
```

**Tiered, auto-detected runtime**: deterministic NLU → (low confidence) → LLM. LLM backend is
chosen by capability: **WebGPU if present, else WASM/CPU**, with a manual override.

## 6. `QueryIntent` schema (draft)

The schema must support **comparisons** and **explicit assumptions**, not just single lookups.

```ts
interface QueryIntent {
  quantity: "stoppingPower" | "csdaRange" | "energyFromRange" | "energyFromStp";
  compareDim: "none" | "material" | "particle" | "program" | "energy";
  particles: { match: string; isotopeAssumed?: string }[];
  materials: { match: string }[];
  energies: {
    value: number;
    unit: "MeV" | "keV" | "GeV" | "MeV/nucl" | "MeV/u";
    perNucleonAssumed?: boolean;
  }[];
  program?: string; // usually omitted → auto-select (reuse dedx_web logic)
  assumptions: string[]; // e.g. ["carbon → ¹²C", "240 keV taken as total → 20 keV/nucl"]
  confidence: number; // drives deterministic→LLM escalation and UI warnings
}
```

The deterministic matcher and the LLM emit the **same** schema, so downstream code is identical
regardless of which produced it.

## 7. Handling phrasing variety (worked examples)

These two sentences are the design's stress tests and should be in the eval set (§14).

### 7.1 "I am curious how far in water the 240 keV carbon ion will go"

| Slot     | Resolution                                           | Difficulty                                                                       |
| -------- | ---------------------------------------------------- | -------------------------------------------------------------------------------- |
| quantity | "how far … will go" → `csdaRange`                    | **Indirect** — no word "range". Needs idiom table; otherwise LLM.                |
| particle | "carbon ion" → Z=6, default ¹²C                      | Isotope ambiguity → `assumptions: ["carbon → ¹²C"]`                              |
| energy   | "240 keV", no "/nucl" → total → 240/12 ≈ 20 keV/nucl | **Total-vs-per-nucleon** ambiguity → `perNucleonAssumed:false` + assumption note |
| material | water → 276                                          | easy                                                                             |

### 7.2 "compare stopping power of neon ions in water and air for 100 MeV/nucl"

| Slot     | Resolution                          | Difficulty                                                         |
| -------- | ----------------------------------- | ------------------------------------------------------------------ |
| quantity | stopping power                      | easy                                                               |
| particle | neon → Z=10                         | easy                                                               |
| energy   | 100 MeV/nucl (explicit per-nucleon) | unambiguous                                                        |
| material | water **and** air                   | **Comparison** → `compareDim:"material"`, `materials:[water, air]` |

**Coverage expectation:** 7.2 is largely deterministic (clear keywords + two material matches +
"compare" trigger). 7.1 leans on the LLM (indirect quantity + isotope/energy disambiguation). This
split is the core justification for the hybrid approach.

**Comparison intents map onto features dedx_web already has** (multi-entity / multi-program) and
onto its shareable-URL grammar — so the answer can include a ready-made comparison-plot deep link.

## 8. CPU (no-GPU) strategy

Many curious users will lack WebGPU; they must still be able to run the LLM, slower.

- **Backend:** WebLLM is effectively WebGPU-only, so the CPU path uses **transformers.js (ONNX
  Runtime Web)** or **wllama (llama.cpp WASM)**.
- **Threading caveat on GitHub Pages:** fast WASM inference wants `SharedArrayBuffer` → COOP/COEP
  cross-origin-isolation headers, which **GitHub Pages cannot set**. Mitigations to evaluate: the
  **`coi-serviceworker`** header-injection trick, or hosting aidedx on **Cyfronet** (full header
  control). _Must be validated in a spike (§13)._
- **It's tolerable because output is tiny:** ~30–80 tokens of JSON, not prose. Even ~few tok/s →
  ~10–30 s. The deterministic layer means most queries never hit the LLM on CPU at all.
- **Progress UX (CPU path):** separate the two waits —
  1. one-time **model download** (byte progress, "80 MB — cached after first use"),
  2. **inference** (stream tokens so slot chips visibly fill in; show elapsed time; a distinct
     "warming up model…" state for the first call).
     Plus an upfront "no GPU detected — answers take ~N s, runs entirely on your machine" notice so
     slowness reads as _private_, not _broken_.

## 9. Integration with dedx_web

- **libdedx sharing (decision needed, see §17):** start by **vendoring the prebuilt `libdedx.mjs` +
  `libdedx.wasm` (~457 KB)** + a thin wrapper; plan toward **extracting a shared
  `@aptg/libdedx-wasm` package** from `dedx_web/src/lib/wasm/` (the `LibdedxService` is already
  fully specified in `docs/06-wasm-api-contract.md`). Do **not** maintain a second Emscripten
  build.
- **Deep-link handoff:** aidedx emits **dedx_web `urlv=2` shareable URLs**, so every answer can
  carry an "Open full plot / calculator →" link that lands in dedx_web pre-filled. This keeps the
  two apps complementary (aidedx = conversational entry; dedx_web = deep analysis) instead of
  duplicating the calculator/plot UI.
- **Synonym tables are reusable both ways:** the material/particle alias map (e.g. PMMA / Lucite /
  Perspex / Plexiglas → one ICRU material) also improves dedx_web's existing text search.

## 10. Tech stack (proposed)

Mirror dedx_web for consistency: **SvelteKit + Svelte 5 (runes only) + TypeScript (strict) +
Tailwind v4 + static adapter**. Heavy ML libs (transformers.js / WebLLM / wllama) are
**dynamic-imported** only when the mic is first used, so the shell loads instantly.

## 11. Model hosting & caching (Cyfronet S3)

- Versioned artifact paths, e.g. `/aidedx/models/whisper-base-q8/v1/…`,
  `/aidedx/models/qwen2.5-0.5b-q4/v1/…`.
- Requirements: **CORS** (`Access-Control-Allow-Origin: *`), **HTTP range requests** (shard/range
  fetches), correct `Content-Type`.
- Browser caching via **Cache API** (transformers.js does this by URL automatically) and/or
  **OPFS** (WebLLM); **key by version** so a bump invalidates cleanly.
- One-time **download-progress UI** + integrity check.

## 12. Trust & correctability UX

The single biggest risk for a _scientific_ voice tool is a confident wrong answer. Mitigations:

- Live transcript of exactly what Whisper heard.
- Parsed query shown as **editable chips**: `[range] [proton] [40 MeV] [PMMA]`. Tap to correct a
  mis-resolved slot. Corrections are valuable future training signal.
- **Assumptions panel** rendering `QueryIntent.assumptions[]` verbatim.
- Answer text + speech; the number is always labeled with its libdedx provenance (program, units).

## 13. Prototyping spikes (do this before final design)

This is research-y; several unknowns are empirical. Each spike answers **one** question and has a
pass/fail criterion. They share a common **eval set** (§14).

- [ ] **Spike 1 — ASR accuracy on domain jargon.** Record ~30 sentences (incl. §7 examples). Run
      Whisper tiny/base/small at q8/q4. Measure error on _slot-bearing tokens_ ("240 keV",
      "MeV/nucl", "PMMA", "Bragg", "neon"). Test Whisper `initial_prompt` vocabulary biasing and a
      post-correction pass.
      **Pass:** ≥95% correct on slot-bearing tokens for the chosen variant. **Output:** chosen
      Whisper variant; whether post-correction is needed.
- [ ] **Spike 2 — NLU quality.** Deterministic-matcher coverage over the eval set; then
      Qwen2.5-0.5B/1.5B and Llama-3.2-1B, few-shot + grammar-constrained JSON, on the misses.
      **Pass:** ≥90% exact-intent accuracy on the eval set (hybrid). **Output:** few-shot vs
      fine-tune decision; chosen model.
- [ ] **Spike 3 — Runtime & caching reality.** Measure download + warmup + inference latency,
      **GPU vs CPU** (WASM, with/without `coi-serviceworker` threads). Confirm Cache API/OPFS
      persistence survives reloads on GitHub Pages; validate (or rule out) the COOP/COEP
      service-worker trick.
      **Pass:** GPU end-to-end < ~3 s; CPU < ~30 s with working progress UI; weights cached across
      reloads. **Output:** backend strategy + progress-UX targets + hosting decision (GH Pages vs
      Cyfronet).
- [ ] **Spike 4 — Trust loop (small).** Editable-chip correction + dedx_web deep-link handoff
      end-to-end.
      **Pass:** a mis-resolved slot can be corrected and recomputed; deep link opens dedx_web
      pre-filled.

## 14. Eval set (build first — highest leverage)

~100 hand-labeled sentences → `QueryIntent`, covering: direct & indirect phrasing, conversational
filler, comparison (multi-material / -particle / -energy), unit variety (keV/MeV/GeV, MeV/nucl vs
MeV/u, total-vs-per-nucleon), isotope ambiguity, inverse queries ("what energy gives a 10 cm range
in water?"). Reused by Spikes 1–2 and frozen as the **regression suite**. Format: JSONL of
`{ audio?, text, expected: QueryIntent }`.

## 15. Synonym / alias tables (build early)

Highest-leverage accuracy artifact and reusable by dedx_web search. Seed from libdedx's ALL-CAPS
NIST names + `PARTICLE_ALIASES`. Examples: PMMA/Lucite/Perspex/Plexiglas → ICRU PMMA; water → 276;
proton/p → H; alpha → He; common ion names → Z.

## 16. Phasing

- **Phase 0** — Spikes 1–4 + eval set (this issue's checklist).
- **Phase 1** — Repo scaffold, ASR module, Cyfronet model manager + caching, libdedx vendored.
- **Phase 2** — Deterministic NLU + synonym tables + resolver; drive compute; trust-chip UX.
- **Phase 3** — LLM fallback (few-shot + constrained JSON); auto GPU/CPU backend selection.
- **Phase 4** — (if Spike 2 says so) synthetic dataset + LoRA fine-tune + eval harness + S3 export.
- **Phase 5** — TTS + answer templating + accessibility + deep-link polish.

## 17. Open questions / decisions

- [ ] Hosting: GitHub Pages (+ `coi-serviceworker`) vs Cyfronet (native COOP/COEP)? — depends on
      Spike 3.
- [ ] libdedx sharing: vendor now / extract `@aptg/libdedx-wasm` later — confirm timing.
- [ ] ASR engine: transformers.js Whisper vs whisper.cpp WASM — Spike 1.
- [ ] LLM: model + few-shot vs fine-tune — Spike 2.
- [ ] TTS: SpeechSynthesis (note: some browsers use cloud voices) vs Piper/Kokoro WASM (fully
      local).
- [ ] Isotope & total-vs-per-nucleon **default conventions** — needs a physicist sign-off.

## 18. Risks

| Risk                                 | Mitigation                                                                           |
| ------------------------------------ | ------------------------------------------------------------------------------------ |
| Whisper mis-transcribes domain terms | `initial_prompt` biasing + post-correction (Spike 1); editable transcript            |
| LLM emits wrong/invalid intent       | Grammar-constrained JSON; deterministic-first; editable chips; never compute numbers |
| CPU inference too slow               | Deterministic layer handles most queries; smallest model; clear progress UX          |
| GH Pages can't enable WASM threads   | `coi-serviceworker` or host on Cyfronet (Spike 3)                                    |
| Wrong answer trusted by user         | Surfaced assumptions + provenance + correction loop (§12)                            |

## 19. References

- dedx_web WASM API contract: `docs/06-wasm-api-contract.md` (the `LibdedxService` "tool surface")
- dedx_web architecture: `docs/03-architecture.md`
- dedx_web shareable-URL grammar: `docs/04-feature-specs/shareable-urls-formal.md` (deep-link
  target)
