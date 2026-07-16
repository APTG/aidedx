# assets/

SVG diagrams embedded in the [root README](../../README.md). Hand-authored inline SVG (no
diagramming-tool source file to keep in sync) using a GitHub-flavored light palette.

| File pair                                              | Used for                                                                                                       |
| ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| `pipeline-light.svg` / `pipeline-dark.svg`             | The one-time model download, then the four-stage on-device pipeline (speech → understand → compute → explain). |
| `local-vs-cloud-light.svg` / `local-vs-cloud-dark.svg` | Contrasts a typical cloud round-trip AI tool with aidedx's local-only inference.                               |

## Light/dark convention

Each diagram ships as a light/dark pair with **identical markup** — same `viewBox`, layout, and
text — differing only in fill/stroke colors, switched via the standard
`<picture>`/`prefers-color-scheme` pattern:

```html
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/pipeline-dark.svg" />
  <img alt="…" src="docs/assets/pipeline-light.svg" width="820" />
</picture>
```

See the root README for the exact markup (including the `alt` text, which duplicates the SVG's own
`<title>`/`aria-label` for accessibility). If you add a third diagram, copy an existing pair's
structure — same GitHub-style color tokens (`#1f2328` text, `#d0d7de` borders, `#2d6fcd` accent
blue, etc.) — rather than introducing a new palette.
