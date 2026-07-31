# Datagen-set TTS synthesis: Qwen3-TTS (EN) + Piper/Chatterbox (PL) (issue #155)

_Pipeline-only report, 2026-07-30, superseded the same day: the Athena job (job 2845994) completed
within hours of this doc's first commit, so §7 below already has the real head-to-head numbers
this doc originally deferred. §§1–6 are otherwise unchanged from the pipeline-only version._

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

## 5. What the results doc (once the job completes) should cover — answered in §7 below

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

## 7. Results (real Athena run, job 2845994, 2026-07-30)

The Athena job completed the same day as §§1–6 above were written (25 min wall time, `sbatch`
job 2845994) and landed in `eval/results/datagen-tts-2026-07-30/`. Scored with the identical
`scripts/e2e-audio-intents-datagen.ts` harness `docs/android-datagen-bench.md` §4.1/§4.7 uses for
the real `lgpixel` session, so the numbers below sit directly next to that table's methodology —
same desktop `whisper-small` q8 + `DOMAIN_PROMPT` leg, same "corrected" (shipped-corrector) column.

### 7.1 Headline: synthetic vs. real human speech

Audio→intent slot-match, n=50 per cell:

| Engine                        | Lang | raw         | corrected       | mean WER (raw vs. canonical) |
| ----------------------------- | ---- | ----------- | --------------- | ---------------------------- |
| Qwen3-TTS                     | EN   | 74% (37/50) | **84%** (42/50) | 6.9%                         |
| Piper (`pl_PL`, real voices)  | PL   | 16% (8/50)  | 24% (12/50)     | 30.9%                        |
| Chatterbox (native, no clone) | PL   | 12% (6/50)  | 12% (6/50)      | 28.5%                        |
| `lgpixel` real human (§4.7)   | EN   | —           | **84%** (42/50) | —                            |
| `lgpixel` real human (§4.7)   | PL   | —           | **52%** (26/50) | —                            |

