// PTZ/patrol tools beyond basic move/preset (already in ptz.ts): Guard tour
// API (preset tours via param.cgi + recorded tours via XML CGIs), PTZ
// Autotracker API, and PTZ Orientation Aid API (compass overlay).
// See:
//   https://developer.axis.com/vapix/network-video/guard-tour-api/
//   https://developer.axis.com/vapix/network-video/ptz-autotracker-api/
//   https://developer.axis.com/vapix/network-video/ptz-orientation-aid/
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { vapix } from '../vapix';
import {
  guard,
  jsonResult,
  errorResult,
  safeJson,
  parseParamResponse,
  extractXmlBlocks,
  parseFlatXml,
  xmlGeneralError,
  ToolResult,
} from './util';

// ============================================================================
// Guard tour API — preset tours (param.cgi dynamic groups)
// ============================================================================

export function registerGuardTourTools(server: McpServer): void {
  server.registerTool(
    'guardtour_list',
    {
      title: 'List guard tours',
      description: 'List every configured preset guard tour (GuardTour.G# group): name, running state, camera/view area, random order flag, and time between sequences.',
      inputSchema: {},
    },
    async (): Promise<ToolResult> =>
      guard(async () => {
        const res = await vapix({ method: 'GET', path: '/axis-cgi/param.cgi', query: { action: 'list', group: 'GuardTour' } });
        if (/does not exist|no such/i.test(res.text()) && res.status !== 200) {
          return errorResult('Guard tour API not available on this model.');
        }
        return jsonResult(parseParamResponse(res.text()));
      }),
  );

  server.registerTool(
    'guardtour_create',
    {
      title: 'Create a preset guard tour',
      description:
        'Create a new preset guard tour (GuardTour.G# group) and return its assigned group number. Add preset ' +
        'positions afterwards with guardtour_add_preset, then start it with guardtour_set_running.',
      inputSchema: {
        name: z.string().optional().describe('Descriptive name (no ", <, > characters).'),
        camNbr: z.number().int().optional().describe('View area / video source the tour applies to. Default 1.'),
        randomEnabled: z.boolean().optional().describe('true = visit presets in random order.'),
        timeBetweenSequencesMinutes: z.number().int().min(0).max(9999).optional(),
      },
    },
    async (args): Promise<ToolResult> =>
      guard(async () => {
        const query: Record<string, string> = { action: 'add', group: 'GuardTour', template: 'guardtour' };
        if (args.name !== undefined) query['GuardTour.G.Name'] = args.name;
        if (args.camNbr !== undefined) query['GuardTour.G.CamNbr'] = String(args.camNbr);
        if (args.randomEnabled !== undefined) query['GuardTour.G.RandomEnabled'] = args.randomEnabled ? 'yes' : 'no';
        if (args.timeBetweenSequencesMinutes !== undefined) query['GuardTour.G.TimeBetweenSequences'] = String(args.timeBetweenSequencesMinutes);
        const res = await vapix({ method: 'GET', path: '/axis-cgi/param.cgi', query });
        const text = res.text().trim();
        const match = text.match(/^(G\d+)\s+OK/);
        return jsonResult({ status: res.status, group: match ? match[1] : undefined, response: text });
      }),
  );

  server.registerTool(
    'guardtour_remove',
    {
      title: 'Remove a guard tour',
      description: 'Delete a preset guard tour group entirely (all its preset positions go with it).',
      inputSchema: { group: z.string().describe('Group number, e.g. "0" or "G0" (from guardtour_list).') },
    },
    async (args): Promise<ToolResult> =>
      guard(async () => {
        const g = args.group.replace(/^G/i, '');
        const res = await vapix({ method: 'GET', path: '/axis-cgi/param.cgi', query: { action: 'remove', group: `GuardTour.G${g}` } });
        return jsonResult({ status: res.status, response: res.text().trim() });
      }),
  );

  server.registerTool(
    'guardtour_add_preset',
    {
      title: 'Add a preset position to a guard tour',
      description: 'Add a PTZ preset position (from ptz_query / presetposall) to a guard tour, defining its order, move speed, and dwell time.',
      inputSchema: {
        group: z.string().describe('Guard tour group number, e.g. "0" or "G0" (from guardtour_list).'),
        presetNbr: z.number().int().describe('Preset position number to visit.'),
        position: z.number().int().optional().describe('Order within the tour (lowest first, when not random). Default 1.'),
        moveSpeedPercent: z.number().int().min(1).max(100).optional().describe('Pan/tilt move speed. Default 70.'),
        waitTime: z.number().int().min(0).max(3600).optional().describe('Time to dwell at this preset. Default 10.'),
        waitTimeUnit: z.enum(['Seconds', 'Minutes']).optional(),
      },
    },
    async (args): Promise<ToolResult> =>
      guard(async () => {
        const g = args.group.replace(/^G/i, '');
        const query: Record<string, string> = {
          action: 'add',
          group: `GuardTour.G${g}.Tour`,
          template: 'tour',
          [`GuardTour.G${g}.Tour.T.PresetNbr`]: String(args.presetNbr),
        };
        if (args.position !== undefined) query[`GuardTour.G${g}.Tour.T.Position`] = String(args.position);
        if (args.moveSpeedPercent !== undefined) query[`GuardTour.G${g}.Tour.T.MoveSpeed`] = String(args.moveSpeedPercent);
        if (args.waitTime !== undefined) query[`GuardTour.G${g}.Tour.T.WaitTime`] = String(args.waitTime);
        if (args.waitTimeUnit !== undefined) query[`GuardTour.G${g}.Tour.T.WaitTimeViewType`] = args.waitTimeUnit;
        const res = await vapix({ method: 'GET', path: '/axis-cgi/param.cgi', query });
        const text = res.text().trim();
        const match = text.match(/^(T\d+)\s+OK/);
        return jsonResult({ status: res.status, tourEntry: match ? match[1] : undefined, response: text });
      }),
  );

  server.registerTool(
    'guardtour_remove_preset',
    {
      title: 'Remove a preset position from a guard tour',
      description: 'Remove one preset entry (T#, from guardtour_list) from a guard tour, leaving the rest of the tour intact.',
      inputSchema: {
        group: z.string().describe('Guard tour group number, e.g. "0" or "G0".'),
        tourEntry: z.string().describe('Tour entry number, e.g. "0" or "T0" (from guardtour_add_preset / guardtour_list).'),
      },
    },
    async (args): Promise<ToolResult> =>
      guard(async () => {
        const g = args.group.replace(/^G/i, '');
        const t = args.tourEntry.replace(/^T/i, '');
        const res = await vapix({ method: 'GET', path: '/axis-cgi/param.cgi', query: { action: 'remove', group: `GuardTour.G${g}.Tour.T${t}` } });
        return jsonResult({ status: res.status, response: res.text().trim() });
      }),
  );

  server.registerTool(
    'guardtour_set_running',
    {
      title: 'Start / stop a guard tour',
      description: 'Start or stop a preset guard tour.',
      inputSchema: {
        group: z.string().describe('Guard tour group number, e.g. "0" or "G0".'),
        running: z.boolean(),
      },
    },
    async (args): Promise<ToolResult> =>
      guard(async () => {
        const g = args.group.replace(/^G/i, '');
        const res = await vapix({
          method: 'GET',
          path: '/axis-cgi/param.cgi',
          query: { action: 'update', [`GuardTour.G${g}.Running`]: args.running ? 'yes' : 'no' },
        });
        return jsonResult({ status: res.status, response: res.text().trim() });
      }),
  );

  // ---- Recorded tour API (XML CGIs) ---------------------------------------

  function recordedTourResult(status: number, xml: string): ToolResult {
    if (status === 404) return errorResult('Recorded tour API not available on this model (404).');
    const err = xmlGeneralError(xml);
    if (err) return errorResult(`Recorded tour error ${err.code}: ${err.description}`);
    return jsonResult({ ok: true });
  }

  server.registerTool(
    'recordedtour_list',
    {
      title: 'List recorded tours',
      description: 'List every recorded PTZ tour (manually-steered movement recordings): ID, name, status (playing/recording/stopped), camera, and loop delay.',
      inputSchema: { camera: z.number().int().optional().describe('Limit to one video channel / view area.') },
    },
    async (args): Promise<ToolResult> =>
      guard(async () => {
        const res = await vapix({ method: 'POST', path: '/axis-cgi/recordedtour/list.cgi', query: { schemaversion: 1, camera: args.camera } });
        if (res.status === 404) return errorResult('Recorded tour API not available on this model (404).');
        const xml = res.text();
        const err = xmlGeneralError(xml);
        if (err) return errorResult(`Recorded tour error ${err.code}: ${err.description}`);
        return jsonResult({ tours: extractXmlBlocks(xml, 'RecordingInformation').map(parseFlatXml) });
      }),
  );

  server.registerTool(
    'recordedtour_record',
    {
      title: 'Start recording a PTZ tour',
      description: 'Start recording a new PTZ tour on a channel (any running guard tour on that channel stops). Steer the camera with your own PTZ commands while it records, then stop with recordedtour_stop_recording.',
      inputSchema: {
        camera: z.number().int().describe('Video channel / view area to record.'),
        niceName: z.string().optional().describe('Name for the recording (max 31 chars, a-z A-Z 0-9 . - _).'),
        recordedTourId: z.number().int().optional().describe('Explicit unique ID. Omit to auto-assign.'),
      },
    },
    async (args): Promise<ToolResult> =>
      guard(async () => {
        const res = await vapix({
          method: 'POST',
          path: '/axis-cgi/recordedtour/record.cgi',
          query: { schemaversion: 1, camera: args.camera, nicename: args.niceName, recordedtourid: args.recordedTourId },
        });
        if (res.status === 404) return errorResult('Recorded tour API not available on this model (404).');
        const xml = res.text();
        const err = xmlGeneralError(xml);
        if (err) return errorResult(`Recorded tour error ${err.code}: ${err.description}`);
        const block = extractXmlBlocks(xml, 'RecordSuccess')[0];
        return jsonResult(block ? parseFlatXml(block) : { ok: true });
      }),
  );

  server.registerTool(
    'recordedtour_stop_recording',
    {
      title: 'Stop recording a PTZ tour',
      description: 'Stop an ongoing tour recording. Omit recordedTourId to stop all ongoing recordings.',
      inputSchema: { recordedTourId: z.number().int().optional() },
    },
    async (args): Promise<ToolResult> =>
      guard(async () => {
        const res = await vapix({ method: 'POST', path: '/axis-cgi/recordedtour/stoprecording.cgi', query: { schemaversion: 1, recordedtourid: args.recordedTourId } });
        return recordedTourResult(res.status, res.text());
      }),
  );

  server.registerTool(
    'recordedtour_play',
    {
      title: 'Play a recorded PTZ tour',
      description: 'Play a recorded PTZ tour. Stops any other ongoing playback on that channel and lower-priority PTZ operations.',
      inputSchema: {
        recordedTourId: z.number().int(),
        loop: z.boolean().optional().describe('true = keep looping until stopped.'),
        loopDelaySeconds: z.number().int().min(0).max(9999).optional(),
      },
    },
    async (args): Promise<ToolResult> =>
      guard(async () => {
        const res = await vapix({
          method: 'POST',
          path: '/axis-cgi/recordedtour/play.cgi',
          query: {
            schemaversion: 1,
            recordedtourid: args.recordedTourId,
            loop: args.loop !== undefined ? (args.loop ? 1 : 0) : undefined,
            loopdelay: args.loopDelaySeconds,
          },
        });
        return recordedTourResult(res.status, res.text());
      }),
  );

  server.registerTool(
    'recordedtour_stop_playback',
    {
      title: 'Stop playing a recorded PTZ tour',
      description: 'Stop playback of a recorded tour. Omit recordedTourId to stop all ongoing playback.',
      inputSchema: { recordedTourId: z.number().int().optional() },
    },
    async (args): Promise<ToolResult> =>
      guard(async () => {
        const res = await vapix({ method: 'POST', path: '/axis-cgi/recordedtour/stopplayback.cgi', query: { schemaversion: 1, recordedtourid: args.recordedTourId } });
        return recordedTourResult(res.status, res.text());
      }),
  );
}

