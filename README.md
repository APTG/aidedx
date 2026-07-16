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
4. **Read the answer.** Any assumptions aidedx made (isotope, energy interpretation, program) are
   noted alongside it.

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
  │   🎤 speak / ⌨ type  ─▶  1. Speech recognition  ─▶  2. Understand  ─▶  3. Compute  ─▶  4. Explain
  │                                                                            │
  └────────────────────────────────────────────────────────────────────────────┘
```

1. **Speech recognition** — turns what you say into text (skip this by typing instead). It's tuned
   toward physics vocabulary (MeV, PMMA, stopping power, …) rather than everyday speech, since we
   expect a physics question, not a recipe — with a retry if a decode ever fails outright.
2. **Understand** — matches your wording against expected physics phrasing to work out the particle,
   material, energy, and quantity you meant, and turns it into a precise query.
3. **Compute** — the query is answered from **trusted reference data (NIST, ICRU, Bethe–Bloch)**, not
   guessed by the AI.
4. **Explain** — you get a plain-language answer, with any assumptions it made noted alongside it.

See the [technical documentation](docs/development.md) for the specifics.

## Why "on your machine" matters

Most AI tools send your words to a company's servers. aidedx does the opposite — the models run
**locally, in your browser**:

- **Privacy is built in.** Your questions never touch the network.
- **Nothing to pay for or operate.** The whole app is a static website — free to host on GitHub Pages
  or a university server.
- **Works offline, too**, once downloaded — handy in an experiment hall or anywhere with no signal.
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

- ✅ **Works:** typed or spoken question → understood → computed → answered, with assumptions noted;
  the one-time model download has a consent flow and status panel.
- 🚧 **In progress:** enabling the language-model fallback for phrasing the built-in rules miss.
- 🐢 **Slow / open:** on GPU-less machines that fallback would take ~10–30 s (most questions skip it,
  handled by the fast built-in rules); fast-inference hosting is still being worked out.
- 🔭 **Planned:** spoken answers, editable assumption chips ([#10](https://github.com/APTG/aidedx/issues/10)), deep links into dedx_web for full plots, wider phrasing coverage.

## Documentation & resources

- 📖 **[User guide](docs/user-guide.md)** — _coming soon._
- 🛠 **[Technical documentation](docs/development.md)** — stack, dev workflow, internals, and every deep-dive under [`docs/`](docs/).
- 🧮 **[APTG/libdedx](https://github.com/APTG/libdedx)** — the library computing every number, built on NIST [PSTAR](https://physics.nist.gov/PhysRefData/Star/Text/PSTAR.html)/[ASTAR](https://physics.nist.gov/PhysRefData/Star/Text/ASTAR.html) and ICRU data.
- 🌐 **[APTG/dedx_web](https://github.com/APTG/dedx_web)** — the form-driven web tool aidedx complements and reuses.

## License

**GPL-3.0-or-later** ([`LICENSE`](LICENSE)) — see [third-party licenses](docs/development.md#third-party-licenses).
