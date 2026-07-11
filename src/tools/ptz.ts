// PTZ (pan/tilt/zoom) tools via /axis-cgi/com/ptz.cgi.
// Not every model has PTZ hardware (e.g. fixed box cameras) — calls degrade
// gracefully and report the raw response when the driver rejects a command.
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { vapix } from '../vapix';
import { guard, jsonResult, errorResult, parseParamResponse, ToolResult } from './util';

const PTZ_PATH = '/axis-cgi/com/ptz.cgi';

async function ptzGet(query: Record<string, string | number | undefined>) {
  return vapix({ method: 'GET', path: PTZ_PATH, query });
}

/** query=position/status/limits responses are plain "key=value" lines, same shape as param.cgi. */
function parsePtzText(text: string): Record<string, string> | string {
  const parsed = parseParamResponse(text);
  return Object.keys(parsed).length > 0 ? parsed : text.trim();
}

/**
 * Parse ptz.cgi?query=presetposall|presetposcam|presetposcamdata plain-text
 * responses into structured per-camera preset lists.
 *
 * Shape (per official docs):
 *   Preset Positions for camera 1
 *   presetposno1=Home
 *   presetposno2=East PTZ
 *
 *   Preset Positions for camera 2
 *   ...
 *
 * presetposcamdata additionally reports position data in degrees per preset;
 * the exact sub-key names aren't fixed in the docs we could confirm, so we
 * group generically by preset number and keep whatever dotted suffix (e.g.
 * ".pan"/".tilt"/".zoom") the camera actually sends, rather than hardcoding
 * field names that might not match every firmware version.
 */
function parsePresetPositions(text: string): Array<{ camera: string; presets: Array<Record<string, string>> }> {
  const headerRe = /^Preset Positions for camera\s+(\S+)/i;
  const kvRe = /^([A-Za-z]+?)(\d+)(?:\.(\w+))?\s*=\s*(.*)$/;
  const cameras: Array<{ camera: string; presets: Map<string, Record<string, string>> }> = [];
  let current: (typeof cameras)[number] | null = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const h = headerRe.exec(line);
    if (h) {
      current = { camera: h[1], presets: new Map() };
      cameras.push(current);
      continue;
    }
    const m = kvRe.exec(line);
    if (m && current) {
      const [, , num, field, value] = m;
      const entry = current.presets.get(num) ?? { number: num };
      if (field) entry[field.toLowerCase()] = value;
      else entry.name = value;
      current.presets.set(num, entry);
    }
  }
  return cameras.map((c) => ({ camera: c.camera, presets: Array.from(c.presets.values()) }));
}

const MOVE_DIRECTIONS = [
  'home',
  'up',
  'down',
  'left',
  'right',
  'upleft',
  'upright',
  'downleft',
  'downright',
  'stop',
] as const;