// ============================================================================
// PTZ Autotracker API — automatic tracking of moving objects
// ============================================================================

const AUTOTRACKER_PATH = '/axis-cgi/ptz-autotracking/admin.cgi';
const autotrackerHint = 'PTZ Autotracker API not available on this model (ptz-autotracking/admin.cgi returned 404).';

interface JsonRpcResponse {
  apiVersion?: string;
  context?: string;
  method?: string;
  data?: unknown;
  error?: { code: number; message: string };
}

function isJsonRpcResponse(x: unknown): x is JsonRpcResponse {
  return !!x && typeof x === 'object';
}

async function autotrackerCall(method: string, params?: Record<string, unknown>) {
  const res = await vapix({
    method: 'POST',
    path: AUTOTRACKER_PATH,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ apiVersion: '1', context: 'axis-mcp', method, params: params ?? {} }),
  });
  return { status: res.status, response: safeJson(res.text()) };
}

function autotrackerResult(status: number, response: unknown): ToolResult {
  if (status === 404) return errorResult(autotrackerHint);
  if (!isJsonRpcResponse(response)) return errorResult(`Unexpected response (HTTP ${status}).`);
  if (response.error) return errorResult(`PTZ Autotracker error ${response.error.code}: ${response.error.message}`);
  return jsonResult(response.data ?? {});
}

