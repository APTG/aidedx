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
});
