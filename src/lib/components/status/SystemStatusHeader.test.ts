import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/svelte";
import SystemStatusHeader from "./SystemStatusHeader.svelte";

describe("SystemStatusHeader", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    cleanup();
  });

  it("hides the status pill entirely (no DOM) in Basic mode by default", async () => {
    const { queryByRole } = render(SystemStatusHeader);
    await Promise.resolve();
    expect(queryByRole("button", { name: "System status" })).not.toBeInTheDocument();
  });

  it("shows the status pill after switching to Advanced mode, and hides it again after switching back", async () => {
    const { getByRole, queryByRole } = render(SystemStatusHeader);
    await Promise.resolve();

    const modeToggle = getByRole("switch", { name: "Advanced mode" });
    await modeToggle.click();
    expect(getByRole("button", { name: "System status" })).toBeInTheDocument();
    expect(modeToggle).toHaveAttribute("aria-checked", "true");
    expect(localStorage.getItem("aidedx:app-mode")).toBe("advanced");

    await modeToggle.click();
    expect(queryByRole("button", { name: "System status" })).not.toBeInTheDocument();
    expect(modeToggle).toHaveAttribute("aria-checked", "false");
    expect(localStorage.getItem("aidedx:app-mode")).toBe("basic");
  });

  it("starts in Advanced mode when that preference was already stored", async () => {
    localStorage.setItem("aidedx:app-mode", "advanced");
    const { getByRole } = render(SystemStatusHeader);
    await Promise.resolve();
    expect(getByRole("button", { name: "System status" })).toBeInTheDocument();
  });

  it("keeps the dark-mode toggle visible regardless of Basic/Advanced mode", async () => {
    const { getByRole } = render(SystemStatusHeader);
    await Promise.resolve();
    expect(getByRole("switch", { name: "Toggle dark mode" })).toBeInTheDocument();

    await getByRole("switch", { name: "Advanced mode" }).click();
    expect(getByRole("switch", { name: "Toggle dark mode" })).toBeInTheDocument();
  });

  it("never renders a dialog on mount, and toggling mode doesn't affect that (dialogs are mode-independent)", async () => {
    const { queryByRole, getByRole } = render(SystemStatusHeader);
    await Promise.resolve();
    expect(queryByRole("dialog")).not.toBeInTheDocument();

    await getByRole("switch", { name: "Advanced mode" }).click();
    expect(queryByRole("dialog")).not.toBeInTheDocument();
  });
});
