// Single source of truth for the app version — read from package.json so
// bumping the version in one place (package.json + manifest.json) is enough.
// Defensive: if package.json is ever missing from the installed package (a
// packaging bug, not a code bug — see Dockerfile's acap-build -a flags), fall
// back to "unknown" rather than crashing the whole app on startup.
function readVersion(): string {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return (require('../package.json') as { version: string }).version;
  } catch (e) {
    console.error('[axis-mcp] could not read package.json for version:', (e as Error).message);
    return 'unknown';
  }
}

export const APP_VERSION: string = readVersion();
