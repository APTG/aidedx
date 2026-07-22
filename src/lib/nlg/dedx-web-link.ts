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
  const isForward = intent.quantity === "stoppingPower" || intent.quantity === "csdaRange";
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
  // `intent.program` is free text, though: `resolveProgramId()` silently
  // falls back to auto-select when the name isn't recognized (unlike this
  // module, it has no way to report that back). If it did fall back, a
  // material/particle comparison can have each row auto-resolve to a
  // *different* program despite `intent.program` being set — so "explicit"
  // is only trusted when every surviving row actually agrees on one program
  // id; a would-be-explicit request that diverged across rows falls back to
  // `program=auto` instead of forcing a single id that would misrepresent
  // the other rows.
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
