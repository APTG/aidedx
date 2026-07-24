# Unit pronunciation in eval audio vs. ASR transcripts (issue #118)

_Investigation doc for issue #118. Started from an observation about how physics units are read
aloud; the durable conclusion and the follow-up GPU study live here per this repo's convention
(a spike/investigation's findings belong in a committed `docs/*.md`, not just an issue thread —
see `docs/phonetic-corrector.md`, `docs/whisper-model-bench.md`). Status: both GPU studies (§5 the
controlled TTS probe, §6.4 forced alignment on real speech) have now run on Athena and results are
analyzed below; see §5.1 and §6.4 "Results" for the numbers._

## 0. The original observation

Units are read aloud differently by humans (Polish + English):

- **Length units** (`cm`, `mm`, `um`) are usually **expanded** — "centimeter", "millimeter",
  "micrometer".
- **Energy units** (`keV`, `MeV`, `GeV`) vary: sometimes expanded ("mega-electron-volt"),
  sometimes letter-spelled (/ˈɛm ˈiː ˈviː/, /ˈkeɪ ˈiː ˈviː/).
- **Stopping-power units** (`keV/mm`): the energy part varies, the length part (`mm`) is almost
  always "millimeters".

Questions: is this visible in our generated audio + transcripts; can we exploit it to guide
Whisper; and how would we check it against real speech.

## 1. The transcript cannot measure energy-unit pronunciation — Whisper normalizes it

Across every English transcript in `eval/results/whisper-bench-2805165/en-v3__*.json`, spelled-out
energy (`electronvolt`) = **0** and letter-spelled (`M-E-V`) = **0** on the good models; energy
always surfaces as the abbreviation `MeV`/`keV`/`GeV`. Whisper's decoder — reinforced by the
`DOMAIN_PROMPT` listing `MeV, keV, GeV` — collapses both "megaelectronvolt" and "em-ee-vee"
pronunciations to the string `MeV`. **The transcript is blind to how the energy unit was spoken.**

The only leaks: `M-E-V` appears **1×** each in `whisper-base__q8` and `whisper-tiny__fp32` — weak
decoders that failed to normalize, proving _some_ clips were letter-spelled by the TTS, but giving
no ratio. The phonetic corrector does **not** fix these (verified: `rng-0573` stays
`"100 M-E-V per nucleon…"`, `unit` slot missed).

## 2. Length units surface expanded, but model-dependently

Per-1000-clip counts from the `raw` transcripts:

| model / dataset      | `centimeter` spelled | `cm` abbrev |
| -------------------- | -------------------- | ----------- |
| EN small q8          | 178                  | 9           |
| EN large-v2 q8       | 61                   | 58          |
| PL piper large-v2 q8 | 0                    | 96          |

"centimeter" can only come from expanded audio, so the TTS _did_ speak it expanded — but whether
Whisper writes `centimeter` vs `cm` swings with model size and language on essentially the same
audio. So the transcript confirms length is spoken expanded (by the neural English engine) but is
a lossy, model-dependent instrument even there.

## 3. Decisive: the TTS engines disagree with each other and with humans

Piper's phonemizer is **espeak-ng** (installed on the dev box). `espeak -q --ipa -v en`:

```
500 keV -> … kˈiː vˈiː            "kee vee"      (letters K V; drops the e)
150 MeV -> … mˌiː vˈiː            "em vee"
1 GeV   -> … dʒˈiː vˈiː           "jee vee"
10 cm   -> tˈɛn sˌiːˈɛm           "ten SEE-EM"   ← letters, NOT "centimeter"
5 mm    -> fˈaɪv ˌɛmˈɛm           "five EM-EM"   ← letters, NOT "millimeter"
20 um   -> twˈɛnti ˈʌm            "twenty UM"    ← reads µm as the filler word "um" (!)
keV/mm  -> kˈiː vˈiː slˈaʃ ˌɛmˈɛm "kee vee slash em em"
```

espeak/Piper **letter-spells everything, including `cm`/`mm`** — it flatly contradicts the
"humans say centimeter" premise for that engine. It only expands when fed the spelled-out word
(`centimeter -> sˈɛntɪmˌiːtə`, `megaelectronvolt -> mˈɛɡəɹˌɛlɪktɹˌɒnvəʊlt`).

