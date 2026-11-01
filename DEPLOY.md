# Running it as a remote connector

Run the server on an always-on machine (a NAS, a mini PC, a VPS) and add it to
Claude as a **custom connector**: it then works from Claude on the web, the
desktop app and the **phone**, with no install on any of them.

```
 Claude (phone / web / desktop)
        │  HTTPS + OAuth
        ▼
 Cloudflare Tunnel ── carrefour.example.com ───────► container :8787  (MCP endpoint)
                  └── carrefour-login.example.com ─► container :6080  (sign-in screen)
                        (behind Cloudflare Access)        │
                                                          ▼
                                              Chromium ── carrefour.fr
```

What you get:

- **OAuth on the MCP endpoint.** Claude registers itself, you type a password
  once on a page served by the container, and Claude keeps a token it renews by
  itself. Only Claude's redirect URIs are accepted at registration, and only
  token hashes are stored.
- **One browser, visible from your phone.** Carrefour's login needs a captcha
  and a code sent by email, and its session lasts **24 hours at most**. The
  container runs a single, ordinary Chromium on a virtual screen, viewable from
  any browser through noVNC. You sign in inside it; the server then sends its
  requests from that same browser. Carrefour ties a session to the device that
  opened it, so this is what keeps the session valid. The profile is
  persistent: Chromium can remember your password, and Carrefour recognises the
  device from one day to the next.

> Prefer a home connection to a datacenter: carrefour.fr's bot protection is
> much friendlier to residential IPs.

## 1. Pick two hostnames

Two subdomains of a domain managed by Cloudflare, for example:

| Hostname | Points to | Protected by |
| --- | --- | --- |
| `carrefour.example.com` | container port `8787` | the server's OAuth |
| `carrefour-login.example.com` | container port `6080` | **Cloudflare Access** |

## 2. Start the container

On the host (Synology: create a folder such as `/volume1/docker/carrefour-mcp`):

1. Put [`docker-compose.yml`](docker-compose.yml) in it.
2. Copy [`.env.docker.example`](.env.docker.example) to `.env` beside it and fill it in:
   - `MCP_PUBLIC_URL=https://carrefour.example.com`
   - `MCP_AUTH_PASSWORD`: 12+ characters, you type it once when adding the connector
   - `CARREFOUR_REMOTE_LOGIN_URL=https://carrefour-login.example.com/vnc.html`
   - `VNC_PASSWORD` (optional): a second prompt on every connection to the
     sign-in screen. Cloudflare Access already protects it; leave it out unless
     the screen is reachable without Access.
3. Start it:
   - **Synology Container Manager**: *Project* › *Create*, choose the folder,
     use the existing `docker-compose.yml`, build/start.
   - **Any Docker host**: `docker compose up -d`.

The image `ghcr.io/manub3/carrefourdrivemcp:latest` is built by this
repository's CI for `amd64` and `arm64`. To build it yourself, replace `image:`
with `build: .` in the compose file.

Check it runs: `http://<host-ip>:8787/healthz` answers `{"ok":true}`.

Everything the server keeps (Carrefour session, browser profile, OAuth clients
and token hashes, logs) is in `./data`. Back it up like any secret; deleting it
signs you out everywhere.

## 3. Publish it with Cloudflare Tunnel

In the Cloudflare dashboard, *Zero Trust* › *Networks* › *Tunnels*, open your
tunnel, then *Public hostname* › *Add*:

| Subdomain | Service |
| --- | --- |
| `carrefour` | `http://<host-ip>:8787` |
| `carrefour-login` | `http://<host-ip>:6080` |

Use the host's LAN IP, which works whether `cloudflared` runs in a container or
not. If `cloudflared` uses the host network, `http://localhost:8787` works too.

**Protect the sign-in screen with Cloudflare Access** (*Zero Trust* › *Access* ›
*Applications* › *Add* › *Self-hosted*): application domain
`carrefour-login.example.com`, policy *Allow* for your own email. You will get
a one-time code by email the first time you open it on a device.

Do **not** put Cloudflare Access in front of `carrefour.example.com`: Claude's
servers call it directly and cannot pass an Access login. That endpoint is
protected by its own OAuth.

## 4. Add the connector in Claude

On claude.ai: *Settings* › *Connectors* › *Add custom connector*:

