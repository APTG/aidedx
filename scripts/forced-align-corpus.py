#!/usr/bin/env python3
"""
Forced alignment of the issue #118 lecture/podcast corpus (eval/lecture-corpus/, fetched by
scripts/submit-fetch-lecture-corpus.sh) to measure the REAL-SPEECH duration of keV/MeV/GeV/eV
tokens — the human cross-check for the TTS-engine probe (scripts/unit-probe-analyze.py). See
docs/unit-pronunciation-asr.md §6 for the method and rationale, §6.1-6.2 for where the corpus
came from, docs/forced-alignment-setup.md for the one-time `.venv-align` this needs.

WHY A HAND-ROLLED ALIGNER, NOT whisperx/MFA
--------------------------------------------
Per-language `transformers` CTC models (`jonatasgrosman/wav2vec2-large-xlsr-53-{english,polish}`)
+ `torchaudio.functional.forced_align`/`merge_tokens` (the same primitive torchaudio's own "CTC
forced alignment API" tutorial is built on) — not `whisperx` (drags in `ctranslate2`, a known
source of cuDNN-version mismatches on HPC, even when only `align()` is used) and not torchaudio's
bundled multilingual `MMS_FA` (expects Romanized input via `uroman` for best results; the
per-language models already have native alphabets, including Polish diacritics, with no
transliteration step). See docs/forced-alignment-setup.md for the full rationale.

TWO TRANSCRIPT SOURCES, SAME ALIGNMENT CODE PATH
--------------------------------------------------
  en/mit-8.701/*.srt   KNOWN, human-captioned text — used directly as the alignment target.
                       (The caption text still collapses to `MeV`/`GeV` regardless of how it was
                       spoken, same blindness as Whisper's own transcripts, docs §1 — that's fine,
                       the measurement comes from ALIGNED DURATION, not the caption text.)
  en/daniel-and-jorge/*.mp3    No ground-truth transcript — transcribed with Whisper
  pl/radio-naukowe/*.mp3       (openai/whisper-large-v3 via `transformers`) first, then the
                                Whisper hypothesis text is force-aligned the same way. Self-
                                referential (same caveat as the TTS probe, docs §5) but still
                                gives a real aligned-duration measurement per instance.

Per segment (an SRT cue, or a Whisper-transcribed chunk):
  1. normalize_for_alignment(): lowercase, spell out digits with num2words (CTC vocabularies are
     letters-only — a digit left as "150" breaks alignment for the whole segment), strip
     punctuation, keep Polish diacritics.
  2. build_target(): tokenize word-by-word (not the whole sentence at once) against the CTC
     processor's vocab, so the exact per-word token-index boundaries are known by construction
     rather than inferred after the fact.
  3. forced_align() + merge_tokens() on the (padded) audio slice for just that segment, then
     regroup the per-token spans back into per-word spans using the boundaries from step 2.
  4. any word matching UNIT_TOKENS gets its aligned [start, end] recorded, plus the segment's
     median word duration as a local speaking-rate baseline (real speech has no fixed rate the
     way TTS does, so raw seconds alone isn't comparable across speakers/segments).

Usage (on Athena, inside .venv-align):
  python3 scripts/forced-align-corpus.py <results-dir> [--corpus-dir eval/lecture-corpus]
                                          [--whisper-model openai/whisper-large-v3]
                                          [--limit N] [--only mit|podcasts]

Output: <results-dir>/unit-durations.jsonl (one JSON object per keV/MeV/GeV/eV instance — the
main analysis artifact, read by scripts/forced-align-analyze.py) and
<results-dir>/full/<file>.json (every aligned word, for auditing a specific file by hand).
Resumable: <results-dir>/.done/<file>.ok marks a source file complete; already-.ok files are
skipped on resubmit.
"""

import argparse
import json
import re
import statistics
import subprocess
import sys
from pathlib import Path

import numpy as np
import torch
import torchaudio.functional as F
from num2words import num2words
from transformers import Wav2Vec2ForCTC, Wav2Vec2Processor, pipeline

SAMPLE_RATE = 16000
UNIT_TOKENS = {"ev", "kev", "mev", "gev", "tev"}
SEG_PAD_S = 0.2  # audio padding around each segment's known/ASR timestamps

CTC_MODELS = {
    "en": "jonatasgrosman/wav2vec2-large-xlsr-53-english",
    "pl": "jonatasgrosman/wav2vec2-large-xlsr-53-polish",
}

