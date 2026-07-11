// AXIS Video Motion Detection 4 (VMD4) tools — profile configuration and
// current per-profile alarm state.
//
// Config interface: POST /local/vmd/control.cgi, JSON body following the
// Google JSON style guide (apiVersion/context/method/params), same shape as
// AOA. See https://developer.axis.com/vapix/applications/video-motion-detection-4-api/
//
// VMD4 has no counts to poll (motion detection is boolean, not a count) — its
// only live signal is the per-profile "active" stateful event topic
// (tnsaxis:CameraApplicationPlatform/VMD/CameraXProfileY), read here the same
// way aoa_get_triggered_alerts reads AOA scenario state: a short pull-point
// subscription, since a stateful topic reports its current value immediately
// on subscribe.
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { vapix } from '../vapix';
import { guard, jsonResult, errorResult, safeJson, ToolResult } from './util';
import { pullCurrentEvents, EventPullError } from './eventPull';

const CONTROL_PATH = '/local/vmd/control.cgi';
// Used throughout Axis's own VMD4 documentation examples; a safe default if
// getSupportedVersions itself can't be reached.
const FALLBACK_API_VERSION = '1.3';

interface Vmd4Profile {
  uid: number;
  name?: string;
  camera?: number;
  [key: string]: unknown;
}

interface Vmd4JsonRpcResponse {
  apiVersion?: string;
  context?: string;
  method?: string;
  data?: unknown;
  error?: { code: number; message: string };
}

function isVmd4Response(x: unknown): x is Vmd4JsonRpcResponse {
  return !!x && typeof x === 'object';
}

async function resolveApiVersion(): Promise<string> {
  const res = await vapix({
    method: 'POST',
    path: CONTROL_PATH,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ context: 'axis-mcp', method: 'getSupportedVersions' }),
  });
  if (res.status >= 200 && res.status < 300) {
    const parsed = safeJson(res.text());
    const versions =
      isVmd4Response(parsed) && parsed.data && typeof parsed.data === 'object'
        ? (parsed.data as Record<string, unknown>).apiVersions
        : undefined;
    if (Array.isArray(versions) && versions.length > 0) return String(versions[versions.length - 1]);
  }
  return FALLBACK_API_VERSION;
}

async function callVmd4(
  method: string,
  params?: Record<string, unknown>,
  apiVersion?: string,
): Promise<{ status: number; apiVersion: string; response: unknown }> {
  const version = apiVersion ?? (await resolveApiVersion());
  const res = await vapix({
    method: 'POST',
    path: CONTROL_PATH,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ apiVersion: version, context: 'axis-mcp', method, ...(params ? { params } : {}) }),
  });
  return { status: res.status, apiVersion: version, response: safeJson(res.text()) };
}

async function fetchProfiles(): Promise<{ status: number; profiles: Vmd4Profile[]; response: unknown }> {
  const { status, response } = await callVmd4('getConfiguration');
  const data = isVmd4Response(response) && !response.error ? (response.data as Record<string, unknown> | undefined) : undefined;
  const profiles = Array.isArray(data?.profiles) ? (data!.profiles as Vmd4Profile[]) : [];
  return { status, profiles, response };
}

export function registerVmd4Tools(server: McpServer): void {
  server.registerTool(
    'vmd4_get_profiles',
    {
      title: 'Get VMD4 profiles',
      description:
        'Fetch the AXIS Video Motion Detection 4 configuration (getConfiguration): cameras (rotation, active) and ' +
        'every profile — include area, exclude areas, size/short-lived/swaying-object filters, and PTZ preset ' +
        "binding. Requires the VMD4 ACAP running — check with get_analytics_status first (it's preinstalled but " +
        'must be started).',
      inputSchema: {},
    },
    async (): Promise<ToolResult> =>
      guard(async () => {
        const { status, apiVersion, response } = await callVmd4('getConfiguration');
        if (status === 404) {
          return errorResult(
            'AXIS Video Motion Detection 4 does not appear to be installed/running (control.cgi returned 404). Check with get_analytics_status.',
          );
        }
        if (!isVmd4Response(response)) {
          return errorResult(`Unexpected response from control.cgi (HTTP ${status}).`);
        }
        if (response.error) {
          return errorResult(`VMD4 getConfiguration error ${response.error.code}: ${response.error.message}`);
        }
        const data = response.data as Record<string, unknown> | undefined;
        return jsonResult({
          apiVersion,
          cameras: data?.cameras ?? [],
          profiles: data?.profiles ?? [],
          configurationStatus: data?.configurationStatus,
        });
      }),
  );

  server.registerTool(
    'vmd4_get_triggered_profiles',
    {
      title: 'Get current VMD4 motion-alarm state',
      description:
        "Read which VMD4 profiles are currently in an active motion-alarm state. There's no polling CGI for this " +
        '— VMD4 only reports it through the VAPIX event stream (tnsaxis:CameraApplicationPlatform/VMD/CameraXProfileY) ' +
        '— so this opens a short-lived ONVIF pull-point subscription, reads whatever is queued (a stateful event ' +
        'reports its current value immediately on subscribe, with no need to wait for a change), then closes it. ' +
        'Run it again for a fresh read.',
      inputSchema: {},
    },
    async (): Promise<ToolResult> =>
      guard(async () => {
        let notifications;
        try {
          notifications = await pullCurrentEvents();
        } catch (e) {
          if (e instanceof EventPullError) return errorResult(e.message);
          throw e;
        }
        const vmdEvents = notifications.filter((n) => /CameraApplicationPlatform\/VMD\//i.test(n.topic));

        // Best-effort name lookup — don't fail the whole read if config can't be fetched.
        let profiles: Vmd4Profile[] = [];
        try {
          profiles = (await fetchProfiles()).profiles;
        } catch {
          // ignore — trigger states below are still useful without names
        }

        const results = vmdEvents.map((n) => {
          const eventName = n.topic.split('/').pop() || n.topic;
          const m = eventName.match(/^Camera(\d+)Profile(\d+)$/i);
          const camera = m ? Number(m[1]) : undefined;
          const uid = m ? Number(m[2]) : undefined;
          const matched = uid !== undefined ? profiles.find((p) => p.uid === uid && p.camera === camera) : undefined;
          const activeRaw = n.items.active;
          return {
            topic: n.topic,
            eventName,
            camera,
            uid,
            name: matched?.name,
            active: activeRaw === '1' || activeRaw?.toLowerCase() === 'true',
            data: n.items,
          };
        });

        return jsonResult({
          profiles: results,
          totalEventsSeen: notifications.length,
          note:
            results.length === 0
              ? 'No VMD4 events were queued on this subscription — this can mean nothing has changed state ' +
                'recently, or no profile is configured. A stateful trigger reports its current value only once ' +
                'per subscription; run this tool again for a fresh read.'
              : undefined,
        });
      }),
  );
}
