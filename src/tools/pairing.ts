// Network Pairing API (BETA) — pair with remote AXIS accessory devices (e.g.
// a D4100-E siren/light) to use as event-action targets — and Edge-to-edge
// camera pairing API (BETA) — pair with an external camera/intercom to pull
// its video feed. Both are newer Device Configuration API (REST) framework
// APIs distinct from the CamStreamer/CamSwitcher ACAP integrations already
// covered elsewhere in this codebase.
// See:
//   https://developer.axis.com/vapix/device-configuration/network-pairing-api/
//   https://developer.axis.com/vapix/device-configuration/edge-to-edge-camera-pairing-api/
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { guard, ToolResult } from './util';
import { dcGet, dcPatch, dcPost, dcDelete, dcResult } from './deviceConfigApi';

function compact(obj: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined));
}

export function registerNetworkPairingTools(server: McpServer): void {
  const hint = 'Network Pairing API not available on this model (BETA — /config/rest/networkpairing/v1beta returned 404).';

  server.registerTool(
    'netpairing_list',
    {
      title: 'List network pairings',
      description:
        'BETA. List paired remote accessory devices (e.g. AXIS D4100-E siren/light) and their connection status. All communication with paired ' +
        'devices is encrypted and the remote certificate is pinned at pairing time.',
      inputSchema: {},
    },
    async (): Promise<ToolResult> =>
      guard(async () => {
        const { httpStatus, response } = await dcGet('networkpairing/v1beta/pairings');
        return dcResult(httpStatus, response, hint);
      }),
  );

  server.registerTool(
    'netpairing_add',
    {
      title: 'Add a network pairing',
      description: 'BETA. Pair with a remote accessory device by address and credentials. All available features on the remote device are enabled by default.',
      inputSchema: {
        address: z.string().describe('FQDN, IPv4, or IPv6 address of the remote device.'),
        username: z.string(),
        password: z.string(),
        description: z.string().optional(),
        niceName: z.string().optional(),
      },
    },
    async (args): Promise<ToolResult> =>
      guard(async () => {
        const body = compact({ address: args.address, username: args.username, password: args.password, description: args.description, nice_name: args.niceName });
        const { httpStatus, response } = await dcPost('networkpairing/v1beta/pairings', body);
        return dcResult(httpStatus, response, hint);
      }),
  );

  server.registerTool(
    'netpairing_remove',
    {
      title: 'Remove a network pairing',
      description: 'BETA. Remove a pairing by ID.',
      inputSchema: { id: z.string() },
    },
    async (args): Promise<ToolResult> =>
      guard(async () => {
        const { httpStatus, response } = await dcDelete(`networkpairing/v1beta/pairings/${encodeURIComponent(args.id)}`);
        return dcResult(httpStatus, response, hint);
      }),
  );

  server.registerTool(
    'netpairing_set_nice_name',
    {
      title: 'Rename a network pairing',
      description: 'BETA. Set the user-friendly display name of a pairing.',
      inputSchema: { id: z.string(), niceName: z.string() },
    },
    async (args): Promise<ToolResult> =>
      guard(async () => {
        const { httpStatus, response } = await dcPatch(`networkpairing/v1beta/pairings/${encodeURIComponent(args.id)}/nice_name`, args.niceName);
        return dcResult(httpStatus, response, hint);
      }),
  );

  server.registerTool(
    'netpairing_get_features',
    {
      title: 'Get a pairing\'s available features',
      description: 'BETA. List the feature categories and capabilities (e.g. SirenLight → Actions) a paired device exposes, and whether each is currently enabled on the host.',
      inputSchema: { id: z.string() },
    },
    async (args): Promise<ToolResult> =>
      guard(async () => {
        const { httpStatus, response } = await dcGet(`networkpairing/v1beta/pairings/${encodeURIComponent(args.id)}/features`);
        return dcResult(httpStatus, response, hint);
      }),
  );

  server.registerTool(
    'netpairing_set_capability_enabled',
    {
      title: 'Enable / disable a paired capability',
      description: 'BETA. Toggle whether a specific capability of a paired device\'s feature (from netpairing_get_features) is usable on this host. Does not affect the remote device itself.',
      inputSchema: { id: z.string(), category: z.string().describe('Feature category, e.g. "SirenLight".'), capability: z.string().describe('Capability name, e.g. "Actions".'), enabled: z.boolean() },
    },
    async (args): Promise<ToolResult> =>
      guard(async () => {
        const { httpStatus, response } = await dcPatch(
          `networkpairing/v1beta/pairings/${encodeURIComponent(args.id)}/features/${encodeURIComponent(args.category)}/capabilities/${encodeURIComponent(args.capability)}/enabled`,
          args.enabled,
        );
        return dcResult(httpStatus, response, hint);
      }),
  );

  server.registerTool(
    'netpairing_sirenlight_list_profiles',
    {
      title: 'List siren/light profiles on a paired device',
      description: 'BETA. List named siren/light profiles (e.g. "Loud noise", "Police sirens") available on a paired AXIS siren/light accessory, which can be triggered as event actions.',
      inputSchema: { pairingId: z.string() },
    },
    async (args): Promise<ToolResult> =>
      guard(async () => {
        const { httpStatus, response } = await dcGet(`networkpairing/v1beta/plugins/siren_light/profiles/${encodeURIComponent(args.pairingId)}`);
        return dcResult(httpStatus, response, hint);
      }),
  );

  server.registerTool(
    'netpairing_sirenlight_get_capabilities',
    {
      title: 'Get siren/light capabilities of a paired device',
      description: 'BETA. Check whether a paired accessory supports "siren", "light", or both.',
      inputSchema: { pairingId: z.string() },
    },
    async (args): Promise<ToolResult> =>
      guard(async () => {
        const { httpStatus, response } = await dcGet(`networkpairing/v1beta/plugins/siren_light/capabilities/${encodeURIComponent(args.pairingId)}`);
        return dcResult(httpStatus, response, hint);
      }),
  );
}