The **English eval set is Qwen3-TTS** (neural): its transcripts contain "8 centimeter range",
"6 centimeter range" — Qwen _does_ expand `cm`→"centimeter" (human-like). **Chatterbox Polish**
(`pl-chat-*`) looks like Piper: energy collapsed by Whisper, length mostly `cm`/`mm` with only
~20–25 `centymetr` expansions per 1000 — but its transcripts are too noisy (Chatterbox PL scored
only 18–25%, `docs/whisper-model-bench.md` §9.3/§10) to read pronunciation off reliably.

Dataset → engine map: `en-v3`=Qwen3-TTS, `pl-piper`=Piper (espeak), `pl-qwen`=Qwen,
`pl-chat-*`=Chatterbox.

**Reframe (the key finding).** Unit pronunciation in the eval audio is a **G2P artifact of the
specific TTS**, not a sample of human speech. Qwen ≈ human for length; Piper/espeak ≠ human for
anything; Chatterbox is closer to Piper. The corpus does not faithfully represent the human
pronunciation distribution the observation is about — so it can neither confirm nor refute it.

## 4. Can we "tell Whisper to expect a pronunciation"? — No, not with Whisper

Whisper's prompt (`DOMAIN_PROMPT`, injected via `<|startofprev|>` in
`scripts/asr-transcribe-manifest.mjs:169-177`, mirrored in `src/lib/asr/transcribe.ts:89`) is a
**text** prior over _output_ tokens — a spelling/vocabulary bias, **not** an acoustic or
pronunciation lexicon. There is no interface to map a pronunciation to a token; Whisper is
end-to-end seq2seq with no phoneme lexicon. It already does the useful half of the idea: it is
_why_ energy never comes out as "electronvolt". Genuine pronunciation control needs a
lexicon-based stack (wav2vec2 + KenLM + lexicon), which is a different pipeline and not worth it
for a ~20-term vocabulary. The real, cheap lever is the **post-ASR corrector**: add letter-spelled
forms (`m e v`, `em ee vee`, `kay ee vee`, `k e v`, `g e v`) to `LEXICON` in
`src/lib/asr/correct/en.ts` to catch the `M-E-V` escapes §1 found.

## 5. Controlled study to actually measure it (built here, GPU, run on Athena)

Since the transcript can't measure energy-unit pronunciation, measure it **acoustically** with a
minimal-pair design — this is what the new scripts do:

- **`scripts/generate-unit-probe.py`** — emits controlled probe sentences where the carrier and
  value are fixed and only the unit rendering varies: `abbrev` "150 MeV", `expand`
  "150 megaelectronvolt", `spaced` "150 mega electron volt", `letters` "150 em e v" (EN + PL,
  126 sentences).
- **`scripts/submit-unit-probe.sh`** — SLURM array, one lane per engine (Qwen-EN, Piper-PL,
  Chatterbox-PL). Synthesizes the probe set, copies each engine's `manifest.json` (per-clip
  `dur_s`) into `eval/results/unit-probe-<job>/`, and transcribes with whisper-small/q8 both
  un-prompted (best chance for letter-spell escapes) and prompted.
- **`scripts/unit-probe-analyze.py`** — runs **locally** after sync (no GPU). For each engine and
  unit, compares the `abbrev` clip duration against its `expand` and `letters` siblings:
  `r = (dur_abbrev − dur_letters) / (dur_expand − dur_letters)` — `r≈0` ⇒ the engine letter-spells
  the abbreviation, `r≈1` ⇒ it expands it. Needs no forced alignment.

Run: `sbatch scripts/submit-unit-probe.sh`, then
`rsync` the results dir back and `python3 scripts/unit-probe-analyze.py eval/results/unit-probe-<job>`.

Refinements deferred: forced-aligned per-token duration (faster-whisper `word_timestamps`) for a
sharper measurement than whole-clip duration; a fixed single voice per engine to cut prosody
variance; adding Qwen-PL and Chatterbox-clone lanes.

### 5.1 Results (run 2026-07-23/24, jobs 2818050 + 2818365)

`python3 scripts/unit-probe-analyze.py eval/results/unit-probe-2818365` — 3 engines × 6 units × 3
carrier sentences (`n=3` per cell, so read exact ratios as directional, not precise):

