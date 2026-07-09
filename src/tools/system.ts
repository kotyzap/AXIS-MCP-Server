// System-level discovery & maintenance tools: API discovery, firmware
// management (reboot / factory default), and capability probing.
//
// Reboot and factory-default are destructive — both require `confirm: true`
// and fall back from the modern JSON-RPC API to the legacy CGI if the camera
// doesn't support firmwaremanagement.cgi.
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { vapix } from '../vapix';
import { guard, jsonResult, errorResult, safeJson, parseParamResponse, ToolResult } from './util';

async function firmwareManagement(method: string, params?: Record<string, unknown>) {
  const body: Record<string, unknown> = { apiVersion: '1.3', method };
  if (params) body.params = params;
  return vapix({
    method: 'POST',
    path: '/axis-cgi/firmwaremanagement.cgi',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

export function registerSystemTools(server: McpServer): void {
  server.registerTool(
    'get_api_list',
    {
      title: 'Discover supported VAPIX APIs',
      description: 'List the VAPIX APIs (and versions) exposed by this device via apidiscovery.cgi. Use this instead of blind-probing endpoints.',
      inputSchema: {},
    },
    async (): Promise<ToolResult> =>
      guard(async () => {
        const res = await vapix({
          method: 'POST',
          path: '/axis-cgi/apidiscovery.cgi',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ apiVersion: '1.0', method: 'getApiList' }),
        });
        if (res.status === 404) return errorResult('API Discovery Service not available on this firmware.');
        return jsonResult({ status: res.status, data: safeJson(res.text()) });
      }),
  );

  server.registerTool(
    'get_capabilities',
    {
      title: 'Get quick capability summary',
      description: 'Summarize HTTP API version, available API groups, and PTZ support from param.cgi (Properties.API / Properties.PTZ).',
      inputSchema: {},
    },
    async (): Promise<ToolResult> =>
      guard(async () => {
        const res = await vapix({
          method: 'GET',
          path: '/axis-cgi/param.cgi',
          query: { action: 'list', group: 'Properties.API,Properties.PTZ' },
        });
        return jsonResult(parseParamResponse(res.text()));
      }),
  );

  server.registerTool(
    'get_firmware_properties',
    {
      title: 'Get firmware management properties',
      description: 'Return firmwaremanagement.cgi properties (active partition, pending updates, validation state, etc.).',
      inputSchema: {},
    },
    async (): Promise<ToolResult> =>
      guard(async () => {
        const res = await firmwareManagement('getProperties');
        if (res.status === 404) return errorResult('firmwaremanagement.cgi not available on this firmware.');
        return jsonResult({ status: res.status, data: safeJson(res.text()) });
      }),
  );

  server.registerTool(
    'reboot_camera',
    {
      title: 'Reboot the camera',
      description:
        'Reboot the device. Destructive — drops all connections and streams. Requires confirm=true. Uses firmwaremanagement.cgi (reboot), falling back to the legacy restart.cgi.',
      inputSchema: {
        confirm: z.literal(true).describe('Must be explicitly set to true to proceed.'),
      },
    },
    async (args): Promise<ToolResult> =>
      guard(async () => {
        if (args.confirm !== true) return errorResult('Refusing to reboot without confirm=true.');
        const res = await firmwareManagement('reboot');
        if (res.status === 404) {
          const legacy = await vapix({ method: 'POST', path: '/axis-cgi/restart.cgi' });
          return jsonResult({ status: legacy.status, via: 'legacy restart.cgi', response: legacy.text().trim() });
        }
        return jsonResult({ status: res.status, via: 'firmwaremanagement.cgi', data: safeJson(res.text()) });
      }),
  );

  server.registerTool(
    'factory_default',
    {
      title: 'Factory default the camera',
      description:
        'Reset the device to factory defaults. Destructive and requires administrator permissions. Requires confirm=true. ' +
        'hard=true wipes network settings too (device becomes unreachable at its current address); hard=false (default) keeps network config. ' +
        'Uses firmwaremanagement.cgi (factoryDefault), falling back to the legacy factorydefault.cgi (always a hard reset) if unavailable.',
      inputSchema: {
        confirm: z.literal(true).describe('Must be explicitly set to true to proceed.'),
        hard: z.boolean().optional().describe('true = hard reset (wipes network config too). Default false.'),
      },
    },
    async (args): Promise<ToolResult> =>
      guard(async () => {
        if (args.confirm !== true) return errorResult('Refusing to factory default without confirm=true.');
        const res = await firmwareManagement('factoryDefault', { hard: args.hard ?? false });
        if (res.status === 404) {
          const legacy = await vapix({ method: 'POST', path: '/axis-cgi/factorydefault.cgi' });
          return jsonResult({ status: legacy.status, via: 'legacy factorydefault.cgi (always hard)', response: legacy.text().trim() });
        }
        return jsonResult({ status: res.status, via: 'firmwaremanagement.cgi', hard: args.hard ?? false, data: safeJson(res.text()) });
      }),
  );
}
