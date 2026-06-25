/**
 * Deterministic alias lookup for materials and particles.
 *
 * Resolution order (cheapest, most certain first):
 *  1. exact — normalized phrase hits the alias index directly;
 *  2. normalized — after stripping decorative suffixes ("ions", "particles",
 *     "beam", "target", "gas", …) and singularizing a trailing "s";
 *  3. isotope (particles only) — an explicit "carbon-13" / "³He" / "C-13"
 *     phrasing, parsed and combined with the element table;
 *  4. fuzzy — Levenshtein distance ≤ 1 (≤ 2 for longer phrases) against the
 *     alias keys, to absorb typos like "watr" or "alumnium".
 *
 * Every result carries `matchKind` so callers (and the eval harness) can tell a
 * confident exact hit from a fuzzy guess.
 */
import {
  MATERIAL_ALIAS_INDEX,
  MATERIAL_BY_ID,
  type CanonicalMaterial,
  type MaterialKind,
} from "./materials.ts";
import {
  ELECTRON_ID,
  PARTICLE_ALIAS_INDEX,
  elementByExactSymbol,
  elementByNameOrSymbol,
  particleById,
  type ParticleAliasEntry,
} from "./particles.ts";
import { boundedLevenshtein, formatIsotope, normalizeText } from "./normalize.ts";

export type MatchKind = "exact" | "normalized" | "isotope" | "fuzzy";

export interface MaterialMatch {
  id: number;
  name: string;
  kind: MaterialKind;
  matchKind: MatchKind;
}

export interface ParticleMatch {
  /** libdedx particle id (Z, or 1001 for the electron). */
  id: number;
  symbol: string;
  name: string;
  massNumber: number;
  /** Isotope label, e.g. "¹²C"; empty for the electron. */
  isotope: string;
  /** True when the isotope was assumed rather than stated in the phrase. */
  isotopeAssumed: boolean;
  matchKind: MatchKind;
}

// Decorative words that carry no entity information once the head noun is known.
const SUFFIX_NOISE = [
  "ions",
  "ion",
  "nuclei",
  "nucleus",
  "particles",
  "particle",
  "beam",
  "beams",
  "projectile",
  "projectiles",
  "target",
  "targets",
  "gas",
  "absorber",
  "medium",
];

/**
 * The phrase reduced to its head token with case preserved: noise words removed
 * (case-insensitively), the rest rejoined. Used only for the case-sensitive
 * symbol guard, so "P ion" → "P" while "carbon ions" → "carbon".
 */
function coreToken(phrase: string): string {
  const tokens = phrase
    .trim()
    .split(/[\s,]+/)
    .filter(Boolean);
  return tokens.filter((t) => !SUFFIX_NOISE.includes(t.toLowerCase())).join(" ");
}

/** Drop trailing decorative words and a single plural "s". */
function stripNoise(normalized: string): string {
  let s = normalized;
  let changed = true;
  while (changed) {
    changed = false;
    for (const w of SUFFIX_NOISE) {
      if (s === w) continue;
      if (s.endsWith(` ${w}`)) {
        s = s.slice(0, -(w.length + 1)).trim();
        changed = true;
      }
    }
  }
  if (s.length > 3 && s.endsWith("s") && !s.endsWith("ss")) s = s.slice(0, -1);
  return s;
}

function fuzzyMatch(key: string, keys: Iterable<string>): string | null {
  if (key.length < 3) return null;
  const max = key.length >= 7 ? 2 : 1;
  let best: string | null = null;
  let bestDist = max + 1;
  for (const candidate of keys) {
    if (Math.abs(candidate.length - key.length) > max) continue;
    const d = boundedLevenshtein(key, candidate, max);
    if (d < bestDist) {
      bestDist = d;
      best = candidate;
      if (d === 0) break;
    }
  }
  return bestDist <= max ? best : null;
}

function toMaterialMatch(id: number, matchKind: MatchKind): MaterialMatch | null {
  const m: CanonicalMaterial | undefined = MATERIAL_BY_ID.get(id);
  if (!m) return null;
  return { id: m.id, name: m.name, kind: m.kind, matchKind };
}