| engine         | GeV           | MeV           | keV           | cm            | mm        | um        |
| -------------- | ------------- | ------------- | ------------- | ------------- | --------- | --------- |
| qwen-en        | letter (−0.26) | ? (denom<0.05) | letter (−0.62) | ? (denom<0.05) | EXPANDS (0.68) | EXPANDS (0.70) |
| piper-pl       | EXPANDS (2.77) | EXPANDS (2.20) | letter (−0.22) | EXPANDS (0.96) | EXPANDS (1.73) | letter (−1.52) |
| chatterbox-pl  | mixed (0.56)  | letter (0.29) | letter (0.38) | letter (−0.42) | letter (−0.01) | letter (−0.05) |

Reading this against the recommendations queued in §7 (original numbering, now resolved):

- **Qwen-EN confirms the split the observation predicted, more precisely than §2's transcript
  count could:** length units (`mm`, `um`) cleanly `EXPANDS` (ratio 0.68–0.70) — matches "8
  centimeter range" already seen in transcripts. Energy units (`keV`, `GeV`) come out **negative**,
  i.e. *shorter* than even the `letters` ("k e v") sibling — not a mid-point, a third regime: Qwen
  renders `keV`/`GeV` as a compact one-syllable acronym ("kehv"/"jhev"), neither spelling out each
  letter nor expanding to "kilo-electron-volt". `cm` and `MeV` are inconclusive here (`expand` and
  `letters` durations too close to separate, `denom<0.05`) — the abbreviated transcript for `MeV`
  ("The beam energy is 150 MeV") is the same Whisper-normalization blindness as §1, expected.
- **Piper-PL and Chatterbox-PL do not reproduce the clean espeak IPA prediction from §3.** The raw
  `espeak --ipa` dump predicted Piper letter-spells *everything* including `cm`/`mm`. The measured
  probe instead shows Piper `EXPANDS` for `GeV`/`MeV`/`cm`/`mm` (ratios up to 2.77, i.e. the abbrev
  clip is *longer* than the fully-expanded sibling) and only `keV`/`um` letter-spelling. Chatterbox
  is closer to the "letter-spells nearly everything" prediction, including `cm` (−0.42) — contrary
  to the original human-speech premise that length units are reliably expanded, at least for this
  Polish TTS voice.
