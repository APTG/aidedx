#!/usr/bin/env python3
"""
Generate the controlled "unit pronunciation probe" sentence set for issue #118.

WHY THIS EXISTS
---------------
The 1000-sentence eval corpus can't answer "how does each TTS engine pronounce a unit"
because (a) Whisper normalizes every energy pronunciation back to the string `MeV`
regardless of whether the audio said "megaelectronvolt" or "em-ee-vee", and (b) whether
Whisper writes `centimeter` vs `cm` is a decoder/orthography choice, not the pronunciation
(see docs/unit-pronunciation-asr.md §1-2). So the transcript is the wrong instrument.

This probe sidesteps that with a MINIMAL-PAIR design: for each (carrier sentence, unit,
value) we emit several `variant`s that differ ONLY in how the unit is written:

  abbrev  : "150 MeV"                 <- what a TTS engine is normally fed; behaviour unknown
  expand  : "150 megaelectronvolt"    <- forces the fully-expanded pronunciation
  spaced  : "150 mega electron volt"  <- expanded, whitespace-separated (energy only)
  letters : "150 em e v"              <- forces the letter-spelled pronunciation

The carrier and value are held fixed across a base id's variants. After synthesis we compare
the CLIP DURATION (and, optionally, forced-aligned unit-token duration) of the `abbrev` clip
against its `expand` and `letters` siblings: if abbrev ~= letters the engine letter-spells the
abbreviation; if abbrev ~= expand it expands it. That's a measurement the transcript can't give
and it needs no forced alignment to be useful (scripts/unit-probe-analyze.py does the diffing).

Output schema is exactly what scripts/tts-{qwen,piper,chatterbox}-*.py already consume: a JSON
list of {id, text, ...}. Extra metadata fields (lang/unit/carrier/variant/value) are ignored by
those synth scripts and read back by scripts/unit-probe-analyze.py.

Usage:
  python scripts/generate-unit-probe.py <out.json> [--lang en|pl|both]
"""

import argparse
import json
import sys

# Expansions per language. Each unit maps to the spoken variants we want to force. `letters`
# is a whitespace spelling that reliably makes espeak/neural G2P read individual letter names
# (the pronunciation espeak already defaults to for these abbreviations — see
# docs/unit-pronunciation-asr.md §3); `spaced` only applies to the energy units.
EXPANSIONS = {
    "en": {
        # energy
        "keV": {"expand": "kiloelectronvolt", "spaced": "kilo electron volt", "letters": "kay e v"},
        "MeV": {"expand": "megaelectronvolt", "spaced": "mega electron volt", "letters": "em e v"},
        "GeV": {"expand": "gigaelectronvolt", "spaced": "giga electron volt", "letters": "gee e v"},
        # length
        "cm": {"expand": "centimeters", "letters": "see em"},
        "mm": {"expand": "millimeters", "letters": "em em"},
        "um": {"expand": "micrometers", "letters": "you em"},
    },
    "pl": {
        "keV": {"expand": "kiloelektronowolt", "spaced": "kilo elektrono wolt", "letters": "ka e wu"},
        "MeV": {"expand": "megaelektronowolt", "spaced": "mega elektrono wolt", "letters": "em e wu"},
        "GeV": {"expand": "gigaelektronowolt", "spaced": "giga elektrono wolt", "letters": "gie e wu"},
        "cm": {"expand": "centymetry", "letters": "ce em"},
        "mm": {"expand": "milimetry", "letters": "em em"},
        "um": {"expand": "mikrometry", "letters": "u em"},
    },
}

# A fixed value per unit (spoken identically across every variant of a base id, so the only
# acoustic difference is the unit rendering). Kept plausible for the physics domain.
VALUES = {"keV": 500, "MeV": 150, "GeV": 3, "cm": 10, "mm": 5, "um": 20}

# Carriers put the unit slot ({X}) at the END of the sentence, so trailing-silence trimming is
# consistent across variants and the clip-duration diff isolates the unit region cleanly. Three
# carriers per family average out per-sentence prosody noise.
CARRIERS = {
    "en": {
        "energy": ["The beam energy is {X}.", "We set the energy to {X}.", "Each particle carries {X}."],
        "length": ["The measured range is {X}.", "The particle stops after {X}.", "The gap is {X}."],
    },
    "pl": {
        "energy": ["Energia wiązki wynosi {X}.", "Ustawiamy energię na {X}.", "Każda cząstka niesie {X}."],
        "length": ["Zmierzony zasięg wynosi {X}.", "Cząstka zatrzymuje się po {X}.", "Szczelina ma {X}."],
    },
}

ENERGY_UNITS = ("keV", "MeV", "GeV")


def build(lang: str):
    out = []
    for unit, value in VALUES.items():
        family = "energy" if unit in ENERGY_UNITS else "length"
        exps = EXPANSIONS[lang][unit]
        variants = {"abbrev": f"{value} {unit}"}
        variants["expand"] = f"{value} {exps['expand']}"
        if "spaced" in exps:
            variants["spaced"] = f"{value} {exps['spaced']}"
        variants["letters"] = f"{value} {exps['letters']}"
        for ci, carrier in enumerate(CARRIERS[lang][family]):
            for variant, phrase in variants.items():
                text = carrier.replace("{X}", phrase)
                sid = f"{lang}-{unit}-c{ci}-{variant}"
                out.append(
                    {
                        "id": sid,
                        "text": text,
                        "lang": lang,
                        "unit": unit,
                        "family": family,
                        "carrier": ci,
                        "variant": variant,
                        "value": value,
                    }
                )
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("out")
    ap.add_argument("--lang", choices=["en", "pl", "both"], default="both")
    args = ap.parse_args()

    langs = ["en", "pl"] if args.lang == "both" else [args.lang]
    sentences = []
    for lang in langs:
        sentences.extend(build(lang))

    with open(args.out, "w", encoding="utf-8") as f:
        json.dump(sentences, f, ensure_ascii=False, indent=1)
    n_by = {}
    for s in sentences:
        n_by[s["lang"]] = n_by.get(s["lang"], 0) + 1
    print(f"wrote {len(sentences)} probe sentences to {args.out}  ({n_by})", file=sys.stderr)


if __name__ == "__main__":
    main()
