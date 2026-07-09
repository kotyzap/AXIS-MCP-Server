// Entry point (package.json main -> dist/bootstrap.js).
//
// Starts the on-camera HTTP surface:
//   - Primary server on HTTP_PORT (AXIS OS assigns it; 32554 for local dev).
//     Serves /mcp, /status.cgi, /settings.cgi behind the camera reverse proxy
//     (declared in manifest.json; the camera enforces admin digest auth).
//   - Optional direct server on a fixed port (default 8000) for MCP clients that
//     can't do digest auth against the reverse proxy. LAN-only; can require a
//     bearer token from settings.
//
// MCP transport: Streamable HTTP in stateless mode — a fresh transport + server
// per POST /mcp, so nothing has to survive the camera's respawn lifecycle.
import express, { Request, Response } from 'express';
import * as path from 'path';
import * as fs from 'fs';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createMcpServer } from './mcpServer';
import { vapix } from './vapix';
import { loadSettings, saveSettings, redactedSettings, isConfigured, Settings } from './settings';
import { pushLog, getLogs, describeMcp, markMcpActivity, setClient, setClientTag } from './logbuf';

const PRIMARY_PORT = parseInt(process.env.HTTP_PORT ?? '32554', 10);
const HTML_DIR = path.join(__dirname, '..', 'html');

// ---- MCP (stateless Streamable HTTP) ---------------------------------------

async function handleMcpPost(req: Request, res: Response): Promise<void> {
  const server = createMcpServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on('close', () => {
    transport.close();
    server.close();
  });
  try {
    markMcpActivity();
    const ua = String(req.headers['user-agent'] || '');
    if (ua) setClient('', ua); // record UA even for clients that skip initialize
    // Explicit, 100%-reliable tag from the URL: ...\/mcp?client=antigravity
    const tag = String((req.query.client ?? req.query.llm ?? '') as string).toLowerCase();
    if (tag) setClientTag(tag);
    for (const line of describeMcp(req.body, ua)) pushLog('info', line);
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: '2.0',
        error: { code: -32603, message: 'Internal server error: ' + (err as Error).message },
        id: null,
      });
    }
  }
}

function methodNotAllowed(_req: Request, res: Response): void {
  res.status(405).json({
    jsonrpc: '2.0',
    error: { code: -32000, message: 'Method not allowed. Use POST for MCP.' },
    id: null,
  });
}

// ---- CGI endpoints ---------------------------------------------------------

async function statusCgi(_req: Request, res: Response): Promise<void> {
  const configured = isConfigured();
  const s = loadSettings();
  const result: Record<string, unknown> = {
    app: 'axis-mcp',
    version: '1.2.0',
    configured,
    endpoints: {
      reverseProxy: '/local/axis_mcp/mcp',
      direct: s.directPortEnabled ? `:${s.directPort}/mcp` : null,
    },
  };
  if (configured) {
    // Self-test: exercise the VAPIX digest client end to end.
    try {
      const dev = await vapix({
        method: 'POST',
        path: '/axis-cgi/basicdeviceinfo.cgi',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ apiVersion: '1.0', method: 'getAllProperties' }),
      });
      let props: unknown = undefined;
      try {
        props = JSON.parse(dev.text())?.data?.propertyList;
      } catch {
        /* ignore */
      }
      result.vapix = { ok: dev.status === 200, httpStatus: dev.status, device: props };
    } catch (e) {
      result.vapix = { ok: false, error: (e as Error).message };
    }
  }
  res.json(result);
}

function settingsCgi(req: Request, res: Response): void {
  if (req.method === 'POST') {
    try {
      const body = (req.body ?? {}) as Partial<Settings>;
      const patch: Partial<Settings> = {};
      if (typeof body.vapixUser === 'string') patch.vapixUser = body.vapixUser;
      if (typeof body.vapixPass === 'string') patch.vapixPass = body.vapixPass;
      if (typeof body.vapixHost === 'string') patch.vapixHost = body.vapixHost;
      if (typeof body.directPortEnabled === 'boolean') patch.directPortEnabled = body.directPortEnabled;
      if (typeof body.directPort === 'number') patch.directPort = body.directPort;
      if (typeof body.bearerToken === 'string') patch.bearerToken = body.bearerToken;
      if (body.theme === 'light' || body.theme === 'dark') patch.theme = body.theme;
      if (typeof body.logoOverride === 'string') patch.logoOverride = body.logoOverride as Settings['logoOverride'];
      saveSettings(patch);
      res.json({ ok: true, settings: redactedSettings() });
      // Note: runMode=respawn — AXIS OS restarts the app after a settings save.
    } catch (e) {
      const msg = (e as Error).message;
      console.error('[axis-mcp] settings save failed:', msg);
      res.status(500).json({ ok: false, error: msg });
    }
  } else {
    res.json(redactedSettings());
  }
}

