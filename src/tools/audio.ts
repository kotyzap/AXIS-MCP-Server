// Audio system tools: Audio API (config knobs beyond what streaming.ts already
// reads), Audio Device Control, Audio Analytics, Audio mixer API, and Media
// clip API. This camera already has audio in/out — these are the dedicated
// VAPIX APIs for it, on top of streaming.ts's existing read-only
// get_audio_config and the raw stream URLs in get_audio_urls.
//
// Not implemented (see ROADMAP.md for the full rationale): Audio control
// service API and Audio relay service API (both deprecated since AXIS OS
// 10.12), Audio Multicast Controller (BETA, built for multi-speaker paging
// networks), Auto speaker test service API (speaker-hardware calibration,
// narrow diagnostic use case), AXIS Audio Manager Edge/Pro APIs (these talk to
// separate site-management software products, not a camera-resident CGI).
//
// See:
//   https://developer.axis.com/vapix/audio-systems/audio-api/
//   https://developer.axis.com/vapix/audio-systems/audio-device-control/
//   https://developer.axis.com/vapix/audio-systems/audio-analytics/
//   https://developer.axis.com/vapix/audio-systems/audio-mixer-api/
//   https://developer.axis.com/vapix/audio-systems/media-clip-api/
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { vapix } from '../vapix';
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

async function paramUpdate(fields: Record<string, string | number | boolean | undefined>): Promise<ToolResult> {
  const query: Record<string, string> = { action: 'update' };
  for (const [k, v] of Object.entries(fields)) {
    if (v !== undefined) query[k] = typeof v === 'boolean' ? (v ? 'yes' : 'no') : String(v);
  }
  const res = await vapix({ method: 'GET', path: '/axis-cgi/param.cgi', query });
  if (res.status < 200 || res.status >= 300) return errorResult(`param.cgi update failed (HTTP ${res.status}): ${res.text().slice(0, 300)}`);
  return jsonResult({ ok: res.text().trim() === 'OK', response: res.text().trim() });
}

