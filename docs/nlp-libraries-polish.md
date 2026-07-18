# NLP libraries for aidedx? — assessment ahead of Polish support

_Session report, 2026-07-16. Question posed: would a natural-language-processing library help in
the **matcher** (`src/lib/intent/matcher.ts`) or the **Whisper-correction layer**
(`scripts/asr-correct*.mjs`), given that the current code risks becoming hard to maintain once
**Polish** is added?_

## TL;DR

**A general NLP library is the wrong tool here, but the maintainability worry is right — and it has
a concrete fix that is mostly architectural, plus two narrow library fits.**

- This is **closed-vocabulary slot-filling, not open NLU** (see `docs/design.md` §4 and
  `docs/voice-pipeline-feasibility.md` §4). The vocabulary is a few dozen materials, ~20 particles,
  a handful of quantity phrasings, and a fixed unit set. General NLP toolkits (spaCy, Stanza, NLTK,
  Morfeusz, Morfologik) are built for open-domain parsing and are **Python/Java/C++** — they cannot
  run in a static, server-less GitHub-Pages app (`docs/design.md` §4.4 "no server-side component").
  They would add weight and a build/runtime mismatch for little gain.
- **What actually multiplies with Polish is _morphology_, not parsing difficulty.** Polish is
  highly fusional: nouns decline through 7 cases and word order is free. `woda` (water) appears as
  `wody / wodzie / wodą / wodę`; `proton` as `protonu / protonów / protony / protonem`. Any table
  keyed on English surface forms (the alias tables, the `MATERIAL_STOPWORDS` set, the idiom regexes)
  either explodes into every case form or needs a lemmatizer.
- **The highest-leverage move is a refactor, not a dependency:** split both the matcher and the
  corrector into a **language-neutral core** (span arithmetic, number grammar, unit folding, entity
  resolution, confidence) plus swappable **per-language packs** (idioms, quantity synonyms,
  stopwords, phonetic rules). No NLP library is needed for this, and it is the change that keeps a
  two-language codebase maintainable.
- **Two genuine, browser-friendly library fits, both narrow:** (1) **language detection** to route
  EN vs PL (`franc`, ~a few KB, pure JS); (2) **phonetic/edit-distance building blocks** (`talisman`,
  or `natural`) to seed the phonetic-lexicon corrector already planned in
  `docs/voice-pipeline-feasibility.md` §5.1 — though for a closed lexicon the repo's own
  `boundedLevenshtein` plus a small Polish grapheme table is competitive and dependency-free.
- **Use Polish morphology tooling at _build time_, not runtime.** The good Polish analyzers
  (**Morfeusz 2**, **Morfologik**) can _generate_ every inflected form of a lemma offline. Run one
  as a `scripts/generate-aliases.ts`-style generator to emit inflected alias tables; ship only the
  resulting JSON. This gets Polish coverage without a heavyweight runtime dependency.
- **The most maintainable Polish path may be to lean harder on the LLM slot-filler** that
  `docs/design.md` §5 already contemplates. A multilingual small LLM absorbs Polish inflection and
  free word order "for free" from one prompt covering both languages — no hand-written Polish
  grammar. The cost is the CPU latency/RAM already analyzed in
  `docs/voice-pipeline-feasibility.md` §2.5/§5.6. This is a real trade, not a free lunch.
- **One concrete bug to fix first (independent of any library):** `normalizeText()` folds most
  Polish diacritics via NFKD (`ą→a`, `ó→o`, `ś→s`, `ż→z`, `ć→c`) **but not `ł`** — it is a
  precomposed letter (U+0142) with no combining-mark decomposition, so `ołów → "ołow"`,
  `łuk → "łuk"` survive un-normalized and will silently miss the alias index.

## Status update (2026-07-18) — issue #87

This report was written on a branch that was never merged; the findings below are landing two days
later, after the recommended refactor was independently carried out (issue #26/#28's implementation
work). Re-verified against the current codebase rather than assumed:

- **Matcher core + `lang/{en,pl}.ts` packs (§2.3.1, §3.1) — done.** `src/lib/intent/matcher.ts`
  (784 lines) is the language-neutral core; `src/lib/intent/lang/{types,en,pl}.ts` (72/254/241
  lines) hold the per-language idiom/keyword/stopword/particle-grammar data, selected via
  `packFor(lang)` in `matchIntent(text, lang)`.
