// Shared factory for the legacy "Application configuration API" family: Cross
// line detection 1.1, Digital autotracking, Video motion detection 2.1, and
// Video motion detection 3. All predate control.cgi's JSON-RPC style — they
// are plain XML documents read/written via /axis-cgi/vaconfig.cgi?name=<pkg>,
// uploaded/started via the generic Application API (list_apps/control_app,
// already covered), and reachable through the same eventPull helper for
// live state.
//
// These are all deprecated (superseded by VMD4 / AOA / Fence-Loitering-Motion
// Guard) and their config XML nests arbitrarily (named objects, polygons,
// per-channel ruleEngines) in ways that differ per app, so rather than model
// every shape, the config tool returns the raw XML for the model to read —
// full parity with reading it in a browser, and safer than guessing at a
// generic nested-XML-to-JSON mapping.
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { vapix } from '../vapix';
import { guard, jsonResult, errorResult, ToolResult } from './util';
import { pullCurrentEvents, EventPullError } from './eventPull';

export interface LegacyAcapOptions {
  /** Tool name prefix, e.g. "crosslinedetection" -> crosslinedetection_get_config. */
  toolPrefix: string;
  /** Human-readable app name for descriptions/errors. */
  displayName: string;
  /** The `name=` value vaconfig.cgi expects, e.g. "CrossLineDetection". */
  appName: string;
  /** Matches this app's event topic. */
  topicMatch: RegExp;
  /** Whether the underlying event is stateful (reports current state on subscribe) or a one-shot pulse. */
  stateful: boolean;
}

export function registerLegacyAcapTools(server: McpServer, opts: LegacyAcapOptions): void {
  const { toolPrefix, displayName, appName, topicMatch, stateful } = opts;

  server.registerTool(
    `${toolPrefix}_get_config`,
    {
      title: `Get ${displayName} configuration`,
      description:
        `Fetch the ${displayName} application configuration as raw XML (/axis-cgi/vaconfig.cgi?action=get&name=${appName}) ` +
        `— named objects (areas/lines/filters) and rules. ${displayName} is a legacy ACAP; requires it installed and ` +
        'started (check with get_analytics_status / list_apps first). Getting the configuration from a stopped ' +
        'application is not possible.',
      inputSchema: {},
    },
    async (): Promise<ToolResult> =>
      guard(async () => {
        const res = await vapix({
          method: 'GET',
          path: '/axis-cgi/vaconfig.cgi',
          query: { action: 'get', name: appName },
        });
        if (res.status === 404) {
          return errorResult(`${displayName} does not appear to be installed (vaconfig.cgi returned 404).`);
        }
        const text = res.text();
        if (res.status < 200 || res.status >= 300 || !/result="ok"/.test(text)) {
          return errorResult(
            `${displayName} vaconfig.cgi did not return an ok result (HTTP ${res.status}). Is the app installed and started?\n${text.slice(0, 500)}`,
          );
        }
        return jsonResult({ xml: text.length > 12000 ? text.slice(0, 12000) + '\n...[truncated]' : text });
      }),
  );

  server.registerTool(
    `${toolPrefix}_get_triggered`,
    {
      title: `Get current ${displayName} event state`,
      description: stateful
        ? `Read the current active/inactive state of ${displayName}'s event. There's no polling CGI for this — it's ` +
          'only reported through the VAPIX event stream — so this opens a short-lived ONVIF pull-point subscription, ' +
          'reads whatever is queued (a stateful event reports its current value immediately on subscribe, with no ' +
          'need to wait for a change), then closes it. Run it again for a fresh read.'
        : `Listen a few seconds for ${displayName} events. This event is stateless (fired once per detection, not ` +
          'held as a state), so this only reports events seen during the listen window — it cannot retroactively ' +
          'report something that happened before the call. Run repeatedly to keep watching.',
      inputSchema: stateful
        ? {}
        : {
            listen_seconds: z
              .number()
              .min(1)
              .max(25)
              .optional()
              .describe('How long to listen for events, in seconds (max 25). Defaults to 8.'),
          },
    },
    async (args: { listen_seconds?: number }): Promise<ToolResult> =>
      guard(async () => {
        let notifications;
        try {
          notifications = await pullCurrentEvents(stateful ? {} : { timeoutSeconds: args.listen_seconds ?? 8 });
        } catch (e) {
          if (e instanceof EventPullError) return errorResult(e.message);
          throw e;
        }
        const matches = notifications.filter((n) => topicMatch.test(n.topic));
        const events = matches.map((n) => {
          const activeRaw = n.items.active;
          return {
            topic: n.topic,
            active: activeRaw !== undefined ? activeRaw === '1' || activeRaw.toLowerCase() === 'true' : undefined,
            data: n.items,
          };
        });
        return jsonResult({
          events,
          totalEventsSeen: notifications.length,
          note:
            events.length === 0
              ? stateful
                ? `No ${displayName} events were queued on this subscription — this can mean nothing has changed ` +
                  'state recently, or the app is not configured/running. Run this tool again for a fresh read.'
                : `No ${displayName} events arrived during the listen window. This is timing-sensitive; try again, ` +
                  'or increase listen_seconds.'
              : undefined,
        });
      }),
  );
}
