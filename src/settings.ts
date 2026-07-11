// Persisted configuration for the Axis MCP Server ACAP.
// Stored as JSON under the app's writable PERSISTENT_DATA_PATH (localdata dir).
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export interface Settings {
  /** VAPIX admin username used for on-camera API calls. */
  vapixUser: string;
  /** VAPIX admin password. */
  vapixPass: string;
  /** Camera host for VAPIX calls. From inside the camera this is 127.0.0.1. */
  vapixHost: string;
  /** Enable the unauthenticated direct MCP listener on a fixed port (LAN-only fallback). */
  directPortEnabled: boolean;
  /** Fixed secondary port for direct MCP access (e.g. 8000). */
  directPort: number;
  /** Optional bearer token required on the direct MCP listener. Empty = no auth. */
  bearerToken: string;
  /**
   * MCP tool access level: 'readonly' (inspect only), 'operate' (PTZ, overlays,
   * streams, I/O — default), 'full' (adds reboot/factory default/set_param/control_app).
   */
  accessLevel: 'readonly' | 'operate' | 'full';
  /** UI theme preference: 'light' (default) or 'dark'. */
  theme: 'light' | 'dark';
  /** Force a specific Live Log logo ('' = auto-detect from client name/UA). */
  logoOverride: '' | 'claude' | 'gemini' | 'openai' | 'antigravity' | 'generic';
}

const DEFAULTS: Settings = {
  vapixUser: '',
  vapixPass: '',
  vapixHost: '127.0.0.1',
  directPortEnabled: false, // secure default — opt in via the settings page
  directPort: 8000,
  bearerToken: '',
  accessLevel: 'operate',
  theme: 'light',
  logoOverride: '',
};

let resolvedDataDir: string | null = null;

/** Return true if we can create `dir` and write a probe file inside it. */
function isWritable(dir: string): boolean {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, '.wtest');
    fs.writeFileSync(probe, 'ok');
    fs.unlinkSync(probe);
    return true;
  } catch {
    return false;
  }
}

/**
 * Pick a writable data directory. On a real ACAP the package install dir can be
 * read-only, so we test candidates in order and fall back to the OS temp dir.
 * The chosen dir is logged once so the app log shows where settings live.
 */
function dataDir(): string {
  if (resolvedDataDir) return resolvedDataDir;
  // NOTE: under CamScripter, PERSISTENT_DATA_PATH has been observed to be a
  // RELATIVE path (e.g. "./localdata/"), unlike the Native SDK's absolute path.
  // A relative path is only as reliable as the process's ambient CWD at that
  // moment, which CamScripter doesn't document or guarantee across restarts --
  // so resolve it against this app's own install dir (a fixed reference point)
  // instead of trusting process.cwd().
  const rawCandidates = [
    process.env.PERSISTENT_DATA_PATH,
    path.join(__dirname, '..', 'localdata'),
    '/usr/local/packages/axis_mcp/localdata',
    path.join(os.tmpdir(), 'axis_mcp'),
  ].filter((c): c is string => !!c);
  const candidates = rawCandidates.map((c) =>
    path.isAbsolute(c) ? c : path.resolve(__dirname, '..', c)
  );

  for (const c of candidates) {
    if (isWritable(c)) {
      resolvedDataDir = c;
      console.log(`[axis-mcp] settings data dir: ${c}`);
      return c;
    } else {
      console.error(`[axis-mcp] data dir not writable, skipping: ${c}`);
    }
  }
  // Last resort — return tmp even if the probe failed, so writes throw a clear error.
  resolvedDataDir = path.join(os.tmpdir(), 'axis_mcp');
  console.error(`[axis-mcp] no writable data dir found; using ${resolvedDataDir}`);
  return resolvedDataDir;
}

function settingsFile(): string {
  return path.join(dataDir(), 'settings.json');
}

let cache: Settings | null = null;

export function loadSettings(): Settings {
  if (cache) return cache;
  try {
    const raw = fs.readFileSync(settingsFile(), 'utf8');
    const parsed = JSON.parse(raw);
    cache = { ...DEFAULTS, ...parsed };
  } catch {
    cache = { ...DEFAULTS };
  }
  return cache!;
}

export function saveSettings(patch: Partial<Settings>): Settings {
  const current = loadSettings();
  // Work on a copy — never mutate the caller's object.
  const p = { ...patch };
  // Never wipe an existing password with an empty string coming from the UI.
  if (p.vapixPass === '' || p.vapixPass === undefined) {
    delete p.vapixPass;
  }
  const next: Settings = { ...current, ...p };
  const file = settingsFile();
  try {
    fs.writeFileSync(file, JSON.stringify(next, null, 2), 'utf8');
  } catch (e) {
    throw new Error(`Failed to write settings to ${file}: ${(e as Error).message}`);
  }
  cache = next;
  return next;
}

/** Settings safe to expose to the UI (password masked). */
export function redactedSettings(): Omit<Settings, 'vapixPass' | 'bearerToken'> & {
  hasPassword: boolean;
  hasBearerToken: boolean;
} {
  const s = loadSettings();
  const { vapixPass, bearerToken, ...rest } = s;
  return {
    ...rest,
    hasPassword: vapixPass.length > 0,
    hasBearerToken: bearerToken.length > 0,
  };
}

export function isConfigured(): boolean {
  const s = loadSettings();
  return s.vapixUser.length > 0 && s.vapixPass.length > 0;
}
