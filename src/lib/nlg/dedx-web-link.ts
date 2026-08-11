/**
 * dedx_web calculator deep link (issue #10 trust loop, final item): given
 * the `QueryIntent` + `ComputeResult` behind an answer, build a `urlv=3`
 * dedx_web calculator URL that opens pre-filled with the same
 * particle/material/program/energy the user is already looking at — "Open
 * in calculator →" in `AnswerCard.svelte`.
 *
 * Scoped to *shapes* dedx_web can represent on either calculator surface: a
 * single particle/material/program (Basic or Advanced mode), or a
 * multi-entity comparison across materials/particles/programs (Advanced
 * mode's `across=`/`materials=`/`particles=`/`programs=` multi-select —
 * `compareDim: "material"` / `"particle"` / `"program"`). Either forward
 * (one or more energy rows — `compareDim: "energy"` is exactly that) or
 * inverse (one target value) quantities are supported. Returning `null` for
 * anything unrepresentable is deliberate: a missing link is harmless, a link
 * that opens dedx_web with different numbers than the ones just shown would
 * undermine the whole trust loop.
 *
 * Single-entity mode selection: Basic mode (`mode=basic`, the default) is
 * used whenever the program was auto-selected — i.e. `intent.program` wasn't
 * user-specified. This relies on `compute.ts`'s `autoProgramForParticle()`
 * mirroring dedx_web's own Auto-select chain (`AUTO_SELECT_CHAIN`/
 * energy-aware fallthrough, dedx_web#871/#872) exactly, so dedx_web's
 * Basic-mode Auto-select — which always re-derives the program from
 * particle+material+energy and ignores any `program=` in the URL
 * (dedx_web#816) — independently lands on the same program aidedx already
 * computed with. When the user named an explicit program (`intent.program`
 * set), Basic mode *can't* represent that choice at all (no program
 * selector, and Auto-select would silently override it), so the link falls
 * back to `mode=advanced&program=<id>` instead — see issue #116.
 *
 * Multi-entity comparisons (`compareDim: "material"` / `"particle"` /
 * `"program"`) always need Advanced mode — Basic mode has no multi-select at
 * all. Comparing materials or particles reuses the same auto-vs-explicit
 * logic: `program=auto` when `intent.program` wasn't user-specified (each
 * compared row re-derives its own program via the same mirrored Auto-select
 * chain, exactly like the Basic-mode case above), or `program=<id>` when it
 * was. Comparing programs (`across=programs`) has no "auto" concept at all —
 * the varying programs *are* the comparison, so `programs=<id1>~<id2>~...`
 * always lists the actual resolved ids. Rows that failed to compute (a
 * material/particle/program combination out of range or unsupported) are
 * dropped from the comparison lists entirely rather than encoding an id
 * dedx_web can't reproduce a value for; if every row failed, there's nothing
 * left to link to and the whole URL is `null`.
 *
 * Param names/ids/units are taken from `APTG/dedx_web`'s
 * `docs/04-feature-specs/shareable-urls-formal.md` grammar and
 * `src/lib/utils/calculator-url.ts`, with one deliberate deviation: the
 * inverse-mode params (`imode=`/`iunit=`) use the *shipped* dedx_web app's
 * names, not the formal spec's not-yet-implemented `calc=`/`runit=`/
 * `sunit=` (dedx_web issue #840) — emitting the formal names would produce
 * a link that silently fails to pre-fill on the actually-deployed site.
 */
import {
  isInverseQuantity,
  type EnergySlot,
  type EnergyUnit,
  type QueryIntent,
  type RangeTargetUnit,
  type StpTargetUnit,
} from "../intent/query-intent.ts";
import { isRangeTargetUnit, isStpTargetUnit, type ComputeResult } from "../compute/compute.ts";

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
    // UNVERIFIED against the actual dedx_web calculator's accepted `:unit` suffix list — added
    // to satisfy this Record's exhaustiveness check for the new TeV unit (issue #151). TeV
    // energies are also astronomically outside every libdedx program's valid range
    // (compute.smoke.test.ts: PSTAR tops out at 10 GeV/nucl), so this link should rarely if
    // ever actually fire for TeV in practice.
    TeV: { anchor: "MeV", suffix: "TeV" },
    "MeV/nucl": { anchor: "MeV/nucl" },
    "MeV/u": { anchor: "MeV/u" },
  };

/**
 * Length units dedx_web's inverse-CSDA `iunit=` accepts; `null` for the two `RangeTargetUnit`
 * members it has no equivalent for (`m` — no metre token; `g/cm2` — an areal density, not a
 * length `iunit=` can express).
 *
 * issue #163 C11 — keyed on the closed `RangeTargetUnit` union (matching `ENERGY_UNIT_TO_DEDXWEB`
 * above), not a loose `Record<string, string>`: a unit added to `RANGE_TARGET_UNITS` without an
 * entry here used to degrade this link to `null` *silently* rather than fail the build — the
 * third consumer B1/B2's exhaustiveness fix (`compute.ts`'s `RANGE_TARGET_UNIT_TO_CM`) missed.
 * `string | null` (not just `string`) makes the two deliberate "no equivalent" gaps an explicit
 * decision every member of the union has to make, not an accidental omission.
 */
const RANGE_UNIT_TO_DEDXWEB: Readonly<Record<RangeTargetUnit, string | null>> = {
  cm: "cm",
  mm: "mm",
  um: "um",
  m: null,
  "g/cm2": null,
};

/** aidedx's 3 STP target units (`matcher.ts`'s `STP_TARGET_RES`), mapped to dedx_web's tokens.
 * issue #163 C11 — keyed on the closed `StpTargetUnit` union, same reasoning as
 * `RANGE_UNIT_TO_DEDXWEB` above; all 3 members already have a real dedx_web token. */
