# Unit pronunciation in eval audio vs. ASR transcripts (issue #118)

_Investigation doc for issue #118. Started from an observation about how physics units are read
aloud; the durable conclusion and the follow-up GPU study live here per this repo's convention
(a spike/investigation's findings belong in a committed `docs/*.md`, not just an issue thread —
see `docs/phonetic-corrector.md`, `docs/whisper-model-bench.md`). Status: findings from committed
data are final; the controlled TTS study (§5) is built and ready to run on Athena, not yet run._

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

## 6. Cross-checking against real human speech

The probe measures _TTS engines_. To measure the _human_ distribution the observation is really
about, run Whisper + forced alignment (WhisperX / Montreal-Forced-Aligner) on public physics
lectures (MIT OCW 22.01/8.02, CERN summer-student lectures) and histogram the aligned `MeV`-token
duration: "megaelectronvolt" (~5 syllables, ~0.7 s) vs "em-ee-vee" (~3 short letters, ~0.4 s)
separate cleanly. Wikipedia per-letter recordings (e.g. the `V` clip) are useful for building a
synthetic letter-spelled reference, not for the lecture measurement.

## 7. Recommendations

1. **Fix the data-validity gap, not the model.** For a corpus that spans the _human_ pronunciation
   distribution, control the TTS **input text** (emit `MeV` / `megaelectronvolt` / `mega electron
volt` and `cm` / `centimeters` variants) rather than trusting any one engine's G2P — none of
   the three covers the range. Source: `scripts/generate-1000-sentences.mjs` (`energyPhrase()`
   ~L209, range units ~L635).
2. **Add letter-spelled unit forms to the phonetic corrector** — closes the confirmed `M-E-V` gap
   (§1, §4), low-risk, matches `docs/phonetic-corrector.md`'s design.
3. **Run the §5 probe** to replace the "Chatterbox looks like Piper" guess with a measured ratio,
   and to confirm Qwen-EN expands length but not (necessarily) energy.
4. **espeak hazards** to note for any Piper-based audio: `µm`→"um" (becomes a hesitation) and
   everything letter-spelled — before treating Piper output as "natural".
