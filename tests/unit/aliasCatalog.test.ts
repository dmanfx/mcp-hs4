import { describe, expect, test } from 'vitest';

import { AliasCatalog } from '../../src/alias/aliasCatalog.js';

type AnyRecord = Record<string, unknown>;

function asRecord(value: unknown): AnyRecord {
  return value as AnyRecord;
}

function firstString(record: AnyRecord, keys: string[]): string | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.length > 0) {
      return value;
    }
  }
  return null;
}

function firstNumber(record: AnyRecord, keys: string[]): number | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value;
    }
  }
  return null;
}

function resultTargetId(result: unknown): number | null {
  return firstNumber(asRecord(result), ['targetRef', 'targetId', 'ref', 'id', 'entityId']);
}

function resultKind(result: unknown): string | null {
  return firstString(asRecord(result), ['kind', 'entityKind', 'type']);
}

function resultScore(result: unknown): number | null {
  return firstNumber(asRecord(result), ['score', 'matchScore']);
}

function resultConfidence(result: unknown): string | null {
  return firstString(asRecord(result), ['confidence']);
}

function resultProvenance(result: unknown): string | null {
  return firstString(asRecord(result), ['provenance', 'source']);
}

function entryKind(entry: unknown): string | null {
  return firstString(asRecord(entry), ['kind', 'entityKind', 'type']);
}

function entryProvenance(entry: unknown): string | null {
  return firstString(asRecord(entry), ['provenance', 'source']);
}

function confidenceRank(value: string | null): number {
  switch (value) {
    case 'high':
      return 3;
    case 'medium':
      return 2;
    case 'low':
      return 1;
    default:
      return 0;
  }
}

describe('AliasCatalog', () => {
  test('normalizes queries and gives config aliases precedence over learned aliases', () => {
    const catalog = new AliasCatalog({
      learnedEnabled: true,
      configAliases: {
        'device:101': [' Kitchen---Main   Light ']
      }
    });

    catalog.setConfigAliases({
      'device:101': [' Kitchen---Main   Light ']
    });

    catalog.ingestDevices([
      { ref: 101, name: 'Kitchen Secondary Light' },
      { ref: 102, name: 'Kitchen Main Light' }
    ]);

    const results = catalog.resolve('device', 'kitchen main light', 5);

    expect(results.length).toBeGreaterThan(0);
    expect(resultTargetId(results[0])).toBe(101);
    expect(resultKind(results[0])).toBe('device');
    expect(resultProvenance(results[0])).toBe('config');
  });

  test('ingests learned aliases for devices, events, and cameras', () => {
    const catalog = new AliasCatalog({
      learnedEnabled: true
    });

    catalog.ingestDevices([
      { ref: 11, name: 'Back Patio Light', location: 'Back Patio', location2: 'Lights' }
    ]);
    catalog.ingestEvents([{ id: 77, group: 'Scenes', name: 'Night Mode' }]);
    catalog.ingestCameras([{ id: 9, name: 'Garage Camera' }]);

    const deviceResults = catalog.resolve('device', 'back patio light', 3);
    const eventResults = catalog.resolve('event', 'night mode', 3);
    const cameraResults = catalog.resolve('camera', 'garage camera', 3);

    expect(resultTargetId(deviceResults[0])).toBe(11);
    expect(resultTargetId(eventResults[0])).toBe(77);
    expect(resultTargetId(cameraResults[0])).toBe(9);
    expect(resultProvenance(deviceResults[0])).toBe('learned');
    expect(resultProvenance(eventResults[0])).toBe('learned');
    expect(resultProvenance(cameraResults[0])).toBe('learned');
  });

  test('returns deterministic scoring/confidence and stable ordering for ambiguous matches', () => {
    const catalog = new AliasCatalog({
      learnedEnabled: true
    });

    catalog.ingestDevices([
      { ref: 201, name: 'Kitchen Lamp Main' },
      { ref: 202, name: 'Kitchen Lamp Side' },
      { ref: 203, name: 'Kitchen Lamp Accent' }
    ]);

    const exact = catalog.resolve('device', 'Kitchen Lamp Main', 5);
    const fuzzy = catalog.resolve('device', 'kitchen lam', 5);
    const ambiguousA = catalog.resolve('device', 'kitchen lamp', 10);
    const ambiguousB = catalog.resolve('device', 'kitchen lamp', 10);

    expect(exact.length).toBeGreaterThan(0);
    expect(typeof resultScore(exact[0])).toBe('number');
    expect(['high', 'medium', 'low']).toContain(resultConfidence(exact[0]));
    expect(confidenceRank(resultConfidence(exact[0]))).toBeGreaterThanOrEqual(confidenceRank(resultConfidence(fuzzy[0])));

    const idsA = ambiguousA.map((item) => resultTargetId(item));
    const idsB = ambiguousB.map((item) => resultTargetId(item));
    expect(idsB).toEqual(idsA);

    for (let index = 1; index < ambiguousA.length; index += 1) {
      const previousScore = resultScore(ambiguousA[index - 1]);
      const currentScore = resultScore(ambiguousA[index]);
      if (typeof previousScore === 'number' && typeof currentScore === 'number') {
        expect(previousScore).toBeGreaterThanOrEqual(currentScore);
      }
    }
  });

  test('exports catalog with timestamped shape and mixed provenance entries', () => {
    const catalog = new AliasCatalog({
      learnedEnabled: true,
      configAliases: {
        'device:301': ['office lamp']
      }
    });

    catalog.ingestDevices([{ ref: 301, name: 'Office Light', location: 'Office' }]);
    catalog.ingestEvents([{ id: 88, group: 'Scenes', name: 'Movie Time' }]);
    catalog.ingestCameras([{ id: 44, name: 'Front Door Camera' }]);

    const exported = catalog.exportCatalog() as {
      generatedAt: string;
      entries: unknown[];
    };

    expect(typeof exported.generatedAt).toBe('string');
    expect(Number.isNaN(Date.parse(exported.generatedAt))).toBe(false);
    expect(Array.isArray(exported.entries)).toBe(true);
    expect(exported.entries.length).toBeGreaterThan(0);

    const kinds = exported.entries.map((entry) => entryKind(entry)).filter((value): value is string => Boolean(value));
    const provenances = exported.entries
      .map((entry) => entryProvenance(entry))
      .filter((value): value is string => Boolean(value));

    expect(kinds).toEqual(expect.arrayContaining(['device', 'event', 'camera']));
    expect(provenances).toContain('config');
    expect(provenances).toContain('learned');
  });
});
