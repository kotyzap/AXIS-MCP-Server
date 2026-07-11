// Fence Guard, Loitering Guard, Motion Guard — three ACAPs identical in API
// shape to VMD4 (getConfiguration + stateful per-profile event), just with
// different trigger types (fence / loitering area / include area). Thin
// wrappers around controlCgiAcapFactory.
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerControlCgiAcapTools } from './controlCgiAcapFactory';

export function registerGuardAppTools(server: McpServer): void {
  registerControlCgiAcapTools(server, {
    toolPrefix: 'fenceguard',
    displayName: 'Fence Guard',
    controlPath: '/local/fenceguard/control.cgi',
    topicMatch: /CameraApplicationPlatform\/FenceGuard\//i,
    fallbackApiVersion: '1.3',
    triggerNoun: 'fence-crossing alarm',
  });

  registerControlCgiAcapTools(server, {
    toolPrefix: 'loiteringguard',
    displayName: 'Loitering Guard',
    controlPath: '/local/loiteringguard/control.cgi',
    topicMatch: /CameraApplicationPlatform\/LoiteringGuard\//i,
    fallbackApiVersion: '1.3',
    triggerNoun: 'loitering alarm',
  });

  registerControlCgiAcapTools(server, {
    toolPrefix: 'motionguard',
    displayName: 'Motion Guard',
    controlPath: '/local/motionguard/control.cgi',
    topicMatch: /CameraApplicationPlatform\/MotionGuard\//i,
    fallbackApiVersion: '1.3',
    triggerNoun: 'motion alarm',
  });
}
