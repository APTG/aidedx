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
 * Basic mode (`mode=basic`, the default) is used whenever the program was
 * auto-selected — i.e. `intent.program` wasn't user-specified. This relies
 * on `compute.ts`'s `autoProgramForParticle()` mirroring dedx_web's own
 * Auto-select chain (`AUTO_SELECT_CHAIN`/energy-aware fallthrough,
 * dedx_web#871/#872) exactly, so dedx_web's Basic-mode Auto-select — which
 * always re-derives the program from particle+material+energy and ignores
 * any `program=` in the URL (dedx_web#816) — independently lands on the
 * same program aidedx already computed with. When the user named an
 * explicit program (`intent.program` set), Basic mode *can't* represent
 * that choice at all (no program selector, and Auto-select would silently
 * override it), so the link falls back to `mode=advanced&program=<id>`
 * instead — see issue #116.
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
  params.set("particle", String(series.particle.id));
  params.set("material", String(series.material.id));

  // An explicit program request (e.g. "using ICRU73") has no Basic-mode
  // equivalent — Basic mode hides the program selector and always
  // re-derives it via Auto-select (dedx_web#816), silently discarding this
  // choice. Advanced mode + an explicit program= is the only way to
  // reproduce it. Otherwise (the common case) the program was auto-selected,
  // and Basic mode's own Auto-select — now mirroring `autoProgramForParticle()`
  // exactly, energy included — independently resolves to the same program,
  // so mode=basic (dedx_web's default, no program= needed) is safe.
  if (intent.program) {
    params.set("mode", "advanced");
    params.set("program", String(series.program.id));
  } else {
    params.set("mode", "basic");
  }

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
