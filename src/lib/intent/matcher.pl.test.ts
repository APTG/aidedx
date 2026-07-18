import { describe, expect, it } from "vitest";
import { matchIntent, matchQueryIntent } from "./matcher.ts";
import { validateQueryIntent } from "./query-intent.ts";

/**
 * Every sentence from `eval/RECORDING.pl.md`'s 50-sentence ground-truth table
 * (issue #79/#87), run through `matchQueryIntent(text, "pl")`. This is the
 * empirical validation the Polish pack (`./lang/pl.ts`) was built against —
 * see that file's doc comment for the grammar reasoning behind each regex.
 */
const SENTENCES: ReadonlyArray<{
  id: string;
  text: string;
  quantity: string;
  minParticles?: number;
  minMaterials?: number;
}> = [
  {
    id: "pl-rng-01",
    text: "Jaki jest zasięg protonu o energii 150 MeV w wodzie?",
    quantity: "csdaRange",
  },
  {
    id: "pl-rng-02",
    text: "Ile wynosi zasięg CSDA protonu o energii 230 MeV w wodzie?",
    quantity: "csdaRange",
  },
  {
    id: "pl-rng-03",
    text: "Jak głęboko wniknie proton o energii 70 MeV w tkankę mięśniową?",
    quantity: "csdaRange",
  },
  {
    id: "pl-rng-04",
    text: "Jak daleko doleci cząstka alfa o energii 20 MeV w powietrzu?",
    quantity: "csdaRange",
  },
  {
    id: "pl-rng-05",
    text: "Podaj zasięg deuteronu o energii 60 MeV w krzemie.",
    quantity: "csdaRange",
  },
  {
    id: "pl-rng-06",
    text: "Jaki zasięg ma tryton o energii 40 MeV w PMMA?",
    quantity: "csdaRange",
  },
  {
    id: "pl-rng-07",
    text: "Oblicz zasięg jonu węgla-12 o energii 300 MeV na nukleon w wodzie.",
    quantity: "csdaRange",
  },
  {
    id: "pl-rng-08",
    text: "Na jaką głębokość wniknie jon tlenu o energii 250 MeV na nukleon w PMMA?",
    quantity: "csdaRange",
  },
  {
    id: "pl-rng-09",
    text: "Jaki jest zasięg jonu neonu o energii 400 MeV na nukleon w wodzie?",
    quantity: "csdaRange",
  },
  {
    id: "pl-rng-10",
    text: "Ile wynosi zasięg jonu żelaza o energii 600 MeV na nukleon w aluminium?",
    quantity: "csdaRange",
  },
  {
    id: "pl-rng-11",
    text: "Jak daleko dotrze jon wapnia o energii 200 MeV na nukleon w tkance tłuszczowej?",
    quantity: "csdaRange",
  },
  {
    id: "pl-rng-12",
    text: "Podaj zasięg jonu argonu o energii 350 MeV na nukleon w wodzie.",
    quantity: "csdaRange",
  },
  {
    id: "pl-rng-13",
    text: "Jaki zasięg ma jon azotu o energii 180 MeV na nukleon w kości korowej?",
    quantity: "csdaRange",
  },
  {
    id: "pl-rng-14",
    text: "Jak głęboko wniknie jon helu-3 o energii 30 MeV w grafit?",
    quantity: "csdaRange",
  },
  {
    id: "pl-rng-15",
    text: "Oblicz zasięg jonu litu o energii 50 MeV na nukleon w poliwęglanie.",
    quantity: "csdaRange",
  },
  {
    id: "pl-rng-16",
    text: "Jaki jest zasięg jonu boru o energii 100 MeV na nukleon w polietylenie?",
    quantity: "csdaRange",
  },
  {
    id: "pl-rng-17",
    text: "Jak daleko doleci jon krzemu o energii 300 MeV na nukleon w dwutlenku krzemu?",
    quantity: "csdaRange",
  },
  {
    id: "pl-rng-18",
    text: "Ile wynosi zasięg jonu miedzi o energii 500 MeV na nukleon w ołowiu?",
    quantity: "csdaRange",
  },
  {
    id: "pl-rng-19",
    text: "Podaj zasięg jonu kryptonu o energii 800 MeV na nukleon w aluminium.",
    quantity: "csdaRange",
  },
  {
    id: "pl-rng-20",
    text: "Jaki zasięg ma jon ksenonu o energii 400 MeV na nukleon w wodzie?",
    quantity: "csdaRange",
  },
  {
    id: "pl-rng-21",
    text: "Jak głęboko wniknie jon tytanu o energii 600 MeV na nukleon w wodzie?",
    quantity: "csdaRange",
  },
  {
    id: "pl-rng-22",
    text: "Powiedz mi, jak daleko zajdzie proton o energii 100 MeV w kości zbitej.",
    quantity: "csdaRange",
  },
  {
    id: "pl-rng-23",
    text: "Zasięg cząstki alfa o energii 10 MeV w Kaptonie – ile to wynosi?",
    quantity: "csdaRange",
  },
  {
    id: "pl-rng-24",
    text: "Jaki jest zasięg jonu magnezu o energii 150 MeV na nukleon w plastiku tkankopodobnym A-150?",
    quantity: "csdaRange",
  },
  {
    id: "pl-rng-25",
    text: "Jaki jest zasięg protonu w wodzie dla energii 100, 150 i 200 MeV?",
    quantity: "csdaRange",
  },
  {
    id: "pl-rng-26",
    text: "Porównaj zasięg jonu węgla w wodzie przy 200, 300 i 400 MeV na nukleon.",
    quantity: "csdaRange",
  },
  {
    id: "pl-rng-27",
    text: "Jak zmienia się zasięg cząstki alfa w powietrzu dla 5, 10 i 20 MeV?",
    quantity: "csdaRange",
  },
  {
    id: "pl-rng-28",
    text: "Porównaj zasięg protonu o energii 150 MeV w wodzie, PMMA i kości korowej.",
    quantity: "csdaRange",
    minMaterials: 3,
  },
  {
    id: "pl-rng-29",
    text: "Jaki jest zasięg jonu tlenu o energii 300 MeV na nukleon w wodzie i w aluminium?",
    quantity: "csdaRange",
    minMaterials: 2,
  },
  {
    id: "pl-rng-30",
    text: "Co wniknie głębiej w wodę przy 200 MeV na nukleon: jon węgla czy jon neonu?",
    quantity: "csdaRange",
    minParticles: 2,
  },
  {
    id: "pl-inv-01",
    text: "Jaką energię musi mieć proton, żeby jego zasięg w wodzie wynosił 20 cm?",
    quantity: "energyFromRange",
  },
  {
    id: "pl-inv-02",
    text: "Przy jakiej energii proton osiągnie zasięg 15 cm w wodzie?",
    quantity: "energyFromRange",
  },
  {
    id: "pl-inv-03",
    text: "Jaka energia protonu odpowiada zasięgowi 5 cm w PMMA?",
    quantity: "energyFromRange",
  },
  {
    id: "pl-inv-04",
    text: "Ile energii potrzebuje jon węgla, aby jego zasięg w wodzie wynosił 10 cm?",
    quantity: "energyFromRange",
  },
  {
    id: "pl-inv-05",
    text: "Jaką energię trzeba nadać cząstce alfa, aby miała zasięg 30 mm w tkance mięśniowej?",
    quantity: "energyFromRange",
  },
  {
    id: "pl-inv-06",
    text: "Przy jakiej energii jon żelaza osiągnie zasięg 3 cm w wodzie?",
    quantity: "energyFromRange",
  },
  {
    id: "pl-inv-07",
    text: "Jaką energię musi mieć jon tlenu, żeby dotrzeć na głębokość 12 cm w wodzie?",
    quantity: "energyFromRange",
  },
  {
    id: "pl-inv-08",
    text: "Ile energii potrzebuje proton na zasięg 8 cm w kości korowej?",
    quantity: "energyFromRange",
  },
  {
    id: "pl-inv-09",
    text: "Jaką energię musi mieć jon wapnia dla zasięgu 5 cm w PMMA?",
    quantity: "energyFromRange",
  },
  {
    id: "pl-inv-10",
    text: "Przy jakiej energii deuteron uzyska zasięg 50 mm w aluminium?",
    quantity: "energyFromRange",
  },
  {
    id: "pl-inv-11",
    text: "Jaką energię musi mieć proton, aby uzyskać zasięg 10 cm w wodzie i w PMMA?",
    quantity: "energyFromRange",
    minMaterials: 2,
  },
  {
    id: "pl-inv-12",
    text: "Jaką energię potrzebuje proton na zasięg 15 cm w wodzie? A jon węgla?",
    quantity: "energyFromRange",
    minParticles: 2,
  },
  {
    id: "pl-sp-01",
    text: "Jaki jest LET protonu o energii 100 MeV w wodzie?",
    quantity: "stoppingPower",
  },
  {
    id: "pl-sp-02",
    text: "Ile wynosi masowa zdolność hamowania jonu węgla o energii 200 MeV na nukleon w wodzie?",
    quantity: "stoppingPower",
  },
  {
    id: "pl-sp-03",
    text: "Ile energii traci proton o energii 10 MeV na centymetr drogi w aluminium?",
    quantity: "stoppingPower",
  },
  {
    id: "pl-sp-04",
    text: "Podaj dE/dx dla deuteronu o energii 40 MeV w powietrzu.",
    quantity: "stoppingPower",
  },
  {
    id: "pl-sp-05",
    text: "Jaki jest LET cząstki alfa o energii 5 MeV w krzemie?",
    quantity: "stoppingPower",
  },
  {
    id: "pl-sp-06",
    text: "Jaka jest zdolność hamowania jonu żelaza o energii 500 MeV na nukleon w złocie?",
    quantity: "stoppingPower",
  },
  {
    id: "pl-sp-07",
    text: "Porównaj zdolność hamowania protonu w wodzie przy 50, 100 i 150 MeV.",
    quantity: "stoppingPower",
  },
  {
    id: "pl-sp-08",
    text: "Porównaj LET jonu węgla o energii 300 MeV na nukleon w wodzie i w PMMA.",
    quantity: "stoppingPower",
    minMaterials: 2,
  },
];

