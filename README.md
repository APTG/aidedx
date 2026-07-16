# aidedx

**Ask a physics question in plain language, get a real answer — computed entirely on your own
machine. Nothing you type or say ever leaves your device.**

aidedx is a friendly, conversational front-end to [**libdedx**](https://github.com/APTG/libdedx),
the stopping-power and range library behind [dedx_web](https://github.com/APTG/dedx_web). Instead of
filling in a form, you just ask:

> 🎤 _"What is the range of 40 MeV protons in PMMA?"_
>
> → _"The CSDA range of a 40 MeV proton in PMMA is 1.42 g/cm², about 12 mm."_

The existing dedx_web tool is precise but form-driven. aidedx lowers the barrier for the quick
"what's the range of X in Y?" questions that researchers, clinicians, and students ask all day — and
it does it **without a server**. There is no backend to run, no account to create, and no data to
leak: the artificial intelligence that understands your question runs inside your browser tab.

## Why "on your machine" matters

Most AI tools send your words to a company's servers. aidedx does the opposite. The speech
recognition and language understanding models run **locally, in your browser**, so:

- **Privacy is built in.** Clinical and research questions never touch the network. This is a real
  feature, not a footnote.
- **There's nothing to pay for or operate.** The whole app is a static website — it can live on
  GitHub Pages or a university server with no running costs.
- **The physics is never guessed.** The AI's only job is to _understand_ your question and turn it
  into a precise query. Every actual number comes from libdedx — never invented by the language
  model.

|                       | **Cloud AI (typical)**        | **aidedx (local)**           |
| --------------------- | ----------------------------- | ---------------------------- |
| Where inference runs  | Company servers               | Your browser tab             |
| Your data             | Uploaded, may be logged       | Never leaves the device      |
| Cost / infrastructure | Metered API, a backend to run | A static file, free to host  |
| Works offline         | No                            | Yes, once weights are cached |
| First-use setup       | None                          | One-time model download      |

The trade-off is the last row: local AI has to fetch its "brain" the first time you use it.

## How it works — two phases

**Phase 1 — Download the models (once).** The first time you use aidedx, it asks permission to
download the AI model weights (a few hundred MB). This happens with an explicit consent dialog and a
visible progress panel. The weights are then cached in your browser, so this only happens once.

**Phase 2 — Run everything locally (every time after).** With the models cached, your question flows
through a fully-local pipeline. No network needed.

```
  ┌─────────────────────────── PHASE 1: first visit only ───────────────────────────┐
  │  Consent dialog  →  download model weights  →  cache in browser (hundreds of MB) │
  └─────────────────────────────────────────────────────────────────────────────────┘
                                        │
                                        ▼
  ┌───────────────────────── PHASE 2: every question, fully local ──────────────────┐
  │                                                                                  │
  │   🎤 speak  or  ⌨ type                                                            │
  │        │                                                                         │
  │        ▼                                                                         │
  │   Speech → text        Whisper, running in your browser                          │
  │        │                                                                         │
  │        ▼                                                                         │
  │   Understand the       A fast rule-based reader for common phrasings,            │
  │   question             with a small local language model as backup              │
  │        │               for unusual wording                                       │
  │        ▼                                                                         │
  │   Compute the answer   libdedx (WebAssembly) — the real physics                  │
  │        │                                                                         │
  │        ▼                                                                         │
  │   Explain it back      A plain-language answer, with every assumption            │
  │                        (isotope, energy interpretation) shown and editable       │
  └──────────────────────────────────────────────────────────────────────────────────┘
```

### The tools behind it, and how it keeps itself honest

- **Speech recognition:** [Whisper](https://github.com/openai/whisper), running in-browser via
  [transformers.js](https://github.com/huggingface/transformers.js) on WebGPU (or CPU where WebGPU
  isn't available).
- **Understanding your words:** a two-tier reader. A **deterministic matcher** handles the common,
  clearly-worded questions instantly; a **small local language model** steps in only for indirect or
  unusual phrasings, and is constrained to emit a strict, checkable structure rather than free prose.
- **Self-correction:** the pipeline is designed to catch its own mistakes rather than pass them on.
  Speech recognition uses a retry-and-repair guard for the rare garbled transcript; the language
  model's output is validated against a fixed schema and re-derived if it doesn't fit; and because
  the AI only ever _fills in a query_, a wrong guess shows up as an editable chip you can fix — it
  can never corrupt the physics.
- **The physics:** [**libdedx**](https://github.com/APTG/libdedx), compiled to WebAssembly and
  called directly. Every number is libdedx's, computed on your machine.

## Project status

aidedx is an **early-stage prototype under active development**. Honestly, here is where things
stand:

- ✅ **Works today:** typed questions → understood → computed → answered, with editable assumptions.
  Voice input is live (press the mic, speak, see a transcript). The one-time model download has an
  explicit consent flow and a live status panel.
- 🚧 **In progress:** wiring the voice transcript all the way through to a spoken/on-screen answer
  (issue [#39](https://github.com/APTG/aidedx/issues/39)); mirroring and enabling the fallback
  language models.
- 🐢 **Slow paths:** on machines without a GPU, the language-model fallback can take ~10–30 s — but
  most questions are handled instantly by the deterministic matcher and never reach it. Fast
  local inference wants browser features GitHub Pages can't fully enable yet; hosting is still being
  worked out (see the [technical docs](docs/development.md)).
- 🔭 **Planned:** spoken answers (text-to-speech), deep links into dedx_web for full plots, and a
  broader range of understood phrasings.

## Documentation

- 📖 **User guide** — _coming soon._ A friendly walkthrough for asking questions and reading answers.
- 🛠 **[Technical documentation](docs/development.md)** — the stack, local dev workflow, the internal
  building blocks (eval set, alias tables, the libdedx WASM wrapper), and pointers to every deep-dive
  under [`docs/`](docs/).

## libdedx and related resources

aidedx stands on the shoulders of the APTG stopping-power toolchain:

- **[APTG/libdedx](https://github.com/APTG/libdedx)** — the stopping-power / CSDA-range library that
  computes every number aidedx reports. It draws on standard databases including NIST
  [PSTAR](https://physics.nist.gov/PhysRefData/Star/Text/PSTAR.html) /
  [ASTAR](https://physics.nist.gov/PhysRefData/Star/Text/ASTAR.html) and ICRU reference data.
- **[APTG/dedx_web](https://github.com/APTG/dedx_web)** — the precise, form-driven web tool aidedx
  complements. aidedx reuses its WebAssembly build of libdedx and its material/particle tables, and
  aims to deep-link into it for full plots.

## License

aidedx is licensed under the **GNU General Public License v3.0 or later** ([`LICENSE`](LICENSE)).
This matches its upstream dependencies [APTG/libdedx](https://github.com/APTG/libdedx) and
[APTG/dedx_web](https://github.com/APTG/dedx_web) (both GPL-3.0): the vendored libdedx WASM module
and the alias tables copied from dedx_web make aidedx a combined/derivative work under GPL-3.0. See
[**Third-party licenses**](docs/development.md#third-party-licenses) for the full dependency
breakdown.
</content>