/** Resolve a raw material phrase to a canonical libdedx material, or null. */
export function resolveMaterial(phrase: string): MaterialMatch | null {
  const norm = normalizeText(phrase);
  if (!norm) return null;

  const exact = MATERIAL_ALIAS_INDEX.get(norm);
  if (exact !== undefined) return toMaterialMatch(exact, "exact");

  const stripped = stripNoise(norm);
  if (stripped !== norm) {
    const hit = MATERIAL_ALIAS_INDEX.get(stripped);
    if (hit !== undefined) return toMaterialMatch(hit, "normalized");
  }

  const fuzzyKey = fuzzyMatch(stripped, MATERIAL_ALIAS_INDEX.keys());
  if (fuzzyKey) {
    const id = MATERIAL_ALIAS_INDEX.get(fuzzyKey);
    if (id !== undefined) return toMaterialMatch(id, "fuzzy");
  }

  return null;
}

function buildParticleMatch(entry: ParticleAliasEntry, matchKind: MatchKind): ParticleMatch | null {
  const p = particleById(entry.id);
  if (!p) return null;
  const isElectron = entry.id === ELECTRON_ID;
  return {
    id: p.id,
    symbol: p.symbol,
    name: p.name,
    massNumber: entry.massNumber,
    isotope: isElectron || entry.massNumber <= 0 ? "" : formatIsotope(entry.massNumber, p.symbol),
    isotopeAssumed: entry.assumed,
    matchKind,
  };
}

/**
 * Parse an explicit isotope phrasing into an element + mass number. Accepts a
 * symbol/name on either side of the number, in normalized form (super/subscript
 * digits already folded to ASCII): "carbon 13", "13 c", "c 13", "he 3".
 * Returns null when the alpha part is not a known element.
 */
function parseIsotope(normalized: string): ParticleAliasEntry | null {
  const head = normalized.match(/^([a-z]+)\s*([0-9]{1,3})$/);
  const tail = normalized.match(/^([0-9]{1,3})\s*([a-z]+)$/);
  let namePart: string | undefined;
  let massPart: string | undefined;
  if (head) {
    namePart = head[1];
    massPart = head[2];
  } else if (tail) {
    massPart = tail[1];
    namePart = tail[2];
  }
  if (namePart === undefined || massPart === undefined) return null;
  const el = elementByNameOrSymbol(namePart);
  if (!el) return null;
  return { id: el.z, massNumber: Number(massPart), assumed: false };
}

/** Resolve a raw particle phrase to a canonical libdedx particle, or null. */
export function resolveParticle(phrase: string): ParticleMatch | null {
  const norm = normalizeText(phrase);
  if (!norm) return null;

  // Case-sensitive symbol guard: an upper-cased element symbol ("P") resolves to
  // that element's ion rather than being shadowed by a lower-cased named-particle
  // alias ("p" → proton). Only fires when the core token carries an uppercase
  // letter, so "p" still means proton.
  const core = coreToken(phrase);
  if (core && core !== core.toLowerCase()) {
    const el = elementByExactSymbol(core);
    if (el) {
      return buildParticleMatch(
        { id: el.z, massNumber: el.defaultMassNumber, assumed: true },
        "exact",
      );
    }
  }

  const exact = PARTICLE_ALIAS_INDEX.get(norm);
  if (exact) return buildParticleMatch(exact, "exact");

  const stripped = stripNoise(norm);
  if (stripped !== norm) {
    const hit = PARTICLE_ALIAS_INDEX.get(stripped);
    if (hit) return buildParticleMatch(hit, "normalized");
  }

  // Explicit isotope ("carbon-13 ions" → "carbon 13", "³He" → "3 he").
  const iso = parseIsotope(stripped) ?? parseIsotope(norm);
  if (iso) return buildParticleMatch(iso, "isotope");

  const fuzzyKey = fuzzyMatch(stripped, PARTICLE_ALIAS_INDEX.keys());
  if (fuzzyKey) {
    const entry = PARTICLE_ALIAS_INDEX.get(fuzzyKey);
    if (entry) return buildParticleMatch(entry, "fuzzy");
  }

  return null;
}
