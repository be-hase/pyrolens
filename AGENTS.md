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
yarn type-check     # tsc -b --noEmit
yarn lint           # eslint
yarn format         # prettier --check   (format:fix to write)
yarn test           # vitest: units, hooks and components (jsdom)
yarn test:coverage  # the same, with a report of what has no unit test
yarn test:e2e       # playwright: the real binary against captured fixtures
yarn build          # -> dist/

go test ./...       # server tests (needs dist/, see above)

make build          # yarn install + yarn build + go build -o pyrolens
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
  `/querier.v1.QuerierService/*` to `PYROSCOPE_URL`, answers `/healthz`.
  Standard library only.
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
  `src/components/TimeRangePicker.tsx` also hosts the global keyboard
  shortcuts; `src/hooks/useFlameGraphUrlState.ts` lifts the flame graph's
  search/sandwich into the URL; `src/clipboard.ts` is the copy helper with
  the insecure-context fallback.
- `src/components/flamebearer.ts` — Pyroscope's wire format to the columnar
  frame the flame graph consumes.
- `src/lib/flamegraph/` — **vendored**; see its `VENDORED.md` before touching
  it. Excluded from eslint on purpose, and its classes are prefixed `plfg-`
  so they cannot collide with app styles.
- `vitest.config.ts` — the test setup, built on `vite.config.ts` so tests
  resolve imports and compile TSX the way the bundle does. jsdom, Testing
  Library, and `node:assert/strict` for the assertions.
- `e2e/` — browser tests against the real binary, with a fake Pyroscope
  replaying responses captured from a real one. See `e2e/README.md` before
  touching the fixtures; a scheduled job re-captures against a live server and
  fails when the responses no longer have the shape they were recorded with.
- `src/components/timeseries-utils.ts`, `src/views/tagExplorerData.ts`,
  `src/hooks/useEditBuffer.ts` — the arithmetic and the state rules the views
  and charts would otherwise hide inside a component, kept out here so they
  can be checked directly. `yarn test:coverage` reads 0% for the views and the
  canvases because only the browser suite reaches them, which it does not
  count.

## Rules that are easy to break

Each of these was learned from a real defect, and breaking one tends to look
fine in a quick test.

### State and navigation

- A control changes the screen by calling `navigate()`. The only local state
  is an edit buffer — the query bar, the range-picker draft — that resets
  when its URL value changes.
- **Transient UI state next to an edit buffer resets with it.** The query
  bar's caret offset and open typeahead are anchored to `committedQuery`, the
  URL value, not to the draft (which changes on every keystroke). Left
  unanchored they survived the URL moving underneath — App writing the
  default query in mid-typing — and the popup then spliced a suggestion into
  the new text at an offset that meant something else entirely.
- **"Now" advances on every navigation, including one that changes nothing.**
  That is what makes Run a real refresh for a relative range. It is a cached
  snapshot read through `useSyncExternalStore`, so renders stay pure; do not
  call `Date.now()` during render to paper over staleness.
- **Every param write is therefore also a refresh** — a groupBy click, a sort
  click, a search commit all refire relative-range fetches. Typed input must
  not write per keystroke: the flame graph search keeps a local draft for
  keystroke-fast highlighting and debounces one replace-navigation per burst.
- **When two components write the same param, each may publish only once its
  debounce has settled on its own draft.** The Comparison panes share
  `fgSearch`; a writer that navigated on any draft/URL mismatch let one
  pane's stale empty debounce delete the other pane's committed value in an
  infinite replaceState ping-pong (and let a stale draft clobber the entry
  Back had just reached).
- **Constructed URLs keep relative state relative.** Baking `now-1h` into
  absolute ms silently kills auto-refresh — the picker still shows "30s"
  while nothing ticks — and the NavBar carries params across views, so a
  frozen window compounds on every click. `previousPeriodParams` and
  `swappedPaneParams` emit relative forms for relative input
  (`swappedPaneParams` falls back to absolute when the halves cannot be
  expressed in whole seconds); do the same in anything new that writes
  ranges.
