/**
 * dedx_web calculator deep link (issue #10 trust loop, final item): given
 * the `QueryIntent` + `ComputeResult` behind an answer, build a `urlv=3`
 * dedx_web calculator URL that opens pre-filled with the same
 * particle/material/program/energy the user is already looking at — "Open
 * in calculator →" in `AnswerCard.svelte`.
 *
 * Scoped to *shapes* dedx_web's basic calculator can represent on its own:
 * a single particle/material/program, either forward (one or more energy
 * rows — `compareDim: "energy"` is exactly that) or inverse (one target
 * value). Multi-entity comparisons (`compareDim: "material"` / `"particle"`
 * / `"program"`) need dedx_web's advanced-mode multi-select (`across=`/
 * `particles=`/`materials=`/`programs=`) and are out of scope here — see
 * issue #10. Returning `null` for anything unrepresentable is deliberate: a
 * missing link is harmless, a link that opens dedx_web with different
 * numbers than the ones just shown would undermine the whole trust loop.
 *
 * The emitted URL always carries `mode=advanced`, even for these
 * basic-shaped queries: dedx_web's Basic mode has no program selector and
 * silently resets `program=` to Auto-select on load (dedx_web #816), which
 * can select a different program than the one the answer was actually
 * computed with — see issue #116.
 *
 * Param names/ids/units are taken from `APTG/dedx_web`'s
 * `docs/04-feature-specs/shareable-urls-formal.md` grammar and
 * `src/lib/utils/calculator-url.ts`, with one deliberate deviation: the
 * inverse-mode params (`imode=`/`iunit=`) use the *shipped* dedx_web app's
 * names, not the formal spec's not-yet-implemented `calc=`/`runit=`/
 * `sunit=` (dedx_web issue #840) — emitting the formal names would produce
 * a link that silently fails to pre-fill on the actually-deployed site.
 */
import type { EnergySlot, EnergyUnit, QueryIntent } from "../intent/query-intent.ts";
import type { ComputeResult } from "../compute/compute.ts";

/**
 * `urlv=3` is only understood by dedx_web's dev deployment — the stable
 * `aptg.github.io/web` is still the old React app. Single named constant so
 * this is a one-line change once dedx_web's v2 promotes to the stable URL.
 */
const DEDX_WEB_CALCULATOR_BASE_URL = "https://aptg.github.io/web_dev/calculator";

/** `uanchor=` only has these 3 base tokens; keV/GeV values ride as a per-row `:unit` suffix. */
type DedxWebEnergyAnchor = "MeV" | "MeV/nucl" | "MeV/u";

const ENERGY_UNIT_TO_DEDXWEB: Record<EnergyUnit, { anchor: DedxWebEnergyAnchor; suffix?: string }> =
  {
    MeV: { anchor: "MeV" },
    keV: { anchor: "MeV", suffix: "keV" },
    GeV: { anchor: "MeV", suffix: "GeV" },
    "MeV/nucl": { anchor: "MeV/nucl" },
    "MeV/u": { anchor: "MeV/u" },
  };

/** Length units dedx_web's inverse-CSDA `iunit=` accepts; aidedx's `g/cm2` has no equivalent. */
const RANGE_UNIT_TO_DEDXWEB: Readonly<Record<string, string>> = {
  cm: "cm",
  mm: "mm",
  um: "um",
};

/** aidedx's 3 STP target units (`matcher.ts`'s `STP_TARGET_RES`), mapped to dedx_web's tokens. */
const STP_UNIT_TO_DEDXWEB: Readonly<Record<string, string>> = {
  "keV/um": "kev-um",
  "MeV/cm": "mev-cm",
  "MeV cm2/g": "mev-cm2-g",
};

/**
 * `null` when `energies` is empty (nothing to encode) or mixes anchor
 * families that can't share one `uanchor=` — e.g. a `MeV` row alongside a
 * `MeV/nucl` row. The matcher itself never produces a mixed list, but chip
 * edits (`edit-intent.ts`'s `withEnergy`) can retarget a single row's unit
 * independently, so this has to be checked at build time, not assumed.
 * Only `keV`/`GeV` can ride as a per-row suffix against a `MeV` anchor;
 * `MeV/nucl`/`MeV/u` rows have no such escape hatch if the anchor differs.
 */
function encodeEnergies(
  energies: EnergySlot[],
): { anchor: DedxWebEnergyAnchor; list: string } | null {
  const first = energies[0];
  if (!first) return null;
  const anchor = ENERGY_UNIT_TO_DEDXWEB[first.unit].anchor;
  if (energies.some((e) => ENERGY_UNIT_TO_DEDXWEB[e.unit].anchor !== anchor)) return null;
  const list = energies
    .map((e) => {
      const mapped = ENERGY_UNIT_TO_DEDXWEB[e.unit];
      return mapped.suffix ? `${e.value}:${mapped.suffix}` : `${e.value}`;
    })
    .join("~");
  return { anchor, list };
}

/** Builds the dedx_web calculator URL for this answer, or `null` when the shape can't be represented (see module doc). */
export function buildDedxWebCalculatorUrl(
  intent: QueryIntent,
  result: ComputeResult,
): string | null {
  const isForward = intent.quantity === "stoppingPower" || intent.quantity === "csdaRange";
  const representable =
    intent.compareDim === "none" || (intent.compareDim === "energy" && isForward);
  if (!representable) return null;

  const series = result.series[0];
  if (!series || series.error !== undefined) return null;

  const params = new URLSearchParams();
  params.set("urlv", "3");
  // mode=advanced, not "basic": dedx_web's Basic mode has no program selector
  // and silently resets program= to Auto-select on load (dedx_web #816) even
  // when the id is otherwise correct — a MSTAR-based answer would open the
  // calculator on auto-selected ICRU 73 instead (issue #116). Advanced mode
  // is the only mode that honors an explicit program=.
  params.set("mode", "advanced");
  params.set("particle", String(series.particle.id));
  params.set("material", String(series.material.id));
  params.set("program", String(series.program.id));

  if (isForward) {
    const encoded = encodeEnergies(intent.energies);
    if (!encoded) return null;
    params.set("energies", encoded.list);
    params.set("uanchor", encoded.anchor);
  } else {
    const target = intent.target;
    if (!target) return null;
    if (intent.quantity === "energyFromRange") {
      const unit = RANGE_UNIT_TO_DEDXWEB[target.unit];
      if (!unit) return null;
      params.set("imode", "csda");
      params.set("lookups", `${target.value}:${unit}`);
      params.set("iunit", unit);
    } else {
      const unit = STP_UNIT_TO_DEDXWEB[target.unit];
      if (!unit) return null;
      params.set("imode", "stp");
      params.set("lookups", `${target.value}:${unit}`);
      params.set("iunit", unit);
    }
  }

  return `${DEDX_WEB_CALCULATOR_BASE_URL}?${params.toString()}`;
}
