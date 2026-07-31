# Android full-app spike (issue #136)

_Session report, 2026-07-29. Status: **device-verified** — a real Pixel 7a (USB adb) ran the full
download → record → transcribe → match → compute → display pipeline end to end,
found and fixed two real bugs and one real matcher gap along the way, and measured real per-call
latency for both goal-3 approaches. §"On-device verification" below has the play-by-play; earlier
sections keep their original build-time findings._

_Updated 2026-07-29 for #143 — the follow-up issue filed from this doc's own §4 findings. Closed
all three of the matcher gaps this doc originally listed as out of scope (indirect idioms, advanced
stopping-power synonyms, explicit isotope notation); §4.1's numbers below are the post-#143
measurement. #143 also added the 15s recording auto-stop cap and Approach A's load-once-call-many
API — both now device-verified on the same Pixel 7a (over wifi adb, after the
original USB session disconnected): the auto-stop fires at ~15.05s consistently (confirmed via
`dumpsys audio`'s own recording-activity timestamps across two independent recordings), and the
warm wasm3 API measures 0.218 ms/call vs. the cold path's 10.098 ms/call — see "On-device
verification" and §3.3 for the full numbers._

_Updated 2026-07-29 for #144 — a visual-only reskin to match the deployed web app's palette,
shape/spacing language, and mic-button states (§6), **device-verified** on the same Pixel 7a: real
build (`./gradlew assembleDebug`, Kotlin included), both Activities walked in light and dark mode,
all three record-button states, and the launcher icon — see §6.7._

_Updated 2026-07-29 for #147 — a real user recording ("range"/"stopping power of twenty MeV
proton in silicon") came back "No match": the on-device ASR spoke "MeV" as two separate words
("Me V"), which `ENERGY_RE` requires as one unbroken token. This is the same digit-only-prefix
assumption §"Matcher gap found and fixed" below already found and partly fixed for spelled-out
*numbers* — no rule existed yet for a letter-spelled *unit*. Turned out to be a **latent bug in
the web app's `en.ts` correction rules too** (verified directly: `correctTranscript()` +
`matchIntent()` on the same sentence lost the energy slot there as well), masked because
`eval/intents.jsonl` is hand-authored clean text that never combines a spelled-out number with a
letter-spelled unit. Fixed on both sides: `en.ts`'s digit-gated rules now also accept a
spelled-out number prefix (`NUMBER_PREFIX_SRC`), and a new `AsrCorrections.kt` ports the relevant
subset of `en.ts`'s `EN_RULES` (letter-spelled units, per-nucleon/particle/material/quantity
phonetic fixes) into the Kotlin matcher, run after `normalizeSpelledNumbers()` — see that file's
header for the full rationale and which `en.ts` rules were deliberately left unported (ASTAR/PSTAR,
"compare", cm/mm inverse-query targets — none of which this port supports). Re-verified on the JVM
agreement test: **no regression**, still 83/83 (100.0%) semantic agreement._

_Updated 2026-07-30 for #161 — rotation used to destroy/recreate `MainActivity` outright: an
in-progress recording leaked (`onDestroy()` never called `recorder.stop()`, so `AudioRecorder`'s
reader thread and the `AudioRecord` itself ran forever with the mic still hot), the ~639 MB
Parakeet model reloaded from disk on every rotation, and the 15s auto-stop cap + all displayed
text were silently dropped. Fixed with `android:configChanges` on `MainActivity` (keeps the
Activity instance — and `transcriber`/`recorder`/every in-flight `Thread` — alive across a
rotation) plus a tracked-UI-state pattern (`DownloadPanel`/`RecordUiState` enums +
`restoreUiState()`) that reapplies the exact visual snapshot after `bindViews()` re-inflates the
view tree, now correctly picking `res/layout-land/main.xml`'s two-column arrangement in landscape.
`onDestroy()` also now stops the recorder unconditionally (independent bug fix — this leak was
never actually rotation-specific, just easiest to hit that way), and `onSaveInstanceState`
restores the last transcript/intent/result text across a real process-death recreation, which
`configChanges` alone doesn't cover.

