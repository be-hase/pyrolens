# Pyrolens

Pyrolens brings the classic Pyroscope UI experience — **Tag Explorer, Single,
Comparison, and Diff views** — to Grafana Pyroscope, as a single
self-contained binary / Docker image.

> Pyrolens is an unofficial project and is not affiliated with or endorsed by
> Grafana Labs. "Pyroscope" is a trademark of Grafana Labs, used here only to
> describe compatibility.

![Single view](docs/screenshots/single-dark.png)

**Works with Pyroscope v1 (tested: v1.21.1) and v2 (tested: v2.2.1)**, in
both single-tenant and multi-tenant (`-auth.multitenancy-enabled`) setups.

Pyroscope 2.0 replaced its embedded UI with a minimal viewer and moved the
full analysis experience into Grafana (Profiles Drilldown). This project
brings the classic workflow back, plus a few things the old UI never had:

- **Everything is in the URL.** Tenant, query, time ranges, comparison
  selections, group-by label — copy the address bar and a teammate sees the
  exact same screen.
- **First-class multi-tenancy.** Switch tenants from the nav bar; the tenant
  rides along in shared links. No per-tenant data sources to manage.
- **Comparison view** colors frames by package-name hash, so the same
  function has the same color in both panes. **Diff view** shows the classic
  green/red differential flame graph (color-blind palette available).
- **One-click baselines.** "Compare vs previous" / "Diff vs previous" jump
  from Single straight into Comparison/Diff with an equal-duration window
  immediately before the current range already filled in; "Swap sides" flips
  which window is the baseline.
- **Pane windows are never a guess.** Each Comparison/Diff pane header shows
  the window it actually resolved to, and offers "Reset window" once you've
  brushed away from the default.

## The views

**Diff** — what got slower between two windows, ranked. Here the injected
`slowRegression` frame jumps out at `+1023%`, red in the flame graph. Because
the diff is one query over both windows, Diff has a single Run above the
panes that commits both edits at once, instead of a Run per pane.

![Diff view](docs/screenshots/diff-dark.png)

**Tag Explorer** — break a service down by any label, then jump straight
into a Comparison or Diff for one value of it.

![Tag Explorer](docs/screenshots/explore-dark.png)

**Comparison** — two independent queries and time windows side by side,
with matching colors so the same function is the same color in both.

![Comparison view](docs/screenshots/comparison-dark.png)

## Quick start

```sh
# Docker
docker run -p 4041:4041 -e PYROSCOPE_URL=http://pyroscope:4040 \
  ghcr.io/be-hase/pyrolens

# or grab a binary (linux/darwin, amd64/arm64) from the releases page:
# https://github.com/be-hase/pyrolens/releases
PYROSCOPE_URL=http://pyroscope.example:4040 ./pyrolens

# or build from source (needs Node >= 24 and Go >= 1.25)
make run                                      # serves on :4041, proxies to localhost:4040
PYROSCOPE_URL=http://pyroscope.example:4040 make run
```

The binary and the image are the same thing: one self-contained server with
the UI embedded. It reverse-proxies only the exact querier RPCs the UI
calls (all under `/querier.v1.QuerierService/`) to your Pyroscope server,
so the browser talks to a single origin — Pyroscope needs no CORS and no
direct exposure, and its ingest and admin endpoints are not reachable
through pyrolens.

## Configuration