export function registerPtzAutotrackerTools(server: McpServer): void {
  server.registerTool(
    'autotracker_get_settings',
    {
      title: 'Get PTZ Autotracker settings',
      description:
        'Read the PTZ Autotracker application state in one call: whether the service is active and which detection ' +
        'APIs (AOA/radar) it can use (getApplicationSettings), plus general tracking settings — min object size, ' +
        'min lifespan, active tracker, timeout-to-home, zoom limits, etc. (getAutotrackingSettings) — and whether ' +
        'automatic zone triggering is on (getAutotrackingState, i.e. automatic vs. manual tracking mode).',
      inputSchema: {},
    },
    async (): Promise<ToolResult> =>
      guard(async () => {
        const [app, settings, state] = await Promise.all([
          autotrackerCall('getApplicationSettings'),
          autotrackerCall('getAutotrackingSettings'),
          autotrackerCall('getAutotrackingState'),
        ]);
        if (app.status === 404) return errorResult(autotrackerHint);
        const pick = (r: { response: unknown }) => (isJsonRpcResponse(r.response) && !r.response.error ? r.response.data : { error: (r.response as JsonRpcResponse)?.error });
        return jsonResult({
          applicationSettings: pick(app),
          autotrackingSettings: pick(settings),
          autotrackingState: pick(state),
        });
      }),
  );

  server.registerTool(
    'autotracker_get_target',
    {
      title: 'Get currently tracked object',
      description: 'Get the ID of the object currently being auto-tracked, or -1 if nothing is being tracked.',
      inputSchema: {},
    },
    async (): Promise<ToolResult> =>
      guard(async () => {
        const { status, response } = await autotrackerCall('getAutotrackingTarget');
        return autotrackerResult(status, response);
      }),
  );

  server.registerTool(
    'autotracker_set_target',
    {
      title: 'Start / stop tracking an object',
      description:
        'Manually start tracking a specific object ID visible in the current video stream (from an analytics/metadata ' +
        'source), or pass -1 to stop tracking. Only meaningful in manual mode (see autotracker_set_state).',
      inputSchema: { targetId: z.number().int().describe('Object ID to track, or -1 to stop.') },
    },
    async (args): Promise<ToolResult> =>
      guard(async () => {
        const { status, response } = await autotrackerCall('setAutotrackingTarget', { targetId: args.targetId });
        return autotrackerResult(status, response);
      }),
  );

  server.registerTool(
    'autotracker_set_state',
    {
      title: 'Set PTZ Autotracker automatic/manual mode',
      description:
        'Enable (automatic mode: the first object entering a configured zone auto-triggers tracking) or disable ' +
        '(manual mode: an external client must call autotracker_set_target) automatic zone-triggered tracking.',
      inputSchema: { enabled: z.boolean() },
    },
    async (args): Promise<ToolResult> =>
      guard(async () => {
        const { status, response } = await autotrackerCall('setAutotrackingState', { enabled: args.enabled });
        return autotrackerResult(status, response);
      }),
  );
}