- **Corrector shipped as a typed, tested, live-wired module (§3.2) — done.** `src/lib/asr/correct/
{core.ts,en.ts}` replaced the `scripts/asr-correct*.mjs` regex piles this report was reacting to,
  and is wired into the transcript path — `asr-status.svelte.ts:31,125` imports and calls
  `correctTranscript()` before publishing `this.transcript`, citing this issue directly in a
  comment. Previously the correction gains were only realized in offline scoring scripts.
- **English regression held, and grew** — `pnpm coverage:intents` is 122/122 (100%) today. The eval
  set itself grew from the 120 examples this report assumed to 122 (issue #83's LET synonym
  batch), which temporarily dropped coverage to 114/122; issue #26's matcher fixes brought it back
  to a full 122/122.
- **The `ł` bug (§3.3, §4.4) — fixed.** `src/lib/aliases/normalize.ts:65` maps `ł/Ł → l/L`
  explicitly before the NFKD strip, with a regression test.
- **Still open, as this report anticipated:** no `franc` dependency exists yet — `transcribe.ts:230`
  still hardcodes `<|en|>` — so the _live_ ASR pipeline is English-only end-to-end; Polish matcher
  support currently runs only through the `lang` parameter in offline scripts. Polish alias forms
  were added by hand, not generated from Morfeusz/Morfologik as §2.3.2/§3.1 recommended. The
  corrector has no `pl.ts` pack yet (the matcher does). The LLM-slot-filler share decision (§2.4)
  remains undecided. None of these block issue #87's "Done when" bar — they're its own named
  follow-up steps (language routing, build-time generation, a Polish corrector pack), sequenced
  after the architecture this report asked for, which is now in place.

---

## 1. Where the maintainability risk actually lives

Three layers turn spoken/typed Polish into an answer; each carries a different amount of
English assumption.

| Layer              | File                                             | English-specificity today                                                                                                                                 | Polish impact                                                                                                |
| ------------------ | ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| ASR language pin   | `src/lib/asr/transcribe.ts:218`                  | `decoder_input_ids` hard-code `<\|en\|>` and an English `DOMAIN_PROMPT`                                                                                   | Must select `<\|pl\|>` and a Polish domain prompt; Whisper is already multilingual, so this is small.        |
| Whisper-correction | `scripts/asr-correct.mjs`, `asr-correct-ext.mjs` | Every rule is an English phonetic/spelling fix ("per napelion" → per nucleon, "loose site" → Lucite)                                                      | A whole second rule set; the regex pile the question worries about. **Prime candidate for redesign.**        |
| NLU matcher        | `src/lib/intent/matcher.ts`                      | `INDIRECT_IDIOMS`, `DIRECT_STOPPING/RANGE`, `detectInverse`, `MATERIAL_STOPWORDS` are English word/idiom regexes; alias tables hold English surface forms | Positional regexes assume English word order; needs Polish idioms + inflected aliases. **Second candidate.** |
| Entity resolution  | `src/lib/aliases/lookup.ts`, `normalize.ts`      | `normalizeText` + Levenshtein — mostly language-neutral, but tuned expecting English typos                                                                | Needs inflected forms (or lemmatization) and the `ł` fix.                                                    |
| NLG (answer text)  | `src/lib/nlg/render.ts`                          | English sentence templates                                                                                                                                | Separate concern (templating), not an NLP-library question.                                                  |

The two the question names — **matcher** and **correction layer** — are exactly the two that carry
the most English idiom, so the instinct is correct. The failure mode to avoid is _copy-paste-then-
translate_: duplicating `matchIntent` and `correct()` into Polish twins, doubling every future fix.

## 2. Candidate approaches, evaluated

### 2.1 General-purpose NLP toolkits — **poor fit (runtime + altitude)**

