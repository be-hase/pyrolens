# AGENTS.md

Guidance for AI coding agents working in this repository. This file is the
single source of truth; `CLAUDE.md` just points here.

## Orientation

Pyrolens is a profiling UI for Grafana Pyroscope — Tag Explorer, Single,
Comparison and Diff — shipped as one Go binary that embeds the built React
app and reverse-proxies the query API. `README.md` has the user-facing
description, the flags and the URL parameters.

Two decisions explain most of the code:

**The URL is the application state.** Tenant, query, time range, per-pane
selections and the group-by label are all query parameters, so any screen can
be copied to a colleague. Components change the screen by navigating, not by
holding state.

**The dependency list is deliberately tiny** — four runtime npm packages
(react, react-dom, tinycolor2, @leeoniya/ufuzzy) and the Go standard library.
Routing, charts and the UI primitives are hand-written for this reason.
Adding a dependency is a decision to raise explicitly, not a detail to slip
into a diff.

## The build coupling you will trip over first

`main.go` embeds the built UI with `//go:embed all:dist`. Nothing Go-related
compiles until that directory exists:

```console
yarn build      # -> dist/
go build ./...  # only works after the line above
```

This applies to `go vet` and `go test` too, since they compile the package.
CI orders its steps this way and GoReleaser does it in a `before` hook — if
you are adding a workflow or a script, do the same.

The reverse also bites: **GoReleaser's output directory must not be `dist/`**,
or `--clean` deletes the UI mid-release. `.goreleaser.yaml` points it at
`.goreleaser-dist`.

## Commands

```console
yarn install --immutable
yarn dev            # vite on :5173; PYROSCOPE_URL=... to point it elsewhere
yarn type-check     # tsc -b
yarn lint           # eslint
yarn format         # prettier --check   (format:fix to write)
yarn test           # vitest: units, hooks and components (jsdom)
yarn build          # -> dist/

go test ./...       # server tests (needs dist/, see above)

make build          # yarn build + go build -o pyrolens
make run            # build, then serve on :4041
make docker         # local image
make snapshot       # exercise the release pipeline without publishing
```

Releases are cut by pushing a `vX.Y.Z` tag: `.github/workflows/release.yml`
validates the tag, re-runs CI against it, then hands off to GoReleaser for
the binaries and the image.

## Where things live

- `main.go` — the entire server. Serves the embedded SPA (with an
  `index.html` fallback so deep links work), proxies
  `/querier.v1.QuerierService/*` and `/pyroscope/*` to `PYROSCOPE_URL`,
  answers `/healthz`. Standard library only.
- `src/urlState.ts` — routing over `history.pushState`. `navigate()` writes
  params and dispatches `pyroscope:navigate`; `useRoute()` subscribes.
- `src/App.tsx` — resolves the URL into `ViewProps`, owns the tenant flow
  (single / multi / unreachable), the theme, and the default query.
- `src/queryLang.ts` — the PromQL-shaped selector: parse, format, and the
  `profile_type` pseudo-label that `splitQuery` peels off for the API.
- `src/api/client.ts` — every RPC. Connect-JSON over `fetch`, relative URLs,
  `X-Scope-OrgID` when a tenant is set, int64-as-string normalised.
- `src/hooks/` — fetch-and-render-state hooks. `src/views/` — the four
  views. `src/components/` — app UI, with `core/` holding the primitives.
- `src/components/flamebearer.ts` — Pyroscope's wire format to the columnar
  frame the flame graph consumes.
- `src/lib/flamegraph/` — **vendored**; see its `VENDORED.md` before touching
  it. Excluded from eslint on purpose, and its classes are prefixed `plfg-`
  so they cannot collide with app styles.
- `vitest.config.ts` — the test setup, built on `vite.config.ts` so tests
  resolve imports and compile TSX the way the bundle does. jsdom, Testing
  Library, and `node:assert/strict` for the assertions.

## Rules that are easy to break

Each of these was learned from a real defect, and breaking one tends to look
fine in a quick test.

### State and navigation

- A control changes the screen by calling `navigate()`. The only local state
  is an edit buffer — the query bar, the range-picker draft — that resets
  when its URL value changes.
- **"Now" advances on every navigation, including one that changes nothing.**
  That is what makes Run a real refresh for a relative range. It is a cached
  snapshot read through `useSyncExternalStore`, so renders stay pure; do not
  call `Date.now()` during render to paper over staleness.
