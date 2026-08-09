/**
 * NLG stage (issue #1 §5, wired up in #39): render a `ComputeResult` as a
 * fixed, per-quantity plain-text answer — a template lookup, not generated
 * text. Every number, unit, and program name comes from the `ComputeResult`
 * (libdedx); particle/material phrases are echoed back verbatim from the
 * intent's `match` strings, so the answer reflects the user's own wording
 * rather than a re-derived canonical name.
 *
 * Templates never prepend an article ("a"/"an") to an echoed particle
 * phrase: `match` can be singular ("proton") or plural ("protons", "carbon
 * ions"), and guessing the right article from arbitrary user text is more
 * trouble than it's worth for a fixed template — "range of 40 MeV protons"
 * reads fine either way.
 *
 * Comparison queries (`compareDim !== "none"`) render as a simple label:value
 * list rather than a fuller sentence per series — the richer comparison UX
 * (issue #10) is out of scope here.
 */
import { isInverseQuantity, type QueryIntent, type Quantity } from "../intent/query-intent.ts";
import type { ComputePoint, ComputeResult, ComputeSeries } from "../compute/compute.ts";
import {
  csdaRangeToCm,
  formatLengthCm,
  formatSignificant,
  perNucleonDisplay,
  stoppingPowerToKevPerUm,
} from "../format.ts";

const QUANTITY_PHRASE: Record<Quantity, string> = {
  stoppingPower: "stopping power",
  csdaRange: "CSDA range",
  energyFromRange: "energy",
  energyFromStp: "energy",
};

/** Native libdedx units, used when a series carries no density to convert
 * with (e.g. `getDensity()` failed for that material). */
const FORWARD_UNIT: Record<"stoppingPower" | "csdaRange", string> = {
  stoppingPower: "MeV·cm²/g",
  csdaRange: "g/cm²",
};

/** Renders a physics value to 4 significant figures, e.g. 1.42899 -> "1.429". */
export function formatNumber(value: number): string {
  return formatSignificant(value);
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * Matches the "<value> <unit> taken as total → …" fragment `matcher.ts` bakes into a fresh
 * intent's `assumptions` at match time, from `particles[0]`/the first heavy ion found (issue #163
 * B7). Stripped out of `result.assumptions` in `renderAnswer()` below and replaced with
 * `totalToPerNucleonNotes()`'s fresh derivation — the baked-in fragment goes stale the moment a
 * chip edit changes the energy's unit or the particle (`withCorrection()` always resets
 * `assumptions` to `[]`, but `compute.ts` keeps dividing by A regardless — C1/C2), and it's wrong
 * for every series but the first in a multi-particle comparison, since it's derived once, not per
 * series (B8).
 */
const TOTAL_PER_NUCLEON_NOTE_RE = / taken as total → /;

/**
 * The total→per-nucleon disclosure for one series+energy pair, derived fresh from whatever the
 * intent *currently* holds — the series' own resolved `particle.massNumber` (correct even after a
 * particle chip edit swapped in a different ion) and `intent.energies[energyIndex]` (correct even
 * after an energy chip edit changed the unit, since C1's fix keeps `perNucleonAssumed` in sync with
 * it). Returns null when there's nothing to disclose: inverse queries (nothing was "taken as
 * total" — C9 is a separate, not-yet-covered gap), a single-nucleon particle (proton), an
 * explicitly per-nucleon unit, or an energy the matcher itself already read as per-nucleon.
 */
function totalToPerNucleonNote(
  intent: QueryIntent,
  quantity: Quantity,
  series: ComputeSeries,
  energyIndex: number,
): string | null {
  if (isInverseQuantity(quantity)) return null;
  const massNumber = series.particle.massNumber;
  if (massNumber <= 1) return null;
  const energy = intent.energies[energyIndex];
  if (!energy || energy.unit === "MeV/nucl" || energy.unit === "MeV/u") return null;
  if (energy.perNucleonAssumed === true) return null;
  const pn = perNucleonDisplay(energy.value, energy.unit, massNumber);
  return `${formatNumber(energy.value)} ${energy.unit} taken as total → ${pn.value} ${pn.unit}`;
}

/**
 * All distinct total→per-nucleon notes across a result's series (deduped — `compareDim:
 * "material"`/`"program"` share one particle+energy across every series, so they'd otherwise
 * repeat the identical note once per series). `compareDim: "energy"` is the one shape with several
 * energies against a single series, so it's the one case iterating `intent.energies` by index
 * matters; every other compareDim uses `intent.energies[0]` against each series' own point 0.
 */
