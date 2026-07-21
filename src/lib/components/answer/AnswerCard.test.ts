import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/svelte";
import AnswerCard from "./AnswerCard.svelte";
import type { QueryIntent } from "$lib/intent/query-intent.ts";
import type { ComputeResult } from "$lib/compute/compute.ts";

const DUPLICATE_LINES = [
  "Stopping power of protons in water, by energy:",
  "- 100 MeV: 7.29 MeV·cm²/g (PSTAR)",
  "- 100 MeV: 7.29 MeV·cm²/g (PSTAR)",
];

function firstCallArg<T>(mock: { mock: { calls: unknown[][] } }): T {
  const call = mock.mock.calls[0];
  if (!call) throw new Error("mock was not called");
  return call[0] as T;
}

// intent/result default to null and onEditIntent to a no-op so existing
// phase-focused tests don't need to restate them on every call.
const BASE_PROPS = { intent: null, result: null, onEditIntent: () => {} };

const TEST_INTENT: QueryIntent = {
  quantity: "csdaRange",
  compareDim: "none",
  particles: [{ match: "protons" }],
  materials: [{ match: "PMMA" }],
  energies: [{ value: 40, unit: "MeV" }],
  assumptions: ["heard: per napelion → read as: per nucleon"],
  confidence: 0.97,
};

const TEST_RESULT: ComputeResult = {
  quantity: "csdaRange",
  compareDim: "none",
  series: [
    {
      label: "PMMA",
      particle: { id: 1, name: "Hydrogen", massNumber: 1, isotope: "¹H" },
      material: { id: 224, name: "Lucite, Perspex, Plexiglas" },
      program: { id: 2, name: "PSTAR" },
      points: [{ energyMeVPerNucl: 40, csdaRange: 1.529 }],
    },
  ],
  assumptions: [],
  libdedxVersion: "1.4.0",
};

