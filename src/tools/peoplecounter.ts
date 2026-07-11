// AXIS People Counter (tvpc) and AXIS P8815-2 3D People Counter (a3dpc) tools
// — live in/out counts, occupancy, and historical exports.
// See https://developer.axis.com/vapix/applications/people-counter-api/
// and https://developer.axis.com/vapix/applications/p8815-2-3d-people-counter-api/
//
// Two unrelated APIs bundled in one file since they cover the same ground
// (indoor people counting) but live at different bases: /local/tvpc/.api
// (bare query-flag CGI, same shape as Queue Monitor) vs /a3dpc/api/... (a
// proper REST-ish path layout, newer product).
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { vapix } from '../vapix';
import { guard, jsonResult, errorResult, safeJson, parseCsv, ToolResult } from './util';

const TVPC_PATH = '/local/tvpc/.api';
const A3DPC_PATH = '/a3dpc/api';

export function registerPeopleCounterTools(server: McpServer): void {
  server.registerTool(
    'peoplecounter_get_live_count',
    {
      title: 'Get live People Counter in/out count',
      description: "Read AXIS People Counter's current cumulative in/out counts for today (live-sum.json).",
      inputSchema: {},
    },
    async (): Promise<ToolResult> =>
      guard(async () => {
        const res = await vapix({ method: 'GET', path: `${TVPC_PATH}?live-sum.json` });
        if (res.status === 404) return errorResult('AXIS People Counter does not appear to be installed (.api returned 404).');
        if (res.status < 200 || res.status >= 300) return errorResult(`live-sum.json failed (HTTP ${res.status}): ${res.text().slice(0, 300)}`);
        return jsonResult(safeJson(res.text()));
      }),
  );

  server.registerTool(
    'peoplecounter_get_line_position',
    {
      title: 'Get People Counter line position',
      description: "Read the pixel coordinates of AXIS People Counter's counting lines and area in the live view (cntpos.json).",
      inputSchema: {},
    },
    async (): Promise<ToolResult> =>
      guard(async () => {
        const res = await vapix({ method: 'GET', path: `${TVPC_PATH}?cntpos.json` });
        if (res.status === 404) return errorResult('AXIS People Counter does not appear to be installed (.api returned 404).');
        if (res.status < 200 || res.status >= 300) return errorResult(`cntpos.json failed (HTTP ${res.status}): ${res.text().slice(0, 300)}`);
        return jsonResult(safeJson(res.text()));
      }),
  );

  server.registerTool(
    'peoplecounter_get_available_days',
    {
      title: 'List People Counter data availability',
      description: 'List which days have stored People Counter data (list-cnt.json).',
      inputSchema: {},
    },
    async (): Promise<ToolResult> =>
      guard(async () => {
        const res = await vapix({ method: 'GET', path: `${TVPC_PATH}?list-cnt.json` });
        if (res.status === 404) return errorResult('AXIS People Counter does not appear to be installed (.api returned 404).');
        if (res.status < 200 || res.status >= 300) return errorResult(`list-cnt.json failed (HTTP ${res.status}): ${res.text().slice(0, 300)}`);
        return jsonResult(safeJson(res.text()));
      }),
  );

  server.registerTool(
    'peoplecounter_get_history',
    {
      title: 'Get historical People Counter data',
      description: 'Export historical People Counter in/out data as CSV, parsed into rows, for a date range and resolution.',
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
          path: `${TVPC_PATH}?export-csv`,
          query: { date: args.date, res: args.res },
        });
        if (res.status === 404) return errorResult('AXIS People Counter does not appear to be installed (.api returned 404).');
        if (res.status < 200 || res.status >= 300) return errorResult(`export-csv failed (HTTP ${res.status}): ${res.text().slice(0, 300)}`);
        const csv = res.text();
        return jsonResult({ ...parseCsv(csv), raw: csv });
      }),
  );

  server.registerTool(
    'peoplecounter_get_occupancy_history',
    {
      title: 'Get historical People Counter occupancy data',
      description:
        'Export historical People Counter occupancy data (occupancy-export-json) — total in/out and average visit ' +
        'time per bin. Occupancy tracking must be enabled in the app settings for this to return data.',
      inputSchema: {
        date: z.string().optional().describe('YYYYMMDD, a range, comma-separated dates, or "all" (default).'),
        res: z.string().optional().describe('Bin resolution: "1m", "15m" (default), "1h", or "24h".'),
      },
    },
    async (args): Promise<ToolResult> =>
      guard(async () => {
        const res = await vapix({
          method: 'GET',
          path: `${TVPC_PATH}?occupancy-export-json`,
          query: { date: args.date, res: args.res },
        });
        if (res.status === 404) return errorResult('AXIS People Counter does not appear to be installed (.api returned 404).');
        if (res.status < 200 || res.status >= 300) return errorResult(`occupancy-export-json failed (HTTP ${res.status}): ${res.text().slice(0, 300)}`);
        return jsonResult(safeJson(res.text()));
      }),
  );
}

