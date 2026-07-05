/**
 * Extended domain correction layer (experimental).
 * = asr-correct.mjs rules + phonetic-variant rules discovered in the 3-speaker ×
 * {whisper-small, turbo} benchmark (docs/voice-pipeline-feasibility.md §2.2).
 * Caveat: rules were tuned on those recordings — validate on held-out speakers.
 * Precursor to the planned phonetic lexicon matcher.
 */
import { correct as baseCorrect } from "./asr-correct.mjs";

const PARTICLE_WORDS =
  "proton|protons|deuteron|deuterons|alpha|alphas|carbon|neon|oxygen|helium|" +
  "lithium|nitrogen|argon|iron|ion|ions";

export function correct(text) {
  let t = text;

  // --- number words (Whisper sometimes spells numbers out) ---
  t = t.replace(/\btwo hundred (and )?forty\b/gi, "240");
  t = t.replace(/\bfree (mev|kev|gev|MeV)\b/gi, "3 $1"); // "free MeV" ≈ "three MeV"

  // --- glued number+unit mishearings: "60mm", "100mEV", "150mv", "30mA", "100MB" ---
  // Domain prior: a number directly followed by m-something before a particle word
  // or "proton(s)" is always an energy in MeV (no mm/mV/mA/MB units exist here).
  t = t.replace(
    new RegExp(
      `(\\d+(?:\\.\\d+)?)\\s*(?:mm|ml|mv|ma|mb|mhz|mev)\\s*[,.]?\\s+(?:a\\s+)?(${PARTICLE_WORDS})`,
      "gi",
    ),
    "$1 MeV $2",
  );
  t = t.replace(/(\d+(?:\.\d+)?)\s*m[e]?v\b/gi, "$1 MeV");

  // --- keV mishearings: "kV", "K EV", "240K EV", "KV" (no kilovolts in domain) ---
  t = t.replace(/(\d+(?:\.\d+)?)\s*k\s*[e]?v\b/gi, "$1 keV");

  // --- ATMEV → 80 MeV ("eighty MeV" glued) ---
  t = t.replace(/\batmev\b/gi, "80 MeV");

  // --- per-nucleon phonetic variants beyond the base set ---
  t = t.replace(
    /\bper\s+(?:napelion|nutlion|nuklion|nukleon|nuclei|nucleons?|nucle\w*|napoleon)\b/gi,
    "per nucleon",
  );
  t = t.replace(/\bpernucleon\b/gi, "per nucleon");
  t = t.replace(/\bper\s+u\b/gi, "/u"); // "290 MeV per u" → MeV/u

  // --- particle phonetic variants ---
  t = t.replace(
    /\b(?:dutrons?|deuterans?|deuterines?|diuterons?|dealt\s*t-?rons?|deutrons?)\b/gi,
    "deuterons",
  );
  t = t.replace(/\baproton\b/gi, "a proton");
  t = t.replace(/\bamoebiprotons?\b/gi, "MeV protons");
  t = t.replace(/\bamoebic protons?\b/gi, "MeV protons");
  // "products"/"proteins" in a beam context are protons
  t = t.replace(
    /\b(?:products|proteins)\b(?=[^.?!]*\b(?:in water|in pmma|in bone|range|stopping)\b)/gi,
    "protons",
  );
  t = t.replace(/\bcarbon (?:isle|aisle|i\.?on)\b/gi, "carbon ion");

  // --- material variants ---
  t = t.replace(/\bpmmea\b/gi, "PMMA");
  t = t.replace(/\bsilicone\b/gi, "silicon");
  t = t.replace(/\b(?:loose site|lou site|luxite|lucid)\b/gi, "Lucite");

  // --- quantity variants ---
  t = t.replace(/\brains of\b/gi, "range of");
  t = t.replace(/\bstop in power\b/gi, "stopping power");
  t = t.replace(/\bcomparis\b/gi, "compare");
  t = t.replace(/\bcompares topping power\b/gi, "compare stopping power");
  t = t.replace(/\b(?:de|da|d)\s*(?:slash|over|-)\s*dx\b/gi, "dE/dx");

  // --- program names ---
  t = t.replace(/\bastor\b/gi, "ASTAR");
  t = t.replace(/\bpstor\b/gi, "PSTAR");

  // base rules last (capitalisation, MeV→mm base case, ASTAR spacing, …)
  return baseCorrect(t);
}