- **The tenant header is synced outside React.** A module-level listener on
  `popstate` and `pyroscope:navigate` calls `setTenant()` before any effect
  runs, so nothing can be requested against the previous tenant. Do not move
  it into a component.

### Fetching

- **Derive `loading` and `error`; never reset them from an effect body.**
  When there is nothing to fetch the derived values disappear on their own.
  The effect-reset version left the spinner running forever whenever the next
  query was unparseable, and the lint rule rejects it besides.
- **Every fetch takes an `AbortSignal`, and every path after an `await`
  re-checks `signal.aborted` before touching state** — success paths
  included, or rapid navigation writes a superseded response over the current
  one.

### Building a query

- **Escape values, validate label names.** `escapeValue` for anything spliced
  between quotes — a typeahead suggestion containing a backslash silently
  queried something else — and `isValidLabelName` for a label arriving from a
  URL parameter or from server data, which could otherwise smuggle extra
  matchers into the query.
- A malformed query is not the same as an empty one; `isMalformedQuery` is
  what tells the user their query was ignored rather than silently doing
  nothing.

### Rendering

- **Flamebearer decoding is iterative on purpose.** A recursive walk
  overflows the stack somewhere under 7000 frames and takes the whole app
  down; keep the explicit stack in `flamebearer.ts`.
- **Charts scale their marks with the same value the axis labels use.**
  Reading a peak against a gridline has to give the number on that gridline —
  scaling by the raw max while labelling with a rounded one was off by up
  to 2×.
- **No `toLocale*` for dates or numbers.** The browser's locale otherwise
  leaks into an English UI; this shipped once as Japanese era names in a date
  picker. Use the fixed helpers in `src/time.ts` and `timeseries-utils.ts`.

### Server

- The proxy's error detail goes to the log, not to the browser.
- Requests are forwarded with the upstream's `Host`, so name-based routing
  (an ingress, Grafana Cloud) reaches the right backend.

## Verifying a change

Type-checking and unit tests do not catch a wrong wire field, a broken canvas
transform, or a control that stopped applying. For anything beyond a pure
function:

1. **Bring up a Pyroscope with data in it.**
   `docker compose -f dev/compose.yaml up -d` starts one and feeds it
   profiles shaped to exercise every view — see `dev/README.md`, which also
   covers the single-tenant variant.
2. **Drive the actual UI** — `make run`, then use the feature you changed.
3. **Look at it.** When a change is visual, screenshot the four views in both
   themes before calling it done (`dev/screenshot.mjs` does all eight).
   Several regressions here were invisible to every automated check and
   obvious at a glance.
4. **Confirm what is actually being served.** The binary embeds the UI at
   build time, so a stale process serves a stale app and every conclusion
   drawn from it is wrong. Rebuild, restart, and check that the asset hash
   the server returns matches `dist/`.

Report honestly what you ran and what you did not.

## Conventions

- Node 24 and Go 1.25, both pinned by mise; yarn 4 via corepack. **Node 25
  dropped corepack from the distribution**, so a bump past 24 has to install
  it first (`npm i -g corepack`) wherever `corepack enable` runs — CI, the
  Dockerfile and the GoReleaser hooks. CI fails loudly if this is missed.
- TypeScript is strict with `erasableSyntaxOnly`, so **`enum` does not
  compile** — use `const X = {…} as const` with a matching type alias.
- Prettier and eslint are CI gates (single quotes, semicolons, trailing
  commas, 2-space indent, printWidth 80); `gofmt` and `go vet` likewise.
- Styling is a plain CSS file next to the component, driven by the tokens in
  `src/theme.css`. The vocabulary is fixed: hover surfaces use
  `--action-hover`; a selected row uses `--action-selected` plus accent text;
  floating panels use `--shadow-md`, modals `--shadow-lg`; filled buttons use
  `--color-primary-strong`, which is a step darker than the accent so white
  label text stays legible. Reach for a token before inventing a value.
- Comments say why, not what — a comment earns its place by recording a
  constraint the code cannot show. Errors are for the person stuck: say what
  happened and what to do next.
- Commit messages are English: a one-line summary, then what changed and why.
  Commit as work progresses rather than one large drop.
