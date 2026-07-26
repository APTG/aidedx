# Setting up `.venv-align` on Athena

**Background reading, not a required step** — `scripts/submit-forced-align.sh` creates
`.venv-align` itself on first run (unlike `.venv-qwen`/`.venv-chatterbox`, which stay deliberately
manual; that script's own header comment explains why this one doesn't need to). Read this doc if
the auto-install fails, or you want to poke at the venv interactively — §1-3 are then exactly what
the submit script runs automatically, and §4-5 are how to verify/debug it by hand.

## Why this venv, and what it avoids

The alignment engine here is a **hand-rolled CTC forced-alignment** using `transformers`
(`Wav2Vec2ForCTC`) + `torchaudio.functional.forced_align`/`merge_tokens` (the same primitive
`torchaudio`'s own "CTC forced alignment API" tutorial builds on), not `whisperx` or torchaudio's
bundled multilingual `MMS_FA`. Two things this sidesteps:

- **`whisperx`** bundles `faster-whisper`/`ctranslate2` as a hard dependency even if you only call
  its `align()` (not `transcribe()`) — `ctranslate2` has a well-known history of cuDNN-version
  mismatches on HPC systems with an older system CUDA/cuDNN than the wheel expects. Using
  `transformers`' own Whisper pipeline for ASR instead avoids that dependency entirely.
- **`torchaudio`'s bundled `MMS_FA`** is a single multilingual model that expects **Romanized**
  input (via the external `uroman` tool) for non-Latin-heavy languages — irrelevant for Polish
  specifically, but the bigger issue is Polish diacritics (`ą ć ę ł ń ó ś ź ż`) would need to
  round-trip through romanization and back, an extra failure mode for no benefit here. Using
  **per-language** CTC models (`jonatasgrosman/wav2vec2-large-xlsr-53-{english,polish}`) instead
  means the model's own vocabulary already contains Polish diacritics natively — no
  transliteration step needed.

So the actual dependency set is small and mirrors what `.venv-qwen` already proved works on Athena:
`torch`/`torchaudio` from the `cu128` wheel index, plus `transformers`, `accelerate`, `num2words`
(spells out digits like `150` → `one hundred fifty` before alignment — CTC vocabularies are letters
only, no digit characters, so a number left as digits breaks the forced alignment for that entire
segment). Audio decoding shells out to `ffmpeg` directly (already on `PATH` via
`scripts/athena-env.sh`), not through `torchaudio`'s own backend — sidesteps yet another
version-matching surface (`docs/tts-eval-audio.md` §6.2 hit exactly this class of bug: `torchaudio`
pulled from plain PyPI linked against a different CUDA runtime than the pinned `torch`, crashing at
import).

## 1. Get an interactive GPU allocation

```sh
srun -C memfs --pty --time=0:29:00 -A plgccbmc15-gpu-a100 -p plgrid-gpu-a100 \
  --gres=gpu:a100:1 --cpus-per-task=4 --mem=16G bash
```

(`--gres=gpu:a100:1` is required — its omission is the reason a past `.venv-chatterbox` setup
attempt saw `torch.cuda.is_available()` return `False`; see `setup-venv-chatterbox.md` §1.)

## 2. Load modules, redirect caches

```sh
cd "$(git rev-parse --show-toplevel 2>/dev/null || pwd)"   # repo root
source scripts/athena-env.sh
```

Single source of truth for module versions (`GCCcore/14.3.0 FFmpeg/7.1.2 nodejs/22.17.1
Python/3.10.4`) and cache redirects (`PIP_CACHE_DIR`/`XDG_CACHE_HOME`/`HF_HOME` off `$HOME`'s 10 GB
quota, onto scratch) — don't hand-load a different combo, `scripts/submit-forced-align.sh` sources
the same script and expects this venv to match it. `torch.hub`'s own cache (used to download
nothing extra here, but harmless to note) also respects `XDG_CACHE_HOME`, landing under
`.cache/torch/` alongside everything else this script already redirects.

## 3. Create the venv and install

**Install `torch` and `torchaudio` from the `cu128` index together, in one command** — not as two
separate `pip install` calls. Doing it in two calls is exactly what broke `.venv-qwen` the first
time (`docs/tts-eval-audio.md` §6.2): a second, unrelated package pulled in a plain-PyPI
`torchaudio` build linked against a different CUDA runtime than the already-installed `torch`,
and it crashed at import (`OSError: Could not load this library`). Installing both from the same
index in the same command guarantees they match from the start:

```sh
python3 -m venv .venv-align
source .venv-align/bin/activate
pip install --upgrade pip
pip install torch torchaudio --index-url https://download.pytorch.org/whl/cu128
pip install transformers accelerate num2words
```

(No `soundfile`/`librosa` needed — audio decoding goes through `ffmpeg` directly, see above.)

## 4. Verify

```sh
python -c "
import torch, torchaudio
print('torch', torch.__version__, 'torchaudio', torchaudio.__version__, 'cuda:', torch.cuda.is_available())
print('forced_align available:', hasattr(torchaudio.functional, 'forced_align'))
"
```

Expect both versions to share the same `+cu128` suffix and `cuda: True`. `forced_align` needs
`torchaudio>=2.1` — if it's missing, `pip show torchaudio` and upgrade.

## 5. Smoke test — load both CTC models and the ASR pipeline once before trusting a real run

```sh
python -c "
import torch
from transformers import Wav2Vec2ForCTC, Wav2Vec2Processor, pipeline

device = 'cuda' if torch.cuda.is_available() else 'cpu'
for repo in ['jonatasgrosman/wav2vec2-large-xlsr-53-english', 'jonatasgrosman/wav2vec2-large-xlsr-53-polish']:
    proc = Wav2Vec2Processor.from_pretrained(repo)
    model = Wav2Vec2ForCTC.from_pretrained(repo).to(device).eval()
    print(repo, '-> vocab size', model.config.vocab_size, 'pad/blank id', proc.tokenizer.pad_token_id,
          'delimiter id', proc.tokenizer.word_delimiter_token_id)

asr = pipeline('automatic-speech-recognition', model='openai/whisper-large-v3',
               device=0 if device == 'cuda' else -1, torch_dtype=torch.float16)
print('whisper-large-v3 pipeline loaded OK')
"
```

This downloads ~4 GB total (two ~1.2 GB wav2vec2 models + ~3 GB whisper-large-v3) into
`.hf-cache-py/` the first time — expected, same cache `.venv-qwen`/`.venv-chatterbox` already
share. If this prints all three `-> vocab size ...` / `loaded OK` lines without error,
`.venv-align` is ready and `scripts/submit-forced-align.sh` will pick it up (it just checks the
directory exists, same as the other CUDA-venv submit scripts).

## 6. Clean up

```sh
deactivate
exit   # leave the srun allocation
```
