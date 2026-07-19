"""
Generate the 1000-sentence Polish Piper-TTS eval-audio batch (issue #79 Track 3 / #87).

Piper (not Qwen3-TTS) is the engine for this batch specifically because Qwen3-TTS's own
supported-language list (Chinese/English/Japanese/Korean/German/French/Russian/Portuguese/
Spanish/Italian) does not include Polish — confirmed before writing this script, not assumed.
Piper does ship real Polish (pl_PL) voice models; see scripts/tts-qwen-1000-pl.py for the
separate, deliberately-experimental attempt at Polish synthesis via Qwen anyway, for comparison.

Voices: every pl_PL voice actually published in rhasspy/piper-voices as of this writing (5 —
Piper has no free-form "instruct" style control the way Qwen3-TTS's VoiceDesign does, so voice
variety here means "which of the 5 real speakers", not a style/accent prompt):
  pl_PL-bass-high, pl_PL-darkman-medium, pl_PL-gosia-medium, pl_PL-mc_speech-medium,
  pl_PL-mls_6892-low

Downloads each voice's .onnx + .onnx.json once into .cache/piper-voices/ (gitignored, shared
across runs the same way .hf-cache/ is for the Whisper models).

Voice assignment is a stable hash of each sentence's id (matching tts-qwen-1000.py's own
issue #83/#92 fix — decorrelated from the fixed category order sentences are built in), with a
small per-clip length_scale/noise_scale jitter (also hash-derived) standing in for Qwen's
per-voice "instruct" prosody variety, since Piper voices don't take a style prompt.

Resumable: writes the manifest after every clip (atomically — temp file + rename, so a job
killed mid-write can never leave the manifest truncated; see the equivalent fix applied to
scripts/asr-transcribe-manifest.mjs this same session) and skips any <id>.wav already on disk.

Usage: python scripts/tts-piper-1000.py <sentences.json> <out_dir>
"""

import json
import os
import sys
import time
import urllib.request
import wave
from pathlib import Path

from piper import PiperVoice, SynthesisConfig

PROJECT_ROOT = Path(__file__).resolve().parent.parent
VOICE_CACHE = PROJECT_ROOT / ".cache" / "piper-voices"
HF_BASE = "https://huggingface.co/rhasspy/piper-voices/resolve/main/pl/pl_PL"

# (voice folder, quality) — every pl_PL voice in rhasspy/piper-voices, confirmed by listing the
# repo directly rather than assumed; quality tier is whatever that voice actually ships (not
# every voice has a "medium", some only have "high" or "low").
VOICE_PROFILES = [
    ("bass", "high"),
    ("darkman", "medium"),
    ("gosia", "medium"),
    ("mc_speech", "medium"),
    ("mls_6892", "low"),
]


def stable_hash(s: str) -> int:
    """Deterministic 32-bit FNV-1a hash — same as tts-qwen-1000.py's own helper, kept as a
    separate copy since these are independent one-off scripts, not a shared module."""
    h = 2166136261
    for byte in s.encode("utf-8"):
        h ^= byte
        h = (h * 16777619) & 0xFFFFFFFF
    return h


def voice_id(name: str, quality: str) -> str:
    return f"pl_PL-{name}-{quality}"


def download_voice(name: str, quality: str) -> Path:
    """Download a voice's .onnx + .onnx.json into VOICE_CACHE if not already present."""
    VOICE_CACHE.mkdir(parents=True, exist_ok=True)
    vid = voice_id(name, quality)
    onnx_path = VOICE_CACHE / f"{vid}.onnx"
    json_path = VOICE_CACHE / f"{vid}.onnx.json"
    for path, ext in [(onnx_path, "onnx"), (json_path, "onnx.json")]:
        if path.exists():
            continue
        url = f"{HF_BASE}/{name}/{quality}/{vid}.{ext}"
        print(f"  downloading {url}")
        urllib.request.urlretrieve(url, path)
    return onnx_path


