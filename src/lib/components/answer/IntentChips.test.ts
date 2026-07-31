import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/svelte";
import IntentChips from "./IntentChips.svelte";
import type { QueryIntent } from "$lib/intent/query-intent.ts";

function firstCallArg<T>(mock: { mock: { calls: unknown[][] } }): T {
  const call = mock.mock.calls[0];
  if (!call) throw new Error("mock was not called");
  return call[0] as T;
}

function baseIntent(overrides: Partial<QueryIntent> = {}): QueryIntent {
  return {
    quantity: "csdaRange",
    compareDim: "none",
    particles: [{ match: "helium-4" }],
    materials: [{ match: "watre" }],
    energies: [{ value: 214, unit: "keV" }],
    assumptions: [],
    confidence: 0.97,
    ...overrides,
  };
}

describe("IntentChips", () => {
  afterEach(() => {
    cleanup();
  });

  it("renders the quantity chip as a display-only label", () => {
    const { getByText } = render(IntentChips, {
      props: { intent: baseIntent(), onEditIntent: () => {} },
    });
    expect(getByText("range")).toBeInTheDocument();
  });

  it("renders the particle chip with the friendly display name, not the raw match", () => {
    const { getByRole } = render(IntentChips, {
      props: { intent: baseIntent(), onEditIntent: () => {} },
    });
    // "helium-4" resolves to the common name "alpha particle" (issue #10
    // naming rule): prefer common names over element-mass notation.
    expect(getByRole("button", { name: /edit particle: alpha particle/i })).toBeInTheDocument();
  });

  it("renders material and energy chips", () => {
    const { getByRole } = render(IntentChips, {
      props: { intent: baseIntent(), onEditIntent: () => {} },
    });
    expect(getByRole("button", { name: /edit material: watre/i })).toBeInTheDocument();
    expect(getByRole("button", { name: /edit energy: 214 keV/i })).toBeInTheDocument();
  });

  it("renders the energy chip's visible text with an explicit space, not template whitespace", () => {
    // toHaveTextContent() normalizes whitespace and would hide a build where
    // the number and unit render glued together ("214keV") — read
    // .textContent directly to catch that.
    const { getByRole } = render(IntentChips, {
      props: { intent: baseIntent(), onEditIntent: () => {} },
    });
    expect(getByRole("button", { name: /edit energy: 214 keV/i }).textContent).toBe("214 keV");
  });

  it("renders the assumptions panel verbatim", () => {
    const intent = baseIntent({ assumptions: ["heard: watre → read as: water"] });
    const { getByText } = render(IntentChips, { props: { intent, onEditIntent: () => {} } });
    expect(getByText("heard: watre → read as: water")).toBeInTheDocument();
  });

  it("omits the assumptions panel when there are no assumptions", () => {
    const { queryByRole } = render(IntentChips, {
      props: { intent: baseIntent(), onEditIntent: () => {} },
    });
    expect(queryByRole("list")).not.toBeInTheDocument();
  });

  it("tapping a particle chip reveals an editable input, and Enter commits the correction", async () => {
    const onEditIntent = vi.fn();
    const intent = baseIntent();
    const { getByRole } = render(IntentChips, { props: { intent, onEditIntent } });

    await fireEvent.click(getByRole("button", { name: /edit particle/i }));
    const input = getByRole("textbox", { name: /particle/i });
    await fireEvent.input(input, { target: { value: "carbon ion" } });
    await fireEvent.keyDown(input, { key: "Enter" });

    expect(onEditIntent).toHaveBeenCalledTimes(1);
    const next = firstCallArg<QueryIntent>(onEditIntent);
    expect(next.particles[0]).toEqual({ match: "carbon ion" });
  });

  it("committing an unchanged particle (label matches raw match's resolved display name) does not call onEditIntent", async () => {
    const onEditIntent = vi.fn();
    // "helium-4" resolves to the display label "alpha particle" — the input
    // opens prefilled with that label, not the raw match text.
    const intent = baseIntent({ particles: [{ match: "helium-4" }] });
    const { getByRole } = render(IntentChips, { props: { intent, onEditIntent } });

    await fireEvent.click(getByRole("button", { name: /edit particle/i }));
    const input = getByRole("textbox", { name: /particle/i });
    await fireEvent.keyDown(input, { key: "Enter" });

    expect(onEditIntent).not.toHaveBeenCalled();
  });

  it("Escape cancels an edit without calling onEditIntent", async () => {
    const onEditIntent = vi.fn();
    const { getByRole, queryByRole } = render(IntentChips, {
      props: { intent: baseIntent(), onEditIntent },
    });

    await fireEvent.click(getByRole("button", { name: /edit material/i }));
    const input = getByRole("textbox", { name: /material/i });
    await fireEvent.input(input, { target: { value: "some other material" } });
    await fireEvent.keyDown(input, { key: "Escape" });

    expect(onEditIntent).not.toHaveBeenCalled();
    expect(queryByRole("textbox", { name: /material/i })).not.toBeInTheDocument();
    expect(getByRole("button", { name: /edit material: watre/i })).toBeInTheDocument();
  });

  it("committing an unchanged value does not call onEditIntent", async () => {
    const onEditIntent = vi.fn();
    const intent = baseIntent();
    const { getByRole } = render(IntentChips, { props: { intent, onEditIntent } });

    await fireEvent.click(getByRole("button", { name: /edit material/i }));
    const input = getByRole("textbox", { name: /material/i });
    await fireEvent.keyDown(input, { key: "Enter" });

    expect(onEditIntent).not.toHaveBeenCalled();
  });

  it("selecting a different energy unit commits withEnergy", async () => {
    const onEditIntent = vi.fn();
    const intent = baseIntent();
    const { getByRole } = render(IntentChips, { props: { intent, onEditIntent } });

    await fireEvent.click(getByRole("button", { name: /edit energy: 214 keV/i }));
    const select = getByRole("combobox", { name: /energy unit/i });
    await fireEvent.change(select, { target: { value: "MeV" } });

    expect(onEditIntent).toHaveBeenCalledTimes(1);
    const next = firstCallArg<QueryIntent>(onEditIntent);
    expect(next.energies[0]).toEqual({ value: 214, unit: "MeV" });
  });

  it("editing the energy value then focusing away from the whole editor commits", async () => {
    const onEditIntent = vi.fn();
    const intent = baseIntent();
    const { getByRole } = render(IntentChips, { props: { intent, onEditIntent } });

    await fireEvent.click(getByRole("button", { name: /edit energy: 214 keV/i }));
    const valueInput = getByRole("spinbutton", { name: /energy value/i });
    await fireEvent.input(valueInput, { target: { value: "240" } });
    // Focus leaving the editor entirely (relatedTarget outside the group) —
    // not just moving from the value input to its own unit select.
    await fireEvent.focusOut(valueInput, { relatedTarget: document.body });

    expect(onEditIntent).toHaveBeenCalledTimes(1);
    const next = firstCallArg<QueryIntent>(onEditIntent);
    expect(next.energies[0]).toEqual({ value: 240, unit: "keV" });
  });

  it("moving focus from the energy value input to its own unit select does not commit prematurely", async () => {
    const onEditIntent = vi.fn();
    const intent = baseIntent();
    const { getByRole } = render(IntentChips, { props: { intent, onEditIntent } });

    await fireEvent.click(getByRole("button", { name: /edit energy: 214 keV/i }));
    const valueInput = getByRole("spinbutton", { name: /energy value/i });
    const unitSelect = getByRole("combobox", { name: /energy unit/i });
    await fireEvent.input(valueInput, { target: { value: "240" } });
    await fireEvent.focusOut(valueInput, { relatedTarget: unitSelect });

    expect(onEditIntent).not.toHaveBeenCalled();
    // The editor should still be open — the value input is still present.
    expect(getByRole("spinbutton", { name: /energy value/i })).toBeInTheDocument();
  });

  it("editing only the target value then focusing away from the whole editor commits", async () => {
    const onEditIntent = vi.fn();
    const intent = baseIntent({ quantity: "energyFromRange", target: { value: 10, unit: "cm" } });
    const { getByRole } = render(IntentChips, { props: { intent, onEditIntent } });

    await fireEvent.click(getByRole("button", { name: /edit target: 10 cm/i }));
    const valueInput = getByRole("spinbutton", { name: /target value/i });
    await fireEvent.input(valueInput, { target: { value: "20" } });
    await fireEvent.focusOut(valueInput, { relatedTarget: document.body });

    expect(onEditIntent).toHaveBeenCalledTimes(1);
    const next = firstCallArg<QueryIntent>(onEditIntent);
    expect(next.target).toEqual({ value: 20, unit: "cm" });
  });

  it("moving focus from the target value input to its own unit input does not commit prematurely", async () => {
    const onEditIntent = vi.fn();
    const intent = baseIntent({ quantity: "energyFromRange", target: { value: 10, unit: "cm" } });
    const { getByRole } = render(IntentChips, { props: { intent, onEditIntent } });

    await fireEvent.click(getByRole("button", { name: /edit target: 10 cm/i }));
    const valueInput = getByRole("spinbutton", { name: /target value/i });
    const unitInput = getByRole("textbox", { name: /target unit/i });
    await fireEvent.input(valueInput, { target: { value: "20" } });
    await fireEvent.focusOut(valueInput, { relatedTarget: unitInput });

    expect(onEditIntent).not.toHaveBeenCalled();
    expect(getByRole("spinbutton", { name: /target value/i })).toBeInTheDocument();
  });

  it("normalizes a retyped target unit's case/spacing/symbols before validating (Copilot review, PR #166)", async () => {
    // Before B1/B2's closed-union fix, this free-text field accepted (and then silently
    // miscomputed) any string. isTargetUnit()'s exact-match check closed that hole, but without
    // normalization it also silently drops an edit that's physically unambiguous to a physicist
    // just because the case/spacing/symbols don't match the canonical display string exactly.
    const onEditIntent = vi.fn();
    const intent = baseIntent({
      quantity: "energyFromStp",
      target: { value: 10, unit: "MeV/cm" },
    });
    const { getByRole } = render(IntentChips, { props: { intent, onEditIntent } });

    await fireEvent.click(getByRole("button", { name: /edit target: 10 MeV\/cm/i }));
    const unitInput = getByRole("textbox", { name: /target unit/i });
    await fireEvent.input(unitInput, { target: { value: "kev/µm" } });
    await fireEvent.focusOut(unitInput, { relatedTarget: document.body });

    expect(onEditIntent).toHaveBeenCalledTimes(1);
    const next = firstCallArg<QueryIntent>(onEditIntent);
    expect(next.target).toEqual({ value: 10, unit: "keV/um" });
  });

  it("still rejects a genuinely unrecognized target unit after normalization", async () => {
    const onEditIntent = vi.fn();
    const intent = baseIntent({ quantity: "energyFromRange", target: { value: 10, unit: "cm" } });
    const { getByRole } = render(IntentChips, { props: { intent, onEditIntent } });

    await fireEvent.click(getByRole("button", { name: /edit target: 10 cm/i }));
    const unitInput = getByRole("textbox", { name: /target unit/i });
    await fireEvent.input(unitInput, { target: { value: "furlongs" } });
    await fireEvent.focusOut(unitInput, { relatedTarget: document.body });

    expect(onEditIntent).not.toHaveBeenCalled();
  });

  it("renders a target chip for an inverse query", () => {
    const inverse = baseIntent({
      quantity: "energyFromRange",
      target: { value: 10, unit: "cm" },
    });
    const { getByRole } = render(IntentChips, {
      props: { intent: inverse, onEditIntent: () => {} },
    });
    expect(getByRole("button", { name: /edit target: 10 cm/i })).toBeInTheDocument();
  });

  it("renders the target chip's visible text with explicit spaces, not template whitespace", () => {
    const inverse = baseIntent({
      quantity: "energyFromRange",
      target: { value: 10, unit: "cm" },
    });
    const { getByRole } = render(IntentChips, {
      props: { intent: inverse, onEditIntent: () => {} },
    });
    expect(getByRole("button", { name: /edit target: 10 cm/i }).textContent).toBe("target: 10 cm");
  });

  it("omits the target chip for a forward query", () => {
    const { queryByRole } = render(IntentChips, {
      props: { intent: baseIntent(), onEditIntent: () => {} },
    });
    expect(queryByRole("button", { name: /edit target/i })).not.toBeInTheDocument();
  });

  it("renders a program chip only when the intent specifies one", () => {
    const withProgram = baseIntent({ program: "PSTAR" });
    const { getByRole } = render(IntentChips, {
      props: { intent: withProgram, onEditIntent: () => {} },
    });
    expect(getByRole("button", { name: /edit program: PSTAR/i })).toBeInTheDocument();
  });

  describe("highlight (issue #10 targeted re-ask)", () => {
    it("marks the matching chip's accessible name, aria-describedby, and ring class", () => {
      const { getByRole } = render(IntentChips, {
        props: {
          intent: baseIntent(),
          onEditIntent: () => {},
          highlight: { slot: "energy", index: 0 },
          highlightId: "answer-reask",
        },
      });

      const chip = getByRole("button", { name: "Edit energy: 214 keV — needs confirmation" });
      expect(chip).toHaveAttribute("aria-describedby", "answer-reask");
      expect(chip.className).toContain("ring-warning");
    });

    it("leaves non-matching chips unhighlighted", () => {
      const { getByRole } = render(IntentChips, {
        props: {
          intent: baseIntent(),
          onEditIntent: () => {},
          highlight: { slot: "energy", index: 0 },
          highlightId: "answer-reask",
        },
      });

      const particleChip = getByRole("button", { name: /edit particle: alpha particle/i });
      expect(particleChip).not.toHaveAttribute("aria-describedby");
      expect(particleChip.className).not.toContain("ring-warning");
      const materialChip = getByRole("button", { name: /edit material: watre/i });
      expect(materialChip).not.toHaveAttribute("aria-describedby");
    });

    it("highlights nothing when highlight is null", () => {
      const { getByRole } = render(IntentChips, {
        props: { intent: baseIntent(), onEditIntent: () => {}, highlight: null },
      });

      expect(getByRole("button", { name: /edit energy: 214 keV/i })).not.toHaveAttribute(
        "aria-describedby",
      );
    });
  });
});
