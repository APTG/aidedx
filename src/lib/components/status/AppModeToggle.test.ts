import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/svelte";
import AppModeToggle from "./AppModeToggle.svelte";

describe("AppModeToggle", () => {
  afterEach(() => {
    cleanup();
  });

  it("renders a visible 'Basic' label and an unchecked switch in basic mode", () => {
    const { getByText, getByRole } = render(AppModeToggle, {
      props: { mode: "basic", onToggle: () => {} },
    });
    expect(getByText("Basic")).toBeInTheDocument();
    // Accessible name comes from aria-labelledby pointing at that same
    // visible text (WCAG 2.5.3 Label in Name), not a separate aria-label.
    const toggle = getByRole("switch", { name: "Basic" });
    expect(toggle).toHaveAttribute("aria-checked", "false");
  });

  it("renders a visible 'Advanced' label and a checked switch in advanced mode", () => {
    const { getByText, getByRole } = render(AppModeToggle, {
      props: { mode: "advanced", onToggle: () => {} },
    });
    expect(getByText("Advanced")).toBeInTheDocument();
    const toggle = getByRole("switch", { name: "Advanced" });
    expect(toggle).toHaveAttribute("aria-checked", "true");
  });

  it("calls onToggle when clicked", async () => {
    const onToggle = vi.fn();
    const { getByRole } = render(AppModeToggle, { props: { mode: "basic", onToggle } });
    const toggle = getByRole("switch", { name: "Basic" });

    await fireEvent.click(toggle);

    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it("has a visible focus ring class for keyboard users", () => {
    const { getByRole } = render(AppModeToggle, { props: { mode: "basic", onToggle: () => {} } });
    const toggle = getByRole("switch", { name: "Basic" });
    expect(toggle.className).toContain("focus-visible:ring-2");
  });
});
