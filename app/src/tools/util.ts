// Shared helpers for MCP tool handlers.
import { VapixError } from '../vapix';

export interface ToolResult {
  content: Array<
    | { type: 'text'; text: string }
    | { type: 'image'; data: string; mimeType: string }
  >;
  isError?: boolean;
  // The MCP SDK's CallToolResult type carries an index signature; ToolResult must
  // include one to be assignable as a tool-callback return value.
  [key: string]: unknown;
}

export function jsonResult(obj: unknown): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(obj, null, 2) }] };
}

export function textResult(text: string): ToolResult {
  return { content: [{ type: 'text', text }] };
}

export function errorResult(message: string): ToolResult {
  return { content: [{ type: 'text', text: message }], isError: true };
}

/** Wrap a tool body so VAPIX/other errors surface as isError content, not throws. */
export async function guard(fn: () => Promise<ToolResult>): Promise<ToolResult> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof VapixError) {
      return errorResult(`VAPIX error (HTTP ${e.status}) on ${e.path}: ${e.bodyExcerpt.slice(0, 400)}`);
    }
    return errorResult(`Tool error: ${(e as Error).message}`);
  }
}

/** Parse JSON, or return the trimmed raw text if it isn't valid JSON. */
export function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text.trim();
  }
}

/**
 * Parse an Axis param.cgi key=value response (one pair per line) into an object.
 */
export function parseParamResponse(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    out[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  return out;
}
