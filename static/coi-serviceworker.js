/*! coi-serviceworker v0.1.7 - Guido Zuidhof and contributors, licensed under MIT */
/* eslint-disable @typescript-eslint/no-unused-expressions */
// Permanent production threading path (issue #9, decided and measured — see
// docs/threading-coop-coep.md). Vendored copy of
// https://github.com/gzuidhof/coi-serviceworker — a service worker that injects
// COOP/COEP response headers client-side so a static host that CANNOT set them
// (GitHub Pages) can still become cross-origin isolated, enabling
// SharedArrayBuffer / WASM multithreading. Uses COEP: credentialless so
// cross-origin subresources (jsdelivr ORT wasm, the Cyfronet S3 weights mirror)
// load without needing their own CORP header. See docs/threading-coop-coep.md.
// Registered from app.html; remove both only if that decision is reversible.
//
// Offline Cache Storage fallback (issue #217): the original upstream fetch
// handler re-throws unconditionally on a failed live fetch, so once this SW
// is controlling the page, ANY resource it proxies — same-origin app code
// included — hard-fails offline even if a prior successful fetch could have
// served it from cache. That broke the app's own "works offline" claim on
// first use: `wasm/libdedx.mjs` and the ASR worker script are dynamic
// import()'d/`new Worker()`'d lazily on first query (see `wasm/loader.ts`,
// `asr/worker-client.ts`), so a user who went offline right after finishing
// the "download models" flow (before issue #217's `model-status.svelte.ts`
// precache fix) had never fetched them at all. `AIDEDX_RUNTIME_CACHE_NAME`
// gives every successful same-origin GET response proxied here a durable
// Cache Storage copy, and the catch block below falls back to it. Kept
// same-origin-only so this never duplicates the multi-hundred-MB model
// weight downloads (Cyfronet S3, cross-origin — already cached separately
// by transformers.js's own "transformers-cache" bucket, see
// `models/download.ts`) into a second cache.
const AIDEDX_RUNTIME_CACHE_NAME = "aidedx-coi-runtime-v1";
let coepCredentialless = true;
if (typeof window === "undefined") {
  self.addEventListener("install", () => self.skipWaiting());
  self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

  self.addEventListener("message", (ev) => {
    if (!ev.data) return;
    if (ev.data.type === "deregister") {
      self.registration
        .unregister()
        .then(() => self.clients.matchAll())
        .then((clients) => {
          clients.forEach((client) => client.navigate(client.url));
        });
    } else if (ev.data.type === "coepCredentialless") {
      coepCredentialless = ev.data.value;
    }
  });

  self.addEventListener("fetch", (event) => {
    const r = event.request;
    if (r.cache === "only-if-cached" && r.mode !== "same-origin") return;

    const request =
      coepCredentialless && r.mode === "no-cors" ? new Request(r, { credentials: "omit" }) : r;
    // issue #217: only same-origin GET responses go into the runtime cache —
    // see the module-level comment above.
    const isCacheableGet = r.method === "GET" && new URL(r.url).origin === self.location.origin;
    event.respondWith(
      fetch(request)
        .then((response) => {
          const withCoiHeaders =
            response.status === 0
              ? response
              : (() => {
                  const newHeaders = new Headers(response.headers);
                  newHeaders.set(
                    "Cross-Origin-Embedder-Policy",
                    coepCredentialless ? "credentialless" : "require-corp",
                  );
                  if (!coepCredentialless) {
                    newHeaders.set("Cross-Origin-Resource-Policy", "cross-origin");
                  }
                  newHeaders.set("Cross-Origin-Opener-Policy", "same-origin");
                  return new Response(response.body, {
                    status: response.status,
                    statusText: response.statusText,
                    headers: newHeaders,
                  });
                })();
          if (isCacheableGet) {
            const toCache = withCoiHeaders.clone();
            caches
              .open(AIDEDX_RUNTIME_CACHE_NAME)
              .then((cache) => cache.put(r, toCache))
              .catch((e) => console.error("[aidedx] runtime cache write failed", e));
          }
          return withCoiHeaders;
        })
        .catch(async (e) => {
          // issue #217: a live fetch failure (e.g. offline) isn't necessarily
          // fatal — a prior successful fetch above may have already left
          // this exact resource in Cache Storage, either in our own runtime
          // cache or (for ONNX Runtime Web's wasm/mjs, when `env.useWasmCache`
          // applies — see `models/download.ts`'s module comment) in
          // transformers.js's own "transformers-cache" bucket. Search every
          // bucket (unscoped `caches.match`) rather than just ours, so both
          // count.
          if (isCacheableGet) {
            const cached = await caches.match(r);
            if (cached) return cached;
          }
          // respondWith() requires a Response; returning undefined from a catch
          // would throw. Re-throw so the fetch surfaces as a normal network
          // error (same as if the SW hadn't intercepted it) instead.
          console.error(e);
          throw e;
        }),
    );
  });
} else {
  (() => {
    const reloadedBySelf = window.sessionStorage.getItem("coiReloadedBySelf");
    window.sessionStorage.removeItem("coiReloadedBySelf");

    const n = navigator;
    const controlling = n.serviceWorker && n.serviceWorker.controller;

    const coi = {
      shouldRegister: () => !reloadedBySelf,
      coepCredentialless: () => true,
      doReload: () => window.location.reload(),
      quiet: false,
    };

    if (!window.isSecureContext) {
      !coi.quiet &&
        console.log("COOP/COEP Service Worker not registered, a secure context is required.");
      return;
    }

    if (controlling) {
      n.serviceWorker.controller.postMessage({
        type: "coepCredentialless",
        value: coi.coepCredentialless(),
      });
    }

    if (!coi.shouldRegister()) return;

    if (!n.serviceWorker) {
      !coi.quiet &&
        console.error("COOP/COEP Service Worker not registered, perhaps due to a restrictive CSP.");
      return;
    }

    n.serviceWorker.register(window.document.currentScript.src).then(
      (registration) => {
        !coi.quiet && console.log("COOP/COEP Service Worker registered", registration.scope);

        registration.addEventListener("updatefound", () => {
          !coi.quiet &&
            console.log("Reloading page to make use of updated COOP/COEP Service Worker.");
          window.sessionStorage.setItem("coiReloadedBySelf", "updatefound");
          coi.doReload();
        });

        if (registration.active && !n.serviceWorker.controller) {
          !coi.quiet && console.log("Reloading page to make use of COOP/COEP Service Worker.");
          window.sessionStorage.setItem("coiReloadedBySelf", "notcontrolling");
          coi.doReload();
        }
      },
      (err) => {
        !coi.quiet && console.error("COOP/COEP Service Worker failed to register:", err);
      },
    );
  })();
}