- **Caveat before trusting the Piper/Chatterbox numbers over the espeak prediction:** `n=3` carriers
  per cell, and for several units `letters` duration was *longer* than `expand` (e.g. Piper GeV:
  expand=2.72s, letters=3.09s) — the assumption the `r` formula depends on (expand ≥ letters) breaks
  down for these two engines, so ratios past ~1 or below 0 are more a symptom of noisy, low-`n`
  clip-duration variance (voice prosody, PL TTS mangling English letter names/words — see the
  garbled `abbrev_transcript` lines, e.g. Piper's `um` abbrev heard as a 200-token run of "11") than
  a clean signal. Treat the Qwen-EN numbers as the reliable read from this run; Piper/Chatterbox
  would need more carriers (and per-token forced alignment, per the deferred refinement above) to
  say anything with confidence beyond "not the same as Qwen."

## 6. Cross-checking against real human speech

The probe measures _TTS engines_. To measure the _human_ distribution the observation is really
about, run Whisper + forced alignment (WhisperX / Montreal-Forced-Aligner) on public physics
lectures and histogram the aligned `MeV`-token duration: "megaelectronvolt" (~5 syllables, ~0.7 s)
vs "em-ee-vee" (~3 short letters, ~0.4 s) separate cleanly. Wikipedia per-letter recordings (e.g.
the `V` clip) are useful for building a synthetic letter-spelled reference, not for the lecture
measurement.

### 6.1 Resources found (verified 2026-07-23, not downloaded — URLs + counts only)

**Primary: MIT 8.701 "Introduction to Nuclear and Particle Physics" (Fall 2020, Markus Klute),
mirrored on Internet Archive, CC BY-NC-SA.** Every clip has a matching *professionally captioned*
(not auto-generated) `.srt` — this is better than a bare lecture recording because the reference
transcript is known, so alignment is true forced alignment (known text → audio), not ASR-then-align.
The caption text still collapses to the abbreviation (`MeV`/`GeV`) regardless of how it was spoken
— same blindness as our own Whisper transcripts (§1) — so the classification still has to come from
aligned-segment duration, not the caption text itself.

- Item: `https://archive.org/details/MIT8.701F20`
- Machine-readable file manifest (JSON, one `curl`, gives every filename/size/duration for all 474
  files without touching any media): `curl -s https://archive.org/metadata/MIT8.701F20`
- Download pattern per chapter: `https://archive.org/download/MIT8.701F20/<name>.mp4` and the same
  path with `.srt` for the caption.
- Grepped all 67 chapter `.srt` files (text only, ~KB each) for `keV`/`MeV`/`GeV`; **21 of 67
  chapters** mention at least one, 76 mentions total, ranked by density:

  | chapter (`MIT8_701F20_<name>_300k`) | mentions | duration | size |
  | --- | --- | --- | --- |
  | `00-07_Units` | 10 | 5:47 | 14.7 MB |
  | `00-08_RelKinematics` | 7 | 15:20 | 34.9 MB |
  | `08-04_experiments` | 6 | 11:11 | 26.5 MB |
  | `07-04_status` | 6 | 8:13 | 19.9 MB |
  | `10-04_accelerators` | 5 | 23:57 | 55.2 MB |
  | `07-03_productiondecay` | 5 | 5:36 | 14.1 MB |
  | `05-01_hadrons` | 5 | 9:27 | 22.4 MB |
  | `10-01_mechanism` | 4 | 17:13 | 39.9 MB |
  | `09-02_binding` | 4 | 9:31 | 22.7 MB |
  | `07-02_fermions` | 4 | 3:42 | 9.7 MB |
  | `05-04_dis` | 3 | 9:52 | 23.5 MB |
  | `01-03_RangeForces` | 3 | 5:29 | 13.6 MB |
  | `09-08_fusion` | 2 | 9:26 | 22.7 MB |
  | `09-07_fission` | 2 | 5:27 | 13.7 MB |
  | `06-03_piondecay` | 2 | 7:50 | 19.0 MB |
  | `05-05_alphas` | 2 | 6:53 | 16.8 MB |
  | `00-06_Particles` | 2 | 14:00 | 32.3 MB |
  | `08-06_scale` | 1 | 7:21 | 17.9 MB |
  | `08-03_mixing` | 1 | 5:38 | 14.1 MB |
  | `03-05_Divergency` | 1 | 6:32 | 16.1 MB |
  | `02-02_flavor` | 1 | 6:49 | 16.8 MB |

  Total for all 21: ~467 MB. `00-07_Units` is the anchor clip — the lecture is literally "the unit
  on units"; the professor reads `GeV` out loud repeatedly ("kilogram, meters, and GeV… 0.197 GeV
  femtometers"). `09-02_binding` / `09-07_fission` / `09-08_fusion` are nuclear-physics chapters
  (same energy regime as this project's dE/dx domain) with natural `MeV`-per-nucleon phrasing
  ("contributes with about 16 MeV per nucleon").
- Verified downloadable with a plain `curl -I` (HTTP 302 → direct `archive.org` CDN mp4, no auth,
  `Accept-Ranges: bytes` so `wget -c`/resume works) — good fit for an Athena `wget` job.
- License note: CC BY-NC-SA — fine for internal research/ASR evaluation, not for redistribution.

**Secondary (podcast, spontaneous/conversational, no ground-truth transcript — would need Whisper's
own transcript + forced-align, same self-referential limitation as the TTS probe): "Daniel and
Jorge Explain the Universe"**, hosted by Daniel Whiteson, an actual ATLAS/LHC particle physicist —
so `GeV`/`MeV` come up in genuine unscripted collider talk, not just as a topic.

- RSS feed (direct, no auth):
  `https://www.omnycontent.com/d/playlist/e73c998e-6e60-432f-8610-ae210140c5b1/f5d5fac6-77be-47e6-9aee-ae32006cd8c3/b26cbbeb-86eb-4b97-9b34-ae32006cd8d6/podcast.rss`
- Each `<enclosure url="...">` is a `podtrac.com` redirect to a direct `traffic.omny.fm/.../audio.mp3`
  — verified with `curl -I` (`curl -L` follows the 302 fine).
- 4 episodes hand-picked from the feed by title (grepped for "LHC"/"Higgs"/"quark"/"neutrino"/
  "antimatter" — near-certain `GeV`/`MeV` content, e.g. the Higgs mass, ~125 GeV, is a stock number
  in that episode): **"How do we measure the Higgs boson mass?"**, **"Are there charm quarks in the
  proton?"**, **"How massive is a neutrino?"**, **"Can antimatter help us find dark matter?"** — see
  `scripts/submit-fetch-lecture-corpus.sh` for the exact per-episode URLs.

**Tertiary / fallback (general physics podcast, lower and unpredictable density of energy-unit
mentions — interviews cover all of physics, not just particle physics): Physics World Weekly.**

- RSS: `https://physicsworld.com/feed/podcast-weekly` → `<enclosure>` redirects (via `blubrry.com`,
  verified `curl -I`) to direct mp3s. Not wired into the fetch script — useful only as a volume
  top-up if the sources above turn out insufficient.

**Considered and set aside:**

- _CERN Summer Student Lecture Programme_ — exactly on-topic content (LEP/LHC/neutrino physics is
  saturated with `MeV`/`GeV`), but `repository.cern` record pages (e.g.
  `https://repository.cern/records/av36y-gf879`) only link out to old CERN agenda/webcast pages, not
  direct file URLs, and `videos.cern.ch` (CDS Videos) looks like a streaming player with no confirmed
  direct-download URL pattern from a quick pass. Worth a second look if the MIT set proves
  insufficient, but it is not a clean `wget`-able collection the way the archive.org mirror is.
- _Perimeter Institute (PIRSA)_ — public lectures with per-talk MP3 audio, but needs per-talk-page
  scraping to find file URLs; no archive.org-style bulk JSON manifest found. Deprioritized versus
  the one-`curl` MIT manifest.

### 6.2 Polish-language resources (verified 2026-07-23)

No Polish equivalent of the MIT captioned-lecture set turned up: CERN's Polish outreach, IFJ PAN's
own open seminars, NCBJ's popular lectures, and Wszechnica.org.pl ("ogólnodostępna baza wykładów")
all exist but publish through YouTube/embedded streaming players, not a bulk-downloadable direct-file
host — none has an archive.org-style mirror. So the Polish side of this corpus is podcast-only, same
tier as the English secondary source (no ground-truth transcript, self-referential alignment).

**Radio Naukowe** — Poland's most popular science-interview podcast (host: Karolina Głowacka),
self-hosted via Spreaker.

- RSS feed: `https://www.spreaker.com/show/4638772/episodes/feed` — `<enclosure>` is a
  `dts.podtrac.com` redirect to a direct `api.spreaker.com/download/episode/...mp3` (verified
  `curl -I`). The site's own per-episode "Pobierz" (Download) link
  (`radionaukowe.pl/podcast/<slug>/pobierz/`) also resolves directly (verified `200 OK` +
  `Content-Disposition: attachment`) as a second, independent path to the same file if the RSS
  redirect chain ever breaks.
- 4 episodes hand-picked by title/topic for expected `keV`/`MeV`/`GeV` density: **#289 "Ciemna
  materia i neutrina"** and **#104 "Ciemna materia"** (dark-matter candidate masses are routinely
  quoted keV–GeV, same physicist guest in both, ~13 years apart — also a rare within-source
  same-speaker comparison), **#183 "Energia fuzji"** (fusion — D-T fusion releases a textbook
  17.6 MeV), **#87 "Promieniowanie Czerenkowa"** (Cherenkov radiation / the CTA observatory, whose
  native unit is GeV–TeV gamma-ray energy). Episodes run long (~1–2 h full interviews, 110–170 MB
  each) — exact URLs in `scripts/submit-fetch-lecture-corpus.sh`.

