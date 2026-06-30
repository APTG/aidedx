/**
 * Domain vocabulary correction layer for ASR output (issue #7).
 *
 * A pure-JS post-processing step that runs before NLU. Fixes systematic
 * Whisper transcription errors on physics domain terms without any model.
 *
 * Importable:
 *   import { correct } from './asr-correct.mjs';
 *   const fixed = correct(asrText);
 *
 * CLI (pipe or arg):
 *   echo "how far will a 60mm proton go" | node scripts/asr-correct.mjs
 *   node scripts/asr-correct.mjs "how far will a 60mm proton go"
 */

// Particles that follow an energy value — used to detect MeV→mm confusion.
const PARTICLE_WORDS =
  "proton|protons|deuteron|deuterons|alpha|alphas|carbon|neon|oxygen|helium|" +
  "lithium|nitrogen|argon|iron|ion|ions";

export function correct(text) {
  let t = text;

  // --- Unit capitalisation ---
  t = t.replace(/\bkev\b/gi, "keV");
  t = t.replace(/\bmev\b/gi, "MeV");
  t = t.replace(/\bgev\b/gi, "GeV");

  // --- dE/dx variants ---
  t = t.replace(/\bthe\s+edx\b/gi, "dE/dx");
  t = t.replace(/\bedx\b/gi, "dE/dx");
  t = t.replace(/\bde\s*[-/]?\s*dx\b/gi, "dE/dx");

  // --- MeV → mm/ml acoustic confusion ---
  // "60mm proton" → "60 MeV proton" (number + mm/ml before a particle word)
  t = t.replace(
    new RegExp(`(\\d+(?:\\.\\d+)?)\\s*(?:mm|ml)\\s+(${PARTICLE_WORDS})`, "gi"),
    "$1 MeV $2",
  );

  // --- GeV word-boundary split ("1G EV" → "1 GeV") ---
  t = t.replace(/(\d)\s*g\s+ev\b/gi, "$1 GeV");

  // --- per nucleon / per unit variants ---
  t = t.replace(/\bper\s+(?:nuclear\s+ion|knockdown|nuclear)\b/gi, "per nucleon");
  t = t.replace(/\bmegaelectron\w*\s+per\s+nuclear?\b/gi, "MeV per nucleon");
  // MeV/u: "per year" and "per you" are common mishearings of "/u"
  t = t.replace(/\bMeV\s+per\s+(?:year|you)\b/gi, "MeV/u");
  // "tamiya" and similar replacing a unit ("90 tamiya per nucleon" → "90 MeV per nucleon")
  t = t.replace(
    new RegExp(`(\\d+(?:\\.\\d+)?)\\s+tamiya\\s+per\\s+nucleon`, "gi"),
    "$1 MeV per nucleon",
  );

  // --- ASTAR / PSTAR spacing ---
  t = t.replace(/\ba\s*[-\s]?star\b/gi, "ASTAR");
  t = t.replace(/\bp\s*[-\s]?star\b/gi, "PSTAR");

  // --- cm ↔ centimeter normalisation (keep "cm") ---
  t = t.replace(/\bcentimeters?\b/gi, "cm");
  t = t.replace(/\bmillimeters?\b/gi, "mm");

  return t;
}

// CLI entry point
if (process.argv[1] && process.argv[1].endsWith("asr-correct.mjs")) {
  const arg = process.argv[2];
  if (arg) {
    console.log(correct(arg));
  } else {
    const chunks = [];
    process.stdin.on("data", (d) => chunks.push(d));
    process.stdin.on("end", () => console.log(correct(chunks.join("").trim())));
  }
}
