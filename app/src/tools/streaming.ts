// Stream URL builders (RTSP/MJPEG/audio) and audio configuration.
//
// Video/audio streaming endpoints are long-lived connections, not
// request/response calls, so these tools return ready-to-use URLs for an
// external player/client rather than fetching the stream themselves (the one
// exception, a single JPEG frame, is `take_snapshot` in imaging.ts).
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { vapix } from '../vapix';
import { loadSettings } from '../settings';
import { guard, jsonResult, parseParamResponse, ToolResult } from './util';

function resolveHost(override?: string): string {
  return override || loadSettings().vapixHost || '127.0.0.1';
}

export function registerStreamingTools(server: McpServer): void {
  server.registerTool(
    'get_rtsp_url',
    {
      title: 'Build an RTSP stream URL',
      description:
        'Construct an RTSP URL (rtsp://host/axis-media/media.amp) with the requested camera/resolution/fps/codec/audio options. ' +
        'If running on-device, the configured VAPIX host is usually 127.0.0.1 — pass "host" explicitly with the camera\'s real network address for a URL any external RTSP client can use.',
      inputSchema: {
        host: z.string().optional().describe("Camera network address as seen by the RTSP client. Defaults to the configured VAPIX host (often 127.0.0.1 on-device)."),
        camera: z.union([z.number(), z.string()]).optional().describe('Video source / channel index.'),
        resolution: z.string().optional().describe('WxH, e.g. 1920x1080.'),
        fps: z.number().optional().describe('Target frame rate.'),
        videocodec: z.enum(['h264', 'h265']).optional(),
        audio: z.boolean().optional().describe('Include an audio track.'),
        include_credentials: z.boolean().optional().describe('Embed VAPIX user:pass in the URL (rtsp://user:pass@host/...). Off by default.'),
      },
    },
    async (args): Promise<ToolResult> =>
      guard(async () => {
        const host = resolveHost(args.host);
        const s = loadSettings();
        const auth = args.include_credentials && s.vapixUser ? `${encodeURIComponent(s.vapixUser)}:${encodeURIComponent(s.vapixPass)}@` : '';
        const params = new URLSearchParams();
        if (args.camera !== undefined) params.set('camera', String(args.camera));
        if (args.resolution) params.set('resolution', args.resolution);
        if (args.fps !== undefined) params.set('fps', String(args.fps));
        if (args.videocodec) params.set('videocodec', args.videocodec);
        if (args.audio !== undefined) params.set('audio', args.audio ? '1' : '0');
        const qs = params.toString();
        const url = `rtsp://${auth}${host}/axis-media/media.amp${qs ? '?' + qs : ''}`;
        return jsonResult({ url });
      }),
  );

  server.registerTool(
    'get_mjpeg_url',
    {
      title: 'Build an MJPEG stream URL',
      description: 'Construct an HTTP MJPEG stream URL (axis-cgi/mjpg/video.cgi) with the requested options.',
      inputSchema: {
        host: z.string().optional().describe('Camera network address. Defaults to the configured VAPIX host.'),
        camera: z.union([z.number(), z.string()]).optional(),
        resolution: z.string().optional().describe('WxH, e.g. 1280x720.'),
        fps: z.number().optional(),
        compression: z.number().min(0).max(100).optional(),
        color: z.boolean().optional().describe('false = grayscale.'),
      },
    },
    async (args): Promise<ToolResult> =>
      guard(async () => {
        const host = resolveHost(args.host);
        const params = new URLSearchParams();
        if (args.camera !== undefined) params.set('camera', String(args.camera));
        if (args.resolution) params.set('resolution', args.resolution);
        if (args.fps !== undefined) params.set('fps', String(args.fps));
        if (args.compression !== undefined) params.set('compression', String(args.compression));
        if (args.color !== undefined) params.set('color', args.color ? '1' : '0');
        const qs = params.toString();
        const url = `http://${host}/axis-cgi/mjpg/video.cgi${qs ? '?' + qs : ''}`;
        return jsonResult({ url });
      }),
  );

  server.registerTool(
    'get_audio_config',
    {
      title: 'Get audio configuration',
      description: 'Read AudioSource/AudioDevice/AudioOutput parameters (input gain, codec, sample rate, output volume, etc.) via param.cgi.',
      inputSchema: {},
    },
    async (): Promise<ToolResult> =>
      guard(async () => {
        const res = await vapix({
          method: 'GET',
          path: '/axis-cgi/param.cgi',
          query: { action: 'list', group: 'AudioSource,AudioDevice,AudioOutput' },
        });
        return jsonResult(parseParamResponse(res.text()));
      }),
  );

  server.registerTool(
    'get_audio_urls',
    {
      title: 'Build audio stream URLs',
      description:
        'Construct the camera-to-client audio receive URL (axis-cgi/audio/receive.cgi) and the client-to-camera transmit URL (axis-cgi/audio/transmit.cgi). Both are raw duplex audio streams for use by an audio-capable client, not JSON responses.',
      inputSchema: {
        host: z.string().optional().describe('Camera network address. Defaults to the configured VAPIX host.'),
      },
    },
    async (args): Promise<ToolResult> =>
      guard(async () => {
        const host = resolveHost(args.host);
        return jsonResult({
          receive: `http://${host}/axis-cgi/audio/receive.cgi`,
          transmit: `http://${host}/axis-cgi/audio/transmit.cgi`,
          note: 'Digest auth required. Use an audio-capable HTTP client (these are continuous streams, not single responses).',
        });
      }),
  );
}
