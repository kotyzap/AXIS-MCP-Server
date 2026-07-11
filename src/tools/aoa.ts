// AXIS Object Analytics (AOA) tools — scenario configuration, live object
// counts, and current triggered/alarm state.
//
// Config/count interface: POST /local/objectanalytics/control.cgi, JSON body
// following the Google JSON style guide (apiVersion/context/method/params).
// See https://developer.axis.com/vapix/applications/axis-object-analytics-api/
//
// There is no polling CGI for "is this scenario alarming right now" — AOA only
// reports that through the VAPIX/ONVIF event stream. aoa_get_triggered_alerts
// opens a short-lived pull-point subscription (same /vapix/services SOAP
// endpoint used by list_event_declarations) to read it: stateful topics — and
// an AOA scenario's alarm state is one — report their current value
// immediately on subscribe, with no need to wait for a state change.
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { vapix } from '../vapix';
import { guard, jsonResult, errorResult, safeJson, ToolResult } from './util';
import { pullCurrentEvents, EventPullError } from './eventPull';

const CONTROL_PATH = '/local/objectanalytics/control.cgi';
// Used throughout Axis's own AOA documentation examples; a safe default if
// getSupportedVersions itself can't be reached.
const FALLBACK_API_VERSION = '1.2';

interface AoaScenario {
  id: number;
  name?: string;
  type?: string;
  [key: string]: unknown;
}

interface AoaJsonRpcResponse {
  apiVersion?: string;
  context?: string;
  method?: string;
  data?: unknown;
  error?: { code: number; message: string };
}

function isAoaResponse(x: unknown): x is AoaJsonRpcResponse {
  return !!x && typeof x === 'object';
}

/** Ask the camera which AOA API versions it supports and use the newest. */
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
      isAoaResponse(parsed) && parsed.data && typeof parsed.data === 'object'
        ? (parsed.data as Record<string, unknown>).apiVersions
        : undefined;
    if (Array.isArray(versions) && versions.length > 0) return String(versions[versions.length - 1]);
  }
  return FALLBACK_API_VERSION;
}