const STP_UNIT_TO_DEDXWEB: Readonly<Record<StpTargetUnit, string>> = {
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

/**
 * Joins resolved entity ids for an advanced-mode `materials=`/`particles=`/
 * `programs=` list, in the same order the comparison's series appear in.
 * `~` is the v3-canonical list separator (issue #672) — same as
 * `encodeEnergies()`'s energy lists.
 */
function joinEntityIds(ids: number[]): string {
  return ids.map(String).join("~");
}

/** Builds the dedx_web calculator URL for this answer, or `null` when the shape can't be represented (see module doc). */
export function buildDedxWebCalculatorUrl(
  intent: QueryIntent,
  result: ComputeResult,
): string | null {
  const isForward = !isInverseQuantity(intent.quantity);
  // "energy" (multiple energy rows against one entity) only makes sense for
  // forward quantities; every other compareDim (including inverse queries)
  // is representable via the entity-params handling below.
  if (intent.compareDim === "energy" && !isForward) return null;

  // Rows that errored (out of range / unsupported combination) are dropped —
  // encoding an id dedx_web can't reproduce a value for would silently
  // misrepresent the comparison. If nothing survives, there's no answer to
  // link to.
  const successful = result.series.filter((s) => s.error === undefined);
  const primary = successful[0];
  if (!primary) return null;

  const params = new URLSearchParams();
  params.set("urlv", "3");

  // An explicit program request (e.g. "using ICRU73") has no Basic-mode
  // equivalent — Basic mode hides the program selector and always
  // re-derives it via Auto-select (dedx_web#816), silently discarding this
  // choice. Advanced mode + an explicit program= is the only way to
  // reproduce it. Otherwise (the common case) the program was auto-selected,
  // and Auto-select — now mirroring `autoProgramForParticle()` exactly,
  // energy included — independently resolves to the same program per row.
  //
  // issue #163 C11 — `resolveProgramId()` now *throws* for an `intent.program` name it can't
  // resolve (B5/B6, #167) rather than silently falling back to auto-select, so for any real
  // `computeIntent()` result, every surviving row here already shares the same program id when
  // `intent.program` is set: `resolveProgramId()` doesn't vary by material/particle once a name
  // resolves. The `successful.every(...)` check below is accordingly defense-in-depth, not a
  // guard against a presently-reachable divergence — `buildDedxWebCalculatorUrl()` takes
  // `intent`/`result` as plain data, not exclusively `computeIntent()`'s own output, so it still
  // refuses to force a single id onto rows that (however they got that way) don't actually agree,
  // rather than risk a link that shows different numbers than the ones just computed.
  const explicitProgram =
    Boolean(intent.program) && successful.every((s) => s.program.id === primary.program.id);

  if (intent.compareDim === "material") {
    params.set("mode", "advanced");
    params.set("across", "materials");
    params.set("particle", String(primary.particle.id));
    params.set("materials", joinEntityIds(successful.map((s) => s.material.id)));
    params.set("program", explicitProgram ? String(primary.program.id) : "auto");
  } else if (intent.compareDim === "particle") {
    params.set("mode", "advanced");
    params.set("across", "particles");
    params.set("material", String(primary.material.id));
    params.set("particles", joinEntityIds(successful.map((s) => s.particle.id)));
    params.set("program", explicitProgram ? String(primary.program.id) : "auto");
  } else if (intent.compareDim === "program") {
    // No "auto" concept here — the varying programs across rows *are* the
    // comparison, so the actual resolved ids are always listed explicitly.
    params.set("mode", "advanced");
    params.set("across", "programs");
    params.set("particle", String(primary.particle.id));
    params.set("material", String(primary.material.id));
    params.set("programs", joinEntityIds(successful.map((s) => s.program.id)));
  } else {
    params.set("particle", String(primary.particle.id));
    params.set("material", String(primary.material.id));
    if (explicitProgram) {
      params.set("mode", "advanced");
      params.set("program", String(primary.program.id));
    } else {
      params.set("mode", "basic");
    }
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
      // `target.unit`'s static type is the wider `RangeTargetUnit | StpTargetUnit` (TargetSlot's
      // own doc comment: the valid subset is implied by `quantity`, not a second discriminant
      // field) — narrowed here the same way compute.ts's exhaustive converters do, so a
      // mismatched target (a bug elsewhere, not something this module should ever guess past)
      // returns `null` rather than a link with the wrong numbers.
      if (!isRangeTargetUnit(target.unit)) return null;
      const unit = RANGE_UNIT_TO_DEDXWEB[target.unit];
      if (!unit) return null;
      params.set("imode", "csda");
      params.set("lookups", `${target.value}:${unit}`);
      params.set("iunit", unit);
    } else if (intent.quantity === "energyFromStp") {
      if (!isStpTargetUnit(target.unit)) return null;
      const unit = STP_UNIT_TO_DEDXWEB[target.unit];
      if (!unit) return null;
      params.set("imode", "stp");
      params.set("lookups", `${target.value}:${unit}`);
      params.set("iunit", unit);
    } else {
      // issue #163 (Copilot review on #178) — the `else` branch above used to assume any
      // non-`energyFromRange` inverse quantity was `energyFromStp`, true only because
      // `QUANTITY_KIND`'s "inverse" set currently has exactly two members. A future third
      // inverse quantity would otherwise silently fall into stopping-power mode and produce a
      // link with the wrong numbers instead of the `null` ("can't represent this shape") every
      // other unrepresentable case in this module returns.
      return null;
    }
  }

  return `${DEDX_WEB_CALCULATOR_BASE_URL}?${params.toString()}`;
}
