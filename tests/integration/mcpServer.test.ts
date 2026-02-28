import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Logger } from 'pino';
import { describe, expect, test, vi } from 'vitest';

import type { AuditStore } from '../../src/audit/auditStore.js';
import type { AppConfig } from '../../src/config.js';
import type { HS4Client } from '../../src/hs4/client.js';
import { buildMcpServer } from '../../src/mcp/server.js';
import type { PolicyEngine } from '../../src/policy/policyEngine.js';

function makeConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    hs4BaseUrl: 'http://127.0.0.1',
    requestTimeoutMs: 10_000,
    readRetries: 1,
    readRetryBackoffMs: 10,
    includeEverythingOnStatus: false,
    maxDevicesDefaultCap: 250,
    statusCacheTtlMs: 0,
    safeMode: 'read_write',
    requireConfirm: true,
    defaultDryRun: false,
    allowedDeviceRefs: null,
    allowedEventIds: null,
    allowedCameraIds: null,
    allowedScripts: null,
    allowedPluginFunctions: null,
    hs4AdminEnabled: false,
    hs4AdminUsersEnabled: false,
    hs4AdminPluginsEnabled: false,
    hs4AdminInterfacesEnabled: false,
    hs4AdminSystemEnabled: false,
    hs4AdminCamerasEnabled: false,
    hs4AdminEventsEnabled: false,
    hs4AdminConfigEnabled: false,
    hs4AdminMaintenanceWindowId: undefined,
    hs4AdminAllowedMaintenanceWindowIds: null,
    hs4AdminRequireChangeTicket: true,
    hs4AdminRollbackEnabled: true,
    hs4AdminExecutionMode: 'adapter',
    hs4AdminDirectFallback: true,
    hs4AdminCapabilityCacheTtlSec: 300,
    hs4AdminAllowedUserIds: null,
    hs4AdminAllowedPluginIds: null,
    hs4AdminAllowedInterfaceIds: null,
    hs4AdminAllowedCategoryIds: null,
    scriptPagePath: '/runscript.html',
    hs4EventsDataPath: '/usr/local/HomeSeer/Data/HomeSeerData_2.json/events.json',
    hs4EventGroupsDataPath: '/usr/local/HomeSeer/Data/HomeSeerData_2.json/eventgroups.json',
    hs4AliasLearnedEnabled: true,
    hs4AliasConfigPath: undefined,
    hs4ChangeTokenTtlSec: 900,
    hs4ChangeTokenMaxEntries: 2000,
    hs4ChangeTokenPersistPath: undefined,
    mcpTransport: 'stdio',
    mcpHttpHost: '127.0.0.1',
    mcpHttpPort: 7422,
    mcpHttpAllowNonLoopback: false,
    mcpHttpAcceptMode: 'compat',
    mcpHttpAllowJsonOnly: true,
    mcpHttpAuthToken: undefined,
    mcpHttpAuthRequiredNonLoopback: true,
    mcpHttpAuthProtectHealthz: true,
    logLevel: 'info',
    auditMaxEntries: 500,
    ...overrides
  };
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function makeLogger(): Logger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn()
  } as unknown as Logger;
}

function makeStatusPayload(name: string, status: string): Record<string, unknown> {
  return {
    Name: name,
    Version: '4.2.22.4',
    TempFormatF: true,
    Devices: [
      {
        Ref: 101,
        Name: 'Kitchen Light',
        Location: 'Kitchen',
        Location2: 'Main',
        Status: status,
        Value: status === 'On' ? 100 : 0,
        Last_Change: '2026-01-01T00:00:00Z',
        Interface_Name: 'Z-Wave'
      }
    ]
  };
}

function makeSingleDevicePayload(args: {
  ref: number;
  name: string;
  status: string;
  value: number;
  controlPairs?: Array<{ label: string; value: number }>;
}): Record<string, unknown> {
  return {
    Name: 'Status A',
    Version: '4.2.22.4',
    TempFormatF: true,
    Devices: [
      {
        Ref: args.ref,
        Name: args.name,
        Location: 'Kitchen',
        Location2: 'Main',
        Status: args.status,
        Value: args.value,
        Last_Change: '2026-01-01T00:00:00Z',
        Interface_Name: 'Z-Wave',
        ...(args.controlPairs
          ? {
              ControlPairs: args.controlPairs.map((pair) => ({
                Label: pair.label,
                ControlValue: pair.value
              }))
            }
          : {})
      }
    ]
  };
}

function makeParentChildLightingPayload(): Record<string, unknown> {
  return {
    Name: 'Status A',
    Version: '4.2.22.4',
    TempFormatF: true,
    Devices: [
      {
        Ref: 141,
        Name: 'Coffee Bar',
        Location: 'Kitchen',
        Location2: 'Node 9',
        Status: 'No Status',
        Value: 0,
        Relationship: '2',
        AssociatedDevices: [143]
      },
      {
        Ref: 143,
        Name: 'Coffee Bar',
        Location: 'Kitchen',
        Location2: 'LD',
        Status: 'Off',
        Value: 0,
        ParentRef: 141,
        Relationship: '4',
        ControlPairs: [
          { Label: 'Off', ControlValue: 0 },
          { Label: 'On', ControlValue: 99 },
          { Label: 'Dim (value)%', ControlValue: 1 }
        ],
        AssociatedDevices: [141]
      },
      {
        Ref: 144,
        Name: 'Bar Overhead Light Master',
        Location: 'Kitchen',
        Location2: 'Node 10',
        Status: 'No Status',
        Value: 0,
        Relationship: '2',
        AssociatedDevices: [146]
      },
      {
        Ref: 146,
        Name: 'Bar Overhead Light',
        Location: 'Family Room',
        Location2: 'LC1',
        Status: 'Off',
        Value: 0,
        ParentRef: 144,
        Relationship: '4',
        ControlPairs: [
          { Label: 'Off', ControlValue: 0 },
          { Label: 'On', ControlValue: 99 },
          { Label: 'Dim (value)%', ControlValue: 1 }
        ],
        AssociatedDevices: [144]
      }
    ]
  };
}

function extractSuccess(result: unknown): Record<string, unknown> {
  const value = result as {
    isError?: boolean;
    structuredContent?: { result?: Record<string, unknown> };
  };
  expect(value.isError).not.toBe(true);
  expect(value.structuredContent?.result).toBeDefined();
  return value.structuredContent?.result as Record<string, unknown>;
}

