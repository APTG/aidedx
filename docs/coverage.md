# Coverage: what aidedx can and cannot compute

**Generated — do not edit by hand.** Regenerate after any alias-table or libdedx change:

```sh
pnpm generate:coverage
```

Source: [`src/lib/aliases/`](../src/lib/aliases/) for particle/material names, the vendored libdedx WASM (`static/wasm/`, version 0.0.0-unknown) for program coverage.

## Particles

Any of the 118 elements Z=1–118 (Hydrogen–Oganesson) can be named as an ion — by element name, symbol, or a recognized spelling variant (see [aliases.md](aliases.md)). A bare element name assumes its most-abundant isotope; an explicit isotope ("carbon-13", "¹³C") overrides that.

These names are recognized directly, with a fixed isotope:

| Name | Resolves to |
| --- | --- |
| proton | ¹H |
| deuteron | ²H |
| triton | ³H |
| alpha particle | ⁴He |
| electron | — |

## Materials

### Elements (Z=1–98, 98 elements)

The first 98 elements (Z=1–98) — named the same way as under Particles above (element name, symbol, or spelling variant) — can also be used as a pure elemental target:

H, He, Li, Be, B, C, N, O, F, Ne, Na, Mg, Al, Si, P, S, Cl, Ar, K, Ca, Sc, Ti, V, Cr, Mn, Fe, Co, Ni, Cu, Zn, Ga, Ge, As, Se, Br, Kr, Rb, Sr, Y, Zr, Nb, Mo, Tc, Ru, Rh, Pd, Ag, Cd, In, Sn, Sb, Te, I, Xe, Cs, Ba, La, Ce, Pr, Nd, Pm, Sm, Eu, Gd, Tb, Dy, Ho, Er, Tm, Yb, Lu, Hf, Ta, W, Re, Os, Ir, Pt, Au, Hg, Tl, Pb, Bi, Po, At, Rn, Fr, Ra, Ac, Th, Pa, U, Np, Pu, Am, Cm, Bk, Cf

### Compounds & mixtures (149)

