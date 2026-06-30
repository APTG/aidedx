/**
 * LLM-based domain correction for ASR output (issue #7).
 *
 * Uses Qwen2.5-1.5B-Instruct (ONNX q4, ~1.7 GB) to post-correct Whisper
 * transcriptions that the regex layer in asr-correct.mjs cannot fix.
 *
 * RAM: ~2.7 GB at runtime. Close the browser before running if RAM is tight.
 *
 * Usage:
 *   node scripts/llm-correct.mjs
 *   node scripts/llm-correct.mjs "your raw asr text here"
 */
import { pipeline, env } from "@huggingface/transformers";
import path from "path";
import { fileURLToPath } from "url";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
env.cacheDir = path.join(PROJECT_ROOT, ".hf-cache");
env.allowLocalModels = false;

const modelArg = process.argv.find((a) => a.startsWith("--model="));
const MODEL_ID = modelArg
  ? modelArg.slice("--model=".length)
  : "onnx-community/Qwen2.5-1.5B-Instruct";
const DTYPE = "q4";

const SYSTEM_PROMPT = `\
You are a TEXT EDITOR, not a question answerer. You will be given a sentence wrapped in
«angle quotes» that was produced by a speech-to-text system (Whisper) for a particle
physics voice interface. Your ONLY job is to fix transcription errors and return the
corrected sentence. You must NEVER answer the question, compute a value, or add any words
that are not already in the input. If nothing is wrong, repeat the sentence unchanged.

═══════════════════════════════════════════════════════
DOMAIN CONTEXT — what the application deals with
═══════════════════════════════════════════════════════

Users ask about three physical quantities for charged particle beams (protons, carbon ions,
neon ions, deuterons, helium-3, etc.) travelling through materials (water, PMMA/Lucite,
bone, silicon, air, adipose tissue, …):

  1. STOPPING POWER (dE/dx, also "energy loss rate")
       — how much energy the particle deposits per unit length or per unit mass
       — valid units: MeV/cm  keV/mm  keV/μm  MeV·cm²/g
       — NOTE: "per cm" or "per mm" appearing after a MeV value is CORRECT here.

  2. CSDA RANGE (penetration depth)
       — how far the particle travels before stopping
       — valid units: cm  mm  g/cm²
       — "per" does NOT appear in range units.

  3. PARTICLE ENERGY (kinetic energy of the beam)
       — the energy of the ion itself
       — valid units: keV  MeV  GeV
       — For heavy ions (carbon, neon, oxygen, …) energy is often given PER NUCLEON:
           MeV/u  or  MeV per nucleon  (MeV/u and MeV/nucl are equivalent)

═══════════════════════════════════════════════════════
DISAMBIGUATION RULE — "per <garbled word>" after an energy value
═══════════════════════════════════════════════════════

Step 1 — decide the context:
  • Does the sentence discuss STOPPING POWER (words: "stopping power", "dE/dx", "energy loss")?
      → "per cm" / "per mm" after MeV is a VALID unit. Do NOT change it.
  • Otherwise (range query, or energy specification for ions):
      → The "per X" is likely a garbled per-nucleon unit. Correct it:

Step 2 — choose between /u and per nucleon by phonetic similarity:
  • "per you" / "per year" / "per ewe" / "per u"
        → sounds like the LETTER u → correct to /u
        → example: "290 MeV per you" → "290 MeV/u"
  • "per nuclear" / "per nucleon" / "per nuke" / "per knockdown" / "per nucle"
        → sounds like NUCLEON → correct to "per nucleon"
        → example: "100 MeV per nuclear" → "100 MeV per nucleon"

═══════════════════════════════════════════════════════
KNOWN WHISPER ERRORS — fix using letter/sound similarity
═══════════════════════════════════════════════════════

  Notation
    "edx" / "de dx" / "de-dx" / "De-dx" / "EDX" / "the EDX"  →  dE/dx
    (dE/dx = differential energy loss, a standard physics notation)

  Acronyms
    "CSBA" / "CSTA" / "CDSA" / "cedar" / "C-SDA"  →  CSDA
    (CSDA = Continuous Slowing Down Approximation; only one letter differs)
    "A-star" / "a star" / "Astar" / "A star"       →  ASTAR
    "P-star" / "p star" / "Pstar" / "P star"       →  PSTAR
    (ASTAR and PSTAR are NIST stopping-power databases)

  Units
    "kev" / "Kev"  →  keV
    "mev" / "Mev"  →  MeV
    "gev" / "Gev"  →  GeV

  Isotopes — always hyphenated
    "carbon 13" / "carbon thirteen"  →  carbon-13
    "helium 3"  / "helium three"     →  helium-3

  Materials
    "loose site" / "lucid" / "luxite" / "lou site"  →  Lucite
    (Lucite is a trade name for PMMA, polymethyl methacrylate)

═══════════════════════════════════════════════════════
OUTPUT FORMAT
═══════════════════════════════════════════════════════
Return the corrected sentence only.
Do not explain. Do not answer. Do not add or remove words beyond fixing the errors above.`;