function totalToPerNucleonNotes(
  intent: QueryIntent,
  quantity: Quantity,
  compareDim: ComputeResult["compareDim"],
  series: ComputeSeries[],
): string[] {
  const notes = new Set<string>();
  if (compareDim === "energy") {
    const series0 = series[0];
    if (series0) {
      intent.energies.forEach((_, i) => {
        const note = totalToPerNucleonNote(intent, quantity, series0, i);
        if (note) notes.add(note);
      });
    }
  } else {
    for (const s of series) {
      const note = totalToPerNucleonNote(intent, quantity, s, 0);
      if (note) notes.add(note);
    }
  }
  return [...notes];
}

function particleLabel(intent: QueryIntent, index: number): string {
  return intent.particles[index]?.match ?? "the particle";
}

function materialLabel(intent: QueryIntent, index: number): string {
  return intent.materials[index]?.match ?? "the material";
}

function energyLabel(intent: QueryIntent, index: number): string {
  const e = intent.energies[index];
  return e ? `${formatNumber(e.value)} ${e.unit}` : "";
}

/** "a range of 10 cm" / "a stopping power of 7.29 MeV/cm", echoing the target unit as given. */
function targetPhrase(intent: QueryIntent): string {
  const t = intent.target;
  if (!t) return "the target value";
  const kind = intent.quantity === "energyFromStp" ? "stopping power" : "range";
  return `a ${kind} of ${formatNumber(t.value)} ${t.unit}`;
}

/**
 * The forward (stoppingPower/csdaRange) or inverse (energy) value at one
 * point, or null when absent. compute.ts fills a missing wrapper value with
 * `Number.NaN` rather than leaving it `undefined` (see `forwardSeries`), so
 * `NaN` is treated the same as "no value" here — otherwise it would render as
 * a literal "n/a g/cm²" instead of the intended "couldn't compute" fallback.
 *
 * Forward quantities convert from libdedx's native mass-normalized units
 * (MeV·cm²/g, g/cm²) to the physical units dedx_web displays (keV/µm, an
 * auto-scaled length) whenever the series carries a usable `density`
 * (issue #42 §2/§3). Without one — `getDensity()` failed for that material —
 * this falls back to the native unit rather than fabricating a conversion.
 */
function valueText(
  quantity: Quantity,
  point: ComputePoint | undefined,
  density: number | undefined,
  massNumber: number,
): string | null {
  if (!point) return null;
  if (isInverseQuantity(quantity)) {
    if (point.energy === undefined || !Number.isFinite(point.energy)) return null;
    if (massNumber === 1) return `${formatNumber(point.energy)} MeV`;
    // issue #163 C9 — the forward direction reads a bare energy as *total* and discloses the
    // per-nucleon reading it derives (`totalToPerNucleonNote()` above); the inverse direction
    // returns the per-nucleon energy `service.getInverseCsda()`/`getInverseStp()` themselves solve
    // for (both native to libdedx's MeV/nucl grid) with no total shown at all — two round-trippable
    // conventions, one disclosed. `point.energy` is always MeV/nucl here (`inverseSeries()` sets
    // both `energyMeVPerNucl` and `energy` from the same solved value), so the total is the same
    // "× massNumber" `energyToMeVPerNucl()`'s absolute-unit branch divides by on the forward path —
    // not `atomicMassForConversion()`'s atomic mass, for symmetry with that existing convention.
    const totalMeV = point.energy * massNumber;
    return `${formatNumber(point.energy)} MeV/nucl (= ${formatNumber(totalMeV)} MeV total)`;
  }
  const raw = quantity === "stoppingPower" ? point.stoppingPower : point.csdaRange;
  if (raw === undefined || !Number.isFinite(raw)) return null;
  if (density !== undefined && density > 0) {
    return quantity === "stoppingPower"
      ? `${formatNumber(stoppingPowerToKevPerUm(raw, density))} keV/µm`
      : formatLengthCm(csdaRangeToCm(raw, density));
  }
  return `${formatNumber(raw)} ${FORWARD_UNIT[quantity]}`;
}

/** One "- label: value (program)" comparison-list line, or an inline error line. */
function compareLine(
  quantity: Quantity,
  label: string,
  series: ComputeSeries,
  pointIndex: number,
): string {
  if (series.error) return `- ${label}: couldn't compute (${series.error})`;
  const value = valueText(
    quantity,
    series.points[pointIndex],
    series.density,
    series.particle.massNumber,
  );
  if (value === null) return `- ${label}: couldn't compute`;
  return `- ${label}: ${value} (${series.program.name})`;
}

