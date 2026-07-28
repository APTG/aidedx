# NeMo Parakeet-v3 vs whisper-small (issue #122)

_Session report, 2026-07-28. Desktop/laptop comparison ("WebAssembly" phase) and Android on-device
phase (§10) both complete, including four shipped matcher/corrector fixes (§5) for gaps the desktop
pass found. Real device: Pixel 7a, same hardware `docs/android-asr-runtime-bench.md` (#120) used._

## TL;DR

**`parakeet-tdt-0.6b-v3`'s real int8 combined size is 639 MB** (encoder 652,184,281 B + decoder
11,845,275 B + joiner 6,355,277 B + tokens.txt 93,939 B, confirmed by direct download, not
extrapolated) — comfortably inside issue #122's ~1 GB relaxed budget. This answers open question #2
outright.

**The literal "WebAssembly" path doesn't work for a model this size, and that's a real, useful
negative result, not a dead end.** sherpa-onnx's generic prebuilt WASM package (npm `sherpa-onnx`,
the one meant for in-browser use) hardcodes its shared `WebAssembly.Memory` to a 2 GiB maximum;
loading this model's 652 MB encoder trips a fatal `RuntimeError: unreachable` during session
creation, before any audio is decoded. Overriding the memory ceiling by hand breaks the module's
pthread-bootstrap a different way instead of fixing it (§2). `sherpa-onnx-node` (native N-API, same
underlying C++ engine, no WASM linear-memory ceiling) runs the identical model/config fine — used
for the rest of this comparison, still entirely on the laptop CPU, just not literally WASM bytecode.
This directly answers the issue's "could this ship the same way whisper-small does today" tangent:
**not via the current generic prebuilt WASM build, at this model size** (§2).

**Hotwords work, and once mis-tuned entries are removed, deliver a real lift comparable to
Whisper's own prompt-biasing — but two of my own first-draft hotword choices actively backfired,
found and fixed the same "reword, don't abandon" way `docs/android-asr-runtime-bench.md` §5.7→§5.9
handled whisper.cpp's prompt leak:**

| Config                                          | E2E audio→intent (corrected) | unit slot-token (corrected)     | median s/clip |
| ----------------------------------------------- | ---------------------------- | ------------------------------- | ------------- |
| unbiased (modified_beam_search, no hotwords)    | 47% (42/89)                  | 90.2%                           | 0.66s         |
| hotwords v1 (+ letter-spelled "M E V" forms)    | 48% (43/89)                  | 66.3% — **worse than unbiased** | 0.90s         |
| hotwords v2 (dropped letter-spelled forms)      | 61% (54/89)                  | 95.7%                           | 0.65s         |
| **hotwords v3 (also dropped ASTAR/PSTAR)**      | **66% (59/89)**              | **95.7%**                       | **0.88s**     |
| whisper-small + prompt, desktop CPU (reference) | 91% (81/89)                  | 96.7%¹                          | 2.3s          |

¹ sherpa-onnx-whisper-small on Android, `docs/android-asr-runtime-bench.md` §3.3 (93.5% corrected);
whisper.cpp+prompt-v2 on Android reaches 96.7% (§5.9) — cited here as the closest apples-to-apples
unit-slot number since desktop whisper-small's own unit breakdown isn't in a comparable table.

**On the specific "spoken units" metric issue #122 was written to test, Parakeet-v3 + tuned
hotwords matches or beats every Whisper configuration measured in this project so far** (95.7%
unit slot-token accuracy, corrected) — a genuine, hotwords-driven win, not a fluke: unit accuracy
alone moved 87.0%→93.5% raw just from switching decoding to `modified_beam_search` + a clean
hotwords list (§4.3).

**Overall E2E (66%) trailed whisper-small's 91% desktop baseline by 25pp — and the reason was not
acoustic accuracy on units, it was something else entirely: Parakeet has no inverse-text-
normalization.** It transcribes numbers as spelled-out English words ("two hundred and fifty"),
never digits, the same structural gap `docs/android-asr-runtime-bench.md` §2.3 found for Vosk. This
project's matcher only composed single-digit spelled numbers (issue #26's one–ten map), not
compound numbers ("sixty", "one hundred and fifty").

**Fixed, not just diagnosed — four small, targeted changes to the shared matcher/corrector** (§5),
each traced to a specific residual failure rather than guessed: spelled-out tens/hundreds
composition (`composeHundreds()`), spelled-out decimals ("three point six" → 3.6,
`composeDecimals()`), spelled-out length-target units ("10 centimeters" → `{value:10,unit:"cm"}`),
and a "Watt energy"→"what energy" homophone correction (NeMo Parakeet mishears the inverse-query
opener a native Whisper doesn't). All four are English-only, length-preserving, and additive.
**Real, re-measured result, not a projection: 47%→73% (unbiased) and 66%→82% (hotwords v3)** —
closing 32 of 35pp of the gap to whisper-small's 91% baseline, with zero regressions (all 676
existing tests pass, plus 9 new ones; Vosk/sherpa-onnx-Whisper/whisper.cpp/wav2vec2's
already-published numbers are unaffected — verified by re-running their saved JSON through the
updated matcher+corrector, not assumed, including confirming none of their transcripts even
contain "Watt" for the new homophone rule to touch).

