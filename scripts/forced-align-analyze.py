#!/usr/bin/env python3
"""
Summarize scripts/forced-align-corpus.py's output (issue #118 §6 human-speech cross-check).
Runs LOCALLY, no GPU/torch needed — reads the committed `unit-durations.jsonl` written on Athena
(one JSON object per keV/MeV/GeV/eV instance found by forced alignment).

Real speech has no fixed rate the way TTS does (scripts/unit-probe-analyze.py's `r =
(dur_abbrev - dur_letters) / (dur_expand - dur_letters)` needs minimal-pair siblings that don't
exist here — every instance here is a single, unrepeated realization). So this script doesn't
auto-classify; it reports the RATE-NORMALIZED duration distribution (`dur / local_median_word_dur`
— comparable across speakers/segments of different speaking rates, unlike raw seconds) per
lang/source/unit, plus every instance sorted by that ratio with its sentence context, so a human
can eyeball where the expanded-vs-letter-spelled split falls (or listen to a handful of the
extremes directly, using the timestamp + eval/lecture-corpus/<lang>/<source>/<file> audio).

Usage:
  python3 scripts/forced-align-analyze.py <results_dir> [--csv out.csv] [--top N]
"""

import argparse
import csv
import json
import statistics
import sys
from pathlib import Path


def load(results_dir: Path):
    path = results_dir / "unit-durations.jsonl"
    if not path.exists():
        print(f"no {path} — run scripts/submit-forced-align.sh first", file=sys.stderr)
        sys.exit(1)
    rows = []
    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line:
                rows.append(json.loads(line))
    return rows


def fmt(x, digits=2):
    return f"{x:.{digits}f}" if isinstance(x, (int, float)) else "  -  "


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("results_dir", type=Path)
    ap.add_argument("--csv", help="write every instance to a CSV for spreadsheet inspection")
    ap.add_argument("--top", type=int, default=5, help="how many extreme (low/high) instances to print per group")
    args = ap.parse_args()

    rows = load(args.results_dir)
    if not rows:
        print("unit-durations.jsonl is empty — nothing aligned yet", file=sys.stderr)
        sys.exit(1)

    groups = {}
    for r in rows:
        key = (r["lang"], r["source"], r["unit"])
        groups.setdefault(key, []).append(r)

    print(f"loaded {len(rows)} instances across {len(groups)} (lang, source, unit) groups\n")
    print(f"{'lang':4s} {'source':16s} {'unit':4s} {'n':>4s} {'dur_med':>8s} {'dur_mean':>9s} "
          f"{'rate_med':>9s} {'rate_mean':>10s}  (rate = dur / local median word dur)")
    for (lang, source, unit), items in sorted(groups.items()):
        durs = [it["dur"] for it in items]
        rates = [it["rate_norm_dur"] for it in items if it.get("rate_norm_dur") is not None]
        print(
            f"{lang:4s} {source:16s} {unit:4s} {len(items):>4d} "
            f"{fmt(statistics.median(durs)):>8s} {fmt(statistics.mean(durs)):>9s} "
            f"{fmt(statistics.median(rates)) if rates else '  -  ':>9s} "
            f"{fmt(statistics.mean(rates)) if rates else '  -  ':>10s}"
        )

    print(
        "\nInterpretation: within one group, LOW rate_norm_dur ~ spoken quickly relative to its "
        "\nsentence (consistent with a short letter-spelled reading, e.g. 'em-ee-vee'); HIGH ~ "
        "\nspoken slowly relative to its sentence (consistent with a longer expanded reading, "
        "\ne.g. 'megaelectronvolt'). No fixed threshold — eyeball the extremes below, or the "
        "\ncontext text, or the source audio at eval/lecture-corpus/<lang>/<source>/<file>.* "
        "\naround the given [start, end] (in seconds, from the start of that file).\n"
    )

    for (lang, source, unit), items in sorted(groups.items()):
        ranked = sorted((it for it in items if it.get("rate_norm_dur") is not None),
                         key=lambda it: it["rate_norm_dur"])
        if not ranked:
            continue
        print(f"=== {lang}/{source}/{unit} — {len(ranked)} instances, extremes ===")
        shown = ranked[: args.top] + (ranked[-args.top :] if len(ranked) > args.top else [])
        seen = set()
        for it in shown:
            k = (it["file"], it["start"])
            if k in seen:
                continue
            seen.add(k)
            print(
                f"  rate={it['rate_norm_dur']:.2f}  dur={it['dur']:.2f}s  "
                f"{it['file']} [{it['start']:.1f}s-{it['end']:.1f}s]"
            )
            print(f"      {it['context'][:160]!r}")
        print()

    if args.csv:
        fields = ["lang", "source", "file", "unit", "start", "end", "dur", "local_median_word_dur",
                   "rate_norm_dur", "context"]
        with open(args.csv, "w", newline="", encoding="utf-8") as f:
            w = csv.DictWriter(f, fieldnames=fields, extrasaction="ignore")
            w.writeheader()
            for r in sorted(rows, key=lambda r: (r["lang"], r["source"], r["unit"], r["rate_norm_dur"] or 0)):
                w.writerow(r)
        print(f"wrote {args.csv}", file=sys.stderr)


if __name__ == "__main__":
    main()
