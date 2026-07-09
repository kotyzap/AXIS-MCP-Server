// Events & analytics tools.
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { vapix } from '../vapix';
import { guard, jsonResult } from './util';
import { parseAppList } from './apps';

const GET_EVENT_INSTANCES = `<?xml version="1.0" encoding="UTF-8"?>
<soap:Envelope xmlns:soap="http://www.w3.org/2003/05/soap-envelope">
  <soap:Body>
    <GetEventInstances xmlns="http://www.axis.com/vapix/ws/event1"/>
  </soap:Body>
</soap:Envelope>`;

export function registerEventTools(server: McpServer): void {
  server.registerTool(
    'list_event_declarations',
    {
      title: 'List event declarations',
      description:
        'Return the camera event topic tree (GetEventInstances SOAP call). Includes a flattened list of topic paths for readability.',
      inputSchema: {},
    },
    async () =>
      guard(async () => {
        const res = await vapix({
          method: 'POST',
          path: '/vapix/services',
          headers: { 'Content-Type': 'application/soap+xml; charset=utf-8' },
          body: GET_EVENT_INSTANCES,
        });
        const xml = res.text();
        // Flatten topic-ish element names for a quick overview without a full XML parse.
        const topics = Array.from(new Set((xml.match(/<tns\d*:[A-Za-z0-9_]+/g) || []).map((t) => t.replace(/^<tns\d*:/, ''))));
        return jsonResult({
          status: res.status,
          topicHints: topics,
          xml: xml.length > 20000 ? xml.slice(0, 20000) + '\n...[truncated]' : xml,
        });
      }),
  );

  server.registerTool(
    'get_analytics_status',
    {
      title: 'Get analytics status',
      description:
        'Report the state of analytics ACAPs (VMD, AXIS Object Analytics, etc.) from the applications list.',
      inputSchema: {},
    },
    async () =>
      guard(async () => {
        const res = await vapix({ method: 'GET', path: '/axis-cgi/applications/list.cgi' });
        const apps = parseAppList(res.text());
        const analyticsNames = /(objectanalytics|vmd|motion|fenceguard|loitering|analytics|aoa)/i;
        const analytics = apps.filter(
          (a) => analyticsNames.test(a.name) || analyticsNames.test(a.niceName || ''),
        );
        return jsonResult({ analytics, allApps: apps.map((a) => ({ name: a.name, status: a.status })) });
      }),
  );
}
