// Recording group API + Remote Object Storage API — the newer cloud-recording
// pipeline (distinct from storage.ts's local SD-card list/start/stop): a
// recording group defines segment/retention/encryption settings and points at
// one or more remote object storage destinations (S3/Azure), which are
// registered separately via the Remote Object Storage API.
// See:
//   https://developer.axis.com/vapix/device-configuration/recording-group/
//   https://developer.axis.com/vapix/device-configuration/remote-object-storage-api/
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { guard, ToolResult } from './util';
import { dcGet, dcPatch, dcPost, dcDelete, dcResult } from './deviceConfigApi';

function compact(obj: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined));
}

export function registerRecordingGroupTools(server: McpServer): void {
  const hint = 'Recording group API not available on this model (/config/rest/recording-group/v2 returned 404).';

  server.registerTool(
    'recordinggroup_list',
    {
      title: 'List recording groups',
      description: 'List all configured recording groups: segment/retention settings, container format, encryption, and remote storage destination(s) each group uploads to.',
      inputSchema: {},
    },
    async (): Promise<ToolResult> =>
      guard(async () => {
        const { httpStatus, response } = await dcGet('recording-group/v2/recordingGroups');
        return dcResult(httpStatus, response, hint);
      }),
  );

  server.registerTool(
    'recordinggroup_create',
    {
      title: 'Create a recording group',
      description:
        'Create a recording group that uploads segmented recordings to a remote object storage destination (see remotestorage_list/remotestorage_add) or to a ' +
        'Recording Data Producer. Exactly one of streamOptions (a stream URL query string, e.g. "camera=1&videocodec=h264&fps=30&resolution=1920x1080&compression=30&audio=1") ' +
        'or dataProducerOptions must be set, not both. Encryption is only available with containerFormat "cmaf".',
      inputSchema: {
        destinationId: z.string().describe('ID of a remote object storage destination from remotestorage_list.'),
        destinationPrefix: z.string().optional().describe('Prefix attached to uploaded object names.'),
        destinationPostfix: z.string().optional().describe('Postfix attached to uploaded object names.'),
        niceName: z.string().optional(),
        description: z.string().optional(),
        containerFormat: z.enum(['matroska', 'cmaf']).optional().describe('Default: matroska.'),
        streamOptions: z.string().optional().describe('Stream URL query string. Mutually exclusive with dataProducerOptions.'),
        dataProducerOptions: z.object({ producerId: z.string(), producerConfiguration: z.record(z.string(), z.any()).optional() }).optional(),
        maxRetentionTime: z.number().int().min(0).optional().describe('Hours. 0/omitted = unlimited.'),
        spanDuration: z.number().int().min(0).optional().describe('Seconds. Default 3600.'),
        segmentDuration: z.object({ target: z.number().int(), max: z.number().int() }).optional().describe('Seconds. Default target/max 15/30.'),
        segmentSize: z.object({ target: z.number().int(), max: z.number().int() }).optional().describe('Bytes. Default target/max ~15MiB/25MiB.'),
        preDuration: z.number().int().min(0).optional().describe('Milliseconds included before a recording starts.'),
        postDuration: z.number().int().min(0).optional().describe('Milliseconds included after a recording stops.'),
        encryption: z
          .object({
            protectionScheme: z.literal('CENC'),
            contentEncryption: z.object({ key: z.string(), keyId: z.string() }).optional().describe('Fixed 128-bit hex key + UUID. Exclusive with keyEncryption.'),
            keyEncryption: z
              .object({
                certificateIds: z.array(z.string()).optional(),
                publicKeys: z.array(z.object({ key: z.string(), keyId: z.string() })).optional(),
                keyRotationDuration: z.number().int(),
              })
              .optional()
              .describe('Rotating-key encryption. Exclusive with contentEncryption.'),
          })
          .optional(),
        objectAttributes: z.array(z.object({ key: z.string(), value: z.string() })).max(3).optional().describe('Up to 3 fixed key-value tags set on every stored object.'),
      },
    },
    async (args): Promise<ToolResult> =>
      guard(async () => {
        const body = compact({
          destinations: [{ remoteObjectStorage: compact({ id: args.destinationId, prefix: args.destinationPrefix, postfix: args.destinationPostfix }) }],
          niceName: args.niceName,
          description: args.description,
          containerFormat: args.containerFormat,
          streamOptions: args.streamOptions,
          dataProducerOptions: args.dataProducerOptions,
          maxRetentionTime: args.maxRetentionTime,
          spanDuration: args.spanDuration,
          segmentDuration: args.segmentDuration,
          segmentSize: args.segmentSize,
          preDuration: args.preDuration,
          postDuration: args.postDuration,
          encryption: args.encryption,
          objectAttributes: args.objectAttributes,
        });
        const { httpStatus, response } = await dcPost('recording-group/v2/recordingGroups', body);
        return dcResult(httpStatus, response, hint);
      }),
  );

  server.registerTool(
    'recordinggroup_delete',
    {
      title: 'Delete a recording group',
      description: 'Delete a recording group by ID. This stops new recordings from being made in it (existing uploaded recordings are unaffected).',
      inputSchema: { id: z.string() },
    },
    async (args): Promise<ToolResult> =>
      guard(async () => {
        const { httpStatus, response } = await dcDelete(`recording-group/v2/recordingGroups/${encodeURIComponent(args.id)}`);
        return dcResult(httpStatus, response, hint);
      }),
  );
}

