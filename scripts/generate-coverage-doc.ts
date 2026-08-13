/**
 * Regenerate docs/coverage.md — issue #163 §8 Phase 5.
 *
 * For a physicist deciding whether to trust an answer, "which materials/particles/programs does
 * this app actually cover?" matters as much as the number itself — asking about an entity libdedx
 * has no data for (stainless steel, a muon, an unsupported program) isn't a bug to fix, it's a
 * question the underlying physics data can't answer. This doc lists exactly that, generated from
 * the same alias tables (`src/lib/aliases/`) and the same libdedx WASM (`src/lib/wasm/`) the app
 * queries at runtime — never hand-maintained, so it can't drift out of sync with either the way
 * the audit's own docs/ findings did (issue #163 §7).
 *
 *   node scripts/generate-coverage-doc.ts
 *   pnpm generate:coverage
 *
 * CI guards freshness: `coverage-doc.smoke.test.ts` fails if the committed doc differs from what
 * this generator would produce against the real WASM.
 */
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ELEMENT_BY_Z } from "../src/lib/aliases/elements.ts";
import { MATERIALS, type CanonicalMaterial } from "../src/lib/aliases/materials.ts";
import { PARTICLES, ELECTRON_ID, type CanonicalParticle } from "../src/lib/aliases/particles.ts";
import { formatIsotope } from "../src/lib/aliases/normalize.ts";
import { programName } from "../src/lib/compute/compute.ts";
import type { LibdedxService, ParticleEntity, ProgramEntity } from "../src/lib/wasm/types.ts";
import { loadService } from "./tts-sentence-check.ts";

/** "Helium (Z=2)" for a single ion, "Lithium–Argon (Z=3–18)" for a contiguous run, or a plain
 * count when a program's ion list has gaps (none currently do, but this must not assume that). */
function describeIonRange(zs: number[]): string {
  const min = zs[0];
  const max = zs[zs.length - 1];
  if (min === undefined || max === undefined) return "";
  const minName = ELEMENT_BY_Z.get(min)?.name ?? `Z=${min}`;
  const maxName = ELEMENT_BY_Z.get(max)?.name ?? `Z=${max}`;
  if (min === max) return `${minName} (Z=${min})`;
  if (zs.length === max - min + 1) return `${minName}–${maxName} (Z=${min}–${max})`;
  return `${zs.length} ions, Z=${min}–${max}`;
}

/** One program row's "which ions does it cover" cell. */
function describeIonCoverage(particles: ParticleEntity[]): string {
  const zs = particles
    .map((p) => p.id)
    .filter((id) => id !== ELECTRON_ID)
    .sort((a, b) => a - b);
  const parts = [describeIonRange(zs)].filter(Boolean);
  if (particles.some((p) => p.id === ELECTRON_ID)) parts.push("electron");
  return parts.length > 0 ? parts.join(" + ") : "none";
}

/**
 * Particles/materials the alias tables recognize a phrase for, but that have no *usable*
 * stopping-power data under any program — a program listing a particle in `getParticles()` while
 * its own `getMaterials()` is empty (ESTAR today) doesn't count as coverage, since no material
 * pairing with it can ever succeed.
 */
function computeGaps(
  service: LibdedxService,
  programs: ProgramEntity[],
): { particles: CanonicalParticle[]; materials: CanonicalMaterial[] } {
  const workingParticleIds = new Set<number>();
  const workingMaterialIds = new Set<number>();
  for (const program of programs) {
    const particles = service.getParticles(program.id);
    const materials = service.getMaterials(program.id);
    if (particles.length === 0 || materials.length === 0) continue;
    for (const p of particles) workingParticleIds.add(p.id);
    for (const m of materials) workingMaterialIds.add(m.id);
  }
  return {
    particles: PARTICLES.filter((p) => !workingParticleIds.has(p.id)),
    materials: MATERIALS.filter((m) => !workingMaterialIds.has(m.id)),
  };
}

/** id/A pairs whose name pins a specific isotope, mirroring `particles.ts`'s
 * `NAMED_PARTICLE_ALIASES` for the light ions plus the electron. */
const NAMED_ISOTOPES: ReadonlyArray<{ name: string; id: number; massNumber: number }> = [
  { name: "proton", id: 1, massNumber: 1 },
  { name: "deuteron", id: 1, massNumber: 2 },
  { name: "triton", id: 1, massNumber: 3 },
  { name: "alpha particle", id: 2, massNumber: 4 },
  { name: "electron", id: ELECTRON_ID, massNumber: 0 },
];

function particlesSection(): string {
  const ionZs = PARTICLES.map((p) => p.id).filter((id) => id !== ELECTRON_ID);
  const minZ = Math.min(...ionZs);
  const maxZ = Math.max(...ionZs);
  const minName = ELEMENT_BY_Z.get(minZ)?.name ?? `Z=${minZ}`;
  const maxName = ELEMENT_BY_Z.get(maxZ)?.name ?? `Z=${maxZ}`;

  const rows = NAMED_ISOTOPES.map(
    ({ name, id, massNumber }) =>
      `| ${name} | ${id === ELECTRON_ID ? "—" : formatIsotope(massNumber, ELEMENT_BY_Z.get(id)?.symbol ?? "")} |`,
  );

  return [
    "## Particles",
    "",
    `Any of the ${ionZs.length} elements Z=${minZ}–${maxZ} (${minName}–${maxName}) can be named as ` +
      "an ion — by element name, symbol, or a recognized spelling variant (see " +
      "[aliases.md](aliases.md)). A bare element name assumes its most-abundant isotope; an " +
      'explicit isotope ("carbon-13", "¹³C") overrides that.',
    "",
    "These names are recognized directly, with a fixed isotope:",
    "",
    "| Name | Resolves to |",
    "| --- | --- |",
    ...rows,
    "",
  ].join("\n");
}

