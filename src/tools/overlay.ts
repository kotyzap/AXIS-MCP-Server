// VAPIX Overlay API — native camera text/image overlays (dynamic overlay
// engine), privacy masks aside. Distinct from the CamOverlay ACAP already
// covered in camoverlay.ts: this is the built-in /axis-cgi one, no extra app
// required.
// See https://developer.axis.com/vapix/network-video/overlay-api/
//
// JSON-RPC over POST /axis-cgi/dynamicoverlay/dynamicoverlay.cgi, Google JSON
// style ({apiVersion, context, method, params} -> {..., data} / {..., error}).
// addText/addImage/setText/setImage accept dozens of optional fields (position,
// colors, font size, PTZ-relative placement, text rotation, ...) that vary by
// firmware/model, so those four tools take a passthrough `params` object
// mirroring the JSON-RPC params verbatim rather than re-declaring every field.
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { vapix } from '../vapix';
import { guard, jsonResult, errorResult, safeJson, ToolResult } from './util';

const CONTROL_PATH = '/axis-cgi/dynamicoverlay/dynamicoverlay.cgi';
const FALLBACK_API_VERSION = '1.0';

interface OverlayJsonRpcResponse {
  apiVersion?: string;
  context?: string;
  method?: string;
  data?: unknown;
  error?: { code: number; message: string };
}

function isOverlayResponse(x: unknown): x is OverlayJsonRpcResponse {
  return !!x && typeof x === 'object';
}

let cachedApiVersion: string | null = null;

async function resolveApiVersion(): Promise<string> {
  if (cachedApiVersion) return cachedApiVersion;
  const res = await vapix({
    method: 'POST',
    path: CONTROL_PATH,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ context: 'axis-mcp', method: 'getSupportedVersions' }),
  });
  if (res.status >= 200 && res.status < 300) {
    const parsed = safeJson(res.text());
    const versions = isOverlayResponse(parsed) ? (parsed.data as { apiVersions?: unknown })?.apiVersions : undefined;
    if (Array.isArray(versions) && versions.length > 0) {
      cachedApiVersion = String(versions[versions.length - 1]);
      return cachedApiVersion;
    }
  }
  return FALLBACK_API_VERSION;
}

async function callOverlay(
  method: string,
  params?: Record<string, unknown>,
): Promise<{ status: number; apiVersion: string; response: unknown }> {
  const apiVersion = await resolveApiVersion();
  const res = await vapix({
    method: 'POST',
    path: CONTROL_PATH,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ apiVersion, context: 'axis-mcp', method, ...(params ? { params } : {}) }),
  });
  return { status: res.status, apiVersion, response: safeJson(res.text()) };
}

function overlayResult(status: number, response: unknown): ToolResult {
  if (status === 404) return errorResult('Overlay API not available on this model (dynamicoverlay.cgi returned 404).');
  if (!isOverlayResponse(response)) return errorResult(`Unexpected response from dynamicoverlay.cgi (HTTP ${status}).`);
  if (response.error) return errorResult(`Overlay API error ${response.error.code}: ${response.error.message}`);
  return jsonResult(response.data ?? {});
}

