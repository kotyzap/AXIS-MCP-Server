// Smaller, self-contained "Device Configuration API" (REST framework) tools:
// Param API, Device mode configuration, Object Snapshot Configuration API,
// Coordinate conversion API, and Event schedules API. All use the shared
// GET/PATCH/POST/DELETE helpers in deviceConfigApi.ts.
// See:
//   https://developer.axis.com/vapix/device-configuration/param-api/
//   https://developer.axis.com/vapix/device-configuration/device-mode-configuration-api/
//   https://developer.axis.com/vapix/device-configuration/object-snapshot-configuration/
//   https://developer.axis.com/vapix/device-configuration/coordinate-conversion-api/
//   https://developer.axis.com/vapix/device-configuration/event-schedules-api/
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { guard, ToolResult } from './util';
import { dcGet, dcPatch, dcPost, dcDelete, dcResult } from './deviceConfigApi';

function compact(obj: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined));
}

export function registerParamApiTools(server: McpServer): void {
  const hint = 'Param API not available on this model (BETA — /config/rest/param/v2beta/... returned 404).';

  server.registerTool(
    'dcparam_get',
    {
      title: 'Get a param.cgi entity/property via the newer Param API',
      description:
        'BETA. Read a param.cgi group or parameter through the newer dynamically-typed Device Configuration API instead of the legacy ' +
        'get_audio_config-style param.cgi GET. Path is dot-separated matching the parameter group, e.g. "Brand" or "Audio.MaxListeners". ' +
        'Dynamic groups (multi-instance, e.g. IOPort) appear as "<Group>Collection" arrays rather than dotted instance paths — see param_api docs.',
      inputSchema: { path: z.string().describe('Dot-separated entity/property path, e.g. "Brand" or "Audio.MaxListeners".') },
    },
    async (args): Promise<ToolResult> =>
      guard(async () => {
        const { httpStatus, response } = await dcGet(`param/v2beta/${args.path}`);
        return dcResult(httpStatus, response, hint);
      }),
  );

  server.registerTool(
    'dcparam_export',
    {
      title: 'Export all writable parameters',
      description: 'BETA. Export every writable (import/export-tagged) param.cgi parameter as structured JSON — useful for backing up config before changes, or to replicate to another device.',
      inputSchema: {},
    },
    async (): Promise<ToolResult> =>
      guard(async () => {
        const { httpStatus, response } = await dcGet('param/v2beta/$export');
        return dcResult(httpStatus, response, hint);
      }),
  );

  server.registerTool(
    'dcparam_import',
    {
      title: 'Import parameters',
      description:
        'BETA. Import a structured JSON payload (as produced by dcparam_export) of parameters/groups to apply. Only the properties provided ' +
        'are changed; failures for individual properties are reported without failing the whole request. Automatically creates dynamic ' +
        'group instances (e.g. a new AudioCollection entry) if they do not already exist.',
      inputSchema: { data: z.record(z.string(), z.any()).describe('The structured parameter data to import, matching dcparam_export\'s shape.') },
    },
    async (args): Promise<ToolResult> =>
      guard(async () => {
        const { httpStatus, response } = await dcPatch('param/v2beta/$import', args.data);
        return dcResult(httpStatus, response, hint);
      }),
  );
}

export function registerDeviceModeTools(server: McpServer): void {
  const hint = 'Device mode configuration API not available on this model (BETA — /config/rest/device-mode/v1beta returned 404).';

  server.registerTool(
    'devicemode_get',
    {
      title: 'Get device mode',
      description:
        'BETA. Get the device\'s current operating mode (e.g. "fisheye", "double-panorama"), the pending mode if a change is queued, ' +
        'whether a restart is required to apply it, and all available modes for this hardware. A single-sensor fixed camera will typically ' +
        'report only one available mode.',
      inputSchema: {},
    },
    async (): Promise<ToolResult> =>
      guard(async () => {
        const { httpStatus, response } = await dcGet('device-mode/v1beta');
        return dcResult(httpStatus, response, hint);
      }),
  );

  server.registerTool(
    'devicemode_set_mode',
    {
      title: 'Set device mode',
      description:
        'BETA. Request a device mode change (from devicemode_get\'s availableModes). If restartRequired becomes true, the change only takes ' +
        'effect after a reboot (see reboot_camera) — or can be cancelled by calling this again with the current activeMode. Changing mode can ' +
        'change camera behavior significantly (e.g. splitting one sensor into multiple virtual channels).',
      inputSchema: { mode: z.string().describe('Mode ID from devicemode_get\'s availableModes, e.g. "fisheye".') },
    },
    async (args): Promise<ToolResult> =>
      guard(async () => {
        const { httpStatus, response } = await dcPatch('device-mode/v1beta/mode', args.mode);
        return dcResult(httpStatus, response, hint);
      }),
  );
}

export function registerObjectSnapshotTools(server: McpServer): void {
  const hint = 'Object Snapshot Configuration API not available on this model (/config/rest/object-snapshot/v1 returned 404).';

  server.registerTool(
    'objectsnapshot_get',
    {
      title: 'Get object snapshot settings',
      description: 'Get whether cropped object snapshots (for analytics metadata producers like Analytics Scene Description) are enabled, and whether they include a margin around the bounding box.',
      inputSchema: {},
    },
    async (): Promise<ToolResult> =>
      guard(async () => {
        const { httpStatus, response } = await dcGet('object-snapshot/v1');
        return dcResult(httpStatus, response, hint);
      }),
  );

  server.registerTool(
    'objectsnapshot_set',
    {
      title: 'Set object snapshot settings',
      description: 'Enable/disable cropped object snapshots and/or whether they include a margin around the bounding box. Only supplied fields are changed.',
      inputSchema: { enabled: z.boolean().optional(), margin: z.boolean().optional() },
    },
    async (args): Promise<ToolResult> =>
      guard(async () => {
        const { httpStatus, response } = await dcPatch('object-snapshot/v1', compact({ enabled: args.enabled, margin: args.margin }));
        return dcResult(httpStatus, response, hint);
      }),
  );
}

