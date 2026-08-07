# Development environment

A Pyroscope with realistic data in it, so the UI can be exercised for real.
Type-checking and unit tests do not catch a wrong wire field, a broken canvas
transform, or a control that stopped applying — this does.

## Start it

```console
docker compose -f dev/compose.yaml up -d
make run                                  # UI on :4041, proxying :4040
```

Open <http://localhost:4041>. It asks for a tenant: **`team-a`**
(checkout-service) or **`team-b`** (billing-service).

Profiles take about a minute to become queryable — the first flame graph
comes back empty until then, which is the server, not the UI.

To also exercise the single-tenant path, where no tenant UI appears at all:

```console
docker compose -f dev/compose.yaml --profile single up -d
PYROSCOPE_URL=http://localhost:4045 make run
```

Stop everything with `docker compose -f dev/compose.yaml --profile single
down -v`.

## What the data looks like

`loadgen/` is a small Go program that burns CPU in named functions and
reports itself to Pyroscope. It is shaped to make each view show something:

- Frames are nested `handleRequest → parseRequest / queryDatabase /
  renderResponse`, so the flame graph has depth rather than one flat bar.
- Work is tagged with a **`region`** label (us-east / eu-west / ap-south, at
  a 3:2:1 weight), which is what the Tag Explorer breaks down.
- **Every other minute an extra `slowRegression` frame appears.** That gives
  the Comparison and Diff views a genuine difference between two adjacent
  time windows — pick a window inside one minute and a window inside the
  next.

Run it directly if you prefer not to use compose:

```console
cd dev/loadgen
SERVER=http://localhost:4040 TENANT=team-a APP=checkout-service go run .
```

`TENANT` unset means no `X-Scope-OrgID` header, for a single-tenant server.
It is a separate Go module on purpose, so its dependencies stay out of the
binary's.

## Screenshots

For a visual change, review the pictures rather than the claim:

Playwright is not a dependency of this project — it would be a heavy install
for everyone who only wants to build the UI. Put it in a scratch directory
instead (once):

```console
npm i --prefix /tmp/pw playwright@1.56.1
/tmp/pw/node_modules/.bin/playwright install chromium
```

Do **not** run `npm install` inside the repository: npm rewrites `yarn.lock`
in its own format.

```console
BASE=http://localhost:4041 TENANT=team-a \
  PLAYWRIGHT=/tmp/pw/node_modules/playwright/index.mjs \
  node dev/screenshot.mjs
```

Writes all four views in both themes to `dev/screenshots/` (git-ignored) and
exits non-zero if any view failed to render or logged a page error. `FROM` /
`UNTIL` pin the main time range — useful while the load generator is still
warming up and a default `now-1h` would be mostly empty axis.

The README's screenshots were produced this way, after letting the load
generator run for about ten minutes:

```console
BASE=http://localhost:4041 TENANT=team-a FROM=now-15m OUT=docs/screenshots \
  PLAYWRIGHT=/tmp/pw/node_modules/playwright/index.mjs \
  node dev/screenshot.mjs
rm docs/screenshots/*-light.png     # the README only embeds the dark ones
```

## Running Pyroscope outside Docker

If you run the server as a binary instead, note that **a second instance on
the same host needs more ports remapped than the obvious ones**. Beyond
`-server.http-listen-port`, `-server.grpc-listen-port` and
`-memberlist.bind-port`, both `-metastore.address` and
`-query-backend.address` default to `localhost:9095` — leave them and the
second instance silently talks to the first, which looks like successful
writes whose queries return nothing:

```console
./pyroscope -server.http-listen-port=4045 -server.grpc-listen-port=9199 \
  -memberlist.bind-port=7948 \
  -metastore.raft.bind-address=localhost:9299 \
  -metastore.raft.advertise-address=localhost:9299 \
  -metastore.raft.server-id=localhost:9299 \
  -metastore.address=localhost:9199 \
  -query-backend.address=localhost:9199
```

Containers each get their own network namespace, so `compose.yaml` does not
have to care.