describe("Polish pack — full RECORDING.pl.md coverage", () => {
  for (const c of SENTENCES) {
    it(`${c.id}: ${c.text}`, () => {
      const intent = matchQueryIntent(c.text, "pl");
      expect(intent.quantity).toBe(c.quantity);
      expect(intent.particles.length).toBeGreaterThanOrEqual(c.minParticles ?? 1);
      expect(intent.materials.length).toBeGreaterThanOrEqual(c.minMaterials ?? 1);
      if (c.quantity === "energyFromRange" || c.quantity === "energyFromStp") {
        expect(intent.target).toBeDefined();
      } else {
        expect(intent.energies.length).toBeGreaterThan(0);
      }
      expect(validateQueryIntent(intent, c.id)).toEqual([]);
    });
  }
});

describe("Polish pack — isotope resolution", () => {
  it("keeps an explicit isotope number on the head-first 'jon' construction", () => {
    const intent = matchQueryIntent(
      "Oblicz zasięg jonu węgla-12 o energii 300 MeV na nukleon w wodzie.",
      "pl",
    );
    expect(intent.particles[0]?.isotopeAssumed).toBeUndefined();
  });

  it("assumes the dominant isotope for a bare 'jon <element>' mention", () => {
    const intent = matchQueryIntent(
      "Jaki jest zasięg jonu neonu o energii 400 MeV na nukleon w wodzie?",
      "pl",
    );
    expect(intent.particles[0]).toEqual({ match: "jonu neonu", isotopeAssumed: "²⁰Ne" });
    expect(intent.assumptions).toContain("neon → ²⁰Ne");
  });

  it("disambiguates helium-3 from the default ⁴He via the isotope suffix", () => {
    const intent = matchQueryIntent(
      "Jak głęboko wniknie jon helu-3 o energii 30 MeV w grafit?",
      "pl",
    );
    expect(intent.particles[0]?.isotopeAssumed).toBeUndefined();
  });
});

