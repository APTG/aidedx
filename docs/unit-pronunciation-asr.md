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

| engine        | GeV            | MeV            | keV            | cm             | mm             | um             |
| ------------- | -------------- | -------------- | -------------- | -------------- | -------------- | -------------- |
| qwen-en       | letter (−0.26) | ? (denom<0.05) | letter (−0.62) | ? (denom<0.05) | EXPANDS (0.68) | EXPANDS (0.70) |
| piper-pl      | EXPANDS (2.77) | EXPANDS (2.20) | letter (−0.22) | EXPANDS (0.96) | EXPANDS (1.73) | letter (−1.52) |
| chatterbox-pl | mixed (0.56)   | letter (0.29)  | letter (0.38)  | letter (−0.42) | letter (−0.01) | letter (−0.05) |

Reading this against the recommendations queued in §7 (original numbering, now resolved):

- **Qwen-EN confirms the split the observation predicted, more precisely than §2's transcript
  count could:** length units (`mm`, `um`) cleanly `EXPANDS` (ratio 0.68–0.70) — matches "8
  centimeter range" already seen in transcripts. Energy units (`keV`, `GeV`) come out **negative**,
  i.e. _shorter_ than even the `letters` ("k e v") sibling — not a mid-point, a third regime: Qwen
  renders `keV`/`GeV` as a compact one-syllable acronym ("kehv"/"jhev"), neither spelling out each
  letter nor expanding to "kilo-electron-volt". `cm` and `MeV` are inconclusive here (`expand` and
  `letters` durations too close to separate, `denom<0.05`) — the abbreviated transcript for `MeV`
  ("The beam energy is 150 MeV") is the same Whisper-normalization blindness as §1, expected.
- **Piper-PL and Chatterbox-PL do not reproduce the clean espeak IPA prediction from §3.** The raw
  `espeak --ipa` dump predicted Piper letter-spells _everything_ including `cm`/`mm`. The measured
  probe instead shows Piper `EXPANDS` for `GeV`/`MeV`/`cm`/`mm` (ratios up to 2.77, i.e. the abbrev
  clip is _longer_ than the fully-expanded sibling) and only `keV`/`um` letter-spelling. Chatterbox
  is closer to the "letter-spells nearly everything" prediction, including `cm` (−0.42) — contrary
  to the original human-speech premise that length units are reliably expanded, at least for this
  Polish TTS voice.
- **Caveat before trusting the Piper/Chatterbox numbers over the espeak prediction:** `n=3` carriers
  per cell, and for several units `letters` duration was _longer_ than `expand` (e.g. Piper GeV:
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
mirrored on Internet Archive, CC BY-NC-SA.** Every clip has a matching _professionally captioned_
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

  | chapter (`MIT8_701F20_<name>_300k`) | mentions | duration | size    |
  | ----------------------------------- | -------- | -------- | ------- |
  | `00-07_Units`                       | 10       | 5:47     | 14.7 MB |
  | `00-08_RelKinematics`               | 7        | 15:20    | 34.9 MB |
  | `08-04_experiments`                 | 6        | 11:11    | 26.5 MB |
  | `07-04_status`                      | 6        | 8:13     | 19.9 MB |
  | `10-04_accelerators`                | 5        | 23:57    | 55.2 MB |
  | `07-03_productiondecay`             | 5        | 5:36     | 14.1 MB |
  | `05-01_hadrons`                     | 5        | 9:27     | 22.4 MB |
  | `10-01_mechanism`                   | 4        | 17:13    | 39.9 MB |
  | `09-02_binding`                     | 4        | 9:31     | 22.7 MB |
  | `07-02_fermions`                    | 4        | 3:42     | 9.7 MB  |
  | `05-04_dis`                         | 3        | 9:52     | 23.5 MB |
  | `01-03_RangeForces`                 | 3        | 5:29     | 13.6 MB |
  | `09-08_fusion`                      | 2        | 9:26     | 22.7 MB |
  | `09-07_fission`                     | 2        | 5:27     | 13.7 MB |
  | `06-03_piondecay`                   | 2        | 7:50     | 19.0 MB |
  | `05-05_alphas`                      | 2        | 6:53     | 16.8 MB |
  | `00-06_Particles`                   | 2        | 14:00    | 32.3 MB |
  | `08-06_scale`                       | 1        | 7:21     | 17.9 MB |
  | `08-03_mixing`                      | 1        | 5:38     | 14.1 MB |
  | `03-05_Divergency`                  | 1        | 6:32     | 16.1 MB |
  | `02-02_flavor`                      | 1        | 6:49     | 16.8 MB |

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

Run on Athena 2026-07-24 (job 2818296 — see "Results" below). Per-language `transformers` CTC
models (`jonatasgrosman/wav2vec2-large-xlsr-53-{english,polish}`) +
`torchaudio.functional.forced_align`/`merge_tokens` — deliberately **not** `whisperx` (drags in
`ctranslate2`, a known cuDNN-version-mismatch source on HPC even when only `align()` is used) and
**not** torchaudio's bundled multilingual `MMS_FA` (expects Romanized input for best results;
irrelevant complexity here since the per-language models already have native alphabets, including
Polish diacritics). Full rationale in `docs/forced-alignment-setup.md`; the one-time `.venv-align`
setup this needs is auto-provisioned by `submit-forced-align.sh` on first run (unlike
`.venv-qwen`/`.venv-chatterbox`, which are deliberately manual — see that script's header comment
for why).

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