| Flag                       | Env                       | Default                 |                                                                                                                      |
| -------------------------- | ------------------------- | ----------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `-listen`                  | `LISTEN`                  | `:4041`                 | address to listen on                                                                                                  |
| `-pyroscope-url`           | `PYROSCOPE_URL`           | `http://localhost:4040` | Pyroscope server to use                                                                                               |
| `-pyroscope-username`      | `PYROSCOPE_USERNAME`      | —                       | basic auth username for the Pyroscope server                                                                          |
| `-pyroscope-password`      | `PYROSCOPE_PASSWORD`      | —                       | basic auth password for the Pyroscope server                                                                          |
| `-pyroscope-password-file` | `PYROSCOPE_PASSWORD_FILE` | —                       | path to a file holding the basic auth password (for a mounted secret); mutually exclusive with `-pyroscope-password`  |
| `-pyroscope-tenant-id`     | `PYROSCOPE_TENANT_ID`     | —                       | pin every outbound request to this tenant, overriding whatever the visitor sent; mutually exclusive with `-allowed-tenants` |
| `-allowed-tenants`         | `ALLOWED_TENANTS`         | —                       | comma-separated tenant IDs to allow; any other non-empty tenant is rejected with 403; mutually exclusive with `-pyroscope-tenant-id` |
| `-log-requests`            | `LOG_REQUESTS`            | `false`                 | log one line per request (method, path, status, duration, bytes, and the tenant for querier calls)                    |
| `-version`                 | —                         | —                       | print the version and exit                                                                                            |

### Authenticated upstreams (Grafana Cloud)

If the Pyroscope behind pyrolens requires basic auth — Grafana Cloud's
hosted Pyroscope does, with the stack ID as the username and an API token as
the password — give it credentials either embedded in the URL
(`https://user:pass@host`) or via the `-pyroscope-username` /
`-pyroscope-password` / `-pyroscope-password-file` flags. Flags win over the
URL's userinfo entirely, username and password must come from the same
source, and half-configured auth refuses to start rather than silently
sending unauthenticated requests.

Use `https://` — basic auth sends the credential with every request, and
pyrolens warns loudly at startup if it would cross a real network in the
clear.

Grafana Cloud recipe, with a token file mounted at `/etc/pyrolens/token`.
Find `<cloud-profiles-url>` and `<stack-id>` on the stack's "Pyroscope"
connection details page, and generate the token as a Cloud Access Policy
token scoped to `profiles:read` (a write-only token is rejected by Pyroscope
with 403):

```sh
PYROSCOPE_URL=https://<cloud-profiles-url> \
PYROSCOPE_USERNAME=<stack-id> \
PYROSCOPE_PASSWORD_FILE=/etc/pyrolens/token \
  ./pyrolens
```

This authenticates pyrolens to Pyroscope — not visitors to pyrolens; see
Security below.

### Tenant control

Two optional, mutually exclusive ways to bound which tenants an instance can
reach:

- **`-pyroscope-tenant-id` (pin)** — one Pyroscope tenant per pyrolens
  instance. Every outbound request is forced to this tenant; a visitor's
  `tenant` URL param cannot choose a different one.
- **`-allowed-tenants` (allowlist)** — one shared instance confined to a
  known subset. Requests for any other non-empty tenant are rejected with
  403 before reaching Pyroscope; a request with no tenant (the UI's own
  multitenancy probe) always passes through untouched.

Neither authenticates the visitor — they bound blast radius, not identity.

### Security

- **Pyrolens performs no authentication or authorization.** Anyone who can
  reach it can query everything the Pyroscope behind it will answer. Put it
  somewhere only your team can reach, fronted by whatever authenticates your
  other internal tools.
- **The tenant switcher is not an isolation boundary by default.** The
  tenant is a URL parameter; without `-pyroscope-tenant-id` or
  `-allowed-tenants`, anyone can read any tenant by editing the address bar.
  Treat it as a convenience for people already allowed to see every tenant.
- **Headers cross the proxy through an explicit allowlist, both
  directions.** A visitor's cookies, `Authorization` and IP address never
  reach Pyroscope; an upstream's `Set-Cookie` never reaches the browser.

## Sharing and URL parameters

All state is carried in query parameters; every view is shareable.

