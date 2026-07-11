// Ops/diagnostics tools, part 2: device identification and network-facing
// config APIs. Find my device, Feature Flag Service, Regional settings and
// mDNS-SD are small Google-JSON-style APIs; Geolocation's Position API is a
// legacy GET/XML CGI; NTP and Network settings are Google-JSON-style but
// larger — Network settings API is treated read-only here per ROADMAP.md
// (network reconfiguration, e.g. static IP / 802.1X, is exactly the kind of
// change that can lock the agent itself out, so it's deliberately excluded).
// See:
//   https://developer.axis.com/vapix/network-video/find-my-device/
//   https://developer.axis.com/vapix/network-video/feature-flag-service/
//   https://developer.axis.com/vapix/network-video/regional-settings/
//   https://developer.axis.com/vapix/network-video/mdns-sd-api/
//   https://developer.axis.com/vapix/network-video/geolocation-api/
//   https://developer.axis.com/vapix/network-video/ntp-api/
//   https://developer.axis.com/vapix/network-video/network-settings-api/
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { vapix } from '../vapix';
import { guard, jsonResult, errorResult, safeJson, extractXmlBlocks, parseFlatXml, ToolResult } from './util';

interface JsonRpcResponse {
  apiVersion?: string;
  context?: string;
  method?: string;
  data?: unknown;
  error?: { code: number; message: string; details?: unknown };
}

function isJsonRpcResponse(x: unknown): x is JsonRpcResponse {
  return !!x && typeof x === 'object';
}

async function jsonRpcCall(path: string, method: string, params?: Record<string, unknown>) {
  const res = await vapix({
    method: 'POST',
    path,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ apiVersion: '1.0', context: 'axis-mcp', method, ...(params ? { params } : {}) }),
  });
  return { status: res.status, response: safeJson(res.text()) };
}

function jsonRpcResult(status: number, response: unknown, notInstalledHint: string): ToolResult {
  if (status === 404) return errorResult(notInstalledHint);
  if (!isJsonRpcResponse(response)) return errorResult(`Unexpected response (HTTP ${status}).`);
  if (response.error) {
    const details = response.error.details ? ` (${JSON.stringify(response.error.details)})` : '';
    return errorResult(`API error ${response.error.code}: ${response.error.message}${details}`);
  }
  return jsonResult(response.data ?? {});
}

// ============================================================================
// Find my device
// ============================================================================

export function registerFindMyDeviceTools(server: McpServer): void {
  const path = '/axis-cgi/findmydevice.cgi';
  const hint = 'Find my device API not available on this model (findmydevice.cgi returned 404).';

  server.registerTool(
    'find_my_device',
    {
      title: 'Locate this device',
      description: 'Trigger the device\'s identification mechanism (e.g. a sound or flashing status LED) to help locate it physically.',
      inputSchema: { durationSeconds: z.number().int().min(1).max(3600).optional().describe('How long the search sequence lasts. Default: device default.') },
    },
    async (args): Promise<ToolResult> =>
      guard(async () => {
        const { status, response } = await jsonRpcCall(path, 'find', args.durationSeconds !== undefined ? { duration: args.durationSeconds } : undefined);
        return jsonRpcResult(status, response, hint);
      }),
  );

  server.registerTool(
    'stop_find_my_device',
    {
      title: 'Stop locating this device',
      description: 'Halt an in-progress find-my-device search sequence.',
      inputSchema: {},
    },
    async (): Promise<ToolResult> =>
      guard(async () => {
        const { status, response } = await jsonRpcCall(path, 'stop');
        return jsonRpcResult(status, response, hint);
      }),
  );
}

// ============================================================================
// Feature Flag Service
// ============================================================================

export function registerFeatureFlagTools(server: McpServer): void {
  const path = '/axis-cgi/featureflag.cgi';
  const hint = 'Feature Flag Service not available on this model (featureflag.cgi returned 404).';

  server.registerTool(
    'featureflag_list_all',
    {
      title: 'List all feature flags',
      description: 'List every feature flag on the device with its current value, default value, and description.',
      inputSchema: {},
    },
    async (): Promise<ToolResult> =>
      guard(async () => {
        const { status, response } = await jsonRpcCall(path, 'listAll');
        return jsonRpcResult(status, response, hint);
      }),
  );

  server.registerTool(
    'featureflag_get',
    {
      title: 'Get feature flag values',
      description: 'Get the current value of one or more named feature flags (see featureflag_list_all for names).',
      inputSchema: { names: z.array(z.string()).min(1) },
    },
    async (args): Promise<ToolResult> =>
      guard(async () => {
        const { status, response } = await jsonRpcCall(path, 'get', { names: args.names });
        return jsonRpcResult(status, response, hint);
      }),
  );

  server.registerTool(
    'featureflag_set',
    {
      title: 'Set feature flag values',
      description: 'Toggle one or more feature flags on/off — e.g. to try an experimental feature. Use with care; flags may control in-development or unsupported functionality.',
      inputSchema: { flagValues: z.record(z.string(), z.boolean()).describe('Map of flag name -> desired boolean value.') },
    },
    async (args): Promise<ToolResult> =>
      guard(async () => {
        const { status, response } = await jsonRpcCall(path, 'set', { flagValues: args.flagValues });
        return jsonRpcResult(status, response, hint);
      }),
  );
}

