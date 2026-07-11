// Device Data Hub adjacent APIs: Analytics MQTT API (publish specific
// analytics data sources straight to MQTT topics — complements the
// Event-Service-oriented mqtt_* tools in streamingApis.ts) and Data
// transformation API (BETA — reshape/filter Device Data Hub topics with JQ
// expressions before consumers see them).
// See:
//   https://developer.axis.com/vapix/device-configuration/analytics-mqtt-api/
//   https://developer.axis.com/vapix/device-configuration/data-transformation/
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { guard, ToolResult } from './util';
import { dcGet, dcPatch, dcPost, dcDelete, dcResult } from './deviceConfigApi';

function compact(obj: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined));
}

/** The Data transformation API addresses existing transforms by outputTopic with dots replaced by slashes in the URL path. */
function topicPath(outputTopic: string): string {
  return outputTopic.split('.').map(encodeURIComponent).join('/');
}

export function registerAnalyticsMqttTools(server: McpServer): void {
  const hint = 'Analytics MQTT API not available on this model (/config/rest/analytics-mqtt/v1 returned 404).';

  server.registerTool(
    'analyticsmqtt_list_data_sources',
    {
      title: 'List analytics data sources',
      description: 'List internal analytics data sources (e.g. "com.axis.analytics_scene_description.v0.beta#1", "com.axis.consolidated_track.v1.beta#1") available to publish over MQTT.',
      inputSchema: {},
    },
    async (): Promise<ToolResult> =>
      guard(async () => {
        const { httpStatus, response } = await dcGet('analytics-mqtt/v1/data_sources');
        return dcResult(httpStatus, response, hint);
      }),
  );

  server.registerTool(
    'analyticsmqtt_list_publishers',
    {
      title: 'List analytics MQTT publishers',
      description: 'List configured publishers that forward an analytics data source to an MQTT topic (requires the MQTT client to be configured/active — see mqtt_configure_client).',
      inputSchema: {},
    },
    async (): Promise<ToolResult> =>
      guard(async () => {
        const { httpStatus, response } = await dcGet('analytics-mqtt/v1/publishers');
        return dcResult(httpStatus, response, hint);
      }),
  );

  server.registerTool(
    'analyticsmqtt_add_publisher',
    {
      title: 'Add an analytics MQTT publisher',
      description: 'Create a publisher that sends an analytics data source (from analyticsmqtt_list_data_sources) to an MQTT topic.',
      inputSchema: {
        id: z.string().describe('Publisher identifier.'),
        dataSourceKey: z.string().describe('Data source key from analyticsmqtt_list_data_sources.'),
        mqttTopic: z.string().describe('Destination MQTT topic, e.g. "cameras/entrance/scene".'),
        qos: z.union([z.literal(0), z.literal(1), z.literal(2)]).optional(),
        retain: z.boolean().optional(),
        useTopicPrefix: z.boolean().optional().describe('Prefix the topic with the device topic prefix configured in mqtt_configure_client.'),
      },
    },
    async (args): Promise<ToolResult> =>
      guard(async () => {
        const body = compact({
          id: args.id,
          data_source_key: args.dataSourceKey,
          mqtt_topic: args.mqttTopic,
          qos: args.qos,
          retain: args.retain,
          use_topic_prefix: args.useTopicPrefix,
        });
        const { httpStatus, response } = await dcPost('analytics-mqtt/v1/publishers', body);
        return dcResult(httpStatus, response, hint);
      }),
  );

  server.registerTool(
    'analyticsmqtt_remove_publisher',
    {
      title: 'Remove an analytics MQTT publisher',
      description: 'Stop and remove a publisher by ID.',
      inputSchema: { id: z.string() },
    },
    async (args): Promise<ToolResult> =>
      guard(async () => {
        const { httpStatus, response } = await dcDelete(`analytics-mqtt/v1/publishers/${encodeURIComponent(args.id)}`);
        return dcResult(httpStatus, response, hint);
      }),
  );
}