export function registerOverlayTools(server: McpServer): void {
  server.registerTool(
    'overlay_list',
    {
      title: 'List camera overlays',
      description:
        'List every text/image overlay created via the native VAPIX Overlay API (dynamicoverlay.cgi list), plus ' +
        'the available uploaded overlay image files. Optionally filter to one camera/channel.',
      inputSchema: {
        camera: z.number().int().optional().describe('Limit to one camera/view-area channel.'),
      },
    },
    async (args): Promise<ToolResult> =>
      guard(async () => {
        const { status, response } = await callOverlay('list', args.camera !== undefined ? { camera: args.camera } : {});
        return overlayResult(status, response);
      }),
  );

  server.registerTool(
    'overlay_get_capabilities',
    {
      title: 'Get overlay capabilities',
      description: 'Get the maximum number of overlays and other overlay capabilities supported by this camera (getOverlayCapabilities).',
      inputSchema: {
        camera: z.number().int().optional().describe('Limit to one camera/view-area channel.'),
      },
    },
    async (args): Promise<ToolResult> =>
      guard(async () => {
        const { status, response } = await callOverlay(
          'getOverlayCapabilities',
          args.camera !== undefined ? { camera: args.camera } : {},
        );
        return overlayResult(status, response);
      }),
  );

  server.registerTool(
    'overlay_add_text',
    {
      title: 'Add text overlay',
      description:
        'Create a new text overlay (addText) and return its overlay ID. Pass the JSON-RPC params object verbatim, ' +
        'e.g. {"camera":1,"text":"%c","position":"topLeft","textColor":"white"}. Common fields: camera, text ' +
        '(supports %c for timestamp etc.), position (e.g. topLeft/bottomRight/custom), textColor, textBGColor, ' +
        'fontSize. Use overlay_get_capabilities / the VAPIX docs for the full field list.',
      inputSchema: {
        params: z.record(z.string(), z.any()).describe('addText JSON-RPC params object.'),
      },
    },
    async (args): Promise<ToolResult> =>
      guard(async () => {
        const { status, response } = await callOverlay('addText', args.params);
        return overlayResult(status, response);
      }),
  );

  server.registerTool(
    'overlay_add_image',
    {
      title: 'Add image overlay',
      description:
        'Create a new image overlay (addImage) from a previously-uploaded overlay image file and return its overlay ' +
        'ID. Pass the JSON-RPC params object verbatim, e.g. {"camera":1,"overlayPath":"logo.ovl","position":"bottomLeft"}. ' +
        'Use overlay_list to see available overlayPath files.',
      inputSchema: {
        params: z.record(z.string(), z.any()).describe('addImage JSON-RPC params object.'),
      },
    },
    async (args): Promise<ToolResult> =>
      guard(async () => {
        const { status, response } = await callOverlay('addImage', args.params);
        return overlayResult(status, response);
      }),
  );

  server.registerTool(
    'overlay_set_text',
    {
      title: 'Update text overlay',
      description:
        'Update fields on an existing text overlay (setText). Pass the JSON-RPC params object verbatim, must include ' +
        '"identity" (from overlay_list), e.g. {"identity":0,"textBGColor":"red"}. Only supplied fields are changed.',
      inputSchema: {
        params: z.record(z.string(), z.any()).describe('setText JSON-RPC params object, must include identity.'),
      },
    },
    async (args): Promise<ToolResult> =>
      guard(async () => {
        if (args.params.identity === undefined) return errorResult('params.identity is required.');
        const { status, response } = await callOverlay('setText', args.params);
        return overlayResult(status, response);
      }),
  );

  server.registerTool(
    'overlay_set_image',
    {
      title: 'Update image overlay',
      description:
        'Update fields on an existing image overlay (setImage). Pass the JSON-RPC params object verbatim, must ' +
        'include "identity" (from overlay_list), e.g. {"identity":2,"camera":1,"overlayPath":"redlogo.ovl"}.',
      inputSchema: {
        params: z.record(z.string(), z.any()).describe('setImage JSON-RPC params object, must include identity.'),
      },
    },
    async (args): Promise<ToolResult> =>
      guard(async () => {
        if (args.params.identity === undefined) return errorResult('params.identity is required.');
        const { status, response } = await callOverlay('setImage', args.params);
        return overlayResult(status, response);
      }),
  );

  server.registerTool(
    'overlay_remove',
    {
      title: 'Remove overlay',
      description: 'Remove an overlay by its identity (from overlay_list). Overlay IDs can change after a reboot — re-list first.',
      inputSchema: {
        identity: z.number().int().describe('Overlay identity to remove.'),
      },
    },
    async (args): Promise<ToolResult> =>
      guard(async () => {
        const { status, response } = await callOverlay('remove', { identity: args.identity });
        return overlayResult(status, response);
      }),
  );
}
