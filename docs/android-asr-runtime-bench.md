# Android ASR runtime bench (issue #120) — session scoping report + runbook

_Session report, 2026-07-23. Cloud/remote Claude Code session (no physical machine, no Android
device). This pass could **not** produce the on-device latency/battery/accuracy numbers issue #120
asks for — that requires a real Android phone, an Android SDK/NDK toolchain, and network access to
Hugging Face / GitHub release assets, none of which this environment has (confirmed empirically in
§0, not assumed). **Issue #120 stays open and unresolved; §5's results table is a template with
every cell unfilled**, to be completed on a local machine per this repo's continuation._

What this pass did do, so the local continuation starts from further along than the issue text
alone:

- Confirmed candidate details — file sizes, licenses, Android integration paths, and (critically)
  whether each candidate can replicate this project's domain-prompt biasing — via web research that
  doesn't require downloading any model weights (§1).
- Answered the issue's three open questions as far as documentation allows (§2) — one of them
  (sherpa-onnx's prompt support) turned up a real, citable negative finding, not just a gap.
- Designed a JSON output contract so on-device results, once produced, score with this repo's
  **existing, unmodified** `scripts/e2e-audio-intents.ts` / `scripts/asr-score-slots.mjs` — no new
  scoring code needed (§3).
- Wrote a step-by-step runbook (§4) and two helper scripts (`scripts/android-asr-fetch-models.sh`,
  `scripts/android-asr-battery-bench.sh`) for the parts that need a real device/network/SDK.

## 0. What this session could and couldn't do (environment audit)

| Requirement                                                              | Status in this session                                                                                                                                                                                                                                                                                           |
| ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Android SDK / NDK / `adb` / emulator                                     | Not installed (`ANDROID_HOME`/`ANDROID_SDK_ROOT` both unset, no `sdkmanager` on `PATH`). `gradle` (`/opt/gradle/bin/gradle`) and JDK 21 are present but cannot build an Android module without the SDK platform + NDK — confirmed there's no path to a working build here regardless of what source files exist. |
| Network to `huggingface.co`                                              | Blocked — `curl -I` on a `ggerganov/whisper.cpp` model file returned `403 Forbidden` **from this environment's own outbound proxy**, not from Hugging Face itself (i.e. this container's network policy rejects the CONNECT tunnel to that host). `WebFetch` on the same domain also returned 403.               |
| Network to `alphacephei.com` (Vosk's official model host)                | Also blocked via `WebFetch` (403).                                                                                                                                                                                                                                                                               |
| General web search, GitHub, some doc sites (`k2-fsa.github.io`, in part) | Reachable — all research in §1–§2 came from these.                                                                                                                                                                                                                                                               |
| A real Android phone                                                     | Not available in a cloud container — never in scope for this environment.                                                                                                                                                                                                                                        |

This matches the issue's own `needs-local-machine` label and the task author's stated expectation
going in ("I know that working in claude code you may face some limits in downloading model weights
due to their size or firewall protections") — a confirmation, not a surprise.

## 1. Candidate research confirmed this session

### 1.1 whisper.cpp

- **License**: MIT (confirmed from the repo page).
- **Android example**: `examples/whisper.android` (Kotlin, JNI bindings to the C++ library) and a
  separate `whisper.android.java` community fork/example — confirmed. Setup is: copy a `.bin` model
  into `app/src/main/assets/models`, copy a sample `.wav` into `app/src/main/assets/samples`, select
  the **release** build variant in Android Studio, deploy. The upstream README explicitly recommends
  tiny/base for on-device use, not small — worth re-checking device headroom before committing to
  small as the like-for-like comparison point.
- **Runtime RAM** (not the same thing as the ≤0.5 GB _download_ budget the issue sets): tiny
  ≈273 MB, base ≈388 MB, **small ≈852 MB** resident at inference time, per the project's own memory
  table. This is a real risk worth flagging before the local run: a phone that's fine with a 190–264 MB
  _file_ can still struggle if inference alone wants ~850 MB of RAM alongside the rest of Android. Not
  disqualifying, but budget it into which test device gets used.
- **Model file sizes** — the issue body states `ggml-small-q5_1.bin` (190 MB) and `ggml-small-q8_0.bin`
  (264 MB) from `ggerganov/whisper.cpp` on Hugging Face. **Not independently re-confirmed this
  session** (huggingface.co is blocked here, §0) — relayed from the issue text, verify the actual
  file size after downloading (`scripts/android-asr-fetch-models.sh` prints it).
- **Domain-prompt biasing**: `whisper_full_params` has an `initial_prompt` field, and the CLI
  (`main`/`whisper-cli`) exposes it as `--prompt "..."` — confirmed via secondary sources (Ruby
  bindings docs, DeepWiki), consistent with well-documented whisper.cpp behavior. **Not confirmed
  this session**: whether the packaged `whisper.android` example's JNI wrapper actually surfaces
  `initial_prompt` as a settable option, or whether that's a small patch the local run needs to add.
  This is the first concrete local-verification task in §4.

### 1.2 sherpa-onnx

- **Whisper-small int8 ONNX size**: **≈239 MB** (encoder+decoder combined; fp32 is ≈783 MB), per
  sherpa-onnx's own "Export Whisper to ONNX" docs page. This directly answers the issue's **Open
  Question 3** — well under the 0.5 GB budget, not just an extrapolation from the tiny.en numbers as
  the issue worried. Re-confirm against the live docs page before relying on it for a final go/no-go
  (a second fetch of the same page 403'd later in this session — plausibly a rate limit, not a
  retraction, but re-check).
- **Android**: sherpa-onnx ships a Kotlin API (small surface — data classes + config objects, e.g.
  `OfflineRecognizer`/`OfflineTts`-style wrappers) and an Android AAR. The repo is large and ships
  demo apps per model family; this session did not get a direct, pinned citation to a
  **whisper-specific** Android demo app (only general confirmation that the Android/Kotlin
  integration exists and that at least one third-party app — `phone-whisper` — already wraps
  sherpa-onnx's Whisper on Android). Check `android/` in `k2-fsa/sherpa-onnx` directly once GitHub
  access is unconstrained (works fine on a normal machine).
- **Domain-prompt biasing — real finding, not just unconfirmed**: sherpa-onnx has **no
  `initial_prompt` mechanism for its Whisper models**. GitHub issue
  [k2-fsa/sherpa-onnx#2295](https://github.com/k2-fsa/sherpa-onnx/issues/2295) ("whisper prompts?"),
  opened June 2025, was still open with no maintainer response as of this session. This answers the
  issue's **Open Question 1** for candidate 2 directly: **no**, domain-prompt biasing has no
  equivalent hook in sherpa-onnx today. Per the issue's own framing, that's "a real accuracy cost to
  weigh against any latency win, not just an integration inconvenience" — worth weighting sherpa-onnx's
  results accordingly once measured, the same way `docs/asr-model-comparison.md` treats un-promptable
  candidates (moonshine, wav2vec2) as scored on their un-prompted best case.

### 1.3 Vosk

- **Model sizes**: `vosk-model-small-en-us-0.15` ≈ 40 MB, `vosk-model-small-pl-0.22` ≈ 40.4 MB (via
  secondary sources mirroring alphacephei's official models page, which itself 403'd directly in this
  session, §0) — both comfortably under the issue's ~50 MB-each estimate.
  `scripts/android-asr-fetch-models.sh` re-confirms the real size on download.
- **Android**: official demo at `alphacep/vosk-android-demo`, confirmed to exist; "near-zero JNI
  work" per the issue's framing matches what's findable — Vosk ships ready Kotlin/Java bindings.
- **Grammar-constrained decoding — mechanism confirmed**, answering part of **Open Question 2**:
  `Recognizer.setGrammar(grammar: String)` takes a JSON array of allowed phrases (or `"[]"` for the
  default open-vocabulary graph) and replaces the WFST decoding graph with a subgraph restricted to
  just those words — narrowing candidates from tens of thousands to a few dozen. This is the concrete
  API for "restrict the decoder to a closed physics-jargon word list" the issue proposes. **What's
  still unmeasured** (needs the real device run): whether that restriction actually beats
  prompt-biased whisper-small on this vocabulary, or just narrows the failure mode differently. No
  equivalent of Whisper's free-text `initial_prompt` exists in Vosk beyond the grammar mechanism —
  consistent with, not contradicting, the issue's own statement.
- **Output-shape concern in the issue text turns out to be already handled** — see §3.

### 1.4 wav2vec2-base-960h (stretch candidate)

- sherpa-onnx's own docs list a `wav2vec2_asr` CTC model category — this **contradicts** the issue's
  hedge that wav2vec2 "isn't in sherpa-onnx's supported set (confirm)": sherpa-onnx does have some
  wav2vec2 support. What's **not** confirmed this session: whether that support extends to an
  arbitrary Hugging Face checkpoint like `Xenova/wav2vec2-base-960h` specifically, or only to
  sherpa-onnx's own separately-exported wav2vec2 models (sherpa-onnx generally needs its own export
  format, not just any ONNX file with the right op set). Needs a direct check of sherpa-onnx's
  wav2vec2 docs/scripts once network access allows it — a five-minute check, not a re-run of this
  whole research pass.
- Given this is already the stretch/time-permitting candidate in the issue, and the desktop numbers
  (`docs/asr-model-comparison.md`) already show wav2vec2-base-960h scoring **0% E2E** on this app's
  closed-vocabulary corrector/matcher (CTC output has no digits, no punctuation, and the corrector's
  Whisper-shaped rules can't parse it), it's reasonable to deprioritize this one further if device
  time runs short — the desktop result is a strong prior that the mobile result won't differ in kind.

## 2. The issue's open questions — answered as far as desk research allows

1. **Does domain-prompt biasing have an equivalent hook in whisper.cpp or sherpa-onnx?**
   whisper.cpp: **yes**, `initial_prompt`/`--prompt` (mechanism confirmed; whether the Android
   example exposes it is a local TODO, §4.2). sherpa-onnx: **no** — confirmed absent, open unanswered
   upstream issue (§1.2). This is a real, asymmetric finding: if sherpa-onnx's raw accuracy without
   prompting can't close the gap to prompted whisper-small's 91% E2E baseline
   (`docs/voice-pipeline-feasibility.md` §2.4.1), sherpa-onnx starts the comparison behind on
   mechanism, not just on measurement not yet taken.
2. **Does Vosk's grammar-constrained mode meaningfully outperform prompt-biased Whisper on this
   vocabulary?** Still fully open — this is exactly the kind of question that needs the real audio
   run, and desk research can't substitute for it. What's newly available: the precise API
   (`setGrammar`) and mechanism (WFST subgraph restriction) to actually implement the comparison,
   which the issue itself hadn't pinned down yet.
3. **Confirm sherpa-onnx's actual whisper-small int8 file size before treating it as budget-safe.**
   **Answered**: ≈239 MB combined (encoder+decoder), comfortably under the 0.5 GB budget — see §1.2
   for the citation and the one caveat (re-confirm against the live page; a second fetch attempt in
   this session was blocked, plausibly by rate-limiting rather than the number being wrong).

## 3. Output contract — so the local run needs zero new scoring code

This repo already has two scoring scripts (`scripts/e2e-audio-intents.ts`, `scripts/asr-score-slots.mjs`)
that consume a specific JSON shape, produced today by `scripts/asr-transcribe.mjs`:

```json
{
  "modelId": "whispercpp/ggml-small-q5_1",
  "dtype": "q5_1",
  "withPrompt": true,
  "loadS": 1.8,
  "records": [
    {
      "speaker": "km",
      "id": "stress-001",
      "raw": "...transcript text...",
      "secs": 2.1,
      "error": null
    }
  ]
}
```

Field notes for an Android harness targeting this contract:

- `modelId` / `dtype` — free-form labels (e.g. `"sherpa-onnx/whisper-small-int8"`,
  `"vosk/small-en-us+small-pl"`); the scoring scripts only echo these for display, never branch on
  their value.
- `withPrompt` / `loadS` — read by `asr-score-slots.mjs`'s label line. Set `withPrompt: false` for
  candidates with no prompt mechanism (sherpa-onnx, Vosk) rather than omitting the field.
- `records[].speaker` + `.id` — **must** match the eval set's `{speaker}/{id}.wav` naming
  (`eval/audio/{km,lg,mn}/<id>.wav`) so `e2e-audio-intents.ts`'s lookup against `eval/intents.jsonl`
  and `asr-score-slots.mjs`'s hand-written slot table both resolve. `id` is one of the 30 fixed IDs in
  `scripts/asr-transcribe.mjs`'s `IDS` array — only emit a record for ids that actually have a `.wav`
  file for that speaker (some speakers are missing a few of the 30, hence 89 total clips, not 90).
- `records[].raw` — plain-text transcript, **no post-processing**. The correction layer
  (`src/lib/asr/correct/core.ts`) and matcher (`src/lib/intent/matcher.ts`) already operate on raw
  text architecture-agnostically — proven by this repo's own moonshine/wav2vec2 rows in
  `docs/asr-model-comparison.md`, which scored non-Whisper free-text transcripts through these exact
  unmodified scripts. **The issue's own caution that "Vosk may need a stubbed adapter since its
  output shape differs from Whisper's" turns out to be unnecessary** — Vosk's plain-text output
  (lowercase, unpunctuated, like Moonshine's) fits the same `raw` field and needs no adapter, only the
  same awareness the existing docs already have that a corrector tuned on Whisper's error shapes may
  help CTC/Vosk-style output less well.
- `records[].secs` — wall-clock seconds for that clip's inference. If a runtime exposes a
  prefill/decode split (the issue explicitly wants this where available), add optional
  `prefillSecs`/`decodeSecs` fields — neither scoring script reads them today, but record them in the
  raw JSON for the write-up in §5 regardless.
- `records[].error` — `null` on success, else the runtime's error string; both scoring scripts skip
  any record with `error` set, matching how `asr-transcribe.mjs` itself handles decode failures.

Once a candidate's harness writes one such JSON file per model/config (e.g. to
`/sdcard/Android/data/<package>/files/`), pull it back and score it with the **exact commands already
used for every other model in this repo**:

```bash
adb pull /sdcard/Android/data/<package>/files/whisper-small-q5_1.json eval/results/android-2026-xx-xx/
pnpm eval:e2e  eval/results/android-2026-xx-xx/whisper-small-q5_1.json
pnpm asr:score eval/results/android-2026-xx-xx/whisper-small-q5_1.json
```

Both scripts default to the shipped corrector (`src/lib/asr/correct/core.ts`, issue #28) — the same
one the live app runs — so the numbers are directly comparable to every existing row in
`docs/voice-pipeline-feasibility.md` and `docs/asr-model-comparison.md` with no extra flags needed.

### Reference result-writer (Kotlin, untested in this session)

Not compiled or run anywhere this session (no Android SDK, §0) — a starting point to adapt into
whichever candidate's example app, using `org.json` (ships with the Android platform, no extra Gradle
dependency needed):

```kotlin
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

data class ClipResult(
    val speaker: String,
    val id: String,
    val raw: String,
    val secs: Double,
    val error: String? = null,
)

fun writeResults(
    outFile: File,
    modelId: String,
    dtype: String,
    withPrompt: Boolean,
    loadS: Double,
    records: List<ClipResult>,
) {
    val root = JSONObject()
    root.put("modelId", modelId)
    root.put("dtype", dtype)
    root.put("withPrompt", withPrompt)
    root.put("loadS", loadS)
    val recordsArr = JSONArray()
    for (r in records) {
        val rec = JSONObject()
        rec.put("speaker", r.speaker)
        rec.put("id", r.id)
        rec.put("raw", r.raw)
        rec.put("secs", r.secs)
        rec.put("error", r.error) // JSONObject.put(String, null) writes JSON null, not absent
        recordsArr.put(rec)
    }
    root.put("records", recordsArr)
    outFile.writeText(root.toString(2))
}
```

## 4. Runbook for the local continuation

### 4.1 Fetch models

Run `scripts/android-asr-fetch-models.sh` (added this session) on a machine with normal network
access. It downloads into `.android-asr-cache/` (gitignored, same convention as `.hf-cache/`),
verifies each file actually landed, and prints its size so you can sanity-check against §1's figures
before copying anything onto a device. The sherpa-onnx URL in particular is a best-guess from the
well-known k2-fsa GitHub-releases convention, not independently confirmed this session (§1.2) — the
script uses `curl -f` so a wrong guess fails loudly with a 404 instead of silently saving garbage; if
it fails, get the real URL from
<https://k2-fsa.github.io/sherpa/onnx/pretrained_models/whisper/> and
<https://github.com/k2-fsa/sherpa-onnx/releases>.

### 4.2 whisper.cpp

1. `git clone https://github.com/ggml-org/whisper.cpp` and open `examples/whisper.android` in
   Android Studio.
2. Copy `ggml-small-q8_0.bin` (start with q8_0 — this project's existing desktop numbers are all q8,
   §1.1's RAM note says budget for the larger of the two regardless) into
   `app/src/main/assets/models/`.
3. Copy the eval clips as `.wav` samples (16 kHz mono — same format `loadAudio()` in
   `scripts/asr-transcribe.mjs` already converts to via ffmpeg, so no re-encoding needed if you reuse
   the same files) into `app/src/main/assets/samples/`.
4. **Confirm §1.1's open TODO first**: check whether the example's JNI wrapper exposes
   `initial_prompt`. If not, that's a small patch (the C++ side already supports it) before this
   candidate can be compared on equal footing with this project's prompted whisper-small baseline —
   worth doing since un-prompted whisper-small underperforms its own prompted numbers by a wide
   margin (§2.4 of `docs/voice-pipeline-feasibility.md`: 88.0% vs 95.6% raw slot tokens).
5. Wire the app to loop over all 89 sample clips, capture wall-clock per clip, and emit the §3 JSON
   contract instead of (or alongside) whatever the example's UI shows.
6. Run the **release** build variant on-device (debug builds skip compiler optimizations whisper.cpp
   relies on for real-world latency).

### 4.3 sherpa-onnx

1. Get the whisper-small int8 model (§4.1) and the sherpa-onnx Android AAR/demo per
   `k2-fsa/sherpa-onnx`'s `android/` directory.
2. Since there's no `initial_prompt` hook (§1.2, §2), this candidate runs **un-prompted only** — score
   it against this project's own un-prompted whisper-small numbers
   (`docs/asr-model-comparison.md`'s "Un-prompted" table) as the fairer comparison, and separately
   against the prompted numbers to be explicit about the mechanism gap, the same way that doc already
   handles moonshine/wav2vec2.
3. Same loop-over-clips-and-emit-JSON approach as whisper.cpp.

### 4.4 Vosk

1. Get both `vosk-model-small-en-us-0.15` and `vosk-model-small-pl-0.22` (§4.1).
2. Start from `alphacep/vosk-android-demo`.
3. For the plain (non-grammar) baseline run, use the model matching each clip's language as normal
   dictation.
4. For the grammar-constrained variant (§1.3, §2), build the closed vocabulary list from this
   project's own alias tables (`src/lib/aliases/`) plus unit/quantity keywords — that's the actual
   "physics-jargon word list" the issue proposes constraining Vosk's decoder to, and it already exists
   in this repo rather than needing to be authored from scratch.
5. Emit both runs (plain and grammar-constrained) as separate JSON files per the §3 contract so
   they show up as distinct rows in §5.

### 4.5 wav2vec2 (stretch, only if time allows)

Confirm the sherpa-onnx-vs-Xenova-checkpoint compatibility question from §1.4 first — five minutes of
checking sherpa-onnx's wav2vec2 export docs — before investing in a build. Given the 0% desktop E2E
result already on record, treat this strictly as a latency/RAM data point (per the issue's own
framing: "include only for the encoder-only/no-autoregressive-decode latency data point"), not an
accuracy comparison.

### 4.6 Battery / thermal capture

Run `scripts/android-asr-battery-bench.sh` (added this session) around each candidate's full 89-clip
batch run:

```bash
scripts/android-asr-battery-bench.sh snapshot before-whisper-cpp
# ... run the whisper.cpp benchmark on-device ...
scripts/android-asr-battery-bench.sh snapshot after-whisper-cpp
scripts/android-asr-battery-bench.sh diff before-whisper-cpp after-whisper-cpp
```

It wraps `adb shell dumpsys battery` (level/temperature) and `adb shell dumpsys thermalservice`
(throttling status enum: NONE/LIGHT/MODERATE/SEVERE/CRITICAL/EMERGENCY/SHUTDOWN) — exactly the
"rough before/after battery-percentage reading" the issue asks for, no more, no less.

### 4.7 Scoring

Per candidate/config, `adb pull` the JSON (§3) into a new `eval/results/android-2026-xx-xx/`
directory and run `pnpm eval:e2e` + `pnpm asr:score` against it (§3's exact commands). Commit the raw
JSONs (text only, same convention as every existing `eval/results/*` directory) alongside the filled-in
§5 table.

## 5. Results — template, unfilled

No cell below has been measured. Filling this in (replacing every `?`) is what actually resolves
issue #120 — everything above is groundwork, not a substitute for it.

| Pipeline                                                                | audio→intent slot match | median s/clip | p90 s/clip | battery/thermal note |
| ----------------------------------------------------------------------- | ----------------------- | ------------- | ---------- | -------------------- |
| whisper-small + prompt, desktop CPU (Node, baseline)                    | 91% (81/89)             | 2.3 s         | —          | n/a (desktop)        |
| candidate 1 — whisper.cpp ggml-small-q8_0, real device                  | ?                       | ?             | ?          | ?                    |
| candidate 1b — whisper.cpp ggml-small-q5_1, real device                 | ?                       | ?             | ?          | ?                    |
| candidate 2 — sherpa-onnx whisper-small int8, real device (un-prompted) | ?                       | ?             | ?          | ?                    |
| candidate 3 — Vosk small EN+PL, plain, real device                      | ?                       | ?             | ?          | ?                    |
| candidate 3b — Vosk small EN+PL, grammar-constrained, real device       | ?                       | ?             | ?          | ?                    |
| _(stretch)_ candidate 4 — wav2vec2-base-960h, real device               | ?                       | ?             | ?          | ?                    |

## 6. Files added this session

- `docs/android-asr-runtime-bench.md` — this file.
- `scripts/android-asr-fetch-models.sh` — downloads the model weights for all candidates; run
  locally, not runnable in this session (§0).
- `scripts/android-asr-battery-bench.sh` — `adb`-based before/after battery + thermal snapshot
  helper; needs a connected device, not runnable in this session.
- `.gitignore` — added `/.android-asr-cache/`, mirroring the existing `/.hf-cache/` entry.

## Sources consulted this session

- [ggml-org/whisper.cpp](https://github.com/ggml-org/whisper.cpp) — license, model memory table.
- [ggml-org/whisper.cpp — examples/whisper.android](https://github.com/ggml-org/whisper.cpp/tree/master/examples/whisper.android) — Android example setup.
- [ggml-org/whisper.cpp Discussion #348 — add initial_prompt parameter?](https://github.com/ggml-org/whisper.cpp/discussions/348) and general `--prompt` CLI documentation (secondary sources: RubyDoc.info whispercpp gem docs, DeepWiki).
- [k2-fsa/sherpa-onnx — Export Whisper to ONNX](https://k2-fsa.github.io/sherpa/onnx/pretrained_models/whisper/export-onnx.html) — whisper-small fp32/int8 file sizes.
- [k2-fsa/sherpa-onnx#2295 — whisper prompts?](https://github.com/k2-fsa/sherpa-onnx/issues/2295) — no `initial_prompt` support, open/unanswered.
- [k2-fsa/sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx) — Android/Kotlin API existence, wav2vec2_asr model category.
- Vosk model sizes and Android demo — via search results mirroring alphacephei.com's official models page (direct fetch 403'd, §0) and [alphacep/vosk-android-demo](https://github.com/alphacep/vosk-android-demo).
- `setGrammar` mechanics — [alphacep/vosk-api issues #1617](https://github.com/alphacep/vosk-api/issues/1617), [#1584](https://github.com/alphacep/vosk-api/issues/1584), [#1720](https://github.com/alphacep/vosk-api/issues/1720), and [alphacephei.com/vosk/android](https://alphacephei.com/vosk/android).
