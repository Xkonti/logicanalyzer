# LogicAnalyzer Web Client

Web-based port of the LogicAnalyzer desktop application. Connects directly to a Pico 2W logic analyzer board via Web Serial API (USB) and WebSocket (WiFi) — no backend server required. Targets Chrome/Edge only (Web Serial is Chromium-only).

## Reference

- **Design document:** `./design.md` — full architecture, data flow diagrams, interface contracts, phased porting plan, and rendering/decoder strategy.
- **Desktop app being ported:** `../LogicAnalyzer/` — the original Avalonia/.NET desktop application. Key source directories:
  - `../LogicAnalyzer/SharedDriver/` — core driver library (protocol, transport, capture session types)
  - `../LogicAnalyzer/LogicAnalyzer/` — Avalonia GUI app (main window, controls, decoder bridge)
  - `../LogicAnalyzer/CLCapture/` — CLI capture tool
  - `../LogicAnalyzer/SignalDescriptionLanguage/` — signal DSL parser

## Tech Stack

- **Framework:** [Quasar Framework](https://quasar.dev/) v2 (Vue 3 + Vite)
- **Language:** JavaScript (ES modules). The `core/` layer will be pure JS with no Vue/Quasar imports.
- **Package manager:** bun (not npm/yarn/pnpm). Use `bun install`, `bun run dev`, etc.
- **State management:** Pinia v3
- **UI components:** Quasar's built-in component library (Material Design)
- **Rendering:** WebGL2 for waveforms (planned), Canvas 2D overlay for annotations
- **Config:** `quasar.config.js` is the main build configuration (wraps Vite)

## Project Structure

Quasar CLI convention — all source is under `src/`:

```
src/
├── boot/          # Boot files — run before Vue app mounts (e.g., axios setup)
├── components/    # Reusable Vue/Quasar components
├── composables/   # Vue composables (bridge between core logic and Vue reactivity)
├── core/          # Pure JS — framework-agnostic logic (transport, protocol, driver,
│                  #   capture data model, decoders, renderer). NO Vue imports here.
├── css/           # Global SCSS
├── layouts/       # Page layout shells (toolbar, drawer, footer)
├── pages/         # Route-level page components
├── router/        # Vue Router configuration
├── stores/        # Pinia stores (reactive state)
├── workers/       # Web Workers (capture processing, decoder execution)
└── App.vue        # Root component
```

See `design.md` for the full breakdown of planned modules within each directory.

## Commands

### Dev server

**DO NOT run the dev server.** Only the user may start it. If you need to verify changes, use `bun run build` or `bun run test` instead or just ask the user to start it.

```sh
bun run dev
```

Opens a browser at `http://localhost:9000` (Vite HMR, auto-reload).

### Build

```sh
bun run build
```

Produces a static SPA in `dist/spa/`.

### Lint

```sh
bun run lint
```

Runs ESLint (flat config at `eslint.config.js`) on all `.js`, `.cjs`, `.mjs`, and `.vue` files under `src/`.

### Format

```sh
bun run format
```

Runs Prettier on JS, Vue, SCSS, HTML, MD, and JSON files. Config at `.prettierrc.json` — single quotes, no semicolons, 100 char print width.

### Tests

```sh
bun run test
```

Uses Vitest. Tests live next to source files or under `src/**/__tests__/`. Run a specific test file:

```sh
bun run test -- src/core/protocol/packets.test.js
```

Watch mode during development:

```sh
bunx vitest --watch
```

## Code Conventions

- **`core/` is framework-agnostic.** No Vue, Quasar, or Pinia imports in `src/core/`. It must be testable with plain Vitest without a DOM.
- **Components never import from `core/` directly.** They go through composables and stores. The data flow is: `core/ → stores/ → composables/ → components/`.
- **Quasar auto-imports components.** You don't need to manually import `<q-btn>`, `<q-input>`, etc. — Quasar's Vite plugin handles it.
- **Boot files** in `src/boot/` run before the app mounts. Use them for global setup (e.g., checking Web Serial API availability).
