# TTS-synthesized eval audio — pilot (issue #30)

_Session report, 2026-07-15. Run on Athena (PLGrid), NVIDIA A100-SXM4-40GB, Python 3.10 venv for
TTS, Node 22 + `@huggingface/transformers` 4.2.0 for ASR (CPU, matching the existing eval
methodology in `docs/voice-pipeline-feasibility.md` / `docs/asr-model-comparison.md`). This is a
**pilot**, not the full issue #30 scope: one TTS voice, the same 30 sentences
`scripts/asr-transcribe.mjs` already has IDs for (the `eval/RECORDING.md` set), scored against the
existing `eval/results/asr-2026-07-15/small-q8-prompt.json` 3-speaker human baseline. Written up
before deciding whether to scale to more voices / all 120 `eval/intents.jsonl` sentences, per the
issue's own "(Contingency, separate decision)" framing._

## TL;DR

- **Model choice: Kokoro-82M** (Apache-2.0, `hexgrad/Kokoro-82M` on Hugging Face) — see §1 for why,
  over Piper (the issue's other suggestion), Chatterbox, and XTTS-v2.
- **Synthesis is essentially free**: 30 domain sentences × 1 voice generated on the A100 in **6.6 s
  total** (0.22 s/clip). Generating all 120 sentences × several voices would still be a
  minutes-not-hours job.
- **whisper-small + domain-prompt on this synthetic audio: 83% clip-pass / 95.7% slot-tokens
  (ext-corrected)** — slightly _below_ the human 3-speaker baseline (93% / 98.6%), not above it.
  This contradicts the issue's working assumption ("synthetic speech is cleaner… treat as a lower
  bound on difficulty") **for this specific voice and this specific corrector** — see §3 for why.
- The gap is mostly **TTS-specific text-normalization artifacts** (Kokoro reads `/` literally as
  "slash" in unit notation) rather than acoustic mumbling — a different failure class than human
  speech produces, and one the existing corrector has zero rules for (§3.1).
- **Operational finding, not specific to TTS**: ASR inference on this Athena node was ~10× slower
  per clip than the reference machine in prior reports, caused by `onnxruntime-node` spawning one
  thread per _physical_ CPU (128) while the cgroup allocation only grants 16 — see §4. Worth fixing
  before running a bigger matrix here.
- **Recommendation**: worth continuing (§5), but fix §4 first and add 2-3 TTS-specific corrector
  rules before scaling to more voices/sentences, so the bigger run isn't dominated by known,
  fixable artifacts.

## 1. Model choice: Kokoro-82M

The issue names Piper and Kokoro as candidates. Checked current (2026-07) rankings before deciding
rather than trusting a Jan-2026 knowledge cutoff on a fast-moving leaderboard (TTS Arena V2,
Hugging Face model trending, several 2026 comparison posts):

| Model                 | License               | Fit for this task                                                                                                                                                                                                                                                                              |
| --------------------- | --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Kokoro-82M**        | Apache-2.0            | 82M params, real-time-plus on CPU and GPU, **54 built-in voices** (20 English) — no cloning needed, so every voice is a free, reproducible, license-clean "speaker". Widely reported as the best small/fast open TTS in 2026.                                                                  |
| Piper                 | MIT                   | Many voices, very fast, but noticeably more robotic/lower-fidelity than Kokoro — the issue lists it as the fallback option, not the pick.                                                                                                                                                      |
| Chatterbox (Resemble) | MIT                   | Higher naturalness, beat ElevenLabs in blind tests — but English-only, needs a _reference clip_ per voice (no free multi-voice bank), and watermarks all output (traceable via PerTh). Overkill for labeled eval audio where naturalness matters less than having many distinct, clean voices. |
| XTTS-v2 (Coqui)       | CPML (non-commercial) | Most-downloaded TTS on HF, but the license blocks use in an open-source project; ruled out on that basis alone.                                                                                                                                                                                |

Kokoro wins on the actual requirement — "many free voices, runs locally, cheap to batch" — better
than either of the issue's own suggestions. Ran via the official `kokoro` PyPI package
(PyTorch + `misaki` G2P) with `device='cuda'`, not `kokoro-onnx`, to use the A100 directly.

## 2. Setup notes (Athena-specific)

Kept out of the way of the repo's Node/TypeScript tooling — Python lives in a **venv at
`.venv-tts/`** (not committed; would need a `.gitignore` entry and a `requirements.txt` if this
graduates from pilot to a real script under `scripts/`).

> **Superseded by `docs/athena-setup.md`**: everything below was worked out ad hoc during this
> pilot. After the follow-up Qwen3-TTS work (§6) hit `$HOME`'s disk quota for real, all of it —
> modules, `PYTHONPATH` fix, and every cache-redirect env var — was consolidated into one sourceable
> script, `scripts/athena-env.sh`, documented there. Read that doc first for any new session; the
> points below are kept as the "why", not a second set of instructions to follow by hand.

- **Python version matters**: the default `Python/3.13.5` module has no prebuilt wheels for
  `blis`/`thinc` (spaCy's dependencies, pulled in by `misaki`'s English G2P) on this platform —
  building from source failed. `Python/3.10.4` (also available as a module) has prebuilt wheels for
  everything; switched to it and the install was clean.
- **`espeakng-loader`** supplies a prebuilt `espeak-ng` shared library + data via pip — no system
  package or root access needed for `misaki`'s phonemizer fallback.
- **`PYTHONPATH` pollution**: Athena's module system unconditionally adds several Python 3.13
  system-package directories (`Python-bundle-PyPI`, `X11`, `cryptography`, …) to `PYTHONPATH`
  regardless of which Python module is loaded. This shadowed the venv's own `regex` package with an
  incompatible cp313 build and broke imports. Fix: `unset PYTHONPATH` after loading modules, before
  activating the venv.
- **GPU**: `torch==2.11.0+cu128` from the official CUDA 12.8 wheel index; confirmed against the
  A100 (`torch.cuda.is_available()` → `True`).
- **Node/ffmpeg**: not preinstalled on PATH; available as modules (`module load FFmpeg/7.1.2
nodejs/22.17.1`). `pnpm` isn't installed cluster-wide; originally installed to `~/.local` via
  `npm install -g pnpm@10.33.0 --prefix=$HOME/.local` (matches `package.json`'s pinned version) —
  **later relocated to scratch** (`docs/athena-setup.md`) once it became clear anything installed
  into `$HOME` counts against the 10 GB quota.

## 3. Results — pilot voice `af_heart`, 30 sentences

Reused `scripts/asr-transcribe.mjs` and `scripts/asr-score-slots.mjs` unmodified — the point of the
pilot was to confirm TTS audio drops into the existing eval pipeline with zero script changes
(`eval/audio/tts-af_heart/<id>.wav`, same layout as `eval/audio/<speaker>/<id>.wav`). Model:
whisper-small q8 + domain prompt (the shipped default, issue #25).

| Metric (ext-corrected)       | TTS pilot (1 voice, 30 clips) | Human baseline (3 speakers, 89 clips) |
| ---------------------------- | ----------------------------- | ------------------------------------- |
| Clip-level all-slots-correct | 83% (25/30)                   | 93% (83/89)                           |
| Slot-token accuracy          | 95.7%                         | 98.6%                                 |
| — raw (no corrector)         | 73% clip / 93.9% tokens       | 80% clip / 95.4% tokens               |
| unit category (raw)          | 83.9%                         | 91.3%                                 |

**Synthetic speech was not cleaner here** — it's the opposite of the issue's working assumption.
Digging into the 5 residual failures explains why:

| Clip                | Heard as                                                      | Cause                                                                                                                              |
| ------------------- | ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `stress-001`        | "the 240-key v-carbon ion"                                    | genuine ASR acoustic miss (keV → "key v"), same failure class as humans                                                            |
| `stress-002`        | "100 MeV-**slash**-nucl"                                      | **TTS-specific**: Kokoro's G2P read the literal `/` in "MeV/nucl" as the word "slash" instead of expanding it                      |
| `sp-005`, `ind-008` | "**adiMeV**/**adMeV** per nucleon" (for "80 MeV per nucleon") | ASR mishearing of "80" specifically before "MeV per nucleon" — same phrase pattern fails both times, worth watching with more data |
| `pernuc-001`        | "290 **MeVu**" (no separator)                                 | **TTS-specific**: Kokoro elided the `/` in "MeV/u" entirely, merging the tokens                                                    |
| `unit-006`          | "900 keV **deuterans**"                                       | ordinary ASR mishearing; the _existing_ `asr-correct-ext.mjs` rule for this already fires correctly                                |

### 3.1 The actionable takeaway

Two of five failures (`stress-002`, `pernuc-001`) are a **new error class specific to
TTS-synthesized text with slash notation** ("MeV/nucl", "MeV/u") that never shows up in human
recordings, because a human reading the sentence aloud says "per nucleon" — they never vocalize
punctuation. The existing corrector (tuned entirely on human speech) has no rule for it. This is
directly useful signal for the issue's own question ("which correction rules fire only for
humans?") — turned around: **which correction rules would be needed only for synthetic audio?**
Answer so far: a rule for TTS engines vocalizing `/` as "slash" in unit notation. A cheap fix
(`asr-correct-ext.mjs`: `/\bmev\s*-?\s*slash\s*-?\s*(nucl|u)\b/i → "MeV/$1"`) would likely close
both gaps, but wasn't added — this pilot's job was to measure the as-shipped corrector, not tune a
new one on n=2 failures.

## 4. Operational finding: thread-affinity slowdown on Athena

Per-clip inference in this run: **median 23.8 s/clip**, vs. **2.3 s/clip** for the same model/settings
in `docs/voice-pipeline-feasibility.md` (a different, non-HPC machine). Both used whisper-small q8

- prompt, CPU only — the ~10× gap is environment, not audio.

`stderr` showed the cause immediately:

```
[E:onnxruntime:onnxruntime-node, env.cc:227 ThreadMain] pthread_setaffinity_np failed for thread:
257404, index: 113, mask: {114, }, error code: 22 error msg: Invalid argument.
```

`onnxruntime-node`'s default thread pool sizes itself to the **physical** core count
(`lscpu` reports 128 on this node) and pins thread _i_ to CPU _i_. The Slurm/cgroup allocation for
this session only grants **16 CPUs** (`nproc` → 16), so ~112 of those pinning calls fail, and the
runtime falls back to running well over 100 threads on 16 real cores — pure scheduling overhead,
not useful parallelism. This will hit **any** Node ASR benchmark run on a shared Athena allocation,
not just this TTS pilot, so it's worth fixing in `scripts/asr-transcribe.mjs`/`asr-batch.mjs`
generally (e.g. pass `session_options: { interOpNumThreads: 1, intraOpNumThreads: <nproc> }` through
`pipeline()`, or set the equivalent env var) before running any larger benchmark on this cluster —
not done here since it's an existing-script change outside this pilot's scope, but it should
precede scaling up (§5) or a 90-clip (3-voice) run will take ~35 minutes instead of ~4.

## 5. Recommendation — before scaling up

This pilot is deliberately small (1 voice, 30 sentences, no repo changes beyond this doc and the
gitignored `eval/audio/tts-af_heart/` + `eval/results/tts-pilot/` outputs) so it could be reviewed
before committing more compute/time. If it's judged useful, the next increments, roughly in order
of cost:

1. Fix the thread-affinity issue (§4) — otherwise every subsequent step is ~10× slower than it
   needs to be on this cluster.
2. Add the 2 remaining planned voices (`am_michael`, `bf_emma` — already chosen for US-male/UK-female
   spread; not yet synthesized) and re-run — checks whether §3's gap is voice-specific or systematic.
3. Add the "slash"-notation corrector rule (§3.1) and re-score — cheap, directly tests the
   diagnosis.
4. Only then extend from 30 to all 120 `eval/intents.jsonl` sentences — this needs `SLOTS` entries
   added to `scripts/asr-score-slots.mjs` for the other 90 examples (currently only the 30
   `RECORDING.md` sentences have hand-written slot specs), which is real, non-automatic work, not
   just more GPU time.
5. The issue's contingency step (LoRA fine-tuning) — not warranted by anything found here; the
   residual failures are exactly the kind the trust UX (issue #10) is designed to catch, not a
   corrector or model gap.

## Reproduction

```sh
# Python venv (one-time)
module load Python/3.10.4
python3 -m venv .venv-tts && source .venv-tts/bin/activate
unset PYTHONPATH   # Athena module system leaks incompatible cp313 site-packages otherwise
pip install torch --index-url https://download.pytorch.org/whl/cu128
pip install kokoro soundfile numpy espeakng-loader
# then: attrs dlinfo joblib segments typing-extensions addict regex certifi cffi docopt
#       exceptiongroup filelock fsspec idna jinja2 requests rich shellingham
# (pip's resolver didn't pull these transitively in this environment; `pip check` in a loop
# until clean is the fastest way to find the full list)

# Node deps (one-time)
module load FFmpeg/7.1.2 nodejs/22.17.1
npm install -g pnpm@10.33.0 --prefix="$HOME/.local"
pnpm install

# Synthesis (Python, GPU) — writes eval/audio/tts-<voice>/<id>.wav
python tts_synthesize.py af_heart      # ~7s for 30 clips on an A100

# ASR eval (Node, CPU) — unmodified project scripts
node scripts/asr-transcribe.mjs onnx-community/whisper-small q8 eval/results/tts-pilot/af_heart-small-q8-prompt.json
node scripts/asr-score-slots.mjs --ext eval/results/tts-pilot/af_heart-small-q8-prompt.json
```

The synthesis script (`tts_synthesize.py`) lives outside the repo for now (pilot only); it reads
sentence text straight from `eval/intents.jsonl` for the 30 IDs `asr-transcribe.mjs` already knows,
and writes 16-bit PCM WAV at Kokoro's native 24 kHz (ffmpeg resamples to 16 kHz mono at ASR time
regardless, same as the human recordings' 44.1/48 kHz source files).

## 6. Heavy-model option: Qwen3-TTS-12Hz-1.7B (plan)

Issue #30 got a comment proposing a heavier model ("Qwen") as an addition to the Kokoro/Piper plan
above, explicitly self-labeled as **desk research — no TTS model actually run that session**. Before
turning that into a task-list item, verified every factual claim in it against primary sources and
then actually ran the model on this A100. This section is the resulting plan, not yet executed
beyond the smoke test below (no eval-audio corpus generated, no ASR scoring run).

### 6.1 What the comment got right, and one thing to correct

The comment names `Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign` and its sibling `-CustomVoice`. Checked
both against the Hugging Face API and the model cards directly (not from training knowledge — this
model post-dates this session's Jan-2026 cutoff):

- **Real, Apache-2.0, ungated, pip-installable** (`pip install qwen-tts`) — confirmed.
- **CustomVoice's 9 preset speakers, only 2 natively English** (`Ryan`, `Aiden`, both male) —
  confirmed verbatim against the model card's speaker table. (`model.get_supported_speakers()`
  actually returns all 9 speaker IDs regardless of language — each speaker _can_ speak English, just
  in their native-language voice profile per the card; e.g. `Vivian` speaking English would carry a
  Chinese-native voice, not an English accent. Untested here, but it's a free extra source of
  timbre variety beyond the 2 "native English" presets if quality holds up.)
- **VoiceDesign takes a free-text `instruct` description (accent, age, gender, pacing, emotion), no
  reference audio, no cloning** — confirmed, and directly demonstrated below.
- **~4.5 GB of weights, comfortably under 8 GB VRAM** — confirmed: 4.52 GB on disk (main LM
  3.83 GB + speech tokenizer 0.68 GB), **4.35 GB peak GPU memory** measured on this A100.
- **One correction**: the comment attributes CustomVoice's "1.24% English WER" to _CustomVoice_
  specifically. The model card's cited number (SEED test-en, WER 1.24) is reported for
  **`-Base`**, not `-CustomVoice`. CustomVoice does have its own (different-benchmark) English WER
  elsewhere on the card — 0.899 on the card's target-speaker multilingual test — which is if
  anything a _better_ number, so the comment's overall conclusion ("this model's output is cleaner
  than human/Kokoro speech, treat as a lower bound") still holds; only the specific citation was
  loose.
- **One thing the comment flagged as unverified and got right to flag**: the "97 ms first-packet
  latency" marketing figure is for the streaming/vLLM-Omni serving path, not the plain
  `qwen_tts.Qwen3TTSModel.generate_*` batch path anyone would actually use to pre-generate a WAV
  corpus. Measured batch latency below is 5.5–12.4 s/clip — fine for offline generation, not
  real-time.

### 6.2 Smoke test — actually run, not desk research

Ran both `-VoiceDesign` and `-CustomVoice` on this session's A100, in a separate venv
(`.venv-qwen/`, Python 3.10, same rationale as `.venv-tts/` in §2) so a `qwen-tts` dependency
problem can't affect the Kokoro pilot's environment.

**Hit and fixed two environment problems** (both worth knowing before anyone repeats this on
Athena):

1. **`torchaudio` version mismatch** — `pip install qwen-tts` pulls `torchaudio` from plain PyPI,
   which resolved to a build linked against `libcudart.so.13`, while `torch` was explicitly
   installed as the `+cu128` build (CUDA 12.8, i.e. `libcudart.so.12`). Failed at import with
   `OSError: Could not load this library: .../_torchaudio.abi3.so`. Fix: reinstall torchaudio from
   the same `cu128` wheel index as torch (`pip install --force-reinstall torchaudio --index-url
https://download.pytorch.org/whl/cu128`) so the versions match.
2. **Home-directory quota exceeded mid-download** — confirms the issue comment's un-verified
   warning exactly. `$HOME` on this PLGrid account has a **10 GB hard quota, already essentially
   full** (`quota -s`: 10240 MB limit, at the `*`-flagged over-quota line). The default
   `~/.cache/huggingface` download died with `OSError: [Errno 122] Disk quota exceeded` partway
   through the first model. Fix: `export HF_HOME=<scratch-path>/.hf-cache-py` before loading —
   scratch has 126 TB free. **This isn't optional tuning, it's required for the download to
   complete at all.** Both variants together cache at 8.5 GB on scratch. (This cache directory is
   shared with Kokoro's downloads too, not Qwen-specific — see `docs/athena-setup.md`, the canonical
   reference for this and every other cache-redirect env var needed on Athena, written after
   `$HOME` actually hit its quota mid-session.)

With both fixed, generation works cleanly:

| Model                           | Load (cold / warm cache) | Peak GPU mem | Per-clip generate (no flash-attn) |
| ------------------------------- | ------------------------ | ------------ | --------------------------------- |
| `-VoiceDesign`                  | 25.0 s / 7.2 s           | 4.35 GB      | 5.5–9.7 s for 3.2–5.3 s of audio  |
| `-CustomVoice` (`Ryan`,`Aiden`) | 25.0 s (cold)            | ~4.3 GB      | 7.6–12.4 s for 4.4–6.5 s of audio |

`flash-attn` was **not** installed for this test (its README-recommended build step is a
from-source compile — same risk profile as `blis`/`thinc` in §2 — skipped to keep the smoke test
quick). Revisit if per-clip latency matters once scaling past a one-off pilot; not needed for
correctness, only speed.

**The actual capability check** — accent diversity via free-text `instruct`, the specific gap
`docs/voice-pipeline-feasibility.md` §6.1/§6.3 flags (3 human speakers, one shared accent profile).
Generated 3 domain sentences with 3 different accent instructions and nothing else changed:

| Instruct (verbatim)                                                   | Sentence                                                           |
| --------------------------------------------------------------------- | ------------------------------------------------------------------ |
| "Older British male voice, RP accent, unhurried and precise."         | "What is the CSDA range of a 150 MeV proton in water?"             |
| "Nigerian-accented English, young female voice, confident and clear." | "Compare the stopping power of 100 MeV protons in water and bone." |
| "Australian-accented English, casual young male voice."               | "What is the range of 60 MeV protons in Lucite?"                   |

All three produced valid, distinct 16-bit PCM / 24 kHz WAVs (verified with `soundfile.info`, not
just "no exception raised"). Files (these 3 plus the earlier single test clip and the 2
`-CustomVoice` presets, 6 total) live in `eval/audio/qwen-smoketest/` — gitignored like the rest of
`eval/audio/`, not committed. Deliberately kept in its own subdirectory rather than
`eval/audio/tts-qwen-<accent>/` naming — this was a feasibility check, not eval-corpus generation,
and shouldn't be mistaken for pilot data the ASR scripts would pick up. **Not yet verified**: whether these
accents are _recognizable/correct_ to a human listener, or just superficially different audio — no
one has listened to them. That's the first thing to check before trusting this for the ASR
comparison in §6.3.

### 6.3 Recommended plan, if this is worth pursuing

Same staged-cost ordering as §5, adapted for the new model:

1. **Listen-check** the 3 accent clips above (or a fresh batch) — confirm a human agrees the accent
   instruction produced something plausible before spending eval time on it. Free-text `instruct`
   models can silently ignore or misinterpret the description; nothing in the smoke test verifies
   _fidelity_ to the requested accent, only that _some_ distinct audio came out.
2. **Small pilot mirroring §3's structure**: 5–10 sentences (not all 30 yet) × 2–3 accent
   `instruct` strings, into `eval/audio/tts-qwen-<accent-tag>/<id>.wav`, then run the existing
   `scripts/asr-transcribe.mjs` + `scripts/asr-score-slots.mjs` unmodified — same integration path
   already proven for Kokoro in §3, no new Node-side code needed.
3. Compare slot-token accuracy **per accent** against both the Kokoro `af_heart` pilot (§3) and the
   human 3-speaker baseline. The interesting question this model is actually suited to answer:
   does whisper-small's accuracy degrade on non-American/British accents the way it might for real
   L2-English speakers, in a way the current 3 human speakers (reportedly a shared accent profile)
   can't test?
4. Only if 1–3 justify it: scale to the full 30 (then 120) sentences × a curated accent set. Budget
   ~6–12 s/clip generation time (no flash-attn) — a 30-sentence × 5-accent matrix is ~150 clips,
   roughly 15–30 minutes of GPU time, not a blocker.
5. **Skip for now**: `-Base` (voice cloning) — cloning an identifiable person's voice without
   consent is the one thing to explicitly avoid here, same standard as the existing human
   `eval/audio/{km,lg,mn}/` speakers presumably meet; `-VoiceDesign`/`-CustomVoice` sidestep this
   entirely by construction (no reference audio), which is why they're the ones tested here.

### 6.4 Setup notes specific to this model (delta from §2)

- Separate venv `.venv-qwen/` (Python 3.10.4, same reasoning as `.venv-tts/`) — not sharing one venv
  between Kokoro and Qwen3-TTS avoids one's dependency pins (e.g. `torchaudio`, `transformers`
  version) breaking the other.
- **Must set `HF_HOME` (or `HF_HUB_CACHE`) to a scratch path before first use** — the default
  `~/.cache/huggingface` will hit the 10 GB home quota on PLGrid before the download finishes (§6.2
  point 2). Not an edge case — it reproduces on the very first `from_pretrained` call.
- **Must pin `torchaudio` to the same CUDA wheel index as `torch`** — installing `qwen-tts` alone
  pulls in a mismatched `torchaudio` from plain PyPI (§6.2 point 1).
- `sox: command not found` prints as a warning on import but did not block generation in this test
  (torchaudio's ffmpeg backend, already available via the `FFmpeg/7.1.2` module, covers what was
  needed here) — left uninstalled; revisit only if a real failure traces back to it.
- `flash-attn` was skipped (optional, from-source build); note in §6.2 if that changes.

## 7. Scale-up: 100 text-mode-validated sentences via Qwen3-TTS

_Session report, 2026-07-16. Executes on §6's plan at a scale between its "5–10 sentence pilot"
step and its "full 30/120 sentence" step: 100 brand-new sentences (not the RECORDING.md 30), each
one **empirically confirmed** — not just plausible-sounding — to make aidedx's actual deterministic
matcher resolve the right intent and its actual libdedx WASM compute a real, finite, positive
number. This section is written to be reproducible at 10× the scale; §7.7 spells out what would
need to change to do that._

### 7.1 The core method: verify with the app's own code, not by eye

The brief was "ensure aidedx can correctly guess the intent… for which it can give meaningful
numerical output" — that's not a property you can eyeball from sentence wording, because the
matcher (`src/lib/intent/matcher.ts`) and libdedx's WASM tables both have real, non-obvious edge
cases (§7.3). So before writing a single sentence, a new script,
**`scripts/tts-sentence-check.ts`**, was built to run candidates through the _actual_ production
pipeline: `matchIntent()` → `computeIntent()` against the real vendored `static/wasm/libdedx.wasm`
(the same WASM the app ships, loaded the same way `compute.smoke.test.ts` does it — see that file
for the pattern this reuses). A candidate only passes when:

- the matcher fills every required slot (`incomplete === false`) with **no schema errors**;
- the matcher's `quantitySource` is `direct`, `indirect`, or `inverse` — **never `default`**. The
  matcher silently falls back to `csdaRange` when it recognizes no quantity keyword/idiom at all;
  that's a wrong guess that can still compute a number, so it's rejected explicitly (this is the one
  addition beyond what the matcher/compute code already enforces — see the comment in
  `checkCandidate()`);
- `computeIntent()` returns with **no `series.error`** on any series, and every series has at least
  one point;
- the quantity's actual answer field (stopping power / CSDA range / inverse energy) is a **finite,
  positive number** — ruling out the case where a unit got silently mis-scaled into _some_ number
  that isn't the right physical quantity (a real risk in this codebase — §7.3's STP-unit gotcha).

```sh
node --experimental-strip-types scripts/tts-sentence-check.ts <sentences.json> [--json out.json]
```

Committed to `scripts/` (not a throwaway) because §7.7 leans on it directly for any future scale-up.
Run with `--experimental-strip-types` because this session's Athena Node module is v22.17.1; the
flag isn't needed once CI's pinned Node 24 runs it, same caveat as `docs/tts-eval-audio.md`'s
earlier Node-version notes.

### 7.2 Sentence sources and the coverage target

Wrote 110 candidate sentences by hand (buffer for the failures §7.3 describes), aiming to span:

- **All four quantities** (`stoppingPower`, `csdaRange`, `energyFromRange`, `energyFromStp`) at
  roughly equal weight, not just the stopping-power/range mix the original 30-sentence set leans on.
- **All five `compareDim` values** — plain single-value queries plus material/particle/energy/program
  comparisons.
- **Real domain vocabulary**, pulled from the fields aidedx's own alias tables (`src/lib/aliases/`)
  already cover, so the _sentences_ sound like they come from the literature even though the
  _entities_ were always going to be limited to what libdedx actually knows:
  - **Proton radiotherapy / particle therapy**: clinical-range energies (70–250 MeV protons,
    ~90–400 MeV/nucleon carbon-12), "CSDA range", "residual/projected/mean/extrapolated range" (all
    contain the literal word the matcher needs — see §7.3), treatment-planning framing.
  - **Radiobiology/dosimetry phantom materials**: A-150 tissue-equivalent plastic, PMMA, water,
    adipose/muscle/bone — the materials `docs/voice-pipeline-feasibility.md`'s alias table work was
    built around.
  - **Alpha spectroscopy**: the real ²⁴¹Am decay energy (5.486 MeV) as a calibration-source alpha,
    surface-barrier silicon detectors.
  - **BNCT (boron neutron capture therapy)**: the ⁷Li recoil ion from the ¹⁰B(n,α)⁷Li capture
    reaction, a real dosimetry detail, not filler.
  - **Semiconductor ion implantation**: keV-scale boron-11/phosphorus-31 in silicon — "projected
    range" is literally the term this field uses for the CSDA range libdedx computes.
  - **Space radiation / GCR shielding**: nitrogen-14, oxygen-16, argon-40 ions in aluminum,
    polyethylene, Kapton — real galactic-cosmic-ray shielding vocabulary (iron-56, the most iconic
    GCR ion, turned out to be unusable — §7.3).
  - **Detector physics**: NaI/CsI scintillators, plastic scintillators, silicon detectors.
  - **Program names as flavor, not function**: ASTAR/PSTAR/MSTAR/ICRU73/Bethe formula mentions to
    trigger `compareDim: "program"` — see §7.3 for why the _specific_ names don't actually matter to
    the compute result.
- **Phrasing/register variety** ("language stylistic variety" in the brief): formal/scientific
  imperatives ("Determine…", "Report the restricted collision stopping power…"), plain questions,
  the matcher's own indirect idioms ("how deep", "at what rate", "penetration depth", "come to
  rest"), casual/conversational filler ("So, um, roughly what's…", "Quick one —…", "Okay, one
  more —…"), and comparative framings ("Which has the higher…", "How does X compare with Y").

### 7.3 What broke, and what it reveals

Every failure category below was found by _running_ the harness, not by reading the matcher source
carefully enough to predict it — several are real edge cases this session wouldn't have guessed:

1. **Six materials are broken in this build's WASM data, at every energy, for every particle**:
   `soft tissue` (id 261), `skin` (250), `lung` (190), `brain` (123), `blood` (118), and `concrete`
   (144) — every query against them fails inside libdedx itself (`_dedx_get_stp_table` returns a
   nonzero error, surfaced as `"WASM STP calculation failed"`). Confirmed by isolating the variable:
   the _same_ particle/energy against `muscle`, `adipose tissue`, `cortical bone`, `A-150
tissue-equivalent plastic`, `water`, and `PMMA` all work. This isn't a wording problem — the
   alias resolves correctly to the right material id, the WASM call itself just fails for these six.
   Worth filing as its own issue if any real query might hit them.
2. **Heavy ions above argon (Z=18) are broken as _projectiles_ via the auto-selected MSTAR
   program**, regardless of material or energy: calcium-40, titanium-48, iron-56, krypton, xenon,
   gold all fail; every element H through Ar (confirmed: H, He, Li, Be, B, C, N, O, F, Ne, Mg, Al, P,
   S, Cl, Ar) works. Iron is the single most-cited galactic-cosmic-ray ion in the space-radiation
   literature — every "iron ion" sentence drafted for that flavor had to become argon-40 or
   silicon-28 instead. (The same elements work fine as _materials_ — "gold foil" as a target is
   unaffected; it's specifically MSTAR's projectile-side table that stops at Ar.)
3. **`"which"`/`"what"` + ≤3 words + `"energy"` silently reclassifies a forward query as an
   inverse one** — `detectInverse()`'s `asksForEnergy` regex doesn't care what quantity you actually
   meant. `"What is the energy loss of…"` and `"Which loses energy faster…"` both got hijacked into
   `energyFromRange` (no target present → `incomplete`, caught by the harness, but silently wrong
   without it). Contractions are safe (`"what's"` has no space after `what`, so the regex's
   `\s+` never matches) — the existing eval set's `"What's the dE/dx of…"` phrasing already relies
   on exactly this. Fix used here: reword around it (`"how much energy does X lose"`, `"which has
the higher stopping power"`) rather than fight the regex.
4. **`energyFromStp` inverse targets must say `"MeV/cm"`/`"MeV per cm"`/`"MeV cm2/g"` — spelling out
   `"per centimeter"` in full doesn't match `extractStpTarget()`'s regex table at all**, so the
   target silently never gets extracted and the schema validator (correctly) rejects the resulting
   intent (`target: required for quantity "energyFromStp"`). This is a pure wording trap, not a
   WASM issue.
5. **Not every stopping-power value is reachable by the inverse-STP lookup's high-energy branch**
   (`side: 1` in `inverseSeries()`) — e.g. "50 MeV cm²/g" for carbon in PMMA has no solution on that
   branch (too far below the achievable curve for that combination), while "80 MeV cm²/g" does. No
   formula predicts this from the intent alone; had to probe empirically per (particle, material)
   pair and pick a target inside the achievable range. This is the sharpest illustration of why
   "meaningful numerical output" needs to mean _actually calling compute_, not just checking the
   intent parses.
6. Two purely mechanical fixes: `"A-150 tissue-equivalent plastic"` must include the `"A-150"` token
   (the bare descriptive phrase isn't in the alias table); `"lithium-7 recoil ion"` fails to resolve
   because the matcher's particle-head regex requires the isotope and the word `"ion"` to be
   _adjacent_ — `"recoil"` sitting between them breaks the match, fixed by moving the descriptive
   clause elsewhere in the sentence.

None of this is a criticism of the matcher/compute code in the abstract — it's exactly the kind of
gap that only a real end-to-end harness surfaces, which is the point of building one before writing
sentences by feel.

### 7.4 Final 100 — category breakdown

| Dimension      | Breakdown                                                                                                                                                                                                                                                                                     |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Quantity       | stoppingPower 36 · csdaRange 36 · energyFromRange 15 · energyFromStp 13                                                                                                                                                                                                                       |
| compareDim     | none 78 · material 4 · particle 4 · energy 4 · program 4 (the last three concentrated in a handful of dedicated compare sentences — the deterministic matcher only sets a compare dimension from explicit multi-entity phrasing, so these aren't naturally as numerous as `quantity` variety) |
| Confidence     | 90 at ≥0.82 (direct/indirect/inverse with no fuzzy-match penalty); 10 lower (fuzzy alias resolution, e.g. "plastic scintillator", still correct, just not an exact alias-table hit)                                                                                                           |
| Particles used | protons, deuterons, tritons, alpha particles, ⁷Li, ¹¹B, ¹²C/¹³C, ³¹P, ¹⁶O, ¹⁹F, ²⁰Ne, ²⁸Si, ⁴⁰Ar                                                                                                                                                                                              |
| Materials used | water, air, PMMA, A-150 tissue-equivalent plastic, cortical/compact bone, adipose/muscle tissue, silicon, silicon dioxide, aluminum, aluminum oxide, gold, graphite, polyethylene, polystyrene, Kapton, Mylar, lithium fluoride, NaI, CsI, plastic scintillator                               |

Full text + resolved intent + numeric result for all 100 lives in `eval/audio/tts-qwen-100/manifest.json`
(generated alongside the audio, §7.6) — that manifest **is** the ground truth for this batch, in the
same spirit as `eval/intents.jsonl`'s hand-labeled `expected` field, except here "expected" means
"what the app itself actually resolved and computed," which is the right ground truth for a batch
whose entire purpose is proving the app understands these sentences.

### 7.5 Voice, accent, and emotion assignment

30 profiles, assigned round-robin (`profile[i % 30]`) across the 100 sentences — simple, deterministic,
and reproducible without needing `Math.random()`/a seed to document. 24 via **VoiceDesign** (free-text
`instruct`, full accent freedom) + 6 via **CustomVoice** (`Ryan`/`Aiden`/`Vivian`/`Sohee` presets with
an `instruct` emotion layered on — CustomVoice takes the same free-text emotion control VoiceDesign
does, just on top of a fixed timbre instead of a designed one).

Each VoiceDesign profile is a one-line `instruct` string spanning four axes at once — accent, age +
gender, emotional tone, and pace — e.g. `"Nigerian-accented English, middle-aged male voice, warm
and confident, medium pace."` The accent list deliberately goes beyond American/British: Scottish,
Irish, Australian, New Zealand, South African, Indian, Nigerian, Kenyan, Singaporean, Jamaican,
Canadian, plus L2-English accents (German-, French-, Japanese-, Russian-, Spanish-accented English)
— aimed squarely at the gap `docs/voice-pipeline-feasibility.md` §6.1/§6.3 flagged (3 human speakers
sharing one accent profile) and that §6.3 of this doc named as the reason to bother with a heavier
model at all. Emotions/paces: calm, excited, tired, curious, hurried, confident, nervous, cheerful,
skeptical, sleepy, stressed, formal, casual — spread across the accent list rather than fixed to any
one of them, so accent and emotion vary independently.

None of this has been listened to yet (same caveat as §6.2's smoke clips) — confirming the
_requested_ accent/emotion is what a human actually hears is unverified and should be the first
thing checked before this batch is used for an ASR comparison.

### 7.6 Generation results

Ran via a new script, `scripts/tts-qwen-100.py` (not committed as app tooling — same status as
§6's ad hoc smoke-test code, but kept in `scripts/` this time since §7.7 expects it to be reused,
not just referenced):

```sh
source scripts/athena-env.sh
source .venv-qwen/bin/activate
python scripts/tts-qwen-100.py <sentences.json> eval/audio/tts-qwen-100
```

**All 100 clips generated successfully, zero failures** (both models — VoiceDesign and CustomVoice
— were loaded simultaneously for the whole run so switching engines mid-batch costs nothing):

| Metric                | Value                                                                                                                                                                                                                                 |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Total generation time | 1199.5 s (~20 min) for 100 clips                                                                                                                                                                                                      |
| Per-clip generation   | 12.0 s average (range ~7–18 s, no flash-attn)                                                                                                                                                                                         |
| Total audio produced  | 692.5 s (~11.5 min) across 100 clips                                                                                                                                                                                                  |
| Output size           | 32 MB (100 WAVs, 24 kHz/16-bit mono)                                                                                                                                                                                                  |
| Peak GPU memory       | not logged for this run; §6.2 measured ~4.3 GB per model standalone, so ~8.6–9 GB with both loaded — comfortably inside the A100's 40 GB, and inside an 8 GB consumer GPU running one model at a time                                 |
| Engine split          | 82 VoiceDesign / 18 CustomVoice (matches the 24:6 pool ratio)                                                                                                                                                                         |
| Voice-profile spread  | every one of the 30 profiles used 3 or 4 times — confirmed even, not by construction alone (round-robin over 100 items across 30 profiles guarantees this arithmetically, but worth checking nothing crashed mid-cycle and skewed it) |

Output: `eval/audio/tts-qwen-100/<id>.wav` (100 files, gitignored like the rest of `eval/audio/`) +
`eval/audio/tts-qwen-100/manifest.json` (sentence text, resolved intent's `quantitySource`, the
numeric result, and the voice profile used for every clip — committed-worthy content, but the
directory it lives in is gitignored wholesale; see §7.7 on whether that should change before ASR
scoring this batch).

### 7.7 Scaling to 1000+

What changes and what doesn't, in the order that matters most:

1. **The bottleneck is sentence _validation_, not generation.** 110 hand-written candidates took
   several rounds against `tts-sentence-check.ts` to reach 100 clean passes — mostly the six
   material and heavy-ion gaps (§7.3 points 1–2), which are now _known_ and avoidable from the
   start next time. A 1000-sentence batch should still budget a real iteration loop (over-generate
   by ~15–20%, run the harness, fix or drop failures, top up) rather than assume a first draft passes.
2. **Reuse `scripts/tts-sentence-check.ts` unmodified** — it takes any `{id, text}[]` JSON and
   already encodes every lesson from §7.3 in its pass/fail logic (though not as _avoidance_ rules —
   it will still correctly reject a sentence that hits the broken-material list, it just won't tell
   you not to write one). Worth adding, before a 1000-run: a lint pass that flags known-bad tokens
   (the 6 broken materials, the heavy-ion-as-particle names) in draft sentences _before_ running the
   full WASM check, purely to save iteration rounds — not built here since 100 sentences didn't
   generate enough repeat-failures to justify it, but 1000 likely would.
3. **Voice pool**: the current 30-profile round-robin gives each profile ~3.3 uses at 100 sentences;
   at 1000 that's ~33 uses each, which is still full coverage but repeats the exact same 30
   voices 10× more. Worth growing the pool (more accents, or vary the emotion/pace wording per
   repeat) rather than just cycling the same 30 harder — cheap to do, since profiles are just
   strings in `scripts/tts-qwen-100.py`'s `VOICE_DESIGN_PROFILES`/`CUSTOM_VOICE_PROFILES` lists.
4. **Compute budget is not a blocker**: at the measured 12.0 s/clip average (§7.6), 1000 clips is
   ~3.3 hours of generation on one A100 — a single long GPU session, not a multi-day job, and
   trivially parallelizable across more GPUs if that's still too slow. The real cost driver at
   1000 is the validation _iteration loop_ in point 1, not raw synthesis time.
5. **Decide on `eval/audio/` gitignore scope for this batch specifically before scaling**: the
   existing `/eval/audio/` blanket ignore was written for human recordings that must never be
   committed; TTS audio has no such privacy constraint, and at 1000 clips × several voices the
   _manifest_ (text + ground truth, no audio) is exactly the kind of artifact this project's
   convention commits (`eval/results/*.json`). Worth deciding whether `manifest.json` should move
   out from under the audio gitignore rule rather than staying invisible to `git status` by
   accident.
