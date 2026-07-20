# Chatterbox Polish TTS: voice-cloned + native batches (issue #106)

_Pipeline-only report, 2026-07-20 — same pattern as `docs/whisper-model-bench.md`'s own first
commit ("ships the pipeline... no results yet"). No Athena run has happened yet; this documents
what was built and exactly how to run it. A results doc lands once the Athena job completes._

## 1. What this is

Issue #106 proposed Chatterbox (`resemble-ai/chatterbox`) as a way to close some of the
Piper/Qwen3-TTS Polish accuracy gap documented in `docs/whisper-model-bench.md` /
`docs/tts-eval-1000-pl.md`, via two independent options that don't need to pick one:

- **Option A — clone the real speaker's voice** from `eval/RECORDING.pl.md`'s 50 human-recorded
  Polish clips (`eval/audio/lg/`), then synthesize the full 1000-sentence set in that voice.
- **Option B — Chatterbox's native Polish synthesis**, no cloning, as a clean 4th-engine data
  point with zero consent surface.

This PR implements both, producing two new 1000-sentence Polish batches alongside the existing
Piper/Qwen3-TTS ones (`eval/audio/tts-piper-1000-pl/`, `eval/audio/tts-qwen-1000-pl/`):
`eval/audio/tts-chatterbox-clone-1000-pl/` and `eval/audio/tts-chatterbox-native-1000-pl/`.

## 2. Consent (issue #106's explicit, blocking precondition)

Issue #106 §"Option A" is explicit that cloning a real person's voice **requires informed
consent from that person before any of it is attempted** — not a technical detail, a
precondition. `eval/audio/lg/`'s 50 Polish clips are the project owner's own recordings (`lg` =
Leszek Grzanka, same person who requested this work and is authorized to consent to cloning his
own voice for this project). That consent is what makes Option A in-scope here; it would not be
appropriate to point this pipeline at any other recording set without the same explicit
authorization from whoever recorded it.

## 3. What's built

### 3.1 Reference-audio prep (`scripts/prepare-voice-clone-refs.py`) — already run locally

Takes the 50 `eval/audio/lg/pl-*.wav` clips (the Polish subset of `lg/`'s recordings — `lg` also
holds an unrelated 30-clip English set from a different recording track, excluded via the
`pl-*.wav` glob), and builds **10 reference clips for cloning**, one per target voice:

1. Deterministic shuffle (fixed seed 42) of the 50 clips, split into 10 non-overlapping groups
   of 5 — "10 prompts from different sentences," not independent draws that could overlap or
   reuse the same clip across two clones.
2. Silence-trim each clip (ffmpeg `silenceremove`, both ends) — empirically a near-no-op on this
   specific set (recordings were already cut close to the speech, largest trim was ~40ms), kept
   as a correctness safety net rather than because it did much here.
3. Concatenate each group's 5 trimmed clips with a 300ms silence gap into one reference WAV.

Already run — output is in `eval/audio/tts-clone-refs-pl/` (gitignored, like all of
`eval/audio/`): `clone-01.wav` .. `clone-10.wav` (29–35s each, well above Chatterbox's documented
~10s reference example) plus `refs-manifest.json` recording exactly which 5 source clips went
into each one, for provenance.

### 3.2 Generation script (`scripts/tts-chatterbox-1000-pl.py`)

Follows `scripts/tts-piper-1000.py`/`scripts/tts-qwen-1000-pl.py`'s established shape (resumable,
atomic manifest checkpoint, stable-hash-of-id voice assignment) via the `chatterbox-tts` PyPI
package's `ChatterboxMultilingualTTS` class:

```python
model = ChatterboxMultilingualTTS.from_pretrained(device="cuda", t3_model="v3")
wav = model.generate(text, language_id="pl", audio_prompt_path=ref_path_or_None)
```

- `--clone-refs eval/audio/tts-clone-refs-pl` → Option A: each sentence's stable hash picks 1 of
  the 10 `clone-*.wav` references as `audio_prompt_path` (~100 sentences/voice).
- no `--clone-refs` → Option B: `audio_prompt_path=None`, confirmed (via the Chatterbox repo's
  own README, not assumed) to fall back to the model's built-in default voice — this resolves
  issue #106's open question ("does `ChatterboxMultilingualTTS` have a usable default voice
  without `audio_prompt_path`") in the affirmative.

Unlike `tts-qwen-1000-pl.py`, there's no `language="Polish"` → `"Auto"` fallback dance — Polish is
a confirmed-supported language for Chatterbox's multilingual model (23 languages, `pl` explicitly
named), so `language_id="pl"` is used directly and unconditionally.

### 3.3 Athena job (`scripts/submit-chatterbox-pl.sh`)

Runs both batches back-to-back (generation → transcription → scoring), same 4-step structure as
`scripts/submit-pl.sh`. Requires a one-time `.venv-chatterbox` setup first (CUDA-specific, same
reasoning as `.venv-qwen` — not auto-provisioned in the batch job, see the script's own header
comment for the exact `pip install` sequence).

### 3.4 `scripts/submit-whisper-bench.sh` — DATASETS wired up, not yet runnable

Added `pl-chat-clone` / `pl-chat-native` entries to the whisper-model-bench `DATASETS` array
ahead of time, so no further script edits are needed once the batches exist — but **do not
resubmit the benchmark until `submit-chatterbox-pl.sh` has completed**; each combo is already
individually failure-isolated (won't crash on a missing `manifest.json`, per
`docs/whisper-model-bench.md` §3's fix), but running early just burns 28 combos' worth of nothing.

## 4. How to run it (rsync + Athena commands)

From the machine with `eval/audio/tts-clone-refs-pl/` (already built, §3.1):

```sh
rsync -avz /home/grzanka/cernbox/Documents/aidedx/eval/audio/tts-clone-refs-pl/ \
  plgkongruencj@athena.cyfronet.pl:/net/tscratch/people/plgkongruencj/aidedx/eval/audio/tts-clone-refs-pl/
```

On Athena, after `git pull`ing this branch:

```sh
cd /net/tscratch/people/plgkongruencj/aidedx
source scripts/athena-env.sh

# One-time only, if .venv-chatterbox doesn't exist yet:
python3 -m venv .venv-chatterbox
source .venv-chatterbox/bin/activate
pip install --upgrade pip
pip install torch torchaudio --index-url https://download.pytorch.org/whl/cu128
pip install chatterbox-tts
deactivate

sbatch scripts/submit-chatterbox-pl.sh
```

Then, once that job's `eval/audio/tts-chatterbox-{clone,native}-1000-pl/manifest.json` both exist
(1000/1000 clips each):

```sh
RESULTS_DIR=eval/results/whisper-bench-2805165 sbatch --array=0,1 scripts/submit-whisper-bench.sh   # the two combos that needed the manually-downloaded fp32 weights
sbatch scripts/submit-whisper-bench.sh                                                              # full 5-dataset, 14-model-pair benchmark including the two new Chatterbox batches
```

## 5. Open risk, not yet verified

`chatterbox-tts`'s `pip install` behavior on Athena (whether it needs the same `torchaudio`
CUDA-wheel-mismatch workaround `docs/tts-eval-audio.md` §6.2 point 1 already hit for `qwen-tts`,
and actual A100 VRAM/inference-speed cost for the 0.5B multilingual model) is unconfirmed —
issue #106 flagged this explicitly and it's still open pending the first real Athena run.
