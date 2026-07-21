import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/svelte";
import AppModeToggle from "./AppModeToggle.svelte";

describe("AppModeToggle", () => {
  afterEach(() => {
    cleanup();
  });

  it("renders as an accessible switch reflecting basic mode as unchecked", () => {
    const { getByRole } = render(AppModeToggle, { props: { mode: "basic", onToggle: () => {} } });
    const toggle = getByRole("switch", { name: "Advanced mode" });
    expect(toggle).toHaveAttribute("aria-checked", "false");
  });

  it("reflects advanced mode as checked", () => {
    const { getByRole } = render(AppModeToggle, {
      props: { mode: "advanced", onToggle: () => {} },
    });
    const toggle = getByRole("switch", { name: "Advanced mode" });
    expect(toggle).toHaveAttribute("aria-checked", "true");
  });

  it("calls onToggle when clicked", async () => {
    const onToggle = vi.fn();
    const { getByRole } = render(AppModeToggle, { props: { mode: "basic", onToggle } });
    const toggle = getByRole("switch", { name: "Advanced mode" });

    await fireEvent.click(toggle);

    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it("has a visible focus ring class for keyboard users", () => {
    const { getByRole } = render(AppModeToggle, { props: { mode: "basic", onToggle: () => {} } });
    const toggle = getByRole("switch", { name: "Advanced mode" });
    expect(toggle.className).toContain("focus-visible:ring-2");
  });
});