function extractResourceText(result: unknown): string {
  const value = result as {
    contents: Array<{ text?: string }>;
  };
  expect(value.contents.length).toBeGreaterThan(0);
  expect(typeof value.contents[0]?.text).toBe('string');
  return value.contents[0]?.text as string;
}

interface ServerHarness {
  server: ReturnType<typeof buildMcpServer>;
  client: Client;
  hs4: {
    getStatus: ReturnType<typeof vi.fn>;
    runEvent: ReturnType<typeof vi.fn>;
    runScriptCommand: ReturnType<typeof vi.fn>;
    pluginFunction: ReturnType<typeof vi.fn>;
    usersCreate: ReturnType<typeof vi.fn>;
    getPluginList: ReturnType<typeof vi.fn>;
    getCameras: ReturnType<typeof vi.fn>;
    controlDeviceByValue: ReturnType<typeof vi.fn>;
    setDeviceStatus: ReturnType<typeof vi.fn>;
    panCamera: ReturnType<typeof vi.fn>;
    setDeviceProperty: ReturnType<typeof vi.fn>;
  };
  policyEvaluate: ReturnType<typeof vi.fn>;
  auditLatest: ReturnType<typeof vi.fn>;
  close: () => Promise<void>;
}

async function createHarness(
  options: {
    statusPayloads?: unknown[];
    eventsPayload?: unknown;
    statusCacheTtlMs?: number;
    configOverrides?: Partial<AppConfig>;
    policyEvaluate?: (input: Record<string, unknown>) => {
      allowed: boolean;
      effectiveDryRun: boolean;
      reasons: string[];
      normalized?: Record<string, unknown>;
    };
    auditLatestEntries?: Array<Record<string, unknown>>;
  } = {}
): Promise<ServerHarness> {
  const payloads = (options.statusPayloads ?? [makeStatusPayload('Status A', 'Off')]).map((payload) => clone(payload));
  const eventsPayload = clone(
    options.eventsPayload ?? {
      Events: []
    }
  );
  let index = 0;

  const getEvents = vi.fn(async () => clone(eventsPayload));
  const getStatus = vi.fn(async () => {
    const payload = payloads[Math.min(index, payloads.length - 1)];
    index += 1;
    return clone(payload);
  });
  const runEvent = vi.fn(async () => ({ Response: 'ok' }));
  const runScriptCommand = vi.fn(async () => ({ responseArray: ['response', 'ok'], commands: [] }));
  const pluginFunction = vi.fn(async () => ({ Response: 'ok' }));
  const usersCreate = vi.fn(async () => ({ Response: 'ok' }));
  const controlDeviceByValue = vi.fn(async () => ({ Response: 'ok' }));
  const setDeviceStatus = vi.fn(async () => ({ Response: 'ok' }));
  const panCamera = vi.fn(async () => ({ Response: 'ok' }));
  const getPluginList = vi.fn(async () => ({
    Plugins: [
      {
        Name: 'Sample Plugin',
        Id: 'sample-plugin',
        Enabled: true
      }
    ]
  }));
  const getCameras = vi.fn(async () => ({
    Cameras: [
      {
        CamID: 10,
        Name: 'Front Door'
      }
    ]
  }));
  const setDeviceProperty = vi.fn(async () => ({ Response: 'ok' }));

  const hs4Client = {
    getVersion: vi.fn(async () => '4.2.22.4'),
    getStatus,
    getEvents,
    runEvent,
    controlDeviceByValue,
    setDeviceStatus,
    runScriptCommand,
    pluginFunction,
    usersCreate,
    getPluginList,
    getCameras,
    getCameraSnapshot: vi.fn(async () => ({ Response: 'ok' })),
    panCamera,
    getControl2: vi.fn(async () => ({ Controls: [] })),
    setDeviceProperty
  };

  const policyEvaluate = vi.fn((input: Record<string, unknown>) => {
    if (options.policyEvaluate) {
      return options.policyEvaluate(input);
    }
    return {
      allowed: true,
      effectiveDryRun: Boolean(input.dryRun),
      reasons: []
    };
  });

  const policy = {
    evaluateMutation: policyEvaluate
  } as unknown as PolicyEngine;

  const auditLatestEntries = options.auditLatestEntries ?? [];
  const auditLatest = vi.fn(() => clone(auditLatestEntries));
  const audit = {
    record: vi.fn(async (entry: Record<string, unknown>) => ({
      id: 'audit-id',
      timestamp: '2026-01-01T00:00:00.000Z',
      ...entry
    })),
    query: vi.fn(() => []),
    latest: auditLatest
  } as unknown as AuditStore;

  const server = buildMcpServer({
    config: makeConfig({
      statusCacheTtlMs: options.statusCacheTtlMs ?? 0,
      ...(options.configOverrides ?? {})
    }),
    logger: makeLogger(),
    client: hs4Client as unknown as HS4Client,
    policy,
    audit
  });

  const client = new Client(
    {
      name: 'mcp-server-test-client',
      version: '1.0.0'
    },
    {
      capabilities: {}
    }
  );

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);

  return {
    server,
    client,
    hs4: {
      getStatus,
      runEvent,
      runScriptCommand,
      pluginFunction,
      usersCreate,
      getPluginList,
      getCameras,
      controlDeviceByValue,
      setDeviceStatus,
      panCamera,
      setDeviceProperty
    },
    policyEvaluate,
    auditLatest,
    close: async () => {
      await Promise.allSettled([client.close(), server.close()]);
    }
  };
}

