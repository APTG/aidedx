#!/usr/bin/env python3
"""
sherpa-onnx desktop CPU benchmark -- issue #120 pre-Android sanity check.

Runs sherpa-onnx's whisper-small int8 (encoder+decoder) over the eval clips and writes the
same JSON contract as scripts/asr-transcribe.mjs (docs/android-asr-runtime-bench.md section 3),
so results score with the existing scripts/e2e-audio-intents.ts / scripts/asr-score-slots.mjs
unmodified.

Un-prompted only -- sherpa-onnx's OfflineRecognizer.from_whisper has no initial_prompt
equivalent (docs/android-asr-runtime-bench.md section 1.2, k2-fsa/sherpa-onnx#2295).

Requires the project-local venv (.venv-asr-bench, `pip install sherpa-onnx numpy`) and the
model fetched via scripts/android-asr-fetch-models.sh sherpa-onnx.

Usage: .venv-asr-bench/bin/python3 scripts/sherpa-onnx-transcribe.py <modelDir> <outFile>
"""
import json
import subprocess
import sys
import time
from pathlib import Path

import numpy as np
import sherpa_onnx

PROJECT_ROOT = Path(__file__).resolve().parent.parent

IDS = [
    "stress-001", "stress-002", "sp-003", "sp-005", "sp-007", "sp-008", "rng-002", "rng-005",
    "rng-008", "ind-001", "ind-003", "ind-008", "conv-003", "conv-008", "cmp-mat-001",
    "cmp-mat-004", "cmp-mat-007", "cmp-par-003", "cmp-par-005", "cmp-en-001", "cmp-prog-001",
    "unit-001", "unit-003", "unit-006", "pernuc-001", "pernuc-003", "iso-002", "iso-004",
    "inv-rng-001", "alias-001",
]


def load_audio(path):
    # Same ffmpeg-to-raw-f32 approach as scripts/asr-transcribe.mjs's loadAudio(), so both
    # runtimes see byte-identical 16kHz mono samples.
    out = subprocess.run(
        ["ffmpeg", "-loglevel", "quiet", "-i", str(path), "-ar", "16000", "-ac", "1", "-f", "f32le", "-"],
        capture_output=True,
        check=True,
    ).stdout
    return np.frombuffer(out, dtype=np.float32)


def main():
    model_dir = Path(sys.argv[1])
    out_file = sys.argv[2]

    t0 = time.time()
    recognizer = sherpa_onnx.OfflineRecognizer.from_whisper(
        encoder=str(model_dir / "small-encoder.int8.onnx"),
        decoder=str(model_dir / "small-decoder.int8.onnx"),
        tokens=str(model_dir / "small-tokens.txt"),
        language="en",
        task="transcribe",
        num_threads=4,
    )
    load_s = time.time() - t0
    print(f"[sherpa-onnx whisper-small int8] loaded in {load_s:.1f}s")

    audio_base = PROJECT_ROOT / "eval" / "audio"
    speakers = sorted(p.name for p in audio_base.iterdir() if p.is_dir())

    records = []
    for speaker in speakers:
        for clip_id in IDS:
            f = audio_base / speaker / f"{clip_id}.wav"
            if not f.exists():
                continue
            samples = load_audio(f)
            t1 = time.time()
            raw = ""
            error = None
            try:
                stream = recognizer.create_stream()
                stream.accept_waveform(16000, samples)
                recognizer.decode_stream(stream)
                raw = stream.result.text.strip()
            except Exception as e:  # noqa: BLE001 -- record runtime errors like the JS harnesses do
                error = str(e)
            secs = time.time() - t1
            records.append({"speaker": speaker, "id": clip_id, "raw": raw, "secs": secs, "error": error})
            print(f"  {speaker}/{clip_id}: ({secs:.1f}s) {'ERROR ' + error if error else raw}")

    with open(out_file, "w") as fh:
        json.dump(
            {
                "modelId": "sherpa-onnx/whisper-small-int8",
                "dtype": "int8",
                "withPrompt": False,
                "loadS": load_s,
                "records": records,
            },
            fh,
            indent=1,
        )
    print(f"wrote {out_file} ({len(records)} records, loadS={load_s:.1f}s)")


if __name__ == "__main__":
    main()