// ============================================================================
// Regional settings
// ============================================================================

export function registerRegionalSettingsTools(server: McpServer): void {
  const path = '/axis-cgi/regionalsettings.cgi';
  const hint = 'Regional settings API not available on this model (regionalsettings.cgi returned 404).';

  server.registerTool(
    'regionalsettings_get',
    {
      title: 'Get regional settings',
      description: 'Get the device\'s regional display settings (currently: length unit, metric or us_customary).',
      inputSchema: {},
    },
    async (): Promise<ToolResult> =>
      guard(async () => {
        const { status, response } = await jsonRpcCall(path, 'getRegionalSettings');
        return jsonRpcResult(status, response, hint);
      }),
  );

  server.registerTool(
    'regionalsettings_set',
    {
      title: 'Set regional settings',
      description: 'Set the device\'s length unit (metric or us_customary), used for presentation only — this does not convert any stored values.',
      inputSchema: { length: z.enum(['metric', 'us_customary']) },
    },
    async (args): Promise<ToolResult> =>
      guard(async () => {
        const { status, response } = await jsonRpcCall(path, 'setRegionalSettings', { units: { length: args.length } });
        return jsonRpcResult(status, response, hint);
      }),
  );
}

// ============================================================================
// mDNS-SD API
// ============================================================================

export function registerMdnsSdTools(server: McpServer): void {
  const path = '/axis-cgi/mdnssd.cgi';
  const hint = 'mDNS-SD API not available on this model (mdnssd.cgi returned 404).';

  server.registerTool(
    'mdnssd_get_info',
    {
      title: 'Get mDNS-SD configuration',
      description: 'Get whether mDNS-SD (Bonjour-style local network discovery) is enabled, and the friendly name it advertises.',
      inputSchema: {},
    },
    async (): Promise<ToolResult> =>
      guard(async () => {
        const { status, response } = await jsonRpcCall(path, 'getMdnssdInfo');
        return jsonRpcResult(status, response, hint);
      }),
  );

  server.registerTool(
    'mdnssd_set_configuration',
    {
      title: 'Set mDNS-SD configuration',
      description: 'Enable/disable mDNS-SD and/or set the friendly name it advertises (max 48 bytes).',
      inputSchema: {
        enabled: z.boolean().optional(),
        friendlyName: z.string().max(48).optional(),
      },
    },
    async (args): Promise<ToolResult> =>
      guard(async () => {
        if (args.enabled === undefined && args.friendlyName === undefined) return errorResult('Provide enabled and/or friendlyName.');
        const { status, response } = await jsonRpcCall(path, 'setMdnssdConfiguration', {
          ...(args.enabled !== undefined ? { enabled: args.enabled } : {}),
          ...(args.friendlyName !== undefined ? { friendlyName: args.friendlyName } : {}),
        });
        return jsonRpcResult(status, response, hint);
      }),
  );

  server.registerTool(
    'mdnssd_discover',
    {
      title: 'Discover devices via mDNS-SD',
      description: 'Discover other devices on the network exposing given mDNS-SD services (e.g. "_axis-video._tcp" for cameras, "_axis-nvr._tcp" for recorders).',
      inputSchema: {
        services: z.array(z.string()).min(1).describe('e.g. ["_axis-video._tcp"]'),
        timeoutSeconds: z.number().int().min(1).max(15).default(5),
      },
    },
    async (args): Promise<ToolResult> =>
      guard(async () => {
        const { status, response } = await jsonRpcCall(path, 'discover', { services: args.services, timeout: args.timeoutSeconds });
        return jsonRpcResult(status, response, hint);
      }),
  );
}

// ============================================================================
// Geolocation API (Position API only — the Orientation/geoorientation sub-API
// is not fully documented on developer.axis.com and is left uncovered)
// ============================================================================