**On Android (Pixel 7a, §8), it holds up — and actually improves**: hotwords-v3 reaches **87%
(77/89) on-device**, tying sherpa-onnx-whisper-small's own on-device number from #120 exactly, while
running **3.5× faster** (0.76s vs. 2.7s median) and needing zero device-specific tuning (no NDK
cross-compile, no thread-count sweep, unlike whisper.cpp's tuning work in #120). It falls 7pp short
of whisper.cpp's tuned 94% best, at roughly an eighth of whisper.cpp's per-clip latency.

**Net assessment**: Parakeet-v3 is fast on both laptop (0.66–0.9s/clip, 2.5–3.5× faster than desktop
whisper-small+prompt) and phone (0.76s/clip, 3.5× faster than sherpa-onnx-whisper-small on the same
device), matches or beats Whisper on the unit-recognition problem this spike exists to test once
hotwords are tuned, and — with four matcher/corrector fixes — closes most of its own
overall-accuracy gap too (82% desktop / 87% on-device vs. 91% desktop-Whisper, up from a 66%
starting point). The residual gap is ordinary acoustic/lexical misses (§5.4/§8.1) — isotope-number
mishears, a few "deuterons" variants a hotword alone doesn't fully recover, one clip where "MeV"
comes out as a nonsense word — the same category every ASR candidate in this project has left over,
not something a formatting fix can reach.

## 1. Setup

|                    |                                                                                                                                                                                                                                                                                      |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Model              | `csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8` (HuggingFace) — encoder/decoder/joiner + tokens.txt, 639 MB total, downloaded into `.hf-cache/csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8/`                                                                        |
| Machine            | Laptop CPU (this session's dev machine), not a server or Android device                                                                                                                                                                                                              |
| Eval clips         | Same fixed 30-sentence × 3-speaker set (`km`/`lg`/`mn`, 89 of 90 exist) issues #120/#122 both use, symlinked from the main checkout's gitignored `eval/audio/` (this worktree doesn't have its own copy — see §10 reproducing note)                                                  |
| Scoring            | Unmodified `scripts/e2e-audio-intents.ts` and `scripts/asr-score-slots.mjs` — the new harness (`scripts/sherpa-onnx-transcribe.mjs`) writes the exact same `modelId`/`dtype`/`loadS`/`records[]` JSON contract, so no scoring code changes were needed, per issue #122's own framing |
| Reference baseline | whisper-small + prompt, desktop CPU (Node, `onnxruntime-node`), 91% (81/89) E2E, 2.3s median — `docs/voice-pipeline-feasibility.md` §2.4.1, also cited throughout `docs/android-asr-runtime-bench.md`                                                                                |

## 2. WebAssembly attempt: hits a real 2 GiB memory ceiling

Tried first, since "WebAssembly" is what was asked for and it's the more faithful test of this
project's actual shipping model (WASM-in-the-browser, matching how whisper-small already runs via
`@huggingface/transformers`/`onnxruntime-web`).

```js
const wasmModule = {};
require("./node_modules/sherpa-onnx/sherpa-onnx-wasm-nodejs.js")(wasmModule);
const recognizer = sherpa_onnx_asr.createOfflineRecognizer(config); // <- crashes here
```

```
/…/sherpa-onnx/csrc/offline-transducer-nemo-model.cc:InitEncoder:200 ---encoder---
…
wasm://wasm/050341b6:1
RuntimeError: unreachable
    at wasm://wasm/050341b6:wasm-function[6727]:0x3ed95b
    at invoke_viiiiiiii (…/sherpa-onnx-wasm-nodejs.js:1:137522)
    …
```

**Root cause, confirmed rather than assumed**: the package's own JS glue hardcodes the WASM shared
memory's growth ceiling —

```js
wasmMemory = new WebAssembly.Memory({
  initial: INITIAL_MEMORY / 65536,
  maximum: 32768,
  shared: true,
});
```

`32768` pages × 64 KiB = exactly 2 GiB. The encoder's on-disk size (652 MB) is well under that, but
ONNX Runtime's WASM execution provider needs substantially more than the raw file size during
graph-load/session-creation (weight deserialization + graph-optimization scratch + node
input/output buffers) — enough to exceed 2 GiB before a single sample is processed.

**Tried to raise the ceiling by pre-supplying a larger `WebAssembly.Memory` before the module
factory runs** (`shared: true`, `maximum: 65536` pages = 4 GiB, the wasm32 architectural limit for a
shared memory):

```js
const wasmModule = {
  wasmMemory: new WebAssembly.Memory({ initial: 4096, maximum: 65536, shared: true }),
};
require("sherpa-onnx-wasm-nodejs.js")(wasmModule);
```

This didn't just fail to raise the ceiling — it broke module init a different way entirely
(`TypeError: Module._malloc is not a function`). The library's own `if (!Module["wasmMemory"])`
check appears to gate more than memory allocation; supplying our own memory object skips whatever
synchronous pthread-worker-pool bootstrap the default path performs. Not a simple config knob —
tied into the build's Emscripten pthreads architecture. Rebuilding sherpa-onnx's WASM binary from
source with a higher `MAXIMUM_MEMORY` (the whisper.cpp `GGML_NATIVE`-style fix) would be a
plausible real fix, but needs the full emscripten + sherpa-onnx + onnxruntime cross-compile
toolchain — a materially bigger undertaking than anything else in this spike, and not attempted
this session.

**Confirmed this is specifically a WASM-memory problem, not a model/config problem**: the identical
model and config, run through `sherpa-onnx-node` (native N-API, no WASM involved), loads in 1.6s and
decodes correctly on the first try (§4). The rest of this comparison uses that native binding.

## 3. Real file size (open question #2)

| File                | Bytes        |
| ------------------- | ------------ |
| `encoder.int8.onnx` | 652,184,281  |
| `decoder.int8.onnx` | 11,845,275   |
| `joiner.int8.onnx`  | 6,355,277    |
| `tokens.txt`        | 93,939       |
| **Total**           | **≈ 639 MB** |

Comfortably inside the ~1 GB relaxed budget issue #122 set. Not extrapolated — every file
downloaded and measured directly.

## 4. Native desktop comparison (`sherpa-onnx-node`)

### 4.1 Config

```js
const config = {
  featConfig: { sampleRate: 16000, featureDim: 80 },
  modelConfig: {
    transducer: { encoder, decoder, joiner },
    tokens,
    modelType: "nemo_transducer", // required for NeMo TDT — confirmed from sherpa-onnx's own
    // nodejs-addon-examples/test_asr_non_streaming_nemo_parakeet_tdt_v2.js,
    // not guessed
    modelingUnit: "bpe",
    bpeVocab, // this model release ships tokens.txt but no bpe.vocab — derived one with equal
    // (-1.0) scores per token, same as sherpa-onnx's own hotwords example does, so
    // hotword phrases can be given as plain words instead of pre-tokenized BPE pieces
  },
  decodingMethod: "modified_beam_search", // required for hotwords; used for BOTH the "unbiased"
  // and hotwords runs below so the pair is controlled —
  // greedy_search (the simpler default) was not run
  // separately, a scope choice not a gap
  hotwordsScore: 2.0,
};
```

Both the unbiased and hotwords passes reuse one loaded recognizer (`recognizer.createStream(hotwords)`
with `hotwords` omitted vs. supplied) — one 640 MB model load, not two.

### 4.2 Reproducing

```
node scripts/sherpa-onnx-transcribe.mjs eval/results/parakeet-v3-<date>
npx tsx scripts/e2e-audio-intents.ts eval/results/parakeet-v3-<date>/parakeet-v3-unbiased.json
node scripts/asr-score-slots.mjs eval/results/parakeet-v3-<date>/parakeet-v3-unbiased.json
# repeat for parakeet-v3-hotwords.json
```

### 4.3 Hotwords: two mis-tuned entries found and fixed, same "reword, don't abandon" pattern as #120

**v1 — first draft, hotwords built from the project's `DOMAIN_PROMPT` vocabulary (already used for
Whisper prompt-biasing) plus phonetic/spelled unit variants issue #122 item 3 asked for
("M E V" letter names, "em ee vee" phonetic sound), plus materials/particles from this eval set's
own ground truth, plus `ASTAR`/`PSTAR` (already in `DOMAIN_PROMPT`):**

