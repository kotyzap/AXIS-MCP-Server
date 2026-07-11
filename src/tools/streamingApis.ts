// Streaming-adjacent VAPIX JSON-RPC APIs that aren't URL builders (those live in
// streaming.ts): Stream profiles, Stream status API, Media stream over HTTP
// (URL builder — the CGI itself returns a raw container stream, not JSON),
// MQTT client API, MQTT Event Bridge, Signed Video, and Analytics Metadata
// Producer Configuration.
// See:
//   https://developer.axis.com/vapix/network-video/stream-profiles/
//   https://developer.axis.com/vapix/network-video/stream-status-api/
//   https://developer.axis.com/vapix/network-video/media-stream-over-http/
//   https://developer.axis.com/vapix/network-video/mqtt-client-api/
//   https://developer.axis.com/vapix/network-video/mqtt-event-bridge/
//   https://developer.axis.com/vapix/network-video/signed-video/
//   https://developer.axis.com/vapix/network-video/analytics-metadata-producer-configuration/
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { vapix } from '../vapix';
import { loadSettings } from '../settings';
import { guard, jsonResult, errorResult, safeJson, parseParamResponse, ToolResult } from './util';

interface JsonRpcResponse {
  apiVersion?: string;
  context?: string;
  method?: string;
  data?: unknown;
  error?: { code: number; message: string };
}

function isJsonRpcResponse(x: unknown): x is JsonRpcResponse {
  return !!x && typeof x === 'object';
}

async function call(path: string, apiVersion: string, method: string, params?: Record<string, unknown>) {
  const res = await vapix({
    method: 'POST',
    path,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ apiVersion, context: 'axis-mcp', method, ...(params !== undefined ? { params } : {}) }),
  });
  return { status: res.status, response: safeJson(res.text()) };
}

function result(status: number, response: unknown, apiLabel: string): ToolResult {
  if (status === 404) return errorResult(`${apiLabel} not available on this model (404).`);
  if (!isJsonRpcResponse(response)) return errorResult(`Unexpected response from ${apiLabel} (HTTP ${status}).`);
  if (response.error) return errorResult(`${apiLabel} error ${response.error.code}: ${response.error.message}`);
  return jsonResult(response.data ?? {});
}

