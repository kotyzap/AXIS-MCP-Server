// CamStreamer App tools — start/stop streams and read their state.
// Base path: /local/camstreamer/  (requires the CamStreamer ACAP installed).
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { vapix } from '../vapix';
import { guard, jsonResult, errorResult, safeJson, parseParamResponse, ToolResult } from './util';

export function registerCamStreamerTools(server: McpServer): void {
  server.registerTool(
    'camstreamer_list_streams',
    {
      title: 'List CamStreamer streams',
      description:
        'List all configured CamStreamer streams (RTMP/HLS/SRT/MPEG-TS) with their stream_id, name, and enabled state.',
      inputSchema: {},
    },
    async (): Promise<ToolResult> =>
      guard(async () => {
        // Documented endpoint (CamStreamer App 5.x/6.x): stream_list.cgi?action=get
        // at /local/camstreamer/ (note the underscore — NOT stream/list.cgi, which
        // 404s/400s on current builds). Response shape: { "streamList": [...] }.
        const res = await vapix({
          method: 'GET',
          path: '/local/camstreamer/stream_list.cgi',
          query: { action: 'get' },
        });
        if (res.status >= 200 && res.status < 300) {
          const parsed = safeJson(res.text());
          const streams =
            parsed && typeof parsed === 'object' && Array.isArray((parsed as Record<string, unknown>).streamList)
              ? (parsed as Record<string, unknown>).streamList
              : parsed;
          return jsonResult({ source: 'stream_list.cgi', streams });
        }

        // Fallback for older/renamed builds: the stream config also mirrors into
        // the param tree at root.Camstreamer.StreamList, a JSON string keyed by
        // stream_id.
        const paramRes = await vapix({
          method: 'GET',
          path: '/axis-cgi/param.cgi',
          query: { action: 'list', group: 'root.Camstreamer.StreamList' },
        });
        if (paramRes.status < 200 || paramRes.status >= 300) {
          return errorResult(
            `stream_list.cgi failed (HTTP ${res.status}) and the root.Camstreamer.StreamList param fallback also failed (HTTP ${paramRes.status}). Is the CamStreamer App installed?`,
          );
        }
        const raw = parseParamResponse(paramRes.text())['root.Camstreamer.StreamList'] ?? '';
        if (raw === '') {
          return jsonResult({ streams: [], note: 'No CamStreamer streams are configured on this camera.' });
        }
        const parsed = safeJson(raw);
        // StreamList is an object keyed by stream_id; flatten to an array carrying id.
        const streams =
          parsed && typeof parsed === 'object' && !Array.isArray(parsed)
            ? Object.entries(parsed as Record<string, unknown>).map(([stream_id, v]) => ({ stream_id, ...(v as object) }))
            : parsed;
        return jsonResult({ source: 'param.cgi:root.Camstreamer.StreamList', streams });
      }),
  );

  server.registerTool(
    'camstreamer_stream_status',
    {
      title: 'Get CamStreamer stream status',
      description: 'Get the live status of a single CamStreamer stream by stream_id.',
      inputSchema: {
        stream_id: z.union([z.number(), z.string()]).describe('The stream_id from camstreamer_list_streams.'),
      },
    },
    async (args): Promise<ToolResult> =>
      guard(async () => {
        // v6: get_streamstat.cgi (stream/status.cgi does not exist in 5.x/6.x).
        const res = await vapix({
          method: 'GET',
          path: '/local/camstreamer/get_streamstat.cgi',
          query: { stream_id: String(args.stream_id) },
        });
        return jsonResult({ status: res.status, data: safeJson(res.text()) });
      }),
  );

  server.registerTool(
    'camstreamer_control_stream',
    {
      title: 'Start / stop a CamStreamer stream',
      description: 'Enable (start) or disable (stop) a CamStreamer stream by stream_id.',
      inputSchema: {
        stream_id: z.union([z.number(), z.string()]).describe('The stream_id to control.'),
        enabled: z.boolean().describe('true = start the stream, false = stop it.'),
      },
    },
    async (args): Promise<ToolResult> =>
      guard(async () => {
        // v6: set_stream_enabled.cgi (stream/set.cgi was removed in the 5.x/6.x
        // flatten, same as stream/list.cgi -> stream_list.cgi). UNVERIFIED on
        // hardware — confirm against a live camera with a real stream_id.
        const res = await vapix({
          method: 'GET',
          path: '/local/camstreamer/set_stream_enabled.cgi',
          query: { stream_id: String(args.stream_id), enabled: args.enabled ? '1' : '0' },
        });
        return jsonResult({ status: res.status, response: safeJson(res.text()) });
      }),
  );
}
