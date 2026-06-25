/**
 * Material / particle synonym (alias) tables for aidedx.
 *
 * Seeded from libdedx (via dedx_web's curated material names and particle
 * aliases) and the periodic table, these map natural-language phrases to
 * canonical libdedx materials and particles. They are the deterministic
 * matcher's accuracy backbone and are also reusable by dedx_web's text search.
 *
 * See `docs/aliases.md` for provenance and how to regenerate the JSON
 * artifacts when libdedx updates. Issue: APTG/aidedx#4.
 */
export { ELEMENTS, ELEMENT_BY_Z, type Element } from "./elements.ts";
export {
  MATERIALS,
  MATERIAL_BY_ID,
  MATERIAL_ALIAS_INDEX,
  type CanonicalMaterial,
  type MaterialKind,
} from "./materials.ts";
export {
  PARTICLES,
  PARTICLE_ALIAS_INDEX,
  ELECTRON_ID,
  particleById,
  type CanonicalParticle,
  type ParticleAliasEntry,
} from "./particles.ts";
export { normalizeText, formatIsotope, toSuperscript, boundedLevenshtein } from "./normalize.ts";
export {
  resolveMaterial,
  resolveParticle,
  type MaterialMatch,
  type ParticleMatch,
  type MatchKind,
} from "./lookup.ts";