export function registerStreamingApiTools(server: McpServer): void {
  // ---- Stream profiles -------------------------------------------------------

  const STREAMPROFILE_PATH = '/axis-cgi/streamprofile.cgi';
  const streamProfileLabel = 'Stream profile API';

  server.registerTool(
    'streamprofile_list',
    {
      title: 'List stream profiles',
      description: 'List saved stream profiles (name, description, and the URL parameter string each one applies). Omit names for all profiles.',
      inputSchema: { names: z.array(z.string()).optional().describe('Profile names to look up. Omit or leave empty for all.') },
    },
    async (args): Promise<ToolResult> =>
      guard(async () => {
        const { status, response } = await call(STREAMPROFILE_PATH, '1.0', 'list', {
          streamProfileName: (args.names ?? []).map((name) => ({ name })),
        });
        return result(status, response, streamProfileLabel);
      }),
  );

  server.registerTool(
    'streamprofile_create',
    {
      title: 'Create stream profiles',
      description: 'Create one or more new stream profiles. Each name must be unique. "parameters" is a &-separated string of stream URL options, e.g. "resolution=1920x1080&fps=25".',
      inputSchema: {
        profiles: z.array(
          z.object({
            name: z.string(),
            description: z.string().optional(),
            parameters: z.string().describe('URL parameter string, e.g. "resolution=1920x1080&compression=30".'),
          }),
        ),
      },
    },
    async (args): Promise<ToolResult> =>
      guard(async () => {
        const { status, response } = await call(STREAMPROFILE_PATH, '1.0', 'create', { streamProfile: args.profiles });
        return result(status, response, streamProfileLabel);
      }),
  );

  server.registerTool(
    'streamprofile_update',
    {
      title: 'Update a stream profile',
      description: 'Update existing stream profiles by name. Cannot rename a profile — remove and re-create instead.',
      inputSchema: {
        profiles: z.array(
          z.object({
            name: z.string(),
            description: z.string().optional(),
            parameters: z.string().optional(),
          }),
        ),
      },
    },
    async (args): Promise<ToolResult> =>
      guard(async () => {
        const { status, response } = await call(STREAMPROFILE_PATH, '1.0', 'update', { streamProfile: args.profiles });
        return result(status, response, streamProfileLabel);
      }),
  );

  server.registerTool(
    'streamprofile_remove',
    {
      title: 'Remove stream profiles',
      description: 'Remove one or more stream profiles by name.',
      inputSchema: { names: z.array(z.string()).min(1) },
    },
    async (args): Promise<ToolResult> =>
      guard(async () => {
        const { status, response } = await call(STREAMPROFILE_PATH, '1.0', 'remove', {
          streamProfileName: args.names.map((name) => ({ name })),
        });
        return result(status, response, streamProfileLabel);
      }),
  );

  // ---- Stream status API -----------------------------------------------------

  server.registerTool(
    'streamstatus_list',
    {
      title: 'List running streams',
      description:
        'List all currently running RTSP streams on the device: client/server address and port, media type, codec, transport, encryption, and playback state. Useful to see who is currently pulling video/audio.',
      inputSchema: {},
    },
    async (): Promise<ToolResult> =>
      guard(async () => {
        const { status, response } = await call('/axis-cgi/streamstatus.cgi', '1.0', 'getAllStreams');
        return result(status, response, 'Stream status API');
      }),
  );

  // ---- Media stream over HTTP (URL builder) ----------------------------------

  server.registerTool(
    'media_get_stream_url',
    {
      title: 'Build a media.cgi stream URL',
      description:
        'Construct a /axis-cgi/media.cgi URL that returns a Matroska or MP4 container stream playable directly by VLC/ffplay/HTML5 <video>, ' +
        'as an alternative to the raw RTSP/MJPEG URL builders in get_rtsp_url/get_mjpeg_url. This tool only builds the URL; fetching it opens a ' +
        'long-lived stream, not a single JSON response.',
      inputSchema: {
        host: z.string().optional().describe('Camera network address. Defaults to the configured VAPIX host (often 127.0.0.1 on-device).'),
        container: z.enum(['matroska', 'mp4']).optional(),
        video: z.boolean().optional(),
        audio: z.boolean().optional(),
        camera: z.union([z.number(), z.string()]).optional().describe('Video source index (multi-sensor products only).'),
        resolution: z.string().optional().describe('WxH, e.g. 1920x1080.'),
        fps: z.number().optional(),
        videocodec: z.enum(['h264', 'h265']).optional(),
        audiocodec: z.enum(['aac', 'opus']).optional(),
        compression: z.number().min(0).max(100).optional(),
        rotation: z.union([z.literal(0), z.literal(90), z.literal(180), z.literal(270)]).optional(),
        streamprofile: z.string().optional().describe('Name of a saved stream profile (see streamprofile_list) to apply.'),
      },
    },
    async (args): Promise<ToolResult> =>
      guard(async () => {
        const host = args.host || loadSettings().vapixHost || '127.0.0.1';
        const params = new URLSearchParams();
        if (args.container) params.set('container', args.container);
        if (args.video !== undefined) params.set('video', args.video ? '1' : '0');
        if (args.audio !== undefined) params.set('audio', args.audio ? '1' : '0');
        if (args.camera !== undefined) params.set('camera', String(args.camera));
        if (args.resolution) params.set('resolution', args.resolution);
        if (args.fps !== undefined) params.set('fps', String(args.fps));
        if (args.videocodec) params.set('videocodec', args.videocodec);
        if (args.audiocodec) params.set('audiocodec', args.audiocodec);
        if (args.compression !== undefined) params.set('compression', String(args.compression));
        if (args.rotation !== undefined) params.set('rotation', String(args.rotation));
        if (args.streamprofile) params.set('streamprofile', args.streamprofile);
        const qs = params.toString();
        return jsonResult({ url: `http://${host}/axis-cgi/media.cgi${qs ? '?' + qs : ''}` });
      }),
  );

  // ---- MQTT client API --------------------------------------------------------

  const MQTT_CLIENT_PATH = '/axis-cgi/mqtt/client.cgi';
  const mqttClientLabel = 'MQTT client API';

  const mqttMessageSchema = z
    .object({
      useDefault: z.boolean().optional(),
      topic: z.string().optional(),
      message: z.string().optional(),
      retain: z.boolean().optional(),
      qos: z.union([z.literal(0), z.literal(1), z.literal(2)]).optional(),
    })
    .optional();

  server.registerTool(
    'mqtt_configure_client',
    {
      title: 'Configure the MQTT client',
      description:
        'Configure the device MQTT client (broker address/protocol, credentials, client ID, keep-alive, last-will/connect/disconnect messages, TLS options). ' +
        'Does not activate the client — call mqtt_activate_client afterwards.',
      inputSchema: {
        server: z.object({
          protocol: z.enum(['tcp', 'ssl', 'ws', 'wss']),
          host: z.string(),
          port: z.number().int().optional(),
          basepath: z.string().optional(),
          alpnProtocol: z.string().optional(),
        }),
        httpProxy: z.string().optional(),
        httpsProxy: z.string().optional(),
        username: z.string().optional(),
        password: z.string().optional(),
        keepExistingPassword: z.boolean().optional(),
        clientId: z.string().optional(),
        keepAliveInterval: z.number().int().optional(),
        connectTimeout: z.number().int().optional(),
        cleanSession: z.boolean().optional(),
        autoReconnect: z.boolean().optional(),
        deviceTopicPrefix: z.string().optional(),
        lastWillTestament: mqttMessageSchema,
        connectMessage: mqttMessageSchema,
        disconnectMessage: mqttMessageSchema,
        ssl: z
          .object({
            validateServerCert: z.boolean().optional(),
            clientCertID: z.string().optional(),
            CACertID: z.string().optional(),
          })
          .optional(),
      },
    },
    async (args): Promise<ToolResult> =>
      guard(async () => {
        const { status, response } = await call(MQTT_CLIENT_PATH, '1.0', 'configureClient', args as Record<string, unknown>);
        return result(status, response, mqttClientLabel);
      }),
  );

  server.registerTool(
    'mqtt_activate_client',
    {
      title: 'Activate the MQTT client',
      description: 'Activate the configured MQTT client (connect to the broker). Remains active across reboots until deactivated.',
      inputSchema: {},
    },
    async (): Promise<ToolResult> =>
      guard(async () => {
        const { status, response } = await call(MQTT_CLIENT_PATH, '1.0', 'activateClient');
        return result(status, response, mqttClientLabel);
      }),
  );

  server.registerTool(
    'mqtt_deactivate_client',
    {
      title: 'Deactivate the MQTT client',
      description: 'Deactivate the MQTT client and disconnect from the broker.',
      inputSchema: {},
    },
    async (): Promise<ToolResult> =>
      guard(async () => {
        const { status, response } = await call(MQTT_CLIENT_PATH, '1.0', 'deactivateClient');
        return result(status, response, mqttClientLabel);
      }),
  );

  server.registerTool(
    'mqtt_get_client_status',
    {
      title: 'Get MQTT client status',
      description: 'Get the MQTT client\'s current state (active/inactive), connection status (connected/disconnected), and its full configuration (password redacted).',
      inputSchema: {},
    },
    async (): Promise<ToolResult> =>
      guard(async () => {
        const { status, response } = await call(MQTT_CLIENT_PATH, '1.0', 'getClientStatus');
        return result(status, response, mqttClientLabel);
      }),
  );

  // ---- MQTT Event Bridge ------------------------------------------------------

  const MQTT_EVENT_PATH = '/axis-cgi/mqtt/event.cgi';
  const mqttEventLabel = 'MQTT Event Bridge';

  server.registerTool(
    'mqtt_configure_event_publication',
    {
      title: 'Configure Event-to-MQTT publishing',
      description:
        'Select which Event Service events get published as MQTT messages, and how (topic prefix, whether to append the event topic, ONVIF namespaces, serial number in payload, per-filter QoS/retain). ' +
        'Publication is only enabled once at least one event filter is set. Filtering is topic-only — payload filtering is not supported.',
      inputSchema: {
        topicPrefix: z.enum(['default', 'custom']).optional(),
        customTopicPrefix: z.string().optional().describe('Required if topicPrefix is "custom".'),
        appendEventTopic: z.boolean().optional(),
        includeTopicNamespaces: z.boolean().optional(),
        includeSerialNumberInPayload: z.boolean().optional(),
        eventFilterList: z.array(
          z.object({
            topicFilter: z.string().describe('ONVIF concrete topic expression, e.g. "onvif:Device/axis:Status/SystemReady" or "onvif:Device/axis:IO//.".'),
            qos: z.union([z.literal(0), z.literal(1), z.literal(2)]).optional(),
            retain: z.enum(['none', 'property', 'all']).optional(),
          }),
        ),
      },
    },
    async (args): Promise<ToolResult> =>
      guard(async () => {
        const { status, response } = await call(MQTT_EVENT_PATH, '1.0', 'configureEventPublication', args as Record<string, unknown>);
        return result(status, response, mqttEventLabel);
      }),
  );

  server.registerTool(
    'mqtt_get_event_publication_config',
    {
      title: 'Get Event-to-MQTT publishing config',
      description: 'Get the current Event Service → MQTT publication configuration.',
      inputSchema: {},
    },
    async (): Promise<ToolResult> =>
      guard(async () => {
        const { status, response } = await call(MQTT_EVENT_PATH, '1.0', 'getEventPublicationConfig');
        return result(status, response, mqttEventLabel);
      }),
  );

  server.registerTool(
    'mqtt_configure_subscription',
    {
      title: 'Configure MQTT-to-Event subscription',
      description:
        'Subscribe to MQTT topics on the broker and convert matching incoming messages into internal Event Service events, so they can trigger rules/actions. ' +
        '"+"/"#" wildcards are only allowed for stateless (isStateData=false) conversions.',
      inputSchema: {
        mqttFilterList: z.array(
          z.object({
            topicFilter: z.string(),
            useDeviceTopicPrefix: z.boolean().optional(),
            qos: z.union([z.literal(0), z.literal(1), z.literal(2)]).optional(),
            isStateData: z.boolean().optional().describe('true = stateful/property event, false = stateless event (default).'),
          }),
        ),
      },
    },
    async (args): Promise<ToolResult> =>
      guard(async () => {
        const { status, response } = await call(MQTT_EVENT_PATH, '1.1', 'configureMqttSubscription', { mqttFilterList: args.mqttFilterList });
        return result(status, response, mqttEventLabel);
      }),
  );

  server.registerTool(
    'mqtt_get_subscription_config',
    {
      title: 'Get MQTT-to-Event subscription config',
      description: 'Get the current MQTT → Event Service subscription configuration.',
      inputSchema: {},
    },
    async (): Promise<ToolResult> =>
      guard(async () => {
        const { status, response } = await call(MQTT_EVENT_PATH, '1.1', 'getMqttSubscriptionConfig');
        return result(status, response, mqttEventLabel);
      }),
  );

  // ---- Signed Video -----------------------------------------------------------
  // Config lives in Image.I#.MPEG.SignedVideo.Enabled (param.cgi), not a
  // dedicated CGI. There is also a per-stream "videosigned=1" RTSP URL option
  // (see get_rtsp_url in streaming.ts — pass it via a manual query string if
  // needed, since it isn't one of that tool's named options).

  server.registerTool(
    'signedvideo_get',
    {
      title: 'Get Signed Video status',
      description: 'Check whether Signed Video (cryptographic tamper-evidence for exported footage) is enabled for a video channel.',
      inputSchema: { channel: z.number().int().min(0).default(0) },
    },
    async (args): Promise<ToolResult> =>
      guard(async () => {
        const res = await vapix({
          method: 'GET',
          path: '/axis-cgi/param.cgi',
          query: { action: 'list', group: `Image.I${args.channel}.MPEG.SignedVideo` },
        });
        if (res.status < 200 || res.status >= 300) return errorResult(`param.cgi failed (HTTP ${res.status}): ${res.text().slice(0, 300)}`);
        return jsonResult(parseParamResponse(res.text()));
      }),
  );

  server.registerTool(
    'signedvideo_set',
    {
      title: 'Enable / disable Signed Video',
      description: 'Enable or disable Signed Video by default for a video channel.',
      inputSchema: { channel: z.number().int().min(0).default(0), enabled: z.boolean() },
    },
    async (args): Promise<ToolResult> =>
      guard(async () => {
        const res = await vapix({
          method: 'GET',
          path: '/axis-cgi/param.cgi',
          query: { action: 'update', [`Image.I${args.channel}.MPEG.SignedVideo.Enabled`]: args.enabled ? 'yes' : 'no' },
        });
        if (res.status < 200 || res.status >= 300) return errorResult(`param.cgi update failed (HTTP ${res.status}): ${res.text().slice(0, 300)}`);
        return jsonResult({ ok: res.text().trim() === 'OK', response: res.text().trim() });
      }),
  );

  // ---- Analytics Metadata Producer Configuration ------------------------------

  const METADATA_PATH = '/axis-cgi/analyticsmetadataconfig.cgi';
  const metadataLabel = 'Analytics Metadata Producer Configuration API';

  server.registerTool(
    'metadataproducer_list',
    {
      title: 'List RTSP metadata producers',
      description:
        'List available RTSP analytics metadata producers (ONVIF XML metadata sources such as AOA/VMD) and, for each, which video channels they support and whether they are currently enabled in the RTSP metadata stream.',
      inputSchema: { producers: z.array(z.string()).optional().describe('Producer names to look up. Omit for all.') },
    },
    async (args): Promise<ToolResult> =>
      guard(async () => {
        const { status, response } = await call(METADATA_PATH, '1.0', 'listProducers', args.producers ? { producers: args.producers } : {});
        return result(status, response, metadataLabel);
      }),
  );

  server.registerTool(
    'metadataproducer_set_enabled',
    {
      title: 'Enable / disable RTSP metadata producers',
      description: 'Enable or disable specific metadata producers on specific video channels in the RTSP metadata stream.',
      inputSchema: {
        producers: z.array(
          z.object({
            name: z.string(),
            videochannels: z.array(z.object({ channel: z.number().int(), enabled: z.boolean() })),
          }),
        ),
      },
    },
    async (args): Promise<ToolResult> =>
      guard(async () => {
        const { status, response } = await call(METADATA_PATH, '1.0', 'setEnabledProducers', { producers: args.producers });
        return result(status, response, metadataLabel);
      }),
  );

  server.registerTool(
    'metadataproducer_get_sample',
    {
      title: 'Get a sample metadata frame',
      description: 'Get a sample ONVIF XML metadata frame for one or more producers, to preview what they emit in the RTSP metadata stream.',
      inputSchema: { producers: z.array(z.string()).optional().describe('Producer names. Omit for all.') },
    },
    async (args): Promise<ToolResult> =>
      guard(async () => {
        const { status, response } = await call(METADATA_PATH, '1.0', 'getSupportedMetadata', { producers: args.producers ?? [] });
        return result(status, response, metadataLabel);
      }),
  );
}