- **A pane param that is absent inherits; an empty string overrides.**
  `params.get('leftQuery') ?? mainQuery` makes absence mean "follow the main
  query" — so never materialize resolved values where absence was the point.
  A swap that wrote resolved queries pinned both panes against later query
  changes, and a click during startup wrote `''` as a pane query that
  inheritance then honoured forever.
- **The tenant header is synced outside React.** A module-level listener on
  `popstate` and `pyroscope:navigate` calls `setTenant()` before any effect
  runs, so nothing can be requested against the previous tenant. Do not move
  it into a component.

### Fetching

- **Every data hook goes through `src/hooks/useFetched.ts`.** The
  abort/loading/error protocol had six hand-written copies once and they
  drifted: one never aborted, one never cleared a stale error, one left the
  spinner stuck when disabled. Add a fetch by calling `useFetched`, not by
  pasting the shape again.
- **Derive `loading` and `error`; never reset them from an effect body.**
  When there is nothing to fetch the derived values disappear on their own.
  The effect-reset version left the spinner running forever whenever the next
  query was unparseable, and the lint rule rejects it besides.
- **A fetch that is due but has not started still counts as loading.**
  Effects run after the commit, so between a deps change and the fetch
  starting there is a render holding the previous data with nothing in
  flight; reporting "not loading" there paints an empty result as though it
  were the answer. `useFetched` compares the key a fetch was started for
  against the current one.
- **Every fetch takes an `AbortSignal`, and every path after an `await`
  re-checks `signal.aborted` before touching state** — success paths
  included, or rapid navigation writes a superseded response over the current
  one. `abort()` does nothing to a response that has already been parsed.
- **`retry()` re-runs the current key; its run identity is `key#attempt`.**
  Comparing `started` against the run id (not the key) is what keeps the gap
  between the click and the effect counting as loading. Data validity stays
  keyed by the key alone, so a retry shows the previous answer while
  reloading, like any refetch.
- **Auto-refresh must not abort work it caused.** A tick advances every
  fetch key, and `useFetched` aborts-and-reissues on a key change — so a
  query slower than the interval would never complete. Ticks skip while
  `fetchesInFlight()` (client.ts) is nonzero; anything else that navigates
  on a timer should do the same.

### Building a query

- **Escape values, validate label names.** `escapeValue` for anything spliced
  between quotes — a typeahead suggestion containing a backslash silently
  queried something else — and `isValidLabelName` for a label arriving from a
  URL parameter or from server data, which could otherwise smuggle extra
  matchers into the query.
- A malformed query is not the same as an empty one; `isMalformedQuery` is
  what tells the user their query was ignored rather than silently doing
  nothing.
- **The `profile_type` pseudo-label has one shared assessment**
  (`assessProfileType`), and its three readers — `malformedQueryReason`,
  `splitQuery`, `parseQuery` — agree by construction. When they each
  re-derived their own notion, a query could be reported as ignored while
  its fetch still ran with a "last one wins" value. The user-facing message
  (`PROFILE_TYPE_MESSAGE`) fires on the same verdict but its wording is
  hand-maintained — keep it in sync when the rules change.

### Keyboard shortcuts and the clipboard

- Every binding (`y`, the `t` sequences) shares one keydown listener in
  `TimeRangePicker.tsx`, guarded against `defaultPrevented`, modifiers, and
  editable targets. It registers once and reads the current range through a
  ref: an effect keyed on `range` re-registered on every auto-refresh tick,
  and its cleanup disarmed the sequence a user was mid-way through typing.
- **The clipboard is untrusted, asynchronous input.** `t v` parses strictly
  (validated relative syntax, zoned ISO, local timestamps, epoch ms within
  bounds `resolveTime` reads back as ms; calendar rollovers rejected — V8's
  `Date.parse` turns Feb 30 into Mar 2), and a settled read applies only if
  the URL still equals the one captured at dispatch. A tick leaves the URL
  identical and passes; a real navigation discards — synchronously, so there
  is no timing window.
- `navigator.clipboard` exists only in secure contexts; writes fall back to
  `execCommand` (src/clipboard.ts), reads have no fallback and fail with
  visible feedback rather than silence.

### Rendering

- **Flamebearer decoding is iterative on purpose.** A recursive walk
  overflows the stack somewhere under 7000 frames and takes the whole app
  down; keep the explicit stack in `flamebearer.ts`.
