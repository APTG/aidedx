/**
 * Particle (projectile) alias table.
 *
 * Canonical entries are keyed by the libdedx particle id: Z (1–118) for ions,
 * plus 1001 for the electron — matching dedx_web's
 * `src/lib/config/particle-aliases.ts`. Each ion's element data (symbol, name,
 * most-abundant isotope) comes from `elements.ts`.
 *
 * The alias index maps a normalized phrase to a particle, a resolved mass
 * number A, and whether choosing that A was an *assumption*:
 *  - A bare element name or symbol ("carbon", "C", "neon ions") leaves the
 *    isotope unspecified, so the most-abundant isotope is assumed
 *    (`assumed: true`) — e.g. "carbon" → ¹²C.
 *  - A specific particle name ("proton", "deuteron", "alpha", "helium-3")
 *    already pins the isotope, so `assumed: false`.
 *
 * Explicit isotope phrasings ("carbon-13", "³He", "C-13") are parsed at lookup
 * time in `lookup.ts` rather than enumerated here.
 */
import { ELEMENTS, ELEMENT_BY_Z, ELEMENT_NAME_VARIANTS, type Element } from "./elements.ts";
import { normalizeText } from "./normalize.ts";

export interface CanonicalParticle {
  /** libdedx particle id: Z for ions, 1001 for the electron. */
  id: number;
  /** Chemical symbol, e.g. "H", "He", "C"; "e⁻" for the electron. */
  symbol: string;
  /** Display name, e.g. "Hydrogen", "Carbon"; "Electron". */
  name: string;
  /** Mass number A assumed when the beam is named by its bare element name. */
  defaultMassNumber: number;
}

export interface ParticleAliasEntry {
  /** libdedx particle id. */
  id: number;
  /** Resolved isotope mass number A. */
  massNumber: number;
  /** True when `massNumber` is an assumed default rather than stated. */
  assumed: boolean;
}

export const ELECTRON_ID = 1001;

/** Full canonical catalogue: every ion Z=1..118 plus the electron. */
export const PARTICLES: readonly CanonicalParticle[] = [
  ...ELEMENTS.map((e) => ({
    id: e.z,
    symbol: e.symbol,
    name: e.name,
    defaultMassNumber: e.defaultMassNumber,
  })),
  { id: ELECTRON_ID, symbol: "e⁻", name: "Electron", defaultMassNumber: 0 },
];

/**
 * Hand-curated aliases for named particles whose isotope is fixed by the name
 * itself, plus the electron. These set `assumed: false` and take precedence
 * over the generic element-name aliases generated below.
 */
const NAMED_PARTICLE_ALIASES: ReadonlyArray<[string, ParticleAliasEntry]> = [
  // Hydrogen isotopes.
  ["proton", { id: 1, massNumber: 1, assumed: false }],
  ["protons", { id: 1, massNumber: 1, assumed: false }],
  ["p", { id: 1, massNumber: 1, assumed: false }],
  ["p+", { id: 1, massNumber: 1, assumed: false }],
  ["1H", { id: 1, massNumber: 1, assumed: false }],
  ["deuteron", { id: 1, massNumber: 2, assumed: false }],
  ["deuterons", { id: 1, massNumber: 2, assumed: false }],
  ["d", { id: 1, massNumber: 2, assumed: false }],
  ["2H", { id: 1, massNumber: 2, assumed: false }],
  ["deuterium", { id: 1, massNumber: 2, assumed: false }],
  ["triton", { id: 1, massNumber: 3, assumed: false }],
  ["tritons", { id: 1, massNumber: 3, assumed: false }],
  ["t", { id: 1, massNumber: 3, assumed: false }],
  ["3H", { id: 1, massNumber: 3, assumed: false }],
  ["tritium", { id: 1, massNumber: 3, assumed: false }],
  // Helium isotopes.
  ["alpha", { id: 2, massNumber: 4, assumed: false }],
  ["alphas", { id: 2, massNumber: 4, assumed: false }],
  ["alpha particle", { id: 2, massNumber: 4, assumed: false }],
  ["alpha particles", { id: 2, massNumber: 4, assumed: false }],
  ["α", { id: 2, massNumber: 4, assumed: false }],
  ["4He", { id: 2, massNumber: 4, assumed: false }],
  ["helion", { id: 2, massNumber: 3, assumed: false }],
  ["3He", { id: 2, massNumber: 3, assumed: false }],
  // Electron.
  ["electron", { id: ELECTRON_ID, massNumber: 0, assumed: false }],
  ["electrons", { id: ELECTRON_ID, massNumber: 0, assumed: false }],
  ["e-", { id: ELECTRON_ID, massNumber: 0, assumed: false }],
  ["e⁻", { id: ELECTRON_ID, massNumber: 0, assumed: false }],
  ["beta", { id: ELECTRON_ID, massNumber: 0, assumed: false }],
  ["β", { id: ELECTRON_ID, massNumber: 0, assumed: false }],
  ["beta minus", { id: ELECTRON_ID, massNumber: 0, assumed: false }],
];

/**
 * Build the normalized alias → entry index. Generic element name and symbol
 * map to the element's default isotope with `assumed: true`; curated named
 * particles are layered on top with `assumed: false` and win on collision.
 */
function buildParticleAliasIndex(): Map<string, ParticleAliasEntry> {
  const index = new Map<string, ParticleAliasEntry>();
  const put = (alias: string, entry: ParticleAliasEntry) => {
    const key = normalizeText(alias);
    if (key.length > 0) index.set(key, entry);
  };

  for (const e of ELEMENTS) {
    const entry: ParticleAliasEntry = {
      id: e.z,
      massNumber: e.defaultMassNumber,
      assumed: true,
    };
    put(e.name, entry);
    put(e.symbol, entry);
  }
  for (const [variant, z] of ELEMENT_NAME_VARIANTS) {
    const e = ELEMENT_BY_Z.get(z);
    if (e) put(variant, { id: e.z, massNumber: e.defaultMassNumber, assumed: true });
  }
  for (const [alias, entry] of NAMED_PARTICLE_ALIASES) put(alias, entry);

  return index;
}

export const PARTICLE_ALIAS_INDEX: ReadonlyMap<string, ParticleAliasEntry> =
  buildParticleAliasIndex();

const ELEMENT_BY_EXACT_SYMBOL: ReadonlyMap<string, Element> = new Map(
  ELEMENTS.map((e) => [e.symbol, e]),
);

/**
 * Case-sensitive symbol lookup, e.g. "P" → phosphorus. Used to disambiguate an
 * upper-cased element symbol from a lower-cased named-particle alias ("p" →
 * proton) before normalization folds the case away.
 */
export function elementByExactSymbol(symbol: string): Element | null {
  return ELEMENT_BY_EXACT_SYMBOL.get(symbol) ?? null;
}

/** Resolve a normalized symbol or element name to its element, or null. */
export function elementByNameOrSymbol(normalized: string): Element | null {
  for (const e of ELEMENTS) {
    if (normalizeText(e.symbol) === normalized || normalizeText(e.name) === normalized) {
      return e;
    }
  }
  for (const [variant, z] of ELEMENT_NAME_VARIANTS) {
    if (normalizeText(variant) === normalized) return ELEMENT_BY_Z.get(z) ?? null;
  }
  return null;
}

export function particleById(id: number): CanonicalParticle | undefined {
  if (id === ELECTRON_ID) return PARTICLES[PARTICLES.length - 1];
  const e = ELEMENT_BY_Z.get(id);
  if (!e) return undefined;
  return { id: e.z, symbol: e.symbol, name: e.name, defaultMassNumber: e.defaultMassNumber };
}
