// Shared factory for the "single-profile control.cgi ACAP" family: Fence
// Guard, Loitering Guard, Motion Guard (and VMD4, though vmd4.ts predates
// this factory and is left as-is). All of these expose the exact same
// getConfiguration/getSupportedVersions JSON-RPC shape at
// /local/<app>/control.cgi (Google JSON style guide), the same
// cameras[]/profiles[] configuration shape, and the same stateful
// "CameraApplicationPlatform/<AppTopic>/CameraXProfileY" event topic read via
// the shared eventPull helper.
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { vapix } from '../vapix';
import { guard, jsonResult, errorResult, safeJson, ToolResult } from './util';
import { pullCurrentEvents, EventPullError } from './eventPull';

interface Profile {
  uid: number;
  name?: string;
  camera?: number;
  [key: string]: unknown;
}

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

export interface ControlCgiAcapOptions {
  /** Tool name prefix, e.g. "fenceguard" -> fenceguard_get_profiles. */
  toolPrefix: string;
  /** Human-readable app name for descriptions/errors, e.g. "Fence Guard". */
  displayName: string;
  /** e.g. /local/fenceguard/control.cgi */
  controlPath: string;
  /** Matches this app's event topic, e.g. /CameraApplicationPlatform\/FenceGuard\//i */
  topicMatch: RegExp;
  /** apiVersion to use if getSupportedVersions itself can't be reached. */
  fallbackApiVersion: string;
  /** One-line description of what a "trigger" means for this app, used in the triggered-profiles tool description. */
  triggerNoun?: string;
}

export function registerControlCgiAcapTools(server: McpServer, opts: ControlCgiAcapOptions): void {
  const { toolPrefix, displayName, controlPath, topicMatch, fallbackApiVersion } = opts;
  const triggerNoun = opts.triggerNoun ?? 'alarm';

  async function resolveApiVersion(): Promise<string> {
    const res = await vapix({
      method: 'POST',
      path: controlPath,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ context: 'axis-mcp', method: 'getSupportedVersions' }),
    });
    if (res.status >= 200 && res.status < 300) {
      const parsed = safeJson(res.text());
      const versions =
        isJsonRpcResponse(parsed) && parsed.data && typeof parsed.data === 'object'
          ? (parsed.data as Record<string, unknown>).apiVersions
          : undefined;
      if (Array.isArray(versions) && versions.length > 0) return String(versions[versions.length - 1]);
    }
    return fallbackApiVersion;
  }

  async function call(
    method: string,
    params?: Record<string, unknown>,
    apiVersion?: string,
  ): Promise<{ status: number; apiVersion: string; response: unknown }> {
    const version = apiVersion ?? (await resolveApiVersion());
    const res = await vapix({
      method: 'POST',
      path: controlPath,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ apiVersion: version, context: 'axis-mcp', method, ...(params ? { params } : {}) }),
    });
    return { status: res.status, apiVersion: version, response: safeJson(res.text()) };
  }

  async function fetchProfiles(): Promise<{ status: number; profiles: Profile[]; response: unknown }> {
    const { status, response } = await call('getConfiguration');
    const data =
      isJsonRpcResponse(response) && !response.error ? (response.data as Record<string, unknown> | undefined) : undefined;
    const profiles = Array.isArray(data?.profiles) ? (data!.profiles as Profile[]) : [];
    return { status, profiles, response };
  }

  server.registerTool(
    `${toolPrefix}_get_profiles`,
    {
      title: `Get ${displayName} profiles`,
      description:
        `Fetch the ${displayName} configuration (getConfiguration): cameras and every profile — trigger area/line, ` +
        `exclusion filters, and PTZ preset binding. Requires the ${displayName} ACAP installed and running — check with get_analytics_status first.`,
      inputSchema: {},
    },
    async (): Promise<ToolResult> =>
      guard(async () => {
        const { status, apiVersion, response } = await call('getConfiguration');
        if (status === 404) {
          return errorResult(
            `${displayName} does not appear to be installed (control.cgi returned 404). Check with get_analytics_status.`,
          );
        }
        if (!isJsonRpcResponse(response)) {
          return errorResult(`Unexpected response from control.cgi (HTTP ${status}).`);
        }
        if (response.error) {
          return errorResult(`${displayName} getConfiguration error ${response.error.code}: ${response.error.message}`);
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
    `${toolPrefix}_get_triggered_profiles`,
    {
      title: `Get current ${displayName} ${triggerNoun} state`,
      description:
        `Read which ${displayName} profiles are currently in an active ${triggerNoun} state. There's no polling CGI ` +
        `for this — it's only reported through the VAPIX event stream — so this opens a short-lived ONVIF pull-point ` +
        `subscription, reads whatever is queued (a stateful event reports its current value immediately on subscribe, ` +
        `with no need to wait for a change), then closes it. Run it again for a fresh read.`,
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
        const matches = notifications.filter((n) => topicMatch.test(n.topic));

        let profiles: Profile[] = [];
        try {
          profiles = (await fetchProfiles()).profiles;
        } catch {
          // ignore — trigger states below are still useful without names
        }

        const results = matches.map((n) => {
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
              ? `No ${displayName} events were queued on this subscription — this can mean nothing has changed ` +
                'state recently, or no profile is configured. A stateful trigger reports its current value only ' +
                'once per subscription; run this tool again for a fresh read.'
              : undefined,
        });
      }),
  );
}
