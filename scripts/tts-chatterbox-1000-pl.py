"""
Generate a 1000-sentence Polish eval-audio batch via Chatterbox Multilingual TTS (issue #106,
following up scripts/tts-piper-1000.py / scripts/tts-qwen-1000-pl.py's established pattern).

Two independent modes, both answering a different half of issue #106:

  --clone-refs <dir>   Option A — clone the speaker's own voice. <dir> must contain 10
                        reference WAVs named clone-01.wav..clone-10.wav (see
                        scripts/prepare-voice-clone-refs.py, which builds these from
                        eval/audio/lg/'s human-recorded Polish clips). Each of the 1000
                        sentences is assigned to one of the 10 clone voices via the same
                        stable-hash-of-id scheme every other 1000-sentence script uses, so each
                        voice speaks ~100 sentences. Chatterbox's `audio_prompt_path` clones the
                        voice per call, no fine-tuning/enrollment step needed.

                        CONSENT: voice cloning here is only appropriate because the speaker who
                        recorded eval/audio/lg/'s clips has explicitly authorized cloning their
                        own voice for this project's eval work (see the PR this script shipped
                        in). Do not point --clone-refs at any other recording set without that
                        same explicit authorization — issue #106 calls this out as a hard
                        precondition, not a technical detail to route around.

  (no --clone-refs)    Option B — Chatterbox's native Polish synthesis, no cloning at all:
                        `audio_prompt_path=None` uses the model's own default voice. Answers
                        "how good is Chatterbox's native Polish" independent of any cloning
                        question, with zero consent surface (touches no real person's identity).

Unlike scripts/tts-qwen-1000-pl.py, Polish is a *confirmed-supported* language for Chatterbox's
multilingual model (not an experimental unsupported-language attempt) — no Auto-mode fallback
dance needed, `language_id="pl"` is used directly.

Resumable + atomic manifest checkpoint, same conventions as every other 1000-sentence script
this repo runs on Athena.

Usage:
  python scripts/tts-chatterbox-1000-pl.py <sentences.json> <out_dir> [--clone-refs <dir>]
"""

import argparse
import json
import os
import sys
import time
from pathlib import Path

# Must be set before any huggingface_hub/tqdm-using import below — sbatch redirects stdout to a
# real file (%x-%j.out), not a TTY, and neither of these bars behaves well there:
# huggingface_hub's own (via its hf_xet backend, the "Fetching N files"/"Download complete" bars
# from ChatterboxMultilingualTTS.from_pretrained()'s first-run weight download) has an official
# env toggle; the "Sampling: NN%|...|" bar inside Chatterbox's own generate() loop isn't exposed
# as a kwarg (confirmed against the real installed API, chatterbox-tts 0.1.7 — see
# setup-venv-chatterbox.md), so tqdm's own documented env toggle is the only way to reach it.
os.environ.setdefault("HF_HUB_DISABLE_PROGRESS_BARS", "1")
os.environ.setdefault("TQDM_DISABLE", "1")

import torch
import torchaudio

from chatterbox.mtl_tts import ChatterboxMultilingualTTS


def stable_hash(s: str) -> int:
    """Deterministic 32-bit FNV-1a hash — same helper every other 1000-sentence script here
    carries its own copy of (independent one-off scripts, not a shared module)."""
    h = 2166136261
    for byte in s.encode("utf-8"):
        h ^= byte
        h = (h * 16777619) & 0xFFFFFFFF
    return h


