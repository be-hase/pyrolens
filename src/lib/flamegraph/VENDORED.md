# Vendored: `@grafana/flamegraph`

## Source

Copied from **[grafana/grafana](https://github.com/grafana/grafana), tag
`v13.0.1`, `packages/grafana-flamegraph/src/`**, which is licensed
**Apache-2.0** — see `LICENSE` in this directory (a copy of that package's
`LICENSE_APACHE2`). Two files carry their own upstream attributions, kept
intact: `FlameGraph/murmur3.ts` (MIT, Gary Court) and the Mapbox ISC notice at
the top of `FlameGraph/FlameGraph.tsx`.

Everything under this directory is either that Apache-2.0 code or our own
adaptation of it, so it is redistributable under this project's Apache-2.0
licence.

## Why vendored rather than installed from npm

The published `@grafana/flamegraph` package depends on `@grafana/data` and
`@grafana/ui`, which pull in a large transitive tree (emotion, lodash,
react-virtualized, d3-scale, …) and peer-depend on `@grafana/assistant`, which
is not publicly available. This project ships four runtime dependencies in
total, so the component is vendored and stripped down to what a standalone
single-page UI needs.

## Removed from upstream

- `@grafana/assistant` integration — the `OpenAssistantButton`,
  `assistantContext` prop and `showAnalyzeWithAssistant` flag.
- `CallTree/` and the `PaneView.CallTree` option.
- `FlameGraphPane` / `NewUIContainer` / the `enableNewUI` opt-in and the entire
  new-UI rendering branch, plus the split-pane machinery it gated
  (`ViewMode.Split`, pane swapping, per-pane view selection). The surviving
  top-level view selector is `SelectedView` (Top Table / Flame Graph / Both).
- Storybook stories, unit tests and test fixtures.

## Replaced (our own code, written for this project)

Upstream renders inside Grafana and leans on Grafana's design system. These
replacements are ours, not copies of anyone's adaptation:

- `data.ts` — the `DataFrame` / `Field` / `FieldType` shapes the component
  needs, in place of `@grafana/data`.
- `format.ts` — value formatting (`ns` durations, `bytes`, SI `short`) and the
  display-processor plumbing, in place of `@grafana/data`'s formatters.
- `theme.ts` — a minimal theme read from this app's CSS custom properties, in
  place of `GrafanaTheme2` / `useTheme2`.
- `cx.ts` — a class-name joiner, in place of `@emotion/css`'s `cx`.
- `ui/` — the handful of primitives the component used from `@grafana/ui`
  (button, icon button, input, radio group, menu, dropdown, context menu,
  portal, tooltip container), built on this app's design tokens. Icons come
  from this project's own icon set via `@components/core/Icon`.
- **All styling.** Upstream styles with `@emotion/css` + `useStyles2`; every
  such block was rewritten as a plain `.css` file next to its component, using
  this project's design tokens so both themes work. Class names are prefixed
  `plfg-`.
- `TopTable/` — upstream renders `@grafana/ui`'s `Table` (with
  `applyFieldOverrides`, custom cell options and `react-virtualized-auto-sizer`);
  this is a plain semantic `<table>` with our own sorting, row windowing and
  cell rendering, keeping upstream's data-preparation logic.
- `utils.ts` — upstream's file only holds an `@grafana/assistant` helper; ours
  reimplements `@grafana/data`'s `escapeStringForRegex` /
  `unEscapeStringFromRegex`.
- Three further third-party dependencies upstream pulls in are replaced by
  local helpers: `d3-scale`'s `scaleLinear` (a linear RGB interpolator in
  `FlameGraph/colors.ts`), `lodash`'s `groupBy` (in
  `FlameGraph/treeTransforms.ts`) and `react-use`'s `useMeasure` / `usePrevious`
  (in `hooks.ts`).

## Kept as-is

The flame graph's substance is upstream's and is deliberately left faithful:
nested-set decoding and the `FlameGraphDataContainer` (`FlameGraph/dataTransform.ts`),
canvas geometry and drawing (`FlameGraph/rendering.ts`), colour assignment
including diff mode (`FlameGraph/colors.ts`), tree operations
(`FlameGraph/treeTransforms.ts`) and `murmur3.ts`.

