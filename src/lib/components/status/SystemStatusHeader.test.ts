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

  it("renders a visible 'Basic' label by default, so the toggle isn't a bare unlabeled pill", async () => {
    const { getByText } = render(SystemStatusHeader);
    await Promise.resolve();
    expect(getByText("Basic")).toBeInTheDocument();
  });

  it("shows the status pill after switching to Advanced mode, and hides it again after switching back", async () => {
    const { getByRole, queryByRole } = render(SystemStatusHeader);
    await Promise.resolve();

    // The switch's accessible name is the visible mode word itself
    // (aria-labelledby), so it changes with state — re-queried after each click.
    await getByRole("switch", { name: "Basic" }).click();
    expect(getByRole("button", { name: "System status" })).toBeInTheDocument();
    const advancedToggle = getByRole("switch", { name: "Advanced" });
    expect(advancedToggle).toHaveAttribute("aria-checked", "true");
    expect(localStorage.getItem("aidedx:app-mode")).toBe("advanced");

    await advancedToggle.click();
    expect(queryByRole("button", { name: "System status" })).not.toBeInTheDocument();
    expect(getByRole("switch", { name: "Basic" })).toHaveAttribute("aria-checked", "false");
    expect(localStorage.getItem("aidedx:app-mode")).toBe("basic");
  });

  it("starts in Advanced mode when that preference was already stored", async () => {
    localStorage.setItem("aidedx:app-mode", "advanced");
    const { getByRole } = render(SystemStatusHeader);
    await Promise.resolve();
    expect(getByRole("button", { name: "System status" })).toBeInTheDocument();
  });

  it("doesn't reopen the panel already-expanded after leaving and returning to Advanced mode (Copilot review, PR #110)", async () => {
    const { getByRole, queryByRole } = render(SystemStatusHeader);
    await Promise.resolve();

    await getByRole("switch", { name: "Basic" }).click(); // -> Advanced
    await getByRole("button", { name: "System status" }).click(); // expand the panel
    expect(getByRole("region", { name: "System status details" })).toBeInTheDocument();

    await getByRole("switch", { name: "Advanced" }).click(); // -> Basic (pill unmounts)
    await getByRole("switch", { name: "Basic" }).click(); // -> Advanced again

    expect(getByRole("button", { name: "System status" })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    expect(queryByRole("region", { name: "System status details" })).not.toBeInTheDocument();
  });

  it("keeps the dark-mode toggle visible regardless of Basic/Advanced mode", async () => {
    const { getByRole } = render(SystemStatusHeader);
    await Promise.resolve();
    expect(getByRole("switch", { name: "Toggle dark mode" })).toBeInTheDocument();

    await getByRole("switch", { name: "Basic" }).click();
    expect(getByRole("switch", { name: "Toggle dark mode" })).toBeInTheDocument();
  });

  it("never renders a dialog on mount, and toggling mode doesn't affect that (dialogs are mode-independent)", async () => {
    const { queryByRole, getByRole } = render(SystemStatusHeader);
    await Promise.resolve();
    expect(queryByRole("dialog")).not.toBeInTheDocument();

    await getByRole("switch", { name: "Basic" }).click();
    expect(queryByRole("dialog")).not.toBeInTheDocument();
  });
});