describe("Polish pack — quantity detection edge cases", () => {
  it("reads 'Ile energii potrzebuje' as an inverse (solve-for-energy) cue", () => {
    expect(
      matchQueryIntent("Ile energii potrzebuje proton na zasięg 8 cm w kości korowej?", "pl")
        .quantity,
    ).toBe("energyFromRange");
  });

  it("does not mistake the forward energy-loss idiom 'Ile energii traci' for an inverse query", () => {
    // Both phrasings start "Ile energii", but "traci" (loses) is forward
    // stoppingPower, not a request to solve for energy — see BLANK_BEFORE_INVERSE_RE.
    const { intent, quantitySource } = matchIntent(
      "Ile energii traci proton o energii 10 MeV na centymetr drogi w aluminium?",
      "pl",
    );
    expect(intent.quantity).toBe("stoppingPower");
    expect(quantitySource).toBe("indirect");
  });

  it("reads the 'LET' acronym as stopping power, same as English", () => {
    const { intent, quantitySource } = matchIntent(
      "Jaki jest LET protonu o energii 100 MeV w wodzie?",
      "pl",
    );
    expect(intent.quantity).toBe("stoppingPower");
    expect(quantitySource).toBe("direct");
  });
});

describe("Polish pack — material n-gram matching stays clean", () => {
  it("resolves 'w wodzie' to the bare material, not a fuzzy hit with the preposition attached", () => {
    const intent = matchQueryIntent("Jaki jest zasięg protonu o energii 150 MeV w wodzie?", "pl");
    expect(intent.materials).toEqual([{ match: "wodzie" }]);
    expect(intent.confidence).toBe(0.97); // direct source, zero fuzzy discount
  });

  it("splits a two-material 'w wodzie i w aluminium' list cleanly", () => {
    const intent = matchQueryIntent(
      "Jaki jest zasięg jonu tlenu o energii 300 MeV na nukleon w wodzie i w aluminium?",
      "pl",
    );
    expect(intent.materials.map((m) => m.match)).toEqual(["wodzie", "aluminium"]);
    expect(intent.compareDim).toBe("material");
  });

  it("splits a three-material serial-comma list", () => {
    const intent = matchQueryIntent(
      "Porównaj zasięg protonu o energii 150 MeV w wodzie, PMMA i kości korowej.",
      "pl",
    );
    expect(intent.materials.map((m) => m.match)).toEqual(["wodzie", "PMMA", "kości korowej"]);
  });
});