Changes to those files are limited to import rewrites onto the replacements
listed above, plus three substitutions forced by the dropped dependencies:
`colors.ts` interpolates the diff colour ramp with a local helper instead of
`d3-scale`; `treeTransforms.ts` groups with a local helper instead of `lodash`;
and `dataTransform.ts` gains a `getFieldByName` lookup and drops upstream's
enum-backed label support, which needs `@grafana/data` field metadata this
project never produces.

Diff mode (`valueRight` / `selfRight`, colour-by-diff, the diff tooltip and the
Baseline/Comparison/Diff table columns) is upstream v13.0.1 functionality and is
used by this project's Diff view.

## Local fixes, deliberate deviations from upstream v13.0.1

- **Zero-baseline diff guards.** Upstream's diff percentage/diff-percent math
  (`FlameGraph/FlameGraphTooltip.tsx`'s `getDiffTooltipData`,
  `TopTable/FlameGraphTopTableContainer.tsx`'s `buildTableRows`) divides by
  `totalTicksLeft`/`totalTicksRight`/`percentageLeft` unconditionally, which is
  `NaN`/`Infinity` whenever one side of a diff interval (baseline or
  comparison) has zero total samples — the tooltip and table then rendered
  literal "NaN%"/"Infinity%". Both places now treat a percentage over a zero
  total as `0`, and a diff against a zero baseline as either `0` (comparison
  also zero) or undefined (comparison nonzero — rendered `'n/a'` in the
  tooltip; the table's existing `Infinity`/`-100` handling already renders
  that case as an honest "new"/"removed" rather than the literal word). See
  the guard comments at each site. `FlameGraph/colors.ts`'s
  `getBarColorByDiff` already guarded this case pre-vendoring; it was the
  reference for this fix.
- **Clipboard fallback.** `FlameGraph/FlameGraphContextMenu.tsx`'s "Copy
  function name" called `navigator.clipboard.writeText` directly. That API is
  `undefined` outside a secure context (plain HTTP, which this project is
  commonly deployed over as an internal tool), so the click threw and left
  the menu stuck open. A local `copyText` helper now feature-detects and
  falls back to a hidden-textarea + `document.execCommand('copy')`, and the
  menu always closes after the attempt regardless of outcome.
- **Controlled search/sandwich.** `FlameGraphContainer.tsx` takes optional
  `search`/`onSearchChange` and `sandwichItem`/`onSandwichChange` props; when
  passed, they replace the internal `useState` (the usual controlled/
  uncontrolled pattern), so the app can lift both into the URL — `fgSearch`
  and `fgSandwich` are shared across every flame graph on screen (Single,
  Comparison and Diff alike), which is what makes a copied link (or another
  pane) point at the same highlighted function. The data-change effect that
  resets focus and sandwich on every profile refresh now skips the sandwich
  reset when it is controlled — otherwise a URL-supplied sandwich selection
  was cleared the moment the profile finished its first load, since that
  effect already runs once on mount. Separately, `FlameGraphContainer.tsx`
  resets focus/zoom (`rangeMin`/`rangeMax`/`focusedItemData`) whenever the
  *resolved* sandwich value changes, comparing during render rather than in
  the local `onSandwich` handler alone — a sandwich arriving through the
  controlled prop (set by another pane) used to leave the old focus/zoom in
  place, rendering a clipped/zoomed canvas against the new sandwich.
- **Empty sandwich notice.** `FlameGraph/FlameGraph.tsx`: when `sandwichItem`
  is set but `getSandwichLevels` finds no matching frame — a stale or
  garbage `fgSandwich` deep link, or a symbol that only exists in the other
  Comparison pane's profile — upstream falls through to an empty canvas
  while the metadata pill above still reads "0 | 0 samples", which looks
  like broken data rather than an absent symbol. This renders a short inline
  notice in the canvas's place instead. The URL param is deliberately left
  alone (not auto-cleared): `fgSearch`/`fgSandwich` are shared across every
  flame graph on screen, so the symbol may legitimately exist in the other
  pane's data even when it doesn't in this one.

## Re-syncing with upstream

```sh
git clone --filter=blob:none --sparse --depth 1 --branch v13.0.1 \
  https://github.com/grafana/grafana.git /tmp/grafana
cd /tmp/grafana && git sparse-checkout set packages/grafana-flamegraph
diff -ru /tmp/grafana/packages/grafana-flamegraph/src <this directory>
```

Expect differences everywhere styling, UI primitives or data types are involved;
the files listed under "Kept as-is" should stay close to upstream.
