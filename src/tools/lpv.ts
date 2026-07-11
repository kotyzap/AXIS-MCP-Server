// AXIS License Plate Verifier (LPV / "fflprapp") tools — push-destination
// config, heartbeat config, recent plate-recognition events, and stored plate
// images.
// See https://developer.axis.com/vapix/applications/license-plate-verifier-api/
//
// Unlike AOA/VMD4, LPV has no JSON-RPC control.cgi — its config CGIs
// (cloud[N].cgi, config_hb.cgi) return small flat XML documents, and its
// event topics (tnsaxis:CameraApplicationPlatform/ALPV.*) are mostly
// stateless pulses fired once per recognition, not a stateful on/off value.
// That means lpv_get_recent_plates can only see plates recognized *while its
// short pull-point subscription is open* — it's a "listen for a few seconds"
// tool, not a "read the last plate" cache lookup.
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { vapix } from '../vapix';
import { guard, jsonResult, errorResult, parseFlatXml, ToolResult } from './util';
import { pullCurrentEvents, EventPullError } from './eventPull';

const BASE = '/local/fflprapp';

function profileSuffix(profile: number): string {
  return profile === 1 ? '' : String(profile);
}

/** cloud_config / hb_config both base64-encode url and password fields. */
function decodeIfPresent(fields: Record<string, string>, key: string): string | undefined {
  const v = fields[key];
  if (!v) return undefined;
  try {
    return Buffer.from(v, 'base64').toString('utf8');
  } catch {
    return undefined;
  }
}

export function registerLpvTools(server: McpServer): void {
  server.registerTool(
    'lpv_get_push_config',
    {
      title: 'Get LPV push-event config',
      description:
        'Read a License Plate Verifier push-destination profile (cloud.cgi / cloud2.cgi / cloud3.cgi): target URL, ' +
        'protocol (HTTP/TCP/FTP), which event types (new/update/lost) are sent, and auth settings. The URL and ' +
        'password fields are base64-encoded on the wire and are decoded here for convenience.',
      inputSchema: {
        profile: z
          .union([z.literal(1), z.literal(2), z.literal(3)])
          .optional()
          .describe('Push profile number (1-3). Defaults to 1.'),
      },
    },
    async (args): Promise<ToolResult> =>
      guard(async () => {
        const profile = args.profile ?? 1;
        const res = await vapix({ method: 'GET', path: `${BASE}/cloud${profileSuffix(profile)}.cgi` });
        if (res.status === 404) {
          return errorResult('AXIS License Plate Verifier does not appear to be installed (cloud.cgi returned 404).');
        }
        if (res.status < 200 || res.status >= 300) {
          return errorResult(`cloud${profileSuffix(profile)}.cgi failed (HTTP ${res.status}): ${res.text().slice(0, 300)}`);
        }
        const fields = parseFlatXml(res.text());
        return jsonResult({
          profile,
          ...fields,
          url_decoded: decodeIfPresent(fields, 'url'),
          password_decoded: decodeIfPresent(fields, 'password'),
        });
      }),
  );

  server.registerTool(
    'lpv_get_heartbeat_config',
    {
      title: 'Get LPV heartbeat config',
      description:
        'Read the License Plate Verifier heartbeat service configuration (config_hb.cgi): destination URL, period ' +
        '(minutes) and enabled state. The URL and password fields are base64-encoded on the wire and are decoded ' +
        'here for convenience.',
      inputSchema: {},
    },
    async (): Promise<ToolResult> =>
      guard(async () => {
        const res = await vapix({ method: 'GET', path: `${BASE}/config_hb.cgi` });
        if (res.status === 404) {
          return errorResult(
            'AXIS License Plate Verifier does not appear to be installed (config_hb.cgi returned 404).',
          );
        }
        if (res.status < 200 || res.status >= 300) {
          return errorResult(`config_hb.cgi failed (HTTP ${res.status}): ${res.text().slice(0, 300)}`);
        }
        const fields = parseFlatXml(res.text());
        return jsonResult({
          ...fields,
          url_decoded: decodeIfPresent(fields, 'url'),
          password_decoded: decodeIfPresent(fields, 'password'),
        });
      }),
  );

  server.registerTool(
    'lpv_get_recent_plates',
    {
      title: 'Listen for LPV plate recognition events',
      description:
        'Open a short-lived VAPIX event subscription and report any license-plate recognition events ' +
        '(tnsaxis:CameraApplicationPlatform/ALPV.*) seen in that window — plate text, car ID, list match, ' +
        'direction, vehicle type/color, and more, taken straight from the event payload. Most ALPV events are ' +
        "fired once per recognition rather than held as a state, so this only reports plates that pass while " +
        "it's listening (default 8s) — it can't retroactively report a plate seen before the call. Increase " +
        'listen_seconds for a longer window; run repeatedly to keep watching.',
      inputSchema: {
        listen_seconds: z
          .number()
          .min(1)
          .max(25)
          .optional()
          .describe('How long to listen for events, in seconds (max 25). Defaults to 8.'),
      },
    },
    async (args): Promise<ToolResult> =>
      guard(async () => {
        let notifications;
        try {
          notifications = await pullCurrentEvents({ timeoutSeconds: args.listen_seconds ?? 8 });
        } catch (e) {
          if (e instanceof EventPullError) return errorResult(e.message);
          throw e;
        }
        const plateEvents = notifications.filter((n) => /ALPV/i.test(n.topic));
        const plates = plateEvents.map((n) => ({
          topic: n.topic,
          plate: n.items.Text ?? n.items.text,
          carId: n.items.carID ?? n.items.carId,
          carState: n.items.carState,
          listName: n.items.listName,
          listMode: n.items.listMode,
          direction: n.items.carMoveDirection,
          vehicleType: n.items.vehicleType,
          vehicleColor: n.items.vehicleColor,
          country: n.items.country,
          data: n.items,
        }));
        return jsonResult({
          plates,
          totalEventsSeen: notifications.length,
          note:
            plates.length === 0
              ? 'No ALPV events arrived during the listen window — no plate was recognized while this tool was ' +
                'running. This is timing-sensitive; try again, or increase listen_seconds.'
              : undefined,
        });
      }),
  );

  server.registerTool(
    'lpv_get_plate_image',
    {
      title: 'Get a stored LPV plate/ROI image',
      description:
        'Fetch a license-plate or region-of-interest snapshot previously stored by LPV, by its stored file name ' +
        '(the lpImage/name field from an lpv_get_recent_plates event, e.g. "52/20231211142706_413731lp_HWR6677_2117396.jpg").',
      inputSchema: {
        name: z.string().describe('Stored image name/path, as referenced in an LPV event payload.'),
      },
    },
    async (args): Promise<ToolResult> =>
      guard(async () => {
        const res = await vapix({
          method: 'GET',
          path: `${BASE}/tools.cgi`,
          query: { action: 'getImage', name: args.name },
        });
        if (res.status < 200 || res.status >= 300) {
          return errorResult(`Could not fetch image (HTTP ${res.status}): ${res.text().slice(0, 200)}`);
        }
        return { content: [{ type: 'image', data: res.body.toString('base64'), mimeType: 'image/jpeg' }] };
      }),
  );
}