| source           | unit | n   | rate_norm_dur (median / mean) |
| ---------------- | ---- | --- | ----------------------------- |
| mit-8.701        | GeV  | 52  | 1.62 / 1.77                   |
| mit-8.701        | MeV  | 25  | 1.10 / 1.22                   |
| mit-8.701        | keV  | 4   | 1.72 / 1.80                   |
| mit-8.701        | eV   | 1   | 0.83                          |
| mit-8.701        | TeV  | 1   | 0.65                          |
| daniel-and-jorge | GeV  | 2   | 3.11 / 3.11                   |
| daniel-and-jorge | MeV  | 4   | 1.54 / 1.67                   |
| daniel-and-jorge | eV   | 5   | 1.00 / 1.14                   |
| radio-naukowe    | TeV  | 1   | 1.08                          |

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
  Watches Women's Sports" — no physics content at all), while the _real_ `MeV` mentions in that
  same episode ("It's half of an MeV, half of a mega electron volt...", "a few MeV, a few million
  electron volts...") sit in different, correctly-captioned parts of the transcript. **Practical
  effect is small** (`daniel-and-jorge` is only 11 of 95 instances, `radio-naukowe` 1 of 95) but it
  means the `daniel-and-jorge`/`radio-naukowe` rows in the table above should be treated as
  low-confidence until someone listens to the actual audio at the given timestamps — the
  `mit-8.701` rows (87 of 95 instances, real `.srt` ground truth) are the trustworthy majority of
  this run.

  **Root cause found and fixed:** `process_podcasts()` handed each whole podcast file to the HF
  ASR pipeline in one call with `chunk_length_s=30, stride_length_s=5` — the "long-form" path that
  splits audio into overlapping chunks and reconciles consecutive chunks' timestamps by matching
  their overlapping token sequences to derive a running offset. A chunk that doesn't overlap
  cleanly with its neighbor (an ad break, unlike the surrounding physics content, is exactly that)
  can desync this offset, after which every later chunk's reported timestamp is shifted from where
  the audio actually is — matching the ad-break-timestamp-pointing-at-real-content pattern above.
  Fixed by transcribing each podcast in fixed, non-overlapping ~28s windows ourselves instead:
  each window is a single native Whisper pass, so `return_timestamps=True` uses Whisper's own
  in-window timestamp tokens directly (no cross-window stitching, so nothing to desync), and the
  window's own start offset — known exactly by construction — is added back. **Confirmed fixed**
  by the 2026-07-28 podcast-only re-run (job 2826271) — see "Results (podcast re-run)" below.

#### Results (podcast re-run, 2026-07-28, job 2826271)

`sbatch scripts/submit-forced-align.sh --only podcasts` re-transcribed just the `daniel-and-jorge`
and `radio-naukowe` lanes with the windowed-transcription fix (MIT alignment untouched, since it
was never affected by this bug). `python3 scripts/forced-align-analyze.py
eval/results/forced-align-2826271` — 15 aligned instances, all `en`/`daniel-and-jorge` (`radio-naukowe`
produced zero: verified directly against its transcript JSONs that none of the four episodes'
Whisper output contains an `eV`/`keV`/`MeV`/`GeV`/`TeV` token at all this run, so this is a real
content difference, not the alignment step silently dropping matches):

| source           | unit | n   | rate_norm_dur (median / mean) |
| ---------------- | ---- | --- | ----------------------------- |
| daniel-and-jorge | GeV  | 6   | 2.90 / 3.07                   |
| daniel-and-jorge | MeV  | 6   | 1.30 / 1.37                   |
| daniel-and-jorge | eV   | 3   | 1.00 / 1.22                   |

**Bug fix confirmed:** the specific instance flagged above — `daniel-and-jorge/neutrino-mass`'s
`MeV` mention at `t≈2125s` — now aligns to `"It's half of an MEV, half of a mega electron volt."`
(the real physics content), not the "Suite 305"/"Portlandia" ad-break text the old long-form
chunking produced. All 6 `MeV` and 3 `eV` instances in this re-run land on physics sentences
(`"10 MeV. We also know that the third"`, `"a few MeV, a few million electron volts"`, `"a proton
is about a billion EV"`, etc.) — no ad-break contamination in this run's context strings.

This re-run is too small (15 instances, one source) to revisit the §6.4 "prosodic emphasis
dominates over a fixed rendering" conclusion, which was drawn from the 87-instance `mit-8.701`
majority (untouched by this bug) — it only confirms the timestamp-desync bug is fixed and the
`daniel-and-jorge` rows can now be trusted, superseding the "low-confidence until re-run" caveat
on the original run's `daniel-and-jorge`/`radio-naukowe` rows above.

## 7. Recommendations

1. ~~Fix the data-validity gap, not the model~~ **Done (2026-07-26).** `scripts/generate-1000-sentences.mjs`
   now renders each keV/MeV/GeV/cm/mm mention as one of several spoken-out variants (abbrev /
   expanded / spaced-out for energy; abbrev / expanded for length — `renderUnitsForSpeech()`)
   instead of always the bare abbreviation. Applied to the TTS-facing text only, **after**
   `checkCandidate()` has already validated the sentence against the real matcher/WASM using the
   abbreviated form — rendering the variance _before_ validation was tried first and silently
   broke multi-energy candidates (the matcher only recognizes "MeV"/"keV"/"GeV" literally, so an
   expanded rendering in a list like "at 700 kiloelectronvolt, 150 MeV, and 200 megaelectronvolt"
   left 2 of 3 stated energies unrecognized while still passing the "at least one energy found"
   incompleteness check). Validating against the abbreviated form matches what actually reaches
   the matcher in the real pipeline anyway, since Whisper normalizes any spoken rendering back to
   the abbreviation before the matcher ever sees a transcript (§1). **First submission failed,
   root-caused, fixed (2026-07-28, job 2826275).** `sbatch scripts/submit-v4.sh` ran only 4s
   (5.8% efficiency, 0.00 GPUh billed), too fast to have reached GPU work — its `.out` log showed
   why: `submit-v4.sh`'s Step 0 ran a second, separate `tts-sentence-check.ts "$SENTENCES_FILE"`
   confirmation pass (inherited unchanged from `submit-v2.sh`/`submit-v3.sh`) that re-validates
   each written record's `text` field directly against the matcher. That pass was a no-op
   confirmation for v2/v3 (where `text` was always the bare abbreviation, identical to what
   `generate-1000-sentences.mjs` had already validated inline), but for v4 `text` is the
   TTS-facing rendering — deliberately including forms like "megaelectronvolt" the matcher can't
   parse (only Whisper normalizes it back, per §1) — so the confirmation pass failed 466/1000
   sentences on legitimate, by-design mismatches and `set -euo pipefail` killed the job before any
   TTS/GPU work. Fixed by dropping that redundant/incompatible pass from `submit-v4.sh`; inline
   validation in `generate-1000-sentences.mjs` (against the abbreviated form, matching what the
   real pipeline's matcher actually receives) is the correct and sufficient check. **Not yet
   re-run** — `sbatch scripts/submit-v4.sh` regenerates the corpus, synthesizes it, transcribes it
   with whisper-small q8, and scores it against v3's baseline
   (`eval/results/tts-1000-v3-*/score-new.json`).
2. ~~Add letter-spelled unit forms to the phonetic corrector~~ **Done (2026-07-26).** Added
   `mev-letter-spelled`/`kev-letter-spelled`/`gev-letter-spelled` regex rules to `EN_RULES` in
   `src/lib/asr/correct/en.ts` — not `LEXICON` as originally proposed: `LEXICON`'s fuzzy pass is
   single-token, edit-distance-capped (max 1 for a token this short), and can't reach "M-E-V" from
   "MeV" (2 hyphen-insertions) or a 3-word "em e v" at all (`applyPhoneticPass` only inspects one
   token right after a number). A regex rule matching `(?:em|m)[\s.,-]*(?:ee|e)[\s.,-]*(?:vee|v)`
   (and the keV/GeV equivalents) after a number closes the confirmed `M-E-V` gap (`rng-0573`, §1)
   and also covers the fully-spelled letter-name form the unit-probe generator uses. Tested in
   `src/lib/asr/correct/correct.test.ts`.
3. ~~Run the §5 probe~~ **Done (§5.1, 2026-07-23/24).** Qwen-EN's split held up (length expands,
   energy compresses even past the letter-spelled baseline); the "Chatterbox looks like Piper"
   guess did not survive contact with the measured ratios — both diverged from the espeak-IPA
   prediction and from each other, with too much duration noise at `n=3` carriers to say more than
   that. If this probe is worth re-running, prioritize more carriers per unit over more engines.
4. **espeak hazards** to note for any Piper-based audio: `µm`→"um" (becomes a hesitation) and
   the offline `espeak --ipa` dump predicting letter-spelling — but §5.1's _measured_ probe found
   Piper actually expanding several units in the synthesized audio, so treat the static IPA dump as
   a hint, not ground truth, and measure before asserting Piper's behavior.
5. ~~Run forced alignment on real lecture/podcast speech~~ **Done (§6.4, 2026-07-24).** The MIT
   lecture data (87 trustworthy instances) shows `GeV`/`MeV` durations clustering near the
   sentence's own typical word length with a long tail driven by sentence position/emphasis, not a
   clean two-cluster split — weaker support for the original binary premise than hoped, though
   duration alone can't fully settle it (would need the actual words spoken, which the caption text
   already collapses per §1). ~~Fix the podcast-lane context-window bug~~ **Fixed (§6.4,
   2026-07-26), not yet re-run** — `sbatch scripts/submit-forced-align.sh --only podcasts`
   re-transcribes just the `daniel-and-jorge`/`radio-naukowe` rows into a fresh results dir; update
   the table above once that's synced back and re-analyzed.
