/**
 * Experiment (docs/voice-pipeline-feasibility.md §2.5): reduce the LLM NLU
 * fallback to a single-token constrained
 * 4-way classification of the `quantity` slot, using a custom LogitsProcessor
 * (proves grammar-constrained decoding IS possible in transformers.js).
 *
 * Usage: node scripts/llm-quantity-classify.mjs [modelShortName]
 */
import {
  AutoTokenizer,
  AutoModelForCausalLM,
  LogitsProcessor,
  LogitsProcessorList,
  env,
} from "@huggingface/transformers";
import path from "path";
import { fileURLToPath } from "url";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
env.cacheDir = path.join(PROJECT_ROOT, ".hf-cache");
env.allowLocalModels = false;

const MODEL = `onnx-community/${process.argv[2] ?? "Qwen2.5-0.5B-Instruct"}`;

const SYSTEM = `You classify particle-physics queries by which quantity they ask for.
A) stopping power — energy lost/deposited per unit length or mass along the path: dE/dx, LET,
   linear energy transfer, ionisation, Bethe-Bloch, retarding force, energy deposition per
   micrometer / per unit mass / per volume, dose per micrometer
B) range — how far/deep the particle travels: range, CSDA, penetration depth
C) energy that achieves a GIVEN range/depth (the range value is given, energy is asked)
D) energy that achieves a GIVEN stopping power (the stopping-power value is given, energy is asked)
Answer with exactly one letter.`;

const FEW_SHOT = [
  ["Stopping power of 50 MeV protons in water.", "A"],
  ["How far does a 200 MeV proton go in PMMA?", "B"],
  ["What energy gives a 12 cm range for protons in water?", "C"],
  ["At what proton energy is dE/dx in water 4 MeV/cm?", "D"],
];

// [text, expected letter] — 10 adversarial (matcher misses) + 10 controls
const CASES = [
  ["What is the linear energy transfer of 80 MeV protons in water?", "A"],
  ["Give me the LET of 50 MeV protons in silicon.", "A"],
  ["How much energy is deposited per micrometer by 100 MeV protons in PMMA?", "A"],
  ["Specific ionisation produced by 60 MeV alpha particles in bone.", "A"],
  ["Calculate the energy deposition density for 200 MeV protons in cortical bone.", "A"],
  ["Energy deposition per unit mass for 150 MeV protons in water.", "A"],
  ["Volumetric energy deposition for 100 MeV/u neon ions in water.", "A"],
  ["What is the Bethe-Bloch value for 100 MeV protons in water?", "A"],
  ["Compute the retarding force on 30 MeV protons traveling through silicon.", "A"],
  ["How much radiation dose per micrometer is accumulated by 100 MeV protons in water?", "A"],
  // controls (deterministic matcher already handles these — check no regression)
  ["What is the CSDA range of a 150 MeV proton in water?", "B"],
  ["How far will a 60 MeV proton travel in water?", "B"],
  ["I am curious how far in water the 240 keV carbon ion will go", "B"],
  ["What's the dE/dx of 250 MeV protons in PMMA?", "A"],
  ["Compare the stopping power of 100 MeV protons in water and bone.", "A"],
  ["What energy gives a 10 cm range in water for protons?", "C"],
  ["Which proton energy stops at 5 mm in PMMA?", "C"],
  ["How energetic must an alpha particle be to travel 3 cm in air?", "C"],
  ["At what proton energy is the stopping power in water 5 MeV/cm?", "D"],
  ["Which energy makes a proton lose 2 MeV per cm in PMMA?", "D"],
];

console.log(`Loading ${MODEL} (q4)…`);
const t0 = Date.now();
const tokenizer = await AutoTokenizer.from_pretrained(MODEL);
const model = await AutoModelForCausalLM.from_pretrained(MODEL, { dtype: "q4" });
console.log(`Loaded in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

// token ids for the four choice letters
const allowed = new Map();
for (const L of ["A", "B", "C", "D"]) {
  const ids = tokenizer.encode(L, { add_special_tokens: false });
  if (ids.length !== 1) throw new Error(`"${L}" is not a single token: ${ids}`);
  allowed.set(BigInt(ids[0]), L);
  allowed.set(ids[0], L);
}
const allowedIds = [...new Set([...allowed.keys()].map(Number))];

class ChoiceOnly extends LogitsProcessor {
  _call(input_ids, logits) {
    const data = logits.data;
    const keep = allowedIds.map((i) => data[i]);
    data.fill(-Infinity);
    allowedIds.forEach((id, k) => (data[id] = keep[k]));
    return logits;
  }
}
const processors = new LogitsProcessorList();
processors.push(new ChoiceOnly());

let pass = 0;
const latencies = [];
for (const [text, expected] of CASES) {
  const messages = [
    { role: "system", content: SYSTEM },
    ...FEW_SHOT.flatMap(([q, a]) => [
      { role: "user", content: q },
      { role: "assistant", content: a },
    ]),
    { role: "user", content: text },
  ];
  const inputs = tokenizer.apply_chat_template(messages, {
    add_generation_prompt: true,
    return_dict: true,
  });
  const t1 = Date.now();
  const out = await model.generate({
    ...inputs,
    max_new_tokens: 1,
    do_sample: false,
    logits_processor: processors,
  });
  const ms = Date.now() - t1;
  latencies.push(ms);
  const seq = out.tolist()[0];
  const lastTok = seq[seq.length - 1];
  const got = allowed.get(lastTok) ?? allowed.get(Number(lastTok)) ?? `?(${lastTok})`;
  const ok = got === expected;
  if (ok) pass++;
  console.log(`${ok ? "✓" : "✗"} [${got} want ${expected}] (${ms}ms) ${text.slice(0, 70)}`);
}
latencies.sort((a, b) => a - b);
console.log(
  `\n=== ${pass}/${CASES.length} correct | median ${latencies[Math.floor(latencies.length / 2)]}ms ===`,
);