### 6.3 Fetched by `scripts/submit-fetch-lecture-corpus.sh` (run 2026-07-23)

That script `wget`s the full set above — 21 MIT chapters (mp4+srt) + 4 Daniel-and-Jorge + 4 Radio
Naukowe episodes — onto `eval/lecture-corpus/{en,pl}/<source>/` (gitignored) and writes a
`MANIFEST.tsv` alongside them. Ran clean on Athena: 50/50 files, 0 failures, ~1.1 GB total.

### 6.4 Forced alignment (`scripts/forced-align-corpus.py`, `scripts/submit-forced-align.sh`)

Built, not yet run. Per-language `transformers` CTC models
(`jonatasgrosman/wav2vec2-large-xlsr-53-{english,polish}`) +
`torchaudio.functional.forced_align`/`merge_tokens` — deliberately **not** `whisperx` (drags in
`ctranslate2`, a known cuDNN-version-mismatch source on HPC even when only `align()` is used) and
**not** torchaudio's bundled multilingual `MMS_FA` (expects Romanized input for best results;
irrelevant complexity here since the per-language models already have native alphabets, including
Polish diacritics). Full rationale in `docs/forced-alignment-setup.md` (one-time `.venv-align`
setup this needs — CUDA-specific, not auto-provisioned by the submit script, same pattern as
`.venv-qwen`/`.venv-chatterbox`).

