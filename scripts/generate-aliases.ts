/**
 * Regenerate the shipped JSON alias artifacts from the typed TS tables.
 *
 *   node scripts/generate-aliases.ts        (Node 22.18+ / 24 — native TS)
 *   pnpm generate:aliases
 *
 * Writes `static/aliases/materials.json` and `static/aliases/particles.json`,
 * each entry carrying its canonical id, name, and the sorted list of normalized
 * aliases that resolve to it. The JSON is a derived artifact — edit the TS
 * tables in `src/lib/aliases/`, never the JSON. CI checks the committed JSON is
 * up to date (see `aliases.test.ts`).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  MATERIALS,
  MATERIAL_ALIAS_INDEX,
  PARTICLES,
  PARTICLE_ALIAS_INDEX,
} from "../src/lib/aliases/index.ts";

export interface MaterialArtifactEntry {
  id: number;
  name: string;
  kind: string;
  aliases: string[];
}

export interface ParticleArtifactEntry {
  id: number;
  symbol: string;
  name: string;
  defaultMassNumber: number;
  aliases: string[];
}

export function buildMaterialArtifact(): MaterialArtifactEntry[] {
  const byId = new Map<number, string[]>();
  for (const [alias, id] of MATERIAL_ALIAS_INDEX) {
    const list = byId.get(id) ?? [];
    list.push(alias);
    byId.set(id, list);
  }
  return MATERIALS.map((m) => ({
    id: m.id,
    name: m.name,
    kind: m.kind,
    aliases: (byId.get(m.id) ?? []).sort(),
  }));
}

export function buildParticleArtifact(): ParticleArtifactEntry[] {
  const byId = new Map<number, string[]>();
  for (const [alias, entry] of PARTICLE_ALIAS_INDEX) {
    const list = byId.get(entry.id) ?? [];
    list.push(alias);
    byId.set(entry.id, list);
  }
  return PARTICLES.map((p) => ({
    id: p.id,
    symbol: p.symbol,
    name: p.name,
    defaultMassNumber: p.defaultMassNumber,
    aliases: (byId.get(p.id) ?? []).sort(),
  }));
}

export function serialize(value: unknown): string {
  return JSON.stringify(value, null, 2) + "\n";
}

function main(): void {
  const outDir = fileURLToPath(new URL("../static/aliases/", import.meta.url));
  mkdirSync(outDir, { recursive: true });
  writeFileSync(outDir + "materials.json", serialize(buildMaterialArtifact()));
  writeFileSync(outDir + "particles.json", serialize(buildParticleArtifact()));
  console.log(
    `✓ wrote static/aliases/materials.json (${MATERIALS.length} materials) ` +
      `and particles.json (${PARTICLES.length} particles).`,
  );
}

// Only run when invoked directly, not when imported by tests.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