**English: synthetic ties real human, exactly.** Qwen3-TTS's corrected 84% (42/50) lands on the
same number as `lgpixel`'s real recording — the strongest evidence yet that Qwen3-TTS audio is
not distinguishable from a real speaker at this pipeline's resolution, for this domain. This
matches the 1000-sentence-batch precedent (`docs/tts-eval-1000-v3.md`'s 84.0% clip-level result)
rather than being a new, surprising number.

**Polish: both synthetic engines land well below the real human floor.** `lgpixel`'s real Polish
recording scores 52% corrected — more than double either synthetic engine's number (24%/12%).
This is consistent with `docs/tts-eval-1000-pl.md`'s own finding that Polish TTS-synthesized audio
underperforms real speech by a wide margin; this 50-sentence domain-specific set reproduces that
gap rather than closing it. `docs/android-datagen-bench.md`'s Part 4 doesn't report a WER number
for `lgpixel`'s real session (slot-match only), so the synthetic WER column above (Piper 30.9%,
Chatterbox 28.5%, both far above Qwen3-TTS's 6.9%) can't be directly compared to a real-human
baseline from this repo — it's reported here for its own sake, not as a synthetic-vs-real delta.

### 7.2 Piper vs. Chatterbox — the actual open question

**Piper wins**, by a clear margin on the headline metric: 24% vs. 12% corrected (2× Chatterbox's
rate), and Piper's raw slot-match (16% vs. 12%) already leads before any corrector help. WER is
close and, unusually, points the other way (Piper 30.9% vs. Chatterbox 28.5%) — a reminder that
WER and slot-match don't always rank engines the same way; slot-match is the metric that matters
here since it's what the matcher actually needs. Inspecting a few raw transcripts side by side on
the same id is suggestive, though not a measured pattern (§7.4): on `dg-13`, Piper keeps the
energy value intact ("...ONRD 250 MeV na nukleon, PMMA?") while losing the `CSDA`/particle
wording, whereas Chatterbox inflates the energy itself ("...o energii 2050 MeV na nukleon w
PMMA?", canonical is 250 MeV) — the kind of error that costs the energy slot outright rather than
just one acronym. Per the requester's own "later we will choose what is useful" framing: **Piper
is the one worth carrying forward** for any future Polish TTS work in this repo, pending a second
independent run to confirm this isn't voice-pool noise (see §7.4).

One notable exception, covered in §7.3: Chatterbox recovers the `PMMA` acronym more often than
Piper does, despite losing on the aggregate metric — the two engines are not uniformly ordered
across every rendering choice.

### 7.3 Does the `display` field's pronunciation hints resolve? (per-acronym breakdown)

Checked by hand against the raw transcripts for every id touching `CSDA`, `LET`, or `PMMA`
(`node` one-liners over the `*-small-q8-prompt.json` records, cross-referenced against
`eval/datagen-sentences.json`'s `quantity`/canonical fields for which ids apply):

- **English `CSDA` (letter-spelled "see-ess-dee-ay", n=3: `dg-01`/`dg-13`/`dg-20`) — 3/3
  recovered.** Every Qwen3-TTS raw transcript came back with the literal token `CSDA`, unchanged.
  The letter-spelling call for English `CSDA` is confirmed working, not just "reasoned."
- **English `LET` (letter-spelled "el-ee-tee", n=7: `dg-43`/`dg-45`..`dg-50`) — a coin flip on
  ASR casing.** 3/7 came back as literal `LET` (all pass); 3/7 came back as lowercase `let`
  (`dg-43`/`dg-46`/`dg-50` — all 3 are in the failures list); 1/7 (`dg-45`) came back as `LED` and
  still passed. This traces to a real, deliberate design tension already documented in
  `src/lib/intent/matcher.test.ts` ("does not mistake the verb 'let' for the LET quantity" —
  lowercase `let` is excluded on purpose, since it collides with the ordinary English verb). The
  letter-spelling produces audio that _sounds_ unambiguous, but Whisper's arbitrary capitalization
  of its own output re-introduces exactly the verb/acronym collision the matcher was built to
  avoid — a failure mode outside this pipeline's or the matcher's control. Worth a follow-up issue
  if `LET` questions matter enough in practice; not fixed here.
- **English `PMMA` (bare acronym, no rendering rule, n=8) — 8/8 recovered, confirms the
  "already unambiguous" call.** Every Qwen3-TTS raw transcript has the literal token `PMMA`.
  Issue #155's flagged-as-unverified assumption for English `PMMA` is now measured, not just
  reasoned.
- **Polish `CSDA` (bare acronym, same as English, n=3) — mostly lost.** Piper: 0/3 recognizable
  (`dg-01`→"zdaprotonu", `dg-13`→"ONRD", `dg-20`→"zdają"). Chatterbox: 1/3 correct (`dg-20`), 1/3
  partially recognizable (`dg-13`→"cyzda"). `eval/RECORDING.datagen.md` §1 deliberately left
  Polish `CSDA` unspelled because "no ambiguity resolved by respelling" — that reasoning is about
  _meaning_ (a bare `CSDA` has no other plausible Polish reading), not about whether a PL TTS
  engine's acoustic rendering of the acronym survives ASR round-trip. This result is a data point
  on the latter, separate question: on this small sample, it usually doesn't, for either engine —
  a real gap the ambiguity-focused design didn't have a way to anticipate. Notably, Polish `LET`
  (n=8, unspelled by the same design logic and flagged there as the one "genuinely two-way
  ambiguous" case) shows the opposite outcome: both engines recover the `stoppingPower` quantity
  on all 8 ids despite Piper's surface transcript rarely containing a clean "LET"/"let" token
  (e.g. `dg-43`→"elety", `dg-47`→"leteczostki") — whatever the PL corrector/matcher path does with
  these tokens tolerates the garbling that defeats `CSDA` recognition. Not traced further here.
- **Polish `PMMA` (bare acronym, n=8) — Chatterbox notably outperforms Piper here.** Chatterbox:
  5/8 correct (`dg-06`/`13`/`26`/`39`/`40`), 1/8 garbled-but-close (`dg-48`→"MA"), 2/8 lost. Piper:
  2/8 correct (`dg-06`/`13`), 3/8 garbled-but-close (`dg-03`→"pMA", `dg-33`→"PMA", `dg-40`→"IPMA"),
  3/8 lost. This is the one place Chatterbox beats Piper outright — the aggregate §7.2 verdict
  doesn't hold uniformly across every acronym.

### 7.4 Caveats

- **Single run, n=50 per cell** — a fifth of the smallest 1000-sentence batch this repo has scored
  before (§6's risk note, now realized as an actual small-sample result, not just a risk). Read
  every number above as directional; a second independent run (different voice-pool seed) would
  be needed before treating the Piper > Chatterbox margin as settled for a real decision.
- **Only the desktop `whisper-small`+prompt leg**, same limitation §6 already flagged — no
  on-device runtime comparison exists for this synthetic audio.
- **The Piper/Chatterbox difference-in-kind observation (§7.2) is a qualitative read of a handful
  of transcripts, not a measured category.** Flagged as impression, not counted data.

## Related

- #155 — this issue
- #130 — parent issue; #155 is the deferred Part 5
- #149 / #150 — the real `lgpixel` recording session this synthesizes a comparison against
- #106 — Chatterbox Polish TTS pipeline + consent precedent (`docs/tts-chatterbox-pl-clone.md`)
- #79 / #92 — the 1000-sentence TTS engine comparisons this reuses without modification
  (`docs/tts-eval-1000-v3.md`, `docs/tts-eval-1000-pl.md`)