function logCgi(req: Request, res: Response): void {
  const since = parseInt(String(req.query.since ?? '0'), 10) || 0;
  res.json(getLogs(since));
}

// ---- App wiring ------------------------------------------------------------

// The camera's reverse proxy may forward the bare path (/status.cgi), the full
// prefixed path (/local/axis_mcp/status.cgi), or some variant, depending on
// firmware. Match on the path SUFFIX so routing works regardless of prefix.
const RE_MCP = /\/mcp\/?$/;
const RE_STATUS = /\/status\.cgi$/;
const RE_SETTINGS = /\/settings\.cgi$/;
const RE_LOG = /\/log\.cgi$/;

function bearerGate(req: Request, res: Response, next: express.NextFunction): void {
  if (!RE_MCP.test(req.path)) return next();
  const token = loadSettings().bearerToken;
  if (!token) return next();
  const auth = req.headers['authorization'] || '';
  if (auth === `Bearer ${token}`) return next();
  res.status(401).json({
    jsonrpc: '2.0',
    error: { code: -32001, message: 'Unauthorized: bearer token required.' },
    id: null,
  });
}

function registerRoutes(app: express.Express, includeCgi: boolean): void {
  app.post(RE_MCP, handleMcpPost);
  app.get(RE_MCP, methodNotAllowed);
  app.delete(RE_MCP, methodNotAllowed);
  if (includeCgi) {
    app.get(RE_STATUS, statusCgi);
    app.get(RE_SETTINGS, settingsCgi);
    app.post(RE_SETTINGS, settingsCgi);
    app.get(RE_LOG, logCgi);
  }
}

function buildPrimaryApp(): express.Express {
  const app = express();
  app.use(express.json({ limit: '4mb' }));
  // Log every incoming request into the ring buffer (shown in the UI Live Log
  // and mirrored to the AXIS app log). Skip the log poller itself to avoid noise.
  app.use((req, _res, next) => {
    if (!RE_LOG.test(req.path)) pushLog('info', `${req.method} ${req.path}`);
    next();
  });
  registerRoutes(app, true);
  // Convenience for local dev / direct access (AXIS OS serves the real one).
  if (fs.existsSync(HTML_DIR)) {
    app.use('/', express.static(HTML_DIR));
  }
  return app;
}

function buildDirectApp(): express.Express {
  const app = express();
  app.use(express.json({ limit: '4mb' }));
  app.use(bearerGate);
  registerRoutes(app, false);
  return app;
}

function main(): void {
  const primary = buildPrimaryApp();
  const primaryServer = primary.listen(PRIMARY_PORT, '0.0.0.0', () => {
    pushLog('info', `primary HTTP server listening on ${PRIMARY_PORT}`);
    pushLog('info', 'MCP endpoint (via reverse proxy): /local/axis_mcp/mcp');
  });

  const s = loadSettings();
  let directServer: ReturnType<express.Express['listen']> | undefined;
  if (s.directPortEnabled && s.directPort && s.directPort !== PRIMARY_PORT) {
    const direct = buildDirectApp();
    directServer = direct.listen(s.directPort, '0.0.0.0', () => {
      pushLog('info', `direct MCP server listening on ${s.directPort} (bearer=${s.bearerToken ? 'on' : 'off'})`);
    });
    directServer.on('error', (e) => {
      pushLog('error', `direct server failed on ${s.directPort}: ${(e as Error).message}`);
    });
  }

  // Clean SIGINT exit — the skill lifecycle relies on respawn after settings save.
  const shutdown = () => {
    pushLog('info', 'shutting down...');
    primaryServer.close();
    directServer?.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main();
