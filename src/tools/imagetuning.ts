// Camera/image tuning tools: eight VAPIX APIs bundled in one module since each
// is small on its own. Two request styles are involved:
//   - Google-JSON-style POST APIs (DayNight, Light control, Image
//     stabilization, Capture mode) — {apiVersion, context, method, params} ->
//     {..., data} / {..., error}.
//   - Legacy param.cgi / XML GET APIs (Image source rotation, Orientation,
//     Rate control, Dewarped views) — the same param.cgi list/update pattern
//     already used by imaging.ts, plus one small XML CGI for Orientation.
//
// See:
//   https://developer.axis.com/vapix/network-video/daynight-api/
//   https://developer.axis.com/vapix/network-video/light-control/
//   https://developer.axis.com/vapix/network-video/image-stabilization-api/
//   https://developer.axis.com/vapix/network-video/image-source-rotation/
//   https://developer.axis.com/vapix/network-video/orientation-api/
//   https://developer.axis.com/vapix/network-video/rate-control/
//   https://developer.axis.com/vapix/network-video/capture-mode/
//   https://developer.axis.com/vapix/network-video/dewarped-views/
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

// ---- Shared Google-JSON-style helper (DayNight / Light control / Image ------
// stabilization / Capture mode all follow {apiVersion, context, method,
// params} -> {data} / {error}, just against different CGI paths).

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

async function jsonRpcCall(
  path: string,
  method: string,
  params?: Record<string, unknown>,
  extraTopLevel?: Record<string, unknown>,
): Promise<{ status: number; response: unknown }> {
  const res = await vapix({
    method: 'POST',
    path,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      apiVersion: '1.0',
      context: 'axis-mcp',
      method,
      ...(params ? { params } : {}),
      ...(extraTopLevel ?? {}),
    }),
  });
  return { status: res.status, response: safeJson(res.text()) };
}

function jsonRpcResult(status: number, response: unknown, notInstalledHint: string): ToolResult {
  if (status === 404) return errorResult(notInstalledHint);
  if (!isJsonRpcResponse(response)) return errorResult(`Unexpected response (HTTP ${status}).`);
  if (response.error) return errorResult(`API error ${response.error.code}: ${response.error.message}`);
  return jsonResult(response.data ?? {});
}

/** Best-effort call that swallows "method not supported" style errors, returning undefined instead. */
async function tryJsonRpcCall(path: string, method: string, params?: Record<string, unknown>): Promise<unknown> {
  try {
    const { response } = await jsonRpcCall(path, method, params);
    if (isJsonRpcResponse(response) && !response.error) return response.data;
    return undefined;
  } catch {
    return undefined;
  }
}

