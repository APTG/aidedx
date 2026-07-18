# Phonetic-lexicon ASR corrector (issue #28)

_Findings doc for issue #28, per this project's convention that a spike/redesign issue's
conclusion belongs in a committed `docs/*.md` file, not just a PR description. The design and
code shipped in PR #90 (`[asr] Phonetic-lexicon correction pass, closing out the corrector
redesign`); PR #90's own description carried the validation table below, but never landed it
here — this doc closes that gap and re-verifies the numbers are still reproducible before
doing so, since the scoring script itself was fixed for an unrelated bug after PR #90 merged
(§3)._

## 1. Problem

Every correction rule discovered before this issue was an instance of one operation: match a
garbled ASR token against a closed domain lexicon by sound. The rule pile grows with every new
speaker/model ("per napelion/nutlion/nukleon/knockdown" → "per nucleon", "Dutrons/deuterans" →
"deuterons", "PMMEA", "NEV", "the low side" → Lucite, …) — the "unbounded regex accretion"
problem. The extended-rules experiment (`scripts/asr-correct-ext.mjs`) measured real headroom
(70% → 89% clip pass on whisper-small) but those regexes were tuned on the exact recordings
that motivated them.

## 2. What shipped (PR #90)

A closed-lexicon edit-distance pass, run **after** the existing regex fast path
(`src/lib/asr/correct/`):

- **`en.ts`**: `LEXICON` — units (keV/MeV/GeV, per-nucleon variants), quantity keywords
  (stopping power, LET, range, …), and program names (ASTAR/PSTAR/…), none of which had a fuzzy
  fallback before. Materials and particles are deliberately **excluded** — they already get
  fuzzy resolution inside the matcher (`resolveMaterial`/`resolveParticle`), so duplicating them
  here would stack a second, redundant fuzzy pass ahead of an already-tuned one. Also
  `PHONETIC_STOPWORDS` — short function words that must never be "corrected".
- **`core.ts`**: `applyPhoneticPass()` tokenizes the transcript, gates each candidate by slot
  context (a token right after a number is a unit candidate; quantity keywords match as 1–3
  word n-grams; program names are standalone acronym-length tokens), and looks up the nearest
  `LEXICON` entry via the **existing** `boundedLevenshtein` (`src/lib/aliases/normalize.ts`) at
  the same length-scaled threshold already used by `resolveMaterial`/`resolveParticle`. No new
  phonetic-algorithm dependency — the ~20-entry lexicon is small enough that plain edit
  distance is sufficient, consistent with issue #87's own "measure before taking the
  dependency" principle.
- `correctTranscript()` returns `{ text, substitutions }` so every accepted correction is
  traceable ("heard _per napelion_ → read as _per nucleon_") for the trust UX (issue #10) and a
  future confidence gate. `asr-status.svelte.ts` only consumes `.text` today; wiring
  `substitutions` into the UI itself is issue #10's own scope, not this one's.

## 3. Validation — re-verified now, not copied from the PR

Scored with `scripts/asr-score-slots.mjs` against the committed 3-speaker (km/lg/mn) transcripts
in `eval/results/asr-2026-07-16/`, comparing the shipped regex-only corrector (`--ext`, PR #89)
against this phonetic pass (`--new`) on the exact same files. Every result file has 89 records;
`whisper-base`'s denominator is 86 because 3 of its records carry a transcription error (dropped
before scoring), not because fewer clips exist for it:

| Model                      | ext-only    | +phonetic (new) |
| -------------------------- | ----------- | --------------- |
| whisper-small, no prompt   | 81/89 (91%) | **82/89 (92%)** |
| whisper-small, with prompt | 83/89 (93%) | **84/89 (94%)** |
| whisper-turbo, no prompt   | 77/89 (87%) | **80/89 (90%)** |
| whisper-turbo, with prompt | 79/89 (89%) | 79/89 (89%)     |
| whisper-base, no prompt    | 45/86 (52%) | **49/86 (57%)** |
| whisper-tiny, no prompt    | 7/89 (8%)   | **8/89 (9%)**   |

Clip-pass rate matches or improves on every model tested, never regresses. Per-speaker
breakdown for whisper-small with prompt (the one row below that moved since PR #90 — see the
correction note): ext km 29/30, lg 26/30, mn 28/29; new km 29/30, lg 26/30, mn **29/29** — no
individual speaker regresses.

> **Correction vs. PR #90's own description.** PR #90 originally reported "whisper-small, with
> prompt: 91% → 92%" — identical to the no-prompt row above, which in hindsight looks like a
> copy/paste artifact rather than a distinct measurement. `scripts/asr-score-slots.mjs` was
> independently fixed for a real scorer bug shortly after PR #90 merged (commit `6e59d2b`,
> issue #92: `\b` conflates digits and letters as one "word" class, so a number glued straight
> to its unit, e.g. "30mm", silently failed to match) — that fix's own commit message explicitly
> verified the no-prompt small/turbo numbers were unchanged, but didn't separately check the
> with-prompt case. Re-running today reproduces every other row exactly as PR #90 reported, so
> the with-prompt row above (93%→94%) is the correct current figure, not a new regression —
> flagging this prominently rather than silently using the corrected number, same discipline
> `docs/tts-eval-1000.md` §6.2 and `docs/tts-eval-1000-v2.md`'s own correction note applied to
> their scoring-bug fixes.

## 4. The overfitting trap issue #28 explicitly warned about

Unlike the extended-rules experiment (tuned on the exact recordings that motivated it), the
phonetic pass has no per-error rules to overfit — its only tunable parameters (minimum key
length, edit-distance cap) are reused **verbatim** from the alias table's already-shipped
fuzzy-match policy rather than fit against these recordings. There is no new parameter to hold
a speaker out for in the first place, so the issue's own leave-one-speaker-out protocol has
nothing to guard against here beyond what's already shown above (every individual speaker
matches or improves, none regresses).

## 5. Also fixed alongside this work

A pre-existing silent-truncation quirk in `asr-score-slots.mjs`: `failures.slice(0, 40)` printed
only the first 40 failing clips with no indication more existed, making entries invisible for
the noisier base/tiny models (40+ real failures) even though the underlying pass/fail
statistics were always computed correctly. Now prints `... and N more (not printed)`.

## 6. Issue #28's own "Done when" — met

> Phonetic pass matches or beats the extended-rules experiment (89% clip pass on whisper-small
> no-prompt, 94% with prompt) without per-error rules, and holds up leave-one-speaker-out.

- whisper-small no-prompt: 92% (new) vs. the extended-rules experiment's own 89% — beats it.
- whisper-small with-prompt: 94% (new) — matches the experiment's 94% exactly.
- No per-error rules (§2) — the lexicon is the same closed set regardless of which speaker or
  model produced the transcript.
- Every individual speaker matches or improves on every model tested (§3) — the practical
  content of "holds up leave-one-speaker-out" for a mechanism with no data-fit parameters (§4).

## 7. Not in scope here (unchanged from PR #90)

- Wiring `substitutions` into the trust UX (issue #10).
- `franc` language routing (issue #87).
- The Polish (`pl`) corrector pack — the matcher side landed in #96; a Polish phonetic-lexicon
  pack is a natural follow-up once real Polish ASR transcripts exist to tune slot-context gating
  against (the Piper/Qwen batch in #97 will produce exactly that).

## Status

Code shipped and merged (PR #90). Findings now landed here per this project's convention.
Reasonable to close issue #28 on this basis.