describe("Polish pack — particle extraction (head-first 'jon <element>')", () => {
  it("extracts two independent 'jon' mentions from a self-contained either/or question", () => {
    const intent = matchQueryIntent(
      "Co wniknie głębiej w wodę przy 200 MeV na nukleon: jon węgla czy jon neonu?",
      "pl",
    );
    expect(intent.particles.map((p) => p.match)).toEqual(["jon węgla", "jon neonu"]);
    expect(intent.compareDim).toBe("particle");
  });

  it("extracts a bare named particle without the 'jon' head", () => {
    expect(
      matchQueryIntent("Jaki zasięg ma tryton o energii 40 MeV w PMMA?", "pl").particles,
    ).toEqual([{ match: "tryton" }]);
  });

  it("extracts the multi-word named particle 'cząstka alfa' in its declined forms", () => {
    expect(
      matchQueryIntent("Jak daleko doleci cząstka alfa o energii 20 MeV w powietrzu?", "pl")
        .particles,
    ).toEqual([{ match: "cząstka alfa" }]);
    expect(
      matchQueryIntent("Jaki jest LET cząstki alfa o energii 5 MeV w krzemie?", "pl").particles,
    ).toEqual([{ match: "cząstki alfa" }]);
  });
});

describe("Polish pack — energy list and per-nucleon parsing", () => {
  it("splits a serial-comma 'i' energy list", () => {
    const intent = matchQueryIntent(
      "Jaki jest zasięg protonu w wodzie dla energii 100, 150 i 200 MeV?",
      "pl",
    );
    expect(intent.energies.map((e) => e.value)).toEqual([100, 150, 200]);
    expect(intent.compareDim).toBe("energy");
  });

  it("reads 'na nukleon' as a per-nucleon MeV/nucl value", () => {
    const intent = matchQueryIntent(
      "Jaki jest zasięg jonu neonu o energii 400 MeV na nukleon w wodzie?",
      "pl",
    );
    expect(intent.energies[0]).toEqual({ value: 400, unit: "MeV/nucl", perNucleonAssumed: true });
  });
});

describe("Polish pack — language selection", () => {
  it("defaults to the English pack when no lang is given", () => {
    expect(matchQueryIntent("What is the range of 40 MeV protons in water?").quantity).toBe(
      "csdaRange",
    );
  });

  it("does not read English text correctly under the Polish pack", () => {
    // Sanity check that `lang` actually selects a different grammar: an
    // English-shaped "carbon ion" phrase doesn't parse as a Polish particle.
    const intent = matchQueryIntent("Range of a carbon ion in water at 90 MeV per nucleon.", "pl");
    expect(intent.particles).toEqual([]);
  });
});
