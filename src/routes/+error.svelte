<script lang="ts">
  import { page } from "$app/state";
  import { base } from "$app/paths";
</script>

<svelte:head>
  <title>Error — aidedx</title>
</svelte:head>

<div class="flex min-h-[60vh] flex-col items-center justify-center gap-4 px-4 text-center">
  <h1 class="text-2xl font-bold">
    {page.status === 404 ? "Page not found" : "Something went wrong"}
  </h1>
  {#if page.error?.message}
    <p class="max-w-md text-muted-foreground">{page.error.message}</p>
  {/if}
  <a href={`${base}/`} class="rounded-md bg-primary px-4 py-2 text-primary-foreground"> Go home </a>
</div>
