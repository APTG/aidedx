#!/bin/bash
#SBATCH --job-name=aidedx-fetch-lecture-corpus
#SBATCH --partition=plgrid-gpu-a100
#SBATCH --account=plgccbmc15-gpu-a100
#SBATCH --qos=normal
#SBATCH --nodes=1
#SBATCH --ntasks=1
#SBATCH --cpus-per-task=2
#SBATCH --mem=4G
#SBATCH --time=00:45:00
#SBATCH --output=%x-%j.out
#SBATCH --error=%x-%j.err
#
# Fetch a small public human-speech corpus for the issue #118 cross-check: does the empirical
# expanded ("megaelectronvolt") vs. letter-spelled ("em-ee-vee") ratio for keV/MeV/GeV in REAL
# speech match what the TTS-engine probe (submit-unit-probe.sh) measures? Pure network I/O, no
# GPU/Python/Node needed — this job does NOT source scripts/athena-env.sh on purpose. See
# docs/unit-pronunciation-asr.md §6 for the method and §6.1 for how these sources were found and
# vetted (archive.org metadata calls + `curl -I` HEAD requests only — nothing was downloaded
# during that research, this script does the actual fetch).
#
# This job only needs network + disk, not a GPU — it landed on the GPU partition/account here
# only because that's the only known-working one for this grant (every other submit-*.sh in this
# repo uses it). If this grant also has a CPU-only partition/account, prefer it instead:
#   sbatch --partition=<cpu-partition> --account=<cpu-account> scripts/submit-fetch-lecture-corpus.sh
# (sbatch CLI flags override the #SBATCH defaults above.)
#
# Three sources, all direct-download (no yt-dlp/browser needed), organized under
# eval/lecture-corpus/ (gitignored, same rationale as eval/audio/ — these are large binary
# artifacts regenerable from this script + the manifest below, not source):
#
#   en/mit-8.701/        MIT 8.701 "Intro to Nuclear & Particle Physics" (Fall 2020), mirrored on
#                         archive.org, CC BY-NC-SA. 21 of 67 chapters mention keV/MeV/GeV in their
#                         OFFICIAL (non-auto-generated) .srt captions — use the .srt as the
#                         forced-alignment REFERENCE text (known-correct), not Whisper's own
#                         transcript. The caption text still collapses to the abbreviation
#                         regardless of how it was spoken (same blindness as our Whisper
#                         transcripts, §1) — classification still has to come from aligned-segment
#                         duration, not the text.
#   en/daniel-and-jorge/ "Daniel and Jorge Explain the Universe" podcast — host Daniel Whiteson is
#                         an actual ATLAS/LHC physicist, so GeV/MeV come up in genuine unscripted
#                         collider talk. 4 episodes hand-picked by title for near-certain content.
#                         No ground-truth transcript (unscripted) — align against Whisper's own
#                         output instead, same self-referential caveat as the TTS probe (§5).
#   pl/radio-naukowe/    Radio Naukowe — Poland's most popular science-interview podcast. 4
#                         episodes hand-picked the same way (dark matter x2, fusion energy,
#                         Cherenkov radiation/CTA — all GeV/keV-scale physics). Same
#                         no-ground-truth caveat as the English podcast; no Polish equivalent of
#                         the MIT captioned lecture set was found (§6.1) — this is the best
#                         available PL source at hand-pick depth.
#
# ~1.2 GB total. Idempotent: wget -c resumes partial files and re-validates complete ones cheaply;
# safe to resubmit after a failure or partial network outage.
#
# Submit:  sbatch scripts/submit-fetch-lecture-corpus.sh
# Next step (not yet built): forced-alignment (WhisperX/MFA) + duration classification per
# docs/unit-pronunciation-asr.md §6.2 — this script only gets the raw corpus onto scratch.
set -uo pipefail

# Run from the repo root. Under sbatch, SLURM starts the job in the submission directory
# (SLURM_SUBMIT_DIR) — submit this from the repo root, same as every other submit-*.sh here.
cd "${SLURM_SUBMIT_DIR:-$(pwd)}"

OUT_ROOT="eval/lecture-corpus"
MIT_DIR="$OUT_ROOT/en/mit-8.701"
DJEU_DIR="$OUT_ROOT/en/daniel-and-jorge"
RN_DIR="$OUT_ROOT/pl/radio-naukowe"
mkdir -p "$MIT_DIR" "$DJEU_DIR" "$RN_DIR"

MANIFEST="$OUT_ROOT/MANIFEST.tsv"
echo -e "id\tlang\tsource\tpath\turl" >"$MANIFEST"

FAILED=0

# fetch <dest-path> <url> <lang> <source> <id> — resumable, does not abort the whole job on one
# broken URL (podcast redirect links can rot; the MIT archive.org mirror is much more stable).
fetch() {
  local dest="$1" url="$2" lang="$3" source="$4" id="$5"
  if wget --continue --tries=3 --waitretry=5 --timeout=60 --no-verbose -O "$dest" "$url"; then
    echo -e "${id}\t${lang}\t${source}\t${dest}\t${url}" >>"$MANIFEST"
  else
    echo "WARN: failed to fetch $dest <- $url" >&2
    rm -f "$dest" # don't leave a truncated/error-page file behind masquerading as media
    FAILED=$((FAILED + 1))
  fi
}

