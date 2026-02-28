import { describe, expect, test } from 'vitest';

import { AuditStore } from '../../src/audit/auditStore.js';

describe('AuditStore', () => {
  test('filters by operationTier, domain, changeTicket, and rollbackResult', async () => {
    const store = new AuditStore(100);

    await store.record({
      tool: 'hs4.devices.set',
      action: 'set_device',
      result: 'success',
      dryRun: false,
      operationTier: 'operator',
      domain: 'system',
      changeTicket: 'chg-001',
      rollbackResult: 'not_needed'
    });

    await store.record({
      tool: 'hs4.users.set',
      action: 'set_user',
      result: 'success',
      dryRun: false,
      operationTier: 'admin',
      domain: 'users',
      maintenanceWindowId: 'mw-1',
      changeTicket: 'chg-100',
      rollbackAttempted: true,
      rollbackResult: 'applied'
    });

    await store.record({
      tool: 'hs4.plugins.set',
      action: 'set_plugin',
      result: 'error',
      dryRun: false,
      operationTier: 'admin',
      domain: 'plugins',
      maintenanceWindowId: 'mw-2',
      changeTicket: 'chg-200',
      rollbackAttempted: true,
      rollbackResult: 'failed'
    });

    const adminEntries = store.query({ operationTier: 'admin' });
    expect(adminEntries).toHaveLength(2);

    const userDomainEntries = store.query({ domain: 'users' });
    expect(userDomainEntries).toHaveLength(1);
    expect(userDomainEntries[0]?.tool).toBe('hs4.users.set');

    const ticketEntries = store.query({ changeTicket: 'chg-200' });
    expect(ticketEntries).toHaveLength(1);
    expect(ticketEntries[0]?.domain).toBe('plugins');

    const rollbackFailedEntries = store.query({ rollbackResult: 'failed' });
    expect(rollbackFailedEntries).toHaveLength(1);
    expect(rollbackFailedEntries[0]?.tool).toBe('hs4.plugins.set');
  });

  test('remains backward compatible for entries without admin metadata fields', async () => {
    const store = new AuditStore(100);

    await store.record({
      tool: 'hs4.health.get',
      action: 'read_health',
      result: 'success',
      dryRun: false
    });

    const entries = store.query();
    expect(entries).toHaveLength(1);
    expect(entries[0]?.tool).toBe('hs4.health.get');
  });
});