| Library                             | Polish support                           | Runtime         | Verdict for aidedx                                                                  |
| ----------------------------------- | ---------------------------------------- | --------------- | ----------------------------------------------------------------------------------- |
| **spaCy** (`pl_core_news_*`)        | Good lemmatizer + POS                    | Python          | Needs a server; `design.md` forbids one. Overkill for closed-domain slot-filling.   |
| **Stanza** (Stanford, Polish UD)    | Good, research-grade                     | Python, heavy   | Same server problem; far too heavy for this task.                                   |
| **Morfeusz 2** (SGJP)               | Reference PL morphology + **generation** | C++/Python/Java | Wrong runtime for the browser — **but excellent as a build-time generator** (§3.1). |
| **Morfologik** (LanguageTool's FSA) | Reference PL dictionary/stemming         | Java            | Wrong runtime; useful only offline, like Morfeusz.                                  |
| **compromise / wink-nlp**           | English only                             | JS/browser      | Right runtime, no Polish — useless here.                                            |

The pattern: the tools with real Polish morphology are all wrong-runtime for a static site, and the
browser-native JS toolkits have no Polish. None is worth adding as a runtime dependency.

### 2.2 Browser-friendly JS NLP building blocks — **two narrow fits**

| Library                   | What it gives                                                     | Fit                                                                                                       |
| ------------------------- | ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| **`franc`**               | Language detection (~400 languages), pure JS, tiny                | **Genuine fit** — routes a query to the EN or PL pack, and can pick the Whisper language tag. Cheap.      |
| **`talisman`**            | Phonetics (metaphone, double-metaphone, soundex…), string metrics | **Building blocks** for the §5.1 phonetic corrector; algorithms are EN/DE/FR-tuned, no Polish phonetics.  |
| **`natural`**             | Stemmers + phonetics + distances (Node-oriented)                  | Similar building blocks; **no Polish stemmer** (Snowball has never shipped one — Polish is too fusional). |
| **`fastest-levenshtein`** | Fast edit distance                                                | The repo already has `boundedLevenshtein`; no need.                                                       |

Note on phonetics for Polish: there is no well-maintained JS "Double Metaphone for Polish."
Because the lexicon is _closed_, the repo's existing edit-distance over normalized text plus a
small hand-written Polish digraph table (`sz/cz/rz→ż, ch→h, ó↔u, ą/ę nasal drops`) will likely
match or beat a generic phonetic library, and stays dependency-free and inspectable.

### 2.3 Restructure + exploit the closed world — **highest leverage, no new dependency**

The design already commits to the "closed-world principle" (`voice-pipeline-feasibility.md` §4):
consume domain knowledge at every stage, never treat this as open dictation. Two structural moves
follow from it:

1. **Language-pack architecture.** Extract the language-specific data out of `matcher.ts` and
   `asr-correct.mjs` into per-locale modules; keep the mechanical core shared. Concretely:

   ```
   src/lib/intent/
     matcher.ts            # language-neutral pipeline (spans, numbers, units, resolver, confidence)
     lang/
       en.ts               # INDIRECT_IDIOMS, DIRECT_* keywords, quantity synonyms, stopwords, inverse cues
       pl.ts               # Polish equivalents
   src/lib/asr/correct/
     core.ts               # number+unit context rules that are language-neutral
     en.ts / pl.ts         # phonetic/spelling rule sets per language
   ```

   This is plain software engineering, not NLP, and it is the single change that most directly
   answers "the code may become hard to maintain": a Polish fix lands in `pl.ts`, never by editing
   an English regex.

2. **Generate inflected aliases; don't hand-list them.** The alias tables are already a _derived
   artifact_ (`scripts/generate-aliases.ts` → `static/aliases/*.json`). Add a Polish pass that runs
   **Morfeusz 2** (or Morfologik) offline to expand each canonical material/particle lemma into its
   declension, emitting the inflected surface forms into the JSON. The heavyweight morphology tool
   runs on the maintainer's machine at build time; the browser ships only a slightly larger JSON and
   the existing normalize+Levenshtein lookup. This is the closed-world principle applied to
   morphology: enumerate the finite forms once rather than lemmatize at runtime.

### 2.4 Lean on the LLM slot-filler — **most maintainable, at a known cost**

`design.md` §5 already plans a hybrid NLU: deterministic matcher + a small local LLM fallback whose
_only_ job is turning language into a `QueryIntent` (never numbers, §4.2). For Polish this option
gets _relatively_ more attractive, because a multilingual model handles inflection and free word
order with no hand-written Polish grammar — one prompt, two languages. `voice-pipeline-feasibility.md`
§2.5/§5.6 already measured the trade-offs (Qwen2.5-1.5B, single-token constrained classification,
CPU latency dominated by prompt prefill, ~2.7 GB RAM). The recommendation there — rules first, LLM
as a narrow last resort — still holds; Polish just raises the value of the LLM's share of the work
relative to hand-porting the deterministic grammar.

## 3. Concrete recommendation, per layer

### 3.1 Matcher

- **Refactor to core + `lang/{en,pl}.ts`** (§2.3.1) _before_ writing any Polish rules. Do it as a
  no-behavior-change move on the English side first, verified by the existing coverage harness
  (`pnpm coverage:intents` stays 120/120), so the split is proven neutral before Polish lands.
- **Keep the n-gram-against-alias-table material/particle scan** — it is already the most
  language-robust part of the matcher and degrades gracefully under free word order, provided the
  alias table carries inflected forms (§2.3.2).
- **The English idioms/keywords/inverse-cues/stopwords are the real per-language work.** These go in
  `pl.ts`, authored with a physicist, not machine-translated.
- **No runtime NLP library.** Optionally use build-time **Morfeusz** to generate Polish aliases.

### 3.2 Whisper-correction layer

- **Adopt the phonetic-lexicon matcher already scoped in `voice-pipeline-feasibility.md` §5.1**, and
  make it the moment to stop the regex accretion the question is worried about. Structure it as
  core + per-language phonetic packs (§2.3.1).
- **Seed it with `talisman`/`natural` phonetic + distance primitives** if convenient, but a closed
  lexicon plus the existing `boundedLevenshtein` and a small Polish digraph table is a legitimate,
  lighter alternative — measure before taking the dependency.
- **Per-language rule sets are mandatory anyway:** the doc already found whisper-small and turbo
  garble _differently_ and need different rules (§2.1); Polish is another axis of the same fact.

### 3.3 Shared / cross-cutting

- **Fix `normalizeText` for `ł`** (map `ł→l`, `Ł→L` explicitly before the NFKD strip). Cheap,
  correctness-critical for Polish, and independently testable. Verified today: every other Polish
  diacritic folds, only `ł` leaks through.
- **Add `franc` (or equivalent) language detection** to route EN/PL and to pick the Whisper language
  token in `transcribe.ts` instead of the hard-coded `<\|en\|>`.
- **Keep NLG (`render.ts`) as a separate templating concern** — it needs Polish sentence templates
  (and gendered/case-aware agreement), but that is a localization task, not an NLP-library one.

## 4. Polish-specific gotchas to plan for

1. **Inflection multiplies every surface-form table.** 7 noun cases × singular/plural. Solve by
   generation (§2.3.2) or lemmatization, never by hand-listing in the matcher.
2. **Free word order** weakens positional regexes (`number → unit → particle`). The alias/n-gram
   scan survives this; the idiom regexes do not — another reason to keep idioms in a thin,
   replaceable pack.
3. **Prepositions vs cases.** English leans on `in`/`of` (`MATERIAL_STOPWORDS`); Polish often marks
   the same relation by case ending alone (`zasięg protonów` = range of protons, genitive, no
   preposition). The stopword-driven material scan must not assume a preposition is present.
4. **`ł` normalization bug** (§3.3).
5. **Numerals inflect and agree** (`sto`/`stu` MeV, `dwa`/`dwóch` protony). Spelled-out Polish
   numbers are a bigger job than English `one/two/three`; treat as lower priority than digit input.
6. **Diacritic-stripping collisions** are mostly harmless in this domain after folding, but validate
   the alias index has no new ambiguous collisions once Polish forms are added.

## 5. Bottom line

Do **not** add a general NLP library. Instead:

1. Refactor matcher and corrector into **language-neutral core + `en`/`pl` packs** (no dependency).
2. **Generate** Polish inflected alias tables offline with **Morfeusz/Morfologik** at build time.
3. Add **`franc`** for language routing and a **phonetic-lexicon corrector** (per §5.1), optionally
   seeded by `talisman`/`natural` primitives.
4. Fix the **`ł`** normalization bug now.
5. Re-evaluate how much of Polish to hand these to the **multilingual LLM slot-filler** vs the
   deterministic grammar — Polish shifts that balance toward the LLM, within the cost envelope
   already measured in `voice-pipeline-feasibility.md`.

The maintainability problem the question anticipates is real, but its fix is architectural (packs +
generated data + the already-planned phonetic matcher), with libraries playing only two small,
well-scoped roles.
