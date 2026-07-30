# Datagen-set TTS synthesis: Qwen3-TTS (EN) + Piper/Chatterbox (PL) (issue #155)

_Pipeline-only report, 2026-07-30 — same pattern as `docs/tts-chatterbox-pl-clone.md`'s own first
commit ("ships the pipeline... no results yet"). No Athena run has happened yet; this documents
what was built and exactly how to run it. A results doc lands once the Athena job completes._

## 1. What this is

Issue #155 is the deferred **Part 5** of #130: `eval/datagen-sentences.json`'s 50 physics tuples
(50 × EN + 50 × PL, ids `dg-01`..`dg-50`) now have a real human-recorded counterpart (#149's
`lgpixel` Pixel-7a session, scored in `docs/android-datagen-bench.md`) — this synthesizes the
**same 100 sentences** via TTS, on the same text, so a later session can score them with the
identical `scripts/e2e-audio-intents-datagen.ts` harness and put a real human-vs-synthetic number
next to `docs/android-datagen-bench.md` §4.1's table for the first time in this repo.

Three engines, deliberately not one picked in advance (per the requester's own framing: "try both
Piper and Chatterbox, later we will choose what is useful"):

- **Qwen3-TTS** (English) — the established engine across the 1000-sentence batches
  (`docs/tts-eval-1000-v3.md`, 84.0% clip-level). No serious EN alternative is in question here;
  Polish is where this repo's TTS story is still unsettled.
- **Piper** (Polish, real `pl_PL` voices) — the only currently-viable PL engine
  (`docs/tts-eval-1000-pl.md`: 20.8% vs. Qwen3-TTS-PL's ~0.9%, and Qwen3-TTS doesn't even accept
  `language="Polish"` — not a close contest, a language-support gap).
- **Chatterbox Multilingual TTS** (Polish, **native voice, no cloning**) — issue #106's "how good
  is Chatterbox's native Polish" data point, built specifically to see whether it closes some of
  the Piper/Qwen3-TTS Polish gap; no results doc has landed for it yet. Native only — cloning the
  `lgpixel` speaker's voice would need that speaker's own explicit re-authorization for this
  specific use (issue #106's consent precedent), which hasn't been sought here, so it's out of
  scope per issue #155's own non-goals.

## 2. Why no new Python generation script was needed

`eval/datagen-sentences.json` is committed in a bilingual, per-tuple `{id, en:{...}, pl:{...}}`
shape — not what any TTS script here reads. But every existing TTS generation script
(`scripts/tts-qwen-1000.py`, `scripts/tts-piper-1000.py`, `scripts/tts-chatterbox-1000-pl.py`) is
already fully generic over a flat `{id, text, quantity, multi, slotTruth}` list — none of them
know or care that they were originally fed a 1000-sentence batch instead of 50. The only piece
that needed to exist was the flattening step, and `scripts/datagen-to-manifest.mjs` already did
almost exactly that for a _different_ purpose (issue #130 Part 3's scoring path, using the
`canonical` field). It now takes a `--field canonical|display` flag (default `canonical`,
unchanged for existing callers); `--field display` is what this issue uses:

```sh
node scripts/datagen-to-manifest.mjs en eval/datagen-manifest-tts-en.json --field display
node scripts/datagen-to-manifest.mjs pl eval/datagen-manifest-tts-pl.json --field display
```

`display` (not `canonical`) is the TTS-input text on purpose — #130 Part 1 designed it to double
as TTS input from the start: length units always spelled out, the 5/50 expanded-energy sentences,
`LET`→"el-ee-tee" and `CSDA`→"see-ess-dee-ay" letter-spelled in English, `PMMA` left as the bare
acronym in both languages (reasoned, not yet measured, to already be unambiguous). See
`eval/RECORDING.datagen.md`'s own rendering table for the full reasoning behind each of those
calls — this pipeline verifies them against real TTS output for the first time, it doesn't
redesign them. Spot-checked locally (no GPU needed for this part):

```
dg-13 EN display: "What is the see-ess-dee-ay range of a 250 MeV per nucleon oxygen ion in PMMA?"
dg-48 EN display: "Compare the el-ee-tee of a 150 MeV proton in water, PMMA, and cortical bone."
```

## 3. What's built

- **`scripts/datagen-to-manifest.mjs`** — `--field display` mode added (§2 above).
- **`scripts/submit-datagen-tts.sh`** — one Athena job running all three engines back to back:
  1. Flatten both `display` manifests (§2).
  2. Qwen3-TTS EN generation → `eval/audio/tts-qwen-datagen-en/`.
  3. Piper PL generation → `eval/audio/tts-piper-datagen-pl/` (auto-provisions `.venv-piper` if
     missing, same as `scripts/submit-pl.sh`).
  4. Chatterbox PL generation, native mode → `eval/audio/tts-chatterbox-datagen-pl/`.
  5. ASR transcription of all three batches — desktop `whisper-small` q8 + domain prompt, the
     same leg `docs/android-datagen-bench.md` §4.1's table already reports for the real `lgpixel`
     session, so these numbers land directly in that table's columns without a methodology
     mismatch to reconcile.
  6. Scoring via `scripts/e2e-audio-intents-datagen.ts` — the identical E2E metric §4.1 uses.

  Every generation/transcription step is resumable (skips ids already in its manifest/outFile),
  same discipline as every other 1000-sentence Athena script in this repo. Fails fast with a clear
  message if `.venv-qwen` or `.venv-chatterbox` don't already exist (both CUDA-specific,
  one-time interactive setup — see `docs/athena-setup.md` for `.venv-qwen`,
  `scripts/submit-chatterbox-pl.sh`'s header comment for `.venv-chatterbox`'s torch-pin gotcha).

- **Nothing new for the synthesis engines themselves.** `scripts/tts-qwen-1000.py`,
  `scripts/tts-piper-1000.py`, and `scripts/tts-chatterbox-1000-pl.py` are used unmodified,
  pointed at the 50-clip flattened manifests instead of a 1000-sentence one.

## 4. How to run it

From the repo root, after pulling this branch/commit onto Athena:

```sh
cd /net/tscratch/people/plgkongruencj/aidedx
git pull
sbatch scripts/submit-datagen-tts.sh
```

Requires `.venv-qwen` and `.venv-chatterbox` to already exist (see §3 above for where each is set
up); `.venv-piper` is created automatically on first run if missing.

Results land in `eval/results/datagen-tts-<date>/`:

```
qwen-en-small-q8-prompt.json        # ASR transcripts, Qwen3-TTS EN batch
piper-pl-small-q8-prompt.json       # ASR transcripts, Piper PL batch
chatterbox-pl-small-q8-prompt.json  # ASR transcripts, Chatterbox PL native batch
qwen-en-score.log                   # e2e-audio-intents-datagen.ts output, EN
piper-pl-score.log                  # e2e-audio-intents-datagen.ts output, PL (Piper)
chatterbox-pl-score.log             # e2e-audio-intents-datagen.ts output, PL (Chatterbox)
```

## 5. What the results doc (once the job completes) should cover

- A head-to-head table: `lgpixel` (real, `docs/android-datagen-bench.md` §4.1) vs. each synthetic
  engine, same 100 sentences, same `scripts/e2e-audio-intents-datagen.ts` scoring — the
  human-vs-synthetic comparison issue #155 exists to produce.
- Piper vs. Chatterbox on Polish specifically, since that's the actual open question (English's
  engine choice isn't in doubt) — whichever wins here is the one worth carrying forward into any
  future Polish TTS work in this repo, per the requester's own "later we will choose what is
  useful" framing.
- Whether the `display` field's pronunciation hints — expanded-energy 5/50, `LET`/`CSDA`
  letter-spelling, `PMMA` left alone — actually produce audio that resolves correctly on each
  engine, broken out per acronym/rendering, not just one aggregate number. `PMMA`'s "no rendering
  rule" call is the one specifically flagged as unverified in issue #155; this is where that gets
  checked.

## 6. Open risks, not yet verified

- **Chatterbox's real API surface is still being nailed down as of this writing.** An in-progress
  Athena session (see the repo's untracked `setup-venv-chatterbox.md` /
  `chatterbox-api-signature-check.md` scratch notes) hit a `from_pretrained()` signature mismatch
  against a stale README-derived kwarg. `scripts/tts-chatterbox-1000-pl.py` (reused unmodified
  here) already reflects the corrected, `inspect.signature`-confirmed call for the real installed
  `chatterbox-tts` version — this pipeline should not be newly exposed to that specific bug, but
  Chatterbox's behavior on this repo's Athena setup is still less battle-tested than
  Qwen3-TTS/Piper's.
- **Only the desktop `whisper-small`+prompt leg is wired up.** `docs/android-datagen-bench.md`
  §4.1 also reports on-device Parakeet-v3/Whisper/whisper.cpp numbers for the real `lgpixel`
  session, none of which apply to Athena-synthesized audio without a phone in the loop — the
  comparison this pipeline produces is one leg of §4.1's table, not the whole thing.
- **Single-run, no voice-pool statistics.** Each engine assigns voices via the same
  stable-hash-of-id scheme every 1000-sentence batch uses, but n=50 is a fifth of the smallest
  batch this repo has scored before — read per-engine numbers as directional pending a second
  independent run if the comparison ends up mattering for a real decision.

## Related

- #155 — this issue
- #130 — parent issue; #155 is the deferred Part 5
- #149 / #150 — the real `lgpixel` recording session this synthesizes a comparison against
- #106 — Chatterbox Polish TTS pipeline + consent precedent (`docs/tts-chatterbox-pl-clone.md`)
- #79 / #92 — the 1000-sentence TTS engine comparisons this reuses without modification
  (`docs/tts-eval-1000-v3.md`, `docs/tts-eval-1000-pl.md`)
