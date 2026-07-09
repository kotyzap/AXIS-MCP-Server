# Axis MCP Server (on-camera ACAP)

A standalone ACAP (`.eap`) that runs a **Model Context Protocol server directly on an Axis camera**
(ARTPEC-8, AXIS OS 12 — e.g. Q1656). It exposes VAPIX-backed tools over **Streamable HTTP** so Claude
Desktop / Claude Code can connect to the camera and inspect/control it.

Built with the ACAP **Native SDK** (Node.js 20 bundled into the package). No Docker runs on the camera —
Docker is only used to *build* the `.eap` on your Mac.

## Layout

```
axis-mcp-acap/
├── Dockerfile              # ACAP Native SDK build (aarch64)
├── build.sh                # docker build + docker cp -> .eap
├── plan.md                 # design plan
└── app/
    ├── manifest.json        # schemaVersion 1.7.4; appName axis_mcp
    ├── axis_mcp             # launcher (filename == appName)
    ├── Makefile             # no-op (acap-build runs make)
    ├── LICENSE
    ├── package.json         # main: dist/bootstrap.js
    ├── tsconfig.json
    ├── src/
    │   ├── bootstrap.ts     # HTTP servers: /mcp, /status.cgi, /settings.cgi
    │   ├── mcpServer.ts      # McpServer + tool registration
    │   ├── vapix.ts          # Digest auth client (MD5 + SHA-256)
    │   ├── settings.ts       # persisted config (PERSISTENT_DATA_PATH)
    │   └── tools/            # device, imaging, events, apps
    └── html/index.html      # settings UI (light default + theme switcher)
```

## Tools (v1)

| Tool | VAPIX |
|---|---|
| `get_device_info` | basicdeviceinfo.cgi (getAllProperties) |
| `get_system_status` | param.cgi (Network/Brand/Firmware) + temperaturecontrol.cgi |
| `get_time` | time.cgi |
| `take_snapshot` | jpg/image.cgi → MCP image content |
| `get_image_settings` / `set_image_settings` | param.cgi ImageSource/Image |
| `get_optics` | opticscontrol.cgi getOptics (ids + capabilities) |
| `autofocus` | cascade: opticscontrol.cgi performAutofocus → startFocusSearch → opticssetup.cgi → ptz.cgi?autofocus=on (caches the working method) |
| `set_zoom_focus` | opticscontrol.cgi setMagnification / autofocus cascade |
| `list_event_declarations` | SOAP GetEventInstances |
| `get_analytics_status` | applications/list.cgi (filtered) |
| `list_apps` / `control_app` | applications/list.cgi, control.cgi |
| `get_params` / `set_param` | param.cgi (writes allowlisted) |

### CamStreamer suite (require the respective ACAP installed)

| Tool | Endpoint |
|---|---|
| `camstreamer_list_streams` | /local/camstreamer/stream/list.cgi |
| `camstreamer_stream_status` | /local/camstreamer/stream/status.cgi |
| `camstreamer_control_stream` | /local/camstreamer/stream/set.cgi (start/stop) |
| `camswitcher_list_playlists` | /local/camswitcher/playlists.cgi?action=get |
| `camswitcher_switch_playlist` | /local/camswitcher/playlist_switch.cgi |
| `camswitcher_queue_playlist` | /local/camswitcher/playlist_queue_push.cgi |
| `camswitcher_get_queue` / `camswitcher_play_next` / `camswitcher_clear_queue` | playlist_queue_*.cgi |
| `camswitcher_output_info` / `camswitcher_list_clips` | output_info.cgi, clips.cgi |
| `camoverlay_list_services` | /local/camoverlay/api/services.cgi |
| `camoverlay_set_service_enabled` | services.cgi?action=set |
| `camoverlay_update_graphic_text` | customGraphics.cgi?action=update_text |
| `camoverlay_infoticker` | infoticker.cgi |

These call the CamStreamer/CamSwitcher/CamOverlay CGIs on the same camera using the same digest auth.
If the corresponding ACAP isn't installed, the tool returns a clear "not installed" error.

## Build

Requires Docker Desktop on your Mac.

```sh
cd axis-mcp-acap
sh build.sh arm64        # -> Axis_MCP_Server_1_0_0_aarch64.eap (or axis_mcp_*.eap)
```

## Install

Camera UI → **System → Apps** → enable *Allow unsigned apps* → **Add app** → upload the aarch64 `.eap` →
**Start**. Open the app's settings page, enter VAPIX admin credentials, click **Run self-test**.

## Connect an MCP client

Two endpoints:

- Reverse-proxied (camera enforces admin digest auth):
  `http://<camera-ip>/local/axis_mcp/mcp`
- Direct LAN port (for clients without digest; optional bearer token):
  `http://<camera-ip>:8000/mcp`

```sh
claude mcp add --transport http axis-q1656 http://<camera-ip>:8000/mcp
```

Inspect with: `npx @modelcontextprotocol/inspector`

## Verification checklist

- [ ] `.eap` installs and starts on FW 12.x without manifest errors
- [ ] `curl -X POST http://<ip>:8000/mcp` with an `initialize` body returns server info
- [ ] MCP Inspector lists all tools and each returns live data
- [ ] `take_snapshot` returns a viewable JPEG
- [ ] `set_param` refuses non-allowlisted groups
- [ ] App survives respawn (save settings → app restarts → MCP still answers)
- [ ] Clean SIGINT exit

## Notes

- Digest auth honours the `algorithm` directive (MD5 **and** SHA-256 + `-sess`) — an MD5-only client
  gets a silent 401 on modern AXIS OS.
- The in-app server binds `process.env.HTTP_PORT` (AXIS OS assigns it; 32554 only for local dev).
- Direct-port reachability from the LAN depends on the camera firewall; the reverse-proxied path is the
  sanctioned route. Keep a bearer token set if the direct port is enabled.
