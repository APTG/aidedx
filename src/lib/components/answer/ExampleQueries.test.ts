import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/svelte";
import ExampleQueries from "./ExampleQueries.svelte";

const examples = [
  "Range of 156.3 MeV protons in water",
  "How far does a 5 MeV alpha particle travel?",
];

const baseProps = {
  examples,
  open: false,
  onToggle: vi.fn(),
  onSelect: vi.fn(),
};

describe("ExampleQueries", () => {
  afterEach(() => {
    cleanup();
  });

  it("hides the examples panel by default and calls onToggle when the toggle is clicked", async () => {
    const onToggle = vi.fn();
    const { getByRole, queryByRole } = render(ExampleQueries, {
      props: { ...baseProps, onToggle },
    });

    expect(queryByRole("region", { name: "Example queries" })).not.toBeInTheDocument();

    const toggle = getByRole("button", { name: "Show examples" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");

    await fireEvent.click(toggle);
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it("reveals every example as its own button when open", () => {
    const { getByRole, queryByRole } = render(ExampleQueries, {
      props: { ...baseProps, open: true },
    });
    expect(queryByRole("button", { name: "Show examples" })).not.toBeInTheDocument();
    expect(getByRole("button", { name: "Hide examples" })).toHaveAttribute("aria-expanded", "true");
    for (const example of examples) {
      expect(getByRole("button", { name: example })).toBeInTheDocument();
    }
  });

  it("calls onSelect with the clicked example's text", async () => {
    const onSelect = vi.fn();
    const { getByRole } = render(ExampleQueries, { props: { ...baseProps, open: true, onSelect } });

    await fireEvent.click(getByRole("button", { name: examples[1] as string }));
    expect(onSelect).toHaveBeenCalledOnce();
    expect(onSelect).toHaveBeenCalledWith(examples[1]);
  });
});