export function registerDataTransformationTools(server: McpServer): void {
  const hint = 'Data transformation API not available on this model (BETA — /config/rest/data-transformation/v1beta returned 404).';

  server.registerTool(
    'datatransform_list_topics',
    {
      title: 'List available Device Data Hub input topics',
      description: 'List Device Data Hub topics that can be used as a transform input, with their keys and current version. New topics can appear at any time, and non-existent topics can still be targeted by a transform ahead of time.',
      inputSchema: {},
    },
    async (): Promise<ToolResult> =>
      guard(async () => {
        const { httpStatus, response } = await dcGet('data-transformation/v1beta/availableTopics/topics');
        return dcResult(httpStatus, response, hint);
      }),
  );

  server.registerTool(
    'datatransform_list',
    {
      title: 'List data transforms',
      description: 'List configured JQ transforms between Device Data Hub topics.',
      inputSchema: {},
    },
    async (): Promise<ToolResult> =>
      guard(async () => {
        const { httpStatus, response } = await dcGet('data-transformation/v1beta/transforms');
        return dcResult(httpStatus, response, hint);
      }),
  );

  server.registerTool(
    'datatransform_create',
    {
      title: 'Create a data transform',
      description:
        'Create a JQ transform from an input Device Data Hub topic to a new output topic (which must be prefixed "com.axis.dt."). Useful to filter/reshape ' +
        'data before external consumers (e.g. via MQTT) see it — for example, extracting only track_events, or converting a timestamp format. ' +
        'The output topic can then be subscribed to like any other Device Data Hub topic, e.g. via analyticsmqtt_add_publisher or mqtt subscriptions.',
      inputSchema: {
        inputTopic: z.string().describe('Input topic name, from datatransform_list_topics.'),
        jqExpression: z.string().describe('The JQ program to transform input JSON to output JSON, e.g. ".track_events".'),
        outputTopic: z.string().describe('Output topic name; must start with "com.axis.dt.".'),
        outputTopicDescription: z.string().optional(),
        outputTopicVersion: z.string().optional().describe('Defaults to the input topic\'s version.'),
      },
    },
    async (args): Promise<ToolResult> =>
      guard(async () => {
        const body = compact({
          inputTopic: args.inputTopic,
          jqExpression: args.jqExpression,
          outputTopic: args.outputTopic,
          outputTopicDescription: args.outputTopicDescription,
          outputTopicVersion: args.outputTopicVersion,
        });
        const { httpStatus, response } = await dcPost('data-transformation/v1beta/transforms', body);
        return dcResult(httpStatus, response, hint);
      }),
  );

  server.registerTool(
    'datatransform_update',
    {
      title: 'Update a data transform',
      description: 'Update the optional fields (description/version) of an existing transform, identified by its current output topic.',
      inputSchema: {
        outputTopic: z.string().describe('The transform\'s current output topic (key).'),
        newOutputTopic: z.string().optional(),
        outputTopicDescription: z.string().optional(),
        outputTopicVersion: z.string().optional(),
      },
    },
    async (args): Promise<ToolResult> =>
      guard(async () => {
        const body = compact({ outputTopic: args.newOutputTopic, outputTopicDescription: args.outputTopicDescription, outputTopicVersion: args.outputTopicVersion });
        const { httpStatus, response } = await dcPatch(`data-transformation/v1beta/transforms/${topicPath(args.outputTopic)}`, body);
        return dcResult(httpStatus, response, hint);
      }),
  );

  server.registerTool(
    'datatransform_remove',
    {
      title: 'Remove a data transform',
      description: 'Delete a transform by its output topic.',
      inputSchema: { outputTopic: z.string() },
    },
    async (args): Promise<ToolResult> =>
      guard(async () => {
        const { httpStatus, response } = await dcDelete(`data-transformation/v1beta/transforms/${topicPath(args.outputTopic)}`);
        return dcResult(httpStatus, response, hint);
      }),
  );

  server.registerTool(
    'datatransform_get_statistics',
    {
      title: 'Get data transform runtime statistics',
      description: 'Get runtime statistics for a transform (message/byte counts, average processing time, drop/error counts, last error). Resets on modification or device restart.',
      inputSchema: { outputTopic: z.string() },
    },
    async (args): Promise<ToolResult> =>
      guard(async () => {
        const { httpStatus, response } = await dcGet(`data-transformation/v1beta/transforms/${topicPath(args.outputTopic)}/statistics`);
        return dcResult(httpStatus, response, hint);
      }),
  );
}
