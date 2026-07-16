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
and works out what you're asking; the physics is then computed (via the
[libdedx](https://github.com/APTG/libdedx) library). And it all runs **inside your browser tab** — no
server, no account, nothing you type or say ever leaves your device.

## How to use it

1. **Open the app** at <https://aptg.github.io/aidedx/> — nothing to install.
2. **Allow the one-time download** when prompted. aidedx fetches its AI models (a few hundred MB) and
   caches them in your browser, so this happens only on your first visit.
3. **Ask your question** — press 🎤 and speak, or type it. For example: _"stopping power of 150 MeV
   protons in water"_, or _"how far do 200 MeV/nucl carbon ions go in water?"_
4. **Read the answer and check the assumptions.** aidedx shows how it understood you (isotope,
   energy, program) as editable chips — fix any and the answer updates instantly.

It's just a web app: no repo to clone, no app to install, no login needed.

## How it works

aidedx runs in two phases. The **first time** you visit, it downloads its AI models once and caches
them in your browser. **After that**, every question is handled entirely on your machine, in four
steps that each feed the next:

```
  first visit only ──▶  download AI models  ──▶  cache in your browser (once)
                                                          │
  ┌────────────────── then, for every question, fully local ──────────────────┐
  │                                                                            │
  │   🎤 speak / ⌨ type  ─▶  1. Listen  ─▶  2. Understand  ─▶  3. Compute  ─▶  4. Explain
  │                                                                            │
  └────────────────────────────────────────────────────────────────────────────┘
```

1. **Listen** — a speech-recognition model turns what you say into text (or you type it directly).
2. **Understand** — aidedx reads out which particle, material, energy, and quantity you meant and
   turns it into a precise query. Common phrasings are handled by fast built-in rules; a small
   language model steps in only for unusual wording.
3. **Compute** — the query is answered from **trusted reference data (NIST, ICRU, Bethe–Bloch)**, not
   guessed by the AI.
4. **Explain** — you get a plain-language answer, with every assumption shown as an editable chip.

Because the AI only ever _fills in the query_, a misheard word surfaces as a chip you can correct —
it can never corrupt the physics. The models also catch their own slips: a garbled transcript is
retried, and malformed query output is re-derived. See the
[technical documentation](docs/development.md) for the specifics.

## Why "on your machine" matters

Most AI tools send your words to a company's servers. aidedx does the opposite — the models run
**locally, in your browser**:

- **Privacy is built in.** Clinical and research questions never touch the network.
- **Nothing to pay for or operate.** The whole app is a static website — free to host on GitHub Pages
  or a university server.
- **The physics is never guessed.** The AI only _understands_ your question; every number comes from
  trusted reference data, never from the language model.

|                       | **Cloud AI (typical)**  | **aidedx (local)**           |
| --------------------- | ----------------------- | ---------------------------- |
| Where inference runs  | Company servers         | Your browser tab             |
| Your data             | Uploaded, may be logged | Never leaves the device      |
| Cost / infrastructure | Metered API + a backend | A static file, free to host  |
| Works offline         | No                      | Yes, once weights are cached |
| First-use setup       | None                    | One-time model download      |

The only trade-off is the last row: local AI has to fetch its "brain" the first time you use it.

## Project status

Early-stage prototype under active development:

- ✅ **Works:** typed question → understood → computed → answered, with editable assumptions; voice
  input transcribes; the one-time download has a consent flow and status panel.
- 🚧 **In progress:** wiring voice all the way through to an answer ([#39](https://github.com/APTG/aidedx/issues/39)); enabling the language-model fallback.
- 🐢 **Slow / open:** on GPU-less machines the language-model fallback takes ~10–30 s (most questions skip it); fast-inference hosting is still being worked out.
- 🔭 **Planned:** spoken answers, deep links into dedx_web for full plots, wider phrasing coverage.

## Documentation & resources

- 📖 **User guide** — _coming soon._
- 🛠 **[Technical documentation](docs/development.md)** — stack, dev workflow, internals, and every deep-dive under [`docs/`](docs/).
- 🧮 **[APTG/libdedx](https://github.com/APTG/libdedx)** — the library computing every number, built on NIST [PSTAR](https://physics.nist.gov/PhysRefData/Star/Text/PSTAR.html)/[ASTAR](https://physics.nist.gov/PhysRefData/Star/Text/ASTAR.html) and ICRU data.
- 🌐 **[APTG/dedx_web](https://github.com/APTG/dedx_web)** — the form-driven web tool aidedx complements and reuses.

## License

**GPL-3.0-or-later** ([`LICENSE`](LICENSE)) — see [third-party licenses](docs/development.md#third-party-licenses).
</content>
