# Plan: On-Camera MCP Server for Axis Q1656 (ARTPEC-8, aarch64, AXIS OS 12)

## Goal

Build a standalone ACAP (`.eap`) that runs an **MCP server directly on the camera**, exposing VAPIX-backed tools over **Streamable HTTP** so Claude Desktop / Claude Code can connect to `http://<camera-ip>/local/axis_mcp/mcp`.

## Architecture decision (important — do NOT use Docker)

Gemini's Docker-ACAP approach is **rejected**: Axis discontinued the Docker/Docker Compose ACAP and it is not supported on AXIS OS 12. The correct FW12 path is a **native ACAP that bundles its own Node.js runtime**, built with the ACAP Native SDK via Docker (Docker is used only for *building* on the Mac, not on the camera).

**MANDATORY: use the `axis-fw12-acap` skill.** Read its `SKILL.md`, then `references/gotchas.md` FIRST, then `references/manifest.md` and `references/web-ui-and-vapix.md`. Scaffold from its `assets/` (Dockerfile, build.sh, manifest.json, launcher.sh, Makefile, LICENSE). Also consult the `camscripter` skill for VAPIX call patterns if needed.

## Stack

- TypeScript, Node.js 20 (bundled ARM64 tarball; glibc on OS 12 is fine)
- `@modelcontextprotocol/sdk` — `McpServer` + `StreamableHTTPServerTransport` (stateless mode is fine for v1)
- Express or plain Node http for routing
- Target: `aarch64` only (ARTPEC-8). One `.eap`.
- App name: `axis_mcp` (underscores only — no hyphens, see manifest rules)

## Project layout

```
axis-mcp-acap/
├── Dockerfile              # from skill assets; ARCH=aarch64
├── build.sh                # from skill assets
├── plan.md
└── app/
    ├── manifest.json       # schemaVersion 1.7.4
    ├── axis_mcp            # launcher shell script == appName
    ├── Makefile            # no-op (from assets)
    ├── LICENSE             # non-empty
    ├── package.json        # main: dist/bootstrap.js
    ├── tsconfig.json
    ├── src/
    │   ├── bootstrap.ts    # http server on process.env.HTTP_PORT ?? 32554
    │   ├── mcpServer.ts    # McpServer + tool registrations
    │   ├── vapix.ts        # Digest-auth VAPIX client (MD5 AND SHA-256!)
    │   ├── tools/
    │   │   ├── device.ts   # device info & health
    │   │   ├── imaging.ts  # snapshot, image settings, zoom/focus
    │   │   ├── events.ts   # event declarations / analytics state
    │   │   └── apps.ts     # ACAP list/start/stop, params
    │   └── settings.ts     # persisted config (camera creds) in app's rw dir
    ├── html/
    │   └── index.html      # settings UI: camera credentials, status, MCP URL display
    └── bin/                # node-arm64 fetched by Dockerfile
```

## Manifest (critical rules from the skill)

```json
{
  "schemaVersion": "1.7.4",
  "acapPackageConf": {
    "setup": {
      "appName": "axis_mcp",
      "friendlyName": "Axis MCP Server",
      "vendor": "Pavel Kotyza",
      "version": "1.0.0",
      "architecture": "aarch64",
      "runMode": "respawn"
    },
    "configuration": {
      "settingPage": "index.html",
      "reverseProxy": [
        { "apiPath": "mcp",          "target": "http://localhost:32554/mcp",          "access": "admin" },
        { "apiPath": "status.cgi",   "target": "http://localhost:32554/status.cgi",   "access": "admin" },
        { "apiPath": "settings.cgi", "target": "http://localhost:32554/settings.cgi", "access": "admin" }
      ]
    }
  }
}
```

Rules that WILL bite: `schemaVersion` must be `1.7.4`; `settingPage` is a bare filename; **no hyphens in `reverseProxy` targets** (name everything with underscores); launcher filename must equal `appName`.

Note: the reverse proxy requires camera admin auth (digest) on `/local/axis_mcp/mcp`. MCP clients that can't do digest auth may need to connect directly to the app port instead — as a fallback, also listen on a fixed secondary port (e.g. 8000) and document `http://<ip>:8000/mcp` (unauthenticated, LAN-only; add a bearer-token check from settings).