describe("AnswerCard", () => {
  afterEach(() => {
    cleanup();
  });

  it("renders nothing when idle", () => {
    const { container } = render(AnswerCard, {
      props: { phase: "idle", lines: [], message: null, ...BASE_PROPS },
    });
    // Svelte leaves an anchor comment for the untaken {#if} block, so check
    // for visible content rather than a literally empty container.
    expect(container.textContent).toBe("");
  });

  it("shows a Computing indicator", () => {
    const { getByRole } = render(AnswerCard, {
      props: { phase: "computing", lines: [], message: null, ...BASE_PROPS },
    });
    expect(getByRole("status")).toHaveTextContent("Computing…");
  });

  it("renders a single-sentence answer", () => {
    const { getByRole } = render(AnswerCard, {
      props: {
        phase: "answered",
        lines: ["The CSDA range of 40 MeV protons in PMMA is 1.529 g/cm² (PSTAR)."],
        message: null,
        ...BASE_PROPS,
      },
    });
    expect(getByRole("status")).toHaveTextContent(
      "The CSDA range of 40 MeV protons in PMMA is 1.529 g/cm² (PSTAR).",
    );
  });

  it("groups consecutive comparison lines into a single list", () => {
    const { getByRole, getAllByRole } = render(AnswerCard, {
      props: {
        phase: "answered",
        lines: [
          "Stopping power of 100 MeV/nucl neon ions, by material:",
          "- water: 8.5 MeV·cm²/g (MSTAR)",
          "- air: 6.1 MeV·cm²/g (MSTAR)",
        ],
        message: null,
        ...BASE_PROPS,
      },
    });

    expect(getByRole("status")).toHaveTextContent("by material:");
    const items = getAllByRole("listitem");
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveTextContent("water: 8.5 MeV·cm²/g (MSTAR)");
    expect(items[1]).toHaveTextContent("air: 6.1 MeV·cm²/g (MSTAR)");
  });

  it("keeps every item when consecutive comparison lines are textually identical", () => {
    // Two requested energies can legitimately format to the same line (e.g.
    // "compare … at 100 and 100 MeV"). List items are keyed by index, not by
    // their own text, specifically so this doesn't collide.
    const { getAllByRole, rerender } = render(AnswerCard, {
      props: { phase: "answered", lines: DUPLICATE_LINES, message: null, ...BASE_PROPS },
    });
    expect(getAllByRole("listitem")).toHaveLength(2);

    // Re-render with the same duplicate-text list to exercise Svelte's keyed
    // `{#each}` diffing path (a text-keyed collision only misbehaves on update,
    // not on first mount).
    rerender({ phase: "answered", lines: DUPLICATE_LINES, message: null, ...BASE_PROPS });
    const items = getAllByRole("listitem");
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveTextContent("100 MeV: 7.29 MeV·cm²/g (PSTAR)");
    expect(items[1]).toHaveTextContent("100 MeV: 7.29 MeV·cm²/g (PSTAR)");
  });

  it("de-emphasizes a trailing assumptions note", () => {
    const { getByText } = render(AnswerCard, {
      props: {
        phase: "answered",
        lines: [
          "The CSDA range of 240 keV carbon ion in water is 0.0001234 g/cm² (MSTAR).",
          "Note: carbon → ¹²C.",
        ],
        message: null,
        ...BASE_PROPS,
      },
    });
    expect(getByText("Note: carbon → ¹²C.")).toHaveClass("text-muted-foreground");
  });

  it("shows the unmatched message", () => {
    const { getByRole } = render(AnswerCard, {
      props: {
        phase: "unmatched",
        lines: [],
        message: "Sorry, I couldn't understand that as a stopping-power or range question.",
        ...BASE_PROPS,
      },
    });
    expect(getByRole("status")).toHaveTextContent("couldn't understand");
  });

  it("shows the error message with an alert role", () => {
    const { getByRole } = render(AnswerCard, {
      props: {
        phase: "error",
        lines: [],
        message: "Electron stopping powers are not available in libdedx v1.4.0",
        ...BASE_PROPS,
      },
    });
    expect(getByRole("alert")).toHaveTextContent("Electron stopping powers are not available");
  });

  it("renders slot chips and the assumptions panel when intent/result are provided", () => {
    const { getByRole, getByText } = render(AnswerCard, {
      props: {
        phase: "answered",
        lines: ["The CSDA range of 40 MeV protons in PMMA is 1.529 g/cm² (PSTAR)."],
        message: null,
        intent: TEST_INTENT,
        result: TEST_RESULT,
        onEditIntent: () => {},
      },
    });

    expect(getByRole("button", { name: /edit particle: proton/i })).toBeInTheDocument();
    expect(getByRole("button", { name: /edit material: PMMA/i })).toBeInTheDocument();
    expect(getByRole("button", { name: /edit energy: 40 MeV/i })).toBeInTheDocument();
    expect(getByText("heard: per napelion → read as: per nucleon")).toBeInTheDocument();
  });

  it("does not render chips when intent/result are null", () => {
    const { queryByRole } = render(AnswerCard, {
      props: {
        phase: "answered",
        lines: ["The CSDA range of 40 MeV protons in PMMA is 1.529 g/cm² (PSTAR)."],
        message: null,
        ...BASE_PROPS,
      },
    });
    expect(queryByRole("button", { name: /edit particle/i })).not.toBeInTheDocument();
    expect(queryByRole("button", { name: /details/i })).not.toBeInTheDocument();
  });

  it("hides program/version provenance until 'Details' is opened", async () => {
    const { getByRole, queryByText, getByText } = render(AnswerCard, {
      props: {
        phase: "answered",
        lines: ["The CSDA range of 40 MeV protons in PMMA is 1.529 g/cm² (PSTAR)."],
        message: null,
        intent: TEST_INTENT,
        result: TEST_RESULT,
        onEditIntent: () => {},
      },
    });

    expect(queryByText(/libdedx 1\.4\.0/)).not.toBeInTheDocument();
    const detailsButton = getByRole("button", { name: "Details" });
    expect(detailsButton).toHaveAttribute("aria-expanded", "false");

    await detailsButton.click();

    expect(detailsButton).toHaveAttribute("aria-expanded", "true");
    expect(getByText(/PSTAR · libdedx 1\.4\.0/)).toBeInTheDocument();
  });

  it("calls onEditIntent with a corrected intent when a chip edit is committed", async () => {
    const onEditIntent = vi.fn();
    const { getByRole } = render(AnswerCard, {
      props: {
        phase: "answered",
        lines: ["The CSDA range of 40 MeV protons in PMMA is 1.529 g/cm² (PSTAR)."],
        message: null,
        intent: TEST_INTENT,
        result: TEST_RESULT,
        onEditIntent,
      },
    });

    const chip = getByRole("button", { name: /edit material: PMMA/i });
    await chip.click();
    const input = getByRole("textbox", { name: /material/i });
    (input as HTMLInputElement).value = "water";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));

    expect(onEditIntent).toHaveBeenCalledTimes(1);
    const next = firstCallArg<QueryIntent>(onEditIntent);
    expect(next.materials[0]).toEqual({ match: "water" });
    expect(next.assumptions).toEqual([]);
  });
});