function materialsSection(): string {
  const elements = MATERIALS.filter((m) => m.kind === "element");
  const compounds = [...MATERIALS.filter((m) => m.kind === "compound")].sort((a, b) =>
    a.name.localeCompare(b.name),
  );
  const elementZs = elements.map((m) => m.id);
  const minZ = Math.min(...elementZs);
  const maxZ = Math.max(...elementZs);
  const symbols = elementZs
    .sort((a, b) => a - b)
    .map((z) => ELEMENT_BY_Z.get(z)?.symbol ?? `Z=${z}`)
    .join(", ");

  const compoundRows = compounds.map((m) => `| ${m.id} | ${m.name} |`);

  return [
    "## Materials",
    "",
    `### Elements (Z=${minZ}–${maxZ}, ${elements.length} elements)`,
    "",
    // Only the first `elements.length` of the Particles section's elements are usable as
    // materials too (libdedx's elemental *targets* stop at Z=98, well short of the full Z=1–118
    // ion catalogue) — naming an explicit subset here rather than "the same elements as above",
    // which would overstate the range.
    `The first ${elements.length} elements (Z=${minZ}–${maxZ}) — named the same way as under ` +
      "Particles above (element name, symbol, or spelling variant) — can also be used as a pure " +
      "elemental target:",
    "",
    symbols,
    "",
    `### Compounds & mixtures (${compounds.length})`,
    "",
    "| id | name |",
    "| --- | --- |",
    ...compoundRows,
    "",
  ].join("\n");
}

function programsSection(service: LibdedxService, programs: ProgramEntity[]): string {
  const rows = programs.map((program) => {
    const particles = service.getParticles(program.id);
    const materials = service.getMaterials(program.id);
    return `| ${programName(program.id)} | ${describeIonCoverage(particles)} | ${materials.length} |`;
  });

  return [
    "## Stopping-power programs",
    "",
    "libdedx tabulates each program's data over its own particle and material lists. The " +
      "auto-selector (`autoProgramForParticle()` in `src/lib/compute/compute.ts`) walks a chain of " +
      "these per particle and falls back to the general Bethe formula (`Bethe`/`Bethe-ext` below) " +
      "when nothing more specific has data — so most particle/material pairs resolve even when no " +
      "*specific* program covers them.",
    "",
    "| Program | Ions covered | Materials covered |",
    "| --- | --- | --- |",
    ...rows,
    "",
  ].join("\n");
}

function gapsSection(service: LibdedxService, programs: ProgramEntity[]): string {
  const gaps = computeGaps(service, programs);
  const lines = [
    "## Known gaps",
    "",
    "Computed from the tables above, not hand-maintained: a particle or material appears here when " +
      "no program both lists it *and* has any tabulated material/particle data at all — an empty " +
      "program (ESTAR's material list is currently empty) doesn't count as coverage even though the " +
      "particle nominally appears in its ion list.",
    "",
  ];

  if (gaps.particles.length > 0) {
    lines.push(
      "**Particles with no usable stopping-power data under any program:**",
      "",
      // `CanonicalParticle.name` capitalizes every entry as a periodic-table element name
      // ("Nihonium"); the electron isn't one, and every other section of this doc names it
      // lowercase ("electron", matching "proton"/"deuteron") — kept consistent here too.
      ...gaps.particles.map(
        (p) => `- ${p.id === ELECTRON_ID ? "electron (Z=—)" : `${p.name} (Z=${p.id})`}`,
      ),
      "",
    );
  } else {
    lines.push("No particle in the tables above is missing coverage under every program.", "");
  }

  if (gaps.materials.length > 0) {
    lines.push(
      "**Materials with no usable stopping-power data under any program:**",
      "",
      ...gaps.materials.map((m) => `- ${m.name} (id ${m.id})`),
      "",
    );
  } else {
    lines.push("No material in the tables above is missing coverage under every program.", "");
  }

  return lines.join("\n");
}

/** Pure builder — takes an already-initialized service so `coverage-doc.test.ts` can reuse the
 * same WASM bootstrap `compute.smoke.test.ts` already pays for, rather than loading it twice. */
export function buildCoverageDoc(service: LibdedxService): string {
  const programs = service.getPrograms();
  return (
    [
      "# Coverage: what aidedx can and cannot compute",
      "",
      "**Generated — do not edit by hand.** Regenerate after any alias-table or libdedx change:",
      "",
      "```sh",
      "pnpm generate:coverage",
      "```",
      "",
      "Source: [`src/lib/aliases/`](../src/lib/aliases/) for particle/material names, the vendored " +
        `libdedx WASM (\`static/wasm/\`, version ${service.getVersion()}) for program coverage.`,
      "",
    ].join("\n") +
    "\n" +
    particlesSection() +
    "\n" +
    materialsSection() +
    "\n" +
    programsSection(service, programs) +
    "\n" +
    gapsSection(service, programs) +
    "\n"
  );
}

async function main(): Promise<void> {
  const service = await loadService();
  const doc = buildCoverageDoc(service);
  const outPath = fileURLToPath(new URL("../docs/coverage.md", import.meta.url));
  writeFileSync(outPath, doc);
  console.log(`✓ wrote docs/coverage.md (${doc.split("\n").length} lines)`);
}

if (process.argv[1] && process.argv[1].endsWith("generate-coverage-doc.ts")) {
  main();
}