export function registerAudioTools(server: McpServer): void {
  // ---- Audio API (param.cgi: Audio.* / AudioSource.*) -------------------------

  server.registerTool(
    'audio_get_settings',
    {
      title: 'Get audio settings',
      description:
        'Read the full Audio.*, AudioSource.* and Properties.Audio.* parameter groups: global duplex mode/max listeners/DSCP, per-configuration ' +
        'enable state, and per-source codec/gain/input type/sample rate. More complete than get_audio_config in streaming.ts.',
      inputSchema: {},
    },
    async (): Promise<ToolResult> =>
      guard(async () => {
        const res = await vapix({ method: 'GET', path: '/axis-cgi/param.cgi', query: { action: 'list', group: 'Audio,AudioSource,Properties.Audio' } });
        if (res.status < 200 || res.status >= 300) return errorResult(`param.cgi failed (HTTP ${res.status}): ${res.text().slice(0, 300)}`);
        return jsonResult(parseParamResponse(res.text()));
      }),
  );

  server.registerTool(
    'audio_set_enabled',
    {
      title: 'Enable / disable audio',
      description:
        'Enable or disable audio end-to-end: sets both AudioSource.A{sourceIndex}.AudioSupport and Audio.A{configIndex}.Enabled, ' +
        'which the VAPIX docs specify must both be "yes" for audio to actually stream.',
      inputSchema: {
        configIndex: z.number().int().min(0).default(0).describe('Audio.A# index.'),
        sourceIndex: z.number().int().min(0).default(0).describe('AudioSource.A# index.'),
        enabled: z.boolean(),
      },
    },
    async (args): Promise<ToolResult> =>
      paramUpdate({
        [`AudioSource.A${args.sourceIndex}.AudioSupport`]: args.enabled,
        [`Audio.A${args.configIndex}.Enabled`]: args.enabled,
      }),
  );

  server.registerTool(
    'audio_configure_source',
    {
      title: 'Configure an audio source',
      description:
        'Configure a physical audio source (AudioSource.A#): name, codec, input type, gain, sample rate, bit rate, microphone power, etc. Only supplied fields are changed.',
      inputSchema: {
        index: z.number().int().min(0).default(0),
        name: z.string().optional(),
        audioEncoding: z.enum(['g711', 'g726', 'aac', 'opus', 'lpcm']).optional(),
        inputType: z.enum(['internal', 'mic', 'line', 'digital']).optional(),
        microphonePower: z.boolean().optional(),
        inputGain: z.union([z.number(), z.literal('mute')]).optional(),
        inputPreGain: z.enum(['low', 'high']).optional(),
        outputGain: z.union([z.number(), z.literal('mute')]).optional(),
        sampleRate: z.union([z.literal(8000), z.literal(16000), z.literal(32000), z.literal(44100), z.literal(48000)]).optional(),
        bitRate: z.number().int().optional(),
        microphoneBalanced: z.boolean().optional(),
        speakerAmp: z.boolean().optional(),
      },
    },
    async (args): Promise<ToolResult> => {
      const i = args.index;
      return paramUpdate({
        [`AudioSource.A${i}.Name`]: args.name,
        [`AudioSource.A${i}.AudioEncoding`]: args.audioEncoding,
        [`AudioSource.A${i}.InputType`]: args.inputType,
        [`AudioSource.A${i}.MicrophonePower`]: args.microphonePower,
        [`AudioSource.A${i}.InputGain`]: args.inputGain,
        [`AudioSource.A${i}.InputPreGain`]: args.inputPreGain,
        [`AudioSource.A${i}.OutputGain`]: args.outputGain,
        [`AudioSource.A${i}.SampleRate`]: args.sampleRate,
        [`AudioSource.A${i}.BitRate`]: args.bitRate,
        [`AudioSource.A${i}.MicrophoneBalanced`]: args.microphoneBalanced,
        [`AudioSource.A${i}.SpeakerAmp`]: args.speakerAmp,
      });
    },
  );

  server.registerTool(
    'audio_configure_stream',
    {
      title: 'Configure an audio stream configuration',
      description: 'Configure an audio stream configuration (Audio.A#): name, HTTP message type, source, number of channels. Only supplied fields are changed.',
      inputSchema: {
        index: z.number().int().min(0).default(0),
        name: z.string().optional(),
        httpMessageType: z.enum(['singlepart', 'multipart']).optional(),
        source: z.number().int().optional().describe('Which AudioSource.A# index this configuration uses.'),
        nbrOfChannels: z.union([z.literal(1), z.literal(2)]).optional(),
      },
    },
    async (args): Promise<ToolResult> => {
      const i = args.index;
      return paramUpdate({
        [`Audio.A${i}.Name`]: args.name,
        [`Audio.A${i}.HTTPMessageType`]: args.httpMessageType,
        [`Audio.A${i}.Source`]: args.source,
        [`Audio.A${i}.NbrOfChannels`]: args.nbrOfChannels,
      });
    },
  );

  server.registerTool(
    'audio_set_global_settings',
    {
      title: 'Set global audio settings',
      description: 'Set device-wide audio settings: duplex mode, max simultaneous listeners, receiver buffer/timeout, and DSCP QoS marking. Only supplied fields are changed.',
      inputSchema: {
        duplexMode: z.enum(['full', 'half', 'get', 'post']).optional(),
        maxListeners: z.number().int().min(0).max(20).optional(),
        receiverBuffer: z.number().int().min(0).max(9999).optional(),
        receiverTimeout: z.number().int().min(0).max(9999).optional(),
        dscp: z.number().int().min(0).max(63).optional(),
      },
    },
    async (args): Promise<ToolResult> =>
      paramUpdate({
        'Audio.DuplexMode': args.duplexMode,
        'Audio.MaxListeners': args.maxListeners,
        'Audio.ReceiverBuffer': args.receiverBuffer,
        'Audio.ReceiverTimeout': args.receiverTimeout,
        'Audio.DSCP': args.dscp,
      }),
  );

  // ---- Audio Device Control API ------------------------------------------------

  const AUDIODEVICE_PATH = '/axis-cgi/audiodevicecontrol.cgi';
  const audioDeviceLabel = 'Audio Device Control API';

  server.registerTool(
    'audiodevice_get_capabilities',
    {
      title: 'Get audio device capabilities',
      description:
        'List every audio device and its inputs/outputs with their supported connection types (internal/mic/line), signaling types (balanced/unbalanced), ' +
        'valid gain values, and power types. This is the newer, more detailed successor to AudioSource.A# for products that support it.',
      inputSchema: {},
    },
    async (): Promise<ToolResult> =>
      guard(async () => {
        const { status, response } = await call(AUDIODEVICE_PATH, '1.0', 'getDevicesCapabilities');
        return result(status, response, audioDeviceLabel);
      }),
  );

  server.registerTool(
    'audiodevice_get_settings',
    {
      title: 'Get audio device settings',
      description: 'Get the current settings (selected connection/signaling type, power type, per-channel gain and mute) for every audio device input and output.',
      inputSchema: {},
    },
    async (): Promise<ToolResult> =>
      guard(async () => {
        const { status, response } = await call(AUDIODEVICE_PATH, '1.0', 'getDevicesSettings');
        return result(status, response, audioDeviceLabel);
      }),
  );

  server.registerTool(
    'audiodevice_set_settings',
    {
      title: 'Set audio device settings',
      description:
        'Set audio device settings. Pass the full "devices" array shape from audiodevice_get_settings with only the fields you want changed — ' +
        'see that tool or the VAPIX docs for the exact nested devices[].inputs[]/outputs[].connectionTypes[].signalingTypes[].channels[] shape.',
      inputSchema: { devices: z.array(z.record(z.string(), z.any())) },
    },
    async (args): Promise<ToolResult> =>
      guard(async () => {
        const { status, response } = await call(AUDIODEVICE_PATH, '1.0', 'setDevicesSettings', { devices: args.devices });
        return result(status, response, audioDeviceLabel);
      }),
  );

  server.registerTool(
    'audiodevice_get_hazardous_settings',
    {
      title: 'Get hazardous audio power types',
      description: 'List power types (e.g. "R12") that can damage connected hardware if applied incorrectly — check before writing a power type via audiodevice_set_settings.',
      inputSchema: {},
    },
    async (): Promise<ToolResult> =>
      guard(async () => {
        const { status, response } = await call(AUDIODEVICE_PATH, '1.0', 'getHazardousSettings');
        return result(status, response, audioDeviceLabel);
      }),
  );

  // ---- Audio Analytics API -----------------------------------------------------
  // Same devices[].inputs[]/outputs[].plugins[].settings shape as Audio mixer
  // below, but a distinct endpoint/plugin catalog (detection/classification
  // plugins vs. signal-processing plugins), so kept as separate tools rather
  // than a shared factory.

  const AUDIOANALYTICS_PATH = '/axis-cgi/audioanalytics.cgi';
  const audioAnalyticsLabel = 'Audio Analytics API';

  server.registerTool(
    'audioanalytics_get_plugin_schemas',
    {
      title: 'Get audio analytics plugin schemas',
      description: 'Get the JSON schema (properties, types, ranges) for every audio analytics plugin (e.g. Adaptive Audio Detection, Classification, Direction of Arrival).',
      inputSchema: {},
    },
    async (): Promise<ToolResult> =>
      guard(async () => {
        const { status, response } = await call(AUDIOANALYTICS_PATH, '1.0', 'getPluginsSchemas', {});
        return result(status, response, audioAnalyticsLabel);
      }),
  );

  server.registerTool(
    'audioanalytics_get_plugins_settings',
    {
      title: 'Get audio analytics plugin settings',
      description: 'Get the current settings of every audio analytics plugin instance attached to each audio device input/output.',
      inputSchema: {},
    },
    async (): Promise<ToolResult> =>
      guard(async () => {
        const { status, response } = await call(AUDIOANALYTICS_PATH, '1.0', 'getPluginsSettings');
        return result(status, response, audioAnalyticsLabel);
      }),
  );

  server.registerTool(
    'audioanalytics_set_plugins_settings',
    {
      title: 'Set audio analytics plugin settings',
      description:
        'Set audio analytics plugin settings. Pass the "devices" array shape from audioanalytics_get_plugins_settings, with each plugin\'s "settings" object ' +
        'following the schema from audioanalytics_get_plugin_schemas.',
      inputSchema: { devices: z.array(z.record(z.string(), z.any())) },
    },
    async (args): Promise<ToolResult> =>
      guard(async () => {
        const { status, response } = await call(AUDIOANALYTICS_PATH, '1.0', 'setPluginsSettings', { devices: args.devices });
        return result(status, response, audioAnalyticsLabel);
      }),
  );

  // ---- Audio mixer API ----------------------------------------------------------

  const AUDIOMIXER_PATH = '/axis-cgi/audiomixer.cgi';
  const audioMixerLabel = 'Audio mixer API';

  server.registerTool(
    'audiomixer_get_plugin_schema',
    {
      title: 'Get an audio mixer plugin schema',
      description: 'Get the JSON schema for one signal-processing plugin\'s settings object, e.g. "automaticGainControl", "voiceEnhancer", "simpleEq".',
      inputSchema: { plugin: z.string() },
    },
    async (args): Promise<ToolResult> =>
      guard(async () => {
        const { status, response } = await call(AUDIOMIXER_PATH, '1.0', 'getPluginSchema', { plugin: args.plugin });
        return result(status, response, audioMixerLabel);
      }),
  );

  server.registerTool(
    'audiomixer_get_plugins_settings',
    {
      title: 'Get audio mixer plugin settings',
      description: 'Get the current settings of every audio mixer plugin instance (gain control, voice enhancer, EQ, etc.) attached to each audio device input/output.',
      inputSchema: {},
    },
    async (): Promise<ToolResult> =>
      guard(async () => {
        const { status, response } = await call(AUDIOMIXER_PATH, '1.0', 'getPluginsSettings');
        return result(status, response, audioMixerLabel);
      }),
  );

  server.registerTool(
    'audiomixer_set_plugins_settings',
    {
      title: 'Set audio mixer plugin settings',
      description:
        'Set audio mixer plugin settings. Pass the "devices" array shape from audiomixer_get_plugins_settings — only fields you include are changed, ' +
        'the rest keep their existing values.',
      inputSchema: { devices: z.array(z.record(z.string(), z.any())) },
    },
    async (args): Promise<ToolResult> =>
      guard(async () => {
        const { status, response } = await call(AUDIOMIXER_PATH, '1.0', 'setPluginsSettings', { devices: args.devices });
        return result(status, response, audioMixerLabel);
      }),
  );

  // ---- Media clip API -----------------------------------------------------------
  // Upload/download (binary file transfer) intentionally not covered here —
  // play/stop/list/remove/rename cover the agent-relevant control surface.

  server.registerTool(
    'mediaclip_list',
    {
      title: 'List media clips',
      description: 'List audio clips stored on the device (name, file location, type).',
      inputSchema: {},
    },
    async (): Promise<ToolResult> =>
      guard(async () => {
        const res = await vapix({ method: 'GET', path: '/axis-cgi/param.cgi', query: { action: 'list', group: 'MediaClip' } });
        if (res.status < 200 || res.status >= 300) return errorResult(`param.cgi failed (HTTP ${res.status}): ${res.text().slice(0, 300)}`);
        return jsonResult(parseParamResponse(res.text()));
      }),
  );

  server.registerTool(
    'mediaclip_play',
    {
      title: 'Play a media clip',
      description: 'Play a stored audio clip through the camera speaker (or a specific audio device/output). Viewer-level operation.',
      inputSchema: {
        clip: z.number().int().min(0).describe('Clip index (MediaClip.M#), from mediaclip_list.'),
        repeat: z.number().int().min(-1).optional().describe('-1 = repeat forever, 0 (default) = play once. Only if the device supports the "repeat" play option.'),
        volume: z.number().int().min(0).max(1000).optional().describe('Percent, linear scale. 0 = mute. Only if the device supports the "volume" play option.'),
        audiodeviceid: z.number().int().optional(),
        audiooutputid: z.number().int().optional().describe('Required if audiodeviceid is set.'),
      },
    },
    async (args): Promise<ToolResult> =>
      guard(async () => {
        const res = await vapix({
          method: 'GET',
          path: '/axis-cgi/mediaclip.cgi',
          query: {
            action: 'play',
            clip: args.clip,
            repeat: args.repeat,
            volume: args.volume,
            audiodeviceid: args.audiodeviceid,
            audiooutputid: args.audiooutputid,
          },
        });
        if (res.status < 200 || res.status >= 300) return errorResult(`mediaclip.cgi play failed (HTTP ${res.status}): ${res.text().slice(0, 300)}`);
        return jsonResult({ response: res.text().trim() });
      }),
  );

  server.registerTool(
    'mediaclip_stop',
    {
      title: 'Stop media clip playback',
      description: 'Stop any currently playing media clip.',
      inputSchema: {},
    },
    async (): Promise<ToolResult> =>
      guard(async () => {
        const res = await vapix({ method: 'GET', path: '/axis-cgi/stopclip.cgi' });
        if (res.status < 200 || res.status >= 300) return errorResult(`stopclip.cgi failed (HTTP ${res.status}): ${res.text().slice(0, 300)}`);
        return jsonResult({ response: res.text().trim() });
      }),
  );

  server.registerTool(
    'mediaclip_remove',
    {
      title: 'Remove a media clip',
      description: 'Delete a stored media clip.',
      inputSchema: { clip: z.number().int().min(0) },
    },
    async (args): Promise<ToolResult> =>
      guard(async () => {
        const res = await vapix({ method: 'GET', path: '/axis-cgi/mediaclip.cgi', query: { action: 'remove', clip: args.clip } });
        if (res.status < 200 || res.status >= 300) return errorResult(`mediaclip.cgi remove failed (HTTP ${res.status}): ${res.text().slice(0, 300)}`);
        return jsonResult({ response: res.text().trim() });
      }),
  );

  server.registerTool(
    'mediaclip_rename',
    {
      title: 'Rename a media clip',
      description: 'Change the descriptive name of a stored media clip.',
      inputSchema: { clip: z.number().int().min(0), name: z.string() },
    },
    async (args): Promise<ToolResult> =>
      guard(async () => {
        const res = await vapix({ method: 'GET', path: '/axis-cgi/mediaclip.cgi', query: { action: 'update', clip: args.clip, name: args.name } });
        if (res.status < 200 || res.status >= 300) return errorResult(`mediaclip.cgi update failed (HTTP ${res.status}): ${res.text().slice(0, 300)}`);
        return jsonResult({ response: res.text().trim() });
      }),
  );
}
