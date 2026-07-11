// VAPIX Zipstream technology API — bit rate reduction tuning for H.264/H.265
// streams (strength, GOP mode, FPS mode, profiles).
// See https://developer.axis.com/vapix/network-video/zipstream-technology/
//
// Legacy-style GET CGIs under /axis-cgi/zipstream/*.cgi, XML request/response
// (not the newer Google-JSON-style APIs). All calls take schemaversion=1 and
// an optional camera=<channel> (omitted = all channels).
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { vapix } from '../vapix';
import { guard, jsonResult, errorResult, extractXmlBlocks, extractXmlTagAll, parseFlatXml, xmlGeneralError, ToolResult } from './util';

const BASE = '/axis-cgi/zipstream';

async function zipstreamGet(cgi: string, query: Record<string, string | number | undefined>) {
  return vapix({ method: 'GET', path: `${BASE}/${cgi}`, query: { schemaversion: 1, ...query } });
}

function zipstreamResult(status: number, xml: string, onSuccess: (xml: string) => unknown): ToolResult {
  if (status === 404) return errorResult('Zipstream technology API not available on this model (404).');
  const err = xmlGeneralError(xml);
  if (err) return errorResult(`Zipstream error ${err.code}: ${err.description}`);
  if (status < 200 || status >= 300) return errorResult(`Zipstream CGI failed (HTTP ${status}): ${xml.slice(0, 300)}`);
  return jsonResult(onSuccess(xml));
}

