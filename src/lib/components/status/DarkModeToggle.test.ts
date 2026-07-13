import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/svelte";
import DarkModeToggle from "./DarkModeToggle.svelte";

describe("DarkModeToggle", () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.classList.remove("dark");
  });

  afterEach(() => {
    cleanup();
  });

  it("renders as an accessible switch defaulting to off", async () => {
    const { getByRole } = render(DarkModeToggle);
    const toggle = getByRole("switch", { name: "Toggle dark mode" });
    await Promise.resolve();
    expect(toggle).toHaveAttribute("aria-checked", "false");
  });

  it("toggles the .dark class and persists the choice on click", async () => {
    const { getByRole } = render(DarkModeToggle);
    const toggle = getByRole("switch", { name: "Toggle dark mode" });

    await fireEvent.click(toggle);

    expect(toggle).toHaveAttribute("aria-checked", "true");
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    expect(localStorage.getItem("aidedx:dark-mode")).toBe("true");

    await fireEvent.click(toggle);

    expect(toggle).toHaveAttribute("aria-checked", "false");
    expect(document.documentElement.classList.contains("dark")).toBe(false);
    expect(localStorage.getItem("aidedx:dark-mode")).toBe("false");
  });

  it("starts enabled when a dark preference is already stored", async () => {
    localStorage.setItem("aidedx:dark-mode", "true");
    const { getByRole } = render(DarkModeToggle);
    const toggle = getByRole("switch", { name: "Toggle dark mode" });
    await Promise.resolve();
    expect(toggle).toHaveAttribute("aria-checked", "true");
    expect(document.documentElement.classList.contains("dark")).toBe(true);
  });
});
