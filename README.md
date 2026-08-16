# Pyrolens

Pyrolens brings the classic Pyroscope UI experience — **Tag Explorer, Single,
Comparison, and Diff views** — to Grafana Pyroscope, as a single
self-contained binary / Docker image.

> Pyrolens is an unofficial project and is not affiliated with or endorsed by
> Grafana Labs. "Pyroscope" is a trademark of Grafana Labs, used here only to
> describe compatibility.

![Single view](docs/screenshots/single-dark.png)

**Works with Pyroscope v1 (tested: v1.21.1) and v2 (tested: v2.2.1).** The UI
only speaks the `querier.v1.QuerierService` API, which both major versions
serve, in both single-tenant and multi-tenant (`-auth.multitenancy-enabled`)
setups.

Pyroscope 2.0 replaced its embedded UI with a minimal viewer and moved the
full analysis experience into Grafana (Profiles Drilldown). This project
brings the classic workflow back, plus a few things the old UI never had:

- **Everything is in the URL.** Tenant, query, time ranges, comparison
  selections, group-by label — copy the address bar and a teammate sees the
  exact same screen. (The classic UI kept the tenant out of the URL, which
  made sharing queries in multi-tenant setups painful.)
- **First-class multi-tenancy.** The tenant is a `tenant` URL param sent as
  `X-Scope-OrgID`; switch tenants from the nav bar. No per-tenant data
  sources to manage.
- **Comparison view** colors frames by package-name hash, so the same
  function has the same color in both panes. **Diff view** shows the classic
  green/red differential flame graph (color-blind palette available).
- **One-click baselines.** The Single view's flamegraph panel has "Compare
  vs previous" / "Diff vs previous" buttons that jump straight into
  Comparison/Diff with an equal-duration window immediately before the
  current range already filled in. Comparison and Diff both have a "Swap
  sides" button to flip which window is the baseline.
- **Pane windows are never a guess.** Each Comparison/Diff pane's header
  shows the time window it actually resolved to, marked "first half" /
  "second half" while it's still the implicit default; brushing or
  deep-linking a window adds a "Reset window" button back to that default.

## The views

**Diff** — what got slower between two windows, ranked. Here an extra
`slowRegression` frame shows up as `+33.57%`.

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
the UI embedded, no runtime dependencies.

Flags / env of the server binary:

| Flag                        | Env                       | Default                 |                         |
| --------------------------- | ------------------------- | ------------------------ | ----------------------- |
| `-listen`                   | `LISTEN`                  | `:4041`                 | address to listen on    |
| `-pyroscope-url`            | `PYROSCOPE_URL`           | `http://localhost:4040` | Pyroscope server to use |
| `-pyroscope-username`       | `PYROSCOPE_USERNAME`      | —                        | basic auth username for the Pyroscope server |
| `-pyroscope-password`       | `PYROSCOPE_PASSWORD`      | —                        | basic auth password for the Pyroscope server |
| `-pyroscope-password-file`  | `PYROSCOPE_PASSWORD_FILE` | —                        | path to a file holding the basic auth password (for a mounted secret); mutually exclusive with `-pyroscope-password` |
| `-pyroscope-tenant-id`      | `PYROSCOPE_TENANT_ID`     | —                        | pin the outbound tenant to this ID on every request, overriding whatever the visitor sent; mutually exclusive with `-allowed-tenants` |
| `-allowed-tenants`          | `ALLOWED_TENANTS`         | —                        | comma-separated tenant IDs to allow; a non-empty tenant outside this list is rejected with 403 before reaching Pyroscope; mutually exclusive with `-pyroscope-tenant-id` |
| `-log-requests`             | `LOG_REQUESTS`            | `false`                  | log one line per request (method, path, status, duration, bytes, and the tenant header for querier calls) |
| `-version`                  | —                         | —                        | print the version and exit |

The server embeds the built SPA and reverse-proxies
`/querier.v1.QuerierService/*` to the Pyroscope server, so the browser talks
to a single origin and your Pyroscope server never needs CORS or direct
exposure. That one prefix is the whole query API the UI uses; nothing else is
forwarded, so Pyroscope's ingest and admin endpoints are not reachable
through pyrolens.

