// Builds the MCP server and registers all v1 tools.
//
// Every tool callback is wrapped with checkGuardrails() (guardrails.ts):
// operator access levels, rate limits, and resource caps are enforced in one
// place, before any tool body runs.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { APP_VERSION } from './version';
import { checkGuardrails } from './guardrails';
import { errorResult } from './tools/util';
import { registerDeviceTools } from './tools/device';
import { registerImagingTools } from './tools/imaging';
import { registerEventTools } from './tools/events';
import { registerAppTools } from './tools/apps';
import { registerSystemTools } from './tools/system';
import { registerPtzTools } from './tools/ptz';
import { registerIoTools } from './tools/io';
import { registerStorageTools } from './tools/storage';
import { registerStreamingTools } from './tools/streaming';
import { registerCamStreamerTools } from './tools/camstreamer';
import { registerCamSwitcherTools } from './tools/camswitcher';
import { registerCamOverlayTools } from './tools/camoverlay';
import { registerAoaTools } from './tools/aoa';
import { registerLpvTools } from './tools/lpv';
import { registerVmd4Tools } from './tools/vmd4';
import { registerQueueMonitorTools } from './tools/queuemonitor';
import { registerGuardAppTools } from './tools/guardApps';
import { registerLegacyAnalyticsTools } from './tools/legacyAnalytics';
import { registerDemographicsTools } from './tools/demographics';
import { registerPeopleCounterTools, registerP8815PeopleCounterTools } from './tools/peoplecounter';
import { registerOverlayTools } from './tools/overlay';
import { registerZipstreamTools } from './tools/zipstream';
import { registerViewAreaTools } from './tools/viewareas';
import { registerImageTuningTools } from './tools/imagetuning';
import { registerGuardTourTools, registerPtzAutotrackerTools, registerPtzOrientationAidTools } from './tools/ptzAdvanced';
import { registerDiagnosticsTools } from './tools/diagnostics';
import {
  registerFindMyDeviceTools,
  registerFeatureFlagTools,
  registerRegionalSettingsTools,
  registerMdnsSdTools,
  registerGeolocationTools,
  registerNtpTools,
  registerNetworkSettingsTools,
} from './tools/netops';
import { registerStreamingApiTools } from './tools/streamingApis';
import { registerAudioTools } from './tools/audio';
import {
  registerParamApiTools,
  registerDeviceModeTools,
  registerObjectSnapshotTools,
  registerCoordinateConversionTools,
  registerEventScheduleTools,
} from './tools/deviceConfig';
import { registerRecordingGroupTools, registerRemoteObjectStorageTools } from './tools/recordingPipeline';
import { registerNetworkPairingTools, registerCameraPairingTools } from './tools/pairing';
import { registerAnalyticsMqttTools, registerDataTransformationTools } from './tools/dataHub';

export function createMcpServer(): McpServer {
  const server = new McpServer({
    name: 'axis-mcp',
    version: APP_VERSION,
  });

  // Intercept every tool registration so guardrails run before the tool body.
  const originalRegisterTool = server.registerTool.bind(server);
  (server as unknown as { registerTool: typeof server.registerTool }).registerTool = ((
    name: string,
    config: unknown,
    cb: (...a: unknown[]) => unknown,
  ) =>
    (originalRegisterTool as unknown as (n: string, c: unknown, f: unknown) => unknown)(
      name,
      config,
      async (...args: unknown[]) => {
        const refusal = await checkGuardrails(name);
        if (refusal) return errorResult(refusal);
        return cb(...args);
      },
    )) as typeof server.registerTool;

  registerDeviceTools(server);
  registerImagingTools(server);
  registerEventTools(server);
  registerAppTools(server);
  registerSystemTools(server);
  registerPtzTools(server);
  registerIoTools(server);
  registerStorageTools(server);
  registerStreamingTools(server);
  registerCamStreamerTools(server);
  registerCamSwitcherTools(server);
  registerCamOverlayTools(server);
  registerAoaTools(server);
  registerLpvTools(server);
  registerVmd4Tools(server);
  registerQueueMonitorTools(server);
  registerGuardAppTools(server);
  registerLegacyAnalyticsTools(server);
  registerDemographicsTools(server);
  registerPeopleCounterTools(server);
  registerP8815PeopleCounterTools(server);
  registerOverlayTools(server);
  registerZipstreamTools(server);
  registerViewAreaTools(server);
  registerImageTuningTools(server);
  registerGuardTourTools(server);
  registerPtzAutotrackerTools(server);
  registerPtzOrientationAidTools(server);
  registerDiagnosticsTools(server);
  registerFindMyDeviceTools(server);
  registerFeatureFlagTools(server);
  registerRegionalSettingsTools(server);
  registerMdnsSdTools(server);
  registerGeolocationTools(server);
  registerNtpTools(server);
  registerNetworkSettingsTools(server);
  registerStreamingApiTools(server);
  registerAudioTools(server);
  registerParamApiTools(server);
  registerDeviceModeTools(server);
  registerObjectSnapshotTools(server);
  registerCoordinateConversionTools(server);
  registerEventScheduleTools(server);
  registerRecordingGroupTools(server);
  registerRemoteObjectStorageTools(server);
  registerNetworkPairingTools(server);
  registerCameraPairingTools(server);
  registerAnalyticsMqttTools(server);
  registerDataTransformationTools(server);

  return server;
}