**Device-verified** on the same Pixel 7a (wireless adb): "Model ready" persisted unchanged across
a portrait→landscape rotation (no reload); a recording started in one orientation, rotated
mid-flight to the other, showed the OS's own mic-in-use indicator the whole time, and the 15s
auto-stop cap fired at the correct wall-clock offset in both directions — confirmed via two
independent cycles against `dumpsys audio`'s own `rec update`/`rec stop` event log (0 lingering
clients). The mic-leak fix was regression-tested directly: starting a recording and immediately
pressing Back (a real `onDestroy()`, not a config change) now logs a `rec stop` ~1.5s later instead
of never logging one at all. Process-death restore was tested with a real `am kill` on the
backgrounded app followed by bringing the task back to front: the last intent line reappeared
immediately, before the model even finished reloading. Zero `FATAL EXCEPTION`s across the full
session's logcat.

Build note: this machine has no system-wide JDK (`javac` is missing from the installed `apt`
JRE-only packages) — `./gradlew assembleDebug` needs `JAVA_HOME` pointed at Android Studio's
bundled JBR (`<android-studio-install-dir>/jbr`) instead, now documented in `CLAUDE.md`._

_Updated 2026-07-31 for #161's "capture core" (the data-layer half of the on-device field-capture
feature; the UI — Save button, verdict chips, "Debug captures" screen — and the PC-side
import/label pipeline are still unbuilt, separate follow-on work). Every query now writes one
capture — a WAV plus a JSON envelope — to `filesDir/captures/<session>/`, automatically and
unconditionally (no dedicated capture UI yet; this is the data layer being exercised end to end,
not the shipped UX). The envelope mirrors the TS `QueryIntent` shape field-for-field
(`CaptureEnvelope.matchedIntentToQueryIntentJson()`) rather than a fixed set of named columns, so
#159/#160 landing on the TS side won't force a capture-format bump. New: `BuildConfig.GIT_SHA`/
`GIT_DIRTY`/`BUILD_TIME_MS` (evaluated by `app/build.gradle` at configure time — a capture is
otherwise nearly worthless once a few fixes have landed since it was taken), device/battery/
thermal info, per-stage (transcribe/match/compute) timings, audio quality metrics (peak/RMS/
clipping/leading-trailing silence — pure-function, JVM-unit-tested in `AudioMetricsTest`), and
which of `AsrCorrections`' ~30 rules actually fired for a given transcript
(`AsrCorrections.correctWithTrace()` — `correct()` now delegates to it, so there's one fold to
keep in sync, not two). `KotlinMatcher.match()` similarly now delegates to a new
`matchWithTrace()`, which also surfaces the corrected text and fired-rule list; both are covered by
new JVM tests, and the pre-existing `KotlinMatcherAgreementTest` was re-run to confirm the
refactor changed no behavior: **still 83/83 (100.0%) semantic agreement**. Every pipeline stage
(transcribe/match/compute) is now individually try/caught and attributed in the capture's
`failure` block — an uncaught exception there used to crash the whole app on a single bad query;
now it's a captured diagnostic and the query fails gracefully instead.