The embedded assets are served gzip-compressed whenever the browser accepts
it — no flag needed, it's automatic.

### Authenticated upstreams (Grafana Cloud)

If the Pyroscope behind pyrolens requires basic auth — Grafana Cloud's
hosted Pyroscope does, with the stack ID as the username and an API token as
the password — give it credentials one of two ways:

- Embed them in `-pyroscope-url` (`https://user:pass@host`), or
- Set `-pyroscope-username` / `-pyroscope-password` (or
  `-pyroscope-password-file` for a mounted secret) explicitly.

**The username and password must come from the same source.** Setting any
of `-pyroscope-username`/`-pyroscope-password`/`-pyroscope-password-file`
makes those flags win over the URL's userinfo *entirely* — pyrolens does not
combine a flag-sourced credential with a URL-sourced one (a URL username
plus a file-sourced password, say). `-pyroscope-password` and
`-pyroscope-password-file` are mutually exclusive, an empty password file is
rejected by name, and a username set without a password (or vice versa, from
whichever source is in play) refuses to start — half-configured auth would
otherwise send unauthenticated requests to the upstream with nothing to say
so. A username may not contain `:`, which is ambiguous with the
username/password separator.

**Use `https://` for an authenticated upstream.** Basic auth sends the
credential in every request; over plain `http://` to anything other than
localhost, that is the token on the wire in the clear. pyrolens warns loudly
at startup if it detects this (it does not refuse to start, since testing
against a local, non-TLS Pyroscope with auth turned on is legitimate), but
the credential should not cross a real network unencrypted.

