# dsh-browser-native

DSH bundle plugin that attaches to a Chromium DevTools Protocol endpoint over a
**WebSocket URL with a query token** and registers fine-grained browser tools.

## Why this exists

`puppeteer.connect({ browserURL })` discovers the endpoint by building
`new URL('/json/version', browserURL)` — a relative URL resolution that drops
the query string, and it cannot use a `ws://` endpoint at all. Against an
endpoint such as

```
ws://host.docker.internal:3000/?token=test-token
```

the anonymous `/json/version` request is rejected with 401, so the attachment
never succeeds. `playwright-core`'s `chromium.connectOverCDP(endpointURL)`
accepts a WebSocket endpoint verbatim, token included, which is exactly what
this plugin uses.

Verified against the live endpoint: `Browser.getVersion` reports
`Chrome/156.0.8078.4`.

## Install

```bash
dsh plugin --profile web add dsh-browser-native     # from a registry/tarball
# or, in a checkout:
npm install && npm run build
dsh plugin --profile web add "$PWD"
```

`dsh plugin add` installs the package and appends it to
`package.json > dsh.profile.bundles`. The bundle layer is
[`cordis.patch.yml`](./cordis.patch.yml):

```yaml
- insert:
    - id: dsh-browser-native
      name: dsh-browser-native
```

Verify composition without booting:

```bash
dsh --profile web --dump-config | grep -A2 dsh-browser-native
```

## Configure

Profile patch (`~/.dsh/profiles/web/cordis.patch.yml`):

```yaml
- id: dsh-browser-native
  config:
    cdpUrl: "ws://host.docker.internal:3000/?token=test-token"
    headless: false
```

| Field | Default | Meaning |
| --- | --- | --- |
| `cdpUrl` | `http://127.0.0.1:9222` | CDP endpoint: `ws(s)://` (query kept) or `http(s)://` |
| `headless` | `false` | Reserved; the MVP is attach-only and never launches |
| `connectTimeoutMs` | `20000` | Budget for the CDP handshake |
| `actionTimeoutMs` | `15000` | Budget for one page action |
| `screenshotDir` | `""` (cwd) | Directory receiving `browser_screenshot` files |

`DSH_BROWSER_CDP_URL` overrides `cdpUrl` (a blank value is treated as unset).

## Tools

| Tool | Purpose |
| --- | --- |
| `browser_navigate` | `goto` a URL, wait for `load` / `domcontentloaded` / `networkidle` / `commit` |
| `browser_snapshot` | Readable page text plus interactive elements (role + accessible name) |
| `browser_click` | Click a CSS selector, report the resulting URL |
| `browser_type` | Fill a field, optionally press Enter |
| `browser_screenshot` | Capture a PNG to disk and report the path |
| `browser_evaluate` | Evaluate a JS expression in page context, return JSON |
| `browser_close` | **Disconnect only** — never closes or kills the remote browser |

The connection is lazy and process-wide: the first tool call attaches, later
calls reuse the same browser and page, and `browser_close` only releases the
client connection, so the next call attaches again.

## Limits (MVP)

- Attach only. `headless` and any launch mode are reserved, not implemented —
  the plugin never starts a browser and never runs `playwright install`.
- `browser_screenshot` writes a file and returns its path; it does not return
  an image content block (that needs an attachments service this plugin does
  not inject).
- One page per process (the first page of the attached context).

## Development

```bash
npm install
npm run typecheck     # tsc --noEmit (src + tests)
npm test              # vitest run
npm run build         # tsc -p tsconfig.build.json → dist/
node scripts/verify-connect.mjs 'ws://host.docker.internal:3000/?token=test-token'
```
