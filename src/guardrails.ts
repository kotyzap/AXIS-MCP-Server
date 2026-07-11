// Central guardrails for MCP tool calls: operator-controlled access levels,
// rate limiting, and per-resource caps.
//
// Access levels (settings.accessLevel, default "operate"):
//   readonly — inspection only: status, params, snapshots, URLs, lists.
//   operate  — day-to-day control: PTZ, focus, overlays, streams, I/O, recordings.
//   full     — maintenance: reboot, factory default, set_param, control_app.
// Each level includes everything below it. Tools above the configured level
// return a clear "disabled by operator" error instead of executing.
//
// Rate limits (sliding 60s window):
//   RATE_LIMIT_TOTAL  — all tool calls combined.
//   RATE_LIMIT_WRITE  — calls to any non-readonly tool.
// PTZ preset cap: ptz_preset_save refuses when the camera already has
// MAX_PTZ_PRESETS presets (counted live via param.cgi), so an agent loop
// can't flood the camera with hundreds of presets.
import { loadSettings } from './settings';
import { vapix } from './vapix';
import { pushLog } from './logbuf';

export type AccessLevel = 'readonly' | 'operate' | 'full';

const LEVEL_RANK: Record<AccessLevel, number> = { readonly: 0, operate: 1, full: 2 };

// Classification strategy:
//   readonly — pure inspection: get/list/status/query/history/live counts.
//   operate  — live operation & runtime content: PTZ, focus, overlays, media
//              clips, tours, recordings, stream/profile control, zipstream,
//              view-area geometry, image tuning.
//   full     — persistent device/system configuration & maintenance: reboot,
//              factory default, raw params, app control, network/NTP/mDNS/
//              geolocation/regional settings, MQTT wiring, pairing, storage
//              topology, feature flags, config import, log administration.
//
// OPERATE_TOOLS / FULL_TOOLS are explicit; everything else that matches the
// read-only naming heuristic below is readonly; anything unrecognized is
// 'full' (fail-closed for future tools).

const OPERATE_TOOLS = new Set<string>([
  // imaging & optics
  'set_image_settings', 'autofocus', 'set_zoom_focus',
  // image tuning
  'daynight_set_configuration', 'light_set_active', 'light_set_intensity',
  'imagestab_set_configuration', 'imagerotation_set', 'ratecontrol_set',
  'dewarp_set_camera_orientation',
  // view areas (geometry is runtime-adjustable, not system config)
  'viewarea_set_geometry', 'viewarea_reset_geometry',
  // PTZ + tours + autotracking + orientation aid
  'ptz_move', 'ptz_relative_move', 'ptz_absolute_move', 'ptz_continuous_move',
  'ptz_preset_goto', 'ptz_preset_save', 'ptz_preset_remove',
  'guardtour_create', 'guardtour_remove', 'guardtour_add_preset',
  'guardtour_remove_preset', 'guardtour_set_running',
  'recordedtour_record', 'recordedtour_stop_recording', 'recordedtour_play',
  'recordedtour_stop_playback',
  'autotracker_set_target', 'autotracker_set_state',
  'orientationaid_set_north', 'orientationaid_set_compass_state', 'orientationaid_set_tag_state',
  // I/O & recordings
  'io_set_output', 'storage_start_recording', 'storage_stop_recording',
  // audio operation & media clips
  'audio_set_enabled', 'audio_configure_source', 'audio_configure_stream',
  'audiodevice_set_settings', 'audioanalytics_set_plugins_settings',
  'audiomixer_set_plugins_settings',
  'mediaclip_play', 'mediaclip_stop', 'mediaclip_remove', 'mediaclip_rename',
  // overlays (native + CamOverlay)
  'overlay_add_text', 'overlay_add_image', 'overlay_set_text', 'overlay_set_image',
  'overlay_remove',
  'camoverlay_set_service_enabled', 'camoverlay_update_graphic_text', 'camoverlay_infoticker',
  // streams & profiles & zipstream
  'camstreamer_control_stream',
  'camswitcher_switch_playlist', 'camswitcher_queue_playlist', 'camswitcher_play_next',
  'camswitcher_clear_queue',
  'streamprofile_create', 'streamprofile_update', 'streamprofile_remove',
  'metadataproducer_set_enabled',
  'zipstream_set_strength', 'zipstream_set_gop', 'zipstream_set_fps_mode',
  'zipstream_set_min_fps', 'zipstream_set_profile',
  // misc runtime
  'objectsnapshot_set', 'log_write_message',
  'find_my_device', 'stop_find_my_device',
  'eventschedule_create', 'eventschedule_update', 'eventschedule_remove',
  'netpairing_set_nice_name',
]);

