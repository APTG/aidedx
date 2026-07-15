/*! coi-serviceworker v0.1.7 - Guido Zuidhof and contributors, licensed under MIT */
/* eslint-disable @typescript-eslint/no-unused-expressions */
// DEBUG (#9 threading experiment — revertable). Vendored copy of
// https://github.com/gzuidhof/coi-serviceworker — a service worker that injects
// COOP/COEP response headers client-side so a static host that CANNOT set them
// (GitHub Pages) can still become cross-origin isolated, enabling
// SharedArrayBuffer / WASM multithreading. Uses COEP: credentialless so
// cross-origin subresources (jsdelivr ORT wasm, the Cyfronet S3 weights mirror)
// load without needing their own CORP header. See docs/threading-coop-coep.md.
// Registered from app.html; remove both to revert.
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
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response.status === 0) return response;
          const newHeaders = new Headers(response.headers);
          newHeaders.set(
            "Cross-Origin-Embedder-Policy",
            coepCredentialless ? "credentialless" : "require-corp",
          );
          if (!coepCredentialless) newHeaders.set("Cross-Origin-Resource-Policy", "cross-origin");
          newHeaders.set("Cross-Origin-Opener-Policy", "same-origin");
          return new Response(response.body, {
            status: response.status,
            statusText: response.statusText,
            headers: newHeaders,
          });
        })
        .catch((e) => {
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
