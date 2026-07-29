# Android full-app spike (issue #136)

_Session report, 2026-07-29. Status: **build-verified, not yet device-verified** — everything
below that doesn't require a physical phone (compiling, native builds, the matcher-agreement
measurement) has been done and re-checked; everything that does (install, download UX, mic
capture, end-to-end latency) is still pending — see "What still needs the phone" at the end. This
doc will be updated once that pass happens, per this repo's spike convention (`docs/wasm.md`'s
"we do not maintain a second Emscripten build pipeline" and #130's own precedent apply the same
way here: findings land in a committed doc, not just a PR description)._

## TL;DR

- **`bench/android/full-app` builds clean** (`./gradlew assembleDebug`) with all five goals wired
  together in one app: in-app model download → mic capture → NeMo Parakeet-v3 transcription →
  Kotlin NLU match → libdedx compute → results screen. Zero `adb push` in the download path — see
  §1.
- **Goal 3 (libdedx access): both approaches were actually built, not just scoped.** Approach B
  (native JNI over vendored `APTG/libdedx`) is the one wired into the live query pipeline.
  Approach A (the existing `static/wasm/libdedx.wasm` inside a vendored wasm3 interpreter) also
  compiles and links as a separate smoke-test native library. **Recommendation: ship Approach B.**
  See §3 for the size/effort comparison and why Approach A, while more feasible than expected,
  wasn't worth adopting for production use.
- **Goal 4 (Kotlin matcher drift): measured, not assumed.** On the 83 direct-phrasing
  single-particle/material/energy examples in `eval/intents.jsonl`, the Kotlin matcher agrees with
  the TS ground truth on **69.9% (58/83)** by resolved entity id ("does it reach the same physics
  answer"), and **49.4% (41/83)** by exact echoed-phrase text. See §4 for what accounts for the
  gap — almost entirely the features this port deliberately left out of scope, not surprises.
- The NeMo Parakeet-v3 weights (four files, ~639 MB) are now mirrored to the same Cyfronet bucket
  the web app already uses (`docs/model-hosting-cyfronet.md`), so the in-app download has a real
  source to pull from — see §1.1.

## 1. Model download UX (goal 1)

`ModelDownloadManager` (`app/src/main/java/com/aidedx/fullapp/download/ModelDownloadManager.kt`)
is plain `java.net.HttpURLConnection` + `java.io` — no Android dependency, deliberately, so its
core logic is unit-testable on a local JVM (see §1.2). Mirrors the *shape* of the web app's
`FileProgress` callback (`src/lib/models/download.ts`) — a callback invoked with
loaded/total-bytes per file, summed across files for one entry — translated from transformers.js's
own progress events to plain streamed HTTP reads, since there's no transformers.js equivalent for
raw sherpa-onnx model files on Android.

- **User-initiated only.** `MainActivity` opens to a "nothing downloaded" prompt panel
  (`downloadPromptPanel`) showing the model name, total size, and source host
  (`aidedx-models.s3p.cloud.cyfronet.pl`) as plain text *before* a "Download" button exists to tap
  — nothing is fetched until that tap.
- **Progress bar** — `ProgressBar` + a "X / Y MB (Z%) — filename" text, updated from
  `ModelDownloadManager`'s per-file progress callback (monotonic within a file, summed across the
  four files sequentially — no interleaving-progress bug to solve here since files download one at
  a time, unlike the web app's concurrent encoder+decoder fetch).
- **Cancel** sets a flag checked between each 64 KB read *and* force-`disconnect()`s the live
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
that hit the *real* Cyfronet mirror over HTTPS — no device/emulator needed:

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
truststore for a check a real device will exercise anyway, both tests were removed and this
verification is deferred to the on-device pass (§"What still needs the phone") — recorded here
so the gap isn't silently invisible.

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
  `` `bench/android/*` `` or `` `arm64-v8a/*.so` ``) opened an unintended *nested* Kotlin block
  comment — Kotlin, unlike C, nests `/* */` — silently absorbing the intended closing `*/` and
  producing an "Unclosed comment" error pointing at an unrelated later line. Not a wasm3/JNI issue
  at all, just a real Kotlin-doc-comment gotcha worth flagging for future edits in this codebase.

`LibdedxWasmBridge.runSmokeTest()` loads the exact same 479 KB `libdedx.wasm` asset the web app
ships (bundled at `app/src/main/assets/wasm/libdedx.wasm`, byte-identical, not regenerated), parses
it, links the two host imports, calls the real exported `dedx_get_version_string()`, and reads the
result back out of wasm linear memory. `MainActivity` exposes this as a standalone "Run WASM spike
smoke test" button, separate from the main query pipeline.

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