export function registerCameraPairingTools(server: McpServer): void {
  const hint = 'Edge-to-edge camera pairing API not available on this model (BETA — /config/rest/camera-pairing/v1beta returned 404).';

  server.registerTool(
    'camerapairing_list',
    {
      title: 'List camera pairings',
      description: 'BETA. List paired external cameras/intercoms (currently limited to one pairing per device) and their connection status.',
      inputSchema: {},
    },
    async (): Promise<ToolResult> =>
      guard(async () => {
        const { httpStatus, response } = await dcGet('camera-pairing/v1beta/camerapairings');
        return dcResult(httpStatus, response, hint);
      }),
  );

  server.registerTool(
    'camerapairing_add',
    {
      title: 'Pair an external camera',
      description: 'BETA. Pair with an external camera or intercom to view its video feed from this device. Only one camera pairing is supported at a time.',
      inputSchema: {
        address: z.string(),
        username: z.string(),
        password: z.string(),
        streamingprotocol: z.enum(['RTSP', 'SRTSP']).default('SRTSP'),
        verifycertificate: z.boolean().default(true),
        description: z.string().optional(),
      },
    },
    async (args): Promise<ToolResult> =>
      guard(async () => {
        const body = {
          address: args.address,
          username: args.username,
          password: args.password,
          streamingprotocol: args.streamingprotocol,
          verifycertificate: args.verifycertificate,
          description: args.description ?? '',
        };
        const { httpStatus, response } = await dcPost('camera-pairing/v1beta/camerapairings', body);
        return dcResult(httpStatus, response, hint);
      }),
  );

  server.registerTool(
    'camerapairing_get',
    {
      title: 'Get a camera pairing',
      description: 'BETA. Get the settings of a camera pairing by ID (from camerapairing_list): address, product model/name, streaming protocol, and available video channels.',
      inputSchema: { id: z.string() },
    },
    async (args): Promise<ToolResult> =>
      guard(async () => {
        const { httpStatus, response } = await dcGet(`camera-pairing/v1beta/camerapairings/${encodeURIComponent(args.id)}`);
        return dcResult(httpStatus, response, hint);
      }),
  );

  server.registerTool(
    'camerapairing_get_status',
    {
      title: 'Get a camera pairing\'s connection status',
      description: 'BETA. Get the current status of a camera pairing: NOT_PAIRED, PAIRED, ERROR, or CONNECTING. On ERROR, check camerapairing_get for details.',
      inputSchema: { id: z.string() },
    },
    async (args): Promise<ToolResult> =>
      guard(async () => {
        const { httpStatus, response } = await dcGet(`camera-pairing/v1beta/camerapairings/${encodeURIComponent(args.id)}/status`);
        return dcResult(httpStatus, response, hint);
      }),
  );

  server.registerTool(
    'camerapairing_update',
    {
      title: 'Update a camera pairing',
      description: 'BETA. Update one or more fields of an existing camera pairing by ID. Each field is written independently; partial failures are reported per field.',
      inputSchema: {
        id: z.string(),
        address: z.string().optional(),
        username: z.string().optional(),
        password: z.string().optional(),
        description: z.string().optional(),
        streamingprotocol: z.enum(['RTSP', 'SRTSP']).optional(),
        verifycertificate: z.boolean().optional(),
        selectedVideoChannel: z.string().optional(),
      },
    },
    async (args): Promise<ToolResult> =>
      guard(async () => {
        const fields = compact({
          address: args.address,
          username: args.username,
          password: args.password,
          description: args.description,
          streamingprotocol: args.streamingprotocol,
          verifycertificate: args.verifycertificate,
          selectedVideoChannel: args.selectedVideoChannel,
        });
        const entries = Object.entries(fields);
        if (entries.length === 0) return dcResult(400, { status: 'error' }, 'No fields supplied to update.');
        const results: Record<string, unknown> = {};
        for (const [field, value] of entries) {
          const { httpStatus, response } = await dcPatch(`camera-pairing/v1beta/camerapairings/${encodeURIComponent(args.id)}/${field}`, value);
          results[field] = { httpStatus, response };
        }
        return dcResult(200, { status: 'success', data: results }, hint);
      }),
  );

  server.registerTool(
    'camerapairing_remove',
    {
      title: 'Unpair an external camera',
      description: 'BETA. Remove a camera pairing by ID.',
      inputSchema: { id: z.string() },
    },
    async (args): Promise<ToolResult> =>
      guard(async () => {
        const { httpStatus, response } = await dcDelete(`camera-pairing/v1beta/camerapairings/${encodeURIComponent(args.id)}`);
        return dcResult(httpStatus, response, hint);
      }),
  );
}
