// Ops/diagnostics tools: Audit log, Log API, Network diagnostics API,
// Systemready API, and the read-only diagnostic corner of System settings
// (server report, system log, access log). User account management
// (pwdgrp.cgi) and factory-default/restart/firmware-upgrade CGIs from the
// System settings page are deliberately NOT covered here — user management is
// Tier 2 security-sensitive (see ROADMAP.md), and reboot/factory-default/
// firmware are already covered by system.ts's guarded reboot_camera /
// factory_default / get_firmware_properties.
// See:
//   https://developer.axis.com/vapix/network-video/audit-log/
//   https://developer.axis.com/vapix/device-configuration/log-api/
//   https://developer.axis.com/vapix/device-configuration/network-diagnostics/
//   https://developer.axis.com/vapix/network-video/systemready-api/
//   https://developer.axis.com/vapix/network-video/system-settings/
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { vapix } from '../vapix';
import { guard, jsonResult, errorResult, safeJson, ToolResult } from './util';
import { dcGet, dcPatch, dcPost, dcResult } from './deviceConfigApi';

export function registerDiagnosticsTools(server: McpServer): void {
  // ---- Audit log ------------------------------------------------------------

  server.registerTool(
    'auditlog_get',
    {
      title: 'Get audit log',
      description: 'Read the device audit log (authentication events, config changes, upgrades, etc.), as plain text lines. Omit tail to get the entire log.',
      inputSchema: { tail: z.number().int().min(1).optional().describe('Number of most recent entries to retrieve. Omit for the entire log.') },
    },
    async (args): Promise<ToolResult> =>
      guard(async () => {
        const res = await vapix({ method: 'GET', path: '/axis-cgi/auditlog.cgi', query: { tail: args.tail } });
        if (res.status === 404) return errorResult('Audit log API not available on this model (404).');
        if (res.status < 200 || res.status >= 300) return errorResult(`auditlog.cgi failed (HTTP ${res.status}): ${res.text().slice(0, 300)}`);
        const lines = res.text().split(/\r?\n/).filter((l) => l.trim().length > 0);
        return jsonResult({ count: lines.length, lines });
      }),
  );

  server.registerTool(
    'auditlog_get_version',
    {
      title: 'Get audit log CGI version',
      description: 'Get the version of the auditlog.cgi implementation.',
      inputSchema: {},
    },
    async (): Promise<ToolResult> =>
      guard(async () => {
        const res = await vapix({ method: 'GET', path: '/axis-cgi/auditlog.cgi', query: { version: 'true' } });
        if (res.status === 404) return errorResult('Audit log API not available on this model (404).');
        return jsonResult({ version: res.text().trim() });
      }),
  );

  // ---- Log API (Device Configuration API framework) -------------------------

  const logHint = 'Log API not available on this model (/config/rest/log/... returned 404).';

  server.registerTool(
    'log_get_persistent_enabled',
    {
      title: 'Get persistent logging state',
      description: 'Check whether saving logs to persistent storage is currently enabled.',
      inputSchema: {},
    },
    async (): Promise<ToolResult> =>
      guard(async () => {
        const { httpStatus, response } = await dcGet('log/v1/persistent/enabled');
        return dcResult(httpStatus, response, logHint);
      }),
  );

  server.registerTool(
    'log_set_persistent_enabled',
    {
      title: 'Enable / disable persistent logging',
      description:
        'Turn saving logs to persistent storage on or off. Remember to turn it off again and clear it (log_clear_persistent) — ' +
        'persistent storage can fill up if left on indefinitely.',
      inputSchema: { enabled: z.boolean() },
    },
    async (args): Promise<ToolResult> =>
      guard(async () => {
        const { httpStatus, response } = await dcPatch('log/v1/persistent/enabled', args.enabled);
        return dcResult(httpStatus, response, logHint);
      }),
  );

  server.registerTool(
    'log_clear_persistent',
    {
      title: 'Clear persistent log storage',
      description: 'Clear the log file on persistent storage to free up device space.',
      inputSchema: {},
    },
    async (): Promise<ToolResult> =>
      guard(async () => {
        const { httpStatus, response } = await dcPost('log/v1/persistent/clearLog', {});
        return dcResult(httpStatus, response, logHint);
      }),
  );

  server.registerTool(
    'log_write_message',
    {
      title: 'Write a message to the system log',
      description: 'Write a custom message into the device system log, e.g. to mark when an automated action ran.',
      inputSchema: {
        message: z.string().max(4096),
        severity: z.number().int().min(0).max(7).optional().describe('RFC5424 severity 0 (emergency) - 7 (debug). Default 6 (informational).'),
      },
    },
    async (args): Promise<ToolResult> =>
      guard(async () => {
        const { httpStatus, response } = await dcPost('log/v1/writeMessage', { msg: args.message, severity: args.severity });
        return dcResult(httpStatus, response, logHint);
      }),
  );

  // ---- Network diagnostics API (Device Configuration API framework) --------

  const netDiagHint = 'Network diagnostics API not available on this model (/config/rest/network-diagnostics/... returned 404).';

  server.registerTool(
    'network_get_tcp_retransmissions',
    {
      title: 'Get TCP retransmission count',
      description: 'Get the number of TCP retransmissions recorded in the last N hours (a rough proxy for network quality/congestion). 0 = all recorded.',
      inputSchema: { hours: z.number().int().min(0).default(0) },
    },
    async (args): Promise<ToolResult> =>
      guard(async () => {
        const { httpStatus, response } = await dcPost('network-diagnostics/v1/netstats/tcpRetransmissions', args.hours);
        return dcResult(httpStatus, response, netDiagHint);
      }),
  );

  server.registerTool(
    'network_get_tcp_retransmission_spikes',
    {
      title: 'Get TCP retransmission spikes',
      description: 'Get the last N recorded TCP retransmission spikes (magnitude + timestamp), useful for correlating network trouble with other events. 0 = all buffered spikes (up to 1024).',
      inputSchema: { count: z.number().int().min(0).default(0) },
    },
    async (args): Promise<ToolResult> =>
      guard(async () => {
        const { httpStatus, response } = await dcPost('network-diagnostics/v1/netstats/tcpRetransmissionSpikes', args.count);
        return dcResult(httpStatus, response, netDiagHint);
      }),
  );

  // ---- Systemready API --------------------------------------------------------

  server.registerTool(
    'get_systemready',
    {
      title: 'Check system readiness',
      description:
        'Check whether the device is ready for external communication/config/streaming (no authentication required). ' +
        'Also reports uptime, boot ID, whether initial admin setup is still needed, and the passphrase policy in effect.',
      inputSchema: { timeoutSeconds: z.number().int().min(0).max(60).optional().describe('Max seconds to wait for readiness before responding. Default: immediate.') },
    },
    async (args): Promise<ToolResult> =>
      guard(async () => {
        const res = await vapix({
          method: 'POST',
          path: '/axis-cgi/systemready.cgi',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ apiVersion: '1.1', context: 'axis-mcp', method: 'systemready', params: { timeout: args.timeoutSeconds ?? 0 } }),
        });
        const parsed = safeJson(res.text()) as { data?: unknown; error?: { code: number; message: string } };
        if (res.status === 404) return errorResult('Systemready API not available on this model (404).');
        if (parsed?.error) return errorResult(`Systemready error ${parsed.error.code}: ${parsed.error.message}`);
        return jsonResult(parsed?.data ?? {});
      }),
  );

  // ---- System settings: read-only diagnostics --------------------------------

  server.registerTool(
    'get_server_report',
    {
      title: 'Get server report',
      description:
        'Generate and return the device server report as text (product info, parameter dump, and system logs) — the ' +
        'same report used for support requests. Truncated to the first 20000 characters; for the full report use the ' +
        'device UI or serverreport.cgi?mode=zip directly.',
      inputSchema: {},
    },
    async (): Promise<ToolResult> =>
      guard(async () => {
        const res = await vapix({ method: 'GET', path: '/axis-cgi/serverreport.cgi', query: { mode: 'text' } });
        if (res.status < 200 || res.status >= 300) return errorResult(`serverreport.cgi failed (HTTP ${res.status}): ${res.text().slice(0, 300)}`);
        const text = res.text();
        return jsonResult({ truncated: text.length > 20000, report: text.slice(0, 20000) });
      }),
  );

  server.registerTool(
    'get_system_log',
    {
      title: 'Get system log',
      description: 'Read the device system log (critical/warning/informational messages, level controlled by Log.System params). Optionally filter by a text substring.',
      inputSchema: { filterText: z.string().optional().describe('Only letters and digits — entries containing this text.') },
    },
    async (args): Promise<ToolResult> =>
      guard(async () => {
        const res = await vapix({ method: 'GET', path: '/axis-cgi/systemlog.cgi', query: { text: args.filterText } });
        if (res.status < 200 || res.status >= 300) return errorResult(`systemlog.cgi failed (HTTP ${res.status}): ${res.text().slice(0, 300)}`);
        const text = res.text();
        return jsonResult({ truncated: text.length > 20000, log: text.slice(0, 20000) });
      }),
  );

  server.registerTool(
    'get_access_log',
    {
      title: 'Get client access log',
      description: 'Read the device client access log (level controlled by Log.Access params).',
      inputSchema: {},
    },
    async (): Promise<ToolResult> =>
      guard(async () => {
        const res = await vapix({ method: 'GET', path: '/axis-cgi/accesslog.cgi' });
        if (res.status < 200 || res.status >= 300) return errorResult(`accesslog.cgi failed (HTTP ${res.status}): ${res.text().slice(0, 300)}`);
        const text = res.text();
        return jsonResult({ truncated: text.length > 20000, log: text.slice(0, 20000) });
      }),
  );
}