// Few-shot examples: [raw_input, correct_output].
// Use sentences NOT in TEST_CASES to avoid data leakage.
// These prime the model on the exact input/output format before the real query.
const FEW_SHOT = [
  // no-op — model must learn to leave clean sentences alone
  [
    "What is the range of 200 MeV protons in water?",
    "What is the range of 200 MeV protons in water?",
  ],
  // "per you" → /u in ion-energy context
  [
    "Stopping power for 400 MeV per you carbon ions in PMMA.",
    "Stopping power for 400 MeV/u carbon ions in PMMA.",
  ],
  // dE/dx acronym
  [
    "What is the edx of 80 MeV protons in silicon?",
    "What is the dE/dx of 80 MeV protons in silicon?",
  ],
  // CSDA acronym one letter off
  [
    "Give me the CSTA range of a 100 MeV proton in water.",
    "Give me the CSDA range of a 100 MeV proton in water.",
  ],
  // "per cm" in stopping-power context — must NOT change
  [
    "The dE/dx is 2.5 MeV per cm for 200 MeV protons.",
    "The dE/dx is 2.5 MeV per cm for 200 MeV protons.",
  ],
  // material alias
  ["Range of 80 MeV protons in lou site.", "Range of 80 MeV protons in Lucite."],
];

// Realistic Whisper error → expected correction pairs.
// Each entry is [whisper_raw, expected].
const TEST_CASES = [
  // --- CSDA acronym mangled (one letter off) ---
  [
    "What is the CSBA range of a 150 MeV proton in water?",
    "What is the CSDA range of a 150 MeV proton in water?",
  ],
  // --- "per year" after ion energy → /u (phonetic: "year" ≈ "u") ---
  [
    "Range of carbon ions in water at 290 MeV per year.",
    "Range of carbon ions in water at 290 MeV/u.",
  ],
  // --- "per you" after ion energy → /u ---
  [
    "Range of carbon ions in water at 290 MeV per you.",
    "Range of carbon ions in water at 290 MeV/u.",
  ],
  // --- "per nuclear" after ion energy → per nucleon ---
  [
    "compare stopping power of neon ions in water and air for 100 MeV per nuclear",
    "compare stopping power of neon ions in water and air for 100 MeV per nucleon",
  ],
  // --- stopping power context: "per cm" after MeV is VALID — must not change ---
  [
    "The stopping power is 5 MeV per cm for 100 MeV protons in water.",
    "The stopping power is 5 MeV per cm for 100 MeV protons in water.",
  ],
  // --- dE/dx variants ---
  ["What's the edx of 250 MeV protons in PMMA?", "What's the dE/dx of 250 MeV protons in PMMA?"],
  ["De-dx of 3 MeV deuterons in silicon.", "dE/dx of 3 MeV deuterons in silicon."],
  // --- ASTAR / PSTAR ---
  [
    "Compare the range of 150 MeV protons in water using A-star and P-star.",
    "Compare the range of 150 MeV protons in water using ASTAR and PSTAR.",
  ],
  // --- isotope hyphens ---
  [
    "Stopping power of carbon 13 ions in water at 100 MeV per nucleon.",
    "Stopping power of carbon-13 ions in water at 100 MeV per nucleon.",
  ],
  [
    "Stopping power of a helium 3 ion in water at 40 MeV per nucleon.",
    "Stopping power of a helium-3 ion in water at 40 MeV per nucleon.",
  ],
  // --- material alias ---
  [
    "What is the range of 60 MeV protons in loose site?",
    "What is the range of 60 MeV protons in Lucite?",
  ],
  // --- sanity check: nothing should change ---
  [
    "How far will a 60 MeV proton travel in water?",
    "How far will a 60 MeV proton travel in water?",
  ],
];

function userMsg(raw) {
  return `Fix transcription errors in: «${raw}»`;
}

async function llmCorrect(generator, raw) {
  const messages = [
    { role: "system", content: SYSTEM_PROMPT },
    // Few-shot examples prime the model on the exact task format.
    ...FEW_SHOT.flatMap(([input, output]) => [
      { role: "user", content: userMsg(input) },
      { role: "assistant", content: output },
    ]),
    { role: "user", content: userMsg(raw) },
  ];
  const out = await generator(messages, {
    max_new_tokens: 100,
    do_sample: false,
  });
  const generated = out[0].generated_text;
  // transformers.js may return a string or a chat-message array depending on version/model.
  if (typeof generated === "string") return generated.trim();
  const last = generated.at(-1);
  return (typeof last === "string" ? last : (last.content ?? "")).trim();
}

// --- CLI mode: correct a single sentence from argv ---
const singleInput = process.argv.slice(2).find((a) => !a.startsWith("--"));

console.log(`Model  : ${MODEL_ID} [${DTYPE}]`);
console.log("Loading model (this allocates ~2.7 GB RAM)...");
const t0 = Date.now();
const generator = await pipeline("text-generation", MODEL_ID, { dtype: DTYPE });
console.log(`Loaded in ${((Date.now() - t0) / 1000).toFixed(1)}s\n`);

if (singleInput) {
  const corrected = await llmCorrect(generator, singleInput);
  console.log(`Input    : ${singleInput}`);
  console.log(`Corrected: ${corrected}`);
  process.exit(0);
}

// --- Batch test mode ---
let passed = 0;
for (const [raw, expected] of TEST_CASES) {
  const t1 = Date.now();
  const corrected = await llmCorrect(generator, raw);
  const elapsed = ((Date.now() - t1) / 1000).toFixed(1);

  const ok = corrected.toLowerCase() === expected.toLowerCase();
  if (ok) passed++;

  console.log(`${ok ? "✓" : "✗"} (${elapsed}s)`);
  if (!ok) {
    console.log(`  input    : ${raw}`);
    console.log(`  expected : ${expected}`);
    console.log(`  got      : ${corrected}`);
  } else {
    console.log(`  "${corrected}"`);
  }
}

console.log(`\n=== ${passed}/${TEST_CASES.length} passed ===`);