SPEAKER_PREFIX_RE = re.compile(r"^[A-Z][A-Z .'\-]{2,30}:\s*")
NUM_RE = re.compile(r"\d[\d.,]*\d|\d")
NON_WORD_RE = re.compile(r"[^\w']+", re.UNICODE)
DIGIT_RE = re.compile(r"\d")


# ---------------------------------------------------------------- audio I/O
def load_audio(path: Path, sr: int = SAMPLE_RATE) -> torch.Tensor:
    """Decode any container ffmpeg understands to mono float32 @ sr via a subprocess pipe —
    avoids depending on torchaudio's own backend (docs/forced-alignment-setup.md's rationale)."""
    cmd = [
        "ffmpeg", "-nostdin", "-threads", "0", "-i", str(path),
        "-f", "s16le", "-ac", "1", "-acodec", "pcm_s16le", "-ar", str(sr), "-",
    ]
    proc = subprocess.run(cmd, capture_output=True, check=True)
    audio = np.frombuffer(proc.stdout, np.int16).astype(np.float32) / 32768.0
    return torch.from_numpy(audio).unsqueeze(0)  # (1, num_samples)


# ---------------------------------------------------------------- SRT parsing
def parse_srt(path: Path):
    """Yield (start_s, end_s, text) per cue. Minimal, no external dependency — this project's
    SRTs (archive.org / MIT OCW) are plain single-track cues, no need for a full parser."""
    raw = path.read_text(encoding="utf-8", errors="replace")
    blocks = re.split(r"\n\s*\n", raw.strip())
    ts_re = re.compile(r"(\d\d):(\d\d):(\d\d)[,.](\d\d\d)\s*-->\s*(\d\d):(\d\d):(\d\d)[,.](\d\d\d)")

    def to_s(h, m, s, ms):
        return int(h) * 3600 + int(m) * 60 + int(s) + int(ms) / 1000

    for block in blocks:
        lines = block.splitlines()
        m = None
        text_lines = []
        for line in lines:
            if m is None:
                m = ts_re.search(line)
                if m:
                    continue
            elif not line.strip().isdigit() or text_lines:
                text_lines.append(line)
        if not m:
            continue
        text = " ".join(t.strip() for t in text_lines if t.strip())
        text = SPEAKER_PREFIX_RE.sub("", text).strip()
        if not text:
            continue
        start = to_s(*m.group(1, 2, 3, 4))
        end = to_s(*m.group(5, 6, 7, 8))
        yield start, end, text


# ---------------------------------------------------------------- text normalization
def spell_numbers(text: str, lang: str) -> str:
    def repl(m):
        raw = m.group(0)
        cleaned = raw.replace(",", ".") if raw.count(",") == 1 and "." not in raw else raw.replace(",", "")
        try:
            val = float(cleaned) if "." in cleaned else int(cleaned)
        except ValueError:
            return raw
        try:
            return " " + num2words(val, lang=lang) + " "
        except NotImplementedError:
            return " " + num2words(val, lang="en") + " "

    return NUM_RE.sub(repl, text)


def normalize_for_alignment(text: str, lang: str) -> list[str]:
    text = text.replace("/", " per " if lang == "en" else " przez ")
    text = spell_numbers(text, lang)
    text = DIGIT_RE.sub(" ", text)  # safety net for anything spell_numbers missed
    text = text.lower()
    text = NON_WORD_RE.sub(" ", text)
    return [w.strip("'") for w in text.split() if w.strip("'")]


# ---------------------------------------------------------------- CTC forced alignment
def build_target(words: list[str], processor: Wav2Vec2Processor):
    vocab = processor.tokenizer.get_vocab()
    unk_id = processor.tokenizer.unk_token_id
    delim_id = processor.tokenizer.word_delimiter_token_id
    target_ids, word_spans, unknown_chars = [], [], set()
    for i, w in enumerate(words):
        if i > 0:
            target_ids.append(delim_id)
        start = len(target_ids)
        for ch in w:
            cid = vocab.get(ch, vocab.get(ch.upper()))
            if cid is None:
                unknown_chars.add(ch)
                cid = unk_id
            target_ids.append(cid)
        word_spans.append((start, len(target_ids)))
    return target_ids, word_spans, unknown_chars


