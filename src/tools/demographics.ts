// AXIS Demographic Identifier tools — live face tracks (age/gender/box size
// estimates) and historical stats.
// See https://developer.axis.com/vapix/applications/demographic-identifier-api/
//
// Same query-flag CGI shape as Queue Monitor: /local/demographics/.api with
// bare flags (tracks-live.json etc.) rather than key=value methods.
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { vapix } from '../vapix';
import { guard, jsonResult, errorResult, safeJson, ToolResult } from './util';

const API_PATH = '/local/demographics/.api';

export function registerDemographicsTools(server: McpServer): void {
  server.registerTool(
    'demographics_get_live_tracks',
    {
      title: 'Get live demographic tracks',
      description:
        'Read face tracks currently active in view (tracks-live.json): estimated gender/age/box size, both ' +
        'averaged over the track and from the last observation.',
      inputSchema: {},
    },
    async (): Promise<ToolResult> =>
      guard(async () => {
        const res = await vapix({ method: 'GET', path: `${API_PATH}?tracks-live.json` });
        if (res.status === 404) {
          return errorResult('AXIS Demographic Identifier does not appear to be installed (.api returned 404).');
        }
        if (res.status < 200 || res.status >= 300) {
          return errorResult(`tracks-live.json failed (HTTP ${res.status}): ${res.text().slice(0, 300)}`);
        }
        return jsonResult(safeJson(res.text()));
      }),
  );

  server.registerTool(
    'demographics_get_ended_tracks',
    {
      title: 'Get ended demographic tracks',
      description: 'Read recently-ended face tracks (tracks-ended.json) with their averaged gender/age/box size estimates.',
      inputSchema: {
        time_seconds: z.number().optional().describe('How far back to include, in seconds. Defaults to 15 minutes.'),
      },
    },
    async (args): Promise<ToolResult> =>
      guard(async () => {
        const res = await vapix({
          method: 'GET',
          path: `${API_PATH}?tracks-ended.json`,
          query: { time: args.time_seconds },
        });
        if (res.status === 404) {
          return errorResult('AXIS Demographic Identifier does not appear to be installed (.api returned 404).');
        }
        if (res.status < 200 || res.status >= 300) {
          return errorResult(`tracks-ended.json failed (HTTP ${res.status}): ${res.text().slice(0, 300)}`);
        }
        return jsonResult(safeJson(res.text()));
      }),
  );

  server.registerTool(
    'demographics_get_live_and_ended_tracks',
    {
      title: 'Get live and ended demographic tracks',
      description: 'Combined read of tracks-live.json and tracks-ended.json in one call.',
      inputSchema: {
        time_seconds: z.number().optional().describe('How far back to include ended tracks, in seconds. Defaults to 15 minutes.'),
      },
    },
    async (args): Promise<ToolResult> =>
      guard(async () => {
        const res = await vapix({
          method: 'GET',
          path: `${API_PATH}?tracks-live-and-ended.json`,
          query: { time: args.time_seconds },
        });
        if (res.status === 404) {
          return errorResult('AXIS Demographic Identifier does not appear to be installed (.api returned 404).');
        }
        if (res.status < 200 || res.status >= 300) {
          return errorResult(`tracks-live-and-ended.json failed (HTTP ${res.status}): ${res.text().slice(0, 300)}`);
        }
        return jsonResult(safeJson(res.text()));
      }),
  );

  server.registerTool(
    'demographics_get_stats',
    {
      title: 'Get historical demographic stats',
      description: 'Export historical Demographic Identifier statistics (export-json) for a date range and resolution.',
      inputSchema: {
        date: z
          .string()
          .optional()
          .describe('YYYYMMDD, a YYYYMMDD-YYYYMMDD range, comma-separated YYYYMMDD dates, or "all" (default).'),
        res: z.string().optional().describe('Bin resolution: "15m" (default), "1h", or "24h".'),
      },
    },
    async (args): Promise<ToolResult> =>
      guard(async () => {
        const res = await vapix({
          method: 'GET',
          path: `${API_PATH}?export-json`,
          query: { date: args.date, res: args.res },
        });
        if (res.status === 404) {
          return errorResult('AXIS Demographic Identifier does not appear to be installed (.api returned 404).');
        }
        if (res.status < 200 || res.status >= 300) {
          return errorResult(`export-json failed (HTTP ${res.status}): ${res.text().slice(0, 300)}`);
        }
        return jsonResult(safeJson(res.text()));
      }),
  );
}