# --- 1. MIT 8.701 (archive.org): mp4 + official .srt per chapter ---
# Manifest: base filename (without extension) -> chapter, ranked by keV/MeV/GeV mention count in
# its own caption (docs/unit-pronunciation-asr.md §6.1 table). archive.org metadata call used to
# find these: curl -s https://archive.org/metadata/MIT8.701F20
MIT_BASE="https://archive.org/download/MIT8.701F20"
MIT_CHAPTERS=(
  00-07_Units
  00-08_RelKinematics
  08-04_experiments
  07-04_status
  10-04_accelerators
  07-03_productiondecay
  05-01_hadrons
  10-01_mechanism
  09-02_binding
  07-02_fermions
  05-04_dis
  01-03_RangeForces
  09-08_fusion
  09-07_fission
  06-03_piondecay
  05-05_alphas
  00-06_Particles
  08-06_scale
  08-03_mixing
  03-05_Divergency
  02-02_flavor
)
echo "=== MIT 8.701: ${#MIT_CHAPTERS[@]} chapters (mp4 + srt each) ==="
for ch in "${MIT_CHAPTERS[@]}"; do
  name="MIT8_701F20_${ch}_300k"
  fetch "$MIT_DIR/$name.mp4" "$MIT_BASE/$name.mp4" en mit-8.701 "$ch"
  fetch "$MIT_DIR/$name.srt" "$MIT_BASE/$name.srt" en mit-8.701 "$ch-srt"
done

# --- 2. Daniel and Jorge Explain the Universe (Omny RSS), hand-picked episodes ---
# RSS feed (all episodes): https://www.omnycontent.com/d/playlist/e73c998e-6e60-432f-8610-ae210140c5b1/f5d5fac6-77be-47e6-9aee-ae32006cd8c3/b26cbbeb-86eb-4b97-9b34-ae32006cd8d6/podcast.rss
echo "=== Daniel and Jorge Explain the Universe: 4 episodes ==="
fetch "$DJEU_DIR/higgs-boson-mass.mp3" \
  "https://podtrac.com/pts/redirect.mp3/traffic.omny.fm/d/clips/e73c998e-6e60-432f-8610-ae210140c5b1/f5d5fac6-77be-47e6-9aee-ae32006cd8c3/d23350bb-8291-49ef-adf9-b05a013935d2/audio.mp3" \
  en daniel-and-jorge higgs-boson-mass
fetch "$DJEU_DIR/charm-quarks-in-proton.mp3" \
  "https://podtrac.com/pts/redirect.mp3/traffic.omny.fm/d/clips/e73c998e-6e60-432f-8610-ae210140c5b1/f5d5fac6-77be-47e6-9aee-ae32006cd8c3/449af6fa-cf84-455e-a944-b110017a224f/audio.mp3" \
  en daniel-and-jorge charm-quarks-in-proton
fetch "$DJEU_DIR/neutrino-mass.mp3" \
  "https://podtrac.com/pts/redirect.mp3/traffic.omny.fm/d/clips/e73c998e-6e60-432f-8610-ae210140c5b1/f5d5fac6-77be-47e6-9aee-ae32006cd8c3/e7e00d86-503d-45a9-aaf1-b046003b8e02/audio.mp3" \
  en daniel-and-jorge neutrino-mass
fetch "$DJEU_DIR/antimatter-dark-matter.mp3" \
  "https://podtrac.com/pts/redirect.mp3/traffic.omny.fm/d/clips/e73c998e-6e60-432f-8610-ae210140c5b1/f5d5fac6-77be-47e6-9aee-ae32006cd8c3/31a0574b-c477-4d96-a84f-b278002b46ba/audio.mp3" \
  en daniel-and-jorge antimatter-dark-matter

# --- 3. Radio Naukowe (Spreaker via podtrac redirect), hand-picked episodes ---
# RSS feed (all episodes): https://www.spreaker.com/show/4638772/episodes/feed
echo "=== Radio Naukowe: 4 episodes ==="
fetch "$RN_DIR/289-ciemna-materia-i-neutrina.mp3" \
  "https://dts.podtrac.com/redirect.mp3/api.spreaker.com/download/episode/70136375/289e01s_radionaukowe_sebastian_trojanowski_neutrina_i_nowa_fizyka.mp3" \
  pl radio-naukowe 289-ciemna-materia-i-neutrina
fetch "$RN_DIR/104-ciemna-materia.mp3" \
  "https://dts.podtrac.com/redirect.mp3/api.spreaker.com/download/episode/50650619/104e01s_radionaukowe_sebastian_trojanowski_ciemna_materia.mp3" \
  pl radio-naukowe 104-ciemna-materia
fetch "$RN_DIR/183-energia-fuzji.mp3" \
  "https://dts.podtrac.com/redirect.mp3/api.spreaker.com/download/episode/58436792/183e01s_radionaukowe_agata_chomiczewska_energia_fuzji.mp3" \
  pl radio-naukowe 183-energia-fuzji
fetch "$RN_DIR/087-promieniowanie-czerenkowa.mp3" \
  "https://dts.podtrac.com/redirect.mp3/api.spreaker.com/download/episode/49085375/87e01s_radionaukowe_marek_nikolajuk_promieniowanie_czerenkowa.mp3" \
  pl radio-naukowe 087-promieniowanie-czerenkowa

echo "=== summary ==="
du -sh "$MIT_DIR" "$DJEU_DIR" "$RN_DIR" 2>/dev/null || true
echo "manifest: $MANIFEST ($(($(wc -l <"$MANIFEST") - 1)) files fetched, $FAILED failed)"
if [ "$FAILED" -gt 0 ]; then
  echo "=== done with $FAILED failure(s) — see WARN lines above; resubmit to retry just those ==="
  exit 1
fi
echo "=== done: corpus in $OUT_ROOT ==="
