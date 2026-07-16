# aidedx

**Ask about the range, kinetic energy, or stopping power of protons and heavy ions — just speak or
type the question in plain language and get a real answer, computed entirely on your own machine.**

Questions like _"how far does a 40 MeV proton go in PMMA?"_ or _"what's the stopping power of carbon
ions in water?"_ normally mean digging through a form or a data table. aidedx lets you simply ask:

> 🎤 _"What is the range of 40 MeV protons in PMMA?"_
>
> → _"The CSDA range of 40 MeV protons in PMMA is 1.285 cm (PSTAR)."_

The key point: **the answer comes from trusted reference data — NIST (PSTAR/ASTAR), ICRU, and
Bethe–Bloch calculations — not from an AI making numbers up.** The AI only listens to your question
and works out what you're asking; the physics is then computed by [libdedx](https://github.com/APTG/libdedx),
the same well-established library used by researchers and clinicians. And it all runs **inside your
browser tab** — no server, no account, nothing you type or say ever leaves your device.

## How it works — two phases

**Phase 1 — Download the models (once).** The first time you use aidedx, it asks permission to
download the AI model weights (a few hundred MB), with an explicit consent dialog and a visible
progress panel. The weights are then cached in your browser, so this only happens once.

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

## Why "on your machine" matters

Most AI tools send your words to a company's servers. aidedx does the opposite — the models run
**locally, in your browser**:

- **Privacy is built in.** Clinical and research questions never touch the network.
- **Nothing to pay for or operate.** The whole app is a static website — free to host on GitHub Pages
  or a university server.
- **The physics is never guessed.** The AI only _understands_ your question; every number comes from
  libdedx, never from the language model.

|                       | **Cloud AI (typical)**  | **aidedx (local)**           |
| --------------------- | ----------------------- | ---------------------------- |
| Where inference runs  | Company servers         | Your browser tab             |
| Your data             | Uploaded, may be logged | Never leaves the device      |
| Cost / infrastructure | Metered API + a backend | A static file, free to host  |
| Works offline         | No                      | Yes, once weights are cached |
| First-use setup       | None                    | One-time model download      |

The only trade-off is the last row: local AI has to fetch its "brain" the first time you use it.

## How to use it

1. **Open the app** at <https://aptg.github.io/aidedx/>.
2. **Allow the one-time download** when prompted — the model weights cache in your browser.
3. **Ask a question**, by typing or by pressing 🎤 and speaking. For example:
   _"stopping power of 150 MeV protons in water"_ or _"how far do 200 MeV/nucl carbon ions go in
   water?"_
4. **Read the answer and check the assumptions.** aidedx shows how it interpreted your question
   (isotope, energy, program) as editable chips — correct any of them and the answer updates.

## Project status

aidedx is an **early-stage prototype under active development**:

- ✅ **Works today:** typed questions → understood → computed → answered, with editable assumptions.
  Voice input is live (press the mic, speak, see a transcript). The one-time model download has an
  explicit consent flow and a live status panel.
- 🚧 **In progress:** wiring the voice transcript all the way through to a spoken/on-screen answer
  (issue [#39](https://github.com/APTG/aidedx/issues/39)); mirroring and enabling the fallback
  language models.
- 🐢 **Slow paths:** on machines without a GPU, the language-model fallback can take ~10–30 s — but
  most questions are handled instantly by the deterministic matcher and never reach it. Fast local
  inference wants browser features GitHub Pages can't fully enable yet; hosting is still being worked
  out (see the [technical docs](docs/development.md)).
- 🔭 **Planned:** spoken answers (text-to-speech), deep links into dedx_web for full plots, and a
  broader range of understood phrasings.

## Documentation

- 📖 **User guide** — _coming soon._ A friendly walkthrough for asking questions and reading answers.
- 🛠 **[Technical documentation](docs/development.md)** — the stack, local dev workflow, the internal
  building blocks (eval set, alias tables, the libdedx WASM wrapper), and pointers to every deep-dive
  under [`docs/`](docs/).

## libdedx and related resources

- **[APTG/libdedx](https://github.com/APTG/libdedx)** — the stopping-power / CSDA-range library that
  computes every number aidedx reports, built on standard databases (NIST
  [PSTAR](https://physics.nist.gov/PhysRefData/Star/Text/PSTAR.html) /
  [ASTAR](https://physics.nist.gov/PhysRefData/Star/Text/ASTAR.html), ICRU).
- **[APTG/dedx_web](https://github.com/APTG/dedx_web)** — the precise, form-driven web tool aidedx
  complements; aidedx reuses its libdedx WebAssembly build and material/particle tables.

## License

**GPL-3.0-or-later** ([`LICENSE`](LICENSE)), matching the vendored libdedx and dedx_web it builds on.
Full dependency breakdown: [Third-party licenses](docs/development.md#third-party-licenses).
</content>
