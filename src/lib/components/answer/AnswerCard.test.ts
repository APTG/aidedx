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

// intent/result/defaultsNotice/reAskNotice/reAskTarget default to null and
// onEditIntent to a no-op so existing phase-focused tests don't need to
// restate them on every call.
const BASE_PROPS = {
  intent: null,
  result: null,
  defaultsNotice: null,
  reAskNotice: null,
  reAskTarget: null,
  onEditIntent: () => {},
};

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
      points: [{ energyMeVPerNucl: 40, values: { csdaRange: 1.529 } }],
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

  it("hides slot chips until 'Edit' is opened, then shows them", async () => {
    const { getByRole, getByText, queryByRole } = render(AnswerCard, {
      props: {
        phase: "answered",
        lines: ["The CSDA range of 40 MeV protons in PMMA is 1.529 g/cm² (PSTAR)."],
        message: null,
        intent: TEST_INTENT,
        result: TEST_RESULT,
        defaultsNotice: null,
        reAskNotice: null,
        reAskTarget: null,
        onEditIntent: () => {},
      },
    });

    expect(queryByRole("button", { name: /edit particle/i })).not.toBeInTheDocument();
    const editButton = getByRole("button", { name: "Edit" });
    expect(editButton).toHaveAttribute("aria-expanded", "false");

    await editButton.click();

    expect(editButton).toHaveAttribute("aria-expanded", "true");
    expect(getByRole("button", { name: /edit particle: proton/i })).toBeInTheDocument();
    expect(getByRole("button", { name: /edit material: PMMA/i })).toBeInTheDocument();
    expect(getByRole("button", { name: /edit energy: 40 MeV/i })).toBeInTheDocument();
    expect(getByText("heard: per napelion → read as: per nucleon")).toBeInTheDocument();
  });

  it("does not render an Edit toggle when intent/result are null", () => {
    const { queryByRole } = render(AnswerCard, {
      props: {
        phase: "answered",
        lines: ["The CSDA range of 40 MeV protons in PMMA is 1.529 g/cm² (PSTAR)."],
        message: null,
        ...BASE_PROPS,
      },
    });
    expect(queryByRole("button", { name: "Edit" })).not.toBeInTheDocument();
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
        defaultsNotice: null,
        reAskNotice: null,
        reAskTarget: null,
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

  it("renders the dedx_web 'Open in calculator' link for a representable answer", () => {
    const { getByRole } = render(AnswerCard, {
      props: {
        phase: "answered",
        lines: ["The CSDA range of 40 MeV protons in PMMA is 1.529 g/cm² (PSTAR)."],
        message: null,
        intent: TEST_INTENT,
        result: TEST_RESULT,
        defaultsNotice: null,
        reAskNotice: null,
        reAskTarget: null,
        onEditIntent: () => {},
      },
    });

    // Full accessible name includes the sr-only new-tab/destination suffix —
    // the WCAG-relevant assertion, not just the visible "Open in calculator →" text.
    const link = getByRole("link", {
      name: "Open in calculator → (opens dedx_web in a new tab)",
    });
    expect(link).toHaveAttribute(
      "href",
      "https://aptg.github.io/web_dev/calculator?urlv=3&particle=1&material=224&mode=basic&energies=40&uanchor=MeV",
    );
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
  });

  it("renders an advanced-mode dedx_web link for a multi-entity comparison answer", () => {
    const comparisonIntent: QueryIntent = {
      ...TEST_INTENT,
      compareDim: "material",
      materials: [{ match: "PMMA" }, { match: "water" }],
    };
    const pmmaSeries = {
      label: "PMMA",
      particle: { id: 1, name: "Hydrogen", massNumber: 1, isotope: "¹H" },
      material: { id: 224, name: "Lucite, Perspex, Plexiglas" },
      program: { id: 2, name: "PSTAR" },
      points: [{ energyMeVPerNucl: 40, values: { csdaRange: 1.529 } }],
    };
    const comparisonResult: ComputeResult = {
      ...TEST_RESULT,
      compareDim: "material",
      series: [pmmaSeries, { ...pmmaSeries, label: "water", material: { id: 276, name: "Water" } }],
    };
    const { getByRole } = render(AnswerCard, {
      props: {
        phase: "answered",
        lines: [
          "CSDA range of 40 MeV protons, by material:",
          "- PMMA: 1.529 g/cm² (PSTAR)",
          "- water: 1.6 g/cm² (PSTAR)",
        ],
        message: null,
        intent: comparisonIntent,
        result: comparisonResult,
        defaultsNotice: null,
        reAskNotice: null,
        reAskTarget: null,
        onEditIntent: () => {},
      },
    });

    const link = getByRole("link", {
      name: "Open in calculator → (opens dedx_web in a new tab)",
    });
    expect(link).toHaveAttribute(
      "href",
      "https://aptg.github.io/web_dev/calculator?urlv=3&mode=advanced&across=materials&particle=1&materials=224%7E276&program=auto&energies=40&uanchor=MeV",
    );
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
        defaultsNotice: null,
        reAskNotice: null,
        reAskTarget: null,
        onEditIntent,
      },
    });

    await getByRole("button", { name: "Edit" }).click();
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

  it("shows a re-ask notice, reuses the defaults-notice styling, auto-opens the chips, highlights the flagged chip, and doesn't steal focus", () => {
    const { getByRole, getByText } = render(AnswerCard, {
      props: {
        phase: "answered",
        lines: ["The CSDA range of 240 keV protons in PMMA is 1.529 g/cm² (PSTAR)."],
        message: null,
        intent: TEST_INTENT,
        result: TEST_RESULT,
        defaultsNotice: null,
        reAskNotice: "240 keV is outside the valid range. Did you mean 240 MeV?",
        reAskTarget: { slot: "energy", index: 0 },
        onEditIntent: () => {},
      },
    });

    const notice = getByText("240 keV is outside the valid range. Did you mean 240 MeV?");
    expect(notice).toHaveAttribute("id", "answer-reask");
    expect(notice).toHaveClass("border-warning/40", "bg-warning/5", "text-warning");

    // Chips are already open, without clicking "Edit" first.
    expect(getByRole("button", { name: "Hide edit" })).toHaveAttribute("aria-expanded", "true");

    // The flagged chip carries the highlight in its accessible name (not
    // color alone, per WCAG 1.4.1) and points back at the banner.
    const energyChip = getByRole("button", {
      name: "Edit energy: 40 MeV — needs confirmation",
    });
    expect(energyChip).toHaveAttribute("aria-describedby", "answer-reask");

    // Nothing moved focus off the document body.
    expect(document.activeElement).not.toBe(energyChip);
  });

  it("omits the re-ask notice and highlight when there is none", () => {
    const { queryByText, getByRole } = render(AnswerCard, {
      props: {
        phase: "answered",
        lines: ["The CSDA range of 40 MeV protons in PMMA is 1.529 g/cm² (PSTAR)."],
        message: null,
        intent: TEST_INTENT,
        result: TEST_RESULT,
        defaultsNotice: null,
        reAskNotice: null,
        reAskTarget: null,
        onEditIntent: () => {},
      },
    });

    expect(queryByText(/needs confirmation/)).not.toBeInTheDocument();
    expect(getByRole("button", { name: "Edit" })).toHaveAttribute("aria-expanded", "false");
  });

  it("shows a defaults notice and auto-opens the chips when slots were defaulted", () => {
    const { getByRole, getByText } = render(AnswerCard, {
      props: {
        phase: "answered",
        lines: ["The CSDA range of 40 MeV protons in PMMA is 1.529 g/cm² (PSTAR)."],
        message: null,
        intent: TEST_INTENT,
        result: TEST_RESULT,
        defaultsNotice:
          "Your question was missing some details, so I filled them in: material not specified → water.",
        reAskNotice: null,
        reAskTarget: null,
        onEditIntent: () => {},
      },
    });

    expect(getByText(/Your question was missing some details/)).toBeInTheDocument();
    // The chips should already be visible without clicking "Edit" first.
    expect(getByRole("button", { name: "Hide edit" })).toHaveAttribute("aria-expanded", "true");
    expect(getByRole("button", { name: /edit particle: proton/i })).toBeInTheDocument();
  });

  it("omits the defaults notice for a normal, fully-specified answer", () => {
    const { queryByText, getByRole } = render(AnswerCard, {
      props: {
        phase: "answered",
        lines: ["The CSDA range of 40 MeV protons in PMMA is 1.529 g/cm² (PSTAR)."],
        message: null,
        intent: TEST_INTENT,
        result: TEST_RESULT,
        defaultsNotice: null,
        reAskNotice: null,
        reAskTarget: null,
        onEditIntent: () => {},
      },
    });

    expect(queryByText(/missing some details/)).not.toBeInTheDocument();
    expect(getByRole("button", { name: "Edit" })).toHaveAttribute("aria-expanded", "false");
  });

  it("collapses Edit/Details again for a brand-new answer (intent goes null in between, as submit() does)", async () => {
    const { getByRole, rerender } = render(AnswerCard, {
      props: {
        phase: "answered",
        lines: ["The CSDA range of 40 MeV protons in PMMA is 1.529 g/cm² (PSTAR)."],
        message: null,
        intent: TEST_INTENT,
        result: TEST_RESULT,
        defaultsNotice: null,
        reAskNotice: null,
        reAskTarget: null,
        onEditIntent: () => {},
      },
    });

    await getByRole("button", { name: "Edit" }).click();
    await getByRole("button", { name: "Details" }).click();
    expect(getByRole("button", { name: "Hide edit" })).toHaveAttribute("aria-expanded", "true");
    expect(getByRole("button", { name: "Hide details" })).toHaveAttribute("aria-expanded", "true");

    // submit() nulls intent/result synchronously before a fresh match/compute.
    await rerender({
      phase: "computing",
      lines: [],
      message: null,
      intent: null,
      result: null,
      defaultsNotice: null,
      reAskNotice: null,
      reAskTarget: null,
      onEditIntent: () => {},
    });
    await rerender({
      phase: "answered",
      lines: ["The stopping power of 100 MeV protons in water is 0.73 keV/µm (PSTAR)."],
      message: null,
      intent: { ...TEST_INTENT, materials: [{ match: "water" }] },
      result: TEST_RESULT,
      defaultsNotice: null,
      reAskNotice: null,
      reAskTarget: null,
      onEditIntent: () => {},
    });

    expect(getByRole("button", { name: "Edit" })).toHaveAttribute("aria-expanded", "false");
    expect(getByRole("button", { name: "Details" })).toHaveAttribute("aria-expanded", "false");
  });

  it("keeps Edit open across a chip-edit recompute (intent stays non-null throughout, as recompute() does)", async () => {
    const { getByRole, rerender } = render(AnswerCard, {
      props: {
        phase: "answered",
        lines: ["The CSDA range of 40 MeV protons in PMMA is 1.529 g/cm² (PSTAR)."],
        message: null,
        intent: TEST_INTENT,
        result: TEST_RESULT,
        defaultsNotice: null,
        reAskNotice: null,
        reAskTarget: null,
        onEditIntent: () => {},
      },
    });

    await getByRole("button", { name: "Edit" }).click();
    expect(getByRole("button", { name: "Hide edit" })).toHaveAttribute("aria-expanded", "true");

    // recompute() leaves the previous intent/result populated during
    // "computing" — it never nulls them the way submit() does.
    await rerender({
      phase: "computing",
      lines: [],
      message: null,
      intent: TEST_INTENT,
      result: TEST_RESULT,
      defaultsNotice: null,
      reAskNotice: null,
      reAskTarget: null,
      onEditIntent: () => {},
    });
    await rerender({
      phase: "answered",
      lines: ["The CSDA range of 40 MeV protons in water is 1.6 g/cm² (PSTAR)."],
      message: null,
      intent: { ...TEST_INTENT, materials: [{ match: "water" }] },
      result: TEST_RESULT,
      defaultsNotice: null,
      reAskNotice: null,
      reAskTarget: null,
      onEditIntent: () => {},
    });

    expect(getByRole("button", { name: "Hide edit" })).toHaveAttribute("aria-expanded", "true");
  });
});
