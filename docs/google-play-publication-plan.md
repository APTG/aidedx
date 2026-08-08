# Google Play publication plan

_Planning document, 2026-08-08. Status: **proposal awaiting decisions** — no code changes yet._

This document answers a concrete question: what would it take to publish APTG software as native Android
apps on Google Play, and in what order should it happen. It covers the two candidate apps
([`APTG/dEdx-App`](https://github.com/APTG/dEdx-App) and this repo's `bench/android/full-app`), the
licensing position, the store-policy gates, the repo layout, and a phased work plan with dates.

It also records two findings that block publication as things stand today, both cheap to fix but
neither optional:

1. **`APTG/dEdx-App` has no `LICENSE` file** while linking GPL-3.0 `libdedx`. Publishing a binary
   from it today would distribute a GPL-derived work under no stated licence. See §5.2, Gap B.
2. **The Parakeet-v3 weights are CC-BY-4.0**, whose attribution requirement is currently unmet in
   `bench/android/full-app`. See §5.2, Gap A.

---

## 1. TL;DR — the recommended path

| #   | Action                                                                  | When                   | Blocking?                    |
| --- | ----------------------------------------------------------------------- | ---------------------- | ---------------------------- |
| 1   | Register the Google Play developer account                              | **This week**          | Yes — the long pole (see §6) |
| 2   | Add `LICENSE` (GPL-3.0) + third-party `NOTICE` to `dEdx-App`            | This week              | Yes — §5.2                   |
| 3   | Bump both apps to `targetSdk 36`                                        | **Before 31 Aug 2026** | Yes — §6.4                   |
| 4   | Publish **dEdx** (the calculator) first, as its own listing             | Weeks 1–10             | —                            |
| 5   | Promote `bench/android/full-app` → `android/` in this repo              | Weeks 2–8              | —                            |
| 6   | Grow the Kotlin app to absorb dedx_web's UI, retire the legacy Java app | Q4 2026                | —                            |
| 7   | Publish **aidedx** as a second listing                                  | Q1 2027                | —                            |
| 8   | Add BYOK cloud AI as an opt-in provider layer                           | After #7               | —                            |

The reasoning in one paragraph: you have no Play account yet, which means the 12-tester / 14-day
closed-testing gate applies (§6.3). That gate is **per account, not per app** — so clearing it with a
small, offline, zero-permission calculator is dramatically lower-risk than clearing it with a
639 MB-download, microphone-using AI app. `dEdx-App` is already ~90 % of the way to a release
(signed-AAB CI, privacy policy written, modernized to API 35); aidedx-native is still a bench spike.
Ship the easy one first to buy a verified, production-unlocked account, then ship the interesting one
onto it.

---

## 2. Where we stand — asset inventory

### 2.1 `APTG/dEdx-App` — the "bare libdedx app"

| Property        | Value                                                                                                                                                    |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Language        | Java, 765 lines across 7 files                                                                                                                           |
| UI              | Two tabs (`DedxFragment` forward dE/dx, `InverseFragment` inverse CSDA), spinner-driven forms, no plots, portrait-locked                                 |
| Physics         | Prebuilt `libdedx.so` per ABI in `jniLibs/` + JNI shim `cpp/dEdx.c`; libdedx v1.3.0                                                                      |
| `applicationId` | `io.github.aptg.dedx`                                                                                                                                    |
| SDK             | `minSdk 21`, `compileSdk`/`targetSdk 35`, NDK 28.2                                                                                                       |
| ABIs            | `arm64-v8a`, `armeabi-v7a`, `x86_64`                                                                                                                     |
| Release CI      | **Already present** — `.github/workflows/release.yml` builds a signed AAB on `v*` tags, keystore via `KEYSTORE_BASE64` secret                            |
| Privacy policy  | **Already written** — `docs/privacy-policy.md`                                                                                                           |
| Tests           | None                                                                                                                                                     |
| Licence         | **Missing** — no `LICENSE` file                                                                                                                          |
| Attribution     | About screen credits Aarhus Particle Therapy Group, Casper Christensen (original app), Jakob Toftegaard + Niels Bassler (libdedx), Danish Cancer Society |

`MODERNIZATION.md`'s §7 already lists "Publish to Google Play Store" as the last open box. This app is
close to ready.

### 2.2 `aidedx` `bench/android/full-app` — the AI assistant spike

| Property      | Value                                                                                                                                                                             |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Language      | Kotlin, ~20 source files + 5 JVM test classes (37 tests)                                                                                                                          |
| ASR           | sherpa-onnx + NeMo Parakeet-tdt-0.6b-v3 int8, **~670 MB** downloaded at runtime from the Cyfronet mirror                                                                          |
| NLU           | `KotlinMatcher` + `AsrCorrections`, **83/83 (100 %) semantic agreement** with the TypeScript matcher                                                                              |
| Physics       | Both approaches built side by side: native `libdedx` JNI (Approach B) **and** the same `libdedx.wasm` the web app ships, run by a vendored wasm3 (Approach A, 0.218 ms/call warm) |
| SDK           | `minSdk 26`, `compileSdk`/`targetSdk 34`                                                                                                                                          |
| ABIs          | `arm64-v8a` only                                                                                                                                                                  |
| Device status | Verified end-to-end on a Pixel 7a across many sessions (see `docs/android-full-app-spike.md`)                                                                                     |
| Extras        | Field-capture system (WAV + JSON envelope, annotation UI, zip export), model download manager, rotation-safe lifecycle, light/dark reskin matching the web palette                |
| Release CI    | None                                                                                                                                                                              |
| Licence       | Inherits this repo's GPL-3.0-or-later                                                                                                                                             |

The important thing to notice: **this is already the more mature codebase of the two.** It has tests,
a modern lifecycle, a design system, and a working native libdedx bridge. The legacy Java app has none
of that.

### 2.3 `APTG/dedx_web` — the feature target

SvelteKit + WASM, GPL-3.0. Users pick particle, target material, and an energy range, and get a
numerical table plus an interactive plot. v2 is in open beta. This is the feature set §3 asks about
porting.

---

## 3. Decision 1 — replace the legacy dEdx app with a Kotlin rewrite?

You asked specifically about replacing `dEdx-App` with a new Kotlin app carrying dedx_web-like UI
features. Here is the honest ledger.

### 3.1 Pros of a Kotlin rewrite

- **You are not starting from zero.** `bench/android/full-app` already has a working `LibdedxBridge`
  (native JNI) and `LibdedxWasmBridge`. A dEdx form screen on top of an existing, device-verified
  bridge is roughly "one screen + one chart", not a from-scratch app.
- **One codebase, one physics bridge.** Today the two apps link libdedx two different ways (legacy
  prebuilt `.so` vs. this repo's CMake build of vendored source). Two bridges means two places to
  chase a libdedx version bump — and `MODERNIZATION.md` §5 already has an open box for exactly that
  drift.
- **The legacy app has no tests.** Zero. The Kotlin app has 37 JVM tests and a golden-file physics
  test in the TS repo. Rewriting is the cheapest moment to inherit that.
- **Feature parity with dedx_web needs a real UI framework anyway.** The legacy app is
  `RelativeLayout`/`LinearLayout` + spinners, portrait-locked, with no charting. Adding an
  interactive plot, energy-range sweeps, unit handling, and export to that is not much cheaper than
  writing it fresh in Compose — and you'd be building a modern feature on a 2013-era skeleton.
- **Java → Kotlin removes a language boundary.** Right now shipping both apps means maintaining
  Java-with-fragments _and_ Kotlin-with-views. Consolidating means one language, one idiom, one set of
  lint rules.
- **`minSdk 21` is dead weight.** Android 5.0 is ~0 % of the active install base in 2026. The Kotlin
  app's `minSdk 26` is already the sane floor and unlocks APIs the legacy app works around.
- **Better accessibility and tablet/landscape support** come nearly free with Compose + Material 3,
  and the legacy app currently has none (it's `screenOrientation="portrait"` hard-locked).

### 3.2 Cons of a Kotlin rewrite

- **The legacy app works today and is nearly publishable.** It is the single fastest route to "an
  APTG app exists on Google Play". A rewrite trades a ~2-week path for a ~2-month one.
- **It is not your code to rewrite unilaterally.** The About screen credits Casper Christensen
  (Aarhus University student project) and the Aarhus Particle Therapy Group. Replacing it is a
  project-governance conversation with Niels Bassler / APTG, not just a technical one. (See §5.3 —
  this matters for the Play listing's developer name too.)
- **Numerical-regression risk.** The legacy app's inverse-CSDA path is verified against known values
  (`MODERNIZATION.md` §7: 8 cm CSDA → ~102 MeV for protons in water). A rewrite must reproduce those
  exactly, which means porting or re-deriving that verification — real work, easy to under-budget.
- **ABI coverage shrinks unless you pay for it.** The legacy app ships `arm64-v8a`,
  `armeabi-v7a`, `x86_64`; the Kotlin app is `arm64-v8a` only. Restoring 32-bit ARM and x86_64 (for
  ChromeOS/emulators) is straightforward but has to be done deliberately.
- **Compose is a new dependency surface.** The bench apps deliberately avoided coroutines and modern
  AndroidX ("plain `Thread`, matching every other bench app's no-coroutines convention"). Adopting
  Compose means adopting coroutines, `lifecycle-*`, and a materially larger dependency graph — all
  Apache-2.0 and GPL-compatible, but more to audit and more to keep current.
- **Charting means a new library decision.** Vico (Apache-2.0, Compose-native, actively maintained) is
  the sane default; MPAndroidChart is Apache-2.0 but effectively unmaintained; hand-drawing on a
  Compose `Canvas` avoids the dependency entirely at the cost of building pan/zoom/tooltips yourself.
- **Scope creep is the real risk.** "dedx_web feature parity" is not one feature — it's material and
  particle pickers over libdedx's full table set, energy-range sweeps, unit conversion, an interactive
  plot with log axes, a results table, and export. Each is small; together they are a quarter of work.

### 3.3 Recommendation

**Do both, in sequence — don't rewrite first.**

1. Publish the legacy Java `dEdx-App` essentially as-is (plus the licence fix and `targetSdk 36`). It
   costs about a week of work and buys you the verified Play account, the cleared 12-tester gate, and
   a live listing under `io.github.aptg.dedx`.
2. Build the Kotlin/Compose dEdx UI inside the aidedx Android app, where the libdedx bridge and the
   test infrastructure already live.
3. When it reaches parity, decide between two endings:
   - **Replace in place** — ship the Kotlin build under the _same_ `io.github.aptg.dedx`
     `applicationId`, so existing users get it as an update. Requires the same signing key.
   - **Let it stand** — keep the calculator listing frozen and let the aidedx listing carry the
     modern UI.

Sequencing this way means the rewrite is never on the critical path to your first release, and the
rewrite happens with a real user base and real crash/ANR data from Play Console to aim at.

---

## 4. Decision 2 — one app or two listings?

### 4.1 The case for **two separate listings** (recommended)

- **Radically different user promises.** dEdx is a ~10 MB offline calculator with **no permissions and
  no internet**. aidedx wants the microphone and a ~670 MB model download. Bundling them means every
  user who wants a stopping-power table is asked for microphone access and confronted with a
  two-thirds-of-a-gigabyte download prompt. That is a conversion and a review-score problem, not just
  an aesthetic one.
- **The Data safety declaration stays trivial for dEdx.** "Collects no data, no permissions" is the
  cleanest possible Play submission and the least likely to be rejected or flagged. Merging drags the
  calculator into the microphone/AI-content policy surface (§8.4) for no benefit.
- **Different audiences.** dEdx serves anyone wanting a stopping-power number. aidedx serves people
  who want to _talk_ to it — a narrower, more experimental audience. Two listings means two sets of
  keywords, two descriptions, and two independent review scores.
- **Risk isolation.** If aidedx trips the generative-AI content policy or a microphone-related review
  question, the calculator stays live and unaffected. One listing means one policy strike takes both
  down.
- **Independent release cadence.** The calculator is essentially finished software; aidedx will churn
  weekly. Shared listing means every aidedx experiment ships a new calculator version too.
- **Cheaper to start.** Two small listings on one account cost nothing extra — the $25 is per account,
  not per app.

### 4.2 The case for **one merged app**

- **One listing to maintain** — one store description, one screenshot set, one privacy policy, one
  Data safety form, one target-API migration per year, one review queue to watch. Two listings is
  genuinely close to double the store-admin overhead, and store admin is the boring recurring cost
  people underestimate.
- **The voice layer is a feature, not a product.** There is a coherent argument that "ask it out loud"
  is simply the fastest input method for the same calculator, and splitting them presents one tool as
  two.
- **Discovery compounds.** One listing accumulates all installs, ratings, and reviews. Two listings
  split that signal, and Play's ranking rewards concentration.
- **Shared code ships once.** In a merged app the libdedx bridge, alias tables, and unit formatting
  exist in one binary rather than in two artifacts you keep in sync.
- **The download can be made optional anyway.** The existing `ModelDownloadManager` is already
  explicitly user-initiated ("nothing here is ever called except in direct response to a user tap"),
  and `RECORD_AUDIO` is a runtime permission. A merged app could ship as a calculator that _offers_
  voice, with both the permission and the download deferred until the user opts in — which
  substantially defuses the main objection in §4.1.

### 4.3 Recommendation

**Two listings, but build them from one codebase.**

Concretely: one Gradle project in `android/` with two product flavours (or two application modules)
sharing a `:core` library that holds the libdedx bridge, alias tables, unit formatting, and the
answer formatter.

- Flavour `dedx` → `applicationId io.github.aptg.dedx`, no `RECORD_AUDIO`, no `INTERNET`, calculator
  UI only.
- Flavour `aidedx` → `applicationId io.github.aptg.aidedx`, the full voice pipeline plus the same
  calculator UI.

This gets both sets of pros: single codebase, single bridge, shared tests, one place to fix a bug —
but two clean store listings with honest, minimal permission sets. Gradle flavours make the
permission difference a manifest-merge concern rather than a runtime flag, so the calculator flavour
genuinely cannot request the microphone.

If the store-admin overhead in §4.2 turns out to bite, collapsing two flavours into one app later is
easy. Splitting one app into two after launch is not — you'd be asking existing users to migrate.

---

## 5. Licensing

### 5.1 Is GPL-3.0 acceptable on Google Play?

**Yes.** This is a real question with a lot of stale internet folklore attached, so briefly:

- The well-known GPL-vs-app-store conflict is an **Apple App Store** problem (the VLC takedown). Apple's
  terms impose per-device usage limits and DRM on end users, which conflicts with GPL §6 and the
  "no further restrictions" rule.
- **Google Play does not apply DRM to app binaries** and does not impose comparable downstream usage
  restrictions. Play's Developer Distribution Agreement asks you to grant Google the right to
  distribute — which the GPL explicitly permits anyone to do.
- GPLv3's anti-tivoization clause (§6, "Installation Information") binds a party conveying software
  _together with a User Product_. Publishing an app on a store is not that; users remain free to
  build and sideload modified versions.
- The empirical proof: GPLv3 and AGPLv3 apps ship on Google Play routinely — Nextcloud, OsmAnd,
  AntennaPod, Signal, and many others.

**Your obligations** in practice are ordinary and already nearly satisfied:

- Provide corresponding source for each distributed binary. A public GitHub repo satisfies this,
  provided **the tag matches the shipped build**. Both apps already derive `versionName` from
  `git describe --tags`, which makes this automatic — keep that.
- Ship the full licence text with the app (an in-app "Licences" screen, or `LICENSE` in the repo
  linked from the store listing and the About screen).
- Do not add restrictions downstream — don't add an EULA, don't add anti-tamper terms.
- Note the DDA supersedes any separate EULA on conflict, so simply **don't add a EULA**.

### 5.2 Dependency licence audit

| Component                                                   | Licence       | GPL-3.0 compatible?                            | Obligation                                                                                            |
| ----------------------------------------------------------- | ------------- | ---------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `libdedx` (APTG)                                            | GPL-3.0       | Same licence                                   | —                                                                                                     |
| AndroidX `appcompat`, `material`, `viewpager2`, `lifecycle` | Apache-2.0    | Yes (Apache-2.0 → GPLv3 is one-way compatible) | Attribution notice                                                                                    |
| Kotlin stdlib                                               | Apache-2.0    | Yes                                            | Attribution notice                                                                                    |
| sherpa-onnx (k2-fsa)                                        | Apache-2.0    | Yes                                            | Attribution notice                                                                                    |
| ONNX Runtime (bundled by sherpa-onnx)                       | MIT           | Yes                                            | Attribution notice                                                                                    |
| wasm3                                                       | MIT           | Yes                                            | Attribution notice                                                                                    |
| Vico (if adopted for charts)                                | Apache-2.0    | Yes                                            | Attribution notice                                                                                    |
| **NeMo Parakeet-tdt-0.6b-v3 weights**                       | **CC-BY-4.0** | Yes; commercial use permitted                  | **Attribution required — currently unmet, see below**                                                 |
| Whisper weights (`onnx-community/whisper-small`)            | MIT           | Yes                                            | Attribution notice                                                                                    |
| `org.json` 20240303                                         | JSON License  | Test scope only                                | Keep it `testImplementation`; its "Good, not Evil" clause makes it awkward to _ship_, and it never is |

**You are in good shape overall** — every runtime dependency is permissive and one-way compatible with
GPL-3.0. Two gaps:

**Gap A — Parakeet attribution (CC-BY-4.0).** The licence requires crediting NVIDIA. The bench app
currently ships no attribution. Fix: add a "Licences & attributions" screen listing NVIDIA
Parakeet-tdt-0.6b-v3 (CC-BY-4.0) alongside every Apache/MIT notice, and mention it in the store
listing's description.

**Gap B — `dEdx-App` has no `LICENSE` file.** It links GPL-3.0 `libdedx`, so the combined work is a
GPL-3.0 derivative, but the repo states no licence at all. Distributing a binary in that state is at
best ambiguous and at worst a GPL violation. Fix before any Play submission: add `LICENSE` (GPL-3.0),
add SPDX headers to the Java sources, and add a copyright line naming the Aarhus Particle Therapy
Group and the original author.

**On the OSS-licences screen:** avoid Google's `play-services-oss-licenses` Gradle plugin. It pulls in
proprietary Google Play Services, which is an awkward dependency for a GPL app. Hand-maintain a
`NOTICE` asset and render it in an About screen instead — with this few dependencies it's a
30-line file.

### 5.3 A note on authorship and who publishes

`dEdx-App`'s About text credits the Aarhus Particle Therapy Group, Casper Christensen, Jakob
Toftegaard, Niels Bassler, and the Danish Cancer Society. Publishing it under a personal Play account
would put a personal name in the "developer" field of a store listing for work that is
institutionally attributed.

Get explicit sign-off from APTG before submitting, and decide deliberately whether the Play developer
display name should read as an individual or as the group. This is also an argument for eventually
moving to an organization account (§6.2) even if you start with a personal one — the developer name is
publicly displayed and is now subject to identity verification.

---

## 6. Google Play account and the timeline

### 6.1 You have no account yet — this is the critical path

Registration is not instant, and one requirement is measured in calendar days you cannot compress.
**Start this immediately**, in parallel with all technical work.

**Steps:**

1. Create a Google account dedicated to the project (do not use a personal Gmail you'd hate to lose;
   do not use a `@agh.edu.pl` account that IT could deprovision).
2. Register at `play.google.com/console` — **one-time $25 USD fee**.
3. Complete identity verification: legal name, address, phone, and a government ID document.
   Turnaround is typically days but can run longer.
4. Set up a payments profile (required even for free apps, for the account itself).
5. Accept the Developer Distribution Agreement.

### 6.2 Personal vs organization account

|                         | Personal                                         | Organization                                                                          |
| ----------------------- | ------------------------------------------------ | ------------------------------------------------------------------------------------- |
| D-U-N-S number          | Not required                                     | **Required** (free from Dun & Bradstreet; government/university bodies may be exempt) |
| 12-tester / 14-day gate | **Applies** (accounts created after 13 Nov 2023) | **Exempt**                                                                            |
| Developer name shown    | Individual's verified name                       | Organization name                                                                     |
| Continuity              | Tied to one person                               | Survives staff changes                                                                |
| Setup time              | Days                                             | Weeks (D-U-N-S + institutional approval)                                              |

**Recommendation: start personal, migrate later if the project warrants it.** An institutional account
under AGH or IFJ PAN is strictly better long-term — it dodges the tester gate entirely, displays a
credible developer name, and survives you leaving the group. But at a university it means a D-U-N-S
lookup and finance/legal sign-off, which realistically takes longer than simply serving the 14-day
closed test. Play supports transferring apps between accounts later.

If you can get an institutional account moving _in parallel_ at no cost to your own time, do — it
would remove §6.3 entirely.

### 6.3 The 12-tester / 14-day gate

Personal accounts created after 13 November 2023 must run a **closed test with at least 12 testers who
stay opted in for 14 consecutive days** before production access is granted.

Key facts:

- It is **once per account**, not per app. Clear it with dEdx and aidedx inherits an unlocked account.
- Testers must opt in via the closed-testing link and are counted as opted-in continuously; a tester
  who opts in counts even if they later uninstall.
- Emulators generally don't count. Use real devices.
- 12 colleagues in a physics group is an easy ask — this is a _scheduling_ constraint, not a hard one.
  Line up the 12 people now so the clock starts the day the account is verified.

Practical consequence: **the calendar, not the code, is your bottleneck.** Two weeks of closed testing
plus verification plus review means the first production release lands roughly 6–10 weeks after you
register, no matter how fast the engineering goes.

### 6.4 Target API level — a hard deadline 23 days out

**From 31 August 2026, all new apps and updates submitted to Play must target Android 16 (API 36).**
An extension to 1 November 2026 can be requested.

Current state: `dEdx-App` targets 35; `bench/android/full-app` targets 34. **Both must move to 36.**

Do this now rather than at submission time — a target-SDK bump surfaces behaviour changes (predictive
back, edge-to-edge enforcement, stricter foreground-service and broadcast rules) that are much better
found in a leisurely week than in the week you're trying to ship.

Separately, note that Android developer verification for sideloaded distribution begins enforcement in
September 2026. It doesn't change Play publication, but it affects anyone distributing your APKs
outside Play.

---

## 7. Repo and code layout

**Decision taken: monorepo.** The native Android app moves from `bench/android/full-app` to a
first-class `android/` directory in `APTG/aidedx`.

**Why this is right here specifically:** `KotlinMatcherAgreementTest` reads `eval/intents.jsonl` and
`src/lib/aliases/*.json` from this repo directly, and that test — 83/83 semantic agreement between the
Kotlin and TypeScript matchers — is the single most valuable safety net the Android app has. Splitting
repos turns a file read into a submodule or a published artifact, and the coupling silently rots. The
same argument covers `static/wasm/libdedx.wasm`, the alias tables, and the quantity lexicon, all of
which the Android app consumes as assets today.

### 7.1 Proposed structure

```
aidedx/
├── src/                        # SvelteKit web app (unchanged)
├── eval/                       # shared eval set (unchanged)
├── android/                    # promoted from bench/android/full-app
│   ├── settings.gradle.kts
│   ├── core/                   # shared: libdedx bridge, matcher, aliases, formatting
│   ├── app-dedx/               # flavour/module: calculator, no permissions
│   ├── app-aidedx/             # flavour/module: voice assistant + calculator
│   └── vendor/                 # gitignored: libdedx, wasm3 checkouts
├── bench/android/              # the ASR runtime bench apps stay here — they are experiments
└── docs/
```

### 7.2 What changes with the move

- **Assets stop being copied.** Today `android/app/src/main/assets/aliases/*.json` are duplicates of
  `src/lib/aliases/`. Replace with a Gradle task that copies them at build time from the canonical TS
  location, so drift becomes impossible.
- **CI grows an Android job.** The existing gate (`format:check`, `lint`, `check`, `validate:eval`,
  `test`, `build`) stays as-is; add a parallel job running `./gradlew testDebugUnitTest lint` and
  `assembleDebug`. Keep it a separate job so a Gradle failure doesn't mask a TS failure.
- **`bench/android/*` stays put.** The vosk/whisper.cpp/wav2vec2/sherpa bench apps are experiments
  answering issue #120 — they are not product code and shouldn't be promoted.
- **`APTG/dEdx-App` stays its own repo** for now. It has independent history, independent authorship,
  and its own release CI. Once the Kotlin calculator reaches parity, archive it with a README pointing
  at the successor.

### 7.3 CI and release

Model the release workflow on the one `dEdx-App` already has — it is well built:

- Tag-triggered (`v*`), `fetch-depth: 0` so `git describe` resolves.
- Keystore from a `KEYSTORE_BASE64` secret, decoded to a runner temp file.
- `./gradlew bundleRelease` → signed AAB → GitHub Release.

Additions worth making:

- **Upload to Play automatically** via `r0adkll/upload-google-play` or Gradle Play Publisher, using a
  Play Console service-account JSON as a secret. Push to the `internal` track on every tag; promote to
  closed/production by hand.
- **Back up the upload keystore now, offline, in more than one place.** Losing it means losing the
  ability to update the listing. Enrolling in Play App Signing (recommended, and default for new apps)
  makes this recoverable — Google holds the app signing key and you hold only an upload key, which
  _can_ be reset. Enroll.
- Keep `versionCode` derived from `git rev-list --count HEAD` as `dEdx-App` already does. It is
  monotonic and requires no manual bookkeeping.

---

## 8. Store-listing and policy compliance

### 8.1 Data safety and privacy policy

Both apps need a publicly hosted privacy policy URL (a GitHub Pages URL or the raw docs file is fine).

- **dEdx**: `docs/privacy-policy.md` already says the right things — no collection, no network, no
  sensors. Data safety form: "No data collected", "No data shared". Trivial.
- **aidedx**: more care needed. The honest declaration is still **no data collected** — audio is
  processed on-device and never transmitted — but you must say so precisely, because "app uses the
  microphone" invites scrutiny. Points to state explicitly:
  - Audio is recorded, transcribed on-device, and discarded; nothing is uploaded.
  - The only network activity is downloading model files from the Cyfronet mirror.
  - **The field-capture feature is the sharp edge.** `CapturePrefs.captureEverything` defaults to off,
    which is the correct default — but the privacy policy must describe what a capture contains (a WAV
    of your voice, device info, and a pipeline trace), that it stays in app-private storage, and that
    the user exports it manually. Consider whether a debug feature belongs in a production build at
    all; a `debug`-only Gradle variant would remove the question entirely.
  - If BYOK is added (§9), the policy must state that enabling it sends the transcript to a
    third-party provider of the user's choosing, and that the key is stored locally.

### 8.2 Permissions

- dEdx flavour: **none**. Keep it that way — it's a genuine selling point in the listing.
- aidedx flavour: `RECORD_AUDIO`, `INTERNET`, `ACCESS_NETWORK_STATE`. The `WRITE_EXTERNAL_STORAGE`
  entry is already correctly capped at `maxSdkVersion 28`. No sensitive-permission declaration form is
  needed for these.

### 8.3 The 670 MB download

Play policy prohibits apps downloading **executable code** from outside Play. ONNX model weights are
data, not code, so runtime download is fine — but be deliberate:

- Default to **Wi-Fi-only** downloads, and say the size plainly before starting. A 670 MB surprise on
  mobile data earns one-star reviews.
- Consider offering whisper-small int8 (~240 MB) as a lighter alternative for storage-constrained
  devices, given this repo has already benchmarked it.
- Play Asset Delivery is an alternative to your own mirror, but it would tie the models to Play
  distribution and lose the Cyfronet mirror the web app shares. Stick with runtime download.

### 8.4 Generative-AI content policy

Play's AI-generated content policy (effective 15 July 2026) requires apps that generate content with
AI to provide **in-app reporting of offensive output** and to prevent policy-violating generation.

Today aidedx arguably falls outside it: the ASR transcribes and the matcher is deterministic — nothing
"generates" open-ended content. **Adding an LLM correction layer changes that**, since an LLM would
produce free-form text. If you go there:

- Add an in-app "report this answer" affordance.
- Declare the AI functionality in the Play Console's AI-related questions honestly.
- Keep the LLM strictly in the correction/parsing role, with the physics numbers always coming from
  libdedx. This is already the project's design principle and it is also the best possible policy
  posture.

### 8.5 Medical / regulatory framing — flag this early

This is a stopping-power tool from a particle-therapy group. That adjacency deserves a deliberate
decision.

- **Do not market it for clinical use.** Words like "treatment planning", "dosimetry for patients", or
  "clinical" in the store listing move software toward being a medical device under EU MDR, with
  consequences far beyond a Play listing.
- Position it as an **educational and research reference tool**.
- Carry the existing libdedx disclaimer verbatim into the listing and the About screen: _"We do not
  claim any correctness of the produced results, any use of these data are at own risk."_ It is
  already in `dEdx-App`'s About text — keep it, and add it to aidedx.
- Avoid Play's "Medical" category; "Education" or "Tools" is the right home.

### 8.6 Listing assets to prepare

For each app: app icon (512×512), feature graphic (1024×500), at least 2 phone screenshots (4–8 is
better), a short description (80 chars), a full description (4000 chars), category, contact email,
and the privacy policy URL. Screenshots of the answer flow will do most of the selling for aidedx.

---

## 9. BYOK cloud AI — the provider layer

**Decision taken: BYOK only.** The user supplies their own API key or OpenAI-compatible endpoint.

This is the right call and the reasoning is worth recording:

- **No Play Billing.** Play requires Play Billing for in-app purchases of digital content, taking
  15–30 %. BYOK involves no in-app transaction — the user pays a third party directly, exactly like
  logging into your own cloud account. No cut, no billing integration, no compliance surface.
- **No backend.** A managed paid tier needs a proxy holding your keys, plus rate limiting, abuse
  handling, and an ops burden. BYOK needs none.
- **No university finance involvement.** No VAT, no invoicing, no revenue that has to be accounted for
  by an institution.
- **The privacy story stays clean.** Default remains fully on-device; cloud is opt-in, per-user,
  under the user's own account and their own agreement with the provider.

### 9.1 Design sketch

Define one interface with pluggable implementations, so no provider is privileged:

```kotlin
interface TranscriptionProvider {  // on-device Parakeet, or a cloud ASR
    suspend fun transcribe(audio: FloatArray, sampleRate: Int): String
}

interface CorrectionProvider {     // null = deterministic rules only
    suspend fun correct(rawTranscript: String, context: DomainContext): String
}
```

- Ship **on-device as the default and only preselected option**. Cloud providers are strictly opt-in.
- Support a **generic OpenAI-compatible** configuration (base URL + model name + key). That single
  implementation covers OpenAI, Groq, Together, OpenRouter, local Ollama/llama.cpp servers, and
  anything else speaking that dialect — far more valuable than hard-coding three vendors.
- Add a native Anthropic implementation if wanted; its API differs enough to warrant its own class.
- **Store keys in `EncryptedSharedPreferences`**, never in plain prefs, never logged, never included
  in a field-capture envelope. Add an explicit test asserting the capture writer cannot serialize a
  key.
- **Always degrade gracefully.** A cloud failure, timeout, or exhausted quota must fall back to the
  on-device path, not to an error screen.
- **Never let a cloud model produce a number.** The LLM's only job is turning messy speech into a
  clean `QueryIntent`; libdedx computes every value. Enforce this at the type level — the correction
  provider returns text or an intent, never a result.
- Show a clear indicator in the UI when a query leaves the device. Users chose this app partly because
  it doesn't.

---

## 10. Phased work plan

### Phase 0 — Unblock (this week, ~1 day of work)

1. Register the Play developer account, pay $25, submit identity verification. **Do this first.**
2. Line up 12 testers with real Android devices; collect their Google account emails.
3. Add `LICENSE` (GPL-3.0) + copyright headers + a `NOTICE` file to `APTG/dEdx-App`. Get APTG sign-off
   on publishing.
4. Open a tracking issue in `APTG/aidedx` linking this document.

### Phase 1 — Ship dEdx (weeks 1–4 of work; ~6–10 weeks of calendar)

1. Bump `dEdx-App` to `compileSdk`/`targetSdk 36`; fix any behaviour changes surfaced.
2. Add an in-app "Licences & attributions" screen.
3. Verify the physics against the known values in `MODERNIZATION.md` §7 on a real device; add at least
   a smoke-level instrumentation test so this is repeatable.
4. Enroll in Play App Signing; back up the upload keystore offline in two places.
5. Prepare listing assets (§8.6); host the privacy policy at a stable URL.
6. Extend the release workflow to upload to the Play `internal` track automatically.
7. Push to closed testing, get 12 testers opted in — **start the 14-day clock**.
8. During those 14 days, do Phase 2 work. Don't idle.
9. Apply for production access; submit for review; publish.

### Phase 2 — Promote the aidedx Android app (weeks 2–8, overlaps Phase 1)

1. Move `bench/android/full-app` → `android/`, restructure into `core` + two flavours (§7.1).
2. Bump to `targetSdk 36`; add `armeabi-v7a` and `x86_64` back if the Kotlin app is to succeed the
   legacy one.
3. Pick one libdedx path and delete the other. The spike measured warm wasm3 at 0.218 ms/call, which
   is comfortably fast enough — but native JNI removes an entire vendored interpreter from the build.
   Decide, document the reason, drop the loser.
4. Replace the copied alias/lexicon assets with a build-time copy task from `src/lib/`.
5. Add the Android job to CI.
6. Add the "Licences & attributions" screen, including **NVIDIA Parakeet CC-BY-4.0** (§5.2 Gap A).
7. Decide the fate of the field-capture UI in production builds — recommend `debug`-variant only.
8. Wi-Fi-only default and an explicit size warning on the model download.

### Phase 3 — dedx_web feature parity in Kotlin (Q4 2026)

1. Compose UI: particle picker, material picker, energy input with units, energy-range sweep.
2. Results table with copy/share.
3. Interactive plot (Vico, or Compose `Canvas`), log axes, pan/zoom.
4. Inverse mode (CSDA range → energy), matching the legacy app exactly — port its verification values
   into a JVM test.
5. Export: CSV and PNG.
6. Decide the legacy app's ending (§3.3): replace in place under the same `applicationId`, or archive.

### Phase 4 — Publish aidedx (Q1 2027)

1. Listing assets, privacy policy covering microphone + captures + BYOK.
2. Internal → closed → production. The account is already unlocked, so this is fast.
3. Watch crash/ANR rates in Play Console vitals; the 639 MB model load is the obvious risk on
   low-memory devices — set a realistic device minimum and use Play Console's device exclusions.

### Phase 5 — BYOK cloud AI (after Phase 4)

Per §9. Ship it as an opt-in "Advanced" settings section, off by default.

---

## 11. Risk register

| Risk                                               | Likelihood | Impact                          | Mitigation                                                                              |
| -------------------------------------------------- | ---------- | ------------------------------- | --------------------------------------------------------------------------------------- |
| 12-tester gate slips (testers don't stay opted in) | Medium     | 2-week delay each retry         | Over-recruit — get 15–18, not 12; confirm opt-ins on day 1 and day 7                    |
| targetSdk 36 deadline missed                       | Low        | New submissions rejected        | Bump now; extension to 1 Nov 2026 available as a backstop                               |
| Identity verification delays                       | Medium     | Blocks everything               | Start this week; have ID documents ready                                                |
| Keystore lost                                      | Low        | Cannot update the listing, ever | Play App Signing + two offline backups                                                  |
| Play rejects over microphone/AI framing            | Low        | 1–2 week review loop            | Precise Data safety declaration; educational framing; no clinical claims                |
| 639 MB model OOMs on low-end devices               | **High**   | Crashes, bad reviews            | Device minimums, Play Console exclusions, offer whisper-small as a lighter option       |
| Regulatory scrutiny from clinical framing          | Low        | Serious                         | §8.5 — educational positioning, disclaimer, no Medical category                         |
| GPL source-availability obligation unmet           | Low        | Licence violation               | Tag every release; `git describe`-derived versions already do this                      |
| Scope creep in dedx_web parity                     | **High**   | Phase 3 never ends              | Cut Phase 3 into shippable slices; forward dE/dx table first, plot second, export third |

---

## 12. Open questions for you

1. **Personal or institutional account?** Recommendation is to start personal for speed while asking
   AGH/IFJ about an organization account in parallel. Do you want to pursue the institutional route?
2. **Has APTG (Niels Bassler) agreed to a Play release** of `dEdx-App`, and under what developer name?
3. **wasm3 or native JNI** for libdedx in the Kotlin app? Both are built and device-verified; the
   spike doesn't force a choice. Native is my recommendation — it deletes a vendored interpreter.
4. **Should the field-capture feature exist in production builds?** Recommendation: debug-only.
5. **Does the calculator flavour need the aidedx branding**, or should the two listings look like
   sibling products from the same group?

---

## 13. References

- [Target API level requirements for Google Play apps](https://support.google.com/googleplay/android-developer/answer/11926878)
- [App testing requirements for new personal developer accounts](https://support.google.com/googleplay/android-developer/answer/14151465)
- [Choose a developer account type](https://support.google.com/googleplay/android-developer/answer/13634885)
- [Google Play Developer Program Policy](https://support.google.com/googleplay/android-developer/answer/16810878)
- [Google Play Developer Distribution Agreement](https://play.google/developer-distribution-agreement.html)
- [nvidia/parakeet-tdt-0.6b-v3 model card (CC-BY-4.0)](https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3)
- [`docs/android-full-app-spike.md`](./android-full-app-spike.md) — the device-verified spike this plan builds on
- [`docs/android-asr-runtime-bench.md`](./android-asr-runtime-bench.md) — ASR runtime selection
- [`docs/model-hosting-cyfronet.md`](./model-hosting-cyfronet.md) — the model mirror
- [`docs/development.md#third-party-licenses`](./development.md#third-party-licenses) — the web app's licence table
