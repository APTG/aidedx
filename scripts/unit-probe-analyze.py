#!/usr/bin/env python3
"""
Analyze the unit-pronunciation probe results (issue #118). Runs LOCALLY after the Athena job's
results are synced back — no GPU, no models, just the committed manifests + transcripts written
by scripts/submit-unit-probe.sh.

For each engine and unit it compares the synthesized CLIP DURATION of the `abbrev` variant
("150 MeV") against its minimal-pair siblings `expand` ("150 megaelectronvolt") and `letters`
("150 em e v"), averaged over the carrier sentences. Since the carrier + value are identical
across a base id's variants, the only acoustic difference is the unit rendering, so:

    r = (dur_abbrev - dur_letters) / (dur_expand - dur_letters)

places the engine's default rendering of the abbreviation on a line from letter-spelled (r≈0)
to fully-expanded (r≈1). It also prints what Whisper wrote for each variant (the un-prompted
small-model transcript), a secondary orthographic signal.

Usage:
  python3 scripts/unit-probe-analyze.py <results_dir> [--json out.json]
"""

import argparse
import glob
import json
import os
import re
import sys

VARIANTS = ("abbrev", "expand", "spaced", "letters")
ID_RE = re.compile(r"^(?P<lang>en|pl)-(?P<unit>[A-Za-z]+)-c(?P<carrier>\d+)-(?P<variant>[a-z]+)$")


def parse_id(sid):
    m = ID_RE.match(sid)
    return m.groupdict() if m else None


def load_manifest(path):
    """id -> dur_s, from an engine's copied manifest.json."""
    with open(path, encoding="utf-8") as f:
        data = json.load(f)
    clips = data.get("clips", data)
    if isinstance(clips, dict):
        clips = list(clips.values())
    return {c["id"]: c.get("dur_s") for c in clips if "id" in c}


def load_transcript(path):
    """id -> raw transcript text, from an asr-transcribe-manifest.mjs output."""
    if not os.path.exists(path):
        return {}
    with open(path, encoding="utf-8") as f:
        data = json.load(f)
    recs = data.get("records", data)
    return {r["id"]: r.get("raw", "") for r in recs if "id" in r}


def mean(xs):
    xs = [x for x in xs if isinstance(x, (int, float))]
    return sum(xs) / len(xs) if xs else None


def engines_in(results_dir):
    out = []
    for p in sorted(glob.glob(os.path.join(results_dir, "*-manifest.json"))):
        out.append(os.path.basename(p)[: -len("-manifest.json")])
    return out


def analyze_engine(results_dir, engine):
    durs = load_manifest(os.path.join(results_dir, f"{engine}-manifest.json"))
    tx = load_transcript(os.path.join(results_dir, f"{engine}-small-q8-noprompt.json"))

    # (unit) -> variant -> list of (dur, transcript) across carriers
    by_unit = {}
    for sid, dur in durs.items():
        p = parse_id(sid)
        if not p:
            continue
        u = by_unit.setdefault(p["unit"], {v: [] for v in VARIANTS})
        u[p["variant"]].append((dur, tx.get(sid, "")))

    rows = []
    for unit, vs in sorted(by_unit.items()):
        d = {v: mean([x[0] for x in vs[v]]) for v in VARIANTS}
        r = None
        denom = None
        if d["abbrev"] is not None and d["expand"] is not None and d["letters"] is not None:
            denom = d["expand"] - d["letters"]
            if abs(denom) > 0.05:  # need a real separation to classify
                r = (d["abbrev"] - d["letters"]) / denom
        verdict = "?"
        if r is not None:
            verdict = "EXPANDS" if r >= 0.6 else "letter-spells" if r <= 0.4 else "mixed/unclear"
        # a representative transcript of the abbrev variant (what Whisper heard/wrote)
        abbr_tx = next((t for _, t in vs["abbrev"] if t), "")
        rows.append(
            {
                "unit": unit,
                "dur": d,
                "ratio": r,
                "expand_minus_letters": denom,
                "verdict": verdict,
                "abbrev_transcript": abbr_tx,
            }
        )
    return rows


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("results_dir")
    ap.add_argument("--json", dest="json_out")
    args = ap.parse_args()

    engines = engines_in(args.results_dir)
    if not engines:
        print(f"no *-manifest.json found in {args.results_dir}", file=sys.stderr)
        sys.exit(1)

    report = {}
    for engine in engines:
        rows = analyze_engine(args.results_dir, engine)
        report[engine] = rows
        print(f"\n===== {engine} =====")
        print(f"  {'unit':5s} {'abbrev':>7s} {'expand':>7s} {'letters':>7s} {'ratio':>6s}  verdict")
        for row in rows:
            d = row["dur"]

            def fmt(x):
                return f"{x:.2f}" if isinstance(x, (int, float)) else "  -  "

            rr = f"{row['ratio']:.2f}" if row["ratio"] is not None else "  -  "
            print(
                f"  {row['unit']:5s} {fmt(d['abbrev']):>7s} {fmt(d['expand']):>7s} "
                f"{fmt(d['letters']):>7s} {rr:>6s}  {row['verdict']}"
            )
            if row["abbrev_transcript"]:
                print(f"        abbrev heard as: {row['abbrev_transcript']!r}")

    print(
        "\nInterpretation: ratio ~0 => engine letter-spells the abbreviation (e.g. 'em-ee-vee'); "
        "\n                ratio ~1 => engine expands it (e.g. 'megaelectronvolt').",
    )

    if args.json_out:
        with open(args.json_out, "w", encoding="utf-8") as f:
            json.dump(report, f, indent=1, ensure_ascii=False)
        print(f"\nwrote {args.json_out}", file=sys.stderr)


if __name__ == "__main__":
    main()