def align_segment(model, processor, waveform, seg_start, seg_end, words, device):
    total_s = waveform.shape[-1] / SAMPLE_RATE
    lo = max(0.0, seg_start - SEG_PAD_S)
    hi = min(total_s, seg_end + SEG_PAD_S)
    i0, i1 = int(lo * SAMPLE_RATE), int(hi * SAMPLE_RATE)
    if i1 - i0 < SAMPLE_RATE * 0.05 or not words:
        return None

    target_ids, word_spans, unknown_chars = build_target(words, processor)
    if not target_ids:
        return None

    audio_slice = waveform[..., i0:i1]
    inputs = processor(audio_slice.squeeze(0).numpy(), sampling_rate=SAMPLE_RATE, return_tensors="pt")
    with torch.inference_mode():
        logits = model(inputs.input_values.to(device)).logits.cpu()
    emission = torch.log_softmax(logits, dim=-1)  # (1, T, V)

    blank_id = processor.tokenizer.pad_token_id
    targets = torch.tensor([target_ids], dtype=torch.int32)
    try:
        alignment, scores = F.forced_align(emission, targets, blank=blank_id)
        token_spans = F.merge_tokens(alignment[0], scores[0], blank=blank_id)
    except Exception as exc:  # noqa: BLE001 - report and skip, don't kill the whole job
        return {"error": str(exc)}
    if len(token_spans) != len(target_ids):
        return {"error": f"span/target length mismatch: {len(token_spans)} != {len(target_ids)}"}

    ratio = audio_slice.shape[-1] / emission.shape[1]  # samples per emission frame
    words_out = []
    for w, (s, e) in zip(words, word_spans):
        t0 = lo + (token_spans[s].start * ratio) / SAMPLE_RATE
        t1 = lo + (token_spans[e - 1].end * ratio) / SAMPLE_RATE
        words_out.append({"word": w, "start": round(t0, 3), "end": round(t1, 3), "dur": round(t1 - t0, 3)})
    return {"words": words_out, "unknown_chars": sorted(unknown_chars)}


# ---------------------------------------------------------------- per-segment processing
def process_segment(model, processor, waveform, seg_start, seg_end, raw_text, lang, device,
                     meta, unit_sink, full_sink):
    words = normalize_for_alignment(raw_text, lang)
    if not words:
        return
    result = align_segment(model, processor, waveform, seg_start, seg_end, words, device)
    if not result or "error" in result:
        if result:
            print(f"  WARN align failed ({meta['file']} @ {seg_start:.1f}s): {result['error']}", file=sys.stderr)
        return
    full_sink.append({**meta, "seg_start": seg_start, "seg_end": seg_end, "text": raw_text,
                       "words": result["words"]})
    durs = [w["dur"] for w in result["words"] if w["dur"] > 0]
    if not durs:
        return
    local_median = statistics.median(durs)
    for w in result["words"]:
        if w["word"] in UNIT_TOKENS and w["dur"] > 0:
            unit_sink.write(json.dumps({
                **meta,
                "unit": w["word"],
                "start": w["start"],
                "end": w["end"],
                "dur": w["dur"],
                "local_median_word_dur": round(local_median, 3),
                "rate_norm_dur": round(w["dur"] / local_median, 3) if local_median > 0 else None,
                "context": raw_text,
            }, ensure_ascii=False) + "\n")
            unit_sink.flush()


# ---------------------------------------------------------------- sources
def process_mit(corpus_dir, models, device, out_dir, unit_sink, limit):
    mit_dir = corpus_dir / "en" / "mit-8.701"
    srts = sorted(mit_dir.glob("*.srt"))[:limit]
    model, processor = models["en"]
    for srt_path in srts:
        mp4_path = srt_path.with_suffix(".mp4")
        done_marker = out_dir / ".done" / f"{srt_path.stem}.ok"
        if not mp4_path.exists():
            print(f"  skip {srt_path.name}: no matching .mp4", file=sys.stderr)
            continue
        if done_marker.exists():
            print(f"  skip {srt_path.name}: already done", file=sys.stderr)
            continue
        print(f"=== mit-8.701: {srt_path.name} ===", file=sys.stderr)
        waveform = load_audio(mp4_path)
        full_sink = []
        meta = {"lang": "en", "source": "mit-8.701", "file": srt_path.stem}
        for seg_start, seg_end, text in parse_srt(srt_path):
            process_segment(model, processor, waveform, seg_start, seg_end, text, "en", device,
                             meta, unit_sink, full_sink)
        write_full(out_dir, srt_path.stem, full_sink)
        done_marker.parent.mkdir(parents=True, exist_ok=True)
        done_marker.touch()