export function registerPtzTools(server: McpServer): void {
  server.registerTool(
    'ptz_move',
    {
      title: 'PTZ discrete move',
      description:
        'Move the camera in a discrete direction (home/up/down/left/right/diagonals/stop) via ptz.cgi?move=. Requires PTZ hardware or a PTZ driver (e-flip/e-PTZ) on the target camera/video channel.',
      inputSchema: {
        move: z.enum(MOVE_DIRECTIONS).describe('Direction, or "home" to return to the home position, or "stop" to halt movement.'),
        camera: z.union([z.number(), z.string()]).optional().describe('Video channel / PTZ driver index. Omit for the default.'),
        speed: z.number().min(0).max(100).optional().describe('Optional move speed 0-100.'),
      },
    },
    async (args): Promise<ToolResult> =>
      guard(async () => {
        const res = await ptzGet({ move: args.move, camera: args.camera, speed: args.speed });
        if (res.status === 404) return errorResult('PTZ CGI not available on this model (no PTZ driver).');
        return jsonResult({ status: res.status, response: res.text().trim() });
      }),
  );

  server.registerTool(
    'ptz_relative_move',
    {
      title: 'PTZ relative move',
      description: 'Pan/tilt/zoom by a relative amount from the current position (rpan/rtilt/rzoom).',
      inputSchema: {
        rpan: z.number().optional().describe('Relative pan in degrees, e.g. 20 (right) or -20 (left).'),
        rtilt: z.number().optional().describe('Relative tilt in degrees.'),
        rzoom: z.number().optional().describe('Relative zoom.'),
        camera: z.union([z.number(), z.string()]).optional(),
      },
    },
    async (args): Promise<ToolResult> =>
      guard(async () => {
        if (args.rpan === undefined && args.rtilt === undefined && args.rzoom === undefined) {
          return errorResult('Provide at least one of rpan, rtilt, rzoom.');
        }
        const res = await ptzGet({ rpan: args.rpan, rtilt: args.rtilt, rzoom: args.rzoom, camera: args.camera });
        if (res.status === 404) return errorResult('PTZ CGI not available on this model.');
        return jsonResult({ status: res.status, response: res.text().trim() });
      }),
  );

  server.registerTool(
    'ptz_absolute_move',
    {
      title: 'PTZ absolute move',
      description: 'Move to an absolute pan/tilt/zoom position (pan/tilt/zoom params). Ranges are model-specific — use ptz_query with "limits" to discover them.',
      inputSchema: {
        pan: z.number().optional().describe('Absolute pan, typically -180..180.'),
        tilt: z.number().optional().describe('Absolute tilt, typically -180..180.'),
        zoom: z.number().optional().describe('Absolute zoom, e.g. 1..9999.'),
        camera: z.union([z.number(), z.string()]).optional(),
      },
    },
    async (args): Promise<ToolResult> =>
      guard(async () => {
        if (args.pan === undefined && args.tilt === undefined && args.zoom === undefined) {
          return errorResult('Provide at least one of pan, tilt, zoom.');
        }
        const res = await ptzGet({ pan: args.pan, tilt: args.tilt, zoom: args.zoom, camera: args.camera });
        if (res.status === 404) return errorResult('PTZ CGI not available on this model.');
        return jsonResult({ status: res.status, response: res.text().trim() });
      }),
  );

  server.registerTool(
    'ptz_continuous_move',
    {
      title: 'PTZ continuous move / stop',
      description:
        'Start continuous pan/tilt and/or zoom motion at a given speed (-100..100). Call again with pan=0,tilt=0 (and/or zoom=0) to stop, or use ptz_move with move="stop".',
      inputSchema: {
        pan: z.number().min(-100).max(100).optional().describe('Continuous pan speed, -100..100.'),
        tilt: z.number().min(-100).max(100).optional().describe('Continuous tilt speed, -100..100.'),
        zoom: z.number().min(-100).max(100).optional().describe('Continuous zoom speed, -100..100.'),
        camera: z.union([z.number(), z.string()]).optional(),
      },
    },
    async (args): Promise<ToolResult> =>
      guard(async () => {
        const query: Record<string, string | number | undefined> = { camera: args.camera };
        if (args.pan !== undefined || args.tilt !== undefined) {
          query.continuouspantiltmove = `${args.pan ?? 0},${args.tilt ?? 0}`;
        }
        if (args.zoom !== undefined) {
          query.continuouszoommove = args.zoom;
        }
        if (query.continuouspantiltmove === undefined && query.continuouszoommove === undefined) {
          return errorResult('Provide at least one of pan, tilt, zoom.');
        }
        const res = await ptzGet(query);
        if (res.status === 404) return errorResult('PTZ CGI not available on this model.');
        return jsonResult({ status: res.status, response: res.text().trim() });
      }),
  );

  server.registerTool(
    'ptz_query',
    {
      title: 'Query PTZ position / status / limits',
      description: 'Read the current PTZ position, driver status, or configured pan/tilt/zoom limits.',
      inputSchema: {
        what: z.enum(['position', 'status', 'limits']).default('position'),
        camera: z.union([z.number(), z.string()]).optional(),
      },
    },
    async (args): Promise<ToolResult> =>
      guard(async () => {
        const res = await ptzGet({ query: args.what, camera: args.camera });
        if (res.status === 404) return errorResult('PTZ CGI not available on this model.');
        return jsonResult({ status: res.status, [args.what]: parsePtzText(res.text()) });
      }),
  );

  server.registerTool(
    'ptz_capabilities',
    {
      title: 'PTZ capabilities',
      description: 'List every PTZ command supported by the current camera/driver (ptz.cgi?info=1). Response is a large plain-text block.',
      inputSchema: {
        camera: z.union([z.number(), z.string()]).optional(),
      },
    },
    async (args): Promise<ToolResult> =>
      guard(async () => {
        const res = await ptzGet({ info: 1, camera: args.camera });
        if (res.status === 404) return errorResult('PTZ CGI not available on this model.');
        const text = res.text();
        return jsonResult({ status: res.status, info: text.length > 20000 ? text.slice(0, 20000) + '\n...[truncated]' : text });
      }),
  );

  server.registerTool(
    'ptz_preset_goto',
    {
      title: 'Go to PTZ preset',
      description: 'Move to a saved PTZ preset, by name or number.',
      inputSchema: {
        name: z.string().optional().describe('Preset name (gotoserverpresetname).'),
        number: z.union([z.number(), z.string()]).optional().describe('Preset number (gotoserverpresetno).'),
        camera: z.union([z.number(), z.string()]).optional(),
      },
    },
    async (args): Promise<ToolResult> =>
      guard(async () => {
        if (!args.name && args.number === undefined) return errorResult('Provide name or number.');
        const query: Record<string, string | number | undefined> = { camera: args.camera };
        if (args.name) query.gotoserverpresetname = args.name;
        if (args.number !== undefined) query.gotoserverpresetno = args.number;
        const res = await ptzGet(query);
        if (res.status === 404) return errorResult('PTZ CGI not available on this model.');
        return jsonResult({ status: res.status, response: res.text().trim() });
      }),
  );

  server.registerTool(
    'ptz_preset_save',
    {
      title: 'Save current position as a PTZ preset',
      description: 'Save the current pan/tilt/zoom position as a named preset.',
      inputSchema: {
        name: z.string().describe('Name for the new/overwritten preset.'),
        camera: z.union([z.number(), z.string()]).optional(),
      },
    },
    async (args): Promise<ToolResult> =>
      guard(async () => {
        const res = await ptzGet({ setserverpresetname: args.name, camera: args.camera });
        if (res.status === 404) return errorResult('PTZ CGI not available on this model.');
        return jsonResult({ status: res.status, response: res.text().trim() });
      }),
  );

  server.registerTool(
    'ptz_preset_list',
    {
      title: 'List PTZ presets (all view areas)',
      description:
        'List saved PTZ preset positions, grouped by camera/view area, including pan/tilt/zoom in degrees where the model reports it. ' +
        'Asking for "presets" or "PTZ presets" almost always means this: each view area/channel can have its own independent set of ' +
        'named presets. Defaults to every view area in one call (ptz.cgi?query=presetposcamdata&camera=all); falls back automatically ' +
        'to name-only listing (query=presetposcam) if the model does not support position data.',
      inputSchema: {
        camera: z
          .union([z.number(), z.string()])
          .optional()
          .describe('View area / video channel number (e.g. 1). Omit to list presets for all view areas at once.'),
      },
    },
    async (args): Promise<ToolResult> =>
      guard(async () => {
        const camera = args.camera ?? 'all';
        let withPositions = true;
        let res = await ptzGet({ query: 'presetposcamdata', camera });
        if (res.status === 404 || /unknown value/i.test(res.text())) {
          withPositions = false;
          res = await ptzGet({ query: 'presetposcam', camera });
        }
        if (res.status === 404) return errorResult('PTZ CGI not available on this model (no PTZ driver / view areas).');
        if (res.status !== 200) return jsonResult({ status: res.status, response: res.text().trim() });
        return jsonResult({ status: res.status, withPositions, cameras: parsePresetPositions(res.text()) });
      }),
  );

  server.registerTool(
    'ptz_preset_remove',
    {
      title: 'Delete a PTZ preset',
      description: 'Delete a saved PTZ preset by name.',
      inputSchema: {
        name: z.string().describe('Preset name to delete.'),
        camera: z.union([z.number(), z.string()]).optional(),
      },
    },
    async (args): Promise<ToolResult> =>
      guard(async () => {
        const res = await ptzGet({ removeserverpresetname: args.name, camera: args.camera });
        if (res.status === 404) return errorResult('PTZ CGI not available on this model.');
        return jsonResult({ status: res.status, response: res.text().trim() });
      }),
  );
}