export function registerRemoteObjectStorageTools(server: McpServer): void {
  const hint = 'Remote Object Storage API not available on this model (/config/rest/remote-object-storage/v1 returned 404).';

  server.registerTool(
    'remotestorage_list',
    {
      title: 'List remote storage destinations',
      description: 'List configured remote object storage destinations (S3/Azure) usable as recording-group upload targets. Secrets (keys/tokens) are redacted in the response.',
      inputSchema: {},
    },
    async (): Promise<ToolResult> =>
      guard(async () => {
        const { httpStatus, response } = await dcGet('remote-object-storage/v1/destinations');
        return dcResult(httpStatus, response, hint);
      }),
  );

  server.registerTool(
    'remotestorage_add',
    {
      title: 'Add a remote storage destination',
      description:
        'Register a new S3 or Azure remote object storage destination (provide exactly one of "s3" or "azure"). Once added, reference its ID from ' +
        'recordinggroup_create to upload recordings there. Credentials are write-only — never returned by remotestorage_list.',
      inputSchema: {
        id: z.string().describe('Unique ID for this destination, e.g. "aws1".'),
        description: z.string().optional(),
        s3: z
          .object({ accessKeyId: z.string(), secretAccessKey: z.string(), sessionToken: z.string().optional(), region: z.string().optional(), url: z.string(), bucket: z.string() })
          .optional(),
        azure: z.object({ accountName: z.string(), container: z.string(), sharedKey: z.string().optional(), sas: z.string().optional(), url: z.string().optional() }).optional(),
      },
    },
    async (args): Promise<ToolResult> =>
      guard(async () => {
        const body = compact({ id: args.id, description: args.description, s3: args.s3, azure: args.azure });
        const { httpStatus, response } = await dcPost('remote-object-storage/v1/destinations', body);
        return dcResult(httpStatus, response, hint);
      }),
  );

  server.registerTool(
    'remotestorage_update',
    {
      title: 'Update a remote storage destination',
      description: 'Update fields of an existing destination by ID (e.g. rotate a SAS token or access key). Only supplied fields are changed.',
      inputSchema: {
        id: z.string(),
        description: z.string().optional(),
        s3: z.record(z.string(), z.any()).optional(),
        azure: z.record(z.string(), z.any()).optional(),
      },
    },
    async (args): Promise<ToolResult> =>
      guard(async () => {
        const body = compact({ description: args.description, s3: args.s3, azure: args.azure });
        const { httpStatus, response } = await dcPatch(`remote-object-storage/v1/destinations/${encodeURIComponent(args.id)}`, body);
        return dcResult(httpStatus, response, hint);
      }),
  );

  server.registerTool(
    'remotestorage_remove',
    {
      title: 'Remove a remote storage destination',
      description: 'Remove a remote storage destination by ID. Check that no recording group still references it first.',
      inputSchema: { id: z.string() },
    },
    async (args): Promise<ToolResult> =>
      guard(async () => {
        const { httpStatus, response } = await dcDelete(`remote-object-storage/v1/destinations/${encodeURIComponent(args.id)}`);
        return dcResult(httpStatus, response, hint);
      }),
  );

  server.registerTool(
    'remotestorage_get_failover',
    {
      title: 'Get failover storage configuration',
      description:
        'Get the local failover configuration used when recordings can\'t be uploaded to the remote object store (disk selection, storage/upload bandwidth limits). ' +
        'Enabled by AUTO disk selection with no limits by default.',
      inputSchema: {},
    },
    async (): Promise<ToolResult> =>
      guard(async () => {
        const { httpStatus, response } = await dcGet('remote-object-storage/v1/failover');
        return dcResult(httpStatus, response, hint);
      }),
  );

  server.registerTool(
    'remotestorage_set_failover',
    {
      title: 'Set failover storage configuration',
      description: 'Configure or disable local failover storage. Pass disable:true to turn failover off entirely (unuploadable recordings will then be dropped, not stored locally).',
      inputSchema: {
        disable: z.boolean().optional(),
        diskSelection: z.enum(['AUTO', 'MANUAL']).optional(),
        diskId: z.string().optional().describe('Required in MANUAL mode.'),
        storageLimit: z.number().int().optional().describe('KiB. MANUAL mode only.'),
        uploadLimit: z.number().int().optional().describe('kbit/s bandwidth cap for re-uploading failover objects.'),
      },
    },
    async (args): Promise<ToolResult> =>
      guard(async () => {
        const value = args.disable ? null : compact({ diskSelection: args.diskSelection, diskId: args.diskId, storageLimit: args.storageLimit, uploadLimit: args.uploadLimit });
        const { httpStatus, response } = await dcPatch('remote-object-storage/v1/failover', value);
        return dcResult(httpStatus, response, hint);
      }),
  );
}
