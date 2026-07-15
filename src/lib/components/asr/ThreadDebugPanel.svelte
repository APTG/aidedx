<script lang="ts">
  /*
   * DEBUG (#9 threading experiment — revertable, not for production).
   *
   * A live control for the ORT WASM thread count, so threading can be tested
   * on the deployed app. Writes the chosen value to localStorage
   * (`aidedxDebugThreads`), which `worker-client.ts` reads and forwards to the
   * ASR worker before the pipeline loads (`transcribe.ts` applies it to
   * `env.backends.onnx.wasm.numThreads`). Because the pipeline+session is
   * memoized once created, applying a new value reloads the page so the worker
   * is rebuilt cleanly.
   *
   * Gated behind the `?debug` query param so ordinary visitors never see it —
   * and `worker-client.ts` only forwards the override when `?debug` is present,
   * so a stale localStorage value can't affect a normal visit.
   * To use on the live app: visit `<url>?debug`, pick a thread count, Apply,
   * then record a clip and read the "Warming up…" time (and the
   * `[asr] ORT numThreads = … (debug override)` console line to confirm it took).
   *
   * Remove this file, its mount in `+page.svelte`, and the `config` worker
   * message plumbing to revert.
   */
  import { onMount } from "svelte";

  const OPTIONS = ["off", "1", "2", "4", "6", "8", "12"];

  let selected = $state("off");
  let crossOriginIsolated = $state(false);
  let hardwareConcurrency = $state(0);
  let ready = $state(false);

  // Mirror of resolveThreadCount() in transcribe.ts — what "off" resolves to.
  const policyThreads = $derived(
    Math.max(1, Math.min(8, Math.floor((hardwareConcurrency > 0 ? hardwareConcurrency : 4) / 2))),
  );

  onMount(() => {
    selected = globalThis.localStorage?.getItem("aidedxDebugThreads") ?? "off";
    crossOriginIsolated = Boolean(globalThis.crossOriginIsolated);
    hardwareConcurrency = globalThis.navigator?.hardwareConcurrency ?? 0;
    ready = true;
  });

  function apply() {
    try {
      globalThis.localStorage?.setItem("aidedxDebugThreads", selected);
    } catch {
      /* ignore */
    }
    globalThis.location?.reload();
  }
</script>

{#if ready}
  <div
    class="mx-auto w-full max-w-3xl rounded-md border border-dashed border-amber-500/60 bg-amber-500/5 px-4 py-3 text-sm"
  >
    <div class="mb-2 font-mono text-xs font-semibold tracking-wide text-amber-600 uppercase">
      🧵 debug: ORT WASM threads (#9)
    </div>
    <div class="flex flex-wrap items-center gap-3">
      <label class="flex items-center gap-2">
        <span class="text-muted-foreground">numThreads</span>
        <select
          bind:value={selected}
          class="rounded border border-input bg-card px-2 py-1 font-mono outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {#each OPTIONS as opt (opt)}
            <option value={opt}>{opt === "off" ? `off (policy → ${policyThreads})` : opt}</option>
          {/each}
        </select>
      </label>
      <button
        type="button"
        onclick={apply}
        class="rounded bg-amber-600 px-3 py-1 font-medium text-white transition-opacity hover:opacity-90"
      >
        Apply &amp; reload
      </button>
      <span class="font-mono text-xs text-muted-foreground">
        crossOriginIsolated=<b
          class:text-green-600={crossOriginIsolated}
          class:text-red-600={!crossOriginIsolated}>{crossOriginIsolated}</b
        >
        · hardwareConcurrency={hardwareConcurrency}
      </span>
    </div>
    <p class="mt-2 text-xs text-muted-foreground">
      "off" uses the shipped policy (half the logical cores, capped at 8) = <b>{policyThreads}</b>
      here; pick a number to override it for A/B testing. Effective only when crossOriginIsolated. After
      Apply, record a clip and confirm via the <code>[asr] ORT numThreads = …</code> console line.
    </p>
  </div>
{/if}
