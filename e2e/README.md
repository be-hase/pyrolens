# End-to-end tests

What the unit tests cannot reach: the binary serving its embedded UI, the
proxy, the wire format decoding, and the canvases those end up on.

```console
yarn playwright install chromium   # once; not part of `yarn install`
yarn test:e2e                      # builds the UI and the binary, then runs
```

## How it is wired

```
chromium ──▶ ./pyrolens :4141 ──▶ e2e/fake-pyroscope.mjs :4142 ──▶ fixtures/
             (the real binary,       (replays captured
              embedded UI)            responses)
```

Playwright starts both servers (`playwright.config.ts`). Nothing is stubbed
inside the browser, so a request really does travel through the Go proxy —
which is how the suite can assert that the tenant header arrived, by reading
the fake upstream's request log back over `/__log`.

**The fixtures decide the time range, not the clock.** `fixtures/meta.json`
records the window the capture was taken with, and `helpers.ts` builds every
URL from it. Pin a range by hand instead and the points land off their own
axis, which looks like a rendering bug.

## Refreshing the fixtures

The fixtures are the bytes a real Pyroscope sent — that is the whole point,
because it means a renamed wire field fails the suite rather than passing
against something hand-written. Re-record them when the Pyroscope version
moves:

```console
docker compose -f dev/compose.yaml up -d
node e2e/capture.mjs                 # waits for profiles, then writes fixtures/
docker compose -f dev/compose.yaml down -v
```

`capture.mjs` picks two adjacent minute-aligned windows, because the load
generator adds a `slowRegression` frame every other minute — that is what
gives Comparison and Diff a real difference to show. It also captures the
refusal a multitenant server gives for an empty tenant, which is what the
UI's tenancy probe reads.

Review the diff before committing it: a fixture changing shape is a fact
about the server worth noticing, not noise. They are excluded from prettier
(`.prettierignore`) so the bytes stay as they arrived.

## The drift guard

A replayed fixture keeps passing however far the real server moves away from
it, and the Pyroscope version is bumped automatically — so nothing here would
notice on its own. `.github/workflows/fixtures.yml` captures against a live
server weekly, and on any pull request that touches the image or the fixtures,
then runs:

```console
FRESH=/tmp/fresh node e2e/check-drift.mjs
```

It compares *structure*, since values differ on every capture: which keys
exist and what type each holds. It also checks the two things a shape
comparison would miss — that the capture is not silently empty, and that the
multitenant refusal still says something the UI's probe recognises, since that
is matched with `/org|tenant/i` rather than by status alone.

When it fails, the fresh capture is uploaded as an artifact so the diff can be
read before deciding whether to re-record.

## What is deliberately not here

Screenshot comparison. Canvas output differs with the platform's font
rendering, so baselines would have to be taken in one fixed container to mean
anything. `dev/screenshot.mjs` covers the visual review by hand for now.