def load_voice_pool(clone_refs_dir: Path | None) -> list[tuple[str, Path | None]]:
    if clone_refs_dir is None:
        return [("chatterbox-default", None)]
    refs = sorted(clone_refs_dir.glob("clone-*.wav"))
    if len(refs) != 10:
        sys.exit(f"expected 10 clone-*.wav files in {clone_refs_dir}, found {len(refs)}")
    return [(r.stem, r) for r in refs]


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("sentences_path", type=Path)
    ap.add_argument("out_dir", type=Path)
    ap.add_argument("--clone-refs", type=Path, default=None)
    args = ap.parse_args()

    # stdout is fully block-buffered when not a TTY (e.g. redirected to sbatch's %x-%j.out) —
    # same fix as every other 1000-sentence script here, for live progress.
    sys.stdout.reconfigure(line_buffering=True)

    args.out_dir.mkdir(parents=True, exist_ok=True)
    sentences = json.loads(args.sentences_path.read_text())

    manifest_path = args.out_dir / "manifest.json"
    manifest = json.loads(manifest_path.read_text())["clips"] if manifest_path.exists() else []
    done_ids = {c["id"] for c in manifest}
    remaining = [s for s in sentences if s["id"] not in done_ids]
    print(f"{len(done_ids)} already done, {len(remaining)} remaining of {len(sentences)}")
    if not remaining:
        print("nothing to do")
        return

    voice_pool = load_voice_pool(args.clone_refs)
    mode = "clone" if args.clone_refs else "native"
    print(f"mode={mode}  voices={[v[0] for v in voice_pool]}")

    print(f"cuda available: {torch.cuda.is_available()}")
    # No t3_model kwarg — confirmed against the real installed API (chatterbox-tts 0.1.7 via
    # inspect.signature, not the README, which is ahead of what's on PyPI): from_pretrained()
    # only takes device.
    model = ChatterboxMultilingualTTS.from_pretrained(
        device="cuda" if torch.cuda.is_available() else "cpu"
    )

    t_start = time.time()
    n_failed = 0
    for i, item in enumerate(remaining):
        sid, text = item["id"], item["text"]
        seed = stable_hash(sid)
        tag, ref_path = voice_pool[seed % len(voice_pool)]

        torch.manual_seed(seed)
        if torch.cuda.is_available():
            torch.cuda.manual_seed_all(seed)

        t0 = time.time()
        try:
            wav = model.generate(
                text, language_id="pl", audio_prompt_path=str(ref_path) if ref_path else None
            )
        except Exception as e:
            # One bad clip shouldn't cost the rest of the batch — same defensive convention as
            # tts-qwen-1000-pl.py's per-clip try/except, though here there's no Auto-mode
            # fallback to attempt first since Polish is a confirmed-supported language.
            n_failed += 1
            manifest.append(
                {
                    "id": sid,
                    "text": text,
                    "quantity": item.get("quantity"),
                    "multi": item.get("multi"),
                    "slotTruth": item.get("slotTruth"),
                    "seed": seed,
                    "engine": "Chatterbox",
                    "mode": mode,
                    "profile": tag,
                    "error": str(e),
                }
            )
            tmp_path = manifest_path.with_suffix(".json.tmp")
            tmp_path.write_text(
                json.dumps(
                    {"voicePool": [v[0] for v in voice_pool], "mode": mode, "clips": manifest},
                    indent=2,
                    ensure_ascii=False,
                )
            )
            os.replace(tmp_path, manifest_path)
            print(f"  [{len(done_ids) + i + 1}/{len(sentences)}] {sid} ({tag}) FAILED: {e}")
            continue
        gen_s = time.time() - t0
        dur_s = wav.shape[-1] / model.sr

        wav_path = args.out_dir / f"{sid}.wav"
        torchaudio.save(str(wav_path), wav, model.sr, encoding="PCM_S", bits_per_sample=16)

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
                "engine": "Chatterbox",
                "mode": mode,
                "profile": tag,
                **({"refClip": ref_path.name} if ref_path else {}),
            }
        )
        # Atomic checkpoint (temp file + rename) — same convention as every other 1000-sentence
        # script here, so a job killed mid-write can't leave a truncated/unparseable manifest.
        tmp_path = manifest_path.with_suffix(".json.tmp")
        tmp_path.write_text(
            json.dumps(
                {"voicePool": [v[0] for v in voice_pool], "mode": mode, "clips": manifest},
                indent=2,
                ensure_ascii=False,
            )
        )
        os.replace(tmp_path, manifest_path)

        elapsed = time.time() - t_start
        rate = elapsed / (i + 1)
        eta_min = rate * (len(remaining) - i - 1) / 60
        print(
            f"  [{len(done_ids) + i + 1}/{len(sentences)}] {sid} ({tag}) gen={gen_s:.1f}s "
            f"dur={dur_s:.1f}s  avg={rate:.1f}s/clip  eta={eta_min:.0f}min"
        )

    total = time.time() - t_start
    print(f"\nDone: {len(remaining)} attempted in {total:.1f}s, {n_failed} failed entirely")
    print(f"manifest now has {len(manifest)} total clips at {manifest_path}")


if __name__ == "__main__":
    main()