export function registerGeolocationTools(server: McpServer): void {
  server.registerTool(
    'geolocation_get_position',
    {
      title: 'Get device geolocation',
      description: 'Get the device\'s stored latitude/longitude/heading and free-text location tag (e.g. "floor 2"). Format (DD/DDMM/DDMMSS) matches whatever was last set.',
      inputSchema: {},
    },
    async (): Promise<ToolResult> =>
      guard(async () => {
        const res = await vapix({ method: 'GET', path: '/axis-cgi/geolocation/get.cgi' });
        if (res.status === 404) return errorResult('Geolocation API not available on this model (404).');
        if (res.status < 200 || res.status >= 300) return errorResult(`geolocation/get.cgi failed (HTTP ${res.status}): ${res.text().slice(0, 300)}`);
        if (!/<GetSuccess>/.test(res.text())) return errorResult(`Unexpected response: ${res.text().slice(0, 300)}`);
        // parseFlatXml's tag scan finds Lat/Lng/Heading/Text/ValidPosition/ValidHeading
        // regardless of the <Location> wrapper nesting around the first three.
        return jsonResult(parseFlatXml(res.text()));
      }),
  );

  server.registerTool(
    'geolocation_set_position',
    {
      title: 'Set device geolocation',
      description:
        'Set the device\'s latitude/longitude/heading and a free-text location tag. lat/lng must be in WGS-84 ' +
        'degrees (DD format, e.g. lat=51.1234, lng=13.1234); heading is 0-360° where 0=North, 90=East.',
      inputSchema: {
        lat: z.number().min(-90).max(90),
        lng: z.number().min(-180).max(180),
        heading: z.number().min(0).max(360).optional(),
        text: z.string().optional().describe('Free-text tag, e.g. "floor 2".'),
      },
    },
    async (args): Promise<ToolResult> =>
      guard(async () => {
        const res = await vapix({
          method: 'GET',
          path: '/axis-cgi/geolocation/set.cgi',
          query: { lat: args.lat, lng: args.lng, heading: args.heading, text: args.text },
        });
        if (res.status === 404) return errorResult('Geolocation API not available on this model (404).');
        const xml = res.text();
        if (/<SetError>/.test(xml)) {
          const errors = extractXmlBlocks(xml, 'SetError')[0] ?? '';
          return errorResult(`Geolocation set failed: ${errors.replace(/\s+/g, ' ').trim()}`);
        }
        return jsonResult({ ok: /<GeneralSuccess/.test(xml) });
      }),
  );
}

// ============================================================================
// NTP API
// ============================================================================

export function registerNtpTools(server: McpServer): void {
  const path = '/axis-cgi/ntp.cgi';
  const hint = 'NTP API not available on this model (ntp.cgi returned 404).';

  server.registerTool(
    'ntp_get_info',
    {
      title: 'Get NTP configuration',
      description: 'Get the current NTP client configuration and sync status: enabled state, NTS usage, server source (DHCP/static), server lists, and whether/how well the clock is synced.',
      inputSchema: {},
    },
    async (): Promise<ToolResult> =>
      guard(async () => {
        const { status, response } = await jsonRpcCall(path, 'getNTPInfo', {});
        return jsonRpcResult(status, response, hint);
      }),
  );

  server.registerTool(
    'ntp_set_client_configuration',
    {
      title: 'Set NTP client configuration',
      description:
        'Configure the NTP client. Only supplied fields are changed. Setting serversSource to "static" uses ' +
        'staticServers instead of DHCP-advertised servers; enabling NTS requires staticNTSKEServers.',
      inputSchema: {
        enabled: z.boolean().optional(),
        NTSEnabled: z.boolean().optional(),
        serversSource: z.enum(['DHCP', 'static']).optional(),
        staticServers: z.array(z.string()).optional().describe('IP addresses or hostnames. Empty list clears them.'),
        staticNTSKEServers: z.array(z.string()).optional(),
        minpoll: z.number().int().min(0).max(24).optional(),
        maxpoll: z.number().int().min(0).max(24).optional(),
      },
    },
    async (args): Promise<ToolResult> =>
      guard(async () => {
        const params: Record<string, unknown> = {};
        if (args.enabled !== undefined) params.enabled = args.enabled;
        if (args.NTSEnabled !== undefined) params.NTSEnabled = args.NTSEnabled;
        if (args.serversSource !== undefined) params.serversSource = args.serversSource;
        if (args.staticServers !== undefined) params.staticServers = args.staticServers;
        if (args.staticNTSKEServers !== undefined) params.staticNTSKEServers = args.staticNTSKEServers;
        if (args.minpoll !== undefined) params.minpoll = args.minpoll;
        if (args.maxpoll !== undefined) params.maxpoll = args.maxpoll;
        if (Object.keys(params).length === 0) return errorResult('Provide at least one field to change.');
        const { status, response } = await jsonRpcCall(path, 'setNTPClientConfiguration', params);
        return jsonRpcResult(status, response, hint);
      }),
  );
}

// ============================================================================
// Network settings API — read-only (see module comment: reconfiguring network
// settings can lock the agent itself out, so only getNetworkInfo is exposed).
// ============================================================================

export function registerNetworkSettingsTools(server: McpServer): void {
  server.registerTool(
    'network_get_info',
    {
      title: 'Get network configuration',
      description:
        'Read the full network configuration: every network interface device (wired/WLAN) with its IPv4/IPv6 ' +
        'settings, DNS, 802.1X status, and WLAN station config where applicable. Read-only — this server ' +
        'intentionally does not expose the write methods (changing IP/DNS/802.1X could disconnect the agent itself).',
      inputSchema: {},
    },
    async (): Promise<ToolResult> =>
      guard(async () => {
        const { status, response } = await jsonRpcCall('/axis-cgi/network_settings.cgi', 'getNetworkInfo', {});
        return jsonRpcResult(status, response, 'Network settings API not available on this model (network_settings.cgi returned 404).');
      }),
  );
}
