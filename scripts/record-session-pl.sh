#!/usr/bin/env bash
# Records the 50-sentence Polish ASR eval set (eval/RECORDING.pl.md) from the
# Brio USB mic. Each take starts on Enter and stops on any keypress or Ctrl-C.
#
# Usage: scripts/record-session-pl.sh <speaker-tag> [--force]
#   --force   re-record sentences that already have a saved .wav (default:
#             skip them, so a session can be split across sittings)
#
# Tuning (env vars):
#   DEVICE  ALSA capture device (default: hw:CARD=B100,DEV=0, the Brio)
set -euo pipefail

SPEAKER=${1:?Usage: $0 <speaker-tag> [--force]}
FORCE=0
[[ "${2:-}" == "--force" ]] && FORCE=1

if [[ ! "$SPEAKER" =~ ^[a-zA-Z0-9_-]+$ ]]; then
  echo "Error: speaker tag must contain only letters, digits, hyphens, and underscores" >&2
  exit 1
fi

if ! command -v sox >/dev/null 2>&1; then
  echo "Error: sox is not installed. Run: sudo apt install -y sox libsox-fmt-alsa" >&2
  exit 1
fi

DEVICE=${DEVICE:-hw:CARD=B100,DEV=0}

if ! arecord -L 2>/dev/null | grep -q "CARD=B100"; then
  echo "Warning: no ALSA device named CARD=B100 (Brio) found. Set DEVICE=... to override." >&2
fi

OUTDIR="eval/audio/$SPEAKER"
mkdir -p "$OUTDIR"
TMP="$(mktemp --suffix=.wav)"
trap 'rm -f "$TMP"' EXIT

echo "Speaker: $SPEAKER | device: $DEVICE"
echo "Each take starts on Enter, stops on any keypress or Ctrl-C."
echo ""

total=0
recorded=0
skipped=0

while IFS=$'\t' read -r id text <&3; do
  total=$((total + 1))
  outfile="$OUTDIR/$id.wav"

  if [[ -f "$outfile" && "$FORCE" -ne 1 ]]; then
    echo "  [$id] already recorded, skipping (--force to redo)"
    skipped=$((skipped + 1))
    continue
  fi

  while true; do
    echo ""
    echo "  [$id]"
    echo "  Say: $text"
    read -rp "  Enter to record, s = skip, q = quit: " key
    if [[ "$key" == "q" ]]; then
      echo ""
      echo "Stopped early. $recorded recorded, $skipped skipped, $((total - 1)) seen of 50."
      exit 0
    fi
    if [[ "$key" == "s" ]]; then
      skipped=$((skipped + 1))
      break
    fi

    echo "  Recording... press any key (or Ctrl-C) to stop"
    rm -f "$TMP"
    set +e
    sox -q -t alsa "$DEVICE" -c 1 -r 48000 -b 16 "$TMP" &
    recpid=$!

    stopped=0
    trap 'stopped=1' INT
    while kill -0 "$recpid" 2>/dev/null && [[ "$stopped" -eq 0 ]]; do
      read -n 1 -s -r -t 0.2 _ 2>/dev/null && stopped=1
    done
    trap - INT

    kill -INT "$recpid" 2>/dev/null
    wait "$recpid" 2>/dev/null
    set -e

    dur=$(soxi -D "$TMP" 2>/dev/null || echo "0")
    echo "  Captured ${dur}s"
    read -rp "  Enter = keep and continue, r = redo this sentence: " redo
    if [[ "$redo" == "r" ]]; then
      continue
    fi
    mv "$TMP" "$outfile"
    recorded=$((recorded + 1))
    echo "  Saved -> $outfile"
    break
  done
