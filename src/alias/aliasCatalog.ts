export type AliasKind = 'device' | 'event' | 'camera';
export type AliasProvenance = 'config' | 'learned';
export type AliasConfidence = 'high' | 'medium' | 'low';

export interface AliasRecord {
  kind: AliasKind;
  targetId: number;
  canonicalName: string;
  alias: string;
  normalizedAlias: string;
  tokens: string[];
  provenance: AliasProvenance;
}

export interface AliasLookupResult {
  kind: AliasKind;
  targetId: number;
  canonicalName: string;
  matchedAlias: string;
  normalizedAlias: string;
  provenance: AliasProvenance;
  score: number;
  confidence: AliasConfidence;
}

export interface AliasCatalogOptions {
  configAliases?: Record<string, string[]>;
  learnedEnabled: boolean;
}

interface AliasTarget {
  kind: AliasKind;
  targetId: number;
}

interface DeviceInput {
  ref: number;
  name: string;
  location?: string;
  location2?: string;
}

interface EventInput {
  id: number;
  group: string;
  name: string;
}

interface CameraInput {
  id: number;
  name: string;
}

const KIND_ORDER: AliasKind[] = ['device', 'event', 'camera'];

function kindRank(kind: AliasKind): number {
  return KIND_ORDER.indexOf(kind);
}

function compareText(a: string, b: string): number {
  const left = a.toLowerCase();
  const right = b.toLowerCase();
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  if (a < b) {
    return -1;
  }
  if (a > b) {
    return 1;
  }
  return 0;
}

function normalizeDisplayAlias(raw: string): string {
  return raw.trim().replace(/\s+/g, ' ');
}

function parsePositiveInteger(raw: string): number | null {
  if (!/^-?\d+$/.test(raw.trim())) {
    return null;
  }
  const parsed = Number(raw.trim());
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    return null;
  }
  return parsed;
}