/** The single-answer sentence for a non-comparison (`compareDim: "none"`) query. */
function singleSentence(intent: QueryIntent, quantity: Quantity, series: ComputeSeries): string {
  const particle = particleLabel(intent, 0);
  const material = materialLabel(intent, 0);

  if (series.error) {
    return isInverseQuantity(quantity)
      ? `Couldn't find the energy for ${particle} in ${material}: ${series.error}`
      : `Couldn't compute the ${QUANTITY_PHRASE[quantity]} of ${energyLabel(intent, 0)} ${particle} in ${material}: ${series.error}`;
  }

  const value = valueText(quantity, series.points[0], series.density, series.particle.massNumber);
  if (value === null) return "Couldn't compute an answer for that query.";

  if (isInverseQuantity(quantity)) {
    return `The energy for ${particle} in ${material} to reach ${targetPhrase(intent)} is ${value} (${series.program.name}).`;
  }
  return `The ${QUANTITY_PHRASE[quantity]} of ${energyLabel(intent, 0)} ${particle} in ${material} is ${value} (${series.program.name}).`;
}

/** The header line introducing a comparison list. */
function introLine(
  intent: QueryIntent,
  quantity: Quantity,
  compareDim: ComputeResult["compareDim"],
): string {
  const inverse = isInverseQuantity(quantity);
  const subject = inverse
    ? `The energy needed to reach ${targetPhrase(intent)}`
    : capitalize(QUANTITY_PHRASE[quantity]);

  switch (compareDim) {
    case "material":
      return inverse
        ? `${subject} for ${particleLabel(intent, 0)}, by material:`
        : `${subject} of ${energyLabel(intent, 0)} ${particleLabel(intent, 0)}, by material:`;
    case "particle":
      return inverse
        ? `${subject} in ${materialLabel(intent, 0)}, by particle:`
        : `${subject} in ${materialLabel(intent, 0)} at ${energyLabel(intent, 0)}, by particle:`;
    case "program":
      return inverse
        ? `${subject} for ${particleLabel(intent, 0)} in ${materialLabel(intent, 0)}, by program:`
        : `${subject} of ${energyLabel(intent, 0)} ${particleLabel(intent, 0)} in ${materialLabel(intent, 0)}, by program:`;
    case "energy":
      return `${subject} of ${particleLabel(intent, 0)} in ${materialLabel(intent, 0)}, by energy:`;
    default:
      return `${subject}:`;
  }
}

/**
 * Render a computed result as plain-text answer lines. `compareDim: "none"`
 * produces a single sentence; any other `compareDim` produces a header line
 * plus one list line per series (or, for `"energy"`, per requested energy
 * within the single series compute.ts returns for that dimension).
 */
export function renderAnswer(intent: QueryIntent, result: ComputeResult): string[] {
  const { quantity, compareDim, series } = result;
  const lines: string[] = [];

  const series0 = series[0];
  if (compareDim === "none") {
    if (series0) lines.push(singleSentence(intent, quantity, series0));
  } else if (compareDim === "energy") {
    if (series0) {
      lines.push(introLine(intent, quantity, compareDim));
      if (series0.error) {
        lines.push(`- couldn't compute: ${series0.error}`);
      } else {
        intent.energies.forEach((_, i) => {
          lines.push(compareLine(quantity, energyLabel(intent, i), series0, i));
        });
      }
    }
  } else {
    lines.push(introLine(intent, quantity, compareDim));
    series.forEach((s, i) => {
      const label =
        compareDim === "material"
          ? materialLabel(intent, i)
          : compareDim === "particle"
            ? particleLabel(intent, i)
            : s.program.name;
      lines.push(compareLine(quantity, label, s, 0));
    });
  }

  // issue #163 C1/C2/B8 — the matcher-baked total→per-nucleon fragment (if any) is dropped and
  // replaced with a fresh one derived per series from the intent/series this render actually
  // holds, so the disclosure survives a chip edit and is correct for every series in a comparison.
  const carriedAssumptions = result.assumptions.filter((a) => !TOTAL_PER_NUCLEON_NOTE_RE.test(a));
  const perNucleonNotes = totalToPerNucleonNotes(intent, quantity, compareDim, series);
  const notes = [...carriedAssumptions, ...perNucleonNotes];
  if (notes.length > 0) {
    lines.push(`Note: ${notes.join("; ")}.`);
  }

  return lines;
}
