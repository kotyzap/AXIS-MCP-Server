// VAPIX View Area API — define/configure rectangular sub-regions of a wide
// angle or high-res sensor as independent virtual streaming channels.
// See https://developer.axis.com/vapix/network-video/view-area-api/
//
// JSON-RPC over POST /axis-cgi/viewarea/info.cgi (list, read-only) and
// /axis-cgi/viewarea/configure.cgi (setGeometry/resetGeometry, Administrator).
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { vapix } from '../vapix';
import { guard, jsonResult, errorResult, safeJson, ToolResult } from './util';

const INFO_PATH = '/axis-cgi/viewarea/info.cgi';
const CONFIGURE_PATH = '/axis-cgi/viewarea/configure.cgi';
const FALLBACK_API_VERSION = '1.0';

interface ViewAreaResponse {
  apiVersion?: string;
  context?: string;
  method?: string;
  data?: unknown;
  error?: { code: number; message: string };
}

function isViewAreaResponse(x: unknown): x is ViewAreaResponse {
  return !!x && typeof x === 'object';
}

async function call(path: string, method: string, params?: Record<string, unknown>) {
  const res = await vapix({
    method: 'POST',
    path,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ apiVersion: FALLBACK_API_VERSION, context: 'axis-mcp', method, ...(params ? { params } : {}) }),
  });
  return { status: res.status, response: safeJson(res.text()) };
}

function result(status: number, response: unknown): ToolResult {
  if (status === 404) return errorResult('View Area API not available on this model (404).');
  if (!isViewAreaResponse(response)) return errorResult(`Unexpected response from View Area API (HTTP ${status}).`);
  if (response.error) return errorResult(`View Area API error ${response.error.code}: ${response.error.message}`);
  return jsonResult(response.data ?? {});
}

export function registerViewAreaTools(server: McpServer): void {
  server.registerTool(
    'viewarea_list',
    {
      title: 'List view areas',
      description:
        'List every view area on this camera (id, source, camera/channel index, whether it is configurable, and — ' +
        'for configurable areas — its current rectangular geometry, canvas size, min/max size and grid alignment). ' +
        'A wide-angle or high-resolution camera can expose several independent virtual channels this way.',
      inputSchema: {},
    },
    async (): Promise<ToolResult> =>
      guard(async () => {
        const { status, response } = await call(INFO_PATH, 'list');
        return result(status, response);
      }),
  );

  server.registerTool(
    'viewarea_set_geometry',
    {
      title: 'Set view area geometry',
      description:
        'Set the rectangular geometry (in canvas pixel coordinates from viewarea_list) of a configurable view area. ' +
        'The device may snap the request to its grid alignment — the response reflects the requested geometry, so ' +
        're-read with viewarea_list to see the actual aligned result. Changing geometry will close any open streams for that area.',
      inputSchema: {
        id: z.number().int().describe('View area ID (from viewarea_list).'),
        horizontalOffset: z.number().int(),
        horizontalSize: z.number().int(),
        verticalOffset: z.number().int(),
        verticalSize: z.number().int(),
      },
    },
    async (args): Promise<ToolResult> =>
      guard(async () => {
        const { status, response } = await call(CONFIGURE_PATH, 'setGeometry', {
          viewArea: {
            id: args.id,
            rectangularGeometry: {
              horizontalOffset: args.horizontalOffset,
              horizontalSize: args.horizontalSize,
              verticalOffset: args.verticalOffset,
              verticalSize: args.verticalSize,
            },
          },
        });
        return result(status, response);
      }),
  );

  server.registerTool(
    'viewarea_reset_geometry',
    {
      title: 'Reset view area geometry',
      description: 'Reset a view area back to its default geometry.',
      inputSchema: { id: z.number().int().describe('View area ID (from viewarea_list).') },
    },
    async (args): Promise<ToolResult> =>
      guard(async () => {
        const { status, response } = await call(CONFIGURE_PATH, 'resetGeometry', { viewArea: { id: args.id } });
        return result(status, response);
      }),
  );
}