| Param                                               | Meaning                                                                                         |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `tenant`                                            | tenant ID, sent as `X-Scope-OrgID` (multi-tenant Pyroscope only)                                |
| `query`                                             | label selector incl. `profile_type`, e.g. `{service_name="x", ...}`                             |
| `from` / `until`                                    | main time range — `now-1h`-style relative or unix-ms absolute                                   |
| `refresh`                                           | auto-refresh interval: `10s` \| `30s` \| `1m` \| `5m`; anything else means off                  |
| `leftQuery` / `leftFrom` / `leftUntil` (+ `right…`) | Comparison & Diff pane selections; default to `query` / range halves                            |
| `groupBy`                                           | Tag Explorer grouping label                                                                     |
| `sort`                                              | Tag Explorer breakdown table sort: `avg` or `max` (default: Share/sum)                          |
| `fgSearch`                                          | flame graph search text; shared across Single, Comparison and Diff                              |
| `fgSandwich`                                        | flame graph sandwich-view selection (function label); shared across Single, Comparison and Diff |
| `maxNodes`                                          | caps flame graph detail per query (1–1,000,000, lower is faster); Default uses the server's own limit — set from the Max nodes slider on the flame-graph views (Single, Comparison, Diff) |

Views: `/` (Single), `/comparison`, `/diff`, `/explore` (Tag Explorer).

Switching tenant from the nav bar starts fresh at `/?tenant=<new>`; the
browser's Back button restores the previous tenant's screen intact.

Once any of the above has drifted from its default, a Reset view button
appears in the controls bar to clear it all back — keeping only the tenant,
the current view and the service/profile type — with Back available to
restore the state it cleared.

The refresh picker next to the time range control repeats the current view
on the chosen interval — only while the range ends at "now", and paused
whenever the tab is in the background.

### Keyboard shortcuts

| Keys                            | Action                                                                                        |
| ------------------------------- | --------------------------------------------------------------------------------------------- |
| `y` or `t a`                    | switch the time range to absolute, so the URL can be shared as-is                             |
| `t c`                           | copy the time range (Grafana's clipboard format — pastes into either tool)                    |
| `t v`                           | paste a time range from the clipboard                                                          |
| `t z`                           | zoom out 2× around the center of the current range                                            |
| `t ArrowLeft` / `t ArrowRight`  | shift the window back / forward by half its span (`ArrowRight` never shifts past "now")       |

`t a`, `t z` and the arrow shortcuts always write an absolute range, even
starting from a relative one. `t v` needs a secure context (HTTPS or
localhost) to read the clipboard; `t c` has a legacy fallback for insecure
contexts, so on a plain-HTTP deployment copy may work while paste will
not. Grafana's rounded relative ranges
(`now/d` and the like) are not supported in either direction: pyrolens URLs
cannot express them, so pasting one reports "Paste failed".

## Development

```sh
corepack enable                # yarn 4
yarn install
yarn dev                       # vite dev server on :5173, proxies to localhost:4040
PYROSCOPE_URL=http://host:4040 yarn dev

yarn test                      # unit tests (vitest)
yarn lint && yarn type-check
```

A local Pyroscope to develop against:

```sh
# single tenant
docker run -p 4040:4040 grafana/pyroscope
# multi-tenant (the UI will prompt for a tenant ID)
docker run -p 4040:4040 grafana/pyroscope -auth.multitenancy-enabled
```

`dev/` has a docker-compose setup that also feeds it realistic profiles —
see `dev/README.md`.

## Supply chain

Container base images are digest-pinned. Every release ships a
Syft-generated SBOM per archive and
[build provenance attestations](https://github.com/actions/attest-build-provenance)
for the archives and the `ghcr.io/be-hase/pyrolens` image, produced in CI
from the tag build. Verify with the `gh` CLI:

```sh
gh attestation verify oci://ghcr.io/be-hase/pyrolens:<tag> --owner be-hase
gh attestation verify pyrolens_<version>_linux_amd64.tar.gz --owner be-hase
```

## License

Pyrolens is licensed **Apache-2.0** (see `LICENSE`). Bundled third-party
code retains its own license file alongside the code, and
`THIRD-PARTY-NOTICES.md` collects every bundled component's copyright and
permission notice — it ships in the release archives and at `/licenses` in
the container image.
