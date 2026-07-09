// In-memory ring buffer of recent activity, exposed to the UI via /log.cgi.
// Each entry has a monotonic `seq` so the UI can poll for only what's new.
export interface LogEntry {
  seq: number;
  ts: string;
  level: 'info' | 'warn' | 'error';
  msg: string;
}

const MAX_ENTRIES = 300;
const buffer: LogEntry[] = [];
let seq = 0;
let lastMcpAt = 0;
let lastClient = '';
let lastClientUA = '';
let lastClientTag = '';

/** Record the connecting MCP client's reported name and/or User-Agent. */
export function setClient(name: string, ua?: string): void {
  if (name) lastClient = name;
  if (ua) lastClientUA = ua;
}

/** Record an explicit client tag from the URL (?client=antigravity). 100% reliable. */
export function setClientTag(tag: string): void {
  if (tag) lastClientTag = tag;
}

export function pushLog(level: LogEntry['level'], msg: string): void {
  seq += 1;
  buffer.push({ seq, ts: new Date().toISOString(), level, msg });
  if (buffer.length > MAX_ENTRIES) buffer.shift();
  // Mirror to stdout/stderr so it also lands in the AXIS app log.
  const line = `[axis-mcp] ${msg}`;
  if (level === 'error') console.error(line);
  else console.log(line);
}

/** Record that an MCP (LLM) request just arrived — drives the "LLM Connected" UI. */
export function markMcpActivity(): void {
  lastMcpAt = Date.now();
}

export function getLogs(since = 0): {
  entries: LogEntry[];
  lastSeq: number;
  mcpMsAgo: number | null;
  client: string;
  clientUA: string;
  clientTag: string;
} {
  return {
    entries: buffer.filter((e) => e.seq > since),
    lastSeq: seq,
    mcpMsAgo: lastMcpAt ? Date.now() - lastMcpAt : null,
    client: lastClient,
    clientUA: lastClientUA,
    clientTag: lastClientTag,
  };
}

/** Summarise an incoming MCP JSON-RPC body into a readable log line. */
export function describeMcp(body: unknown, ua = ''): string[] {
  const arr = Array.isArray(body) ? body : [body];
  const out: string[] = [];
  for (const m of arr) {
    if (m && typeof m === 'object' && 'method' in m) {
      const method = (m as { method: string }).method;
      if (method === 'initialize') {
        const ci = (m as { params?: { clientInfo?: { name?: string; version?: string } } }).params
          ?.clientInfo;
        const name = ci?.name ?? 'unknown';
        setClient(name, ua);
        out.push(
          `LLM connected: ${name}${ci?.version ? ' ' + ci.version : ''}${ua ? ' [UA: ' + ua + ']' : ''}`,
        );
      } else if (method === 'tools/call') {
        const name = (m as { params?: { name?: string } }).params?.name ?? '?';
        out.push(`MCP tools/call → ${name}`);
      } else {
        out.push(`MCP ${method}`);
      }
    }
  }
  return out;
}