| id | name |
| --- | --- |
| 99 | A-150 Tissue-Equivalent Plastic |
| 103 | Adipose Tissue (ICRP) |
| 104 | Air (dry, near sea level) |
| 106 | Aluminum Oxide |
| 113 | Barium Fluoride |
| 114 | Barium Sulfate |
| 116 | Beryllium Oxide |
| 117 | Bismuth Germanium Oxide |
| 118 | Blood (ICRP) |
| 119 | Bone, Compact (ICRU) |
| 120 | Bone, Cortical (ICRP) |
| 121 | Boron Carbide |
| 122 | Boron Oxide |
| 123 | Brain (ICRP) |
| 127 | Cadmium Telluride |
| 128 | Cadmium Tungstate |
| 129 | Calcium Carbonate |
| 130 | Calcium Fluoride |
| 131 | Calcium Oxide |
| 132 | Calcium Sulfate |
| 133 | Calcium Tungstate |
| 134 | Carbon Dioxide |
| 135 | Carbon Tetrachloride |
| 136 | Cellulose Acetate (Cellophane) |
| 137 | Cellulose Acetate Butyrate |
| 138 | Cellulose Nitrate |
| 139 | Ceric Sulfate Dosimeter Solution |
| 140 | Cesium Fluoride |
| 141 | Cesium Iodide |
| 142 | Chlorobenzene |
| 143 | Chloroform |
| 144 | Concrete (Portland) |
| 145 | Cyclohexane |
| 146 | Dichlorobenzene |
| 147 | Dichlorodiethyl Ether |
| 148 | Dichloroethane |
| 149 | Diethyl Ether |
| 151 | Dimethyl Sulfoxide |
| 152 | Ethane |
| 153 | Ethyl Alcohol |
| 154 | Ethyl Cellulose |
| 155 | Ethylene |
| 156 | Eye Lens (ICRP) |
| 157 | Ferric Oxide |
| 159 | Ferrous Oxide |
| 160 | Ferrous Sulfate Dosimeter Solution |
| 161 | Freon-12 |
| 162 | Freon-12B2 |
| 163 | Freon-13 |
| 164 | Freon-13B1 |
| 165 | Freon-13I1 |
| 166 | Gadolinium Oxysulfide |
| 167 | Gallium Arsenide |
| 168 | Gel in Photographic Emulsion |
| 170 | Glass (Lead) |
| 171 | Glass (Plate) |
| 169 | Glass (Pyrex) |
| 172 | Glucose |
| 174 | Glycerol |
| 906 | Graphite |
| 176 | Gypsum (Plaster of Paris) |
| 179 | Kapton Polyimide Film |
| 180 | Lanthanum Oxybromide |
| 181 | Lanthanum Oxysulfide |
| 182 | Lead Oxide |
| 183 | Lithium Amide |
| 184 | Lithium Carbonate |
| 185 | Lithium Fluoride |
| 186 | Lithium Hydride |
| 187 | Lithium Iodide |
| 188 | Lithium Oxide |
| 189 | Lithium Tetraborate |
| 190 | Lung (ICRP) |
| 192 | Magnesium Carbonate |
| 193 | Magnesium Fluoride |
| 194 | Magnesium Oxide |
| 195 | Magnesium Tetraborate |
| 196 | Mercuric Iodide |
| 200 | MS20 Tissue Substitute |
| 203 | Muscle-Equivalent Liquid (with sucrose) |
| 204 | Muscle-Equivalent Liquid (without sucrose) |
| 201 | Muscle, Skeletal |
| 202 | Muscle, Striated |
| 222 | Mylar (PET) |
| 125 | N-Butyl Alcohol |
| 177 | N-Heptane |
| 178 | N-Hexane |
| 214 | N-Pentane |
| 240 | N-Propyl Alcohol |
| 150 | N,N-Dimethylformamide |
| 208 | Nylon (DuPont Elvamide 8062) |
| 211 | Nylon Type 11 (Rilsan) |
| 209 | Nylon Type 6 and 6/6 |
| 210 | Nylon Type 6-10 |
| 212 | Octane (liquid) |
| 213 | Paraffin Wax |
| 215 | Photographic Emulsion |
| 216 | Plastic Scintillator (vinyltoluene-based) |
| 217 | Plutonium Dioxide |
| 223 | PMMA (Plexiglass) |
| 218 | Polyacrylonitrile |
| 219 | Polycarbonate (Makrolon/Lexan) |
| 220 | Polychlorostyrene |
| 221 | Polyethylene |
| 224 | Polyoxymethylene |
| 225 | Polypropylene |
| 226 | Polystyrene |
| 227 | Polytetrafluoroethylene (Teflon) |
| 228 | Polytrifluorochloroethylene |
| 229 | Polyvinyl Acetate |
| 230 | Polyvinyl Alcohol |
| 231 | Polyvinyl Butyral |
| 232 | Polyvinyl Chloride (PVC) |
| 234 | Polyvinylidene Fluoride |
| 235 | Polyvinylpyrrolidone |
| 236 | Potassium Iodide |
| 237 | Potassium Oxide |
| 239 | Propane (liquid) |
| 242 | Rubber (butyl) |
| 243 | Rubber (natural) |
| 244 | Rubber (neoprene) |
| 233 | Saran |
| 245 | Silicon Dioxide |
| 246 | Silver Bromide |
| 247 | Silver Chloride |
| 248 | Silver Halides in Photographic Emulsion |
| 249 | Silver Iodide |
| 250 | Skin (ICRP) |
| 251 | Sodium Carbonate |
| 252 | Sodium Iodide |
| 253 | Sodium Monoxide |
| 254 | Sodium Nitrate |
| 258 | Testes (ICRP) |
| 259 | Tetrachloroethylene |
| 260 | Thallium Chloride |
| 263 | Tissue-Equivalent Gas (methane-based) |
| 264 | Tissue-Equivalent Gas (propane-based) |
| 261 | Tissue, Soft (ICRP) |
| 262 | Tissue, Soft (ICRU four-component) |
| 265 | Titanium Dioxide |
| 267 | Trichloroethylene |
| 268 | Triethyl Phosphate |
| 269 | Tungsten Hexafluoride |
| 270 | Uranium Dicarbide |
| 271 | Uranium Monocarbide |
| 272 | Uranium Oxide |
| 275 | Viton Fluoroelastomer |
| 276 | Water (liquid) |
| 277 | Water Vapor |

## Stopping-power programs

libdedx tabulates each program's data over its own particle and material lists. The auto-selector (`autoProgramForParticle()` in `src/lib/compute/compute.ts`) walks a chain of these per particle and falls back to the general Bethe formula (`Bethe`/`Bethe-ext` below) when nothing more specific has data — so most particle/material pairs resolve even when no *specific* program covers them.

| Program | Ions covered | Materials covered |
| --- | --- | --- |
| ASTAR | Helium (Z=2) | 74 |
| PSTAR | Hydrogen (Z=1) | 74 |
| ESTAR | electron | 0 |
| MSTAR | Helium–Argon (Z=2–18) | 78 |
| ICRU73 (old) | Lithium–Argon (Z=3–18) | 74 |
| ICRU73 | Lithium–Argon (Z=3–18) | 74 |
| ICRU49 | Hydrogen–Helium (Z=1–2) | 74 |
| Bethe | Hydrogen–Copernicium (Z=1–112) | 279 |
| Bethe-ext | Hydrogen–Copernicium (Z=1–112) | 279 |

## Known gaps

Computed from the tables above, not hand-maintained: a particle or material appears here when no program both lists it *and* has any tabulated material/particle data at all — an empty program (ESTAR's material list is currently empty) doesn't count as coverage even though the particle nominally appears in its ion list.

**Particles with no usable stopping-power data under any program:**

- Nihonium (Z=113)
- Flerovium (Z=114)
- Moscovium (Z=115)
- Livermorium (Z=116)
- Tennessine (Z=117)
- Oganesson (Z=118)
- electron (Z=—)

No material in the tables above is missing coverage under every program.

