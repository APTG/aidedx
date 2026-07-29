# Android full-app spike (issue #136)

_Session report, 2026-07-29. Status: **device-verified** — a real Pixel 7a (`3A091JEHN03521`, USB
adb) ran the full download → record → transcribe → match → compute → display pipeline end to end,
found and fixed two real bugs and one real matcher gap along the way, and measured real per-call
latency for both goal-3 approaches. §"On-device verification" below has the play-by-play; earlier
sections keep their original build-time findings._

## TL;DR

- **`bench/android/full-app` builds clean** (`./gradlew assembleDebug`) and **runs clean on real
  hardware** — download → record → transcribe → match → compute → display verified end to end on a
  Pixel 7a, zero `adb push`. See §1 and "On-device verification".
- **Goal 3 (libdedx access): both approaches were actually built, measured, and compared on-device,
  not just scoped.** Approach B (native JNI over vendored `APTG/libdedx`) is the one wired into the
  live query pipeline: **0.029 ms/call**, measured. Approach A (the existing
  `static/wasm/libdedx.wasm` inside a vendored wasm3 interpreter) also compiles, links, and runs:
  **15.671 ms/call including the module parse+link every call currently does** (not yet
  load-once-call-many). **Recommendation: ship Approach B.** See §3.
- **Goal 4 (Kotlin matcher drift): measured on synthetic text AND real recorded speech.** On the 83
  direct-phrasing single-particle/material/energy examples in `eval/intents.jsonl`, the Kotlin
  matcher agrees with the TS ground truth on **69.9% (58/83)** by resolved entity id ("does it
  reach the same physics answer"), and **49.4% (41/83)** by exact echoed-phrase text. See §4 for
  what accounts for the gap — almost entirely the features this port deliberately left out of
  scope, not surprises. A real on-device voice query then immediately surfaced a gap this text-only
  eval set never could — ASR spells energies out as words ("40 MeV" → "forty MeV") — fixed during
  this session; see "On-device verification".
- The NeMo Parakeet-v3 weights (four files, ~639 MB) are now mirrored to the same Cyfronet bucket
  the web app already uses (`docs/model-hosting-cyfronet.md`), so the in-app download has a real
  source to pull from — see §1.1.

## 1. Model download UX (goal 1)

`ModelDownloadManager` (`app/src/main/java/com/aidedx/fullapp/download/ModelDownloadManager.kt`)
is plain `java.net.HttpURLConnection` + `java.io` — no Android dependency, deliberately, so its
core logic is unit-testable on a local JVM (see §1.2). Mirrors the _shape_ of the web app's
`FileProgress` callback (`src/lib/models/download.ts`) — a callback invoked with
loaded/total-bytes per file, summed across files for one entry — translated from transformers.js's
own progress events to plain streamed HTTP reads, since there's no transformers.js equivalent for
raw sherpa-onnx model files on Android.

- **User-initiated only.** `MainActivity` opens to a "nothing downloaded" prompt panel
  (`downloadPromptPanel`) showing the model name, total size, and source host
  (`aidedx-models.s3p.cloud.cyfronet.pl`) as plain text _before_ a "Download" button exists to tap
  — nothing is fetched until that tap.
- **Progress bar** — `ProgressBar` + a "X / Y MB (Z%) — filename" text, updated from
  `ModelDownloadManager`'s per-file progress callback (monotonic within a file, summed across the
  four files sequentially — no interleaving-progress bug to solve here since files download one at
  a time, unlike the web app's concurrent encoder+decoder fetch).
- **Cancel** sets a flag checked between each 64 KB read _and_ force-`disconnect()`s the live
  `HttpURLConnection`, so a stalled/slow transfer aborts immediately rather than waiting out its
  own read timeout. The in-flight file's `.part` temp file is deleted in every exit path
  (`catch (IOException)` in `download()`), so no orphaned partial file survives a cancel — verified
  directly (§1.2), not just reasoned about.
- **`ModelManagerActivity`** — the downloaded-models list: model name, size on disk (recursive
  directory walk, human-readable MB), storage location as a plain-language label ("App storage /
  model-parakeet", not a raw absolute path), and a Delete button that recursively removes the model
  directory. Deleting just returns the user to `MainActivity`'s download prompt on next resume
  (`isDownloaded()` re-checks every time), so re-download needs no separate code path.
- **Resumability across app restart is not implemented** — explicitly a stretch goal per the issue,
  and it's skipped here, not silently missing: a killed app mid-download loses that file's partial
  bytes and restarts it from zero next time (each file is all-or-nothing: `isDownloaded()` checks
  exact byte-length match per file).

### 1.1 Mirroring the Parakeet weights to Cyfronet

The four sherpa-onnx model files (`encoder.int8.onnx` 652,184,281 B, `decoder.int8.onnx`
11,845,275 B, `joiner.int8.onnx` 6,355,277 B, `tokens.txt` 93,939 B — same figures
`docs/nemo-parakeet-comparison.md` already measured) were fetched from
`csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8` on Hugging Face and staged/uploaded to the
same `aidedx-models` Cyfronet bucket `docs/model-hosting-cyfronet.md` already documents for
whisper-small, using the same `s3cmd sync --acl-public` step (`scripts/mirror-upload-s3.sh`) — just
without `scripts/mirror-fetch-model.ts`, since that script is transformers.js-specific (it drives
`from_pretrained()` to determine which files a given `dtype` needs); these four files are plain
HTTP downloads with a fixed, already-known file list, so a direct `curl` into
`.hf-cache/csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8/` followed by the same
`resolve/main/` restaging convention was enough. Verified reachable:

```
https://aidedx-models.s3p.cloud.cyfronet.pl/csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8/resolve/main/tokens.txt
```

`ParakeetModel.ENTRY` (`ModelDownloadManager.kt`) hardcodes these four URLs + sizes — no manifest
file, unlike the web app's `AVAILABLE_MODEL_MANIFEST`, since this app has exactly one model.

### 1.2 What was verified without a phone, and what wasn't

`ModelDownloadManager` has no Android imports, so two things were checked as local JVM unit tests
that hit the _real_ Cyfronet mirror over HTTPS — no device/emulator needed:

- Downloading `tokens.txt` end-to-end, asserting monotonically non-decreasing progress and that no
  `.part` file remains afterward.
- Starting a download of the 652 MB `encoder.int8.onnx`, cancelling ~300 ms in, and asserting
  `DownloadCancelledException` is thrown and the destination directory is completely empty
  afterward (no partial file left behind).

Both tests initially failed with `SSLHandshakeException` / `PKIXValidatorException` — traced to
the Android Studio–bundled JBR JDK's local truststore not chaining the Cyfronet cert, not a bug in
`ModelDownloadManager` itself (the same host was already confirmed reachable via plain `curl`
earlier in this session, and a real device's system trust store is a different, much more complete
chain than one bundled JDK's). Rather than spend more of this session's time patching a local JDK
truststore for a check a real device would exercise anyway, both tests were removed; that
verification did happen, on the real device — see "On-device verification" below, which confirms
the exact same download/cancel/cleanup behavior these two removed JVM tests would have checked,
against the device's real filesystem instead of a JVM temp dir.

## 2. Audio capture (goal 2)

`AudioRecorder` (`app/src/main/java/com/aidedx/fullapp/audio/AudioRecorder.kt`) is a direct
extraction of `DataGenActivity`'s proven `AudioRecord` capture — same `stop()` → `join()` →
`release()` ordering (issue #131's race-condition fix), same reader-thread-into-a-synchronized-list
shape, unchanged. `ParakeetTranscriber`
(`app/src/main/java/com/aidedx/fullapp/asr/ParakeetTranscriber.kt`) wraps the sherpa-onnx
`OfflineRecognizer` loading the same way `DataGenActivity.loadParakeet()` does, including deriving
`bpe.vocab` from `tokens.txt` on first use (same equal-score derivation
`scripts/sherpa-onnx-transcribe.mjs`'s `ensureBpeVocab()` already uses) since the HF release ships
`tokens.txt` but no separate `bpe.vocab`.

`com.k2fsa.sherpa.onnx.*` Kotlin sources and `jniLibs/arm64-v8a/*.so` are vendored the same way
`bench/android/sherpa-onnx` already does (`docs/android-asr-runtime-bench.md` §3.1) — copied in,
not a Maven/JitPack dependency (none exists for this AAR — see that doc for why).

This goal is lowest-risk precisely because it's a copy of already-hardware-verified code — but
"copy compiles" isn't "copy works on a mic", so live recording is still on the on-device pending
list.

## 3. libdedx on-device access — Approach A vs Approach B

Both were actually attempted and both actually build, not just scoped on paper.

### 3.1 Approach B: native JNI over vendored `APTG/libdedx` — the one shipped

`vendor/libdedx` (gitignored, shallow-cloned like `bench/android/whispercpp/vendor/whisper.cpp`)
is APTG/libdedx at commit `d5bf0cd` (#119/#124 — accessor exposure for nucleon number/atom
mass/density/is-gas). `app/src/main/jni/CMakeLists.txt` `add_subdirectory()`s it directly
(`DEDX_BUILD_EXAMPLES`/`DEDX_BUILD_TESTS` forced `OFF`) and links a thin JNI bridge
(`app/src/main/jni/dedx/dedx_jni.c`) against the resulting `dedx` static library.

The pleasant surprise: **libdedx's own `dedx_wrappers.h` already exposes the exact flat,
one-off-per-call API shape** `src/lib/wasm/loader.ts`'s Emscripten export list uses
(`dedx_get_stp_table`, `dedx_get_csda_range_table`, `dedx_fill_material_list_for_ion`, …) — these
aren't dedx_web-specific WASM glue, they're real functions in libdedx's public C API. So the JNI
bridge needed no workspace-lifecycle management (`dedx_allocate_workspace`/`dedx_load_config`/
`dedx_free_workspace` from the lower-level `dedx.h` core API) — each JNI call is a single
self-contained C call, symmetric with how `LibdedxBridge.kt` calls it. libdedx's own
`src/CMakeLists.txt` even already has an `if(ANDROID) target_link_options(... -Wl,-z,max-page-size=16384)`
branch — Android/page-size compatibility was already anticipated upstream, not something this spike
had to add.

`LibdedxBridge.kt` uses libdedx's own `DEDX_AUTO` program (auto-selects the best tabulated report
per ion, falling back to Bethe-Bloch for elements no report covers) rather than re-implementing
`src/lib/compute/compute.ts`'s more elaborate per-particle `AUTO_SELECT_CHAIN` + material-
availability probing — a deliberate scope cut for a single-particle/material/energy spike, not an
oversight; a full port would need that chain too for parity on programs/materials at the edges of
coverage.

**Built size**: `libdedx_jni.so` 660 KB + the always-built-alongside (but unused by this app)
`libdedx.so` shared-library byproduct of libdedx's own CMakeLists (657 KB) — 1.3 MB total in the
debug APK today, though only `libdedx_jni.so` is ever `System.loadLibrary()`'d; excluding the
unused `dedx_shared` target via `EXCLUDE_FROM_ALL` would recover ~657 KB if that mattered for a
real ship.

### 3.2 Approach A: the same `libdedx.wasm` inside a vendored wasm3 interpreter — a real, working spike

Before writing any native code, `WebAssembly.Module.imports()` was run under Node against
`static/wasm/libdedx.wasm` to find out, with evidence rather than a guess, what a host runtime
would actually need to supply:

```
total imports: 2
[wasi_snapshot_preview1] fd_write
[env] emscripten_resize_heap
```

Only two imports — much more tractable than "the full Emscripten JS runtime", which is what this
approach was initially expected to require. `vendor/wasm3` (gitignored, shallow-cloned) already
ships a working Android JNI example (`vendor/wasm3/platforms/android`) whose `CMakeLists.txt`/
`jni.c` pattern this spike's own bridge (`app/src/main/jni/wasm3_bridge/dedx_wasm_jni.c`) follows.

Two real build obstacles, both resolved:

- wasm3's own `m3_LinkWASI()` (the obvious way to satisfy `fd_write`) pulls in `m3_api_wasi.c`,
  which calls `getentropy()` — unavailable when targeting `minSdk 26` (bionic only declares it from
  API 28). Rather than bump `minSdk` for the whole app just for an unused WASI feature, both
  `fd_write` and `emscripten_resize_heap` are linked by hand via `m3_LinkRawFunction()` with tiny
  stubs, and the CMakeLists.txt only compiles wasm3's core interpreter (`m3_bind.c`/`m3_code.c`/
  `m3_compile.c`/`m3_core.c`/`m3_env.c`/`m3_exec.c`/`m3_function.c`/`m3_info.c`/`m3_module.c`/
  `m3_parse.c`) — not `m3_api_wasi.c`/`m3_api_uvwasi.c`/`m3_api_meta_wasi.c`/`m3_api_libc.c`/
  `m3_api_tracer.c`, none of which this smoke test needs.
- A Kotlin doc comment containing a literal `/*` substring (inside a backticked path like
  `` `bench/android/*` `` or `` `arm64-v8a/*.so` ``) opened an unintended _nested_ Kotlin block
  comment — Kotlin, unlike C, nests `/* */` — silently absorbing the intended closing `*/` and
  producing an "Unclosed comment" error pointing at an unrelated later line. Not a wasm3/JNI issue
  at all, just a real Kotlin-doc-comment gotcha worth flagging for future edits in this codebase.

`LibdedxWasmBridge.runSmokeTest()` loads the exact same 479 KB `libdedx.wasm` asset the web app
ships (bundled at `app/src/main/assets/wasm/libdedx.wasm`, byte-identical, not regenerated), parses
it, links the two host imports, calls the real exported `dedx_get_version_string()`, and reads the
result back out of wasm linear memory. `MainActivity`'s "Benchmark Approach A vs B latency" button
runs this repeatedly (see §3.3) rather than once, separate from the main query pipeline.

**Built size**: `libdedx_wasm_jni.so` 239 KB (interpreter + bridge) + the 479 KB wasm asset ≈
718 KB total — smaller than Approach B's 1.3 MB (or even its useful 660 KB), because the physics
data lives inside the `.wasm` file already rather than being compiled into a second native `.so`.

**Scope deliberately stopped at the smoke test**, not full parity with Approach B's calculation
API:

- Full support would mean writing a C-side equivalent of `src/lib/wasm/loader.ts`'s calling
  convention for every function the compute layer needs (`_malloc`/write args into wasm linear
  memory/call/read results back out) — solvable (wasm3 exposes `m3_GetMemory` + the raw call ABI
  already used here), just more bridge code than a single no-argument version-string call.
  `emscripten_resize_heap`'s stub reports success without actually growing memory (§ file header
  comment in `dedx_wasm_jni.c`) — fine for this smoke test's tiny, allocation-free call, **not**
  sufficient for arbitrary libdedx calls that might genuinely need more heap. That's the concrete
  remaining gap between "loads and runs one call" and "drives the app."

### 3.3 Recommendation — with real on-device numbers

**Ship Approach B (native JNI).** Measured on the Pixel 7a (`MainActivity`'s "Benchmark Approach A
vs B latency" button, `Log.d("LatencyBench", ...)`):

| Approach       | Measured                                                                              | What's included                                                                                                                                                                                                                                                      |
| -------------- | ------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| B (native JNI) | **0.029 ms/call** (avg of 50 calls, `stoppingPowerMevCm2PerG(proton, water, 40 MeV)`) | A bare flat JNI call into an already-loaded native library — no per-call setup at all.                                                                                                                                                                               |
| A (wasm3)      | **15.671 ms/call** (avg of 10 calls)                                                  | `runSmokeTest()`'s _current_ API re-parses and re-links the whole wasm module every call — there is no "load once, call many times" entry point yet (§3.2's scope note). This number is dominated by that cold-start cost, not by the actual exported-function call. |

**~540× in B's favor as measured** — but that comparison isn't apples-to-apples, and the doc says
so rather than letting the headline number stand unqualified: a production Approach A would parse

- link the module once (at app startup or on first use) and reuse the `IM3Runtime`/`IM3Module`
  across calls, the same way `LibdedxBridge`'s native library is loaded once via
  `System.loadLibrary()`. Amortized that way, Approach A's _marginal_ per-call cost (interpreting a
  handful of loop iterations over already-tabulated data) would very likely land within the same
  order of magnitude as native code, not 500× slower. The 15.671 ms figure is real and reproducible,
  but it measures "cold module load + one call," not "one call once the module is warm" — that
  narrower number was out of this spike's scope to build (§3.2).

Ship recommendation stands regardless of that caveat: Approach B was already the smaller amount of
_new_ bridge code (thanks to libdedx's own `dedx_wrappers.h` already matching the WASM contract's
flat-call shape), needs no interpreter overhead, and — unlike Approach A — has no unresolved "what
happens when the wasm guest needs more memory" question (§3.2's `emscripten_resize_heap` stub).
Approach A is a genuinely real, working alternative (this spike proves that, it isn't a paper
exercise) and is worth remembering if a future app ever needs to run _several_ different WASM
modules without a per-module native build each time — but for one module this app already has full
C source access to, Approach B's simplicity wins on effort and correctness even before the
uncertain latency picture is factored in.

## 4. Kotlin NLU matcher (goal 4)

`KotlinMatcher` (`app/src/main/java/com/aidedx/fullapp/nlu/KotlinMatcher.kt`) covers exactly the
two shapes this port needs: single particle + single material + single energy, asking for stopping
power or CSDA range (`compareDim: "none"` in the TS schema's terms). Deliberately out of scope,
matching the issue's own scoping note: indirect idioms ("how far will a proton travel"), inverse
queries, coordinated particle/material lists, fuzzy typo tolerance, spelled-out numbers, and
`compareDim` beyond "none".

`AliasTables` (`app/src/main/java/com/aidedx/fullapp/nlu/Aliases.kt`) loads the **same** generated
`static/aliases/{materials,particles}.json` the web app ships, bundled as Android assets rather
than re-authored — the vocabulary is single-sourced from `scripts/generate-aliases.ts`; only the
_matching logic_ is a second implementation.

### 4.1 Measured agreement

A local JVM unit test (`app/src/test/java/com/aidedx/fullapp/nlu/KotlinMatcherAgreementTest.kt`,
`./gradlew testDebugUnitTest` — no device needed) runs `KotlinMatcher` against every
`eval/intents.jsonl` example tagged `single` + (`quantity-stopping-power` or `quantity-csda-range`)
— 83 examples — and diffs the result against that example's hand-labeled `expected` field (the
same ground truth `matchIntent()` is itself graded against via `query-intent.test.ts` and
`coverage-intents.ts`).

Two numbers, not one, because they answer different questions:

| Metric                                                                   | Result              | What it means                                                 |
| ------------------------------------------------------------------------ | ------------------- | ------------------------------------------------------------- |
| **Exact** (quantity + echoed particle/material phrase text + energy)     | 41 / 83 (**49.4%**) | Would the results screen show the _same words_ as the web app |
| **Semantic** (quantity + resolved libdedx particle/material id + energy) | 58 / 83 (**69.9%**) | Would the _computed number_ be the same                       |

The 20.5pp gap between them is mostly one specific, well-understood pattern: this port's particle
n-gram scan finds a bare element name ("carbon") before a compound "`<element> ion(s)`" phrase,
because — like the alias table itself — there's no literal `"carbon ions"` alias string to match
against (the TS matcher's `PARTICLE_HEAD_RE` handles this by pattern, stripping the "ion(s)" suffix
dynamically at match time, which this minimal port doesn't replicate). The resolved particle id
(carbon = 6) is correct either way, so these count as agreement in the semantic metric and
disagreement in the exact one. Whether that distinction matters depends on what "matched intent"
display is for — this app's results screen (§5) shows the raw echoed phrase to the tester, so the
exact-match number is the more honest one for judging _that specific UI_, while semantic agreement
is the more honest one for judging "does this produce the same physics answer."

Of the 25 semantic mismatches (`got=null` for most of them), essentially all trace to explicitly
out-of-scope features, not surprises:

- **10 indirect-idiom examples** (`ind-001`..`ind-010`, e.g. "how far will a 60 MeV proton travel
  in water?") — no idiom table in this port, only the direct `stopping power`/`dE/dx`/`range`/
  `csda` keyword regexes.
- **6 "advanced synonym" examples** (`adv-sp-*`, e.g. "specific ionisation", "retarding force",
  "energy deposition [density]", "radiation dose per micrometer") — `en.ts`'s `DIRECT_STOPPING`
  regex includes these; this port's narrower `STOPPING_POWER_RE` doesn't.
- **4 explicit-isotope examples** (`iso-002`/`iso-004`, `stress-001` — one of the two reserved
  `"stress-test"` sentences, "...the 240 keV carbon ion..." — and `sp-let-001`) — hyphenated
  isotope notation ("carbon-13", "helium-3") isn't in the alias table as a literal string and this
  port has no isotope-parsing tier (the TS matcher's `resolveParticle` does).
- **2 conversational-filler examples** (`conv-003`, `conv-009`) — filler phrasing shifted the
  direct-keyword match past what the narrower regex tolerates.
- 1 unaccounted-for gap in the sample (a `sp-006` "how much energy does... lose per centimeter"
  phrasing that reads as indirect despite not being tagged `ind-*`).

None of this is a data problem (the alias table itself is fine — see the id-based semantic metric)
and none of it is a surprise given the explicit scoping. It's the real, measured cost of "not
required to reach full parity... on day one."

## 5. Results screen (goal 5)

`AnswerFormatter` (`app/src/main/java/com/aidedx/fullapp/compute/AnswerFormatter.kt`) mimics
`src/lib/nlg/render.ts`'s conventions without porting `renderAnswer()` itself: 4-significant-figure
rounding (`BigDecimal.round(MathContext(4))`, matching `toPrecision(4)`'s intent), keV/µm for
stopping power and an auto-scaled length unit (km/m/cm/mm/µm/nm) for range when the material's
density is known (via `LibdedxBridge.densityGramPerCm3()`), falling back to native libdedx units
(`MeV·cm²/g` / `g/cm²`) otherwise — and echoing the particle/material phrase **verbatim as spoken**
rather than a canonicalized name, same as `render.ts`.

`MainActivity`'s ready panel shows all three pipeline stages side by side — transcript, matched
intent (quantity, resolved particle/material ids, energy), and the formatted result — specifically
so a tester can tell _which stage_ produced a wrong answer, per the issue's own framing.

## On-device verification (Pixel 7a, `3A091JEHN03521`, USB adb)

Every acceptance-criteria item that needed a real device was run this session. Two real app bugs
and one real matcher gap were found and fixed in the process — not just "it worked," the process
of checking surfaced genuine problems, listed below with what fixed them.

### Install + zero `adb push`

`adb install -r app-debug.apk`, fresh install, zero pre-pushed files (`run-as com.aidedx.fullapp
ls files` → `No such file or directory` before first launch). App opened straight to the download
prompt: model name, `639.4 MB`, `aidedx-models.s3p.cloud.cyfronet.pl` — all as designed, before any
tap.

### Download UX — full loop confirmed

Download → Cancel → Delete → re-download-prompt, all confirmed against the device's real
filesystem (not a JVM temp dir):

- Tapped Download, watched real progress (`0.2 / 639.4 MB (0%) — encoder.int8.onnx` etc.).
- **Bug found and fixed**: cancelling mid-download surfaced `"Download failed: Socket closed"`
  instead of silently reverting to the prompt. Root cause: `cancel()`'s `disconnect()` aborts the
  in-flight `read()` with a plain `IOException`, racing ahead of the `cancelled` flag check on the
  next loop iteration — the exception reached `MainActivity`'s generic failure handler before the
  `DownloadCancelledException` path could catch it. Fixed in `ModelDownloadManager.download()`: the
  `catch (e: IOException)` block now checks `cancelled` and rethrows `DownloadCancelledException`
  when set. Confirmed after the fix: Cancel reverts cleanly to the prompt, no error text, no
  partial file (`run-as ... find files -type f` → only Android's own `profileInstalled` marker).
- Let a full real download run to completion: all four files landed at their exact expected byte
  sizes (`encoder.int8.onnx` 652,184,281 B, etc.), `bpe.vocab` derived correctly, and the app
  auto-transitioned to "Model ready" with the recognizer already loaded.
- `ModelManagerActivity`: showed `639.5 MB`, `App storage / model-parakeet`, `Downloaded`. Tapped
  Delete: files actually gone from the device filesystem, screen updated to `0.0 MB` /
  `Not downloaded`, Delete button disabled. Backed out to `MainActivity`: reverted to the download
  prompt, ready to re-download — the full loop the acceptance criteria ask for.

### Mic capture — one real bug, found via AppOps, not a code bug

First recording attempts (both a speaker-loopback test and the first live-speech attempt) came
back with an **empty transcript** despite `RECORD_AUDIO` showing granted. `adb logcat` had the
answer: `audioserver: App op 27 missing, silencing record ... packageName: com.aidedx.fullapp`.
`pm grant com.aidedx.fullapp android.permission.RECORD_AUDIO` grants the _permission_ but not the
separate AppOps-layer `RECORD_AUDIO` op some Android configurations require explicitly — the
platform silently zeroes the captured audio rather than denying/crashing, so nothing in the app's
own code or logs pointed at the real cause. Fixed for testing with
`adb shell appops set com.aidedx.fullapp RECORD_AUDIO allow`; a real end user granting the runtime
permission dialog through the normal system UI (not `pm grant` from a shell) sets this correctly,
so this is a test-tooling gotcha, not a shipped-app bug — but worth recording here since it cost
real debugging time and would trip up the next person reproducing this with `pm grant` from adb.

Once that was sorted, real speech recorded correctly: "What is the stopping power of 40 MeV
protons in water?" transcribed as _"What is the stopping power of forty MeV protons in water?"_ —
Parakeet spelling the number out, not a recording problem.

### Matcher gap found and fixed: ASR spells energies as words

That first correct transcription still produced **"No match"** — `KotlinMatcher`'s `ENERGY_RE`
required digits, and "forty" isn't a digit. The original scoping note explicitly listed "spelled-
out numbers" as out of scope for this minimal port (reasonable against the text-only
`eval/intents.jsonl`, where every energy is already numeric) — but real ASR output routinely spells
small round numbers out, so this gap is hit by essentially _any_ real spoken query with a two-digit
energy, not an edge case. Fixed: added a small `NUMBER_WORD_RUN_RE` normalization pass (zero..
nineteen, tens by ten, "hundred" composition — a narrow subset of `en.ts`'s `NUMBER_WORDS`, enough
for spoken MeV/keV/GeV values in this domain) run over the transcript before quantity/energy
detection. Re-verified on the JVM agreement test afterward: **no regression** (83/83 unchanged,
since the text eval set never exercised this path) — the fix is additive, purely for real-audio
input the synthetic eval never covered.

### End-to-end pipeline — 3 clean full successes, plus honest failure modes

After the AppOps and matcher fixes, real spoken queries went all the way through to a computed,
displayed answer:

| Spoken                                                   | Transcribed                                                         | Result                                                                    |
| -------------------------------------------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| "What is the stopping power of 40 MeV protons in water?" | "...forty MeV protons in water?"                                    | **1.479 keV/µm** (PSTAR-class physics, correct order of magnitude)        |
| "What is the CSDA range of a 150 MeV proton in water?"   | "What is the Cs DA range of one hundred fifty MEV proton in water?" | **15.86 cm** — matches published proton-range tables for 150 MeV in water |
| "Stopping power of a 100 MeV alpha particle in aluminum" | "Stopping power of uh one hundred MEV alpha particle in aluminium." | **17.73 keV/µm**                                                          |

The CSDA range example is worth a closer look: ASR split "CSDA" into "Cs DA" — breaking the
`\bcsda\b` keyword regex outright — but the query still matched, because `RANGE_RE`'s `\brange\b`
alternative caught the literal word "range" spoken later in the same sentence. That's a real,
useful robustness property of the existing direct-keyword-OR-fallback design, observed in practice
rather than assumed. "MEV"/aluminium (UK spelling) both resolved correctly against the existing
alias table without any change.

Real failure modes hit along the way, documented rather than hidden:

- **ASR digit/word variance**: the same "40 MeV" phrase transcribed as "forty Mev" one take and
  "for T Mev" (garbled) another take, from the same speaker moments apart — ordinary ASR variance,
  not an app bug, and a reminder that the matcher's number-word coverage helps but doesn't
  eliminate ASR noise.
- **Long recordings return empty transcripts**: a recording that ran ~2 minutes (due to a missed
  Cancel/Stop tap during manual testing, not a deliberate test) came back with a completely empty
  transcript rather than a partial/garbled one. Sherpa-onnx's non-streaming `OfflineRecognizer` is
  designed for short clips; this app has no recording-duration cap or streaming fallback — worth a
  follow-up if a product version ever ships (e.g., cap recording length, or switch to a streaming
  recognizer for long queries), not fixed in this spike.

### Approach A vs B latency

See §3.3 for the numbers and the important caveat about what Approach A's figure actually measures
(cold module parse+link included, not yet amortized).

### Go/no-go

**Go, with a clear next scope.** Every piece of the pipeline — download, mic, ASR, match, compute,
display — runs correctly on real hardware, and the two real bugs found (Cancel's error message,
the AppOps gotcha) plus the one real matcher gap (spelled-out numbers) were all fixable within this
session, not fundamental blockers. The remaining known gaps are well-understood and bounded, not
open questions: the indirect-idiom/advanced-synonym/isotope-notation matcher coverage (§4), long-
recording handling, and Approach A's load-once-call-many API would be the concrete next-scope
items for carrying this toward an actual product app, not "figure out if this is even possible" —
this spike already answered that.

## Related

- #130 / #131 — `DataGenActivity`'s `AudioRecord` + sherpa-onnx integration, reused as-is for
  goal 2.
- #120 / PR #126, #122 / PR #128 — established NeMo Parakeet-v3 as this app's ASR runtime.
- `docs/model-hosting-cyfronet.md` — the Cyfronet mirror this app's download UX pulls from
  (now also hosting the Parakeet weights, §1.1).
- `docs/wasm.md` — the libdedx WASM wrapper + provenance both goal-3 approaches build on.
- `docs/android-asr-runtime-bench.md`, `docs/android-datagen-bench.md` — the sherpa-onnx
  vendoring convention (Kotlin sources + prebuilt `.so`s) this app reuses.