| Config      | E2E (corrected) | unit slot-token (raw → corrected)       | median s/clip |
| ----------- | --------------- | --------------------------------------- | ------------- |
| unbiased    | 47% (42/89)     | 87.0% → 90.2%                           | 0.66s         |
| hotwords v1 | 48% (43/89)     | **64.1% → 66.3% — worse than unbiased** | 0.90s         |

**v1 unit-slot accuracy is worse than not using hotwords at all.** Root cause, confirmed from raw
transcripts (28 of 89 clips affected): including the letter-name form `"M E V"` as a hotword biases
the decoder into splitting normally-pronounced "MeV" into individual letters even on clips where
nothing was spelled out — e.g. `"...five hundred K E V protons..."` for a clip where the speaker
said "keV" as one word. The same failure shape as `docs/android-asr-runtime-bench.md` §5.7's
whisper.cpp prompt leak (a biasing mechanism echoing its own hint text instead of what was said).

**v2 — dropped the letter-name forms, kept the phonetic-sound forms** ("em ee vee" etc. — closer to
what issue #122's own quoted maintainer comment actually described: "pronounced 'em-ee-vee'"):

| Config      | E2E (corrected) | unit slot-token (raw → corrected) | median s/clip |
| ----------- | --------------- | --------------------------------- | ------------- |
| hotwords v2 | 61% (54/89)     | 93.5% → 95.7%                     | 0.65s         |

Unit-slot accuracy jumps to above the unbiased baseline, as intended. But a **second, pre-existing**
issue (present in v1 too, just not yet isolated) remained: `ASTAR`/`PSTAR` (program-name hotwords,
carried over from `DOMAIN_PROMPT`) trigger runaway hallucinated repetition on clips that never
mention a program at all —

```
"ASTAR ASTAR ASTAR ASTAR ASTAR ASTAR ASTAR ASTAR ASTARP POW A 500 KEV protons in water."
```

for a clip whose ground truth is just "Stopping power of 500 keV protons in water." — 5 clips
corrupted this way in v1, 7 in v2.

**v3 — also dropped `ASTAR`/`PSTAR`** (out of this spike's actual scope anyway — issue #122 targets
the spoken-units problem specifically, and program names were already recognized correctly
unprompted, e.g. the unbiased run's `cmp-prog-001` clip):

| Config          | E2E raw         | E2E corrected   | unit slot-token (corrected) | clip-level (asr-score-slots) | median s/clip |
| --------------- | --------------- | --------------- | --------------------------- | ---------------------------- | ------------- |
| unbiased        | 40% (36/89)     | 47% (42/89)     | 90.2%                       | 48% (43/89)                  | 0.66s         |
| hotwords v1     | 42% (37/89)     | 48% (43/89)     | 66.3% (worse)               | 46% (41/89)                  | 0.90s         |
| hotwords v2     | 51% (45/89)     | 61% (54/89)     | 95.7%                       | 62% (55/89)                  | 0.65s         |
| **hotwords v3** | **56% (50/89)** | **66% (59/89)** | **95.7%**                   | **69% (61/89)**              | 0.88s         |

**v3 is the recommended config.** Full slot-token table (raw → corrected, n=483 tokens):

| Category | unbiased          | hotwords v3       |
| -------- | ----------------- | ----------------- |
| number   | 60.9% → 64.1%     | 81.5% → 81.5%     |
| unit     | 87.0% → 90.2%     | 93.5% → 95.7%     |
| particle | 88.4% → 89.5%     | 92.6% → 93.7%     |
| material | 94.2% → 95.1%     | 100.0% → 100.0%   |
| quantity | 89.5% → 95.8%     | 92.6% → 97.9%     |
| program  | 0.0% → 100.0%     | 0.0% → 100.0%     |
| **ALL**  | **83.2% → 87.4%** | **91.1% → 94.0%** |

Raw results: `eval/results/parakeet-v3-2026-07-28/parakeet-v3-{unbiased,hotwords}-v{1,2,3}.json`
(unbiased was only run once — the hotwords list changes don't affect the unbiased pass, so v1's
unbiased file is the one used throughout).

### 4.4 Answering issue open question #1

**Does sherpa-onnx's hotwords mechanism, given a jargon + phonetic-variant word list, actually
recognize unit jargon reliably, better than Whisper's `initial_prompt` does today?**

Yes, on the unit-slot metric specifically, once the hotword list itself is debugged: 95.7%
corrected unit-token accuracy (hotwords v3) is at or above every Whisper configuration measured in
this project (sherpa-onnx-whisper-small/Android: 93.5%; whisper.cpp+prompt-v2/Android: 96.7% — the
one config that edges Parakeet out). This is a genuine, mechanism-driven win, not noise — it took
two rounds of "the hotword list itself was the bug" debugging to get there, the same lesson
`docs/android-asr-runtime-bench.md` §5.7→§5.9 already drew for Whisper's own prompt text: a biasing
mechanism can leak its own hint text into output, and the fix is to reword the hints, not abandon
biasing.

## 5. Closing the gap: matcher/corrector fixes, shipped and re-measured

The unit-slot win alone left overall E2E (66%) trailing whisper-small's desktop baseline (91%) by
25pp. **Almost none of that gap was about units.** Parakeet's TDT decoder transcribes numbers as
spelled-out English words — `"two hundred and fifty"`, `"one hundred and fifty"`, `"sixty"` — never
as digits. Whisper's decoder does inverse-text-normalization (ITN) as part of its training and
reliably outputs `"250"`. This project's matcher (`src/lib/intent/matcher.ts`) only composed
single-digit spelled numbers into digits (`NUMBER_WORDS`, one–ten, added narrowly for issue #26's
"one GeV"/"three MeV" case) — it had no path for compound numbers like "sixty" or "one hundred and
fifty".

**A first-pass diagnostic probe** (a scratch script implementing a general English
number-word-to-digit composer, run against already-corrected transcripts) quantified the ceiling
before committing to a real fix — 21/47 and 12/18 residual failures recoverable, projecting
47%→71% (unbiased) / 66%→80% (hotwords v3). That projection is now confirmed for real, and then
extended further (§5.3) once the remaining 18 failures were inspected individually:

### 5.1 The hundreds/tens fix

- `src/lib/intent/lang/en.ts`: extended `NUMBER_WORDS` from one–ten to one–ninety-nine by tens
  (eleven–nineteen, twenty/thirty/…/ninety as individual entries — each already fits the existing
  per-word substitution mechanism unchanged), and added a new `HUNDRED_WORD = "hundred"` export.
- `src/lib/intent/lang/pl.ts`: `HUNDRED_WORD = null` — Polish's `NUMBER_WORDS` stays empty (already
  documented: numerals decline by case/gender, unsafe for a flat word→digit table), so composition
  is a no-op there, not a broken one.
- `src/lib/intent/lang/types.ts`: added `HUNDRED_WORD: string | null` to the `LangPack` interface.
- `src/lib/intent/matcher.ts`: new `composeHundreds()` — matches `"(one..nine) hundred [and]?
(any NUMBER_WORDS entry)?"` and replaces the _whole_ matched phrase with a single
  length-preserving digit substitution (the same span-preserving invariant `spellOutNumbers()`
  already relied on, extended to a genuine multi-word composition instead of one-token-at-a-time).
  Runs before `spellOutNumbers()`'s per-word pass, which still handles any standalone tens/teens
  the hundreds pass didn't consume. "Thousand" and above stays out of scope — not attested in this
  project's eval set.
- `src/lib/intent/matcher.test.ts`: 5 new tests (`describe("issue #122 — spelled-out tens and
hundreds …")`) — standalone tens ("sixty"), "X hundred and Y", "X hundred Y" (no "and"), a bare
  "X hundred", and a span-preservation check mirroring issue #26's own test.

### 5.2 First real result (hundreds/tens only)

| Run         | E2E before fix | E2E after hundreds/tens fix | diagnostic-probe projection   |
| ----------- | -------------- | --------------------------- | ----------------------------- |
| unbiased    | 47% (42/89)    | 71% (63/89)                 | 71% (63/89) — matched exactly |
| hotwords v3 | 66% (59/89)    | 80% (71/89)                 | 80% (71/89) — matched exactly |

The real fix landed exactly on the probe's projected ceiling in both runs — the diagnostic script's
composer and the shipped `composeHundreds()` agree on every recovered clip.

### 5.3 Three more fixes, chasing the remaining 18 failures

The 18 clips still failing after §5.2 turned out not to be one uniform "acoustic misses, nothing to
do" bucket — three more had a traceable, fixable root cause, not a guess:

- **Spelled-out decimals** ("three point six GeV" instead of "3.6 GeV") — 2 of 3 speakers on the
  same sentence (`pernuc-003`) spelled the decimal out; the third already said the digits directly.
  New `composeDecimals()` in `matcher.ts` (same length-preserving, whole-phrase-replacement pattern
  as `composeHundreds()`), plus a new `POINT_WORD` pack field (`"point"` for English, `null` for
  Polish) and a `"zero"` → `"0"` entry added to `NUMBER_WORDS` (needed for decimal digits like
  "point zero six", not previously spoken standalone).
- **Spelled-out length-target units** ("10 centimeters" instead of "10 cm") — issue #122's own
  quoted maintainer comment named this exact pattern ("length units (cm, mm), usually spelled out
  in full") and the hotwords list (§4.3) already anticipated it by biasing toward "centimeters" —
  but the matcher's `LENGTH_TARGET_RE` only ever recognized the abbreviated forms. Extended the
  regex to accept `centimeters?`/`millimeters?`/`micrometers?` alongside `cm`/`mm`/`um`, normalizing
  each back to the schema's abbreviated unit.
- **"Watt energy" → "what energy"** — a genuine homophone mishearing at the start of an
  inverse-energy question (`inv-rng-001`, one speaker) that Whisper-family output in this project
  has never shown. New `EN_RULES` entry in `src/lib/asr/correct/en.ts`, scoped to "watt energy"
  specifically (not a bare "watt" fix, so a genuine future watts unit mention wouldn't be
  silently rewritten). **This is a corrector change, not just a matcher change** — it revises §6's
  "works unmodified" finding below to "needed one small addition."

New tests: 3 in `matcher.test.ts` (decimal composition, spelled-out cm, spelled-out mm/um) + 1 in
`correct.test.ts` (Watt→What). 676 tests pass total (was 667 before this spike), zero regressions.

### 5.4 Final real result

| Run         | E2E (§5.2)  | E2E (all four fixes) | unit slot-token | asr-score-slots clip-level |
| ----------- | ----------- | -------------------- | --------------- | -------------------------- |
| unbiased    | 71% (63/89) | **73% (65/89)**      | 90.2%           | 49% (44/89)                |
| hotwords v3 | 80% (71/89) | **82% (73/89)**      | 95.7%           | 70% (62/89)                |

`asr-score-slots.mjs`'s numbers move too, this time — a small amount (43→44/89 unbiased, 61→62/89
hotwords v3) — because the Watt/What fix lives in the shared corrector both scoring scripts call,
unlike the matcher-only hundreds/decimals/length-unit fixes, which only `e2e-audio-intents.ts`
routes through.

**Confirmed no other candidate's published numbers moved**: re-ran the already-committed Vosk,
wav2vec2 (both `eval/results/android-{vosk,wav2vec2}-2026-07-27/`), sherpa-onnx-Whisper
(`eval/results/android-sherpa-onnx-2026-07-27/`), and whisper.cpp+prompt-v2
(`eval/results/android-whispercpp-promptv2-2026-07-28/`) result files through both updated scoring
paths — every corrected E2E and clip-level number is byte-identical to what's already published in
`docs/android-asr-runtime-bench.md` (0%, 87%/77 raw for sherpa-onnx-Whisper, 92% clip-level for
whisper.cpp, 94% E2E). Confirmed, not assumed, for the Watt/What rule specifically: none of the four
saved transcript files contain the string "Watt" at all, so that rule is a structural no-op for
them. The fix set is additive.

**Unlike Vosk's vocabulary wall (`docs/android-asr-runtime-bench.md` §2.4/§2.6 — words genuinely
absent from the model's lexicon, unrecoverable by any decoder-side fix), all four of these really
were solvable software gaps**, each traced to a specific clip rather than guessed. The remaining 16
failures (down from 18) are ordinary acoustic/lexical errors of the same flavor
`docs/android-asr-runtime-bench.md` §3.3 already documented for Whisper-family models on this eval
set (isotope numbers — "carbon 14"/"carbon 30" for "carbon-13", "helium free" for "helium-3"; "GeV"
as "giga electron of volt"; "deuterons" persistently misheard as "doutrons"/"deuters"/"deutterons"
despite being an active hotword; one digit-level mishear, "10" for "100") — not a new failure mode
specific to Parakeet, and not obviously fixable by another formatting rule the way the first four
were.

## 6. Corrector compatibility (open question #3)

**`src/lib/asr/correct/core.ts`'s existing rules and phonetic pass needed no changes for Parakeet's
transcript style** — same finding as `docs/android-asr-runtime-bench.md` §3's sherpa-onnx-Whisper
result. One small _addition_ was needed (§5.3's "Watt energy"→"what energy" rule, a genuine new
homophone mishearing this project hadn't seen from Whisper), not a modification to anything
existing — every category's score still moves raw→corrected in the same direction (never a
regression) across both the unbiased and hotwords-v3 runs (§4.3's table): e.g. `program`
0.0%→100.0% in both, `quantity` +6.3pp/+5.3pp, `unit` +3.2pp/+2.2pp. No Parakeet-specific casing or
punctuation quirk broke an existing rule.

## 7. Polish (open question #4) — still blocked, same as #120

No Polish eval audio exists in this project yet (`eval/audio/` only has the English `km`/`lg`/`mn`
speakers) — issues #63/#79/#30 (Polish i18n eval work) are still open, exactly the same blocker
`docs/android-asr-runtime-bench.md` §8 already flagged for Whisper. Parakeet-v3's claimed 7.31% WER
on Polish MLS (issue #122's own candidate table) remains unverified against this project's actual
query set.

## 8. Android on-device (Phase 2)

Same hardware and harness pattern `docs/android-asr-runtime-bench.md` (#120) already established:
Pixel 7a (`lynx`), Tensor G2, Android 17, `arm64-v8a`, `bench/android/sherpa-onnx/` (the same Kotlin
app #120 built for sherpa-onnx-whisper-small), same 89-clip eval set (resampled 44.1kHz→16kHz mono),
same push-to-`/data/local/tmp`-then-`run-as`-into-`filesDir` pattern (§1 there). Extended, not
rebuilt: `bench/android/sherpa-onnx/app/src/main/java/com/aidedx/sherpabench/BenchActivity.kt` gained
a `model_family` intent extra (`nemo_transducer` alongside #120's original `whisper` default) driving
`OfflineTransducerModelConfig` instead of `OfflineWhisperModelConfig` — the vendored
`OfflineRecognizer.kt` already had a `sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8` factory entry
(sherpa-onnx's own Kotlin API ships awareness of this exact model), confirming the config shape
matches the desktop harness (§4.1) exactly.

**One real gotcha, found and fixed**: passing the hotwords string as a plain `-e hotwords "..."`
intent extra corrupted it — `adb shell`'s remote re-tokenization mangled the string's `/` and `:`
characters (the hotwords syntax's own phrase-separator and score-suffix punctuation), and `am start`
silently misparsed the launch intent (`act=android.intent.action.VIEW dat=:` in the launch log,
instead of the expected component launch). Fixed by pushing the hotwords string to a file
(`hotwords_file` intent extra, a path relative to `filesDir`) and having the app read it with
`File(filesDir, path).readText()` — the same "push as a file, not a fragile CLI argument" lesson
`docs/android-asr-runtime-bench.md` §3.1 already applied to native `.so` libraries.

### 8.1 Results

| Pipeline                                        | audio→intent slot match | median s/clip | load time |
| ----------------------------------------------- | ----------------------- | ------------- | --------- |
| whisper-small + prompt, desktop CPU (reference) | 91% (81/89)             | 2.3s          | —         |
| whisper.cpp+prompt-v2, Pixel 7a (#120's best)   | 94% (84/89)             | 5.9s          | 0.72s     |
| **Parakeet-v3 + hotwords v3, Pixel 7a**         | **87% (77/89)**         | **0.76s**     | **3.2s**  |
| sherpa-onnx-whisper-small, Pixel 7a (#120)      | 87% (77/89)             | 2.7s          | 2.3s      |
| Parakeet-v3 unbiased, Pixel 7a                  | 73% (65/89)             | 0.71s         | 3.6s      |
| Vosk small-en, Pixel 7a (#120)                  | 0% (0/89)               | 1.3s          | 0.55s     |

**Parakeet-v3 + hotwords ties sherpa-onnx-whisper-small's own on-device accuracy exactly (87%,
77/89) — while running 3.5× faster** (0.76s vs. 2.7s median). It doesn't beat whisper.cpp's tuned
94% (the only candidate that does, per #120's own thread/prompt tuning work), but reaches within 7pp
of it at roughly an eighth of whisper.cpp's per-clip latency, with zero device-specific tuning of its
own — no NDK cross-compile, no thread-count sweep, no build misconfiguration to find and fix the way
whisper.cpp needed (`docs/android-asr-runtime-bench.md` §5.2).

**On-device numbers track the desktop numbers closely, not divergently**: unbiased is
73% (65/89) both on-device and on the laptop (§5.4) — same clip count, same failures. Hotwords moves
from 82% (73/89) desktop to 87% (77/89) on-device — _better_ on the phone, not worse (4 more clips
pass; the residual-failure list below is a strict subset of the desktop one, §5.4). This is the
opposite of what #120 found for whisper.cpp's naive default config (severe thermal throttling
inflating on-device latency 5-6× — §5.5 there) — Parakeet-v3 shows no such regression, on either
axis, out of the box.

Slot-token accuracy (raw → corrected, via `asr-score-slots.mjs`):

| Category | unbiased      | hotwords v3     |
| -------- | ------------- | --------------- |
| quantity | 90.5% → 95.8% | 92.6% → 98.9%   |
| number   | 62.0% → 65.2% | 80.4% → 82.6%   |
| unit     | 85.9% → 89.1% | 93.5% → 95.7%   |
| particle | 87.4% → 88.4% | 94.7% → 95.8%   |
| material | 94.2% → 95.1% | 100.0% → 100.0% |
| program  | 0.0% → 100.0% | 0.0% → 100.0%   |

The 12 residual hotwords-v3 failures are the same categories §5.4 already documented for the desktop
run (isotope-number mishears — "carbon 30" for "carbon-13"; "deuterons" variants a hotword doesn't
fully recover — "doutrons"/"deutherons"; "helium free" for "helium-3"; "GeV" as "giga electron of
volt"; "KV" for "keV"; one nonsense-word garble, "mega elektronobals" for "MeV") — no new,
device-specific failure mode. Raw results:
`eval/results/android-parakeet-2026-07-28/parakeet-{unbiased,hotwords}.json`.

### 8.2 Reproducing

```
cd bench/android/sherpa-onnx
export ANDROID_HOME=~/Android/Sdk
export JAVA_HOME=<a real JDK — Android Studio's bundled JBR works: .../android-studio/jbr>

# native libs are gitignored (docs/android-asr-runtime-bench.md §3.1) - re-fetch
curl -sSL -o android-libs.tar.bz2 https://github.com/k2-fsa/sherpa-onnx/releases/download/v1.13.4/sherpa-onnx-v1.13.4-android.tar.bz2
tar xjf android-libs.tar.bz2
cp jniLibs/arm64-v8a/*.so app/src/main/jniLibs/arm64-v8a/

./gradlew assembleDebug
adb connect <phone-ip>:5555   # or plain USB — either way, adb devices must show it first
adb install -r app/build/outputs/apk/debug/app-debug.apk

# model + resampled (16kHz mono) audio + a bpe.vocab (see §4.1 for how it's derived) to
# /data/local/tmp, then into the app's internal storage via run-as (§1 in the #120 doc)
adb push .hf-cache/csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8 /data/local/tmp/sb/model-parakeet
adb push <16kHz-resampled-eval-audio-dir> /data/local/tmp/sb/audio
adb shell run-as com.aidedx.sherpabench cp -r /data/local/tmp/sb/model-parakeet files/model-parakeet
adb shell run-as com.aidedx.sherpabench mkdir -p files/audio
adb shell run-as com.aidedx.sherpabench cp -r /data/local/tmp/sb/audio/<speaker> files/audio/<speaker>   # per speaker

adb shell am start -n com.aidedx.sherpabench/.BenchActivity --ez autorun true \
  -e model_dir model-parakeet -e model_family nemo_transducer -e decoding_method modified_beam_search \
  -e num_threads 2 -e out_name results-parakeet-unbiased.json \
  -e model_id csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8

# hotwords run: push the hotwords string as a FILE (plain -e hotwords "..." gets mangled by
# adb shell's remote re-tokenization, §8) then pass hotwords_file, not hotwords
adb push <hotwords-v3.txt> /data/local/tmp/sb/hotwords-v3.txt
adb shell run-as com.aidedx.sherpabench cp /data/local/tmp/sb/hotwords-v3.txt files/hotwords-v3.txt
adb shell am start -n com.aidedx.sherpabench/.BenchActivity --ez autorun true \
  -e model_dir model-parakeet -e model_family nemo_transducer -e decoding_method modified_beam_search \
  -e num_threads 2 -e out_name results-parakeet-hotwords.json -e hotwords_file hotwords-v3.txt \
  -e model_id csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8

adb shell run-as com.aidedx.sherpabench cat files/results-parakeet-unbiased.json > eval/results/android-parakeet-<date>/parakeet-unbiased.json
adb shell run-as com.aidedx.sherpabench cat files/results-parakeet-hotwords.json > eval/results/android-parakeet-<date>/parakeet-hotwords.json
npx tsx scripts/e2e-audio-intents.ts eval/results/android-parakeet-<date>/parakeet-unbiased.json
node scripts/asr-score-slots.mjs eval/results/android-parakeet-<date>/parakeet-unbiased.json
# repeat scoring for parakeet-hotwords.json
```

## 9. Recommendation and open follow-ups

- **Number-word/decimal/length-unit composition and the Watt/What homophone fix** (§5) are done —
  landed in `src/lib/intent/matcher.ts`, `src/lib/intent/lang/{en,pl,types}.ts`, and
  `src/lib/asr/correct/en.ts`, closing 32 of 35pp of the E2E gap to whisper-small. Not attempted:
  "thousand" and above (not attested in this project's eval set), and Polish composition (blocked
  on the same numeral-declension concern `lang/pl.ts` already documents — would need a physicist
  review, not a data-table extension).
- **The WASM memory ceiling (§2)** means Parakeet-v3 cannot ship via this project's current
  browser-first distribution model without either a custom sherpa-onnx WASM build (real, multi-day
  toolchain work) or accepting a native-app-only distribution — directly informative for the
  product-direction question issue #122 flagged but didn't ask this spike to resolve.
- **Hotwords list hygiene matters as much as the mechanism itself** (§4.3) — a future hotwords list
  for this project (Parakeet or otherwise) should avoid short/acronym entries prone to
  hallucinated-repetition and letter-spelled forms prone to over-triggering; phonetic-sound spellings
  ("em ee vee") were fine, letter-name spellings ("M E V") were not.
- **The residual 16 failures (82% vs. whisper-small's 91%)** are now ordinary acoustic/lexical
  misses (§5.4) — isotope numbers, several distinct "deuterons" mishears a hotword doesn't fully
  fix, one clip where "MeV" comes out as a nonsense compound word, a couple of pure digit-level
  errors ("10" for "100"). Nothing in this residual list looks systematically fixable the way the
  first four formatting/homophone gaps were — this is very likely close to Parakeet-v3's real
  ceiling on this eval set without better acoustics or a different hotwords score/list.
- **Bottom line**: Parakeet-v3 + tuned hotwords is a genuinely strong candidate, not just a
  technically-interesting one — it ties sherpa-onnx-whisper-small's on-device accuracy exactly
  (87%, §8.1) while running 3.5× faster and needing none of whisper.cpp's build/thread-tuning work.
  If **latency/battery matters more than the last few points of accuracy**, it's the best
  candidate measured across both #120 and this spike. If **accuracy is the only axis that
  matters**, whisper.cpp's tuned 94% (#120 §5.9) still wins outright. Neither this doc nor #120
  weighs those priorities against each other — that tradeoff is a product decision, not a
  benchmarking one.

## 10. Reproducing (desktop)

```
mkdir -p .hf-cache/csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8
cd .hf-cache/csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8
BASE=https://huggingface.co/csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8/resolve/main
curl -sSL -o tokens.txt "$BASE/tokens.txt"
curl -sSL -o decoder.int8.onnx "$BASE/decoder.int8.onnx"
curl -sSL -o joiner.int8.onnx "$BASE/joiner.int8.onnx"
curl -sSL -o encoder.int8.onnx "$BASE/encoder.int8.onnx"   # ~652 MB

pnpm add -D sherpa-onnx-node@1.13.4
node scripts/sherpa-onnx-transcribe.mjs eval/results/parakeet-v3-<date>
npx tsx scripts/e2e-audio-intents.ts eval/results/parakeet-v3-<date>/parakeet-v3-unbiased.json
node scripts/asr-score-slots.mjs eval/results/parakeet-v3-<date>/parakeet-v3-unbiased.json
# repeat both scoring commands for parakeet-v3-hotwords.json
```

`eval/audio/` is gitignored (personal recordings); this worktree symlinked it from the main
checkout (`ln -s <main-checkout>/eval/audio eval/audio`) rather than copying 89 files.

Raw results: `eval/results/parakeet-v3-2026-07-28/`. Harness: `scripts/sherpa-onnx-transcribe.mjs`.
