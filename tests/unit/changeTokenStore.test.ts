import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

import { ChangeTokenStore } from '../../src/change/changeTokenStore.js';

const UUIDISH_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('ChangeTokenStore', () => {
  test('creates and retrieves prepared change records', async () => {
    const store = new ChangeTokenStore({
      ttlSec: 60,
      maxEntries: 20
    });

    await store.init();

    const created = await store.create({
      toolName: 'hs4.devices.set',
      args: { ref: 101, value: 100 },
      summary: { intent: 'turn on kitchen light' },
      preparedAuditRef: 'audit-prepare-1'
    });

    expect(created.token).toMatch(UUIDISH_PATTERN);
    expect(Number.isNaN(Date.parse(created.createdAt))).toBe(false);
    expect(Number.isNaN(Date.parse(created.expiresAt))).toBe(false);
    expect(created.preparedAuditRef).toBe('audit-prepare-1');

    const loaded = store.get(created.token);
    expect(loaded?.token).toBe(created.token);
    expect(loaded?.toolName).toBe('hs4.devices.set');
    expect(loaded?.args).toEqual({ ref: 101, value: 100 });
    expect(loaded?.summary).toEqual({ intent: 'turn on kitchen light' });
  });

  test('expires records and purges stale entries', async () => {
    const store = new ChangeTokenStore({
      ttlSec: 1,
      maxEntries: 10
    });

    await store.init();
    const created = await store.create({
      toolName: 'hs4.events.run',
      args: { id: 77 },
      summary: { event: 'night mode' }
    });

    await sleep(1200);

    const purgedCount = await store.purgeExpired();
    expect(purgedCount).toBeGreaterThanOrEqual(1);
    expect(store.get(created.token)).toBeNull();
  });

  test('prunes to max entries and keeps list ordered newest-first', async () => {
    const store = new ChangeTokenStore({
      ttlSec: 60,
      maxEntries: 2
    });

    await store.init();

    const first = await store.create({
      toolName: 'tool.first',
      args: {},
      summary: { step: 1 }
    });
    await sleep(5);

    const second = await store.create({
      toolName: 'tool.second',
      args: {},
      summary: { step: 2 }
    });
    await sleep(5);

    const third = await store.create({
      toolName: 'tool.third',
      args: {},
      summary: { step: 3 }
    });

    expect(store.get(first.token)).toBeNull();
    expect(store.get(second.token)?.token).toBe(second.token);
    expect(store.get(third.token)?.token).toBe(third.token);

    const listed = store.list();
    expect(listed).toHaveLength(2);
    expect(listed.map((item) => item.token)).toEqual([third.token, second.token]);
    expect(store.list(1).map((item) => item.token)).toEqual([third.token]);
  });

  test('marks records committed and stores commit audit refs', async () => {
    const store = new ChangeTokenStore({
      ttlSec: 60,
      maxEntries: 10
    });

    await store.init();

    const created = await store.create({
      toolName: 'hs4.devices.set',
      args: { ref: 88, value: 0 },
      summary: { intent: 'turn off office light' },
      preparedAuditRef: 'audit-prepare-2'
    });

    const committed = await store.markCommitted(created.token, 'audit-commit-1');
    expect(committed?.token).toBe(created.token);
    expect(typeof committed?.committedAt).toBe('string');
    expect(Number.isNaN(Date.parse(committed?.committedAt ?? ''))).toBe(false);
    expect(committed?.commitAuditRef).toBe('audit-commit-1');

    const loaded = store.get(created.token);
    expect(loaded?.committedAt).toBe(committed?.committedAt);
    expect(loaded?.commitAuditRef).toBe('audit-commit-1');

    await expect(store.markCommitted('missing-token')).resolves.toBeNull();
  });

  test('loads persisted JSONL and appends subsequent writes', async () => {
    const fixtureDir = await mkdtemp(join(tmpdir(), 'change-token-store-'));
    const persistPath = join(fixtureDir, 'tokens.jsonl');

    try {
      const storeA = new ChangeTokenStore({
        ttlSec: 3600,
        maxEntries: 10,
        persistPath
      });
      await storeA.init();

      const first = await storeA.create({
        toolName: 'hs4.events.run',
        args: { id: 1 },
        summary: { stage: 'one' }
      });
      const second = await storeA.create({
        toolName: 'hs4.events.run',
        args: { id: 2 },
        summary: { stage: 'two' }
      });
      await storeA.markCommitted(first.token, 'audit-commit-a');

      const rawBefore = await readFile(persistPath, 'utf8');
      const linesBefore = rawBefore
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean);
      expect(linesBefore.length).toBeGreaterThanOrEqual(3);
      for (const line of linesBefore) {
        expect(() => JSON.parse(line)).not.toThrow();
      }

      const storeB = new ChangeTokenStore({
        ttlSec: 3600,
        maxEntries: 10,
        persistPath
      });
      await storeB.init();

      const loadedFirst = storeB.get(first.token);
      const loadedSecond = storeB.get(second.token);
      expect(loadedFirst?.commitAuditRef).toBe('audit-commit-a');
      expect(loadedFirst?.committedAt).toBeTruthy();
      expect(loadedSecond?.token).toBe(second.token);

      await storeB.create({
        toolName: 'hs4.events.run',
        args: { id: 3 },
        summary: { stage: 'three' }
      });

      const rawAfter = await readFile(persistPath, 'utf8');
      const linesAfter = rawAfter
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean);
      expect(linesAfter.length).toBeGreaterThan(linesBefore.length);
    } finally {
      await rm(fixtureDir, { recursive: true, force: true });
    }
  });
});
