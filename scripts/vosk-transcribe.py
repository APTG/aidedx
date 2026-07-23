#!/usr/bin/env python3
"""
Vosk desktop CPU benchmark -- issue #120 pre-Android sanity check.

Runs Vosk's small English model over the eval clips and writes the same JSON contract as
scripts/asr-transcribe.mjs (docs/android-asr-runtime-bench.md section 3), so results score with
the existing scripts/e2e-audio-intents.ts / scripts/asr-score-slots.mjs unmodified.

Two modes:
  (default)   plain open-vocabulary dictation.
  --grammar   Kaldi's grammar-FST decoding (setGrammar), restricted to a word list built from
              every word in eval/intents.jsonl's gold sentences plus spelled-out English numbers
              (docs/android-asr-runtime-bench.md section 4.4's proposed "closed physics-jargon
              word list", derived from the eval set itself rather than authored by hand). Words
              missing from the model's own fixed lexicon (confirmed this session: "mev", "pmma",
              "nucleon", "csda", "astar", "pstar", "deuteron", "kapton" all fail with "Ignoring
              word missing in vocabulary" -- Vosk's grammar mode can only *restrict* the model's
              existing lexicon, it cannot inject new pronunciations) are silently dropped by Vosk
              itself; this script just reports how many.

All eval sentences are English text (scripts/asr-transcribe.mjs forces lang_to_id["<|en|>"]
unconditionally for the same eval set), so only the English model is exercised here -- the
Polish model has nothing to transcribe against this corpus.

Requires the project-local venv (.venv-asr-bench, `pip install vosk numpy`) and the model
fetched via scripts/android-asr-fetch-models.sh vosk.

Usage: .venv-asr-bench/bin/python3 scripts/vosk-transcribe.py <modelDir> <outFile> [--grammar]
"""
import json
import re
import subprocess
import sys
import time
from pathlib import Path

from vosk import KaldiRecognizer, Model, SetLogLevel

PROJECT_ROOT = Path(__file__).resolve().parent.parent

# Standard English number words -- eval/intents.jsonl spells energies as digits ("40 MeV"), but
# spoken audio says "forty", so the grammar needs these even though they never appear in the
# gold text itself.
NUMBER_WORDS = (
    "zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen "
    "fifteen sixteen seventeen eighteen nineteen twenty thirty forty fifty sixty seventy eighty "
    "ninety hundred thousand million billion point"
).split()


def build_grammar_words():
    intents_path = PROJECT_ROOT / "eval" / "intents.jsonl"
    words = set(NUMBER_WORDS)
    with open(intents_path) as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            text = json.loads(line).get("text", "")
            words.update(w.lower() for w in re.findall(r"[a-zA-Z][a-zA-Z'-]*", text))
    return sorted(words)

IDS = [
    "stress-001", "stress-002", "sp-003", "sp-005", "sp-007", "sp-008", "rng-002", "rng-005",
    "rng-008", "ind-001", "ind-003", "ind-008", "conv-003", "conv-008", "cmp-mat-001",
    "cmp-mat-004", "cmp-mat-007", "cmp-par-003", "cmp-par-005", "cmp-en-001", "cmp-prog-001",
    "unit-001", "unit-003", "unit-006", "pernuc-001", "pernuc-003", "iso-002", "iso-004",
    "inv-rng-001", "alias-001",
]


def load_audio_pcm16(path):
    # Vosk's KaldiRecognizer wants raw 16-bit PCM bytes, not float32 (unlike the other two
    # harnesses) -- same ffmpeg source decode, different output sample format.
    return subprocess.run(
        ["ffmpeg", "-loglevel", "quiet", "-i", str(path), "-ar", "16000", "-ac", "1", "-f", "s16le", "-"],
        capture_output=True,
        check=True,
    ).stdout


def main():
    model_dir = Path(sys.argv[1])
    out_file = sys.argv[2]
    use_grammar = "--grammar" in sys.argv

    t0 = time.time()
    model = Model(str(model_dir))
    if use_grammar:
        SetLogLevel(0)  # need "Ignoring word missing in vocabulary" warnings on stderr, once
        grammar_words = build_grammar_words()
        grammar = json.dumps([*grammar_words, "[unk]"])
        rec = KaldiRecognizer(model, 16000, grammar)
        SetLogLevel(-1)  # back to quiet for the per-clip loop
        print(f"[vosk {model_dir.name} +grammar] {len(grammar_words)} words in grammar (dropped words logged above)")
    else:
        SetLogLevel(-1)
        rec = KaldiRecognizer(model, 16000)
    load_s = time.time() - t0
    print(f"[vosk {model_dir.name}{' +grammar' if use_grammar else ''}] loaded in {load_s:.1f}s")

    audio_base = PROJECT_ROOT / "eval" / "audio"
    speakers = sorted(p.name for p in audio_base.iterdir() if p.is_dir())

    records = []
    for speaker in speakers:
        for clip_id in IDS:
            f = audio_base / speaker / f"{clip_id}.wav"
            if not f.exists():
                continue
            pcm = load_audio_pcm16(f)
            t1 = time.time()
            raw = ""
            error = None
            try:
                rec.Reset()  # reuse the one grammar-compiled recognizer instead of rebuilding its FST per clip
                rec.AcceptWaveform(pcm)
                raw = json.loads(rec.FinalResult()).get("text", "").strip()
            except Exception as e:  # noqa: BLE001 -- record runtime errors like the JS harnesses do
                error = str(e)
            secs = time.time() - t1
            records.append({"speaker": speaker, "id": clip_id, "raw": raw, "secs": secs, "error": error})
            print(f"  {speaker}/{clip_id}: ({secs:.1f}s) {'ERROR ' + error if error else raw}")

    with open(out_file, "w") as fh:
        json.dump(
            {
                "modelId": f"vosk/{model_dir.name}{'+grammar' if use_grammar else ''}",
                "dtype": "kaldi",
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