def main():
    # See tts-qwen-1000.py's identical comment: stdout is fully block-buffered when not a
    # TTY (e.g. redirected to sbatch's %x-%j.out), so force line buffering for live progress.
    sys.stdout.reconfigure(line_buffering=True)

    sentences_path, out_dir = sys.argv[1], Path(sys.argv[2])
    out_dir.mkdir(parents=True, exist_ok=True)
    sentences = json.loads(Path(sentences_path).read_text())

    manifest_path = out_dir / "manifest.json"
    manifest = json.loads(manifest_path.read_text())["clips"] if manifest_path.exists() else []
    done_ids = {c["id"] for c in manifest}
    remaining = [s for s in sentences if s["id"] not in done_ids]
    print(f"{len(done_ids)} already done, {len(remaining)} remaining of {len(sentences)}")
    if not remaining:
        print("nothing to do")
        return

    print("loading/downloading voices...")
    voices = {}
    for name, quality in VOICE_PROFILES:
        onnx_path = download_voice(name, quality)
        voices[voice_id(name, quality)] = PiperVoice.load(str(onnx_path))
    voice_ids = list(voices.keys())

    t_start = time.time()
    for i, item in enumerate(remaining):
        sid, text = item["id"], item["text"]
        seed = stable_hash(sid)
        vid = voice_ids[seed % len(voice_ids)]
        voice = voices[vid]

        # Small hash-derived jitter around Piper's own defaults (length_scale=1.0,
        # noise_scale=0.667, noise_w_scale=0.8) — the closest available stand-in for Qwen's
        # per-voice "instruct" prosody variety, since Piper voices take no style prompt.
        # Best-effort reproducibility only: unlike tts-qwen-1000.py's torch.manual_seed
        # (independently confirmed to make Qwen synthesis bit-reproducible), Piper's onnxruntime
        # inference path reading from a Python-side RNG seed is not verified here — deterministic
        # *inputs* (voice + syn_config) are what's actually guaranteed reproducible per clip.
        length_scale = 1.0 + ((seed % 21) - 10) / 100  # 0.90 .. 1.10
        noise_scale = 0.667 + ((seed // 21 % 21) - 10) / 200  # ~0.617 .. 0.717
        config = SynthesisConfig(length_scale=length_scale, noise_scale=noise_scale)

        t0 = time.time()
        wav_path = out_dir / f"{sid}.wav"
        with wave.open(str(wav_path), "wb") as wav_file:
            voice.synthesize_wav(text, wav_file, syn_config=config)
        gen_s = time.time() - t0

        with wave.open(str(wav_path), "rb") as wav_file:
            dur_s = wav_file.getnframes() / wav_file.getframerate()

        manifest.append(
            {
                "id": sid,
                "text": text,
                "quantity": item.get("quantity"),
                "multi": item.get("multi"),
                "slotTruth": item.get("slotTruth"),
                "gen_s": round(gen_s, 2),
                "dur_s": round(dur_s, 2),
                "seed": seed,
                "engine": "Piper",
                "profile": vid,
                "length_scale": round(length_scale, 3),
                "noise_scale": round(noise_scale, 3),
            }
        )
        # Atomic checkpoint (temp file + rename) — see asr-transcribe-manifest.mjs's identical
        # fix this same session: a direct write left a truncated/unparseable manifest possible
        # if the job was killed mid-write, silently discarding every completed clip on resume.
        tmp_path = manifest_path.with_suffix(".json.tmp")
        tmp_path.write_text(json.dumps({"voicePool": voice_ids, "clips": manifest}, indent=2))
        os.replace(tmp_path, manifest_path)

        elapsed = time.time() - t_start
        rate = elapsed / (i + 1)
        eta_min = rate * (len(remaining) - i - 1) / 60
        print(
            f"  [{len(done_ids) + i + 1}/{len(sentences)}] {sid} ({vid}) gen={gen_s:.1f}s "
            f"dur={dur_s:.1f}s  avg={rate:.1f}s/clip  eta={eta_min:.0f}min"
        )

    total = time.time() - t_start
    print(f"\nDone: {len(remaining)} new clips in {total:.1f}s ({total / len(remaining):.2f}s/clip avg)")
    print(f"manifest now has {len(manifest)} total clips at {manifest_path}")


if __name__ == "__main__":
    main()