describe('buildMcpServer transport-level behavior', () => {
  test('returns structured BAD_REQUEST shape for invalid hs4.events.run input', async () => {
    const harness = await createHarness();
    try {
      const result = await harness.client.callTool({
        name: 'hs4.events.run',
        arguments: {}
      });

      expect(result.isError).toBe(true);
      expect(result.structuredContent).toEqual(
        expect.objectContaining({
          error: expect.objectContaining({
            code: 'BAD_REQUEST',
            message: 'Provide id, or provide both group and name.',
            retryable: false,
            fixHint: expect.any(String),
            suggestedNextToolCalls: expect.any(Array)
          })
        })
      );
      expect(JSON.parse((result.content[0] as { text: string }).text)).toEqual(
        expect.objectContaining({
          error: expect.objectContaining({
            code: 'BAD_REQUEST',
            message: 'Provide id, or provide both group and name.',
            retryable: false,
            fixHint: expect.any(String),
            suggestedNextToolCalls: expect.any(Array)
          })
        })
      );
      expect(harness.hs4.runEvent).not.toHaveBeenCalled();
    } finally {
      await harness.close();
    }
  });

  test('hs4.events.get returns matched event with extracted definition fields', async () => {
    const harness = await createHarness({
      eventsPayload: {
        Events: [
          {
            id: 29,
            Group: 'Scenes',
            Name: 'Master Bedroom ALL lights ON',
            Trigger: { type: 'manual' },
            Actions: [{ type: 'device', ref: 101, value: 100 }],
            voice_command: '',
            voice_command_enabled: false
          }
        ]
      }
    });
    try {
      const result = await harness.client.callTool({
        name: 'hs4.events.get',
        arguments: {
          id: 29
        }
      });

      const payload = extractSuccess(result);
      expect(payload.id).toBe(29);
      expect(payload.group).toBe('Scenes');
      expect(payload.name).toBe('Master Bedroom ALL lights ON');
      expect(payload.matchedBy).toBe('id');
      expect(payload).toHaveProperty('raw');
      expect(payload).toHaveProperty('details');

      const details = payload.details as Record<string, unknown>;
      expect(details.hasExtendedDefinition).toBe(true);
      expect(details.trigger).toEqual({ type: 'manual' });
      expect(details.actions).toEqual([{ type: 'device', ref: 101, value: 100 }]);
    } finally {
      await harness.close();
    }
  });

  test('hs4.events.definition.get parses persisted event file and resolves refs', async () => {
    const fixtureDir = await mkdtemp(join(tmpdir(), 'hs4-events-fixture-'));
    const eventsPath = join(fixtureDir, 'events.json');
    const eventGroupsPath = join(fixtureDir, 'eventgroups.json');

    await writeFile(
      eventsPath,
      JSON.stringify(
        [
          {
            evRef: 29,
            mvarGroupRef: 1470538601,
            Name: 'Master Bedroom ALL lights ON',
            sType: 'Scene',
            Last_Trigger_Time: '2026-02-24T12:00:00.000Z',
            Triggers: {
              TrigGroups: {
                K0: {
                  $values: [
                    {
                      $type: 'Scheduler.Classes.EvTrig_DEVICE_VALUE, Scheduler',
                      ev_trig_dvRef: 557,
                      TriggerSubType: 7,
                      mvarOperationSelected: true,
                      mvarValue_or_Start: 99,
                      ValEnd_Spec: -99999.98765
                    }
                  ]
                }
              }
            },
            ConditionalActions: [
              {
                mvarActions: {
                  K0: {
                    $type: 'Scheduler.Classes.EvACT_DEVICE, Scheduler',
                    delay: '00:00:00',
                    devices: {
                      K554: {
                        dvRef: 554,
                        ControlLabel: 'On',
                        ControlValue: 255
                      }
                    }
                  }
                },
                mvarConditions: []
              }
            ]
          }
        ],
        null,
        2
      ),
      'utf8'
    );

    await writeFile(
      eventGroupsPath,
      JSON.stringify(
        [
          {
            Group: 'Scenes',
            Ref: 1470538601
          }
        ],
        null,
        2
      ),
      'utf8'
    );

    const harness = await createHarness({
      statusPayloads: [
        {
          Name: 'Status A',
          Version: '4.2.22.4',
          TempFormatF: true,
          Devices: [
            {
              Ref: 554,
              Name: 'Master Bedroom Lamp',
              Location: 'Master Bedroom',
              Location2: 'ZP03',
              Status: 'Off',
              Value: 0,
              Interface_Name: 'ZWavePlus'
            },
            {
              Ref: 557,
              Name: 'Light',
              Location: 'Master Bedroom',
              Location2: 'ZS02',
              Status: 'On',
              Value: 99,
              Interface_Name: 'ZWavePlus'
            }
          ]
        }
      ],
      configOverrides: {
        hs4EventsDataPath: eventsPath,
        hs4EventGroupsDataPath: eventGroupsPath
      }
    });

    try {
      const result = await harness.client.callTool({
        name: 'hs4.events.definition.get',
        arguments: {
          id: 29,
          resolveDeviceRefs: true
        }
      });

      const payload = extractSuccess(result);
      const event = payload.event as Record<string, unknown>;
      const refs = payload.refs as Record<string, unknown>;
      const summary = payload.summary as Record<string, unknown>;
      const triggers = payload.triggers as Array<Record<string, unknown>>;
      const conditionalActions = payload.conditionalActions as Array<Record<string, unknown>>;
      const resolvedDevices = payload.resolvedDevices as Array<Record<string, unknown>>;

      expect(payload.matchedBy).toBe('id');
      expect(event.id).toBe(29);
      expect(event.group).toBe('Scenes');
      expect(event.name).toBe('Master Bedroom ALL lights ON');
      expect(summary.actionCount).toBe(1);
      expect(refs.triggerDeviceRefs).toEqual([557]);
      expect(refs.actionDeviceRefs).toEqual([554]);
      expect(refs.allDeviceRefs).toEqual([554, 557]);

      expect(triggers[0]?.groupKey).toBe('K0');
      expect((triggers[0]?.triggers as Array<Record<string, unknown>>)[0]?.deviceRef).toBe(557);

      const actionBlock = conditionalActions[0] as Record<string, unknown>;
      const actions = actionBlock.actions as Array<Record<string, unknown>>;
      const deviceActions = actions[0]?.deviceActions as Array<Record<string, unknown>>;
      expect(deviceActions[0]?.dvRef).toBe(554);
      expect(deviceActions[0]?.controlLabel).toBe('On');
      expect(deviceActions[0]?.controlValue).toBe(255);

      expect(resolvedDevices).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ ref: 554, found: true, name: 'Master Bedroom Lamp' }),
          expect.objectContaining({ ref: 557, found: true, name: 'Light' })
        ])
      );
    } finally {
      await harness.close();
      await rm(fixtureDir, { recursive: true, force: true });
    }
  });

  test('hs4.events.definition.get returns BAD_REQUEST when persisted event is missing', async () => {
    const fixtureDir = await mkdtemp(join(tmpdir(), 'hs4-events-missing-'));
    const eventsPath = join(fixtureDir, 'events.json');
    const eventGroupsPath = join(fixtureDir, 'eventgroups.json');

    await writeFile(eventsPath, JSON.stringify([], null, 2), 'utf8');
    await writeFile(eventGroupsPath, JSON.stringify([], null, 2), 'utf8');

    const harness = await createHarness({
      configOverrides: {
        hs4EventsDataPath: eventsPath,
        hs4EventGroupsDataPath: eventGroupsPath
      }
    });

    try {
      const result = await harness.client.callTool({
        name: 'hs4.events.definition.get',
        arguments: {
          id: 9999
        }
      });

      expect(result.isError).toBe(true);
      expect(result.structuredContent).toEqual(
        expect.objectContaining({
          error: expect.objectContaining({
            code: 'BAD_REQUEST',
            message: 'Event definition not found in persisted file.',
            retryable: false,
            fixHint: expect.any(String),
            suggestedNextToolCalls: expect.any(Array),
            details: {
              id: 9999,
              eventsPath,
              group: undefined,
              name: undefined,
              totalEvents: 0
            }
          })
        })
      );
    } finally {
      await harness.close();
      await rm(fixtureDir, { recursive: true, force: true });
    }
  });

  test('hs4.devices.get returns requested refs with found and missing lists', async () => {
    const harness = await createHarness({
      statusPayloads: [makeStatusPayload('Status A', 'Off')]
    });
    try {
      const result = await harness.client.callTool({
        name: 'hs4.devices.get',
        arguments: {
          refs: [101, 999, 101],
          resolveChildren: false
        }
      });

      const payload = extractSuccess(result);
      expect(payload.requestedRefs).toEqual([101, 999]);
      expect(payload.found).toEqual([101]);
      expect(payload.missing).toEqual([999]);
      expect(payload.returnedDevices).toBe(1);
      expect(payload.resolvedRefs).toEqual([101]);
    } finally {
      await harness.close();
    }
  });

  test('includeRaw defaults to false and strips raw in hs4.devices.get output', async () => {
    const harness = await createHarness({
      statusPayloads: [makeStatusPayload('Status A', 'Off')]
    });
    try {
      const withoutRawResult = await harness.client.callTool({
        name: 'hs4.devices.get',
        arguments: {
          refs: [101],
          resolveChildren: false
        }
      });
      const withoutRawPayload = extractSuccess(withoutRawResult);
      const withoutRawItem = (withoutRawPayload.items as Array<Record<string, unknown>>)[0];

      expect(withoutRawPayload.includeRaw).toBe(false);
      expect(withoutRawItem).not.toHaveProperty('raw');

      const withRawResult = await harness.client.callTool({
        name: 'hs4.devices.get',
        arguments: {
          refs: [101],
          includeRaw: true,
          resolveChildren: false
        }
      });
      const withRawPayload = extractSuccess(withRawResult);
      const withRawItem = (withRawPayload.items as Array<Record<string, unknown>>)[0];

      expect(withRawPayload.includeRaw).toBe(true);
      expect(withRawItem).toHaveProperty('raw');
    } finally {
      await harness.close();
    }
  });

  test('hs4.devices.set auto-switches set_status to control_value when value maps to a control pair', async () => {
    const harness = await createHarness({
      statusPayloads: [
        makeSingleDevicePayload({
          ref: 146,
          name: 'Bar Overhead Light',
          status: 'Off',
          value: 0,
          controlPairs: [
            { label: 'Off', value: 0 },
            { label: 'On', value: 99 }
          ]
        }),
        makeSingleDevicePayload({
          ref: 146,
          name: 'Bar Overhead Light',
          status: 'On',
          value: 99,
          controlPairs: [
            { label: 'Off', value: 0 },
            { label: 'On', value: 99 }
          ]
        })
      ]
    });
    try {
      const result = await harness.client.callTool({
        name: 'hs4.devices.set',
        arguments: {
          ref: 146,
          mode: 'set_status',
          value: 99,
          confirm: true,
          intent: 'Turn on bar overhead light',
          reason: 'Integration test for mode auto-switch'
        }
      });

      const payload = extractSuccess(result);
      expect(payload.mode).toBe('control_value');
      expect(payload.requestedMode).toBe('set_status');
      expect(payload.modeAutoSwitch).toEqual(expect.stringContaining('executed mode=control_value'));
      expect(payload.verification).toEqual(
        expect.objectContaining({
          matched: true
        })
      );
      expect(harness.hs4.controlDeviceByValue).toHaveBeenCalledTimes(1);
      expect(harness.hs4.setDeviceStatus).not.toHaveBeenCalled();
    } finally {
      await harness.close();
    }
  });

  test('hs4.devices.set retries with control_value when set_status verification fails', async () => {
    const harness = await createHarness({
      statusPayloads: [
        makeSingleDevicePayload({
          ref: 146,
          name: 'Bar Overhead Light',
          status: 'Off',
          value: 0
        }),
        makeSingleDevicePayload({
          ref: 146,
          name: 'Bar Overhead Light',
          status: 'Off',
          value: 0,
          controlPairs: [
            { label: 'Off', value: 0 },
            { label: 'On', value: 99 }
          ]
        }),
        makeSingleDevicePayload({
          ref: 146,
          name: 'Bar Overhead Light',
          status: 'Off',
          value: 0,
          controlPairs: [
            { label: 'Off', value: 0 },
            { label: 'On', value: 99 }
          ]
        }),
        makeSingleDevicePayload({
          ref: 146,
          name: 'Bar Overhead Light',
          status: 'Off',
          value: 0,
          controlPairs: [
            { label: 'Off', value: 0 },
            { label: 'On', value: 99 }
          ]
        }),
        makeSingleDevicePayload({
          ref: 146,
          name: 'Bar Overhead Light',
          status: 'Off',
          value: 0,
          controlPairs: [
            { label: 'Off', value: 0 },
            { label: 'On', value: 99 }
          ]
        }),
        makeSingleDevicePayload({
          ref: 146,
          name: 'Bar Overhead Light',
          status: 'On',
          value: 99,
          controlPairs: [
            { label: 'Off', value: 0 },
            { label: 'On', value: 99 }
          ]
        })
      ]
    });
    try {
      const result = await harness.client.callTool({
        name: 'hs4.devices.set',
        arguments: {
          ref: 146,
          mode: 'set_status',
          value: 99,
          confirm: true,
          intent: 'Turn on bar overhead light',
          reason: 'Integration test for fallback after verification mismatch'
        }
      });

      const payload = extractSuccess(result);
      expect(payload.mode).toBe('set_status');
      expect(payload.requestedMode).toBe('set_status');
      expect(payload.fallback).toEqual(
        expect.objectContaining({
          attempted: true,
          mode: 'control_value',
          matched: true
        })
      );
      expect(payload.verification).toEqual(
        expect.objectContaining({
          matched: true
        })
      );
      expect(harness.hs4.setDeviceStatus).toHaveBeenCalledTimes(1);
      expect(harness.hs4.controlDeviceByValue).toHaveBeenCalledTimes(1);
    } finally {
      await harness.close();
    }
  });

  test('hs4.devices.set returns HS4_ERROR when verification never converges', async () => {
    const harness = await createHarness({
      statusPayloads: [
        makeSingleDevicePayload({
          ref: 146,
          name: 'Bar Overhead Light',
          status: 'Off',
          value: 0,
          controlPairs: [
            { label: 'Off', value: 0 },
            { label: 'On', value: 99 }
          ]
        }),
        makeSingleDevicePayload({
          ref: 146,
          name: 'Bar Overhead Light',
          status: 'Off',
          value: 0,
          controlPairs: [
            { label: 'Off', value: 0 },
            { label: 'On', value: 99 }
          ]
        }),
        makeSingleDevicePayload({
          ref: 146,
          name: 'Bar Overhead Light',
          status: 'Off',
          value: 0,
          controlPairs: [
            { label: 'Off', value: 0 },
            { label: 'On', value: 99 }
          ]
        }),
        makeSingleDevicePayload({
          ref: 146,
          name: 'Bar Overhead Light',
          status: 'Off',
          value: 0,
          controlPairs: [
            { label: 'Off', value: 0 },
            { label: 'On', value: 99 }
          ]
        }),
        makeSingleDevicePayload({
          ref: 146,
          name: 'Bar Overhead Light',
          status: 'Off',
          value: 0,
          controlPairs: [
            { label: 'Off', value: 0 },
            { label: 'On', value: 99 }
          ]
        })
      ]
    });
    try {
      const result = await harness.client.callTool({
        name: 'hs4.devices.set',
        arguments: {
          ref: 146,
          mode: 'control_value',
          value: 99,
          confirm: true,
          intent: 'Turn on bar overhead light',
          reason: 'Integration test for non-converging write verification'
        }
      });

      expect(result.isError).toBe(true);
      expect(result.structuredContent).toEqual(
        expect.objectContaining({
          error: expect.objectContaining({
            code: 'HS4_ERROR',
            message: 'Device state did not converge to the requested target.'
          })
        })
      );
      expect(harness.hs4.controlDeviceByValue).toHaveBeenCalledTimes(1);
    } finally {
      await harness.close();
    }
  });

  test('resources expose thin/full variants and thin strips raw while full keeps it', async () => {
    const harness = await createHarness({
      statusPayloads: [makeStatusPayload('Status A', 'Off')]
    });
    try {
      const listed = await harness.client.listResources();
      const uris = listed.resources.map((resource) => resource.uri);

      expect(uris).toEqual(
        expect.arrayContaining([
          'hs4://devices/catalog',
          'hs4://devices/catalog/full',
          'hs4://devices/status',
          'hs4://devices/status/full'
        ])
      );

      const thinCatalog = await harness.client.readResource({ uri: 'hs4://devices/catalog' });
      const fullCatalog = await harness.client.readResource({ uri: 'hs4://devices/catalog/full' });

      const thinPayload = JSON.parse(extractResourceText(thinCatalog)) as {
        devices: Array<Record<string, unknown>>;
      };
      const fullPayload = JSON.parse(extractResourceText(fullCatalog)) as {
        devices: Array<Record<string, unknown>>;
      };

      expect(thinPayload.devices[0]).not.toHaveProperty('raw');
      expect(fullPayload.devices[0]).toHaveProperty('raw');
    } finally {
      await harness.close();
    }
  });

  test('status cache reuses payload until fresh=true is requested', async () => {
    const harness = await createHarness({
      statusPayloads: [makeStatusPayload('Snapshot A', 'Off'), makeStatusPayload('Snapshot B', 'On')],
      statusCacheTtlMs: 60_000
    });
    try {
      const first = extractSuccess(
        await harness.client.callTool({
          name: 'hs4.devices.status.get',
          arguments: {}
        })
      );
      const second = extractSuccess(
        await harness.client.callTool({
          name: 'hs4.devices.status.get',
          arguments: {}
        })
      );

      expect(harness.hs4.getStatus).toHaveBeenCalledTimes(1);

      const fresh = extractSuccess(
        await harness.client.callTool({
          name: 'hs4.devices.status.get',
          arguments: { fresh: true }
        })
      );

      expect(harness.hs4.getStatus).toHaveBeenCalledTimes(2);
      expect((first.snapshot as { name: string }).name).toBe('Snapshot A');
      expect((second.snapshot as { name: string }).name).toBe('Snapshot A');
      expect((fresh.snapshot as { name: string }).name).toBe('Snapshot B');
    } finally {
      await harness.close();
    }
  });

  test('admin tool is registered and returns structured success envelope', async () => {
    const harness = await createHarness();
    try {
      const listedTools = await harness.client.listTools();
      const toolNames = listedTools.tools.map((tool) => tool.name);
      expect(toolNames).toContain('hs4.admin.system.service.restart');

      const result = await harness.client.callTool({
        name: 'hs4.admin.system.service.restart',
        arguments: {
          service: 'hs4',
          confirm: true,
          intent: 'Restart HS4 service after maintenance',
          reason: 'Integration validation run',
          operationTier: 'operator',
          domain: 'system',
          maintenanceWindowId: 'mw-2026-02-23-01',
          changeTicket: 'chg-1001',
          riskLevel: 'medium'
        }
      });

      const payload = extractSuccess(result);
      expect(payload.result).toBe('applied');
      expect(Array.isArray(payload.precheck)).toBe(true);
      expect(Array.isArray(payload.steps)).toBe(true);
      expect(payload.rollback).toBe('available');
      expect(typeof payload.auditRef).toBe('string');
    } finally {
      await harness.close();
    }
  });

  test('admin policy deny includes structured envelope for missing maintenance window and change ticket', async () => {
    const harness = await createHarness({
      policyEvaluate: (input) => {
        const reasons: string[] = [];
        if (!input.maintenanceWindowId) {
          reasons.push('maintenanceWindowId is required by policy');
        }
        if (!input.changeTicket) {
          reasons.push('changeTicket is required by policy');
        }
        return {
          allowed: reasons.length === 0,
          effectiveDryRun: Boolean(input.dryRun),
          reasons
        };
      }
    });

    try {
      const result = await harness.client.callTool({
        name: 'hs4.admin.plugins.install',
        arguments: {
          pluginId: 'sample-plugin',
          confirm: true,
          intent: 'Install plugin for policy-path test',
          reason: 'Integration policy deny test',
          domain: 'plugins'
        }
      });

      expect(result.isError).toBe(true);
      const error = (result.structuredContent as { error: Record<string, unknown> }).error;
      expect(error.code).toBe('POLICY_DENY');
      expect(error.details).toMatchObject({
        reasons: expect.arrayContaining([
          'maintenanceWindowId is required by policy',
          'changeTicket is required by policy'
        ]),
        envelope: {
          result: 'failed',
          rollback: 'not_needed'
        }
      });

      expect(harness.policyEvaluate).toHaveBeenCalledWith(
        expect.objectContaining({
          tool: 'hs4.admin.plugins.install',
          action: 'admin_plugins_install',
          operationTier: 'operator',
          domain: 'plugins',
          maintenanceWindowId: undefined,
          changeTicket: undefined,
          targetIds: ['sample-plugin']
        })
      );
    } finally {
      await harness.close();
    }
  });

  test('admin dryRun returns planned transaction envelope', async () => {
    const harness = await createHarness();
    try {
      const result = await harness.client.callTool({
        name: 'hs4.admin.system.service.restart',
        arguments: {
          service: 'hs4',
          dryRun: true,
          confirm: true,
          intent: 'Dry-run restart',
          reason: 'Validate planned response',
          domain: 'system'
        }
      });

      const payload = extractSuccess(result);
      expect(payload.result).toBe('planned');
      expect(payload.rollback).toBe('not_needed');
      expect(Array.isArray(payload.precheck)).toBe(true);
      expect(Array.isArray(payload.steps)).toBe(true);
      expect(typeof payload.auditRef).toBe('string');
    } finally {
      await harness.close();
    }
  });

  test('admin direct execution mode routes supported mutations via direct client path', async () => {
    const harness = await createHarness({
      configOverrides: {
        hs4AdminExecutionMode: 'direct',
        hs4AdminDirectFallback: false
      }
    });
    try {
      const result = await harness.client.callTool({
        name: 'hs4.admin.users.create',
        arguments: {
          username: 'alice',
          domain: 'users',
          maintenanceWindowId: 'mw-2026-02-27-01',
          changeTicket: 'chg-2001',
          confirm: true,
          intent: 'Create a user for direct routing test',
          reason: 'Integration test'
        }
      });

      const payload = extractSuccess(result);
      expect(payload.data).toEqual(
        expect.objectContaining({
          route: 'direct',
          transport: 'userscreate'
        })
      );
      expect(harness.hs4.usersCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          username: 'alice'
        })
      );
      expect(harness.hs4.runScriptCommand).not.toHaveBeenCalled();
    } finally {
      await harness.close();
    }
  });

  test('admin direct execution mode falls back to adapter when direct path is unsupported', async () => {
    const harness = await createHarness({
      configOverrides: {
        hs4AdminExecutionMode: 'direct',
        hs4AdminDirectFallback: true
      }
    });
    try {
      const result = await harness.client.callTool({
        name: 'hs4.admin.events.update',
        arguments: {
          group: 'Kitchen',
          name: 'Evening Scene',
          domain: 'events',
          maintenanceWindowId: 'mw-2026-02-27-01',
          changeTicket: 'chg-2002',
          confirm: true,
          intent: 'Update event definition via fallback path',
          reason: 'Integration fallback test'
        }
      });

      const payload = extractSuccess(result);
      expect(payload.data).toEqual(
        expect.objectContaining({
          route: 'adapter',
          transport: 'runScriptCommand',
          fallback: expect.objectContaining({
            from: 'direct',
            to: 'adapter',
            reason: 'UNSUPPORTED_ON_TARGET'
          })
        })
      );
      expect(harness.hs4.runScriptCommand).toHaveBeenCalledTimes(1);
    } finally {
      await harness.close();
    }
  });

  test('admin auto execution mode caches unsupported direct paths and routes subsequent calls directly to adapter', async () => {
    const harness = await createHarness({
      configOverrides: {
        hs4AdminExecutionMode: 'auto',
        hs4AdminDirectFallback: true,
        hs4AdminCapabilityCacheTtlSec: 300
      }
    });
    try {
      const callArgs = {
        name: 'hs4.admin.events.update',
        arguments: {
          group: 'Kitchen',
          name: 'Evening Scene',
          domain: 'events',
          maintenanceWindowId: 'mw-2026-02-27-01',
          changeTicket: 'chg-2003',
          confirm: true,
          intent: 'Update event definition via auto route',
          reason: 'Integration auto-routing cache test'
        }
      } as const;

      const first = extractSuccess(await harness.client.callTool(callArgs));
      const second = extractSuccess(await harness.client.callTool(callArgs));

      const firstData = first.data as Record<string, unknown>;
      const secondData = second.data as Record<string, unknown>;

      expect(firstData).toEqual(
        expect.objectContaining({
          route: 'adapter',
          fallback: expect.objectContaining({
            from: 'direct',
            to: 'adapter'
          })
        })
      );
      expect(secondData).toEqual(
        expect.objectContaining({
          route: 'adapter'
        })
      );
      expect(secondData.fallback).toBeUndefined();
      expect(harness.hs4.runScriptCommand).toHaveBeenCalledTimes(2);
    } finally {
      await harness.close();
    }
  });

  test('admin resources are listed and readable', async () => {
    const harness = await createHarness({
      auditLatestEntries: [
        {
          id: 'audit-1',
          timestamp: '2026-02-23T00:00:00.000Z',
          tool: 'hs4.admin.system.config.set',
          action: 'admin_system_config_set',
          result: 'success',
          dryRun: false,
          details: {
            before: { safeMode: 'read_write' },
            after: { safeMode: 'read_only' },
            diff: { changed: true, changedKeys: ['safeMode'] }
          }
        }
      ]
    });
    try {
      const listed = await harness.client.listResources();
      const uris = listed.resources.map((resource) => resource.uri);

      const expectedUris = [
        'hs4://admin/users',
        'hs4://admin/interfaces',
        'hs4://admin/plugins',
        'hs4://admin/cameras/config',
        'hs4://admin/policy/state',
        'hs4://admin/audit/diff'
      ];

      expect(uris).toEqual(expect.arrayContaining(expectedUris));

      for (const uri of expectedUris) {
        const resource = await harness.client.readResource({ uri });
        const text = extractResourceText(resource);
        expect(() => JSON.parse(text)).not.toThrow();
      }

      const policyState = JSON.parse(
        extractResourceText(await harness.client.readResource({ uri: 'hs4://admin/policy/state' }))
      ) as Record<string, unknown>;
      expect(policyState.adminExecution).toEqual(
        expect.objectContaining({
          mode: expect.any(String),
          directFallback: expect.any(Boolean),
          capabilityCacheTtlSec: expect.any(Number)
        })
      );

      const auditDiff = JSON.parse(
        extractResourceText(await harness.client.readResource({ uri: 'hs4://admin/audit/diff' }))
      ) as Array<Record<string, unknown>>;
      expect(auditDiff.length).toBeGreaterThan(0);
    } finally {
      await harness.close();
    }
  });

  test('ergonomic tools/resources/prompts are registered', async () => {
    const harness = await createHarness();
    try {
      const listedTools = await harness.client.listTools();
      const toolNames = listedTools.tools.map((tool) => tool.name);
      expect(toolNames).toEqual(
        expect.arrayContaining([
          'hs4.help.route',
          'hs4.resolve.devices',
          'hs4.resolve.events',
          'hs4.resolve.cameras',
          'hs4.change.prepare',
          'hs4.change.commit',
          'hs4.intent.device_set_by_name',
          'hs4.intent.event_run_by_name',
          'hs4.intent.scene_activate',
          'hs4.selftest.run'
        ])
      );

      const listedResources = await harness.client.listResources();
      const uris = listedResources.resources.map((resource) => resource.uri);
      expect(uris).toEqual(
        expect.arrayContaining(['hs4://state/summary', 'hs4://catalog/aliases', 'hs4://agent/contract'])
      );

      const listedPrompts = await harness.client.listPrompts();
      const promptNames = listedPrompts.prompts.map((prompt) => prompt.name);
      expect(promptNames).toContain('hs4_agent_contract');
    } finally {
      await harness.close();
    }
  });

  test('hs4.resolve.devices and hs4.help.route return actionable guidance', async () => {
    const harness = await createHarness({
      eventsPayload: {
        Events: [
          {
            id: 77,
            Group: 'Scenes',
            Name: 'Night Mode'
          }
        ]
      }
    });

    try {
      const resolved = await harness.client.callTool({
        name: 'hs4.resolve.devices',
        arguments: {
          query: 'kitchen light',
          limit: 3
        }
      });
      const resolvedPayload = extractSuccess(resolved);
      expect(resolvedPayload.totalMatches).toBeGreaterThan(0);
      expect((resolvedPayload.items as Array<Record<string, unknown>>)[0]).toEqual(
        expect.objectContaining({
          ref: 101,
          score: expect.any(Number),
          confidence: expect.any(String)
        })
      );

      const routed = await harness.client.callTool({
        name: 'hs4.help.route',
        arguments: {
          goal: 'turn off kitchen light',
          mode: 'dry_run'
        }
      });
      const routePayload = extractSuccess(routed);
      expect(Array.isArray(routePayload.routes)).toBe(true);
      expect((routePayload.routes as Array<Record<string, unknown>>).length).toBeGreaterThan(0);
    } finally {
      await harness.close();
    }
  });

  test('hs4.resolve.devices prefers actionable child endpoints for ambiguous master/child aliases', async () => {
    const harness = await createHarness({
      statusPayloads: [makeParentChildLightingPayload()]
    });
    try {
      const resolved = await harness.client.callTool({
        name: 'hs4.resolve.devices',
        arguments: {
          query: 'coffee bar',
          limit: 5,
          includeEvidence: true
        }
      });

      const payload = extractSuccess(resolved);
      expect(payload.recommendedRef).toBe(143);
      const items = payload.items as Array<Record<string, unknown>>;
      expect(items[0]).toEqual(
        expect.objectContaining({
          ref: 143,
          recommended: true,
          actionability: expect.objectContaining({
            role: 'endpoint'
          })
        })
      );
      expect(items.find((item) => item.ref === 141)).toEqual(
        expect.objectContaining({
          actionability: expect.objectContaining({
            role: 'wrapper_or_master'
          })
        })
      );
    } finally {
      await harness.close();
    }
  });

  test('hs4.change.prepare and hs4.change.commit run two-phase device mutation', async () => {
    const harness = await createHarness();
    try {
      const prepared = await harness.client.callTool({
        name: 'hs4.change.prepare',
        arguments: {
          toolName: 'hs4.devices.set',
          args: {
            ref: 101,
            mode: 'control_value',
            value: 0,
            confirm: true,
            intent: 'Turn off kitchen light',
            reason: 'integration test'
          }
        }
      });

      const preparedPayload = extractSuccess(prepared);
      const token = preparedPayload.token;
      expect(typeof token).toBe('string');
      expect(preparedPayload.toolName).toBe('hs4.devices.set');

      const committed = await harness.client.callTool({
        name: 'hs4.change.commit',
        arguments: {
          token
        }
      });

      const commitPayload = extractSuccess(committed);
      expect(commitPayload.committed).toBe(true);
      expect(commitPayload.toolName).toBe('hs4.devices.set');
      expect(harness.hs4.controlDeviceByValue).toHaveBeenCalledTimes(1);
    } finally {
      await harness.close();
    }
  });

  test('hs4.intent.device_set_by_name is dry-run first and can execute commit', async () => {
    const harness = await createHarness();
    try {
      const planned = await harness.client.callTool({
        name: 'hs4.intent.device_set_by_name',
        arguments: {
          query: 'kitchen light',
          value: 100
        }
      });
      const plannedPayload = extractSuccess(planned);
      expect(plannedPayload.execute).toBe(false);
      expect(plannedPayload.prepared).toBeDefined();
      expect(harness.hs4.controlDeviceByValue).toHaveBeenCalledTimes(0);

      const executed = await harness.client.callTool({
        name: 'hs4.intent.device_set_by_name',
        arguments: {
          query: 'kitchen light',
          value: 0,
          execute: true,
          confirm: true,
          intent: 'Turn off kitchen light',
          reason: 'integration test'
        }
      });
      const executedPayload = extractSuccess(executed);
      expect(executedPayload.execute).toBe(true);
      expect(executedPayload.prepared).toBeDefined();
      expect(executedPayload.committed).toBeDefined();
      expect(harness.hs4.controlDeviceByValue).toHaveBeenCalledTimes(1);
    } finally {
      await harness.close();
    }
  });

  test('hs4.intent.device_set_by_name prefers actionable endpoint and includes resolution metadata', async () => {
    const harness = await createHarness({
      statusPayloads: [makeParentChildLightingPayload()]
    });
    try {
      const planned = await harness.client.callTool({
        name: 'hs4.intent.device_set_by_name',
        arguments: {
          query: 'coffee bar',
          value: 0
        }
      });
      const payload = extractSuccess(planned);
      expect(payload.execute).toBe(false);
      expect(payload.resolution).toEqual(
        expect.objectContaining({
          resolvedRef: 143,
          resolvedRole: 'endpoint'
        })
      );
      expect(payload.warnings).toBeUndefined();
      const prepared = payload.prepared as Record<string, unknown>;
      expect((prepared.summary as Record<string, unknown>).resolvedRef).toBe(143);
    } finally {
      await harness.close();
    }
  });

  test('hs4.intent.device_set_by_name warns when query targets a wrapper/master while endpoint alternative exists', async () => {
    const harness = await createHarness({
      statusPayloads: [makeParentChildLightingPayload()]
    });
    try {
      const planned = await harness.client.callTool({
        name: 'hs4.intent.device_set_by_name',
        arguments: {
          query: 'bar overhead light master',
          value: 0
        }
      });
      const payload = extractSuccess(planned);
      expect(payload.execute).toBe(false);
      expect(payload.resolution).toEqual(
        expect.objectContaining({
          resolvedRef: 144,
          resolvedRole: 'wrapper_or_master'
        })
      );
      expect(payload.warnings).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: 'PARENT_OR_WRAPPER_TARGET',
            resolvedRef: 144,
            suggestedRef: 146
          })
        ])
      );
    } finally {
      await harness.close();
    }
  });

  test('hs4.intent.scene_activate preferPath=device_fallback forces device path when event exists', async () => {
    const harness = await createHarness({
      statusPayloads: [
        makeSingleDevicePayload({
          ref: 101,
          name: 'Movie Time',
          status: 'Off',
          value: 0,
          controlPairs: [
            { label: 'Off', value: 0 },
            { label: 'On', value: 99 }
          ]
        })
      ],
      eventsPayload: {
        Events: [
          {
            id: 77,
            Group: 'Scenes',
            Name: 'Movie Time'
          }
        ]
      }
    });
    try {
      const planned = await harness.client.callTool({
        name: 'hs4.intent.scene_activate',
        arguments: {
          objective: 'movie time',
          preferPath: 'device_fallback',
          fallbackDeviceValue: 99
        }
      });

      const payload = extractSuccess(planned);
      expect(payload.path).toBe('device_fallback');
      expect(payload.execute).toBe(false);
      expect(payload.selection).toEqual(
        expect.objectContaining({
          preferPath: 'device_fallback',
          selectedPath: 'device_fallback',
          reason: 'prefer_path_device_fallback'
        })
      );
      const prepared = payload.prepared as Record<string, unknown>;
      expect((prepared.summary as Record<string, unknown>).resolvedRef).toBe(101);
    } finally {
      await harness.close();
    }
  });

  test('hs4.intent.scene_activate preferPath=event returns NOT_FOUND when no event matches', async () => {
    const harness = await createHarness({
      statusPayloads: [
        makeSingleDevicePayload({
          ref: 101,
          name: 'Kitchen Light',
          status: 'Off',
          value: 0
        })
      ],
      eventsPayload: {
        Events: []
      }
    });
    try {
      const result = await harness.client.callTool({
        name: 'hs4.intent.scene_activate',
        arguments: {
          objective: 'kitchen light',
          preferPath: 'event'
        }
      });

      expect(result.isError).toBe(true);
      expect(result.structuredContent).toEqual(
        expect.objectContaining({
          error: expect.objectContaining({
            code: 'NOT_FOUND',
            details: expect.objectContaining({
              objective: 'kitchen light',
              preferPath: 'event'
            })
          })
        })
      );
    } finally {
      await harness.close();
    }
  });

  test('hs4.intent.scene_activate auto path prefers device fallback when device confidence is stronger', async () => {
    const harness = await createHarness({
      statusPayloads: [
        makeSingleDevicePayload({
          ref: 101,
          name: 'Kitchen Light',
          status: 'Off',
          value: 0,
          controlPairs: [
            { label: 'Off', value: 0 },
            { label: 'On', value: 99 }
          ]
        })
      ],
      eventsPayload: {
        Events: [
          {
            id: 88,
            Group: 'Scenes',
            Name: 'Kitchen'
          }
        ]
      }
    });
    try {
      const planned = await harness.client.callTool({
        name: 'hs4.intent.scene_activate',
        arguments: {
          objective: 'kitchen light'
        }
      });

      const payload = extractSuccess(planned);
      expect(payload.path).toBe('device_fallback');
      expect(payload.selection).toEqual(
        expect.objectContaining({
          selectedPath: 'device_fallback',
          reason: 'auto_device_fallback'
        })
      );
    } finally {
      await harness.close();
    }
  });

  test('hs4.intent.scene_activate auto path prefers event when event confidence is high and clearly better', async () => {
    const harness = await createHarness({
      statusPayloads: [
        makeSingleDevicePayload({
          ref: 101,
          name: 'Night Mode Lamp',
          status: 'Off',
          value: 0,
          controlPairs: [
            { label: 'Off', value: 0 },
            { label: 'On', value: 99 }
          ]
        })
      ],
      eventsPayload: {
        Events: [
          {
            id: 91,
            Group: 'Scenes',
            Name: 'Night Mode'
          }
        ]
      }
    });
    try {
      const planned = await harness.client.callTool({
        name: 'hs4.intent.scene_activate',
        arguments: {
          objective: 'night mode'
        }
      });

      const payload = extractSuccess(planned);
      expect(payload.path).toBe('event');
      expect(payload.selection).toEqual(
        expect.objectContaining({
          selectedPath: 'event',
          reason: 'auto_event_high_confidence'
        })
      );
      const prepared = payload.prepared as Record<string, unknown>;
      expect((prepared.summary as Record<string, unknown>).resolvedEventId).toBe(91);
    } finally {
      await harness.close();
    }
  });

  test('hs4.selftest.run reports status and check list', async () => {
    const harness = await createHarness();
    try {
      const result = await harness.client.callTool({
        name: 'hs4.selftest.run',
        arguments: {}
      });

      const payload = extractSuccess(result);
      expect(['pass', 'warn', 'fail']).toContain(payload.status);
      expect(Array.isArray(payload.checks)).toBe(true);
      expect((payload.checks as Array<Record<string, unknown>>).length).toBeGreaterThan(0);
    } finally {
      await harness.close();
    }
  });
});
