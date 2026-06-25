# Material & particle alias tables

Maps natural-language phrases ("PMMA", "carbon ions", "lung tissue") to
canonical **libdedx** materials and particles. These tables are the
deterministic matcher's accuracy backbone and are designed to be reusable by
[dedx_web](https://github.com/APTG/dedx_web)'s text search.

- Code: [`src/lib/aliases/`](../src/lib/aliases/)
- Shipped JSON: [`static/aliases/`](../static/aliases/) (served at
  `/<base>/aliases/materials.json` and `/particles.json`)
- Issue: [APTG/aidedx#4](https://github.com/APTG/aidedx/issues/4)

## Layout

| File                          | Responsibility                                                           |
| ----------------------------- | ------------------------------------------------------------------------ |
| `elements.ts`                 | Periodic-table seed: Z → symbol, name, default isotope mass number.      |
| `materials.ts`                | Canonical material catalogue + `alias → material id` index.              |
| `particles.ts`                | Canonical particle catalogue + `alias → (id, A, assumed)` index.         |
| `normalize.ts`                | Text normalization, isotope superscript formatting, bounded Levenshtein. |
| `lookup.ts`                   | `resolveMaterial()` / `resolveParticle()` (exact → normalized → fuzzy).  |
| `index.ts`                    | Public barrel.                                                           |
| `scripts/generate-aliases.ts` | Emits the JSON artifacts from the TS tables.                             |

## Lookup behaviour

`resolveMaterial(phrase)` and `resolveParticle(phrase)` try, in order:

1. **exact** — normalized phrase hits the alias index directly;
2. **normalized** — after stripping decorative suffixes ("ions", "particles",
   "beam", "target", "gas", …) and a trailing plural "s";
3. **isotope** (particles only) — explicit "carbon-13" / "³He" / "C-13" parsed
   and combined with the element table;
4. **fuzzy** — Levenshtein distance ≤ 1 (≤ 2 for longer phrases) to absorb
   typos like "watr" or "alumnium".

Each result carries a `matchKind` so callers can distinguish a confident exact
hit from a fuzzy guess.

### Isotope assumptions

A bare element name leaves the isotope unspecified, so the most-abundant isotope
is **assumed** (`isotopeAssumed: true`), e.g. `carbon ion → ¹²C`. A specific
particle name ("proton", "deuteron", "alpha", "helium-3") already pins the
isotope (`isotopeAssumed: false`). This mirrors the labelling convention in the
[eval set](../eval/intents.jsonl) (e.g. the assumption `carbon → ¹²C`).

## Provenance

| Data                                        | Source                                                                                                                  |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Element symbols & names (Z = 1–118)         | dedx_web `src/lib/utils/element-data.ts` (IUPAC).                                                                       |
| Default isotope mass numbers                | Most-abundant stable isotope, or the longest-lived one for elements with no stable isotope (periodic-table convention). |
| Elemental targets (material id = Z, 1–98)   | libdedx NIST elemental targets, as used by dedx_web.                                                                    |
| Compound / mixture materials (99–277, 906)  | dedx_web `src/lib/config/material-names.ts` → `MATERIAL_NAME_OVERRIDES` (curated rendering of libdedx ALL-CAPS names).  |
| Particle ids & symbols (Z, 1001 = electron) | dedx_web `src/lib/config/particle-aliases.ts` → `PARTICLE_ALIASES`.                                                     |
| Trade names / colloquialisms / eval phrases | Hand-curated in `materials.ts` / `particles.ts` (e.g. PMMA / Lucite / Perspex / Plexiglas → 223).                       |

The element/compound catalogues are **copied** from dedx_web rather than
imported, because aidedx ships zero libdedx/WASM in its initial bundle. Keep
them in sync when libdedx or dedx_web change (see "Regenerating" below).

## Regenerating the JSON

The JSON files are derived artifacts — **edit the TS tables, never the JSON**:

```sh
pnpm generate:aliases   # rewrites static/aliases/{materials,particles}.json
```

CI guards freshness: `aliases.test.ts` fails if the committed JSON differs from
what the generator would produce. The artifacts are excluded from Prettier (see
`.prettierignore`) so the generator is their sole formatter.

## When libdedx updates

1. If new elements/ions are exposed: add rows to `ELEMENTS` in `elements.ts`.
2. If the compound material list changes: update `COMPOUND_MATERIALS` in
   `materials.ts` to match dedx_web's `MATERIAL_NAME_OVERRIDES`.
3. Add any new trade names / colloquial aliases to the override lists.
4. Run `pnpm generate:aliases && pnpm test`.
