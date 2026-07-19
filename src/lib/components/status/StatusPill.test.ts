import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/svelte";
import StatusPill from "./StatusPill.svelte";

const baseProps = {
  open: false,
  onToggle: vi.fn(),
  modelLabel: "Ready",
  modelDotClass: "bg-success",
  diskLabel: "1.13 GB",
  diskClass: "",
  ramLabel: "Not supported",
  ramTooltip: "This browser doesn't report memory usage",
  cpuLabel: "4 of 8",
  cpuTooltip: "WASM threads used for in-browser transcription (half of logical cores, capped at 8)",
  hardwareLabel: "GPU · WebGPU",
  showClear: true,
  onClear: vi.fn(),
};

describe("StatusPill", () => {
  afterEach(() => {
    cleanup();
  });

  it("shows the model/disk summary and calls onToggle when clicked", async () => {
    const onToggle = vi.fn();
    const { getByRole } = render(StatusPill, { props: { ...baseProps, onToggle } });
    const button = getByRole("button", { name: "System status" });
    expect(button).toHaveTextContent("Ready · 1.13 GB");

    await fireEvent.click(button);
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it("does not render the panel when closed", () => {
    const { queryByText } = render(StatusPill, { props: baseProps });
    expect(queryByText("Memory (RAM)")).not.toBeInTheDocument();
  });

  it("renders the panel rows and a Clear button when open with cached data", () => {
    const { getByText, getByRole } = render(StatusPill, { props: { ...baseProps, open: true } });
    expect(getByText("Memory (RAM)")).toBeInTheDocument();
    expect(getByText("CPU threads")).toBeInTheDocument();
    expect(getByText("Hardware")).toBeInTheDocument();
    expect(getByRole("button", { name: "Clear" })).toBeInTheDocument();
  });

  it("shows the CPU threads value and exposes the policy explanation via a title tooltip", () => {
    const { getByText } = render(StatusPill, { props: { ...baseProps, open: true } });
    const value = getByText("4 of 8");
    expect(value).toHaveAttribute("title", baseProps.cpuTooltip);
  });

  it("truncates a long hardware renderer string and exposes the full text via a title tooltip", () => {
    const longLabel =
      "CPU only (render: ANGLE (Intel, Intel(R) UHD Graphics 620 (0x00003EA0) Direct3D11 vs_5_0 ps_5_0, D3D11))";
    const { getByText } = render(StatusPill, {
      props: { ...baseProps, open: true, hardwareLabel: longLabel },
    });
    const value = getByText(longLabel);
    expect(value).toHaveClass("truncate");
    expect(value).toHaveAttribute("title", longLabel);
  });

  it("hides the Clear button when there's nothing to clear", () => {
    const { queryByRole } = render(StatusPill, {
      props: { ...baseProps, open: true, showClear: false },
    });
    expect(queryByRole("button", { name: "Clear" })).not.toBeInTheDocument();
  });

  it("calls onClear when the Clear button is clicked", async () => {
    const onClear = vi.fn();
    const { getByRole } = render(StatusPill, { props: { ...baseProps, open: true, onClear } });
    await fireEvent.click(getByRole("button", { name: "Clear" }));
    expect(onClear).toHaveBeenCalledTimes(1);
  });

  it("reflects aria-expanded state", () => {
    const { getByRole, rerender } = render(StatusPill, { props: baseProps });
    expect(getByRole("button", { name: "System status" })).toHaveAttribute(
      "aria-expanded",
      "false",
    );

    rerender({ ...baseProps, open: true });
    expect(getByRole("button", { name: "System status" })).toHaveAttribute("aria-expanded", "true");
  });
});
