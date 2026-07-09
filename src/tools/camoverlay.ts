// CamOverlay App tools — list/toggle services and update Custom Graphics.
// Base path: /local/camoverlay/api/  (requires the CamOverlay ACAP installed).
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { vapix } from '../vapix';
import { guard, jsonResult, errorResult, safeJson, parseParamResponse, ToolResult } from './util';

/** #RRGGBB -> AXIS zero-padded decimal triplet, e.g. #FF0000 -> "255000000". */
function hexToAxisColor(hex: string): string {
  const h = hex.replace('#', '').padEnd(6, 'f');
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `${r.toString().padStart(3, '0')}${g.toString().padStart(3, '0')}${b.toString().padStart(3, '0')}`;
}

export function registerCamOverlayTools(server: McpServer): void {
  server.registerTool(
    'camoverlay_list_services',
    {
      title: 'List CamOverlay services',
      description: 'List all CamOverlay services with their IDs and types.',
      inputSchema: {},
    },
    async (): Promise<ToolResult> =>
      guard(async () => {
        // services.cgi with no query returns 404 on old firmware but "invalid
        // action specified" (400) on newer CamOverlay App builds, which require
        // an explicit action param. Try action=list, then action=get, then fall
        // back to reading the param tree directly (mirrors the CamStreamer
        // stream-list workaround — always available even if the CGI action name
        // changes between App versions).
        for (const action of ['get', 'list']) {
          const res = await vapix({
            method: 'GET',
            path: '/local/camoverlay/api/services.cgi',
            query: { action },
          });
          if (res.status === 404) {
            return errorResult('CamOverlay App does not appear to be installed (services.cgi returned 404).');
          }
          if (res.status >= 200 && res.status < 300) {
            return jsonResult({ status: res.status, action, services: safeJson(res.text()) });
          }
        }

        // Fallback: enumerate services from the param tree.
        const paramRes = await vapix({
          method: 'GET',
          path: '/axis-cgi/param.cgi',
          query: { action: 'list', group: 'root.CamOverlay' },
        });
        if (paramRes.status < 200 || paramRes.status >= 300) {
          return errorResult(
            `services.cgi rejected all known actions and the root.CamOverlay param fallback failed (HTTP ${paramRes.status}). Is the CamOverlay App installed?`,
          );
        }
        const params = parseParamResponse(paramRes.text());
        if (Object.keys(params).length === 0) {
          return jsonResult({ services: [], note: 'No CamOverlay services are configured on this camera.' });
        }
        return jsonResult({ source: 'param.cgi:root.CamOverlay', params });
      }),
  );

  server.registerTool(
    'camoverlay_set_service_enabled',
    {
      title: 'Enable / disable a CamOverlay service',
      description: 'Enable or disable a CamOverlay service by service_id.',
      inputSchema: {
        service_id: z.union([z.number(), z.string()]).describe('The CamOverlay service ID.'),
        enabled: z.boolean().describe('true = enable, false = disable.'),
      },
    },
    async (args): Promise<ToolResult> =>
      guard(async () => {
        const res = await vapix({
          method: 'GET',
          path: '/local/camoverlay/api/services.cgi',
          query: { action: 'set', service_id: String(args.service_id), enabled: args.enabled ? '1' : '0' },
        });
        return jsonResult({ status: res.status, response: safeJson(res.text()) });
      }),
  );

  server.registerTool(
    'camoverlay_update_graphic_text',
    {
      title: 'Update CamOverlay Custom Graphic text',
      description:
        'Update text fields in a CamOverlay Custom Graphic service. Field names are defined in the CamOverlay UI. Optionally set per-field colors (hex like #FF0000).',
      inputSchema: {
        service_id: z.union([z.number(), z.string()]).describe('The Custom Graphic service ID.'),
        fields: z.record(z.string(), z.string()).describe('Map of field name -> text value.'),
        colors: z
          .record(z.string(), z.string())
          .optional()
          .describe('Optional map of field name -> hex color (e.g. #FF0000).'),
      },
    },
    async (args): Promise<ToolResult> =>
      guard(async () => {
        if (Object.keys(args.fields).length === 0) return errorResult('No fields supplied.');
        const query: Record<string, string> = {
          action: 'update_text',
          service_id: String(args.service_id),
        };
        for (const [k, v] of Object.entries(args.fields)) query[k] = v;
        if (args.colors) {
          for (const [k, hex] of Object.entries(args.colors)) query[`${k}_color`] = hexToAxisColor(hex);
        }
        const res = await vapix({ method: 'GET', path: '/local/camoverlay/api/customGraphics.cgi', query });
        return jsonResult({ status: res.status, response: safeJson(res.text()) });
      }),
  );

  server.registerTool(
    'camoverlay_infoticker',
    {
      title: 'Set CamOverlay InfoTicker text',
      description: 'Set the scrolling InfoTicker text for a CamOverlay service.',
      inputSchema: {
        service_id: z.union([z.number(), z.string()]).describe('The InfoTicker service ID.'),
        text: z.string().describe('The text to display.'),
      },
    },
    async (args): Promise<ToolResult> =>
      guard(async () => {
        const res = await vapix({
          method: 'GET',
          path: '/local/camoverlay/api/infoticker.cgi',
          query: { service_id: String(args.service_id), text: args.text },
        });
        return jsonResult({ status: res.status, response: safeJson(res.text()) });
      }),
  );
}