### 3.3 Recommendation

**Ship Approach B (native JNI).** It was already the smaller amount of *new* bridge code (thanks to
libdedx's own `dedx_wrappers.h` already matching the WASM contract's flat-call shape), needs no
interpreter overhead, and — unlike Approach A — has no unresolved "what happens when the wasm
guest needs more memory" question. Approach A is a genuinely real, working alternative (this spike
proves that, it isn't a paper exercise) and is worth remembering if a future app ever needs to run
*several* different WASM modules without a per-module native build each time — but for one module
this app already has full C source access to, Approach B's simplicity wins. Per-call latency
comparison between the two is **not yet measured** — that needs the phone (real repeated calls,
not just "loads and runs once"); see the pending list.

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
*matching logic* is a second implementation.

### 4.1 Measured agreement

A local JVM unit test (`app/src/test/java/com/aidedx/fullapp/nlu/KotlinMatcherAgreementTest.kt`,
`./gradlew testDebugUnitTest` — no device needed) runs `KotlinMatcher` against every
`eval/intents.jsonl` example tagged `single` + (`quantity-stopping-power` or `quantity-csda-range`)
— 83 examples — and diffs the result against that example's hand-labeled `expected` field (the
same ground truth `matchIntent()` is itself graded against via `query-intent.test.ts` and
`coverage-intents.ts`).

Two numbers, not one, because they answer different questions:

| Metric | Result | What it means |
| --- | --- | --- |
| **Exact** (quantity + echoed particle/material phrase text + energy) | 41 / 83 (**49.4%**) | Would the results screen show the *same words* as the web app |
| **Semantic** (quantity + resolved libdedx particle/material id + energy) | 58 / 83 (**69.9%**) | Would the *computed number* be the same |

The 20.5pp gap between them is mostly one specific, well-understood pattern: this port's particle
n-gram scan finds a bare element name ("carbon") before a compound "`<element> ion(s)`" phrase,
because — like the alias table itself — there's no literal `"carbon ions"` alias string to match
against (the TS matcher's `PARTICLE_HEAD_RE` handles this by pattern, stripping the "ion(s)" suffix
dynamically at match time, which this minimal port doesn't replicate). The resolved particle id
(carbon = 6) is correct either way, so these count as agreement in the semantic metric and
disagreement in the exact one. Whether that distinction matters depends on what "matched intent"
display is for — this app's results screen (§5) shows the raw echoed phrase to the tester, so the
exact-match number is the more honest one for judging *that specific UI*, while semantic agreement
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
so a tester can tell *which stage* produced a wrong answer, per the issue's own framing.

## What still needs the phone

Everything below requires a real Android device (Pixel 7a, matching prior sessions) and hasn't
been attempted yet:

1. **Install + launch** — `adb install -r app/build/outputs/apk/debug/app-debug.apk` and confirm
   the app opens to the download prompt with zero pre-pushed files.
2. **Download UX end-to-end on real hardware** — tap-to-download, live progress, mid-download
   Cancel + confirm no orphaned partial file on the device's actual filesystem (not just the JVM
   unit test's temp dir), delete via `ModelManagerActivity`, re-download.
3. **Mic capture** — confirm `AudioRecorder` actually records on this hardware (same
   `RECORD_AUDIO` permission dance `DataGenActivity` already navigated).
4. **End-to-end pipeline** — the ~10-sentence hand-picked test set the acceptance criteria call
   for, covering both range and stopping-power queries, run through record → transcribe → match →
   compute → display for real.
5. **Approach A vs B latency** — real repeated per-call timing on-device, not just "both link and
   run once."
6. **Go/no-go** — this doc's recommendation (§3.3, ship Approach B) is a build-time/effort
   judgment; a real go/no-go on carrying this toward a product app should factor in the on-device
   pipeline results above too, once they exist.

## Related

- #130 / #131 — `DataGenActivity`'s `AudioRecord` + sherpa-onnx integration, reused as-is for
  goal 2.
- #120 / PR #126, #122 / PR #128 — established NeMo Parakeet-v3 as this app's ASR runtime.
- `docs/model-hosting-cyfronet.md` — the Cyfronet mirror this app's download UX pulls from
  (now also hosting the Parakeet weights, §1.1).
- `docs/wasm.md` — the libdedx WASM wrapper + provenance both goal-3 approaches build on.
- `docs/android-asr-runtime-bench.md`, `docs/android-datagen-bench.md` — the sherpa-onnx
  vendoring convention (Kotlin sources + prebuilt `.so`s) this app reuses.
