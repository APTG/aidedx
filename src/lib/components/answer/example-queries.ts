/**
 * Curated example queries for the landing page's "Show examples" reveal
 * (issue #67). Each was verified end to end — matchQueryIntent() →
 * computeIntent() against the real libdedx WASM module → renderAnswer() —
 * before being added here; see example-queries.smoke.test.ts for the
 * regression check that keeps them working as the matcher/alias tables
 * evolve. Order matters: the first entry is shown as the primary example.
 */
export const EXAMPLE_QUERIES: readonly string[] = [
  "Range of 156.3 MeV protons in water",
  "What proton energy is needed to reach a depth of 2 cm in PMMA?",
  "What is the stopping power of a 5 MeV per nucleon alpha particle in gold?",
  "Compare the range of 195.4 MeV per nucleon carbon ions in water, PMMA, and cortical bone",
  "Range of a 480.6 MeV neon ion in air",
  "Stopping power of a 0.85 GeV per nucleon argon ion in aluminum",
  "How far does a 220.5 keV boron ion travel in silicon?",
];
