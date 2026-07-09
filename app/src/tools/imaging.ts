// Imaging & optics tools. Q1656 is a fixed box camera (no pan/tilt); zoom/focus
// are optics-controlled where supported.
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { vapix } from '../vapix';
import { guard, jsonResult, errorResult, parseParamResponse, safeJson, ToolResult } from './util';

// ---- Optics / autofocus helpers -------------------------------------------
// Caches (module singletons — persist across MCP requests in this process):
//   cachedOpticsId  — the optics id discovered via getOptics
//   cachedAfMethod  — the autofocus method that last worked, tried first next time
let cachedOpticsId: string | null = null;
let cachedAfMethod: string | null = null;

async function opticsControl(method: string, params?: Record<string, unknown>) {
  const body: Record<string, unknown> = { apiVersion: '1.0', method };
  if (params) body.params = params;
  return vapix({
    method: 'POST',
    path: '/axis-cgi/opticscontrol.cgi',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/** Discover the first optics id via getOptics (cached). Falls back to "1". */
async function discoverOpticsId(force = false): Promise<string> {
  if (cachedOpticsId && !force) return cachedOpticsId;
  try {
    const res = await opticsControl('getOptics');
    if (res.status === 200) {
      const j = safeJson(res.text()) as { data?: { optics?: any[] }; optics?: any[] };
      const list = j?.data?.optics ?? j?.optics;
      if (Array.isArray(list) && list.length) {
        const first = list[0] || {};
        cachedOpticsId = String(first.id ?? first.opticsId ?? first.optics ?? '1');
        return cachedOpticsId;
      }
    }
  } catch {
    /* ignore — fall through to default */
  }
  return cachedOpticsId ?? '1';
}

interface AfOutcome {
  ok: boolean;
  status: number;
  detail: unknown;
}

/** Ordered autofocus methods (confirmed-working first), each returns an outcome. */
function autofocusAttempts(id: string): Array<{ name: string; run: () => Promise<AfOutcome> }> {
  const jsonOk = (res: { status: number; text(): string }): AfOutcome => {
    const j = safeJson(res.text());
    const err = j && typeof j === 'object' && 'error' in (j as object);
    return { ok: res.status === 200 && !err, status: res.status, detail: j };
  };
  const cgiOk = (res: { status: number; text(): string }): AfOutcome => {
    const body = res.text();
    return { ok: res.status === 200 && !/error/i.test(body), status: res.status, detail: body.slice(0, 200) };
  };
  return [
    // 1. Modern Optics Control JSON API — the confirmed working call.
    { name: 'performAutofocus', run: async () => jsonOk(await opticsControl('performAutofocus', { optics: [id] })) },
    // 2. Alternative JSON method on the same API.
    { name: 'startFocusSearch', run: async () => jsonOk(await opticsControl('startFocusSearch', { optics: [id] })) },
    // 3. Legacy optics setup CGI (older firmware).
    {
      name: 'opticssetup.cgi',
      run: async () => cgiOk(await vapix({ method: 'GET', path: '/axis-cgi/opticssetup.cgi', query: { autofocus: 'perform' } })),
    },
    // 4. Legacy PTZ driver autofocus flag.
    {
      name: 'ptz.cgi',
      run: async () => cgiOk(await vapix({ method: 'GET', path: '/axis-cgi/com/ptz.cgi', query: { autofocus: 'on' } })),
    },
  ];
}

interface AfResult {
  ok: boolean;
  method?: string;
  optics: string;
  detail?: unknown;
  tried: Array<{ method: string; status?: number; ok?: boolean; error?: string }>;
}

/** Run autofocus, cascading through methods and caching the one that works. */
async function runAutofocus(optics?: string): Promise<AfResult> {
  const id = optics ?? (await discoverOpticsId());
  let attempts = autofocusAttempts(id);
  // Try the previously-successful method first.
  if (cachedAfMethod) {
    attempts = [
      ...attempts.filter((a) => a.name === cachedAfMethod),
      ...attempts.filter((a) => a.name !== cachedAfMethod),
    ];
  }
  const tried: AfResult['tried'] = [];
  for (const a of attempts) {
    try {
      const r = await a.run();
      tried.push({ method: a.name, status: r.status, ok: r.ok });
      if (r.ok) {
        cachedAfMethod = a.name;
        return { ok: true, method: a.name, optics: id, detail: r.detail, tried };
      }
    } catch (e) {
      tried.push({ method: a.name, error: (e as Error).message });
    }
  }
  cachedAfMethod = null; // reset so the next call re-cascades from the top
  return { ok: false, optics: id, tried };
}

// ---- Tool registration -----------------------------------------------------

export function registerImagingTools(server: McpServer): void {
  server.registerTool(
    'take_snapshot',
    {
      title: 'Take snapshot',
      description:
        'Capture a JPEG snapshot from the camera and return it as image content. Optional resolution (e.g. "1920x1080"), camera/source index, compression and rotation.',
      inputSchema: {
        resolution: z.string().optional().describe('WxH, e.g. 1920x1080. Omit for camera default.'),
        camera: z.union([z.number(), z.string()]).optional().describe('Video source / channel index.'),
        compression: z.number().min(0).max(100).optional().describe('JPEG compression 0-100.'),
        rotation: z.union([z.literal(0), z.literal(90), z.literal(180), z.literal(270)]).optional().describe('Rotate the image by this many degrees.'),
      },
    },
    async (args): Promise<ToolResult> =>
      guard(async () => {
        const res = await vapix({
          method: 'GET',
          path: '/axis-cgi/jpg/image.cgi',
          query: {
            resolution: args.resolution,
            camera: args.camera !== undefined ? String(args.camera) : undefined,
            compression: args.compression,
            rotation: args.rotation,
          },
        });
        if (res.status !== 200) {
          return errorResult(`Snapshot failed: HTTP ${res.status} ${res.text().slice(0, 200)}`);
        }
        return {
          content: [{ type: 'image', data: res.body.toString('base64'), mimeType: 'image/jpeg' }],
        };
      }),
  );

  server.registerTool(
    'get_image_settings',
    {
      title: 'Get image settings',
      description: 'Return ImageSource / Image appearance parameters via param.cgi.',
      inputSchema: {},
    },
    async () =>
      guard(async () => {
        const res = await vapix({
          method: 'GET',
          path: '/axis-cgi/param.cgi',
          query: { action: 'list', group: 'ImageSource,Image' },
        });
        return jsonResult(parseParamResponse(res.text()));
      }),
  );

  server.registerTool(
    'set_image_settings',
    {
      title: 'Set image settings',
      description:
        'Set one or more Image appearance parameters (e.g. Image.I0.Appearance.Brightness). Pass a map of full param names to values. Only Image* / ImageSource* groups are permitted.',
      inputSchema: {
        params: z.record(z.string(), z.string()).describe('Map of param name -> value.'),
      },
    },
    async (args): Promise<ToolResult> =>
      guard(async () => {
        const entries = Object.entries(args.params);
        if (entries.length === 0) return errorResult('No params supplied.');
        for (const [k] of entries) {
          if (!/^(Image|ImageSource)\b/.test(k) && !/^(Image|ImageSource)\./.test(k)) {
            return errorResult(`Refusing to set '${k}': only Image / ImageSource params are allowed.`);
          }
        }
        const query: Record<string, string> = { action: 'update' };
        for (const [k, v] of entries) query[k] = v;
        const res = await vapix({ method: 'GET', path: '/axis-cgi/param.cgi', query });
        return jsonResult({ status: res.status, response: res.text().trim() });
      }),
  );

  server.registerTool(
    'get_optics',
    {
      title: 'Get optics info',
      description:
        'Discover the camera optics via the Optics Control API (getOptics): optics ids and capabilities (zoom/focus/autofocus). Also refreshes the cached optics id used by autofocus.',
      inputSchema: {},
    },
    async (): Promise<ToolResult> =>
      guard(async () => {
        const res = await opticsControl('getOptics');
        if (res.status === 404) {
          return errorResult('Optics Control API (opticscontrol.cgi) not available on this model.');
        }
        const data = safeJson(res.text());
        await discoverOpticsId(true); // refresh cache from this response
        return jsonResult({ status: res.status, cachedOpticsId, data });
      }),
  );

  server.registerTool(
    'autofocus',
    {
      title: 'Autofocus',
      description:
        'Run autofocus. Tries, in order: Optics Control JSON performAutofocus (with getOptics id discovery), then startFocusSearch, then legacy opticssetup.cgi, then ptz.cgi?autofocus=on. Caches the method that works so later calls use it first. Reports every method attempted.',
      inputSchema: {
        optics: z.string().optional().describe('Optics id. Omit to auto-discover via getOptics.'),
      },
    },
    async (args): Promise<ToolResult> =>
      guard(async () => {
        const r = await runAutofocus(args.optics);
        if (r.ok) {
          return jsonResult({ ok: true, method: r.method, optics: r.optics, detail: r.detail, tried: r.tried });
        }
        return errorResult(
          `Autofocus failed on all methods (optics ${r.optics}). Tried: ${JSON.stringify(r.tried)}`,
        );
      }),
  );

  server.registerTool(
    'set_zoom_focus',
    {
      title: 'Set zoom / focus',
      description:
        'Control optics zoom/focus via opticscontrol.cgi setMagnification, or trigger autofocus. For autofocus this uses the same robust cascade as the autofocus tool. Gracefully reports if the model has no controllable optics.',
      inputSchema: {
        zoom: z.number().optional().describe('Target zoom value (optics units).'),
        focus: z.number().optional().describe('Target focus value (optics units).'),
        autofocus: z.boolean().optional().describe('Trigger an autofocus run instead of setting zoom/focus.'),
        optics: z.string().optional().describe('Optics id. Omit to auto-discover.'),
      },
    },
    async (args): Promise<ToolResult> =>
      guard(async () => {
        if (args.autofocus) {
          const r = await runAutofocus(args.optics);
          if (r.ok) return jsonResult({ ok: true, method: r.method, optics: r.optics, detail: r.detail });
          return errorResult(`Autofocus failed (optics ${r.optics}). Tried: ${JSON.stringify(r.tried)}`);
        }
        if (args.zoom === undefined && args.focus === undefined) {
          return errorResult('Provide zoom, focus, and/or autofocus.');
        }
        const id = args.optics ?? (await discoverOpticsId());
        const params: Record<string, unknown> = { optics: [id] };
        if (args.zoom !== undefined) params.zoom = args.zoom;
        if (args.focus !== undefined) params.focus = args.focus;
        const res = await opticsControl('setMagnification', params);
        if (res.status === 404) return errorResult('opticscontrol.cgi not available on this model.');
        return jsonResult({ status: res.status, optics: id, response: safeJson(res.text()) });
      }),
  );
}
