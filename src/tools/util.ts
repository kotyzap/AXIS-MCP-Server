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

/**
 * Minimal CSV parser for Axis's various export-csv-* CGIs (no quoted/escaped
 * commas seen in practice across Queue Monitor / People Counter / etc.).
 */
export function parseCsv(text: string): { headers: string[]; rows: Array<Record<string, string>> } {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length === 0) return { headers: [], rows: [] };
  const headers = lines[0].split(',').map((h) => h.trim());
  const rows = lines.slice(1).map((line) => {
    const cells = line.split(',');
    const row: Record<string, string> = {};
    headers.forEach((h, i) => (row[h] = (cells[i] ?? '').trim()));
    return row;
  });
  return { headers, rows };
}

/**
 * Parse a flat (single-level) XML document into a tag -> text object, e.g.
 * the <cloud_config>/<hb_config> responses from the LPV app. Handles both
 * `<tag>value</tag>` and self-closing `<tag/>` leaves; skips the wrapping
 * root element since its own content starts with a nested tag rather than
 * plain text.
 */
export function parseFlatXml(xml: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /<([A-Za-z0-9_]+)(?:\s[^>]*)?(?:\/>|>([^<]*)<\/\1>)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    out[m[1]] = m[2] !== undefined ? m[2] : '';
  }
  return out;
}

/**
 * Extract the raw inner XML of every occurrence of <tag>...</tag> (non-greedy,
 * one level — good enough for the repeated-block shapes used by Zipstream's
 * <Status>/<Profile> lists and similar). Each returned string can be fed to
 * parseFlatXml() to get that block's own leaf fields.
 */
export function extractXmlBlocks(xml: string, tag: string): string[] {
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'g');
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) out.push(m[1]);
  return out;
}

/** Extract the text content of every occurrence of a repeated leaf tag, e.g. every <Strength>10</Strength>. */
export function extractXmlTagAll(xml: string, tag: string): string[] {
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([^<]*)</${tag}>`, 'g');
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) out.push(m[1]);
  return out;
}

/**
 * Detect a VAPIX XML CGI's <GeneralError> block (used by Zipstream, Orientation,
 * Recorded tour and other legacy XML CGIs) and return its code/description, or
 * null if the response was a success.
 */
export function xmlGeneralError(xml: string): { code: string; description: string } | null {
  const blocks = extractXmlBlocks(xml, 'GeneralError');
  if (blocks.length === 0) return null;
  const parsed = parseFlatXml(blocks[0]);
  return { code: parsed.ErrorCode ?? '', description: parsed.ErrorDescription ?? parsed.Description ?? '' };
}
