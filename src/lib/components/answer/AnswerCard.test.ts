import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/svelte";
import AnswerCard from "./AnswerCard.svelte";

const DUPLICATE_LINES = [
  "Stopping power of protons in water, by energy:",
  "- 100 MeV: 7.29 MeV·cm²/g (PSTAR)",
  "- 100 MeV: 7.29 MeV·cm²/g (PSTAR)",
];

describe("AnswerCard", () => {
  afterEach(() => {
    cleanup();
  });

  it("renders nothing when idle", () => {
    const { container } = render(AnswerCard, {
      props: { phase: "idle", lines: [], message: null },
    });
    // Svelte leaves an anchor comment for the untaken {#if} block, so check
    // for visible content rather than a literally empty container.
    expect(container.textContent).toBe("");
  });

  it("shows a Computing indicator", () => {
    const { getByRole } = render(AnswerCard, {
      props: { phase: "computing", lines: [], message: null },
    });
    expect(getByRole("status")).toHaveTextContent("Computing…");
  });

  it("renders a single-sentence answer", () => {
    const { getByRole } = render(AnswerCard, {
      props: {
        phase: "answered",
        lines: ["The CSDA range of 40 MeV protons in PMMA is 1.529 g/cm² (PSTAR)."],
        message: null,
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
      props: { phase: "answered", lines: DUPLICATE_LINES, message: null },
    });
    expect(getAllByRole("listitem")).toHaveLength(2);

    // Re-render with the same duplicate-text list to exercise Svelte's keyed
    // `{#each}` diffing path (a text-keyed collision only misbehaves on update,
    // not on first mount).
    rerender({ phase: "answered", lines: DUPLICATE_LINES, message: null });
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
      },
    });
    expect(getByRole("alert")).toHaveTextContent("Electron stopping powers are not available");
  });
});
