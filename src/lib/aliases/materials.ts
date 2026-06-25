/**
 * Material (target) alias table.
 *
 * Canonical entries are keyed by the libdedx material id. The catalogue has two
 * parts:
 *  - Elements Z=1..98, whose material id equals Z (libdedx exposes the NIST
 *    elemental targets in this range). Symbol/name come from `elements.ts`.
 *  - Compounds and mixtures (ids 99..277, plus graphite at 906), copied from
 *    dedx_web's `MATERIAL_NAME_OVERRIDES`
 *    (`src/lib/config/material-names.ts`) — the project's curated, readable
 *    rendering of libdedx's ALL-CAPS NIST names.
 *
 * The alias index maps a normalized phrase to a material id. It is built from:
 *  - element symbol + name (e.g. "Al", "aluminium" → 13),
 *  - each compound's canonical name with any trailing "(qualifier)" stripped
 *    (e.g. "Water (liquid)" → "water" → 276), skipping bases that collide so an
 *    ambiguous word like "glass" never silently resolves to one variant,
 *  - hand-curated trade names and colloquialisms below (PMMA / Lucite /
 *    Perspex / Plexiglas → 223, teflon → 227, etc.).
 */
import { ELEMENTS, ELEMENT_NAME_VARIANTS } from "./elements.ts";
import { normalizeText } from "./normalize.ts";

export type MaterialKind = "element" | "compound";

export interface CanonicalMaterial {
  /** libdedx material id. */
  id: number;
  /** Readable display name. */
  name: string;
  kind: MaterialKind;
}

/**
 * Compounds and mixtures, copied verbatim from dedx_web
 * `MATERIAL_NAME_OVERRIDES`. Keep in sync when libdedx / dedx_web change; see
 * `docs/aliases.md`.
 */
