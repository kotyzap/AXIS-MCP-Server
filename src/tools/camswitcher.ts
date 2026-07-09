// CamSwitcher App tools — list/switch/queue playlists (views) and read output.
// Base path: /local/camswitcher/  (requires the CamSwitcher ACAP installed).
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { vapix } from '../vapix';
import { guard, jsonResult, errorResult, safeJson, ToolResult } from './util';

async function get(path: string, query?: Record<string, string>) {
  const res = await vapix({ method: 'GET', path, query });
  if (res.status === 404) {
    throw new Error('CamSwitcher App does not appear to be installed (404 on ' + path + ').');
  }
  return { status: res.status, data: safeJson(res.text()) };
}

// CamSwitcher's documented base path is /local/camswitcher/api/<cgi> (matches
// ws_authorization.cgi), but some App versions serve the same CGIs one level up
// at /local/camswitcher/<cgi> (matches output_info.cgi, and is what earlier
// builds of this server assumed). Try the documented /api/ path first, then
// fall back to the bare path, so this works across CamSwitcher versions without
// needing to know which one is installed.
async function getVersioned(cgi: string, query?: Record<string, string>) {
  const withApi = await get(`/local/camswitcher/api/${cgi}`, query);
  if (withApi.status >= 200 && withApi.status < 300) return { ...withApi, path: `api/${cgi}` };
  const bare = await get(`/local/camswitcher/${cgi}`, query);
  return { ...bare, path: cgi };
}

export function registerCamSwitcherTools(server: McpServer): void {
  server.registerTool(
    'camswitcher_list_playlists',
    {
      title: 'List CamSwitcher playlists (views)',
      description: 'List all CamSwitcher playlists / views with their names, durations, and items.',
      inputSchema: {},
    },
    async (): Promise<ToolResult> =>
      guard(async () => jsonResult(await getVersioned('playlists.cgi', { action: 'get' }))),
  );

  server.registerTool(
    'camswitcher_switch_playlist',
    {
      title: 'Switch to a CamSwitcher playlist',
      description: 'Immediately switch to (interrupt and start) a CamSwitcher playlist by name.',
      inputSchema: {
        playlist_name: z.string().describe('The playlist/view name from camswitcher_list_playlists.'),
      },
    },
    async (args): Promise<ToolResult> =>
      guard(async () =>
        jsonResult(await getVersioned('playlist_switch.cgi', { playlist_name: args.playlist_name })),
      ),
  );

  server.registerTool(
    'camswitcher_queue_playlist',
    {
      title: 'Queue a CamSwitcher playlist',
      description: 'Add a playlist to the end of the queue; it plays after the current one finishes.',
      inputSchema: {
        playlist_name: z.string().describe('The playlist/view name to queue.'),
      },
    },
    async (args): Promise<ToolResult> =>
      guard(async () =>
        jsonResult(await getVersioned('playlist_queue_push.cgi', { playlist_name: args.playlist_name })),
      ),
  );

  server.registerTool(
    'camswitcher_get_queue',
    {
      title: 'Get CamSwitcher queue',
      description: 'Return the current CamSwitcher playlist queue.',
      inputSchema: {},
    },
    async (): Promise<ToolResult> =>
      guard(async () => jsonResult(await getVersioned('playlist_queue_list.cgi'))),
  );

  server.registerTool(
    'camswitcher_play_next',
    {
      title: 'Skip to next queued playlist',
      description: 'Skip to the next playlist in the CamSwitcher queue.',
      inputSchema: {},
    },
    async (): Promise<ToolResult> =>
      guard(async () => jsonResult(await getVersioned('playlist_queue_play_next.cgi'))),
  );

  server.registerTool(
    'camswitcher_clear_queue',
    {
      title: 'Clear CamSwitcher queue',
      description: 'Clear the CamSwitcher playlist queue.',
      inputSchema: {},
    },
    async (): Promise<ToolResult> =>
      guard(async () => jsonResult(await getVersioned('playlist_queue_clear.cgi'))),
  );

  server.registerTool(
    'camswitcher_output_info',
    {
      title: 'Get CamSwitcher output info',
      description: 'Return the CamSwitcher output stream info (RTSP URL and WebSocket URL).',
      inputSchema: {},
    },
    async (): Promise<ToolResult> =>
      guard(async () => jsonResult(await get('/local/camswitcher/output_info.cgi'))),
  );

  server.registerTool(
    'camswitcher_list_clips',
    {
      title: 'List CamSwitcher clips',
      description: 'List available CamSwitcher video clips.',
      inputSchema: {},
    },
    async (): Promise<ToolResult> =>
      guard(async () => jsonResult(await getVersioned('clips.cgi', { action: 'get' }))),
  );
}