Method, per segment (an MIT `.srt` cue with **known** text, or a Whisper-transcribed chunk for the
two podcasts, which have none): normalize the text (lowercase, spell out digits with `num2words`
— CTC vocabularies are letters-only, so a bare `150` breaks alignment for that whole segment),
tokenize word-by-word against the CTC processor's vocab (word boundaries known by construction,
not inferred), forced-align against the (padded) audio slice, regroup token spans into word spans.
Any `eV`/`keV`/`MeV`/`GeV`/`TeV` word gets its aligned `[start, end]` recorded, plus that
segment's median word duration as a local speaking-rate baseline — real speech has no fixed rate
the way TTS does, so `dur / local_median_word_dur` is the comparable quantity across
speakers/segments, not raw seconds.

```sh
sbatch scripts/submit-forced-align.sh
# after it finishes (or to sanity-check a handful of files before committing a full ~6h run):
#   python3 scripts/forced-align-corpus.py eval/results/forced-align-manual --limit 2
# then, after rsync-ing eval/results/forced-align-<job>/ back:
python3 scripts/forced-align-analyze.py eval/results/forced-align-<job>
```

`forced-align-analyze.py` runs locally (no GPU/torch) and reports the rate-normalized-duration
distribution per `(lang, source, unit)`, plus the most extreme instances with sentence context —
there's no TTS-style minimal pair here to compute a clean `r` ratio from (§5's), so this is a
human-eyeballed read of the distribution (low ratio ~ quick/letter-spelled-like, high ratio ~
slow/expanded-like), not an auto-classifier, with the option to go listen to specific
`eval/lecture-corpus/<lang>/<source>/<file>.*` timestamps directly for the ones that matter.

#### Results (run 2026-07-24, job 2818296)

`python3 scripts/forced-align-analyze.py eval/results/forced-align-2818296` — 95 aligned
`eV`/`keV`/`MeV`/`GeV`/`TeV` instances across 9 `(lang, source, unit)` groups. Almost all volume is
the MIT captioned lectures (ground-truth text, real forced alignment):

| source                    | unit | n   | rate_norm_dur (median / mean) |
| ------------------------- | ---- | --- | ------------------------------ |
| mit-8.701                 | GeV  | 52  | 1.62 / 1.77                    |
| mit-8.701                 | MeV  | 25  | 1.10 / 1.22                    |
| mit-8.701                 | keV  | 4   | 1.72 / 1.80                    |
| mit-8.701                 | eV   | 1   | 0.83                            |
| mit-8.701                 | TeV  | 1   | 0.65                            |
| daniel-and-jorge          | GeV  | 2   | 3.11 / 3.11                    |
| daniel-and-jorge          | MeV  | 4   | 1.54 / 1.67                    |
| daniel-and-jorge          | eV   | 5   | 1.00 / 1.14                    |
| radio-naukowe             | TeV  | 1   | 1.08                            |