export function registerImageTuningTools(server: McpServer): void {
  // ---- DayNight API --------------------------------------------------------
  const DAYNIGHT_PATH = '/axis-cgi/daynight.cgi';
  const daynightHint = 'DayNight API not available on this model (daynight.cgi returned 404).';

  server.registerTool(
    'daynight_get_capabilities',
    {
      title: 'Get DayNight capabilities',
      description: 'Get day/night switching capabilities for a channel: autotune support, IR-pass filter support, and night-to-day shift level support.',
      inputSchema: { channel: z.number().int().default(0) },
    },
    async (args): Promise<ToolResult> =>
      guard(async () => {
        const { status, response } = await jsonRpcCall(DAYNIGHT_PATH, 'getCapabilities', { channel: args.channel }, { apiVersion: '1.2' });
        return jsonRpcResult(status, response, daynightHint);
      }),
  );

  server.registerTool(
    'daynight_get_configuration',
    {
      title: 'Get DayNight configuration',
      description: 'Get the current day/night switching configuration for a channel: shift levels, dwell times, autotune, and IR-cut night filter (clear glass vs IR-pass).',
      inputSchema: { channel: z.number().int().default(0) },
    },
    async (args): Promise<ToolResult> =>
      guard(async () => {
        const { status, response } = await jsonRpcCall(DAYNIGHT_PATH, 'getConfiguration', { channel: args.channel }, { apiVersion: '1.2' });
        return jsonRpcResult(status, response, daynightHint);
      }),
  );

  server.registerTool(
    'daynight_set_configuration',
    {
      title: 'Set DayNight configuration',
      description:
        'Set day/night switching parameters for a channel. Only supplied fields are changed. Raising ' +
        'dayNightShiftLevel switches to night mode when it is darker; raising nightDayShiftLevel (only when ' +
        'autotune is false) switches back to day when it is darker — set too high and day/night can oscillate.',
      inputSchema: {
        channel: z.number().int().default(0),
        dayNightShiftLevel: z.number().int().min(0).max(100).optional(),
        dayNightDwellTime: z.number().min(1).max(600).optional().describe('Seconds to wait before switching day->night.'),
        nightDayShiftLevel: z.number().int().optional().describe('Only settable if autotune is false and the device supports it.'),
        nightDayDwellTime: z.number().min(1).max(600).optional().describe('Seconds to wait before switching night->day.'),
        autotune: z.boolean().optional().describe('true = let the device auto-tune the night->day threshold.'),
        nightFilter: z.enum(['clear', 'irpass']).optional().describe('Only settable if the device has an IR-pass filter.'),
      },
    },
    async (args): Promise<ToolResult> =>
      guard(async () => {
        const params: Record<string, unknown> = { channel: args.channel };
        if (args.dayNightShiftLevel !== undefined) params.DayNightShiftLevel = args.dayNightShiftLevel;
        if (args.dayNightDwellTime !== undefined) params.DayNightDwellTime = args.dayNightDwellTime;
        if (args.nightDayShiftLevel !== undefined) params.NightDayShiftLevel = args.nightDayShiftLevel;
        if (args.nightDayDwellTime !== undefined) params.NightDayDwellTime = args.nightDayDwellTime;
        if (args.autotune !== undefined) params.Autotune = args.autotune;
        if (args.nightFilter !== undefined) params.NightFilter = args.nightFilter;
        const { status, response } = await jsonRpcCall(DAYNIGHT_PATH, 'setConfiguration', params, { apiVersion: '1.2' });
        return jsonRpcResult(status, response, daynightHint);
      }),
  );

  // ---- Light control API ---------------------------------------------------
  const LIGHT_PATH = '/axis-cgi/lightcontrol.cgi';
  const lightHint = 'Light control API not available on this model (lightcontrol.cgi returned 404).';

  server.registerTool(
    'light_get_information',
    {
      title: 'Get light information',
      description: 'List the IR/white light LEDs on this device (getLightInformation) — light IDs, enabled state, type, and other properties.',
      inputSchema: {},
    },
    async (): Promise<ToolResult> =>
      guard(async () => {
        const { status, response } = await jsonRpcCall(LIGHT_PATH, 'getLightInformation', {});
        return jsonRpcResult(status, response, lightHint);
      }),
  );

  server.registerTool(
    'light_get_status',
    {
      title: 'Get light status',
      description: 'Get whether a specific light (by lightID, from light_get_information) is currently on or off.',
      inputSchema: { lightID: z.string().describe('e.g. "led0" (from light_get_information).') },
    },
    async (args): Promise<ToolResult> =>
      guard(async () => {
        const { status, response } = await jsonRpcCall(LIGHT_PATH, 'getLightStatus', { lightID: args.lightID });
        return jsonRpcResult(status, response, lightHint);
      }),
  );

  server.registerTool(
    'light_set_active',
    {
      title: 'Activate / deactivate light',
      description: 'Turn a light on (activateLight) or off (deactivateLight). The light must also be enabled (see light_get_information) to take effect.',
      inputSchema: {
        lightID: z.string().describe('e.g. "led0" (from light_get_information).'),
        active: z.boolean().describe('true to activate, false to deactivate.'),
      },
    },
    async (args): Promise<ToolResult> =>
      guard(async () => {
        const { status, response } = await jsonRpcCall(LIGHT_PATH, args.active ? 'activateLight' : 'deactivateLight', { lightID: args.lightID });
        return jsonRpcResult(status, response, lightHint);
      }),
  );

  server.registerTool(
    'light_set_intensity',
    {
      title: 'Set manual light intensity',
      description: 'Manually set the intensity (0-100) of a light. Use light_get_information / getValidIntensity range first — invalid values are rejected.',
      inputSchema: {
        lightID: z.string().describe('e.g. "led0" (from light_get_information).'),
        intensity: z.number().min(0).max(100),
      },
    },
    async (args): Promise<ToolResult> =>
      guard(async () => {
        const { status, response } = await jsonRpcCall(LIGHT_PATH, 'setManualIntensity', { lightID: args.lightID, intensity: args.intensity });
        return jsonRpcResult(status, response, lightHint);
      }),
  );

  server.registerTool(
    'light_get_current_intensity',
    {
      title: 'Get current light intensity',
      description: 'Get the currently applied light intensity for a light (getCurrentIntensity) — reflects automatic or manual control.',
      inputSchema: { lightID: z.string().describe('e.g. "led0" (from light_get_information).') },
    },
    async (args): Promise<ToolResult> =>
      guard(async () => {
        const { status, response } = await jsonRpcCall(LIGHT_PATH, 'getCurrentIntensity', { lightID: args.lightID });
        return jsonRpcResult(status, response, lightHint);
      }),
  );

  // ---- Image stabilization API ---------------------------------------------
  // Endpoint inferred from VAPIX's naming convention (API discovery id
  // "image-stabilization" -> imagestabilization.cgi, matching
  // daynight/lightcontrol/capturemode); the docs page for this API omits an
  // explicit curl/endpoint example.
  const STAB_PATH = '/axis-cgi/imagestabilization.cgi';
  const stabHint = 'Image stabilization API not available on this model (imagestabilization.cgi returned 404).';

  server.registerTool(
    'imagestab_get_capabilities',
    {
      title: 'Get image stabilization capabilities',
      description: 'Get EIS/OIS support and manual-focal-length range for a camera image channel.',
      inputSchema: {},
    },
    async (): Promise<ToolResult> =>
      guard(async () => {
        const { status, response } = await jsonRpcCall(STAB_PATH, 'getCapabilities', {});
        return jsonRpcResult(status, response, stabHint);
      }),
  );

  server.registerTool(
    'imagestab_get_configuration',
    {
      title: 'Get image stabilization configuration',
      description:
        'Read the full current image stabilization configuration for a channel — merges enabled state, type ' +
        '(EIS/OIS), EIS margin, EIS focal length and EIS demo mode into one call (fields the device does not ' +
        'support, e.g. no EIS, are simply omitted).',
      inputSchema: { id: z.number().int().default(0).describe('Camera image channel ID.') },
    },
    async (args): Promise<ToolResult> =>
      guard(async () => {
        const params = { id: args.id };
        const [enabled, type, margin, focalLength, demo] = await Promise.all([
          tryJsonRpcCall(STAB_PATH, 'getEnabled', params),
          tryJsonRpcCall(STAB_PATH, 'getType', params),
          tryJsonRpcCall(STAB_PATH, 'getEISMargin', params),
          tryJsonRpcCall(STAB_PATH, 'getEISFocalLength', params),
          tryJsonRpcCall(STAB_PATH, 'getEISDemo', params),
        ]);
        const out: Record<string, unknown> = { id: args.id };
        if (enabled && typeof enabled === 'object') Object.assign(out, enabled);
        if (type && typeof type === 'object') Object.assign(out, type);
        if (margin && typeof margin === 'object') Object.assign(out, margin);
        if (focalLength && typeof focalLength === 'object') Object.assign(out, focalLength);
        if (demo && typeof demo === 'object') Object.assign(out, demo);
        if (Object.keys(out).length === 1) return errorResult(stabHint);
        return jsonResult(out);
      }),
  );

  server.registerTool(
    'imagestab_set_configuration',
    {
      title: 'Set image stabilization configuration',
      description:
        'Change image stabilization settings for a channel. Only supplied fields are changed, each via its own ' +
        'VAPIX call (setEnabled/setType/setEISMargin/setEISFocalLength/setEISDemo); per-field results are reported ' +
        'so a "method not supported" on one field (e.g. EIS margin on an OIS-only device) does not block the rest.',
      inputSchema: {
        id: z.number().int().default(0).describe('Camera image channel ID.'),
        enabled: z.boolean().optional(),
        type: z.enum(['EIS', 'OIS']).optional(),
        margin: z.number().int().min(0).max(9999).optional().describe('EIS margin.'),
        focalLength: z.number().int().optional().describe('Manual EIS focal length, within the device-reported min/max range.'),
        demo: z.boolean().optional().describe('EIS demo/split-screen mode.'),
      },
    },
    async (args): Promise<ToolResult> =>
      guard(async () => {
        const results: Record<string, unknown> = {};
        const ops: Array<[string, string, Record<string, unknown>]> = [];
        if (args.enabled !== undefined) ops.push(['enabled', 'setEnabled', { id: args.id, enabled: args.enabled }]);
        if (args.type !== undefined) ops.push(['type', 'setType', { id: args.id, type: args.type }]);
        if (args.margin !== undefined) ops.push(['margin', 'setEISMargin', { id: args.id, margin: args.margin }]);
        if (args.focalLength !== undefined) ops.push(['focalLength', 'setEISFocalLength', { id: args.id, focalLength: args.focalLength }]);
        if (args.demo !== undefined) ops.push(['demo', 'setEISDemo', { id: args.id, demo: args.demo }]);
        if (ops.length === 0) return errorResult('Provide at least one of: enabled, type, margin, focalLength, demo.');
        for (const [key, method, params] of ops) {
          const { status, response } = await jsonRpcCall(STAB_PATH, method, params);
          if (status === 404) return errorResult(stabHint);
          results[key] = isJsonRpcResponse(response) && response.error
            ? { error: response.error }
            : { ok: true, data: isJsonRpcResponse(response) ? response.data : response };
        }
        return jsonResult(results);
      }),
  );

  // ---- Image source rotation (param.cgi addendum) --------------------------

  server.registerTool(
    'imagerotation_get',
    {
      title: 'Get image source rotation',
      description: 'Read whether this device supports image source rotation, its current rotation (0/90/180/270), and whether auto-rotation is enabled, for one image source.',
      inputSchema: { channel: z.number().int().default(0) },
    },
    async (args): Promise<ToolResult> =>
      guard(async () => {
        const res = await vapix({ method: 'GET', path: '/axis-cgi/param.cgi', query: { action: 'list', group: `ImageSource.I${args.channel}` } });
        return jsonResult(parseParamResponse(res.text()));
      }),
  );

  server.registerTool(
    'imagerotation_set',
    {
      title: 'Set image source rotation',
      description: 'Set the rotation (0/90/180/270, from Properties.Image.Rotation) and/or auto-rotation flag for an image source. Changing rotation closes all open streams on that source, which must then be reacquired.',
      inputSchema: {
        channel: z.number().int().default(0),
        rotation: z.union([z.literal(0), z.literal(90), z.literal(180), z.literal(270)]).optional(),
        autoRotationEnabled: z.boolean().optional(),
      },
    },
    async (args): Promise<ToolResult> =>
      guard(async () => {
        if (args.rotation === undefined && args.autoRotationEnabled === undefined) {
          return errorResult('Provide rotation and/or autoRotationEnabled.');
        }
        const query: Record<string, string> = { action: 'update' };
        if (args.rotation !== undefined) query[`ImageSource.I${args.channel}.Rotation`] = String(args.rotation);
        if (args.autoRotationEnabled !== undefined) query[`ImageSource.I${args.channel}.AutoRotationEnabled`] = args.autoRotationEnabled ? 'yes' : 'no';
        const res = await vapix({ method: 'GET', path: '/axis-cgi/param.cgi', query });
        return jsonResult({ status: res.status, response: res.text().trim() });
      }),
  );

  // ---- Orientation API (gyroscope/accelerometer, XML) ----------------------

  server.registerTool(
    'orientation_get',
    {
      title: 'Get lens orientation',
      description:
        'Read the camera lens orientation from its built-in gyroscope/accelerometer: longitudinal angle (0-359°, ' +
        'rotation around the lens axis) and lateral angle (0-180°, 0° = pointing straight down, 180° = straight up). ' +
        'Only available on models with orientation sensors.',
      inputSchema: {},
    },
    async (): Promise<ToolResult> =>
      guard(async () => {
        const [lonRes, latRes] = await Promise.all([
          vapix({ method: 'GET', path: '/axis-cgi/orientation/getlongitudinalvalue.cgi', query: { schemaversion: 1 } }),
          vapix({ method: 'GET', path: '/axis-cgi/orientation/getlateralvalue.cgi', query: { schemaversion: 1 } }),
        ]);
        if (lonRes.status === 404 || latRes.status === 404) {
          return errorResult('Orientation API not available on this model (404) — requires a built-in orientation sensor.');
        }
        const lonErr = xmlGeneralError(lonRes.text());
        const latErr = xmlGeneralError(latRes.text());
        if (lonErr || latErr) {
          return errorResult(`Orientation API error: ${lonErr?.description ?? ''} ${latErr?.description ?? ''}`.trim());
        }
        const lonBlock = extractXmlBlocks(lonRes.text(), 'LongitudinalValue')[0];
        const latBlock = extractXmlBlocks(latRes.text(), 'LateralValue')[0];
        return jsonResult({
          longitudinalDegrees: lonBlock ? Number(parseFlatXml(lonBlock).Value) : undefined,
          lateralDegrees: latBlock ? Number(parseFlatXml(latBlock).Value) : undefined,
        });
      }),
  );

  // ---- Rate control (param.cgi) --------------------------------------------

  server.registerTool(
    'ratecontrol_get',
    {
      title: 'Get rate control settings',
      description: 'Read the default rate control settings (mode: vbr/mbr/abr, plus MBR/ABR parameters) for an image view.',
      inputSchema: { view: z.number().int().default(0) },
    },
    async (args): Promise<ToolResult> =>
      guard(async () => {
        const res = await vapix({ method: 'GET', path: '/axis-cgi/param.cgi', query: { action: 'list', group: `Image.I${args.view}.RateControl` } });
        return jsonResult(parseParamResponse(res.text()));
      }),
  );

  server.registerTool(
    'ratecontrol_set',
    {
      title: 'Set rate control settings',
      description:
        'Set default rate control parameters for an image view. mode selects vbr (guarantee quality, unpredictable ' +
        'bitrate), mbr (cap instantaneous bitrate), or abr (target an average bitrate over a retention period, ' +
        'best for fixed storage budgets). Only supplied fields are changed.',
      inputSchema: {
        view: z.number().int().default(0),
        mode: z.enum(['vbr', 'mbr', 'abr']).optional(),
        priority: z.enum(['none', 'quality', 'framerate', 'fullframerate']).optional().describe('MBR only.'),
        maxBitrateKbit: z.number().int().min(0).optional().describe('MBR: max bitrate in kbit/s.'),
        abrTargetBitrateKbit: z.number().int().min(0).optional().describe('ABR: target average bitrate in kbit/s.'),
        abrMaxBitrateKbit: z.number().int().min(0).optional().describe('ABR: max instantaneous bitrate in kbit/s.'),
        abrRetentionDays: z.number().int().min(1).max(3652).optional().describe('ABR: desired retention period in days.'),
      },
    },
    async (args): Promise<ToolResult> =>
      guard(async () => {
        const query: Record<string, string> = { action: 'update' };
        const prefix = `Image.I${args.view}.RateControl`;
        if (args.mode !== undefined) query[`${prefix}.Mode`] = args.mode;
        if (args.priority !== undefined) query[`${prefix}.Priority`] = args.priority;
        if (args.maxBitrateKbit !== undefined) query[`${prefix}.MaxBitrate`] = String(args.maxBitrateKbit);
        if (args.abrTargetBitrateKbit !== undefined) query[`${prefix}.ABR.TargetBitrate`] = String(args.abrTargetBitrateKbit);
        if (args.abrMaxBitrateKbit !== undefined) query[`${prefix}.ABR.MaxBitrate`] = String(args.abrMaxBitrateKbit);
        if (args.abrRetentionDays !== undefined) query[`${prefix}.ABR.RetentionTime`] = String(args.abrRetentionDays);
        if (Object.keys(query).length === 1) return errorResult('Provide at least one setting to change.');
        const res = await vapix({ method: 'GET', path: '/axis-cgi/param.cgi', query });
        return jsonResult({ status: res.status, response: res.text().trim() });
      }),
  );

  // ---- Capture mode ---------------------------------------------------------
  const CAPTUREMODE_PATH = '/axis-cgi/capturemode.cgi';
  const captureModeHint = 'Capture mode API not available on this model (capturemode.cgi returned 404).';

  server.registerTool(
    'capturemode_get_modes',
    {
      title: 'Get capture modes',
      description: 'List the current and available sensor capture modes (resolution/FPS combinations) for each channel.',
      inputSchema: {},
    },
    async (): Promise<ToolResult> =>
      guard(async () => {
        const { status, response } = await jsonRpcCall(CAPTUREMODE_PATH, 'getCaptureModes', {});
        return jsonRpcResult(status, response, captureModeHint);
      }),
  );

  server.registerTool(
    'capturemode_set_mode',
    {
      title: 'Set capture mode',
      description: 'Switch a channel to a different capture mode (captureModeId, from capturemode_get_modes). Takes effect after a reboot.',
      inputSchema: {
        channel: z.number().int().describe('Channel index (from capturemode_get_modes).'),
        captureModeId: z.number().int().describe('Target capture mode ID.'),
      },
    },
    async (args): Promise<ToolResult> =>
      guard(async () => {
        // Note: unlike the other Capture mode method, setCaptureMode's channel/captureModeId
        // are top-level request fields, not nested under "params" (per Axis's own docs).
        const { status, response } = await jsonRpcCall(CAPTUREMODE_PATH, 'setCaptureMode', undefined, {
          channel: args.channel,
          captureModeId: args.captureModeId,
        });
        return jsonRpcResult(status, response, captureModeHint);
      }),
  );

  // ---- Dewarped views (360°/180° cameras, param.cgi) ------------------------

  server.registerTool(
    'dewarp_get_view_modes',
    {
      title: 'Get dewarped view modes',
      description:
        'For 360°/180° cameras (e.g. AXIS M3007-PV): whether dewarping is supported, the current mounting ' +
        'orientation (ceiling/wall/desk), and every view mode (Overview, Panorama, Quad View, View Area 1-4, ...) ' +
        'with its name and enabled state. To stream a view mode, request camera=<view mode index + 1> with a ' +
        'resolution from Properties.Image.I<index>.Resolution.',
      inputSchema: {},
    },
    async (): Promise<ToolResult> =>
      guard(async () => {
        const res = await vapix({
          method: 'GET',
          path: '/axis-cgi/param.cgi',
          query: { action: 'list', group: 'Properties.Image.Dewarp,ImageSource.I0.CameraTiltOrientation,Properties.Image.NbrOfViews,Image.*.Name,Image.*.Enabled' },
        });
        const parsed = parseParamResponse(res.text());
        if (parsed['root.Properties.Image.Dewarp'] === undefined) {
          return errorResult('This device does not report Properties.Image.Dewarp — dewarped views are likely not supported on this model.');
        }
        return jsonResult(parsed);
      }),
  );

  server.registerTool(
    'dewarp_set_camera_orientation',
    {
      title: 'Set dewarp camera mounting orientation',
      description:
        'Set the mounting orientation used by dewarping and PTZ on a 360°/180° camera: -90 = ceiling, 0 = wall, ' +
        '90 = desk. Some dewarped view modes (e.g. Double Panorama, Quad View) are unavailable when mounted on a wall.',
      inputSchema: { orientation: z.union([z.literal(-90), z.literal(0), z.literal(90)]) },
    },
    async (args): Promise<ToolResult> =>
      guard(async () => {
        const res = await vapix({
          method: 'GET',
          path: '/axis-cgi/param.cgi',
          query: { action: 'update', 'ImageSource.I0.CameraTiltOrientation': args.orientation },
        });
        return jsonResult({ status: res.status, response: res.text().trim() });
      }),
  );
}
