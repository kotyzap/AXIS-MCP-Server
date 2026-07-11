// AXIS Queue Monitor tools — live people-in-queue count, historical queue
// data, and application parameters.
// See https://developer.axis.com/vapix/applications/queue-monitor-api/
//
// Unlike AOA/VMD4, Queue Monitor isn't a JSON-RPC control.cgi — it's a small
// query-flag CGI (/local/queue/.api) that returns JSON for the live reading
// and CSV for historical exports. The query flags (e.g. "live-sum-people.json")
// are bare, not key=value, so they're baked into the path and the vapix()
// query option only carries the trailing key=value params (date/res).
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { vapix } from '../vapix';
import { guard, jsonResult, errorResult, safeJson, parseCsv, ToolResult } from './util';

const API_PATH = '/local/queue/.api';

export function registerQueueMonitorTools(server: McpServer): void {
  server.registerTool(
    'queue_get_live_count',
    {
      title: 'Get live queue people count',
      description:
        'Read the current number of people standing in each configured Queue Monitor region right now ' +
        '(live-sum-people.json): per-region name and count, plus the camera serial and timestamp.',
      inputSchema: {},
    },
    async (): Promise<ToolResult> =>
      guard(async () => {
        const res = await vapix({ method: 'GET', path: `${API_PATH}?live-sum-people.json` });
        if (res.status === 404) {
          return errorResult('AXIS Queue Monitor does not appear to be installed (.api returned 404).');
        }
        if (res.status < 200 || res.status >= 300) {
          return errorResult(`live-sum-people.json failed (HTTP ${res.status}): ${res.text().slice(0, 300)}`);
        }
        return jsonResult(safeJson(res.text()));
      }),
  );

  server.registerTool(
    'queue_get_params',
    {
      title: 'Get Queue Monitor parameters',
      description: 'Read all Queue Monitor application configuration parameters (params.json) — region names, thresholds, upload settings, etc.',
      inputSchema: {},
    },
    async (): Promise<ToolResult> =>
      guard(async () => {
        const res = await vapix({ method: 'GET', path: `${API_PATH}?params.json` });
        if (res.status === 404) {
          return errorResult('AXIS Queue Monitor does not appear to be installed (.api returned 404).');
        }
        if (res.status < 200 || res.status >= 300) {
          return errorResult(`params.json failed (HTTP ${res.status}): ${res.text().slice(0, 300)}`);
        }
        return jsonResult(safeJson(res.text()));
      }),
  );

  server.registerTool(
    'queue_get_history',
    {
      title: 'Get historical queue data',
      description:
        'Export historical Queue Monitor data as CSV, parsed into rows: "minutes" gives, per time bin, how many ' +
        'minutes each region spent at High/Mid/Low queue level; "people" gives the average number of people per ' +
        'region per time bin. Both the parsed rows and the raw CSV are returned.',
      inputSchema: {
        metric: z.enum(['minutes', 'people']).describe('Which export to fetch: queue-level minute bins, or average people counts.'),
        date: z
          .string()
          .optional()
          .describe('YYYYMMDD, a YYYYMMDD-YYYYMMDD range, comma-separated YYYYMMDD dates, or "all" (default).'),
        res: z
          .string()
          .optional()
          .describe('Bin resolution, e.g. "15m", "1h", "24h" (also "1m" for the people export). Defaults to 15m.'),
      },
    },
    async (args): Promise<ToolResult> =>
      guard(async () => {
        const flag = args.metric === 'minutes' ? 'export-csv-minutes' : 'export-csv-people';
        const res = await vapix({
          method: 'GET',
          path: `${API_PATH}?${flag}`,
          query: { date: args.date, res: args.res },
        });
        if (res.status === 404) {
          return errorResult('AXIS Queue Monitor does not appear to be installed (.api returned 404).');
        }
        if (res.status < 200 || res.status >= 300) {
          return errorResult(`${flag} failed (HTTP ${res.status}): ${res.text().slice(0, 300)}`);
        }
        const csv = res.text();
        return jsonResult({ ...parseCsv(csv), raw: csv });
      }),
  );
}
