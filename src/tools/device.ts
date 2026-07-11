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
        'Return uptime, network parameters and (if available) temperature. Uses param.cgi (Properties.System.Temperature, ' +
        'the widest-compatibility source), falling back to temperaturecontrol.cgi and finally the legacy operator/temperature.cgi.',
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
        // Three tiers, cross-checked against a separately-working HomeKit integration
        // on the same Q1656 unit:
        //  1. param.cgi group=Properties.System.Temperature — a simple CPU/board sensor
        //     exposed on many models *without* the full TemperatureControl feature set.
        //     This is what actually works on this camera; temperaturecontrol.cgi (below)
        //     400s on it even with a valid action, presumably because
        //     Properties.TemperatureSensor.TemperatureControl isn't "yes" here.
        //  2. temperaturecontrol.cgi?action=statusall — the newer, richer API (every
        //     sensor/heater/fan) on models that do support it. Valid actions are
        //     start|stop|query|timeuntilstop|statusall — there is no "getTemperature"
        //     action (that was the original bug here; the camera correctly 400s on it).
        //  3. /axis-cgi/operator/temperature.cgi — oldest legacy CGI, plain
        //     `value="NN.N"` response, last resort.
        try {
          let temp = parseParamResponse(
            (
              await vapix({
                method: 'GET',
                path: '/axis-cgi/param.cgi',
                query: { action: 'list', group: 'Properties.System.Temperature' },
              })
            ).text(),
          );
          if (Object.keys(temp).length === 0) {
            const tc = await vapix({ method: 'GET', path: '/axis-cgi/temperaturecontrol.cgi', query: { action: 'statusall' } });
            temp = tc.status === 200 ? parseParamResponse(tc.text()) : {};
          }
          if (Object.keys(temp).length === 0) {
            const legacy = await vapix({ method: 'GET', path: '/axis-cgi/operator/temperature.cgi' });
            const m = /value="([\d.]+)"/.exec(legacy.text());
            if (m) temp = { value: m[1] };
          }
          status.temperature = Object.keys(temp).length > 0 ? temp : 'unavailable (no temperature parameter found on this model)';
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
    'get_view_areas',
    {
      title: 'List view areas',
      description:
        'List the camera view areas (id, name, source, rectangle) via the View Area API (viewarea/info.cgi). Falls back to param.cgi Image/ImageSource params on older firmware. Read-only.',
      inputSchema: {},
    },
    async () =>
      guard(async () => {
        // Modern View Area API.
        const res = await vapix({
          method: 'POST',
          path: '/axis-cgi/viewarea/info.cgi',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ apiVersion: '1.0', method: 'list' }),
        });
        if (res.status >= 200 && res.status < 300) {
          return jsonResult({ source: 'viewarea/info.cgi', data: safeJson(res.text()) });
        }
        // Fallback: view areas mirror into the Image param tree
        // (Image.I#.Enabled / Image.I#.Name).
        const paramRes = await vapix({
          method: 'GET',
          path: '/axis-cgi/param.cgi',
          query: { action: 'list', group: 'Image,ImageSource' },
        });
        const params = parseParamResponse(paramRes.text());
        const areas: Record<string, { enabled?: string; name?: string }> = {};
        for (const [k, v] of Object.entries(params)) {
          const m = /(?:^|\.)Image\.(I\d+)\.(Enabled|Name)$/.exec(k);
          if (!m) continue;
          areas[m[1]] = areas[m[1]] || {};
          if (m[2] === 'Enabled') areas[m[1]].enabled = v;
          else areas[m[1]].name = v;
        }
        return jsonResult({ source: 'param.cgi (viewarea API returned HTTP ' + res.status + ')', viewAreas: areas });
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
