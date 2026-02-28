import { describe, expect, test } from 'vitest';

import { PolicyEngine } from '../../src/policy/policyEngine.js';
import type { AppConfig } from '../../src/config.js';

function makeConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    hs4BaseUrl: 'http://127.0.0.1',
    requestTimeoutMs: 10_000,
    readRetries: 1,
    readRetryBackoffMs: 10,
    includeEverythingOnStatus: false,
    maxDevicesDefaultCap: 250,
    statusCacheTtlMs: 1_500,
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
    mcpTransport: 'stdio',
    mcpHttpHost: '127.0.0.1',
    mcpHttpPort: 7422,
    mcpHttpAllowNonLoopback: false,
    mcpHttpAcceptMode: 'compat',
    mcpHttpAllowJsonOnly: true,
    logLevel: 'info',
    auditMaxEntries: 500,
    ...overrides
  };
}

describe('PolicyEngine', () => {
  test('blocks mutation when confirm is missing', () => {
    const engine = new PolicyEngine(makeConfig());

    const decision = engine.evaluateMutation({
      tool: 'hs4.devices.set',
      action: 'set_device',
      targetRefs: [10],
      intent: 'turn on kitchen lights',
      reason: 'night routine'
    });

    expect(decision.allowed).toBe(false);
    expect(decision.reasons.join(' ')).toContain('confirm=true');
  });

  test('allows dry-run even when confirm is missing', () => {
    const engine = new PolicyEngine(makeConfig());

    const decision = engine.evaluateMutation({
      tool: 'hs4.events.run',
      action: 'run_event',
      dryRun: true,
      eventIds: [7]
    });

    expect(decision.allowed).toBe(true);
    expect(decision.effectiveDryRun).toBe(true);
  });

  test('blocks when device ref is outside allowlist', () => {
    const engine = new PolicyEngine(
      makeConfig({
        allowedDeviceRefs: new Set([101, 102])
      })
    );

    const decision = engine.evaluateMutation({
      tool: 'hs4.devices.set',
      action: 'set_device',
      confirm: true,
      intent: 'change switch',
      reason: 'manual action',
      targetRefs: [999]
    });

    expect(decision.allowed).toBe(false);
    expect(decision.reasons.join(' ')).toContain('not allowed');
  });

  test('normalizes plugin function for allowlist checks', () => {
    const engine = new PolicyEngine(
      makeConfig({
        allowedPluginFunctions: new Set(['zwave:configuration_set'])
      })
    );

    const allowed = engine.evaluateMutation({
      tool: 'hs4.plugins.function.call',
      action: 'plugin_function',
      confirm: true,
      intent: 'configure node',
      reason: 'maintenance',
      pluginFunction: 'zwave:configuration_set'
    });

    const blocked = engine.evaluateMutation({
      tool: 'hs4.plugins.function.call',
      action: 'plugin_function',
      confirm: true,
      intent: 'configure node',
      reason: 'maintenance',
      pluginFunction: 'zwave:bad_function'
    });

    expect(allowed.allowed).toBe(true);
    expect(blocked.allowed).toBe(false);
  });

  test('blocks admin operation when admin operations are globally disabled', () => {
    const engine = new PolicyEngine(
      makeConfig({
        hs4AdminEnabled: false,
        hs4AdminUsersEnabled: true
      })
    );

    const decision = engine.evaluateMutation({
      tool: 'hs4.users.set',
      action: 'set_user',
      operationTier: 'admin',
      domain: 'users',
      maintenanceWindowId: 'mw-1',
      changeTicket: 'chg-100',
      confirm: true,
      intent: 'update admin user',
      reason: 'scheduled maintenance'
    });

    expect(decision.allowed).toBe(false);
    expect(decision.reasons.join(' ')).toContain('HS4_ADMIN_ENABLED=false');
  });

  test('blocks admin operation when domain is disabled', () => {
    const engine = new PolicyEngine(
      makeConfig({
        hs4AdminEnabled: true,
        hs4AdminUsersEnabled: false
      })
    );

    const decision = engine.evaluateMutation({
      tool: 'hs4.users.set',
      action: 'set_user',
      operationTier: 'admin',
      domain: 'users',
      maintenanceWindowId: 'mw-1',
      changeTicket: 'chg-100',
      confirm: true,
      intent: 'update admin user',
      reason: 'scheduled maintenance'
    });

    expect(decision.allowed).toBe(false);
    expect(decision.reasons.join(' ')).toContain("domain 'users' is not enabled");
  });

  test('blocks admin operation when maintenance window is missing or mismatched', () => {
    const engine = new PolicyEngine(
      makeConfig({
        hs4AdminEnabled: true,
        hs4AdminUsersEnabled: true,
        hs4AdminMaintenanceWindowId: 'mw-approved',
        hs4AdminAllowedMaintenanceWindowIds: new Set(['mw-approved'])
      })
    );

    const missingWindow = engine.evaluateMutation({
      tool: 'hs4.users.set',
      action: 'set_user',
      operationTier: 'admin',
      domain: 'users',
      changeTicket: 'chg-100',
      confirm: true,
      intent: 'update admin user',
      reason: 'scheduled maintenance'
    });

    const mismatchedWindow = engine.evaluateMutation({
      tool: 'hs4.users.set',
      action: 'set_user',
      operationTier: 'admin',
      domain: 'users',
      maintenanceWindowId: 'mw-other',
      changeTicket: 'chg-100',
      confirm: true,
      intent: 'update admin user',
      reason: 'scheduled maintenance'
    });

    expect(missingWindow.allowed).toBe(false);
    expect(missingWindow.reasons.join(' ')).toContain('maintenanceWindowId');
    expect(mismatchedWindow.allowed).toBe(false);
    expect(mismatchedWindow.reasons.join(' ')).toContain("must match the configured value 'mw-approved'");
  });

  test('blocks admin operation when changeTicket is required but missing', () => {
    const engine = new PolicyEngine(
      makeConfig({
        hs4AdminEnabled: true,
        hs4AdminUsersEnabled: true,
        hs4AdminRequireChangeTicket: true
      })
    );

    const decision = engine.evaluateMutation({
      tool: 'hs4.users.set',
      action: 'set_user',
      operationTier: 'admin',
      domain: 'users',
      maintenanceWindowId: 'mw-1',
      confirm: true,
      intent: 'update admin user',
      reason: 'scheduled maintenance'
    });

    expect(decision.allowed).toBe(false);
    expect(decision.reasons.join(' ')).toContain('changeTicket');
  });

  test('allows admin operation when all admin conditions are met', () => {
    const engine = new PolicyEngine(
      makeConfig({
        hs4AdminEnabled: true,
        hs4AdminUsersEnabled: true,
        hs4AdminMaintenanceWindowId: 'mw-1',
        hs4AdminAllowedMaintenanceWindowIds: new Set(['mw-1']),
        hs4AdminRequireChangeTicket: true
      })
    );

    const decision = engine.evaluateMutation({
      tool: 'hs4.users.set',
      action: 'set_user',
      operationTier: 'admin',
      domain: 'users',
      maintenanceWindowId: 'mw-1',
      changeTicket: 'chg-100',
      confirm: true,
      intent: 'update admin user',
      reason: 'scheduled maintenance'
    });

    expect(decision.allowed).toBe(true);
    expect(decision.normalized?.operationTier).toBe('admin');
    expect(decision.normalized?.domain).toBe('users');
    expect(decision.normalized?.maintenanceWindowId).toBe('mw-1');
    expect(decision.normalized?.changeTicket).toBe('chg-100');
  });

  test('blocks when configured admin user allowlist excludes requested user ids', () => {
    const engine = new PolicyEngine(
      makeConfig({
        hs4AdminAllowedUserIds: new Set(['alice'])
      })
    );

    const decision = engine.evaluateMutation({
      tool: 'hs4.users.set',
      action: 'set_user',
      confirm: true,
      intent: 'grant access',
      reason: 'ticketed request',
      userIds: ['Alice', 'Bob']
    });

    expect(decision.allowed).toBe(false);
    expect(decision.reasons.join(' ')).toContain('User IDs not allowed by policy: bob');
  });
});