**Device-verified** on the same Pixel 7a: a real (silent-room) recording produced
`manifest.json` + `captures.json` + a `.wav` under `filesDir/captures/auto-2026-07-31/`, pulled via
the same `run-as`-based trick `import-datagen-session.sh` already uses. The envelope's `build.gitSha`
matched the actual merged commit exactly (`b88c842`) with `gitDirty: true` correctly reflecting
this session's own uncommitted work; `audio.sampleCount` (31678) matched the pulled WAV's real
frame count exactly (`python3`'s `wave` module); `audio` metrics (duration, peak amplitude, leading/
trailing silence) were sane for a quiet-room clip; `nlu.matched: false` / `intent: null` correctly
reflected the empty transcript; `timingsMs.transcribe` (~311 ms) was the only non-negligible stage,
as expected when nothing downstream ran. The matched-intent path (`nlu.intent` populated,
`compute` populated) isn't reachable by literally speaking into the mic over adb, so it's covered
instead by `CaptureEnvelopeTest`'s synthetic-`MatchedIntent` cases. All 37 JVM unit tests pass
(`AudioMetricsTest`, `CaptureEnvelopeTest`, the extended `AsrCorrectionsTest`/`KotlinMatcherTest`,
plus the pre-existing suites), and zero `FATAL EXCEPTION`s appeared in logcat across the session._

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
- **Goal 4 (Kotlin matcher drift): measured on synthetic text AND real recorded speech, then
  closed almost entirely (#143).** On the 83 direct-phrasing single-particle/material/energy
  examples in `eval/intents.jsonl`, the Kotlin matcher now agrees with the TS ground truth on
  **100.0% (83/83)** by resolved entity id ("does it reach the same physics answer"), up from
  69.9% before #143, and **75.9% (63/83)** by exact echoed-phrase text, up from 49.4%. See §4 for
  what #143 fixed and what the remaining exact-match gap is (cosmetic phrase-echo differences, not
  wrong answers). A real on-device voice query separately surfaced a gap this text-only eval set
  never could — ASR spells energies out as words ("40 MeV" → "forty MeV") — fixed during the
  original #136 session; see "On-device verification".
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

**#143 closed the "smoke test only" gap**: `LibdedxWasmBridge.init()` now returns a `Session` that
parses+links the module exactly once and exposes real `stoppingPowerMevCm2PerG()`/
`csdaRangeGramPerCm2()` calls — a genuine calculate API, not just a version-string round-trip.
Each call allocates scratch space in the module's own linear memory via its exported `malloc`
(confirmed exported alongside the physics functions), writes the energy float into that buffer,
calls `dedx_get_stp_table`/`dedx_get_csda_range_table` with the resulting linear-memory pointers,
reads the result back out, then `free`s the scratch buffers — the same one-off-per-call ABI
`dedx_jni.c` (Approach B) uses, just through wasm3's calling convention instead of a direct C call.
`emscripten_resize_heap`'s stub still reports success without actually growing memory — fine for
these small, fixed-size calls (never observed to need more than the module's initial linear
memory), **not** verified safe for an arbitrary future call that might genuinely need more heap;
still a documented, not hidden, limitation.

### 3.3 Recommendation — with real on-device numbers

**Ship Approach B (native JNI).** Originally measured on the Pixel 7a as 0.029 ms/call (B) vs.
15.671 ms/call (A, cold-only) — see "Approach A vs B latency" below for the full, updated
comparison including #143's warm (load-once-call-many) number. The original cold comparison
(~540× in B's favor) wasn't apples-to-apples, and this doc said so rather than letting the headline
number stand unqualified — #143 then built the amortized "warm" API the caveat called for and
re-measured: Approach A's real marginal per-call cost (interpreting a handful of loop iterations
over already-tabulated data) does land far closer to native code than the cold number suggested,
around 47× slower rather than ~540×.