// ============================================================================
// PTZ Orientation Aid API — compass overlay for directional reporting
// ============================================================================

const ORIENTATIONAID_PATH = '/axis-cgi/ptz-orientationaid.cgi';
const orientationAidHint = 'PTZ Orientation Aid API not available on this model (ptz-orientationaid.cgi returned 404).';

async function orientationAidCall(method: string, params?: Record<string, unknown>) {
  const res = await vapix({
    method: 'POST',
    path: ORIENTATIONAID_PATH,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ apiVersion: '2.0', context: 'axis-mcp', method, ...(params ? { params } : {}) }),
  });
  return { status: res.status, response: safeJson(res.text()) };
}

function orientationAidResult(status: number, response: unknown): ToolResult {
  if (status === 404) return errorResult(orientationAidHint);
  if (!isJsonRpcResponse(response)) return errorResult(`Unexpected response (HTTP ${status}).`);
  if (response.error) return errorResult(`PTZ Orientation Aid error ${response.error.code}: ${response.error.message}`);
  return jsonResult(response.data ?? {});
}

export function registerPtzOrientationAidTools(server: McpServer): void {
  server.registerTool(
    'orientationaid_set_north',
    {
      title: 'Set compass north',
      description: 'Mark the direction the camera is currently pointing as north for the compass overlay. Re-run whenever the camera position changes.',
      inputSchema: {},
    },
    async (): Promise<ToolResult> =>
      guard(async () => {
        const { status, response } = await orientationAidCall('setNorth');
        return orientationAidResult(status, response);
      }),
  );

  server.registerTool(
    'orientationaid_get_compass_state',
    {
      title: 'Get compass overlay state',
      description: 'Check whether the compass overlay is currently enabled.',
      inputSchema: {},
    },
    async (): Promise<ToolResult> =>
      guard(async () => {
        const { status, response } = await orientationAidCall('getCompassState');
        return orientationAidResult(status, response);
      }),
  );

  server.registerTool(
    'orientationaid_set_compass_state',
    {
      title: 'Enable / disable compass overlay',
      description: 'Enable or disable the compass overlay on the video.',
      inputSchema: { enabled: z.boolean() },
    },
    async (args): Promise<ToolResult> =>
      guard(async () => {
        const { status, response } = await orientationAidCall('setCompassState', { enabled: args.enabled });
        return orientationAidResult(status, response);
      }),
  );

  server.registerTool(
    'orientationaid_list_tags',
    {
      title: 'List PTZ preset tags',
      description: 'List every available preset-position tag and whether it is currently shown in the device web interface.',
      inputSchema: {},
    },
    async (): Promise<ToolResult> =>
      guard(async () => {
        const { status, response } = await orientationAidCall('listTags');
        return orientationAidResult(status, response);
      }),
  );

  server.registerTool(
    'orientationaid_set_tag_state',
    {
      title: 'Show / hide preset position tags',
      description: 'Set which preset-position tags (from orientationaid_list_tags) are displayed in the device web interface.',
      inputSchema: {
        tags: z
          .array(z.object({ id: z.string(), display: z.boolean() }))
          .describe('List of {id, display} pairs, ids from orientationaid_list_tags.'),
      },
    },
    async (args): Promise<ToolResult> =>
      guard(async () => {
        const { status, response } = await orientationAidCall('setTagState', { tagList: args.tags });
        return orientationAidResult(status, response);
      }),
  );
}