def process_podcasts(corpus_dir, models, asr, out_dir, unit_sink, limit):
    for lang, source in (("en", "daniel-and-jorge"), ("pl", "radio-naukowe")):
        pod_dir = corpus_dir / lang / source
        mp3s = sorted(pod_dir.glob("*.mp3"))[:limit]
        model, processor = models[lang]
        for mp3_path in mp3s:
            done_marker = out_dir / ".done" / f"{source}-{mp3_path.stem}.ok"
            if done_marker.exists():
                print(f"  skip {mp3_path.name}: already done", file=sys.stderr)
                continue
            print(f"=== {source}: {mp3_path.name} (transcribing, this is the slow step) ===", file=sys.stderr)
            waveform = load_audio(mp3_path)
            chunks = asr(
                str(mp3_path),
                return_timestamps=True,
                generate_kwargs={"language": lang, "task": "transcribe"},
            )["chunks"]
            full_sink = []
            meta = {"lang": lang, "source": source, "file": mp3_path.stem}
            total_s = waveform.shape[-1] / SAMPLE_RATE
            for chunk in chunks:
                start, end = chunk["timestamp"]
                if start is None:
                    continue
                if end is None:
                    end = total_s
                process_segment(model, processor, waveform, start, end, chunk["text"], lang, models["device"],
                                 meta, unit_sink, full_sink)
            write_full(out_dir, f"{source}-{mp3_path.stem}", full_sink)
            done_marker.parent.mkdir(parents=True, exist_ok=True)
            done_marker.touch()


def write_full(out_dir, name, full_sink):
    if not full_sink:
        return
    (out_dir / "full").mkdir(parents=True, exist_ok=True)
    with open(out_dir / "full" / f"{name}.json", "w", encoding="utf-8") as f:
        json.dump(full_sink, f, ensure_ascii=False, indent=1)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("results_dir")
    ap.add_argument("--corpus-dir", default="eval/lecture-corpus")
    ap.add_argument("--whisper-model", default="openai/whisper-large-v3")
    ap.add_argument("--limit", type=int, default=None, help="cap files per source, for a quick test run")
    ap.add_argument("--only", choices=["mit", "podcasts"], help="run only one stage")
    args = ap.parse_args()

    corpus_dir = Path(args.corpus_dir)
    out_dir = Path(args.results_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / ".done").mkdir(parents=True, exist_ok=True)

    device = "cuda" if torch.cuda.is_available() else "cpu"
    print(f"device: {device}", file=sys.stderr)

    print("loading CTC alignment models...", file=sys.stderr)
    models = {"device": device}
    for lang, repo in CTC_MODELS.items():
        processor = Wav2Vec2Processor.from_pretrained(repo)
        model = Wav2Vec2ForCTC.from_pretrained(repo).to(device).eval()
        models[lang] = (model, processor)
        print(f"  {lang}: {repo}  blank/pad_id={processor.tokenizer.pad_token_id} "
              f"delimiter_id={processor.tokenizer.word_delimiter_token_id}", file=sys.stderr)

    unit_path = out_dir / "unit-durations.jsonl"
    with open(unit_path, "a", encoding="utf-8") as unit_sink:
        if args.only != "podcasts":
            print("--- MIT 8.701 (known-transcript alignment, no ASR) ---", file=sys.stderr)
            process_mit(corpus_dir, models, device, out_dir, unit_sink, args.limit or 10**9)

        if args.only != "mit":
            print(f"loading ASR pipeline ({args.whisper_model})...", file=sys.stderr)
            asr = pipeline(
                "automatic-speech-recognition",
                model=args.whisper_model,
                device=0 if device == "cuda" else -1,
                torch_dtype=torch.float16 if device == "cuda" else torch.float32,
                chunk_length_s=30,
                stride_length_s=5,
            )
            print("--- podcasts (ASR + alignment) ---", file=sys.stderr)
            process_podcasts(corpus_dir, models, asr, out_dir, unit_sink, args.limit or 10**9)

    n = sum(1 for _ in open(unit_path, encoding="utf-8")) if unit_path.exists() else 0
    print(f"=== done: {n} unit-token instances written to {unit_path} ===", file=sys.stderr)


if __name__ == "__main__":
    main()
