/**
 * Periodic-table seed data shared by the material and particle alias tables.
 *
 * `symbol` and `name` are copied verbatim from dedx_web's
 * `src/lib/utils/element-data.ts` (IUPAC names) so the two projects agree on
 * spelling. `defaultMassNumber` is the mass number A of the most abundant
 * stable isotope, or — for elements with no stable isotope — the longest-lived
 * one (the value conventionally shown in parentheses on the periodic table).
 * It is the isotope assumed when a beam is named by its bare element name
 * (e.g. "carbon ion" → ¹²C). See `docs/aliases.md` for provenance.
 *
 * The table is the single source of truth for Z → (symbol, name, default A);
 * both `particles.ts` and `materials.ts` derive their element entries from it,
 * so a libdedx update that exposes a heavier ion only needs a row added here.
 */

export interface Element {
  /** Atomic number Z (1–118). */
  z: number;
  /** IUPAC chemical symbol, e.g. "H", "Fe". */
  symbol: string;
  /** IUPAC English name, e.g. "Hydrogen", "Iron". */
  name: string;
  /** Mass number A of the most abundant / most stable isotope. */
  defaultMassNumber: number;
}

export const ELEMENTS: readonly Element[] = [
  { z: 1, symbol: "H", name: "Hydrogen", defaultMassNumber: 1 },
  { z: 2, symbol: "He", name: "Helium", defaultMassNumber: 4 },
  { z: 3, symbol: "Li", name: "Lithium", defaultMassNumber: 7 },
  { z: 4, symbol: "Be", name: "Beryllium", defaultMassNumber: 9 },
  { z: 5, symbol: "B", name: "Boron", defaultMassNumber: 11 },
  { z: 6, symbol: "C", name: "Carbon", defaultMassNumber: 12 },
  { z: 7, symbol: "N", name: "Nitrogen", defaultMassNumber: 14 },
  { z: 8, symbol: "O", name: "Oxygen", defaultMassNumber: 16 },
  { z: 9, symbol: "F", name: "Fluorine", defaultMassNumber: 19 },
  { z: 10, symbol: "Ne", name: "Neon", defaultMassNumber: 20 },
  { z: 11, symbol: "Na", name: "Sodium", defaultMassNumber: 23 },
  { z: 12, symbol: "Mg", name: "Magnesium", defaultMassNumber: 24 },
  { z: 13, symbol: "Al", name: "Aluminium", defaultMassNumber: 27 },
  { z: 14, symbol: "Si", name: "Silicon", defaultMassNumber: 28 },
  { z: 15, symbol: "P", name: "Phosphorus", defaultMassNumber: 31 },
  { z: 16, symbol: "S", name: "Sulfur", defaultMassNumber: 32 },
  { z: 17, symbol: "Cl", name: "Chlorine", defaultMassNumber: 35 },
  { z: 18, symbol: "Ar", name: "Argon", defaultMassNumber: 40 },
  { z: 19, symbol: "K", name: "Potassium", defaultMassNumber: 39 },
  { z: 20, symbol: "Ca", name: "Calcium", defaultMassNumber: 40 },
  { z: 21, symbol: "Sc", name: "Scandium", defaultMassNumber: 45 },
  { z: 22, symbol: "Ti", name: "Titanium", defaultMassNumber: 48 },
  { z: 23, symbol: "V", name: "Vanadium", defaultMassNumber: 51 },
  { z: 24, symbol: "Cr", name: "Chromium", defaultMassNumber: 52 },
  { z: 25, symbol: "Mn", name: "Manganese", defaultMassNumber: 55 },
  { z: 26, symbol: "Fe", name: "Iron", defaultMassNumber: 56 },
  { z: 27, symbol: "Co", name: "Cobalt", defaultMassNumber: 59 },
  { z: 28, symbol: "Ni", name: "Nickel", defaultMassNumber: 58 },
  { z: 29, symbol: "Cu", name: "Copper", defaultMassNumber: 63 },
  { z: 30, symbol: "Zn", name: "Zinc", defaultMassNumber: 64 },
  { z: 31, symbol: "Ga", name: "Gallium", defaultMassNumber: 69 },
  { z: 32, symbol: "Ge", name: "Germanium", defaultMassNumber: 74 },
  { z: 33, symbol: "As", name: "Arsenic", defaultMassNumber: 75 },
  { z: 34, symbol: "Se", name: "Selenium", defaultMassNumber: 80 },
  { z: 35, symbol: "Br", name: "Bromine", defaultMassNumber: 79 },
  { z: 36, symbol: "Kr", name: "Krypton", defaultMassNumber: 84 },
  { z: 37, symbol: "Rb", name: "Rubidium", defaultMassNumber: 85 },
  { z: 38, symbol: "Sr", name: "Strontium", defaultMassNumber: 88 },
  { z: 39, symbol: "Y", name: "Yttrium", defaultMassNumber: 89 },
  { z: 40, symbol: "Zr", name: "Zirconium", defaultMassNumber: 90 },
  { z: 41, symbol: "Nb", name: "Niobium", defaultMassNumber: 93 },
  { z: 42, symbol: "Mo", name: "Molybdenum", defaultMassNumber: 98 },
  { z: 43, symbol: "Tc", name: "Technetium", defaultMassNumber: 98 },
  { z: 44, symbol: "Ru", name: "Ruthenium", defaultMassNumber: 102 },
  { z: 45, symbol: "Rh", name: "Rhodium", defaultMassNumber: 103 },
  { z: 46, symbol: "Pd", name: "Palladium", defaultMassNumber: 106 },
  { z: 47, symbol: "Ag", name: "Silver", defaultMassNumber: 107 },
  { z: 48, symbol: "Cd", name: "Cadmium", defaultMassNumber: 114 },
  { z: 49, symbol: "In", name: "Indium", defaultMassNumber: 115 },
  { z: 50, symbol: "Sn", name: "Tin", defaultMassNumber: 120 },
  { z: 51, symbol: "Sb", name: "Antimony", defaultMassNumber: 121 },
  { z: 52, symbol: "Te", name: "Tellurium", defaultMassNumber: 130 },
  { z: 53, symbol: "I", name: "Iodine", defaultMassNumber: 127 },
  { z: 54, symbol: "Xe", name: "Xenon", defaultMassNumber: 132 },
  { z: 55, symbol: "Cs", name: "Caesium", defaultMassNumber: 133 },
  { z: 56, symbol: "Ba", name: "Barium", defaultMassNumber: 138 },
  { z: 57, symbol: "La", name: "Lanthanum", defaultMassNumber: 139 },
  { z: 58, symbol: "Ce", name: "Cerium", defaultMassNumber: 140 },
  { z: 59, symbol: "Pr", name: "Praseodymium", defaultMassNumber: 141 },
  { z: 60, symbol: "Nd", name: "Neodymium", defaultMassNumber: 142 },
  { z: 61, symbol: "Pm", name: "Promethium", defaultMassNumber: 145 },
  { z: 62, symbol: "Sm", name: "Samarium", defaultMassNumber: 152 },
  { z: 63, symbol: "Eu", name: "Europium", defaultMassNumber: 153 },
  { z: 64, symbol: "Gd", name: "Gadolinium", defaultMassNumber: 158 },
  { z: 65, symbol: "Tb", name: "Terbium", defaultMassNumber: 159 },
  { z: 66, symbol: "Dy", name: "Dysprosium", defaultMassNumber: 164 },
  { z: 67, symbol: "Ho", name: "Holmium", defaultMassNumber: 165 },
  { z: 68, symbol: "Er", name: "Erbium", defaultMassNumber: 166 },
  { z: 69, symbol: "Tm", name: "Thulium", defaultMassNumber: 169 },
  { z: 70, symbol: "Yb", name: "Ytterbium", defaultMassNumber: 174 },
  { z: 71, symbol: "Lu", name: "Lutetium", defaultMassNumber: 175 },
  { z: 72, symbol: "Hf", name: "Hafnium", defaultMassNumber: 180 },
  { z: 73, symbol: "Ta", name: "Tantalum", defaultMassNumber: 181 },
  { z: 74, symbol: "W", name: "Tungsten", defaultMassNumber: 184 },
  { z: 75, symbol: "Re", name: "Rhenium", defaultMassNumber: 187 },
  { z: 76, symbol: "Os", name: "Osmium", defaultMassNumber: 192 },
  { z: 77, symbol: "Ir", name: "Iridium", defaultMassNumber: 193 },
  { z: 78, symbol: "Pt", name: "Platinum", defaultMassNumber: 195 },
  { z: 79, symbol: "Au", name: "Gold", defaultMassNumber: 197 },
  { z: 80, symbol: "Hg", name: "Mercury", defaultMassNumber: 202 },
  { z: 81, symbol: "Tl", name: "Thallium", defaultMassNumber: 205 },
  { z: 82, symbol: "Pb", name: "Lead", defaultMassNumber: 208 },
  { z: 83, symbol: "Bi", name: "Bismuth", defaultMassNumber: 209 },
  { z: 84, symbol: "Po", name: "Polonium", defaultMassNumber: 209 },
  { z: 85, symbol: "At", name: "Astatine", defaultMassNumber: 210 },
  { z: 86, symbol: "Rn", name: "Radon", defaultMassNumber: 222 },
  { z: 87, symbol: "Fr", name: "Francium", defaultMassNumber: 223 },
  { z: 88, symbol: "Ra", name: "Radium", defaultMassNumber: 226 },
  { z: 89, symbol: "Ac", name: "Actinium", defaultMassNumber: 227 },
  { z: 90, symbol: "Th", name: "Thorium", defaultMassNumber: 232 },
  { z: 91, symbol: "Pa", name: "Protactinium", defaultMassNumber: 231 },
  { z: 92, symbol: "U", name: "Uranium", defaultMassNumber: 238 },
  { z: 93, symbol: "Np", name: "Neptunium", defaultMassNumber: 237 },
  { z: 94, symbol: "Pu", name: "Plutonium", defaultMassNumber: 244 },
  { z: 95, symbol: "Am", name: "Americium", defaultMassNumber: 243 },
  { z: 96, symbol: "Cm", name: "Curium", defaultMassNumber: 247 },
  { z: 97, symbol: "Bk", name: "Berkelium", defaultMassNumber: 247 },
  { z: 98, symbol: "Cf", name: "Californium", defaultMassNumber: 251 },
  { z: 99, symbol: "Es", name: "Einsteinium", defaultMassNumber: 252 },
  { z: 100, symbol: "Fm", name: "Fermium", defaultMassNumber: 257 },
  { z: 101, symbol: "Md", name: "Mendelevium", defaultMassNumber: 258 },
  { z: 102, symbol: "No", name: "Nobelium", defaultMassNumber: 259 },
  { z: 103, symbol: "Lr", name: "Lawrencium", defaultMassNumber: 262 },
  { z: 104, symbol: "Rf", name: "Rutherfordium", defaultMassNumber: 267 },
  { z: 105, symbol: "Db", name: "Dubnium", defaultMassNumber: 268 },
  { z: 106, symbol: "Sg", name: "Seaborgium", defaultMassNumber: 269 },
  { z: 107, symbol: "Bh", name: "Bohrium", defaultMassNumber: 270 },
  { z: 108, symbol: "Hs", name: "Hassium", defaultMassNumber: 269 },
  { z: 109, symbol: "Mt", name: "Meitnerium", defaultMassNumber: 278 },
  { z: 110, symbol: "Ds", name: "Darmstadtium", defaultMassNumber: 281 },
  { z: 111, symbol: "Rg", name: "Roentgenium", defaultMassNumber: 282 },
  { z: 112, symbol: "Cn", name: "Copernicium", defaultMassNumber: 285 },
  { z: 113, symbol: "Nh", name: "Nihonium", defaultMassNumber: 286 },
  { z: 114, symbol: "Fl", name: "Flerovium", defaultMassNumber: 289 },
  { z: 115, symbol: "Mc", name: "Moscovium", defaultMassNumber: 290 },
  { z: 116, symbol: "Lv", name: "Livermorium", defaultMassNumber: 293 },
  { z: 117, symbol: "Ts", name: "Tennessine", defaultMassNumber: 294 },
  { z: 118, symbol: "Og", name: "Oganesson", defaultMassNumber: 294 },
];

/** Z → element, for O(1) lookup by atomic number. */
export const ELEMENT_BY_Z: ReadonlyMap<number, Element> = new Map(ELEMENTS.map((e) => [e.z, e]));

/**
 * Alternative spellings of element names not captured by the IUPAC `name`
 * column above (American/British variants, older trivial names). Shared by the
 * material and particle alias builders so "aluminum" and "aluminium" both
 * resolve. Mirrors the spelling variants carried in dedx_web's
 * `PARTICLE_ALIASES`.
 */
export const ELEMENT_NAME_VARIANTS: ReadonlyArray<[string, number]> = [
  ["aluminum", 13],
  ["sulphur", 16],
  ["cesium", 55],
  ["wolfram", 74],
];