async function callAoa(
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

async function fetchScenarios(
  apiVersion?: string,
): Promise<{ status: number; apiVersion: string; scenarios: AoaScenario[]; response: unknown }> {
  const { status, apiVersion: v, response } = await callAoa('getConfiguration', undefined, apiVersion);
  const data = isAoaResponse(response) && !response.error ? (response.data as Record<string, unknown> | undefined) : undefined;
  const scenarios = Array.isArray(data?.scenarios) ? (data!.scenarios as AoaScenario[]) : [];
  return { status, apiVersion: v, scenarios, response };
}

export function registerAoaTools(server: McpServer): void {
  server.registerTool(
    'aoa_get_scenarios',
    {
      title: 'Get AOA scenarios',
      description:
        'Fetch the full AXIS Object Analytics configuration (getConfiguration): every scenario with its type ' +
        '(motion / fence / crosslinecounting / occupancyInArea), trigger areas, filters, object classifications ' +
        'and PTZ preset bindings. Requires the AOA ACAP installed and configured — check with get_analytics_status first.',
      inputSchema: {},
    },
    async (): Promise<ToolResult> =>
      guard(async () => {
        const { status, apiVersion, response } = await callAoa('getConfiguration');
        if (status === 404) {
          return errorResult(
            'AXIS Object Analytics does not appear to be installed (control.cgi returned 404). Check with get_analytics_status.',
          );
        }
        if (!isAoaResponse(response)) {
          return errorResult(`Unexpected response from control.cgi (HTTP ${status}).`);
        }
        if (response.error) {
          return errorResult(`AOA getConfiguration error ${response.error.code}: ${response.error.message}`);
        }
        const data = response.data as Record<string, unknown> | undefined;
        return jsonResult({
          apiVersion,
          scenarios: data?.scenarios ?? [],
          devices: data?.devices,
          metadataOverlay: data?.metadataOverlay,
        });
      }),
  );

  server.registerTool(
    'aoa_get_object_counts',
    {
      title: 'Get current AOA object counts',
      description:
        'Read live detected-object counts from countable AOA scenarios: current occupancy for occupancyInArea ' +
        'scenarios (getOccupancy) and accumulated line-crossing counts for crosslinecounting scenarios ' +
        '(getAccumulatedCounts) — both broken down by object category (car, human, bike, etc.) plus a total. ' +
        "Motion and fence scenarios don't expose a counts endpoint — use aoa_get_triggered_alerts for those. " +
        'Omit scenario_id to read every countable scenario.',
      inputSchema: {
        scenario_id: z
          .number()
          .int()
          .optional()
          .describe('Limit to a single scenario ID (from aoa_get_scenarios). Omit to read all countable scenarios.'),
      },
    },
    async (args): Promise<ToolResult> =>
      guard(async () => {
        const cfg = await fetchScenarios();
        if (cfg.status === 404) {
          return errorResult(
            'AXIS Object Analytics does not appear to be installed (control.cgi returned 404). Check with get_analytics_status.',
          );
        }
        if (isAoaResponse(cfg.response) && cfg.response.error) {
          return errorResult(`AOA getConfiguration error ${cfg.response.error.code}: ${cfg.response.error.message}`);
        }
        const targets = cfg.scenarios.filter(
          (s) =>
            (args.scenario_id === undefined || s.id === args.scenario_id) &&
            (s.type === 'crosslinecounting' || s.type === 'occupancyInArea'),
        );
        if (targets.length === 0) {
          return jsonResult({
            counts: [],
            note:
              args.scenario_id !== undefined
                ? `Scenario ${args.scenario_id} was not found, or is not a crosslinecounting/occupancyInArea scenario.`
                : 'No crosslinecounting or occupancyInArea scenarios are configured — nothing to count. Motion/fence scenario state is available via aoa_get_triggered_alerts.',
          });
        }
        const counts: Array<Record<string, unknown>> = [];
        for (const s of targets) {
          const method = s.type === 'crosslinecounting' ? 'getAccumulatedCounts' : 'getOccupancy';
          const { response } = await callAoa(method, { scenario: s.id }, cfg.apiVersion);
          if (isAoaResponse(response) && response.error) {
            counts.push({ scenario_id: s.id, name: s.name, type: s.type, error: response.error });
          } else if (isAoaResponse(response)) {
            counts.push({ scenario_id: s.id, name: s.name, type: s.type, ...(response.data as object) });
          } else {
            counts.push({ scenario_id: s.id, name: s.name, type: s.type, raw: response });
          }
        }
        return jsonResult({ apiVersion: cfg.apiVersion, counts });
      }),
  );

  server.registerTool(
    'aoa_get_triggered_alerts',
    {
      title: 'Get current AOA triggered/alarm state',
      description:
        "Read which AOA scenarios are currently in an alarm/triggered state, for any scenario type (including " +
        "motion and fence, which aoa_get_object_counts can't read). There is no polling CGI for this — AOA only " +
        'reports it through the VAPIX event stream — so this opens a short-lived ONVIF pull-point subscription, ' +
        'reads whatever is queued (a stateful event reports its current value immediately on subscribe, with no ' +
        'need to wait for a change), then closes the subscription. Run it again for a fresh read.',
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
        const aoaEvents = notifications.filter((n) => /objectanalytics/i.test(n.topic));

        // Best-effort name lookup — don't fail the whole read if config can't be fetched.
        let scenarioNames = new Map<number, string>();
        try {
          const cfg = await fetchScenarios();
          scenarioNames = new Map(cfg.scenarios.map((s) => [s.id, s.name ?? '']));
        } catch {
          // ignore — trigger states below are still useful without names
        }

        const scenarios = aoaEvents.map((n) => {
          const scenarioMatch = n.topic.match(/Scenario(\d+)/i);
          const scenario_id = scenarioMatch ? Number(scenarioMatch[1]) : undefined;
          const activeRaw = n.items.active;
          return {
            topic: n.topic,
            scenario_id,
            name: scenario_id !== undefined ? scenarioNames.get(scenario_id) : undefined,
            active: activeRaw === '1' || activeRaw?.toLowerCase() === 'true',
            data: n.items,
          };
        });

        return jsonResult({
          scenarios,
          totalEventsSeen: notifications.length,
          note:
            scenarios.length === 0
              ? 'No AOA scenario events were queued on this subscription — this can mean nothing has changed ' +
                'state recently, or no scenario is configured. A stateful trigger reports its current value only ' +
                'once per subscription; run this tool again for a fresh read.'
              : undefined,
        });
      }),
  );
}
