// Builds the MCP server and registers all v1 tools.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerDeviceTools } from './tools/device';
import { registerImagingTools } from './tools/imaging';
import { registerEventTools } from './tools/events';
import { registerAppTools } from './tools/apps';
import { registerCamStreamerTools } from './tools/camstreamer';
import { registerCamSwitcherTools } from './tools/camswitcher';
import { registerCamOverlayTools } from './tools/camoverlay';

export function createMcpServer(): McpServer {
  const server = new McpServer({
    name: 'axis-mcp',
    version: '1.2.0',
  });

  registerDeviceTools(server);
  registerImagingTools(server);
  registerEventTools(server);
  registerAppTools(server);
  registerCamStreamerTools(server);
  registerCamSwitcherTools(server);
  registerCamOverlayTools(server);

  return server;
}