export function registerP8815PeopleCounterTools(server: McpServer): void {
  server.registerTool(
    'p8815_get_live_occupancy',
    {
      title: 'Get live P8815-2 3D People Counter occupancy',
      description: 'Read real-time estimated occupancy and total in/out counts from an AXIS P8815-2 3D People Counter.',
      inputSchema: {},
    },
    async (): Promise<ToolResult> =>
      guard(async () => {
        const res = await vapix({ method: 'GET', path: `${A3DPC_PATH}/occupancy` });
        if (res.status === 404) return errorResult('AXIS P8815-2 3D People Counter does not appear to be installed (a3dpc API returned 404).');
        if (res.status < 200 || res.status >= 300) return errorResult(`a3dpc/api/occupancy failed (HTTP ${res.status}): ${res.text().slice(0, 300)}`);
        return jsonResult(safeJson(res.text()));
      }),
  );

  server.registerTool(
    'p8815_get_foot_traffic_history',
    {
      title: 'Get P8815-2 foot traffic history',
      description: 'Export historical in/out foot-traffic statistics from an AXIS P8815-2 3D People Counter (JSON).',
      inputSchema: {
        start: z.string().optional().describe('YYYYMMDD, "yesterday", "today", or "now". Defaults to "today".'),
        end: z.string().optional().describe('YYYYMMDD, "yesterday", "today", or "now". Defaults to "now".'),
        resolution: z.enum(['minute', 'hour', 'day']).optional().describe('Bin size. Defaults to "hour".'),
      },
    },
    async (args): Promise<ToolResult> =>
      guard(async () => {
        const res = await vapix({
          method: 'GET',
          path: `${A3DPC_PATH}/export/json`,
          query: { start: args.start ?? 'today', end: args.end ?? 'now', resolution: args.resolution ?? 'hour' },
        });
        if (res.status === 404) return errorResult('AXIS P8815-2 3D People Counter does not appear to be installed (a3dpc API returned 404).');
        if (res.status < 200 || res.status >= 300) return errorResult(`a3dpc/api/export/json failed (HTTP ${res.status}): ${res.text().slice(0, 300)}`);
        return jsonResult(safeJson(res.text()));
      }),
  );

  server.registerTool(
    'p8815_get_occupancy_history',
    {
      title: 'Get P8815-2 occupancy history',
      description: 'Export historical peak-occupancy statistics from an AXIS P8815-2 3D People Counter (JSON).',
      inputSchema: {
        start: z.string().optional().describe('YYYYMMDD, "yesterday", "today", or "now". Defaults to "today".'),
        end: z.string().optional().describe('YYYYMMDD, "yesterday", "today", or "now". Defaults to "now".'),
        resolution: z.enum(['hour', 'day']).optional().describe('Bin size. Defaults to "hour".'),
      },
    },
    async (args): Promise<ToolResult> =>
      guard(async () => {
        const res = await vapix({
          method: 'GET',
          path: `${A3DPC_PATH}/export_occupancy/json`,
          query: { start: args.start ?? 'today', end: args.end ?? 'now', resolution: args.resolution ?? 'hour' },
        });
        if (res.status === 404) return errorResult('AXIS P8815-2 3D People Counter does not appear to be installed (a3dpc API returned 404).');
        if (res.status < 200 || res.status >= 300) return errorResult(`a3dpc/api/export_occupancy/json failed (HTTP ${res.status}): ${res.text().slice(0, 300)}`);
        return jsonResult(safeJson(res.text()));
      }),
  );
}
