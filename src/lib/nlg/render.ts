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
import type { QueryIntent, Quantity } from "../intent/query-intent.ts";
import type { ComputePoint, ComputeResult, ComputeSeries } from "../compute/compute.ts";
import {
  csdaRangeToCm,
  formatLengthCm,
  formatSignificant,
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

function isInverse(quantity: Quantity): quantity is "energyFromRange" | "energyFromStp" {
  return quantity === "energyFromRange" || quantity === "energyFromStp";
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
): string | null {
  if (!point) return null;
  if (isInverse(quantity)) {
    return point.energy === undefined || !Number.isFinite(point.energy)
      ? null
      : `${formatNumber(point.energy)} MeV/nucl`;
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
  const value = valueText(quantity, series.points[pointIndex], series.density);
  if (value === null) return `- ${label}: couldn't compute`;
  return `- ${label}: ${value} (${series.program.name})`;
}

/** The single-answer sentence for a non-comparison (`compareDim: "none"`) query. */
function singleSentence(intent: QueryIntent, quantity: Quantity, series: ComputeSeries): string {
  const particle = particleLabel(intent, 0);
  const material = materialLabel(intent, 0);

  if (series.error) {
    return isInverse(quantity)
      ? `Couldn't find the energy for ${particle} in ${material}: ${series.error}`
      : `Couldn't compute the ${QUANTITY_PHRASE[quantity]} of ${energyLabel(intent, 0)} ${particle} in ${material}: ${series.error}`;
  }

  const value = valueText(quantity, series.points[0], series.density);
  if (value === null) return "Couldn't compute an answer for that query.";

  if (isInverse(quantity)) {
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
  const inverse = isInverse(quantity);
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

  if (result.assumptions.length > 0) {
    lines.push(`Note: ${result.assumptions.join("; ")}.`);
  }

  return lines;
}