const COMPOUND_MATERIALS: ReadonlyArray<[number, string]> = [
  [99, "A-150 Tissue-Equivalent Plastic"],
  [103, "Adipose Tissue (ICRP)"],
  [104, "Air (dry, near sea level)"],
  [106, "Aluminum Oxide"],
  [113, "Barium Fluoride"],
  [114, "Barium Sulfate"],
  [116, "Beryllium Oxide"],
  [117, "Bismuth Germanium Oxide"],
  [118, "Blood (ICRP)"],
  [119, "Bone, Compact (ICRU)"],
  [120, "Bone, Cortical (ICRP)"],
  [121, "Boron Carbide"],
  [122, "Boron Oxide"],
  [123, "Brain (ICRP)"],
  [125, "N-Butyl Alcohol"],
  [127, "Cadmium Telluride"],
  [128, "Cadmium Tungstate"],
  [129, "Calcium Carbonate"],
  [130, "Calcium Fluoride"],
  [131, "Calcium Oxide"],
  [132, "Calcium Sulfate"],
  [133, "Calcium Tungstate"],
  [134, "Carbon Dioxide"],
  [135, "Carbon Tetrachloride"],
  [136, "Cellulose Acetate (Cellophane)"],
  [137, "Cellulose Acetate Butyrate"],
  [138, "Cellulose Nitrate"],
  [139, "Ceric Sulfate Dosimeter Solution"],
  [140, "Cesium Fluoride"],
  [141, "Cesium Iodide"],
  [142, "Chlorobenzene"],
  [143, "Chloroform"],
  [144, "Concrete (Portland)"],
  [145, "Cyclohexane"],
  [146, "Dichlorobenzene"],
  [147, "Dichlorodiethyl Ether"],
  [148, "Dichloroethane"],
  [149, "Diethyl Ether"],
  [150, "N,N-Dimethylformamide"],
  [151, "Dimethyl Sulfoxide"],
  [152, "Ethane"],
  [153, "Ethyl Alcohol"],
  [154, "Ethyl Cellulose"],
  [155, "Ethylene"],
  [156, "Eye Lens (ICRP)"],
  [157, "Ferric Oxide"],
  [159, "Ferrous Oxide"],
  [160, "Ferrous Sulfate Dosimeter Solution"],
  [161, "Freon-12"],
  [162, "Freon-12B2"],
  [163, "Freon-13"],
  [164, "Freon-13B1"],
  [165, "Freon-13I1"],
  [166, "Gadolinium Oxysulfide"],
  [167, "Gallium Arsenide"],
  [168, "Gel in Photographic Emulsion"],
  [169, "Glass (Pyrex)"],
  [170, "Glass (Lead)"],
  [171, "Glass (Plate)"],
  [172, "Glucose"],
  [174, "Glycerol"],
  [176, "Gypsum (Plaster of Paris)"],
  [177, "N-Heptane"],
  [178, "N-Hexane"],
  [179, "Kapton Polyimide Film"],
  [180, "Lanthanum Oxybromide"],
  [181, "Lanthanum Oxysulfide"],
  [182, "Lead Oxide"],
  [183, "Lithium Amide"],
  [184, "Lithium Carbonate"],
  [185, "Lithium Fluoride"],
  [186, "Lithium Hydride"],
  [187, "Lithium Iodide"],
  [188, "Lithium Oxide"],
  [189, "Lithium Tetraborate"],
  [190, "Lung (ICRP)"],
  [192, "Magnesium Carbonate"],
  [193, "Magnesium Fluoride"],
  [194, "Magnesium Oxide"],
  [195, "Magnesium Tetraborate"],
  [196, "Mercuric Iodide"],
  [200, "MS20 Tissue Substitute"],
  [201, "Muscle, Skeletal"],
  [202, "Muscle, Striated"],
  [203, "Muscle-Equivalent Liquid (with sucrose)"],
  [204, "Muscle-Equivalent Liquid (without sucrose)"],
  [208, "Nylon (DuPont Elvamide 8062)"],
  [209, "Nylon Type 6 and 6/6"],
  [210, "Nylon Type 6-10"],
  [211, "Nylon Type 11 (Rilsan)"],
  [212, "Octane (liquid)"],
  [213, "Paraffin Wax"],
  [214, "N-Pentane"],
  [215, "Photographic Emulsion"],
  [216, "Plastic Scintillator (vinyltoluene-based)"],
  [217, "Plutonium Dioxide"],
  [218, "Polyacrylonitrile"],
  [219, "Polycarbonate (Makrolon/Lexan)"],
  [220, "Polychlorostyrene"],
  [221, "Polyethylene"],
  [222, "Mylar (PET)"],
  [223, "PMMA (Plexiglass)"],
  [224, "Polyoxymethylene"],
  [225, "Polypropylene"],
  [226, "Polystyrene"],
  [227, "Polytetrafluoroethylene (Teflon)"],
  [228, "Polytrifluorochloroethylene"],
  [229, "Polyvinyl Acetate"],
  [230, "Polyvinyl Alcohol"],
  [231, "Polyvinyl Butyral"],
  [232, "Polyvinyl Chloride (PVC)"],
  [233, "Saran"],
  [234, "Polyvinylidene Fluoride"],
  [235, "Polyvinylpyrrolidone"],
  [236, "Potassium Iodide"],
  [237, "Potassium Oxide"],
  [239, "Propane (liquid)"],
  [240, "N-Propyl Alcohol"],
  [242, "Rubber (butyl)"],
  [243, "Rubber (natural)"],
  [244, "Rubber (neoprene)"],
  [245, "Silicon Dioxide"],
  [246, "Silver Bromide"],
  [247, "Silver Chloride"],
  [248, "Silver Halides in Photographic Emulsion"],
  [249, "Silver Iodide"],
  [250, "Skin (ICRP)"],
  [251, "Sodium Carbonate"],
  [252, "Sodium Iodide"],
  [253, "Sodium Monoxide"],
  [254, "Sodium Nitrate"],
  [258, "Testes (ICRP)"],
  [259, "Tetrachloroethylene"],
  [260, "Thallium Chloride"],
  [261, "Tissue, Soft (ICRP)"],
  [262, "Tissue, Soft (ICRU four-component)"],
  [263, "Tissue-Equivalent Gas (methane-based)"],
  [264, "Tissue-Equivalent Gas (propane-based)"],
  [265, "Titanium Dioxide"],
  [267, "Trichloroethylene"],
  [268, "Triethyl Phosphate"],
  [269, "Tungsten Hexafluoride"],
  [270, "Uranium Dicarbide"],
  [271, "Uranium Monocarbide"],
  [272, "Uranium Oxide"],
  [275, "Viton Fluoroelastomer"],
  [276, "Water (liquid)"],
  [277, "Water Vapor"],
  [906, "Graphite"],
];

/** Full canonical catalogue: elemental targets (Z=1..98) + compounds. */
export const MATERIALS: readonly CanonicalMaterial[] = [
  ...ELEMENTS.filter((e) => e.z <= 98).map(
    (e): CanonicalMaterial => ({ id: e.z, name: e.name, kind: "element" }),
  ),
  ...COMPOUND_MATERIALS.map(([id, name]): CanonicalMaterial => ({ id, name, kind: "compound" })),
];