function parseConfigAliasTarget(rawKey: string): AliasTarget | null {
  const normalized = rawKey.trim().toLowerCase();
  const match = /^(device|event|camera)\s*[:/#|]\s*(\d+)$/.exec(normalized);
  if (!match) {
    return null;
  }

  const kind = match[1] as AliasKind;
  const targetId = parsePositiveInteger(match[2] ?? '');
  if (targetId === null) {
    return null;
  }

  return { kind, targetId };
}

function roundScore(value: number): number {
  return Number(value.toFixed(6));
}

function scoreToConfidence(score: number): AliasConfidence {
  if (score >= 0.9) {
    return 'high';
  }
  if (score >= 0.72) {
    return 'medium';
  }
  return 'low';
}

function computeTokenOverlap(left: string[], right: string[]): number {
  if (left.length === 0 || right.length === 0) {
    return 0;
  }

  const rightSet = new Set(right);
  let overlap = 0;
  for (const token of left) {
    if (rightSet.has(token)) {
      overlap += 1;
    }
  }
  return overlap;
}

export function normalizeAliasText(input: string): string {
  if (!input) {
    return '';
  }

  const cleaned = input
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ');

  return cleaned;
}

export function tokenizeAliasText(input: string): string[] {
  const normalized = normalizeAliasText(input);
  if (!normalized) {
    return [];
  }

  const parts = normalized.split(' ');
  const deduped: string[] = [];
  const seen = new Set<string>();
  for (const token of parts) {
    if (!token || seen.has(token)) {
      continue;
    }
    seen.add(token);
    deduped.push(token);
  }
  return deduped;
}

export class AliasCatalog {
  private readonly learnedEnabled: boolean;

  private readonly namesByKind: Record<AliasKind, Map<number, string>> = {
    device: new Map(),
    event: new Map(),
    camera: new Map()
  };

  private readonly configByKind: Record<AliasKind, Map<number, Map<string, AliasRecord>>> = {
    device: new Map(),
    event: new Map(),
    camera: new Map()
  };

  private readonly learnedByKind: Record<AliasKind, Map<number, Map<string, AliasRecord>>> = {
    device: new Map(),
    event: new Map(),
    camera: new Map()
  };

  constructor(options: AliasCatalogOptions) {
    this.learnedEnabled = options.learnedEnabled;
    this.setConfigAliases(options.configAliases ?? {});
  }

  setConfigAliases(configAliases: Record<string, string[]> = {}): void {
    this.configByKind.device.clear();
    this.configByKind.event.clear();
    this.configByKind.camera.clear();

    const entries = Object.entries(configAliases).sort(([left], [right]) => compareText(left, right));
    for (const [rawKey, aliases] of entries) {
      const target = parseConfigAliasTarget(rawKey);
      if (!target || !Array.isArray(aliases)) {
        continue;
      }

      for (const alias of aliases) {
        this.upsertAlias(this.configByKind[target.kind], target.kind, target.targetId, alias, 'config');
      }
    }

    for (const kind of KIND_ORDER) {
      this.refreshCanonicalNames(kind, this.configByKind[kind]);
    }
  }

  ingestDevices(devices: DeviceInput[]): void {
    const names = new Map<number, string>();
    const learned = new Map<number, Map<string, AliasRecord>>();
    const sorted = [...devices].sort((left, right) => left.ref - right.ref);

    for (const device of sorted) {
      const canonical = normalizeDisplayAlias(device.name || `device:${device.ref}`);
      names.set(device.ref, canonical);

      if (!this.learnedEnabled) {
        continue;
      }

      const candidates = this.buildDeviceAliases(device);
      for (const alias of candidates) {
        this.upsertAlias(learned, 'device', device.ref, alias, 'learned');
      }
    }

    this.namesByKind.device.clear();
    for (const [id, name] of names.entries()) {
      this.namesByKind.device.set(id, name);
    }
    this.learnedByKind.device = learned;
    this.refreshCanonicalNames('device', this.configByKind.device);
  }

  ingestEvents(events: EventInput[]): void {
    const names = new Map<number, string>();
    const learned = new Map<number, Map<string, AliasRecord>>();
    const sorted = [...events].sort((left, right) => left.id - right.id);

    for (const event of sorted) {
      const canonical = normalizeDisplayAlias(event.name || `event:${event.id}`);
      names.set(event.id, canonical);

      if (!this.learnedEnabled) {
        continue;
      }

      const candidates = this.buildEventAliases(event);
      for (const alias of candidates) {
        this.upsertAlias(learned, 'event', event.id, alias, 'learned');
      }
    }

    this.namesByKind.event.clear();
    for (const [id, name] of names.entries()) {
      this.namesByKind.event.set(id, name);
    }
    this.learnedByKind.event = learned;
    this.refreshCanonicalNames('event', this.configByKind.event);
  }

  ingestCameras(cameras: CameraInput[]): void {
    const names = new Map<number, string>();
    const learned = new Map<number, Map<string, AliasRecord>>();
    const sorted = [...cameras].sort((left, right) => left.id - right.id);

    for (const camera of sorted) {
      const canonical = normalizeDisplayAlias(camera.name || `camera:${camera.id}`);
      names.set(camera.id, canonical);

      if (!this.learnedEnabled) {
        continue;
      }

      const candidates = this.buildCameraAliases(camera);
      for (const alias of candidates) {
        this.upsertAlias(learned, 'camera', camera.id, alias, 'learned');
      }
    }

    this.namesByKind.camera.clear();
    for (const [id, name] of names.entries()) {
      this.namesByKind.camera.set(id, name);
    }
    this.learnedByKind.camera = learned;
    this.refreshCanonicalNames('camera', this.configByKind.camera);
  }

  resolve(kind: AliasKind, query: string, limit: number): AliasLookupResult[] {
    const normalizedQuery = normalizeAliasText(query);
    if (!normalizedQuery) {
      return [];
    }

    const safeLimit = Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : 0;
    if (safeLimit === 0) {
      return [];
    }

    const queryTokens = tokenizeAliasText(normalizedQuery);
    const bestByTarget = new Map<number, AliasLookupResult>();

    const evaluateBucket = (bucket: Map<number, Map<string, AliasRecord>>): void => {
      for (const [targetId, aliasMap] of bucket.entries()) {
        for (const record of aliasMap.values()) {
          const score = this.computeScore(record, normalizedQuery, queryTokens);
          if (score <= 0) {
            continue;
          }

          const candidate: AliasLookupResult = {
            kind,
            targetId,
            canonicalName: this.getCanonicalName(kind, targetId),
            matchedAlias: record.alias,
            normalizedAlias: record.normalizedAlias,
            provenance: record.provenance,
            score,
            confidence: scoreToConfidence(score)
          };

          const existing = bestByTarget.get(targetId);
          if (!existing || this.isBetterResult(candidate, existing)) {
            bestByTarget.set(targetId, candidate);
          }
        }
      }
    };

    evaluateBucket(this.configByKind[kind]);
    evaluateBucket(this.learnedByKind[kind]);

    return [...bestByTarget.values()]
      .sort((left, right) => {
        if (left.score !== right.score) {
          return right.score - left.score;
        }
        if (left.provenance !== right.provenance) {
          return left.provenance === 'config' ? -1 : 1;
        }
        if (left.targetId !== right.targetId) {
          return left.targetId - right.targetId;
        }
        const aliasCmp = compareText(left.matchedAlias, right.matchedAlias);
        if (aliasCmp !== 0) {
          return aliasCmp;
        }
        return compareText(left.canonicalName, right.canonicalName);
      })
      .slice(0, safeLimit);
  }

  exportCatalog(): { generatedAt: string; entries: AliasRecord[] } {
    const entries: AliasRecord[] = [];

    for (const kind of KIND_ORDER) {
      const buckets = [this.configByKind[kind], this.learnedByKind[kind]];
      for (const bucket of buckets) {
        const ids = [...bucket.keys()].sort((left, right) => left - right);
        for (const targetId of ids) {
          const aliasMap = bucket.get(targetId);
          if (!aliasMap) {
            continue;
          }

          const records = [...aliasMap.values()].sort((left, right) => {
            if (left.provenance !== right.provenance) {
              return left.provenance === 'config' ? -1 : 1;
            }
            const normalizedCmp = compareText(left.normalizedAlias, right.normalizedAlias);
            if (normalizedCmp !== 0) {
              return normalizedCmp;
            }
            return compareText(left.alias, right.alias);
          });

          for (const record of records) {
            entries.push({
              kind,
              targetId,
              canonicalName: this.getCanonicalName(kind, targetId),
              alias: record.alias,
              normalizedAlias: record.normalizedAlias,
              tokens: [...record.tokens],
              provenance: record.provenance
            });
          }
        }
      }
    }

    entries.sort((left, right) => {
      const kindCmp = kindRank(left.kind) - kindRank(right.kind);
      if (kindCmp !== 0) {
        return kindCmp;
      }
      if (left.targetId !== right.targetId) {
        return left.targetId - right.targetId;
      }
      if (left.provenance !== right.provenance) {
        return left.provenance === 'config' ? -1 : 1;
      }
      const normalizedCmp = compareText(left.normalizedAlias, right.normalizedAlias);
      if (normalizedCmp !== 0) {
        return normalizedCmp;
      }
      return compareText(left.alias, right.alias);
    });

    return {
      generatedAt: new Date().toISOString(),
      entries
    };
  }

  private getCanonicalName(kind: AliasKind, targetId: number): string {
    return this.namesByKind[kind].get(targetId) ?? `${kind}:${targetId}`;
  }

  private refreshCanonicalNames(kind: AliasKind, bucket: Map<number, Map<string, AliasRecord>>): void {
    for (const [targetId, aliasMap] of bucket.entries()) {
      const canonicalName = this.getCanonicalName(kind, targetId);
      for (const [normalizedAlias, record] of aliasMap.entries()) {
        aliasMap.set(normalizedAlias, {
          ...record,
          canonicalName
        });
      }
    }
  }

  private upsertAlias(
    bucket: Map<number, Map<string, AliasRecord>>,
    kind: AliasKind,
    targetId: number,
    rawAlias: string,
    provenance: AliasProvenance
  ): void {
    const displayAlias = normalizeDisplayAlias(rawAlias);
    const normalizedAlias = normalizeAliasText(displayAlias);
    if (!displayAlias || !normalizedAlias) {
      return;
    }

    const tokens = tokenizeAliasText(normalizedAlias);
    const perTarget = bucket.get(targetId) ?? new Map<string, AliasRecord>();
    const candidate: AliasRecord = {
      kind,
      targetId,
      canonicalName: this.getCanonicalName(kind, targetId),
      alias: displayAlias,
      normalizedAlias,
      tokens,
      provenance
    };

    const existing = perTarget.get(normalizedAlias);
    if (!existing || this.preferAlias(candidate, existing)) {
      perTarget.set(normalizedAlias, candidate);
      bucket.set(targetId, perTarget);
    }
  }

  private preferAlias(candidate: AliasRecord, existing: AliasRecord): boolean {
    const candidateAliasKey = `${candidate.alias.toLowerCase()}\u0000${candidate.alias}`;
    const existingAliasKey = `${existing.alias.toLowerCase()}\u0000${existing.alias}`;
    return candidateAliasKey < existingAliasKey;
  }

  private computeScore(record: AliasRecord, normalizedQuery: string, queryTokens: string[]): number {
    if (record.normalizedAlias === normalizedQuery) {
      return 1;
    }

    let score = 0;
    if (record.normalizedAlias.startsWith(normalizedQuery)) {
      score = Math.max(score, 0.94);
    }
    if (record.normalizedAlias.includes(normalizedQuery)) {
      score = Math.max(score, 0.86);
    }
    if (normalizedQuery.startsWith(record.normalizedAlias)) {
      score = Math.max(score, 0.8);
    }

    const overlap = computeTokenOverlap(queryTokens, record.tokens);
    if (overlap > 0) {
      const queryCoverage = overlap / queryTokens.length;
      const aliasCoverage = overlap / record.tokens.length;
      const harmonic = (2 * queryCoverage * aliasCoverage) / (queryCoverage + aliasCoverage);
      score = Math.max(score, 0.35 + harmonic * 0.55);
    }

    if (score > 0 && record.provenance === 'config') {
      score = Math.min(1, score + 0.02);
    }

    return roundScore(score);
  }

  private isBetterResult(candidate: AliasLookupResult, existing: AliasLookupResult): boolean {
    if (candidate.score !== existing.score) {
      return candidate.score > existing.score;
    }
    if (candidate.provenance !== existing.provenance) {
      return candidate.provenance === 'config';
    }

    const aliasCmp = compareText(candidate.matchedAlias, existing.matchedAlias);
    if (aliasCmp !== 0) {
      return aliasCmp < 0;
    }

    return compareText(candidate.canonicalName, existing.canonicalName) < 0;
  }

  private buildDeviceAliases(device: DeviceInput): string[] {
    const baseName = normalizeDisplayAlias(device.name);
    const location = normalizeDisplayAlias(device.location ?? '');
    const location2 = normalizeDisplayAlias(device.location2 ?? '');

    const aliases = new Set<string>();
    if (baseName) {
      aliases.add(baseName);
    }
    if (location && baseName) {
      aliases.add(`${location} ${baseName}`);
    }
    if (location2 && baseName) {
      aliases.add(`${location2} ${baseName}`);
    }
    if (location && location2 && baseName) {
      aliases.add(`${location} ${location2} ${baseName}`);
    }
    aliases.add(`device ${device.ref}`);

    return [...aliases.values()].sort(compareText);
  }

  private buildEventAliases(event: EventInput): string[] {
    const name = normalizeDisplayAlias(event.name);
    const group = normalizeDisplayAlias(event.group);

    const aliases = new Set<string>();
    if (name) {
      aliases.add(name);
    }
    if (group && name) {
      aliases.add(`${group} ${name}`);
    }
    if (group) {
      aliases.add(group);
    }
    aliases.add(`event ${event.id}`);

    return [...aliases.values()].sort(compareText);
  }

  private buildCameraAliases(camera: CameraInput): string[] {
    const name = normalizeDisplayAlias(camera.name);
    const aliases = new Set<string>();
    if (name) {
      aliases.add(name);
    }
    aliases.add(`camera ${camera.id}`);
    return [...aliases.values()].sort(compareText);
  }
}