const FULL_TOOLS = new Set<string>([
  // maintenance & raw config
  'reboot_camera', 'factory_default', 'set_param', 'control_app',
  'dcparam_import', 'devicemode_set_mode', 'capturemode_set_mode',
  // network / system configuration
  'featureflag_set', 'regionalsettings_set', 'mdnssd_set_configuration',
  'geolocation_set_position', 'ntp_set_client_configuration',
  // MQTT & signed video wiring
  'mqtt_configure_client', 'mqtt_activate_client', 'mqtt_deactivate_client',
  'mqtt_configure_event_publication', 'mqtt_configure_subscription',
  'signedvideo_set',
  // analytics data plumbing
  'analyticsmqtt_add_publisher', 'analyticsmqtt_remove_publisher',
  'datatransform_create', 'datatransform_update', 'datatransform_remove',
  // pairing & storage topology
  'netpairing_add', 'netpairing_remove', 'netpairing_set_capability_enabled',
  'camerapairing_add', 'camerapairing_update', 'camerapairing_remove',
  'recordinggroup_create', 'recordinggroup_delete',
  'remotestorage_add', 'remotestorage_update', 'remotestorage_remove',
  'remotestorage_set_failover',
  // log administration
  'log_set_persistent_enabled', 'log_clear_persistent',
]);

// Read-only naming heuristic: pure-inspection verbs anywhere in the tool name.
const READONLY_PATTERN =
  /(^|_)(get|list|query|status|history|discover|export|convert|capabilities|info)(_|$)|_(counts?|alerts?|tracks?|stats|profiles|scenarios|plates?|sample|schemas?|report|log|position|modes|strengths|days|occupancy|topics|spaces|url|urls)$/;

const EXTRA_READONLY = new Set<string>([
  'take_snapshot', // fetches an image; changes nothing
  'ptz_capabilities',
  'camswitcher_output_info',
  'lpv_get_plate_image',
  'p8815_get_live_occupancy',
  'queue_get_live_count',
  'peoplecounter_get_live_count',
  'demographics_get_live_and_ended_tracks',
]);

export function toolLevel(name: string): AccessLevel {
  if (FULL_TOOLS.has(name)) return 'full';
  if (OPERATE_TOOLS.has(name)) return 'operate';
  if (EXTRA_READONLY.has(name) || READONLY_PATTERN.test(name)) return 'readonly';
  return 'full'; // unknown → fail closed
}

// ---- Rate limiting ----------------------------------------------------------

const RATE_WINDOW_MS = 60_000;
const RATE_LIMIT_TOTAL = 60; // any tool calls / minute
const RATE_LIMIT_WRITE = 20; // non-readonly tool calls / minute
export const MAX_PTZ_PRESETS = 20;

const allCalls: number[] = [];
const writeCalls: number[] = [];

function slide(arr: number[], now: number): void {
  while (arr.length && now - arr[0] > RATE_WINDOW_MS) arr.shift();
}

/**
 * Check whether `name` may run now. Returns null if allowed (and records the
 * call), or a human-readable refusal message.
 */
export async function checkGuardrails(name: string): Promise<string | null> {
  const level = toolLevel(name);
  const allowed = loadSettings().accessLevel;

  if (LEVEL_RANK[level] > LEVEL_RANK[allowed]) {
    pushLog('warn', `guardrail: '${name}' blocked (needs '${level}', operator allows '${allowed}')`);
    return (
      `Tool '${name}' is disabled by the camera operator. ` +
      `It requires access level '${level}' but the AXIS MCP Server is set to '${allowed}'. ` +
      `An administrator can change this on the app's settings page.`
    );
  }

  const now = Date.now();
  slide(allCalls, now);
  slide(writeCalls, now);
  if (allCalls.length >= RATE_LIMIT_TOTAL) {
    pushLog('warn', `guardrail: '${name}' rate-limited (${RATE_LIMIT_TOTAL} calls/min reached)`);
    return `Rate limit reached (${RATE_LIMIT_TOTAL} tool calls per minute). Wait a moment and try again.`;
  }
  if (level !== 'readonly' && writeCalls.length >= RATE_LIMIT_WRITE) {
    pushLog('warn', `guardrail: '${name}' rate-limited (${RATE_LIMIT_WRITE} write calls/min reached)`);
    return `Write rate limit reached (${RATE_LIMIT_WRITE} state-changing calls per minute). Wait a moment and try again.`;
  }

  // Resource cap: don't let an agent flood the camera with PTZ presets.
  if (name === 'ptz_preset_save') {
    const count = await countPtzPresets();
    if (count !== null && count >= MAX_PTZ_PRESETS) {
      pushLog('warn', `guardrail: ptz_preset_save blocked (${count} presets >= cap ${MAX_PTZ_PRESETS})`);
      return (
        `PTZ preset cap reached: the camera already has ${count} presets ` +
        `(limit ${MAX_PTZ_PRESETS} via MCP). Remove unused presets first.`
      );
    }
  }

  allCalls.push(now);
  if (level !== 'readonly') writeCalls.push(now);
  return null;
}

/** Count configured PTZ presets via param.cgi. Fail-open (null) on any error. */
async function countPtzPresets(): Promise<number | null> {
  try {
    const res = await vapix({
      method: 'GET',
      path: '/axis-cgi/param.cgi',
      query: { action: 'list', group: 'PTZ.Preset' },
    });
    if (res.status < 200 || res.status >= 300) return null;
    const names = res.text().match(/\.P\d+\.Name=/g);
    return names ? names.length : 0;
  } catch {
    return null;
  }
}
