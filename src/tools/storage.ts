// SD/network storage recording tools (axis-cgi/record/*.cgi).
// Requires local storage (SD card or configured network share) on the device.
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { vapix } from '../vapix';
import { guard, jsonResult, errorResult, safeJson, ToolResult } from './util';

export function registerStorageTools(server: McpServer): void {
  server.registerTool(
    'storage_list_recordings',
    {
      title: 'List recordings',
      description: 'List stored recordings on the camera (SD card / network share) via record/list.cgi.',
      inputSchema: {
        diskid: z.string().optional().describe('Restrict to a specific disk id (e.g. SD_DISK).'),
        recordingid: z.string().optional().describe('Restrict to a specific recording id.'),
      },
    },
    async (args): Promise<ToolResult> =>
      guard(async () => {
        const res = await vapix({
          method: 'GET',
          path: '/axis-cgi/record/list.cgi',
          query: { diskid: args.diskid, recordingid: args.recordingid },
        });
        if (res.status === 404) return errorResult('record/list.cgi not available — is local storage configured?');
        return jsonResult({ status: res.status, data: safeJson(res.text()) });
      }),
  );

  server.registerTool(
    'storage_start_recording',
    {
      title: 'Start a recording',
      description: 'Start recording video to local storage via record/record.cgi?action=start.',
      inputSchema: {
        camera: z.union([z.number(), z.string()]).optional().describe('Video source / channel index.'),
        diskid: z.string().optional().describe('Target disk id (e.g. SD_DISK). Omit for the default.'),
      },
    },
    async (args): Promise<ToolResult> =>
      guard(async () => {
        const res = await vapix({
          method: 'GET',
          path: '/axis-cgi/record/record.cgi',
          query: { action: 'start', camera: args.camera !== undefined ? String(args.camera) : undefined, diskid: args.diskid },
        });
        if (res.status === 404) return errorResult('record/record.cgi not available — is local storage configured?');
        return jsonResult({ status: res.status, response: safeJson(res.text()) });
      }),
  );

  server.registerTool(
    'storage_stop_recording',
    {
      title: 'Stop a recording',
      description: 'Stop an active recording via record/record.cgi?action=stop.',
      inputSchema: {
        recordingid: z.string().optional().describe('Specific recording id to stop. Omit to stop the active recording on the default channel.'),
      },
    },
    async (args): Promise<ToolResult> =>
      guard(async () => {
        const res = await vapix({
          method: 'GET',
          path: '/axis-cgi/record/record.cgi',
          query: { action: 'stop', recordingid: args.recordingid },
        });
        if (res.status === 404) return errorResult('record/record.cgi not available — is local storage configured?');
        return jsonResult({ status: res.status, response: safeJson(res.text()) });
      }),
  );
}
