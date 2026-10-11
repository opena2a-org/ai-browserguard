# ADR-002: Vanilla TypeScript Without UI Frameworks

**Status:** Accepted
**Date:** 2026-02-27

## Context

The extension popup (`src/popup/`) provides the primary user interface:
detection status, delegation wizard, kill switch, session timeline, and
violation log. Several UI framework options were considered:

- **React/Preact**: Familiar ecosystem, component model, but adds 40-130 KB
  to the bundle and requires a virtual DOM reconciliation step on every render.
- **Svelte**: Smaller runtime footprint, but still introduces a compiler
  toolchain dependency and framework-specific abstractions.
- **Vanilla TypeScript + CSS**: Direct DOM manipulation, no abstraction layer,
  smallest possible bundle.

Chrome extension popups must open instantly. Users activate the popup during
active agent sessions to check status or trigger the kill switch. Any
perceptible delay undermines trust in a security tool.

## Decision

Use vanilla TypeScript with manual DOM manipulation for all UI components.
CSS is authored as plain stylesheets loaded via `<link>` in
`src/popup/index.html`. No UI framework, virtual DOM, or CSS-in-JS library
is included as a runtime dependency. Fonts are self-hosted
(`fonts/inter-latin.woff2`) to avoid external network requests.

The Vite build for the popup entry (`ENTRY=popup` in `vite.config.ts`)
produces a single `popup.js` and `styles.css` output, with no shared chunks
or dynamic imports.

## Consequences

### Positive
- Total popup bundle is approximately 88 KB (JS + CSS + HTML + font),
  compared to 200 KB+ with React or 150 KB+ with Preact.
- Popup renders in a single synchronous pass with no framework initialization
  overhead.
- Zero runtime dependencies means zero supply chain attack surface from
  UI libraries, which is important for a security extension.
- TypeScript strict mode (`tsconfig.json`) provides type safety without
  needing framework-specific type wrappers.

> **Correction (2026-10-11).** The 88 KB total above does not match the build.
> Measured on 2026-10-11 after `npm run build`: `dist/popup/index.html` is 4,760
> bytes, `dist/popup/styles.css` 28,557 bytes, `dist/popup/popup.js` about
> 117 KB without its inline source map, and `fonts/inter-latin.woff2` 230,192
> bytes. The popup is therefore about 380 KB with the font, which alone is
> larger than the 88 KB stated. `popup.js` ships with its source map inline
> (`sourcemap: 'inline'` in `vite.config.ts`), which brings it to about 480 KB
> and the popup to about 744 KB as packaged. The `popup.js` sizes are rounded
> because they change whenever the popup's code does. The React and Preact
> figures in the same bullet were compared against the 88 KB total and were not
> re-measured. The decision is unchanged: the popup has no UI framework and no
> runtime dependencies. To re-measure:
> `npm run build && wc -c dist/popup/index.html dist/popup/styles.css dist/popup/popup.js dist/fonts/inter-latin.woff2`.

### Negative
- DOM updates require manual `document.createElement`, `addEventListener`,
  and element property assignment. This is more verbose than declarative
  JSX or Svelte templates.
- No component lifecycle management. State synchronization between the
  popup and background service worker must be handled explicitly via
  `chrome.runtime.sendMessage` and `chrome.storage.onChanged`.
- UI refactoring (e.g., adding new delegation wizard steps) requires
  more boilerplate than equivalent framework code.

### Neutral
- Vitest runs tests against the TypeScript source directly, independent of
  any DOM rendering library. This would be true regardless of framework
  choice.
- The build script (`scripts/build.js`) handles popup as one of three
  separate Vite builds. Adding a framework would not change the multi-entry
  build architecture.
