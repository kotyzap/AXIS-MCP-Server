// Shared helper for Axis's newer "Device Configuration API" REST framework
// (distinct from the older Google-JSON-style {apiVersion,context,method,params}
// CGIs used everywhere else in this codebase). Used by the Log API and
// Network diagnostics API today; more Tier 1 "Device configuration" APIs in a
// later phase will likely follow the same shape.
//
// Pattern: GET/PATCH/POST against /config/rest/<api>/v1/<entity>[/<property-or-action>],
// request body (for PATCH/POST) is {"data": <value>}, response body is
// {"status": "success", "data": <value>} or an error shape on failure.
// See https://developer.axis.com/vapix/device-configuration/device-configuration-apis/
import { vapix } from '../vapix';
import { errorResult, jsonResult, safeJson, ToolResult } from './util';

export interface DeviceConfigResponse {
  status?: string;
  data?: unknown;
  error?: { code?: string | number; message?: string; description?: string };
  [key: string]: unknown;
}

function isDeviceConfigResponse(x: unknown): x is DeviceConfigResponse {
  return !!x && typeof x === 'object';
}

/** GET a property/entity. `restPath` is relative to /config/rest/, e.g. "log/v1/persistent/enabled". */
export async function dcGet(restPath: string): Promise<{ httpStatus: number; response: unknown }> {
  const res = await vapix({ method: 'GET', path: `/config/rest/${restPath}` });
  return { httpStatus: res.status, response: safeJson(res.text()) };
}

/** PATCH a property. Body is wrapped as {"data": value} per the framework's convention. */
export async function dcPatch(restPath: string, value: unknown): Promise<{ httpStatus: number; response: unknown }> {
  const res = await vapix({
    method: 'PATCH',
    path: `/config/rest/${restPath}`,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ data: value }),
  });
  return { httpStatus: res.status, response: safeJson(res.text()) };
}

/** POST (trigger) an action. Body is wrapped as {"data": value}; value defaults to {} for no-argument actions. */
export async function dcPost(restPath: string, value: unknown = {}): Promise<{ httpStatus: number; response: unknown }> {
  const res = await vapix({
    method: 'POST',
    path: `/config/rest/${restPath}`,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ data: value }),
  });
  return { httpStatus: res.status, response: safeJson(res.text()) };
}

/** DELETE a collection item, e.g. "recording-group/v2/recordingGroups/<id>". */
export async function dcDelete(restPath: string): Promise<{ httpStatus: number; response: unknown }> {
  const res = await vapix({
    method: 'DELETE',
    path: `/config/rest/${restPath}`,
    headers: { 'Content-Type': 'application/json' },
  });
  return { httpStatus: res.status, response: safeJson(res.text()) };
}

export function dcResult(httpStatus: number, response: unknown, notInstalledHint: string): ToolResult {
  if (httpStatus === 404) return errorResult(notInstalledHint);
  if (!isDeviceConfigResponse(response)) return errorResult(`Unexpected response (HTTP ${httpStatus}).`);
  if (response.status && response.status !== 'success') {
    return errorResult(`Device Configuration API error (HTTP ${httpStatus}): ${JSON.stringify(response)}`);
  }
  return jsonResult(response.data ?? {});
}