**The proxy forwards an explicit header allowlist, not whatever arrived.**
Outbound, only `Content-Type`, `X-Scope-OrgID` and `Accept-Encoding` are
copied from the visitor's request, plus `Authorization` set by pyrolens
itself when upstream credentials are configured — never the visitor's own
(one exception outside pyrolens's control: Go's own HTTP client re-adds a
fixed `Te: trailers`, with no visitor-controlled data, when the inbound
request happened to carry one — a browser's `fetch` cannot). A visitor's
cookies (a fronting proxy's own SSO session, say), browser fingerprint
headers and IP address (`X-Forwarded-For`) never reach Pyroscope. See
Security below for the same allowlisting in the other direction.

Grafana Cloud recipe, with a token file mounted at `/etc/pyrolens/token`.
Find `<cloud-profiles-url>` and `<stack-id>` on the stack's "Pyroscope"
connection details page in Grafana Cloud, and generate the token as a Cloud
Access Policy token scoped to `profiles:read` — a write-only token is
rejected by Pyroscope with 403:

```sh
PYROSCOPE_URL=https://<cloud-profiles-url> \
PYROSCOPE_USERNAME=<stack-id> \
PYROSCOPE_PASSWORD_FILE=/etc/pyrolens/token \
  ./pyrolens
```

This only authenticates pyrolens to Pyroscope. It does not authenticate
visitors to pyrolens — see Security below.

### Tenant control

By default, the tenant switcher is not an isolation boundary — see Security
below. `-pyroscope-tenant-id` and `-allowed-tenants` are an *optional*
boundary for the two shapes that default deliberately isn't, and they are
mutually exclusive (setting both refuses to start):

- **`-pyroscope-tenant-id` (pin)** — for one Pyroscope tenant per pyrolens
  instance. Every outbound request's `X-Scope-OrgID` is overwritten to this
  exact value, including the UI's own deliberately-empty multitenancy probe,
  so a visitor's `tenant` URL param can no longer choose a different tenant
  no matter what it says.
- **`-allowed-tenants` (allowlist)** — for one pyrolens instance shared across
  several tenants, confined to a known subset. A request whose tenant is
  non-empty and not in the comma-separated list is rejected with 403 before
  it reaches Pyroscope; an absent or empty tenant (the multitenancy probe)
  always passes through untouched.

Neither authenticates the visitor — they constrain which tenant a request can
reach, not who is allowed to send one. Put pyrolens behind whatever
authenticates people, same as always; these flags are for bounding blast
radius once they're in, and compose with upstream basic auth however a
deployment needs (a pinned or allowlisted single-tenant Grafana Cloud stack,
for instance).

### Security

**Pyrolens performs no authentication or authorization.** Anyone who can
reach it can query everything the Pyroscope server behind it will answer, so
put it somewhere only your team can reach and front it with whatever
authenticates your other internal tools.

**The tenant switcher is not an isolation boundary, by default.** The tenant
is a URL parameter that becomes the `X-Scope-OrgID` header, so without
further configuration a user can read any tenant by editing the address bar.
Treat it as a convenience for people who are already allowed to see every
tenant, not as a permission check — unless `-pyroscope-tenant-id` or
`-allowed-tenants` (see Tenant control above) is configured to bound it.

**Headers are proxied through an explicit allowlist, in both directions.**
The proxy does not transparently forward whatever headers arrived: a
visitor's cookies (a fronting SSO's session cookie, say), `Authorization`,
and IP address never reach the Pyroscope upstream, and an upstream (or a
load balancer in front of it) setting `Set-Cookie` never reaches the
browser. Only what pyrolens's own client actually needs crosses either
direction.

Only that one path prefix is proxied; anything else is served from the
embedded UI, and a proxied request has to carry a canonical path.

## URL parameters

All state is carried in query parameters; every view is shareable.

| Param                                              | Meaning                                                              |
| -------------------------------------------------- | -------------------------------------------------------------------- |
| `tenant`                                           | tenant ID, sent as `X-Scope-OrgID` (multi-tenant Pyroscope only)     |
| `query`                                            | label selector incl. `profile_type`, e.g. `{service_name="x", ...}`  |
| `from` / `until`                                   | main time range — `now-1h`-style relative or unix-ms absolute        |
| `refresh`                                          | auto-refresh interval: `10s` \| `30s` \| `1m` \| `5m`; anything else means off |
| `leftQuery` / `leftFrom` / `leftUntil` (+ `right…`) | Comparison & Diff pane selections; default to `query` / range halves |
| `groupBy`                                          | Tag Explorer grouping label                                          |
| `sort`                                             | Tag Explorer breakdown table sort: `avg` or `max` (default: Share/sum) |
| `fgSearch`                                         | flame graph search text; shared across Single, Comparison and Diff   |
| `fgSandwich`                                       | flame graph sandwich-view selection (function label); shared across Single, Comparison and Diff |
| `maxNodes`                                         | positive integer (1–1,000,000) capping the flamegraph node count per query; server default when absent or invalid |

Views: `/` (Single), `/comparison`, `/diff`, `/explore` (Tag Explorer).

Keyboard shortcuts: `y` or `t a` switches the time range to absolute so the
URL can be shared as-is; `t c` copies it (Grafana's own clipboard format, so
it pastes in either tool) and `t v` pastes it back. `t z` zooms out 2× around
the center of the current range; `t ArrowLeft`/`t ArrowRight` shift the
window back/forward by half its span. Like `t a`, `t z` and the arrow
shortcuts always write an absolute range, even starting from a relative one.
`t ArrowRight` clamps to the current time — it will not shift past "now", and
does nothing once the window already reaches it. `t v` needs a secure context
(HTTPS or localhost) to read the clipboard; `t c` has a legacy fallback for an
insecure one, the same one `copy absolute link` uses, which can still fail
depending on the browser. Grafana's rounded relative ranges (`now/d` and the
like) are not supported in either direction: pyrolens URLs cannot express
them, so pasting one reports "Paste failed".

The refresh picker next to the time range control repeats the current view on
the chosen interval — only while the range is relative and ending at "now",
and paused whenever the tab is in the background.

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

## License

Pyrolens is licensed **Apache-2.0** (see `LICENSE`). Bundled third-party
code retains its own license file alongside the code.