- **The professor's `GeV`/`MeV` durations sit close to the sentence's own median word length, with
  a long right tail, not a clean bimodal split.** Median rate ~1.1–1.6, i.e. "typical" word length
  or a bit above — most instances are neither obviously letter-spelled-fast (rate ≪1) nor
  obviously fully-expanded-slow (rate ≫2). Extremes exist both ways within `mit-8.701/GeV` alone:
  0.80 ("Mass is going to 1 GeV **and** mass is going to 10 GeV" — said quickly, back-to-back) up to
  5.72 ("in the order of 100 GeV" — said slowly, standalone emphasis). This reads as **prosodic
  emphasis/position in the sentence dominating over a fixed "this is how I say GeV" rendering** —
  weaker support for a clean expanded-vs-letter-spelled dichotomy in real lecture speech than the
  original observation assumed, at least from duration alone (a transcription of what was actually
  said, not just its duration, would be needed to confirm — out of scope here since these are
  Whisper/caption text already collapsed per §1's blindness).
- **Data-quality finding: the podcast lane's printed "context" can be from the wrong part of the
  audio.** Spot-checking `daniel-and-jorge/neutrino-mass`'s `eV`/`MeV` instances at
  `t≈2125–2212s` against the source JSON (`eval/results/forced-align-2818296/full/daniel-and-jorge-neutrino-mass.json`)
  shows the printed context is an unrelated podcast-ad break ("Suite 305", "Portlandia", "Everyone
  Watches Women's Sports" — no physics content at all), while the *real* `MeV` mentions in that
  same episode ("It's half of an MeV, half of a mega electron volt...", "a few MeV, a few million
  electron volts...") sit in different, correctly-captioned parts of the transcript. Root cause not
  chased down (likely a segment-boundary/offset issue specific to how `forced-align-corpus.py`
  windows context for Whisper-transcribed — as opposed to `.srt`-captioned — sources, since spot
  checks of `mit-8.701` context strings above are all correct, short, and on-topic). **Practical
  effect is small** (`daniel-and-jorge` is only 11 of 95 instances, `radio-naukowe` 1 of 95) but it
  means the `daniel-and-jorge`/`radio-naukowe` rows in the table above should be treated as
  low-confidence until someone listens to the actual audio at the given timestamps — the
  `mit-8.701` rows (87 of 95 instances, real `.srt` ground truth) are the trustworthy majority of
  this run.

## 7. Recommendations

1. **Fix the data-validity gap, not the model.** For a corpus that spans the _human_ pronunciation
   distribution, control the TTS **input text** (emit `MeV` / `megaelectronvolt` / `mega electron
volt` and `cm` / `centimeters` variants) rather than trusting any one engine's G2P — none of
   the three covers the range. Source: `scripts/generate-1000-sentences.mjs` (`energyPhrase()`
   ~L209, range units ~L635).
2. **Add letter-spelled unit forms to the phonetic corrector** — closes the confirmed `M-E-V` gap
   (§1, §4), low-risk, matches `docs/phonetic-corrector.md`'s design.
3. ~~Run the §5 probe~~ **Done (§5.1, 2026-07-23/24).** Qwen-EN's split held up (length expands,
   energy compresses even past the letter-spelled baseline); the "Chatterbox looks like Piper"
   guess did not survive contact with the measured ratios — both diverged from the espeak-IPA
   prediction and from each other, with too much duration noise at `n=3` carriers to say more than
   that. If this probe is worth re-running, prioritize more carriers per unit over more engines.
4. **espeak hazards** to note for any Piper-based audio: `µm`→"um" (becomes a hesitation) and
   the offline `espeak --ipa` dump predicting letter-spelling — but §5.1's *measured* probe found
   Piper actually expanding several units in the synthesized audio, so treat the static IPA dump as
   a hint, not ground truth, and measure before asserting Piper's behavior.
5. ~~Run forced alignment on real lecture/podcast speech~~ **Done (§6.4, 2026-07-24).** The MIT
   lecture data (87 trustworthy instances) shows `GeV`/`MeV` durations clustering near the
   sentence's own typical word length with a long tail driven by sentence position/emphasis, not a
   clean two-cluster split — weaker support for the original binary premise than hoped, though
   duration alone can't fully settle it (would need the actual words spoken, which the caption text
   already collapses per §1). Fix the podcast-lane context-window bug (§6.4) before trusting or
   expanding the `daniel-and-jorge`/`radio-naukowe` rows.