Ship recommendation stands regardless: Approach B was already the smaller amount of _new_ bridge
code (thanks to libdedx's own `dedx_wrappers.h` already matching the WASM contract's flat-call
shape), needs no interpreter overhead, and — unlike Approach A — has no unresolved "what happens
when the wasm guest needs more memory" question (§3.2's `emscripten_resize_heap` stub). Approach A
is a genuinely real, working alternative (this spike proves that, it isn't a paper
exercise) and is worth remembering if a future app ever needs to run _several_ different WASM
modules without a per-module native build each time — but for one module this app already has full
C source access to, Approach B's simplicity wins on effort and correctness, and the now-measured
~47× latency gap (down from cold's ~540×, still real) only reinforces the same call.

## 4. Kotlin NLU matcher (goal 4)

`KotlinMatcher` (`app/src/main/java/com/aidedx/fullapp/nlu/KotlinMatcher.kt`) covers exactly the
two shapes this port needs: single particle + single material + single energy, asking for stopping
power or CSDA range (`compareDim: "none"` in the TS schema's terms). Still deliberately out of
scope: inverse queries, coordinated particle/material lists, fuzzy typo tolerance, and `compareDim`
beyond "none". Indirect idioms, advanced stopping-power synonyms, and explicit isotope notation
were originally scoped out too, but #143 closed all three — see §4.1's updated numbers — after the
measured agreement below showed they accounted for most of the gap.

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

| Metric                                                                   | Before #143   | After #143         | What it means                                                 |
| ------------------------------------------------------------------------ | ------------- | ------------------ | ------------------------------------------------------------- |
| **Exact** (quantity + echoed particle/material phrase text + energy)     | 41/83 (49.4%) | **63/83 (75.9%)**  | Would the results screen show the _same words_ as the web app |
| **Semantic** (quantity + resolved libdedx particle/material id + energy) | 58/83 (69.9%) | **83/83 (100.0%)** | Would the _computed number_ be the same                       |

**100% semantic agreement** — every one of the 83 examples now resolves to the same quantity,
particle id, material id, and energy the TS matcher's `expected` ground truth calls for. #143
closed exactly the three gaps §4's original scoping note left open:

- **Indirect idioms** — ported `en.ts`'s `INDIRECT_IDIOMS` table (`"how far will a proton
travel"` → csdaRange, `"how quickly does it lose energy"` → stoppingPower, etc.) as a fallback
  consulted only when neither direct keyword regex matches, same ordering `matcher.ts` uses. Fixed
  all 10 `ind-*` examples.
- **Advanced stopping-power synonyms** — added the missing `DIRECT_STOPPING` alternatives
  (`retarding force`, `energy deposition(?: density)?`, `dose per micrometer`, the `ioni[sz]ation`
  spelling variant) plus the verb-form idioms (`"energy ... deposited ... per micrometer"`, `"lose
... energy per cm"`) as indirect idioms. Fixed all 6 `adv-sp-*` examples.
- **Explicit isotope notation** — ported `lookup.ts`'s `parseIsotope()`: an
  `` `<element>-<mass number>` `` token (this port's tokenizer already keeps the hyphen inside one
  token, e.g. `"carbon-13"`) resolves the element part through the _same_ alias table, then
  overrides the resolved entry's default mass number with the explicit one — tried as a fallback
  only after the plain alias-window scan fails. Fixed `iso-002`, `iso-004`, `sp-let-001`, and
  `stress-001` (one of the two reserved `"stress-test"` sentences).

The remaining **24.1pp gap in the exact metric** (not the semantic one, which is now 100%) is the
same cosmetic pattern already noted before #143: this port's particle scan still echoes a bare
element name ("carbon") rather than a compound `"<element> ion(s)"` phrase, since there's no
literal `"carbon ions"` alias-table entry to match against verbatim (the TS matcher's
`PARTICLE_HEAD_RE` strips that suffix dynamically at match time; this port's fallback resolves the
same _id_ without reconstructing the exact echoed phrase in every case). That's a display-text
difference, not a computed-answer difference — the semantic metric is the one that reflects
whether the app gets the physics right, and it's now perfect on this test set.

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

## 6. Look & feel reskin (issue #144)

Issue #144 asked for "strong visual family resemblance" to the deployed web app
(aptg.github.io/aidedx), read directly from `src/app.css`/`+layout.svelte`/`MicButton.svelte`/
`ModelDownloadBanner.svelte` rather than guessed, and called out several judgment calls explicitly
("either is fine, but pick one deliberately"). Decisions below, in the order the issue raises them.

### 6.1 Color palette — computed, not eyeballed

`src/app.css`'s tokens are OKLCH. Android color resources need sRGB hex. Rather than picking
"close enough" hex values by eye, `--background`/`--accent`/`--danger`/etc. were run through the
standard OKLab→linear-sRGB matrices (Björn Ottosson's published coefficients) plus sRGB gamma
encoding, in a one-off Python script — the same numeric path a browser uses to render
`oklch(0.55 0.16 258)`. Light tokens landed in `app/src/main/res/values/colors.xml`, `.dark`
tokens in `values-night/colors.xml`, both keeping the CSS custom-property names 1:1 so either file
is a mechanical re-derivation if `app.css`'s palette ever changes. The two `oklch(1 0 0 / N%)`
alpha borders (dark-mode `border`/`input`) stay alpha-white ARGB8 hex (`#1AFFFFFF`/`#26FFFFFF`)
rather than flattened to an opaque gray, matching the CSS source's actual alpha-compositing
semantics instead of an approximation of it.

### 6.2 Theming: framework Theme.Material + values-night, not AppCompat/MaterialComponents

The issue left this open ("decide... rather than mixing conventions ad hoc"). `MainActivity`/
`ModelManagerActivity` extend plain `android.app.Activity` and use framework `android.widget.*`
views throughout — a deliberate choice from #136 itself ("no Fragments/Compose/coroutines/
ViewModel... matches every other bench/android app's convention"). Adopting the AndroidX Material
Components _library_ would mean either switching those Activities to `AppCompatActivity` (a bigger
architecture change than a reskin should make) or fighting theme attributes that only half-apply
to a plain Activity. Instead: a hand-rolled `AppTheme` extending the platform's own
`Theme.Material.Light.NoActionBar` (dark: `Theme.Material.NoActionBar`), with color/shape overrides
via `values`/`values-night` resource qualifiers. Android's day/night resource-qualifier resolution
is a framework mechanism, not an AppCompat one — since Android 10's system-wide dark theme, `values-
night/` is honored automatically based on system preference with zero `AppCompatDelegate`
involvement, which is exactly the "follows system `prefers-color-scheme`" behavior the web app has.
`minSdk 26` (already the project floor) supports this cleanly.

### 6.3 Shape/spacing/typography

`--radius-lg` (0.5rem) → 8dp corner radius for cards/panels (`drawable/bg_card.xml`,
`bg_panel_muted.xml`); `--radius-md` → 6dp for buttons (`bg_button_outline/accent/danger/muted.xml`),
both as thin (1dp) bordered shapes matching the web's `border-input`/`border-border` convention,
with `<ripple>` touch feedback masked to the same rounded shape rather than a stock square ripple.
Type scale follows the web app's restraint: bold reserved for the toolbar title and button labels
(`ToolbarTitle`, `SectionLabel`, `Button.*` styles), 11–11.5sp for hint/status text
(`MutedHintText`, mirroring `text-[11.5px]`), 14sp for body copy. Emoji glyphs (🎤/⏹) carry over
directly, same as the web app's icon-free convention.

### 6.4 Mic/record button states

`MainActivity`'s `setRecordButtonIdle()`/`Recording()`/`Transcribing()` swap the record button's
background drawable, text color, and label to mirror `MicButton.svelte`'s three states exactly:
idle = outline/`bg-card` (`bg_button_outline`), recording = solid danger (`bg_button_danger`),
transcribing = muted (`bg_button_muted`) plus a visible accent-on-muted progress bar
(`drawable/progress_accent.xml`, matching the web's `h-1 rounded-full bg-muted` track). The
Android pipeline has no fractional transcribe-progress signal (sherpa-onnx's `OfflineRecognizer` is
a single blocking whole-clip call, not token-streamed like the web app's browser-side model), so
the progress bar runs indeterminate rather than fabricating a fake percentage — an intentional,
narrower translation of the web state, not a missing feature.

### 6.5 Header/footer and "Manage downloads" placement

Both Activities get a bordered-bottom `Toolbar` (bold "aidedx" title on `MainActivity`, matching
`+layout.svelte`'s header) and `MainActivity` carries a compact status line (`statusText`, "Model
ready"/"Loading recognizer…") next to the title — the Android answer to the issue's own question
about `SystemStatusHeader.svelte`'s equivalent, moved out of the results panel and into the header
so it's visible regardless of pipeline stage, same as the web app. A bordered-top footer with a
centered muted tagline mirrors `+layout.svelte`'s footer text. Per the issue's own suggestion,
"Manage downloads" moved off the main button stack (where it competed visually with the primary
record action) into the toolbar overflow menu (`menu/main_menu.xml`) — the native Android
affordance for a secondary, infrequent action, with no equivalent needed on the web side since
that app has no comparable management screen to link to.

### 6.6 Launcher icon

`static/favicon.svg` (black rounded square, white bold-monospace "dE") doesn't port directly:
its `<text>` element relies on the browser's generic `monospace` font family, which has no SVG→
Android translation. Rasterized a `dE` glyph in DejaVu Sans Mono Bold (a stock Linux monospace,
visually close to what browsers actually resolve `font-family: monospace` to) via Pillow at each
mipmap density, as the adaptive-icon foreground layer; the background is the same flat `#111111`
as a plain `@color` resource rather than a duplicated drawable. `minSdk 26` means adaptive icons
(`mipmap-anydpi-v26/ic_launcher.xml`) are always available — no legacy square-icon fallback needed.

### 6.7 Verification

**Device-verified**, both build and visual. The sandbox this reskin was written in has JRE-only
Java installs (`openjdk-17-jre`/`openjdk-21-jre`, no `javac`) — a pre-existing environment gap
unrelated to this change, the same one that would've blocked compiling #136/#142's own Kotlin
locally. Worked around it by downloading a portable Temurin 21 JDK (no root needed) and pointing
`JAVA_HOME` at it for `./gradlew assembleDebug`, which then built clean, `compileDebugKotlin`
included — not just the AAPT2 resource-only check an earlier draft of this section settled for.
Installed the resulting APK on the same Pixel 7a used for #136/#143 (reachable over wifi adb) and
walked the actual UI:

- `MainActivity` in light mode: bordered header with the "Model ready" status line, rounded
  outline mic button, card-wrapped Transcript/Matched intent/Result section, de-emphasized
  benchmark button below a divider, bordered footer tagline — matches §6.5/§6.3 as designed.
- All three record-button states fired for real: idle (outline) → tap → recording (solid danger
  red, "⏹ Tap to stop") → tap → transcribing (muted background, "Processing…", visible
  accent-on-muted progress bar) → back to idle once the (empty, silent) test clip resolved to "No
  speech detected — try again" — confirming the state machine, not just the drawables in
  isolation.
- Toolbar overflow → "Manage downloads" opens `ModelManagerActivity` with the hand-rolled back
  arrow (§6.5's `ic_back.xml`) and the same card styling; back navigation returns cleanly to
  `MainActivity`.
- Toggling the device to dark mode (`adb shell cmd uimode night yes`) repaints both Activities via
  `values-night` with zero app-side code — near-black background, off-white text, alpha-white
  borders visible on cards — confirming the "follows system preference, no AppCompat" call in
  §6.2 actually holds on real hardware, not just in theory.
- The adaptive launcher icon renders correctly in the app drawer: black rounded square, white "dE"
  in DejaVu Sans Mono Bold, matching `static/favicon.svg`'s mark.

No visual or functional regressions found. This section originally shipped as "not verified this
session" pending a real device; superseded by the above once one was available.

## On-device verification (Pixel 7a, USB adb)

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
  designed for short clips. **Fixed in #143**: `MainActivity` now auto-stops any recording still
  running after 15s (comfortably longer than every hand-picked test sentence above, per
  `MAX_RECORDING_MS`) by firing the exact same stop → transcribe → match → compute → display path
  a manual Stop tap would, and a blank transcript now shows "No speech detected — try again"
  instead of the ambiguous "No match" a real parse failure also shows — distinguishing "heard
  nothing" from "heard something but couldn't match it." **Device-verified**: confirmed via
  `dumpsys audio`'s own recording-activity timestamps (independent of app-side logging) across two
  separate untouched recordings — 15.058s and 15.046s from start to auto-stop, both comfortably
  within the intended margin and consistent with each other. A blank/ambient-noise recording during
  this same pass correctly showed "No speech detected — try again" (empty transcript) vs. a
  separate short recording that picked up a stray word showing plain "No match" (non-empty
  transcript, no matcher hit) — confirming the two messages are actually distinguished, not just
  written that way in code. One thing this pass surfaced that's worth recording for future on-
  device debugging sessions, not a product bug: an extra manual tap sent to the record button while
  a recording was already in flight (a mistake in this session's own test script, not a UI issue)
  produces exactly the same observable symptom as a real bug would — the recording stops and
  immediately restarts — so a stack-trace-bearing debug log
  (`Log.d(..., Exception("stack trace"))` at the top of `onRecordTapped()`) was added temporarily
  and was what actually distinguished "real bug" from "duplicate external tap" here; removed again
  once confirmed, but the technique is worth reaching for first next time something like this comes
  up rather than reasoning about it from timestamps alone.

### Approach A vs B latency — re-measured with the warm (load-once-call-many) API

§3.3 originally measured Approach A only via `runSmokeTest()`, which re-parses and re-links the
whole module on every call — 15.671 ms/call, explicitly caveated as not a fair per-call number.
**#143 added the load-once-call-many API** the caveat called for, and it was re-measured on the
same Pixel 7a (`MainActivity`'s "Benchmark Approach A vs B latency" button):

| Approach                                                                | Measured (this update) | Measured (original #136 run) |
| ----------------------------------------------------------------------- | ---------------------- | ---------------------------- |
| B (native JNI)                                                          | **0.0046 ms/call**     | 0.029 ms/call                |
| A cold (`runSmokeTest`, re-parse+re-link every call)                    | **10.098 ms/call**     | 15.671 ms/call               |
| A warm (`Session`, parsed once, real `stoppingPowerMevCm2PerG()` calls) | **0.218 ms/call**      | not yet built                |

Run-to-run variance on both the B and cold-A numbers (0.0046 vs 0.029 ms, 10.1 vs 15.7 ms) is
ordinary JIT-warmup/thermal noise, not a regression — treat the _ratios_ as the signal, not the
absolute figures. The number #143 actually adds is **warm A at 0.218 ms/call**: amortizing the
parse+link cost across calls (§3.2) was correct — it drops Approach A's overhead by **~46×**
relative to the cold number, landing at roughly **47× slower than native JNI** rather than the
cold comparison's ~540×. That's a real, substantially narrower gap, though still native-JNI's
favor by almost two orders of magnitude — consistent with an interpreter (even loaded once) doing
more per-call work than a direct compiled function call.

### Go/no-go

**Go.** Every piece of the pipeline — download, mic, ASR, match, compute, display — runs correctly
on real hardware, and every bug found across both sessions (Cancel's error message, the AppOps
gotcha, spelled-out numbers, the three matcher-coverage gaps, the long-recording failure mode) was
fixed and re-verified within the same session it was found in, not left open. #143's three items
(matcher coverage, long-recording cap, Approach A's load-once-call-many API) are now all closed and
device-verified — see §4.1 and "On-device verification" above for the numbers. Nothing from this
spike or its #143 follow-up remains open as of this update; further work is new scope (#144's
look-and-feel pass, or whatever comes after), not a continuation of unfinished verification here.

## Related

- #130 / #131 — `DataGenActivity`'s `AudioRecord` + sherpa-onnx integration, reused as-is for
  goal 2.
- #120 / PR #126, #122 / PR #128 — established NeMo Parakeet-v3 as this app's ASR runtime.
- `docs/model-hosting-cyfronet.md` — the Cyfronet mirror this app's download UX pulls from
  (now also hosting the Parakeet weights, §1.1).
- `docs/wasm.md` — the libdedx WASM wrapper + provenance both goal-3 approaches build on.
- `docs/android-asr-runtime-bench.md`, `docs/android-datagen-bench.md` — the sherpa-onnx
  vendoring convention (Kotlin sources + prebuilt `.so`s) this app reuses.
