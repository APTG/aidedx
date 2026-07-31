/**
 * Default-slot filling for incomplete queries (issue #10 trust-loop
 * extension): when the matcher recognized *what* quantity is being asked
 * for but not every slot ("stopping power of a proton" — no material, no
 * energy), fill the gaps with sensible defaults so the query still computes
 * and renders as editable chips, instead of a dead-end "couldn't understand"
 * message. The defaults are deliberately generic/well-known reference values
 * (a proton in water at a round energy), not a guess at what the user meant.
 */
import type { QuantitySource, UnresolvedEntity } from "./matcher.ts";
import type { EnergySlot, QueryIntent, TargetSlot } from "./query-intent.ts";

const DEFAULT_PARTICLE_MATCH = "proton";
const DEFAULT_MATERIAL_MATCH = "water";
const DEFAULT_ENERGY: EnergySlot = { value: 100, unit: "MeV" };
const DEFAULT_TARGET_RANGE: TargetSlot = { value: 10, unit: "cm" };
const DEFAULT_TARGET_STP: TargetSlot = { value: 10, unit: "MeV/cm" };

/**
 * A query is recoverable-with-defaults when the matcher is confident about
 * *which* quantity is being asked (`quantitySource !== "default"` — a real
 * keyword/idiom/inverse cue fired) but `incomplete` is set because some
 * other slot came up empty. When the quantity itself is only a guess
 * (`quantitySource === "default"`), defaulting the remaining slots too would
 * compound one guess on top of another — that case stays a plain
 * "couldn't understand" instead.
 */
export function isRecoverableIncomplete(match: {
  quantitySource: QuantitySource;
  incomplete: boolean;
}): boolean {
  return match.incomplete && match.quantitySource !== "default";
}

export interface FilledSlot {
  kind: "particle" | "material" | "energy" | "target";
  /** Human-readable note in the existing "X → Y" assumptions style, e.g. "material not specified → water". */
  note: string;
}

export interface FillDefaultsResult {
  intent: QueryIntent;
  filled: FilledSlot[];
}

/** Fills whichever of particles/materials/energies/target is empty with a default; leaves recognized slots untouched. */
export function fillMissingSlots(intent: QueryIntent): FillDefaultsResult {
  const filled: FilledSlot[] = [];
  const isInverse = intent.quantity === "energyFromRange" || intent.quantity === "energyFromStp";

  let particles = intent.particles;
  if (particles.length === 0) {
    filled.push({ kind: "particle", note: `particle not specified → ${DEFAULT_PARTICLE_MATCH}` });
    particles = [{ match: DEFAULT_PARTICLE_MATCH }];
  }

  let materials = intent.materials;
  if (materials.length === 0) {
    filled.push({ kind: "material", note: `material not specified → ${DEFAULT_MATERIAL_MATCH}` });
    materials = [{ match: DEFAULT_MATERIAL_MATCH }];
  }

  let energies = intent.energies;
  if (!isInverse && energies.length === 0) {
    filled.push({
      kind: "energy",
      note: `energy not specified → ${DEFAULT_ENERGY.value} ${DEFAULT_ENERGY.unit}`,
    });
    energies = [DEFAULT_ENERGY];
  }

  let target = intent.target;
  if (isInverse && target === undefined) {
    target = intent.quantity === "energyFromRange" ? DEFAULT_TARGET_RANGE : DEFAULT_TARGET_STP;
    filled.push({ kind: "target", note: `target not specified → ${target.value} ${target.unit}` });
  }

  return {
    intent: {
      ...intent,
      particles,
      materials,
      energies,
      ...(target !== undefined ? { target } : {}),
      assumptions: [...intent.assumptions, ...filled.map((f) => f.note)],
    },
    filled,
  };
}

/** Composes the user-facing banner text for a defaults-filled answer. */
export function buildDefaultsNotice(filled: FilledSlot[]): string {
  const list = filled.map((f) => f.note).join("; ");
  return `Your question was missing some details, so I filled them in: ${list}. Tap a value below to correct it, or try asking again.`;
}

/**
 * issue #163 B3/B6 — the message for a query that *named* a particle/material/program libdedx has
 * no data for, as opposed to one that never named anything. Callers must check this **before**
 * `fillMissingSlots()` — silently substituting a default for a slot this describes is exactly the
 * "material not specified → water" false banner the bug report measured (the user did specify
 * one; libdedx just doesn't have it). Deliberately doesn't invite "tap a value below to correct
 * it" the way `buildDefaultsNotice()` does — there is no computed answer to show chips for here.
 */
export function buildUnresolvedNotice(unresolved: UnresolvedEntity[]): string {
  // Copilot review on PR #167 — every real call site guards with `unresolved.length > 0` first
  // (there's nothing to name otherwise), so an empty array here is a caller bug, not a case to
  // degrade gracefully for: it would otherwise silently produce ". Try a different particle,
  // material, or program, or check the spelling." with no actual named entity in it.
  if (unresolved.length === 0) {
    throw new Error("buildUnresolvedNotice() requires at least one unresolved entity");
  }
  const parts = unresolved.map((u) => `"${u.phrase}" isn't a ${u.kind} that libdedx has data for`);
  // issue #163 B6 — was keyed off item *count* ("> 1 item → generic 'particle or material'"),
  // which silently mislabeled the moment a second kind (program) became possible: 2+ unresolved
  // programs would have printed "particle or material" despite naming neither. Built from the
  // *distinct kinds* actually present instead, so it's correct regardless of how many of each.
  const kinds = [...new Set(unresolved.map((u) => u.kind))];
  const noun =
    kinds.length > 1 ? kinds.join(" or ") : (kinds[0] ?? "particle, material, or program");
  return `${parts.join("; ")}. Try a different ${noun}, or check the spelling.`;
}
