#!/usr/bin/env bash
set -euo pipefail
SPEAKER=${1:?Usage: $0 <speaker-tag>}
if [[ ! "$SPEAKER" =~ ^[a-zA-Z0-9_-]+$ ]]; then
  echo "Error: speaker tag must contain only letters, digits, hyphens, and underscores" >&2
  exit 1
fi
mkdir -p "eval/audio/$SPEAKER"

while IFS=$'\t' read -r id text <&3; do
  echo ""
  echo "  [$id]"
  echo "  Say: $text"
  read -rp "  Press Enter to start recording (Ctrl-C to abort)..."
  arecord -r 44100 -f S16_LE -c 1 -t wav \
    "eval/audio/$SPEAKER/$id.wav" &
  REC_PID=$!
  read -rp "  Recording... Press Enter to stop."
  kill "$REC_PID" 2>/dev/null
  wait "$REC_PID" 2>/dev/null || true
  echo "  Saved → eval/audio/$SPEAKER/$id.wav"
done 3<<'SENTENCES'
stress-001	I am curious how far in water the 240 keV carbon ion will go
stress-002	compare stopping power of neon ions in water and air for 100 MeV/nucl
sp-003	What's the dE/dx of 250 MeV protons in PMMA?
sp-005	Stopping power for 80 MeV per nucleon carbon ions in water.
sp-007	What is the mass stopping power of 200 MeV protons in cortical bone?
sp-008	dE/dx of 3 MeV deuterons in silicon.
rng-002	What is the CSDA range of a 150 MeV proton in water?
rng-005	Range of 90 MeV per nucleon carbon ions in water.
rng-008	How deep does a 100 MeV proton penetrate in water?
ind-001	How far will a 60 MeV proton travel in water?
ind-003	At what rate does a 30 MeV proton shed energy as it moves through aluminum?
ind-008	What penetration depth do 80 MeV per nucleon oxygen ions reach in water?
conv-003	Um, so like, how far does a 100 MeV proton go in water, roughly?
conv-008	Okay so I need the range of 230 MeV protons in water for a plan.
cmp-mat-001	Compare the stopping power of 100 MeV protons in water and bone.
cmp-mat-004	Range of 150 MeV protons in water, bone, and adipose tissue.
cmp-mat-007	For 100 MeV per nucleon carbon ions, compare the range in water and PMMA.
cmp-par-003	How do carbon and neon ions compare in range in water at 100 MeV per nucleon?
cmp-par-005	Which penetrates deeper in water at 60 MeV, a proton or a deuteron?
cmp-en-001	Compare the range of protons in water at 100 and 200 MeV.
cmp-prog-001	Compare the range of 150 MeV protons in water using ASTAR and PSTAR.
unit-001	Stopping power of 500 keV protons in water.
unit-003	What is the stopping power of 1 GeV protons in water?
unit-006	What is the range of 900 keV deuterons in water?
pernuc-001	Range of carbon ions in water at 290 MeV/u.
pernuc-003	What is the range of a carbon ion with 3.6 GeV total energy in water?
iso-002	Stopping power of carbon-13 ions in water at 100 MeV per nucleon.
iso-004	Stopping power of a helium-3 ion in water at 40 MeV per nucleon.
inv-rng-001	What energy gives a 10 cm range in water for protons?
alias-001	What is the range of 60 MeV protons in Lucite?
SENTENCES