export function registerCoordinateConversionTools(server: McpServer): void {
  const hint = 'Coordinate conversion API not available on this model (/config/rest/coordinate-conversion-api/v1 returned 404).';

  server.registerTool(
    'coordconv_list_spaces',
    {
      title: 'List supported coordinate spaces',
      description:
        'List the coordinate spaces this device knows about, e.g. "cameraImage@1" (normalized [0,1] image pixel coordinates), ' +
        '"deviceCentricCartesian" (world-space x/y/z), "geographicPosition" (lat/lon/elevation), "radarImage@N". Use these names with coordconv_convert.',
      inputSchema: {},
    },
    async (): Promise<ToolResult> =>
      guard(async () => {
        const { httpStatus, response } = await dcGet('coordinate-conversion-api/v1/spaces');
        return dcResult(httpStatus, response, hint);
      }),
  );

  server.registerTool(
    'coordconv_convert',
    {
      title: 'Convert points between coordinate spaces',
      description:
        'Convert a batch of points (up to 1000) from one coordinate space to another, e.g. from a pixel in the camera image to a real-world ' +
        'position. Points that have no corresponding location in the destination space (e.g. a sky pixel with no ground position) come back as an empty list.',
      inputSchema: {
        sourceSpace: z.string().describe('Source coordinate space name from coordconv_list_spaces, e.g. "cameraImage@1".'),
        destination: z.string().describe('Destination coordinate space name, e.g. "deviceCentricCartesian".'),
        points: z.array(z.array(z.number())).describe('List of points; each point is itself a list of numbers (dimensionality depends on the source space).'),
      },
    },
    async (args): Promise<ToolResult> =>
      guard(async () => {
        const { httpStatus, response } = await dcPost(`coordinate-conversion-api/v1/spaces/${encodeURIComponent(args.sourceSpace)}/convert`, {
          destination: args.destination,
          points: args.points.map((p) => [p]),
        });
        return dcResult(httpStatus, response, hint);
      }),
  );
}

export function registerEventScheduleTools(server: McpServer): void {
  const hint = 'Event schedules API not available on this model (/config/rest/event-schedules/v2 returned 404).';

  server.registerTool(
    'eventschedule_list',
    {
      title: 'List event schedules',
      description:
        'List all configured event schedules (pulse schedules that fire repeatedly, or interval schedules that are statefully "active"/"inactive" ' +
        'over a recurring time window), in iCalendar-based RFC 5545 format. Referenced by ID from other features like recurring actions or speaker display power-save schedules.',
      inputSchema: {},
    },
    async (): Promise<ToolResult> =>
      guard(async () => {
        const { httpStatus, response } = await dcGet('event-schedules/v2');
        return dcResult(httpStatus, response, hint);
      }),
  );

  server.registerTool(
    'eventschedule_create',
    {
      title: 'Create an event schedule',
      description:
        'Create a schedule from an iCalendar-style definition. Include DTEND to make it an interval (stateful on/off) schedule; omit it for a ' +
        'pulse (recurring instant) schedule. Example daily 9:30-17:00 Tue/Wed: "DTSTART:19700101T093000\\nDTEND:19700101T170000\\nRRULE:FREQ=WEEKLY;BYDAY=TU,WE".',
      inputSchema: {
        name: z.string().describe('Well-known name for the schedule.'),
        schedule: z.string().describe('iCalendar-format schedule definition (DTSTART/DTEND/RRULE lines joined with \\n).'),
        id: z.string().optional().describe('Optional explicit ID; auto-generated if omitted.'),
      },
    },
    async (args): Promise<ToolResult> =>
      guard(async () => {
        const { httpStatus, response } = await dcPost('event-schedules/v2/schedules', compact({ name: args.name, schedule: args.schedule, id: args.id }));
        return dcResult(httpStatus, response, hint);
      }),
  );

  server.registerTool(
    'eventschedule_update',
    {
      title: 'Update an event schedule',
      description: 'Update the name and/or definition of an existing schedule by ID.',
      inputSchema: { id: z.string(), name: z.string().optional(), schedule: z.string().optional() },
    },
    async (args): Promise<ToolResult> =>
      guard(async () => {
        const { httpStatus, response } = await dcPatch(`event-schedules/v2/schedules/${encodeURIComponent(args.id)}`, compact({ name: args.name, schedule: args.schedule }));
        return dcResult(httpStatus, response, hint);
      }),
  );

  server.registerTool(
    'eventschedule_remove',
    {
      title: 'Remove an event schedule',
      description: 'Delete a schedule by ID. Check nothing still references it first (e.g. a speaker display power-save schedule).',
      inputSchema: { id: z.string() },
    },
    async (args): Promise<ToolResult> =>
      guard(async () => {
        const { httpStatus, response } = await dcDelete(`event-schedules/v2/schedules/${encodeURIComponent(args.id)}`);
        return dcResult(httpStatus, response, hint);
      }),
  );
}
