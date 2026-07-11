// Cross line detection 1.1, Digital autotracking, Video motion detection 2.1,
// and Video motion detection 3 — four deprecated ACAPs sharing the legacy
// vaconfig.cgi XML configuration mechanism. Thin wrappers around
// legacyAcapFactory. All superseded by VMD4 / AOA on current AXIS OS, so
// these mainly matter on older devices.
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerLegacyAcapTools } from './legacyAcapFactory';

export function registerLegacyAnalyticsTools(server: McpServer): void {
  registerLegacyAcapTools(server, {
    toolPrefix: 'crosslinedetection',
    displayName: 'Cross Line Detection 1.1',
    appName: 'CrossLineDetection',
    topicMatch: /CrossLineDetection/i,
    stateful: false,
  });

  registerLegacyAcapTools(server, {
    toolPrefix: 'digitalautotracking',
    displayName: 'Digital Autotracking',
    appName: 'DigitalAutotracking',
    topicMatch: /DigitalAutotracking/i,
    stateful: true,
  });

  registerLegacyAcapTools(server, {
    toolPrefix: 'vmd21',
    displayName: 'Video Motion Detection 2.1',
    appName: 'VideoMotionDetection',
    topicMatch: /VideoMotionDetection/i,
    stateful: true,
  });

  registerLegacyAcapTools(server, {
    toolPrefix: 'vmd3',
    displayName: 'Video Motion Detection 3',
    appName: 'VideoMotionDetection3',
    topicMatch: /VMD3/i,
    stateful: true,
  });
}
