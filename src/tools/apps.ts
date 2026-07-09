// ACAP management + parameter tools.
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { vapix } from '../vapix';
import { guard, jsonResult, errorResult, parseParamResponse, ToolResult } from './util';

export interface AppEntry {
  name: string;
  niceName?: string;
  status?: string;
  version?: string;
  vendor?: string;
}

/** Parse the XML from applications/list.cgi into a simple array. */
export function parseAppList(xml: string): AppEntry[] {
  const apps: AppEntry[] = [];
  const re = /<application\b([^>]*)\/?>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    const attrs = m[1];
    const attr = (n: string) => {
      const a = new RegExp(`${n}="([^"]*)"`).exec(attrs);
      return a ? a[1] : undefined;
    };
    const name = attr('Name');
    if (!name) continue;
    apps.push({
      name,
      niceName: attr('NiceName'),
      status: attr('Status'),
      version: attr('Version'),
      vendor: attr('Vendor'),
    });
  }
  return apps;
}

// param.cgi groups that set_param is allowed to modify. Read is unrestricted;
// writes are constrained to reduce blast radius (skill guidance: allowlist).
const WRITABLE_GROUP_ALLOWLIST = [
  'Image',
  'ImageSource',
  'Brand',
  'Time',
  'AudioSource',
  'Event',
  'Overlay',
];

function isAllowedForWrite(param: string): boolean {
  const top = param.split('.')[0];
  return WRITABLE_GROUP_ALLOWLIST.includes(top);
}

export function registerAppTools(server: McpServer): void {
  server.registerTool(
    'list_apps',
    {
      title: 'List installed ACAPs',
      description: 'List installed camera applications (ACAPs) with status and version.',
      inputSchema: {},
    },
    async () =>
      guard(async () => {
        const res = await vapix({ method: 'GET', path: '/axis-cgi/applications/list.cgi' });
        return jsonResult(parseAppList(res.text()));
      }),
  );

  server.registerTool(
    'control_app',
    {
      title: 'Start / stop an ACAP',
      description: 'Start, stop or restart an installed application by package name.',
      inputSchema: {
        package: z.string().describe('The ACAP package name (as returned by list_apps).'),
        action: z.enum(['start', 'stop', 'restart']).describe('Action to perform.'),
      },
    },
    async (args): Promise<ToolResult> =>
      guard(async () => {
        const res = await vapix({
          method: 'GET',
          path: '/axis-cgi/applications/control.cgi',
          query: { action: args.action, package: args.package },
        });
        return jsonResult({ status: res.status, response: res.text().trim() });
      }),
  );

  server.registerTool(
    'get_params',
    {
      title: 'Get parameters',
      description: 'Read camera parameters via param.cgi. Provide a group filter (e.g. "Network" or "Image.I0").',
      inputSchema: {
        group: z.string().optional().describe('param.cgi group filter. Omit to list all (large).'),
      },
    },
    async (args): Promise<ToolResult> =>
      guard(async () => {
        const res = await vapix({
          method: 'GET',
          path: '/axis-cgi/param.cgi',
          query: { action: 'list', group: args.group },
        });
        return jsonResult(parseParamResponse(res.text()));
      }),
  );

  server.registerTool(
    'set_param',
    {
      title: 'Set a parameter',
      description:
        `Set a single camera parameter via param.cgi. Guarded: only these top-level groups may be written: ${WRITABLE_GROUP_ALLOWLIST.join(', ')}. The full parameter name and value are both required.`,
      inputSchema: {
        param: z.string().describe('Full parameter name, e.g. Image.I0.Appearance.Brightness.'),
        value: z.string().describe('New value.'),
      },
    },
    async (args): Promise<ToolResult> =>
      guard(async () => {
        if (!args.param || !args.value) return errorResult('Both param and value are required.');
        if (!isAllowedForWrite(args.param)) {
          return errorResult(
            `Refusing to set '${args.param}': group not in write allowlist (${WRITABLE_GROUP_ALLOWLIST.join(', ')}).`,
          );
        }
        const res = await vapix({
          method: 'GET',
          path: '/axis-cgi/param.cgi',
          query: { action: 'update', [args.param]: args.value },
        });
        return jsonResult({ status: res.status, response: res.text().trim() });
      }),
  );
}