- **Axis ticks snap to local wall-clock boundaries, re-reading the zone
  offset at every tick.** The labels are rendered with local getters, so an
  epoch-aligned day tick claims a midnight it does not sit on — nine hours
  off in UTC+9. Extrapolating one offset across the range is the same bug
  reduced to an hour: across a DST transition it draws two gridlines with the
  same date and none for the next day.
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
- **A missing file 404s; only view routes fall back to the SPA shell.**
  Anything under `assets/`, and anything whose last path segment contains a
  dot, is a file request. Falling back there hands the browser HTML with a
  script's content type, which reads as a bad deploy rather than a stale
  cache — and makes a mistyped icon path render as garbage instead of
  failing.
- The binary is PID 1 in the container, so it drains on SIGTERM rather than
  dropping in-flight queries mid-response.
- **The gzip and identity paths must stay behaviorally identical for asset
  files.** They are precompressed at startup and served through
  `http.ServeContent` with `Content-Encoding: gzip` — HEAD, Range and
  preconditions then behave the same on both encodings, `Vary` is set on
  both, and `/index.html` keeps its canonical redirect. A hand-rolled
  `w.Write(gz)` diverged on all four. (The SPA-shell fallback's identity
  path is still a raw `Write` — the one remaining spot where the encodings
  differ on Range/preconditions.)
- **The access log writes escaped paths.** The server is unauthenticated, so
  a decoded `%0a` in `r.URL.Path` let anyone forge log lines; query strings
  are never logged (they carry tenant label matchers). The log's
  ResponseWriter wrapper exposes `Unwrap`, or the reverse proxy's per-write
  flush silently dies behind the flag.

## Verifying a change

`yarn test:e2e` now covers some of what unit tests cannot — a view that stopped
rendering, a canvas left blank, a control that no longer writes to the URL, a
renamed wire field — because it drives the real binary against bytes a real
Pyroscope sent. Run it for anything beyond a pure function.

Two things about that suite are deliberate. **The browser runs as `ja-JP`**
(`playwright.config.ts`), so a `toLocale*` creeping back in fails there
instead of shipping Japanese month names to everyone but the CI runner. And
**an assertion has to be able to fail**: the fake replays the same fixture
whatever it is sent, so check what was actually requested through
`upstreamLog` rather than only that the screen looks right. Several tests
here once passed against a view that rendered nothing, because the string
they waited for was a permanent NavBar label.

Two more lessons in the same family. **A wire-shape change needs the wire
observed**: the upstream ignores unknown request fields, so a misplaced or
misspelled field no-ops invisibly, and client-only tests prove the code
agrees with itself — extend the fake's request log and assert the field
through `upstreamLog` (as `maxNodes` does for all three views). And **pin
the wiring, not just the units**: every suite once passed with
`retry={undefined}` in every view (Comparison panes included) — the hooks
were tested, the views never were. A view-level jsdom test driving
URL → hook → mocked fetch is cheap and catches exactly that.

It does not replace looking at the thing. It cannot tell you a chart is
mis-scaled, a colour is unreadable, or a layout broke, and its fixtures are a
snapshot rather than a live server. So for a change of any substance:

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

When a change touches what the server sends or how it is decoded, re-record
the fixtures (`e2e/README.md`) rather than editing them by hand — a
hand-written fixture only proves the code agrees with itself.

Report honestly what you ran and what you did not.

## Conventions

- Node 24 and Go 1.26, both pinned by mise (go.mod states the minimum);
  yarn 4 via corepack. **Node 25
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
- **Assert on a boolean, not on a DOM node.** `assert.equal(queryBy…(), null)`
  reads fine and passes fine, but when it fails node:assert tries to diff a
  jsdom element and walks the whole document graph — a worker that dies of
  memory exhaustion a minute later instead of a one-line failure. `assert.ok(!…)`.
- Comments say why, not what — a comment earns its place by recording a
  constraint the code cannot show. Errors are for the person stuck: say what
  happened and what to do next.
- Commit messages are English: a one-line summary, then what changed and why.
  Commit as work progresses rather than one large drop.