6. ~~Check whether a bigger Whisper actually recognizes the unit correctly on real lecture
   speech, not just synthesized probes~~ **Done (§8, 2026-07-24).** `whisper-large-v3-ONNX__q8` is
   the only pair that gets all 11/11 real-speech unit mentions right, but at ~3x the shipped
   model's latency. The shipped `whisper-small q8` misses one real instance regardless of the
   corrector — not a spelling error the corrector can catch, since the unit token doesn't appear in
   the raw transcript at all. Not recommending a model swap on this evidence alone (§8).

## 8. Full Whisper model-matrix check on real lecture clips

§6.4's forced-alignment read said real speech doesn't show a clean expanded-vs-letter-spelled
split; it didn't say whether Whisper actually _recognizes_ the unit correctly when transcribing
that same real speech, as opposed to the TTS-synthesized clips §5 measured. `eval/audio/lecture-clips-118/`
holds 10 short clips cut directly from the MIT 8.701 lecture audio (not synthesized), covering the
`GeV` mentions in `00-07_Units`, the `MeV` mentions in `09-02_binding`, and the dual `keV`+`MeV`
sentence in `10-01_mechanism` — 11 unit-recognition opportunities total (the dual-unit clip counts
twice). `scripts/submit-lecture-clip-bench.sh` transcribes each clip with every officially-released
Whisper size at both `fp32` and `q8` (14 model/dtype pairs, 140 transcriptions, one job, no GPU
speedup expected — see the script's header). `scripts/lecture-clip-bench-analyze.mjs` then scores
each pair two ways: **raw** (does the untouched transcript contain the expected unit?) and
**corrected** (does it still contain it after `src/lib/asr/correct/core.ts`'s `correctTranscript()`
— the same pass the shipped app runs before the NLU matcher ever sees the text).

### Results (run 2026-07-24, job 2822892)

`node scripts/lecture-clip-bench-analyze.mjs eval/results/lecture-clip-bench-2822892`:

| model/dtype                    | raw   | corrected | avg s/clip | missed after correction                            |
| ------------------------------ | ----- | --------- | ---------- | -------------------------------------------------- |
| whisper-large-v3-ONNX q8       | 11/11 | 11/11     | 7.49       | (none)                                             |
| whisper-large-v3-turbo fp32    | 10/11 | 10/11     | 4.76       | 1 (`09-02-binding` MeV)                            |
| whisper-large-v2-ONNX fp32     | 9/11  | 9/11      | 10.29      | 2 (`09-02-binding` MeV ×2)                         |
| whisper-medium-ONNX fp32       | 9/11  | 9/11      | 4.74       | 2 (`10-01-mechanism` keV+MeV)                      |
| **whisper-small q8 (shipped)** | 9/11  | 9/11      | **2.52**   | 2 (`10-01-mechanism` keV+MeV)                      |
| whisper-large-v3-ONNX fp32     | 8/11  | 8/11      | 8.17       | 3 (`09-02-binding` MeV; `10-01-mechanism` keV+MeV) |
| whisper-medium-ONNX q8         | 8/11  | 8/11      | 4.38       | 3 (same pattern)                                   |
| whisper-small fp32             | 8/11  | 8/11      | 2.70       | 3 (same pattern)                                   |
| whisper-base fp32              | 7/11  | 7/11      | 1.89       | 4 (`00-07-units` GeV ×2; `09-02-binding` MeV ×2)   |
| whisper-large-v2-ONNX q8       | 7/11  | 7/11      | 6.06       | 4 (`09-02-binding` MeV ×2; `10-01-mechanism` ×2)   |
| whisper-large-v3-turbo q8      | 6/11  | 7/11      | 15.58      | 4                                                  |
| whisper-tiny fp32              | 4/11  | 5/11      | 1.07       | 6 (misses most `00-07-units` GeV instances)        |
| whisper-base q8                | 2/11  | 5/11      | 1.86       | 6                                                  |
| whisper-tiny q8                | 1/11  | 2/11      | 2.22       | 9                                                  |

(full per-clip detail: `node scripts/lecture-clip-bench-analyze.mjs eval/results/lecture-clip-bench-2822892`)

- **Only `whisper-large-v3-ONNX q8` gets every instance right, at ~3x the shipped model's
  latency.** 7.49 s/clip vs. the shipped `whisper-small q8`'s 2.52 s/clip — a real cost against
  `docs/voice-pipeline-feasibility.md`'s sub-3-second target, for closing a gap that's 1 clip out
  of 10 on this sample.
- **The shipped `whisper-small q8` misses exactly one real instance, and it's the same one
  medium/large-v2/large-v3(fp32) also miss: `10-01-mechanism`'s dual-unit sentence** ("...in the
  range of some 100 **keV**... to about 10 **MeV**..."), heard as "...and so on." — the model
  drops the unit tokens entirely rather than mis-transcribing them. This is not a spelling error
  the corrector can fix (§4's `LEXICON` approach only rewrites a mis-heard token that's present);
  there is nothing in the raw transcript to correct.
- **The corrector barely moves the needle on real speech.** It only recovers additional hits for
  the weakest tiny/base pairs (e.g. `whisper-base q8` 2/11 raw → 5/11 corrected), where the raw
  transcript still contains a garbled-but-recognizable unit string. For every pair at or above
  `small`, corrected == raw — consistent with the §5.1/§6.4 finding that the model either hears a
  unit token or doesn't; there's no widespread "heard the right token, spelled it wrong" failure
  mode in real lecture speech for these models, unlike the synthesized-audio letter-spelling
  case (§1, `M-E-V`).
- **`fp32` vs `q8` doesn't move accuracy consistently** for small/medium/large-v2 — each dtype pair
  lands within 1 unit of its sibling, and the large accuracy jumps in the table are model-size
  driven (tiny/base failing on `GeV` almost entirely), not quantization-driven. `large-v3-turbo` is
  the outlier: `q8` is both slower (15.58 s vs. 4.76 s) and less accurate (6/11 vs. 10/11 raw) than
  its own `fp32`, worth a second look before trusting turbo-q8 numbers elsewhere in this repo.
- **Not recommending a model swap on this evidence alone.** One clip out of ten, on an 11-instance
  sample, isn't enough to justify 3x latency on every voice query — especially since the miss is a
  complete drop, not a wrong-spelling the corrector could plausibly be extended to catch. Worth
  revisiting if the real-speech sample grows (more MIT chapters, or the podcast sources once
  §6.4's context-window bug is fixed) and the same failure mode keeps showing up.