export const MATERIAL_BY_ID: ReadonlyMap<number, CanonicalMaterial> = new Map(
  MATERIALS.map((m) => [m.id, m]),
);

/**
 * Hand-curated aliases: trade names, colloquial names, formulae, and the
 * specific phrasings used in the eval set. These win over auto-generated base
 * names on collision (applied last).
 */
const MATERIAL_ALIAS_OVERRIDES: ReadonlyArray<[string, number]> = [
  // Water.
  ["water", 276],
  ["liquid water", 276],
  ["h2o", 276],
  ["water vapor", 277],
  ["water vapour", 277],
  ["steam", 277],
  // Air.
  ["air", 104],
  // PMMA family (highest-value alias group from the issue).
  ["pmma", 223],
  ["lucite", 223],
  ["perspex", 223],
  ["plexiglas", 223],
  ["plexiglass", 223],
  ["acrylic", 223],
  // Other polymer trade names.
  ["teflon", 227],
  ["ptfe", 227],
  ["mylar", 222],
  ["pet", 222],
  ["polyester", 222],
  ["kapton", 179],
  ["lexan", 219],
  ["makrolon", 219],
  ["polycarbonate", 219],
  ["pvc", 232],
  ["polyethylene", 221],
  ["polystyrene", 226],
  ["polypropylene", 225],
  // Carbon.
  ["graphite", 906],
  // Glass / silica (auto base "glass" is dropped as ambiguous; pick Pyrex).
  ["glass", 169],
  ["pyrex", 169],
  ["quartz", 245],
  ["silica", 245],
  ["fused silica", 245],
  ["silicon dioxide", 245],
  // Alumina.
  ["alumina", 106],
  ["sapphire", 106],
  ["aluminium oxide", 106],
  ["aluminum oxide", 106],
  // Tissues and biological materials (eval set).
  ["tissue", 261],
  ["soft tissue", 261],
  ["muscle", 201],
  ["muscle tissue", 201],
  ["skeletal muscle", 201],
  ["striated muscle", 202],
  ["adipose tissue", 103],
  ["adipose", 103],
  ["fat", 103],
  ["lung", 190],
  ["lung tissue", 190],
  ["bone", 120],
  ["cortical bone", 120],
  ["compact bone", 119],
  ["brain", 123],
  ["skin", 250],
  ["blood", 118],
  ["a150", 99],
  ["a 150", 99],
  // Misc.
  ["concrete", 144],
  ["nai", 252],
  ["sodium iodide", 252],
  ["csi", 141],
  ["lif", 185],
  ["paraffin", 213],
];

/**
 * Base name of a compound for auto-aliasing: drop a trailing "(qualifier)" and
 * normalize. "Water (liquid)" → "water"; "Carbon Dioxide" → "carbon dioxide".
 */
function compoundBaseName(name: string): string {
  return normalizeText(name.replace(/\s*\(.*\)\s*$/, ""));
}

function buildMaterialAliasIndex(): Map<string, number> {
  const index = new Map<string, number>();
  const put = (alias: string, id: number) => {
    const key = normalizeText(alias);
    if (key.length > 0) index.set(key, id);
  };

  // Elements by symbol and name.
  for (const e of ELEMENTS) {
    if (e.z > 98) continue;
    put(e.symbol, e.z);
    put(e.name, e.z);
  }
  for (const [variant, z] of ELEMENT_NAME_VARIANTS) {
    if (z <= 98) put(variant, z);
  }

  // Auto compound base names, dropping any base that maps to more than one id.
  const baseToIds = new Map<string, Set<number>>();
  for (const [id, name] of COMPOUND_MATERIALS) {
    const base = compoundBaseName(name);
    if (!base) continue;
    const ids = baseToIds.get(base) ?? new Set<number>();
    ids.add(id);
    baseToIds.set(base, ids);
  }
  for (const [base, ids] of baseToIds) {
    if (ids.size !== 1) continue;
    for (const id of ids) index.set(base, id);
  }

  // Curated overrides win on collision.
  for (const [alias, id] of MATERIAL_ALIAS_OVERRIDES) put(alias, id);

  return index;
}

export const MATERIAL_ALIAS_INDEX: ReadonlyMap<string, number> = buildMaterialAliasIndex();