- Name: `Carrefour`
- URL: `https://carrefour.example.com/mcp`

Claude opens the server's page: type `MCP_AUTH_PASSWORD`, *Allow access*. The
connector is now available in every Claude app signed in to your account,
phone included.

## 5. Sign in to Carrefour

In a conversation: *"Connect me to Carrefour"*. Claude calls
`carrefour_browser_login`, which opens Chromium on the server's virtual screen
and replies with the sign-in link.

1. Open the link (Cloudflare Access code the first time on a device). The
   viewer connects by itself, and reconnects by itself when you come back from
   another app, e.g. your mail to read Carrefour's code.
2. In the Chromium window: email, password (let Chromium save it: next time it
   is filled in), captcha, then the code Carrefour emails you.
3. Wait for the carrefour.fr page. Leave the browser open: the server works in
   it from now on. While you sign in, the server holds its own requests back,
   so the captcha sees a plain browser.

Then *"What did I buy last month?"* works. The session renews itself while the
server keeps it alive, for up to 24 hours; after that Claude tells you to sign
in again, same link.

## Configuration reference (HTTP mode)

| Variable | Default | Role |
| --- | --- | --- |
| `MCP_TRANSPORT` | `stdio` (`http` in the image) | `http` to serve Streamable HTTP; `--http` on the command line does the same |
| `MCP_HTTP_HOST` / `MCP_HTTP_PORT` | `127.0.0.1` / `8787` (`0.0.0.0` in the image) | listen address |
| `MCP_PUBLIC_URL` | `http://localhost:<port>` | public base URL; must be https unless localhost |
| `MCP_AUTH_PASSWORD` | required | consent-page password, 12+ characters |
| `MCP_AUTH_TOKEN` | — | optional static bearer token, 32+ characters |
| `MCP_OAUTH_REDIRECT_HOSTS` | `claude.ai,claude.com,localhost,127.0.0.1` | hosts allowed in registered redirect URIs |
| `MCP_OAUTH_STATE_FILE` | `<data>/oauth/state.json` | OAuth clients and token hashes |
| `CARREFOUR_REMOTE_LOGIN` | `1` in the image | `0` to run without the virtual screen and noVNC |
| `VNC_PASSWORD` | — | optional VNC password (8 characters used) |
| `CARREFOUR_REMOTE_LOGIN_URL` | `http://localhost:6080/vnc.html` | link Claude gives you to sign in; `autoconnect`, `resize` and `reconnect` are added unless set |
| `CARREFOUR_SHARED_BROWSER` | `1` in the image | one visible browser for sign-in and requests; `0` falls back to a separate headless browser |
| `CARREFOUR_SHARED_BROWSER_PORT` | `9333` | local DevTools port of that browser (never exposed) |
| `CARREFOUR_LOGIN_WINDOW_SIZE` | `1280x900` | virtual screen and sign-in window size |

Tokens: access tokens last 24 h, refresh tokens 90 days and are single use.
Ten wrong passwords lock the consent page for 15 minutes.

## Using it from Claude Code

Claude Code supports OAuth too:
`claude mcp add --transport http carrefour https://carrefour.example.com/mcp`.
With `MCP_AUTH_TOKEN` set, a header works as well:
`--header "Authorization: Bearer <token>"`.

## Troubleshooting

- **Claude says it cannot connect**: open `https://carrefour.example.com/healthz`
  from your phone. No answer: check the tunnel's public hostname and the
  container. `{"ok":true}`: check the URL in Claude ends with `/mcp`.
- **"redirect_uri host … is not allowed"**: a client other than Claude is
  registering; add its host to `MCP_OAUTH_REDIRECT_HOSTS` if you trust it.
- **Black screen in noVNC**: the browser is not running yet. Ask Claude to
  connect you to Carrefour; the window appears within a few seconds.
- **"A Carrefour sign-in is in progress"**: the server waits for you to finish
  signing in (15 minutes at most), so that nothing touches the browser during
  the captcha. Finish it on the sign-in screen, or wait.
- **Chromium crashes**: give the container more shared memory (`shm_size: 1gb`
  is in the compose file).
- **Signed out every day**: expected. Carrefour's sign-in session lasts 24 h
  and cannot be extended without the captcha and the emailed code.