export function registerZipstreamTools(server: McpServer): void {
  server.registerTool(
    'zipstream_get_status',
    {
      title: 'Get Zipstream status',
      description: 'Get the current Zipstream settings (strength, GOP mode/length, FPS mode/min-FPS, profile) for one channel or all channels.',
      inputSchema: { camera: z.union([z.number(), z.string()]).optional().describe('Video channel. Omit for all channels.') },
    },
    async (args): Promise<ToolResult> =>
      guard(async () => {
        const res = await zipstreamGet('getstatus.cgi', { camera: args.camera });
        return zipstreamResult(res.status, res.text(), (xml) => ({
          channels: extractXmlBlocks(xml, 'Status').map(parseFlatXml),
        }));
      }),
  );

  server.registerTool(
    'zipstream_list_strengths',
    {
      title: 'List valid Zipstream strengths',
      description: 'List the Zipstream strength values this device accepts (e.g. off, 10, 20, 30, 40, 50).',
      inputSchema: {},
    },
    async (): Promise<ToolResult> =>
      guard(async () => {
        const res = await zipstreamGet('liststrengths.cgi', {});
        return zipstreamResult(res.status, res.text(), (xml) => ({ strengths: extractXmlTagAll(xml, 'Strength') }));
      }),
  );

  server.registerTool(
    'zipstream_set_strength',
    {
      title: 'Set Zipstream strength',
      description: 'Set the Zipstream strength (bit rate reduction amount) for one channel or all channels. Applies to new streams only.',
      inputSchema: {
        strength: z.string().describe('One of the values from zipstream_list_strengths, e.g. "off", "10", "30".'),
        camera: z.union([z.number(), z.string()]).optional().describe('Video channel. Omit for all channels.'),
      },
    },
    async (args): Promise<ToolResult> =>
      guard(async () => {
        const res = await zipstreamGet('setstrength.cgi', { strength: args.strength, camera: args.camera });
        return zipstreamResult(res.status, res.text(), () => ({ ok: true }));
      }),
  );

  server.registerTool(
    'zipstream_list_gop_modes',
    {
      title: 'List Zipstream GOP modes',
      description: 'List the available Zipstream GOP (group of pictures) modes: fixed or dynamic.',
      inputSchema: {},
    },
    async (): Promise<ToolResult> =>
      guard(async () => {
        const res = await zipstreamGet('listgopmodes.cgi', {});
        return zipstreamResult(res.status, res.text(), (xml) => ({ gopModes: extractXmlTagAll(xml, 'GopMode') }));
      }),
  );

  server.registerTool(
    'zipstream_set_gop',
    {
      title: 'Set Zipstream GOP settings',
      description: 'Set the Zipstream GOP mode and/or maximum GOP length for one channel or all channels. Applies to new streams only.',
      inputSchema: {
        gopmode: z.enum(['fixed', 'dynamic']).optional().describe('GOP mode. Omit to keep current value.'),
        maxgoplength: z.number().int().min(1).max(1023).optional().describe('Max GOP length (1-1023, dynamic mode only). Omit to keep current value.'),
        camera: z.union([z.number(), z.string()]).optional().describe('Video channel. Omit for all channels.'),
      },
    },
    async (args): Promise<ToolResult> =>
      guard(async () => {
        if (args.gopmode === undefined && args.maxgoplength === undefined) return errorResult('Provide gopmode and/or maxgoplength.');
        const res = await zipstreamGet('setgop.cgi', { gopmode: args.gopmode, maxgoplength: args.maxgoplength, camera: args.camera });
        return zipstreamResult(res.status, res.text(), () => ({ ok: true }));
      }),
  );

  server.registerTool(
    'zipstream_list_fps_modes',
    {
      title: 'List Zipstream FPS modes',
      description: 'List the available Zipstream FPS modes: fixed or dynamic.',
      inputSchema: {},
    },
    async (): Promise<ToolResult> =>
      guard(async () => {
        const res = await zipstreamGet('listfpsmodes.cgi', {});
        return zipstreamResult(res.status, res.text(), (xml) => ({ fpsModes: extractXmlTagAll(xml, 'FpsMode') }));
      }),
  );

  server.registerTool(
    'zipstream_set_fps_mode',
    {
      title: 'Set Zipstream FPS mode',
      description: 'Set the Zipstream FPS mode (fixed or dynamic) for one channel or all channels.',
      inputSchema: {
        fpsmode: z.enum(['fixed', 'dynamic']),
        camera: z.union([z.number(), z.string()]).optional().describe('Video channel. Omit for all channels.'),
      },
    },
    async (args): Promise<ToolResult> =>
      guard(async () => {
        const res = await zipstreamGet('setfpsmode.cgi', { fpsmode: args.fpsmode, camera: args.camera });
        return zipstreamResult(res.status, res.text(), () => ({ ok: true }));
      }),
  );

  server.registerTool(
    'zipstream_set_min_fps',
    {
      title: 'Set Zipstream minimum FPS',
      description: 'Set the minimum dynamic frame rate for Zipstream (only relevant when FPS mode is dynamic).',
      inputSchema: {
        minfps: z.number().int().min(0).describe('Minimum FPS. 0 = no floor.'),
        camera: z.union([z.number(), z.string()]).optional().describe('Video channel. Omit for all channels.'),
      },
    },
    async (args): Promise<ToolResult> =>
      guard(async () => {
        const res = await zipstreamGet('setminfps.cgi', { minfps: args.minfps, camera: args.camera });
        return zipstreamResult(res.status, res.text(), () => ({ ok: true }));
      }),
  );

  server.registerTool(
    'zipstream_list_profiles',
    {
      title: 'List Zipstream profiles',
      description: 'List the available Zipstream profiles (classic / storage / networkloadbalancing) with their max feature level.',
      inputSchema: {},
    },
    async (): Promise<ToolResult> =>
      guard(async () => {
        const res = await zipstreamGet('listprofiles.cgi', {});
        return zipstreamResult(res.status, res.text(), (xml) => ({
          profiles: extractXmlBlocks(xml, 'Profile').map(parseFlatXml),
        }));
      }),
  );

  server.registerTool(
    'zipstream_set_profile',
    {
      title: 'Set Zipstream profile',
      description:
        'Set the Zipstream profile: classic (manual control), storage (optimizes bitrate for storage use cases), ' +
        'or networkloadbalancing (optimizes for loaded networks, smaller/more-frequent refresh frames).',
      inputSchema: {
        profile: z.enum(['classic', 'storage', 'networkloadbalancing']),
        profilelevel: z.number().int().optional().describe('Feature level for the profile (0 = highest available). See zipstream_list_profiles.'),
        gradualdecoderefresh: z.enum(['auto', 'low', 'balanced', 'extreme']).optional().describe('Only used with the networkloadbalancing profile.'),
        camera: z.union([z.number(), z.string()]).optional().describe('Video channel. Omit for all channels.'),
      },
    },
    async (args): Promise<ToolResult> =>
      guard(async () => {
        const res = await zipstreamGet('setprofile.cgi', {
          profile: args.profile,
          profilelevel: args.profilelevel,
          gradualdecoderefresh: args.gradualdecoderefresh,
          camera: args.camera,
        });
        return zipstreamResult(res.status, res.text(), () => ({ ok: true }));
      }),
  );
}
