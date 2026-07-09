// Device info & health tools.
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { vapix } from '../vapix';
import { guard, jsonResult, safeJson, parseParamResponse, ToolResult } from './util';

export function registerDeviceTools(server: McpServer): void {
  server.registerTool(
    'get_device_info',
    {
      title: 'Get device info',
      description:
        'Return all device properties (model, serial, firmware, hardware, etc.) via basicdeviceinfo.cgi.',
      inputSchema: {},
    },
    async () =>
      guard(async () => {
        const res = await vapix({
          method: 'POST',
          path: '/axis-cgi/basicdeviceinfo.cgi',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            apiVersion: '1.0',
            method: 'getAllProperties',
          }),
        });
        let parsed: unknown;
        try {
          parsed = JSON.parse(res.text());
        } catch {
          parsed = { raw: res.text() };
        }
        return jsonResult({ status: res.status, data: parsed });
      }),
  );

  server.registerTool(
    'get_system_status',
    {
      title: 'Get system status',
      description:
        'Return uptime, network parameters and (if available) temperature. Uses param.cgi and temperaturecontrol.cgi.',
      inputSchema: {},
    },
    async () =>
      guard(async () => {
        const status: Record<string, unknown> = {};

        // Network + brand + firmware params.
        const paramRes = await vapix({
          method: 'GET',
          path: '/axis-cgi/param.cgi',
          query: { action: 'list', group: 'Network,Brand,Properties.Firmware' },
        });
        status.params = parseParamResponse(paramRes.text());

        // Temperature (not present on all models — report gracefully).
        try {
          const temp = await vapix({ method: 'GET', path: '/axis-cgi/temperaturecontrol.cgi', query: { action: 'getTemperature' } });
          status.temperature = temp.status === 200 ? temp.text().trim() : `unavailable (HTTP ${temp.status})`;
        } catch (e) {
          status.temperature = `unavailable (${(e as Error).message})`;
        }

        return jsonResult(status);
      }),
  );

  server.registerTool(
    'get_device_properties',
    {
      title: 'Get specific device properties',
      description:
        'Return a specific subset of basicdeviceinfo.cgi properties (e.g. Brand, ProdNbr, Version, SerialNumber) instead of the full set from get_device_info.',
      inputSchema: {
        propertyList: z.array(z.string()).describe('Property names to fetch, e.g. ["Brand","ProdNbr","Version","SerialNumber"].'),
      },
    },
    async (args): Promise<ToolResult> =>
      guard(async () => {
        const res = await vapix({
          method: 'POST',
          path: '/axis-cgi/basicdeviceinfo.cgi',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ apiVersion: '1.0', method: 'getProperties', propertyList: args.propertyList }),
        });
        return jsonResult({ status: res.status, data: safeJson(res.text()) });
      }),
  );

  server.registerTool(
    'get_time',
    {
      title: 'Get camera time',
      description: 'Return the camera date/time and timezone via time.cgi.',
      inputSchema: {},
    },
    async () =>
      guard(async () => {
        const res = await vapix({ method: 'GET', path: '/axis-cgi/time.cgi', query: { action: 'get' } });
        return jsonResult({ status: res.status, time: res.text().trim() });
      }),
  );
}
