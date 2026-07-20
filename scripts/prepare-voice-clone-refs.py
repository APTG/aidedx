"""
Build reference-audio prompts for voice cloning (issue #106) from an existing set of
human-recorded WAV clips — used here to turn the 50 Polish clips in eval/audio/lg/ (the
speaker's own recordings, eval/RECORDING.pl.md, issue #79) into 10 reference clips for
Chatterbox's `audio_prompt_path` voice cloning (scripts/tts-chatterbox-1000-pl.py --clone).

Explicit consent note: this script clones a real person's voice. It is only appropriate to
run against a recording set when the person who recorded it has explicitly authorized cloning
their own voice for this project's eval work — see the PR description / issue #106 discussion
for that authorization. Do not point this at someone else's recordings without their consent;
issue #106 itself calls this out as a hard precondition, not a technical detail.

What it does:
  1. Takes all `<prefix>-*.wav` clips in a source dir, deterministically shuffles them (fixed
     seed, reproducible) and splits into N non-overlapping groups of size K (default 10x5,
     using all 50 input clips exactly once — "10 prompts from different sentences", not 10
     independent random draws that could overlap).
  2. Trims leading/trailing silence from each clip (ffmpeg silenceremove, both directions via
     the standard trim-reverse-trim-reverse idiom) — empirically a near-no-op on this specific
     50-clip set (tightest clip only trimmed ~40ms either side, recordings were already cut
     close to the speech), but kept as a correctness safety net for any future input set that
     isn't as tightly recorded.
  3. Concatenates each group's 5 (trimmed) clips with a short silence gap between them into one
     reference WAV per group — comfortably longer than Chatterbox's documented ~10s reference
     example (mean clip here is ~6s, so 5 clips + gaps lands around 30s).
  4. Writes a manifest recording exactly which source clips went into each reference, for
     provenance.

Usage:
  python scripts/prepare-voice-clone-refs.py <src_dir> <out_dir> [--pattern "pl-*.wav"]
      [--groups 10] [--per-group 5] [--seed 42] [--gap-ms 300]
"""

import argparse
import json
import random
import subprocess
import sys
import wave
from pathlib import Path


def trim_silence(src: Path, dst: Path, threshold_db: int = -45, min_silence_s: float = 0.1) -> None:
    """Trim leading + trailing silence via ffmpeg's silenceremove, applied forwards then
    (reversed) to catch both ends — the standard idiom, since silenceremove only trims the
    start of a stream on its own."""
    filt = (
        f"silenceremove=start_periods=1:start_silence={min_silence_s}:start_threshold={threshold_db}dB,"
        "areverse,"
        f"silenceremove=start_periods=1:start_silence={min_silence_s}:start_threshold={threshold_db}dB,"
        "areverse"
    )
    subprocess.run(
        ["ffmpeg", "-y", "-v", "error", "-i", str(src), "-af", filt, str(dst)],
        check=True,
    )


def concat_with_gaps(clips: list[Path], out_path: Path, gap_ms: int) -> float:
    """Concatenate WAV clips (same format assumed — mono/rate/sample-width) with a fixed
    silence gap between them, using the `wave` module directly (same style as
    tts-piper-1000.py's own WAV handling) rather than ffmpeg's concat demuxer, so there's no
    filelist-format edge case to get wrong."""
    with wave.open(str(clips[0]), "rb") as w0:
        params = w0.getparams()
    gap_frames = int(params.framerate * gap_ms / 1000)
    silence = b"\x00" * (gap_frames * params.sampwidth * params.nchannels)

    with wave.open(str(out_path), "wb") as out:
        out.setparams(params)
        for i, clip in enumerate(clips):
            with wave.open(str(clip), "rb") as w:
                if (w.getframerate(), w.getnchannels(), w.getsampwidth()) != (
                    params.framerate,
                    params.nchannels,
                    params.sampwidth,
                ):
                    raise ValueError(f"{clip} format mismatch vs {clips[0]} — resample inputs first")
                out.writeframes(w.readframes(w.getnframes()))
            if i < len(clips) - 1:
                out.writeframes(silence)

    with wave.open(str(out_path), "rb") as w:
        return w.getnframes() / w.getframerate()


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("src_dir", type=Path)
    ap.add_argument("out_dir", type=Path)
    ap.add_argument("--pattern", default="pl-*.wav")
    ap.add_argument("--groups", type=int, default=10)
    ap.add_argument("--per-group", type=int, default=5)
    ap.add_argument("--seed", type=int, default=42)
    ap.add_argument("--gap-ms", type=int, default=300)
    args = ap.parse_args()

    clips = sorted(args.src_dir.glob(args.pattern))
    needed = args.groups * args.per_group
    if len(clips) != needed:
        sys.exit(
            f"found {len(clips)} clips matching {args.pattern!r} in {args.src_dir}, "
            f"need exactly {needed} ({args.groups} groups x {args.per_group})"
        )

    rng = random.Random(args.seed)
    shuffled = clips[:]
    rng.shuffle(shuffled)
    groups = [shuffled[i * args.per_group : (i + 1) * args.per_group] for i in range(args.groups)]

    args.out_dir.mkdir(parents=True, exist_ok=True)
    trim_dir = args.out_dir / "_trimmed"
    trim_dir.mkdir(exist_ok=True)

    manifest = {
        "sourceDir": str(args.src_dir),
        "pattern": args.pattern,
        "seed": args.seed,
        "gapMs": args.gap_ms,
        "refs": [],
    }

    for gi, group in enumerate(groups, start=1):
        tag = f"clone-{gi:02d}"
        trimmed = []
        for clip in group:
            t = trim_dir / clip.name
            trim_silence(clip, t)
            trimmed.append(t)

        out_path = args.out_dir / f"{tag}.wav"
        dur_s = concat_with_gaps(trimmed, out_path, args.gap_ms)

        manifest["refs"].append(
            {
                "tag": tag,
                "sourceClips": [c.name for c in group],
                "durationS": round(dur_s, 2),
            }
        )
        print(f"{tag}: {[c.stem for c in group]} -> {out_path.name} ({dur_s:.1f}s)")

    manifest_path = args.out_dir / "refs-manifest.json"
    manifest_path.write_text(json.dumps(manifest, indent=2, ensure_ascii=False))
    print(f"\nwrote {len(groups)} reference clips + {manifest_path}")


if __name__ == "__main__":
    main()