done 3<<'SENTENCES'
pl-rng-01	Jaki jest zasięg protonu o energii 150 MeV w wodzie?
pl-rng-02	Ile wynosi zasięg CSDA protonu o energii 230 MeV w wodzie?
pl-rng-03	Jak głęboko wniknie proton o energii 70 MeV w tkankę mięśniową?
pl-rng-04	Jak daleko doleci cząstka alfa o energii 20 MeV w powietrzu?
pl-rng-05	Podaj zasięg deuteronu o energii 60 MeV w krzemie.
pl-rng-06	Jaki zasięg ma tryton o energii 40 MeV w PMMA?
pl-rng-07	Oblicz zasięg jonu węgla-12 o energii 300 MeV na nukleon w wodzie.
pl-rng-08	Na jaką głębokość wniknie jon tlenu o energii 250 MeV na nukleon w PMMA?
pl-rng-09	Jaki jest zasięg jonu neonu o energii 400 MeV na nukleon w wodzie?
pl-rng-10	Ile wynosi zasięg jonu żelaza o energii 600 MeV na nukleon w aluminium?
pl-rng-11	Jak daleko dotrze jon wapnia o energii 200 MeV na nukleon w tkance tłuszczowej?
pl-rng-12	Podaj zasięg jonu argonu o energii 350 MeV na nukleon w wodzie.
pl-rng-13	Jaki zasięg ma jon azotu o energii 180 MeV na nukleon w kości korowej?
pl-rng-14	Jak głęboko wniknie jon helu-3 o energii 30 MeV w grafit?
pl-rng-15	Oblicz zasięg jonu litu o energii 50 MeV na nukleon w poliwęglanie.
pl-rng-16	Jaki jest zasięg jonu boru o energii 100 MeV na nukleon w polietylenie?
pl-rng-17	Jak daleko doleci jon krzemu o energii 300 MeV na nukleon w dwutlenku krzemu?
pl-rng-18	Ile wynosi zasięg jonu miedzi o energii 500 MeV na nukleon w ołowiu?
pl-rng-19	Podaj zasięg jonu kryptonu o energii 800 MeV na nukleon w aluminium.
pl-rng-20	Jaki zasięg ma jon ksenonu o energii 400 MeV na nukleon w wodzie?
pl-rng-21	Jak głęboko wniknie jon tytanu o energii 600 MeV na nukleon w wodzie?
pl-rng-22	Powiedz mi, jak daleko zajdzie proton o energii 100 MeV w kości zbitej.
pl-rng-23	Zasięg cząstki alfa o energii 10 MeV w Kaptonie – ile to wynosi?
pl-rng-24	Jaki jest zasięg jonu magnezu o energii 150 MeV na nukleon w plastiku tkankopodobnym A-150?
pl-rng-25	Jaki jest zasięg protonu w wodzie dla energii 100, 150 i 200 MeV?
pl-rng-26	Porównaj zasięg jonu węgla w wodzie przy 200, 300 i 400 MeV na nukleon.
pl-rng-27	Jak zmienia się zasięg cząstki alfa w powietrzu dla 5, 10 i 20 MeV?
pl-rng-28	Porównaj zasięg protonu o energii 150 MeV w wodzie, PMMA i kości korowej.
pl-rng-29	Jaki jest zasięg jonu tlenu o energii 300 MeV na nukleon w wodzie i w aluminium?
pl-rng-30	Co wniknie głębiej w wodę przy 200 MeV na nukleon: jon węgla czy jon neonu?
pl-inv-01	Jaką energię musi mieć proton, żeby jego zasięg w wodzie wynosił 20 cm?
pl-inv-02	Przy jakiej energii proton osiągnie zasięg 15 cm w wodzie?
pl-inv-03	Jaka energia protonu odpowiada zasięgowi 5 cm w PMMA?
pl-inv-04	Ile energii potrzebuje jon węgla, aby jego zasięg w wodzie wynosił 10 cm?
pl-inv-05	Jaką energię trzeba nadać cząstce alfa, aby miała zasięg 30 mm w tkance mięśniowej?
pl-inv-06	Przy jakiej energii jon żelaza osiągnie zasięg 3 cm w wodzie?
pl-inv-07	Jaką energię musi mieć jon tlenu, żeby dotrzeć na głębokość 12 cm w wodzie?
pl-inv-08	Ile energii potrzebuje proton na zasięg 8 cm w kości korowej?
pl-inv-09	Jaką energię musi mieć jon wapnia dla zasięgu 5 cm w PMMA?
pl-inv-10	Przy jakiej energii deuteron uzyska zasięg 50 mm w aluminium?
pl-inv-11	Jaką energię musi mieć proton, aby uzyskać zasięg 10 cm w wodzie i w PMMA?
pl-inv-12	Jaką energię potrzebuje proton na zasięg 15 cm w wodzie? A jon węgla?
pl-sp-01	Jaki jest LET protonu o energii 100 MeV w wodzie?
pl-sp-02	Ile wynosi masowa zdolność hamowania jonu węgla o energii 200 MeV na nukleon w wodzie?
pl-sp-03	Ile energii traci proton o energii 10 MeV na centymetr drogi w aluminium?
pl-sp-04	Podaj dE/dx dla deuteronu o energii 40 MeV w powietrzu.
pl-sp-05	Jaki jest LET cząstki alfa o energii 5 MeV w krzemie?
pl-sp-06	Jaka jest zdolność hamowania jonu żelaza o energii 500 MeV na nukleon w złocie?
pl-sp-07	Porównaj zdolność hamowania protonu w wodzie przy 50, 100 i 150 MeV.
pl-sp-08	Porównaj LET jonu węgla o energii 300 MeV na nukleon w wodzie i w PMMA.
SENTENCES

echo ""
echo "Done. $recorded recorded, $skipped skipped this run."
