/**
 * Hardware acceleration detection for the status panel's "Hardware" row.
 *
 * WebGPU is the primary signal — it's also what decides which in-browser
 * inference backend transformers.js picks. Falls back to a WebGL renderer
 * string so unsupported browsers still show something useful instead of a
 * bare "CPU only".
 */

export interface HardwareInfo {
  kind: "gpu" | "cpu";
  label: string;
}

interface MinimalGPUAdapterInfo {
  description?: string;
}

interface MinimalGPUAdapter {
  info?: MinimalGPUAdapterInfo;
  requestAdapterInfo?: () => Promise<MinimalGPUAdapterInfo>;
}

interface MinimalGPU {
  requestAdapter: () => Promise<MinimalGPUAdapter | null>;
}

function getGpu(): MinimalGPU | undefined {
  return (navigator as Navigator & { gpu?: MinimalGPU }).gpu;
}

function detectWebGlRenderer(): string | null {
  if (typeof document === "undefined") return null;
  const canvas = document.createElement("canvas");
  const gl = (canvas.getContext("webgl2") ??
    canvas.getContext("webgl")) as WebGLRenderingContext | null;
  if (!gl) return null;
  const debugInfo = gl.getExtension("WEBGL_debug_renderer_info");
  if (!debugInfo) return null;
  const renderer = gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL);
  return typeof renderer === "string" ? renderer : null;
}

export async function detectHardware(): Promise<HardwareInfo> {
  const gpu = typeof navigator !== "undefined" ? getGpu() : undefined;
  if (gpu) {
    try {
      const adapter = await gpu.requestAdapter();
      if (adapter) {
        const info = adapter.info ?? (await adapter.requestAdapterInfo?.());
        return {
          kind: "gpu",
          label: info?.description ? `GPU · ${info.description}` : "GPU · WebGPU",
        };
      }
    } catch {
      /* WebGPU present but adapter request failed — fall through to WebGL check */
    }
  }

  const renderer = detectWebGlRenderer();
  return {
    kind: "cpu",
    label: renderer ? `CPU only (render: ${renderer})` : "CPU only",
  };
}