## MCP transport

Streamable HTTP, stateless: on each `POST /mcp`, create a `StreamableHTTPServerTransport` with `sessionIdGenerator: undefined`, connect the `McpServer`, handle request. Respond 405 to GET/DELETE on `/mcp` (no server-push needed in v1). This avoids session state across the camera's respawn lifecycle.

## VAPIX client (`vapix.ts`)

Calls go to `http://127.0.0.1` from inside the camera. Must implement **Digest auth honoring the `algorithm` directive — SHA-256 as well as MD5** (silent 401 otherwise; see skill's web-ui-and-vapix.md). Reuse nonce. Credentials come from settings.cgi-saved config (stored under the app's writable localdata dir).

## Tools (v1)

Device info & health:
- `get_device_info` — POST /axis-cgi/basicdeviceinfo.cgi (`getAllProperties`)
- `get_system_status` — uptime, temperature (/axis-cgi/temperaturecontrol.cgi if present), network params via param.cgi
- `get_time` — /axis-cgi/time.cgi

Imaging & optics (Q1656 is fixed box, no PTZ pan/tilt — zoom/focus via optics):
- `take_snapshot` — /axis-cgi/jpg/image.cgi?resolution=... → return as MCP image content (base64)
- `get_image_settings` / `set_image_settings` — param.cgi ImageSource params
- `set_zoom_focus` — /axis-cgi/opticscontrol.cgi (JSON API); gracefully report if unsupported

Events & analytics:
- `list_event_declarations` — SOAP /vapix/services GetEventInstances (or eventsystem REST if available); return simplified tree
- `get_analytics_status` — list AOA/VMD app state via applications API

App management:
- `list_apps` — /axis-cgi/applications/list.cgi (XML → JSON)
- `control_app` — /axis-cgi/applications/control.cgi?action=start|stop&package=...
- `get_params` / `set_param` — /axis-cgi/param.cgi (guard set_param: allowlist groups, require explicit param name)

All tools: return structured JSON text content; on VAPIX error return isError with body excerpt.

## Settings UI (`html/index.html`)

Light theme default + theme switcher (user preference). Shows: connection status, configured VAPIX credentials form (POST settings.cgi), the MCP endpoint URLs, and a tool self-test button (calls status.cgi which runs get_device_info internally). API base computed as `/local/axis_mcp` per skill reference.

## Build & deploy

1. `./build.sh arm64` → produces `Axis_MCP_Server_1_0_0_aarch64.eap` via `axisecp/acap-native-sdk:<latest 12.x>-aarch64-ubuntu24.04`, fetches Node 20 linux-arm64 tarball into `bin/`, runs `tsc`, `acap-build`.
2. Camera UI → System → Apps → enable *Allow unsigned apps* → upload `.eap` → start.
3. Check app log: launcher execs node, HTTP server binds `HTTP_PORT`, MCP ready.
4. Open settings page from Apps list, enter VAPIX admin credentials, run self-test.

## Client config (Claude Desktop / Claude Code)

```
claude mcp add --transport http axis-q1656 http://<camera-ip>:8000/mcp
```
(or the `/local/axis_mcp/mcp` proxied path if the client supports digest auth).

## Verification checklist

- [ ] `.eap` installs and starts on Q1656 FW 12.x without manifest errors
- [ ] `curl -X POST http://<ip>:8000/mcp` with an `initialize` JSON-RPC body returns server info
- [ ] MCP Inspector (`npx @modelcontextprotocol/inspector`) lists all tools and each returns live data
- [ ] `take_snapshot` returns a viewable JPEG
- [ ] `set_param` refuses non-allowlisted groups
- [ ] App survives respawn (save settings → app restarts → MCP still answers)
- [ ] Clean SIGINT exit (skill lifecycle requirement)

## Milestones

1. Scaffold from skill assets; build + install an empty "hello" ACAP that answers on /mcp with one dummy tool. **Prove the pipeline first.**
2. VAPIX digest client + device info/health tools.
3. Imaging + snapshot (image content).
4. Events + app management tools.
5. Settings UI + credential persistence + bearer-token option.
6. Full verification checklist on real camera.
