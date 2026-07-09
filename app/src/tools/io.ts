// I/O tools: relay outputs (io/output.cgi) and digital inputs (io/port.cgi).
//
// output.cgi's `action` grammar has drifted across firmware/docs: some describe
// it as `<port>:/active|/inactive|/pulse`, the classic VAPIX form uses
// `<port>:/` (active) / `<port>:\` (inactive) / `<port>:/<ms>` (pulse). We try
// the word form first and fall back to the symbol form on a non-2xx response —
// same cascade approach as the autofocus tool.
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { vapix } from '../vapix';
import { guard, jsonResult, errorResult, ToolResult } from './util';

type OutputState = 'active' | 'inactive' | 'pulse';

function symbolAction(port: string | number, state: OutputState, pulseMs?: number): string {
  if (state === 'active') return `${port}:/`;
  if (state === 'inactive') return `${port}:\\`;
  return `${port}:/${pulseMs ?? 500}`; // pulse: active for N ms, then reverts
}

function wordAction(port: string | number, state: OutputState): string {
  return `${port}:/${state}`;
}

export function registerIoTools(server: McpServer): void {
  server.registerTool(
    'io_set_output',
    {
      title: 'Set relay output',
      description:
        'Activate, deactivate, or pulse a digital/relay output port via io/output.cgi. Tries the word form first ("<port>:/active"), then the classic symbol form ("<port>:/" / "<port>:\\\\" / "<port>:/<ms>") if the camera rejects it.',
      inputSchema: {
        port: z.union([z.number(), z.string()]).describe('Output port number, e.g. 1.'),
        state: z.enum(['active', 'inactive', 'pulse']).describe('Desired state.'),
        pulse_ms: z.number().positive().optional().describe('Pulse duration in ms (state="pulse" only). Default 500.'),
      },
    },
    async (args): Promise<ToolResult> =>
      guard(async () => {
        const tried: Array<{ form: string; action: string; status: number; body?: string }> = [];

        const word = wordAction(args.port, args.state);
        let res = await vapix({ method: 'GET', path: '/axis-cgi/io/output.cgi', query: { action: word } });
        tried.push({ form: 'word', action: word, status: res.status, body: res.text().slice(0, 200) });
        if (res.status >= 200 && res.status < 300) {
          return jsonResult({ ok: true, form: 'word', action: word, status: res.status });
        }
        if (res.status === 404) return errorResult('io/output.cgi not available on this model.');

        const sym = symbolAction(args.port, args.state, args.pulse_ms);
        res = await vapix({ method: 'GET', path: '/axis-cgi/io/output.cgi', query: { action: sym } });
        tried.push({ form: 'symbol', action: sym, status: res.status, body: res.text().slice(0, 200) });
        if (res.status >= 200 && res.status < 300) {
          return jsonResult({ ok: true, form: 'symbol', action: sym, status: res.status });
        }

        return errorResult(`Both action forms failed for port ${args.port}. Tried: ${JSON.stringify(tried)}`);
      }),
  );

  server.registerTool(
    'io_get_inputs',
    {
      title: 'Read digital input(s)',
      description: 'Read the state of one digital input port, or all ports if omitted, via io/port.cgi.',
      inputSchema: {
        port: z.union([z.number(), z.string()]).optional().describe('Input port number. Omit to read all ports.'),
      },
    },
    async (args): Promise<ToolResult> =>
      guard(async () => {
        const query = args.port !== undefined ? { checkactive: String(args.port) } : undefined;
        const res = await vapix({ method: 'GET', path: '/axis-cgi/io/port.cgi', query });
        if (res.status === 404) return errorResult('io/port.cgi not available on this model.');
        return jsonResult({ status: res.status, response: res.text().trim() });
      }),
  );
}
