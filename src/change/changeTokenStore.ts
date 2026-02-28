import { randomUUID } from 'node:crypto';
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export interface PreparedChangeRecord {
  token: string;
  toolName: string;
  args: Record<string, unknown>;
  summary: Record<string, unknown>;
  preparedAuditRef?: string;
  commitAuditRef?: string;
  createdAt: string;
  expiresAt: string;
  committedAt: string | null;
}

interface CreateChangeInput {
  toolName: string;
  args: Record<string, unknown>;
  summary: Record<string, unknown>;
  preparedAuditRef?: string;
}

interface ChangeTokenStoreOptions {
  ttlSec: number;
  maxEntries: number;
  persistPath?: string;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeOptionalString(raw: string | undefined): string | undefined {
  const trimmed = raw?.trim();
  return trimmed ? trimmed : undefined;
}

function parseTimestamp(raw: string): number | null {
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

function cloneRecordObject(input: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(input)) as Record<string, unknown>;
}

function clonePreparedChangeRecord(record: PreparedChangeRecord): PreparedChangeRecord {
  return {
    ...record,
    args: cloneRecordObject(record.args),
    summary: cloneRecordObject(record.summary)
  };
}

function parsePersistedPreparedChange(raw: unknown): PreparedChangeRecord | null {
  if (!isObject(raw)) {
    return null;
  }

  const token = raw.token;
  const toolName = raw.toolName;
  const args = raw.args;
  const summary = raw.summary;
  const createdAt = raw.createdAt;
  const expiresAt = raw.expiresAt;
  const committedAt = raw.committedAt;
  const preparedAuditRef = raw.preparedAuditRef;
  const commitAuditRef = raw.commitAuditRef;

  if (
    typeof token !== 'string' ||
    typeof toolName !== 'string' ||
    !isObject(args) ||
    !isObject(summary) ||
    typeof createdAt !== 'string' ||
    typeof expiresAt !== 'string' ||
    (committedAt !== null && typeof committedAt !== 'string')
  ) {
    return null;
  }

  if (parseTimestamp(createdAt) === null || parseTimestamp(expiresAt) === null) {
    return null;
  }
  if (typeof committedAt === 'string' && parseTimestamp(committedAt) === null) {
    return null;
  }
  if (preparedAuditRef !== undefined && typeof preparedAuditRef !== 'string') {
    return null;
  }
  if (commitAuditRef !== undefined && typeof commitAuditRef !== 'string') {
    return null;
  }

  return {
    token,
    toolName,
    args: cloneRecordObject(args),
    summary: cloneRecordObject(summary),
    preparedAuditRef,
    commitAuditRef,
    createdAt,
    expiresAt,
    committedAt
  };
}

export class ChangeTokenStore {
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly persistPath?: string;

  private readonly records = new Map<string, PreparedChangeRecord>();
  private initialized = false;
  private initPromise: Promise<void> | null = null;
  private persistQueue: Promise<void> = Promise.resolve();
  private persistDirReady = false;

  constructor(opts: ChangeTokenStoreOptions) {
    const ttlSec = Number.isFinite(opts.ttlSec) ? Math.max(1, Math.floor(opts.ttlSec)) : 1;
    const maxEntries = Number.isFinite(opts.maxEntries) ? Math.max(1, Math.floor(opts.maxEntries)) : 1;

    this.ttlMs = ttlSec * 1000;
    this.maxEntries = maxEntries;
    this.persistPath = normalizeOptionalString(opts.persistPath);
  }

  async init(): Promise<void> {
    if (this.initialized) {
      return;
    }
    if (this.initPromise) {
      return this.initPromise;
    }

    this.initPromise = (async () => {
      if (this.persistPath) {
        await this.loadPersistedRecords(this.persistPath);
      }

      this.purgeExpiredInternal(Date.now());
      this.enforceMaxEntries();
      this.initialized = true;
    })();

    try {
      await this.initPromise;
    } finally {
      this.initPromise = null;
    }
  }

  async create(input: CreateChangeInput): Promise<PreparedChangeRecord> {
    await this.init();

    const toolName = input.toolName.trim();
    if (!toolName) {
      throw new Error('toolName must be non-empty');
    }

    this.purgeExpiredInternal(Date.now());

    const now = Date.now();
    const preparedAuditRef = normalizeOptionalString(input.preparedAuditRef);
    const record: PreparedChangeRecord = {
      token: randomUUID(),
      toolName,
      args: cloneRecordObject(input.args),
      summary: cloneRecordObject(input.summary),
      preparedAuditRef,
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + this.ttlMs).toISOString(),
      committedAt: null
    };

    this.records.set(record.token, record);
    this.enforceMaxEntries();
    await this.appendPersistedRecord(record);
    return clonePreparedChangeRecord(record);
  }

  get(token: string): PreparedChangeRecord | null {
    this.purgeExpiredInternal(Date.now());
    const normalized = token.trim();
    if (!normalized) {
      return null;
    }
    const found = this.records.get(normalized);
    return found ? clonePreparedChangeRecord(found) : null;
  }

  async markCommitted(token: string, commitAuditRef?: string): Promise<PreparedChangeRecord | null> {
    await this.init();
    this.purgeExpiredInternal(Date.now());

    const normalizedToken = token.trim();
    if (!normalizedToken) {
      return null;
    }

    const found = this.records.get(normalizedToken);
    if (!found) {
      return null;
    }

    let changed = false;
    if (found.committedAt === null) {
      found.committedAt = new Date().toISOString();
      changed = true;
    }

    const normalizedAuditRef = normalizeOptionalString(commitAuditRef);
    if (normalizedAuditRef && normalizedAuditRef !== found.commitAuditRef) {
      found.commitAuditRef = normalizedAuditRef;
      changed = true;
    }

    if (changed) {
      await this.appendPersistedRecord(found);
    }

    return clonePreparedChangeRecord(found);
  }

  async purgeExpired(): Promise<number> {
    await this.init();
    return this.purgeExpiredInternal(Date.now());
  }

  list(limit?: number): PreparedChangeRecord[] {
    this.purgeExpiredInternal(Date.now());

    const max = Number.isFinite(limit) ? Math.max(0, Math.floor(limit ?? 0)) : Number.MAX_SAFE_INTEGER;
    if (max === 0) {
      return [];
    }

    return [...this.records.values()]
      .sort((left, right) => {
        const leftMs = parseTimestamp(left.createdAt) ?? 0;
        const rightMs = parseTimestamp(right.createdAt) ?? 0;
        if (leftMs !== rightMs) {
          return rightMs - leftMs;
        }
        return left.token < right.token ? -1 : left.token > right.token ? 1 : 0;
      })
      .slice(0, max)
      .map((record) => clonePreparedChangeRecord(record));
  }

  private purgeExpiredInternal(nowMs: number): number {
    let removed = 0;
    for (const [token, record] of this.records.entries()) {
      const expiresAtMs = parseTimestamp(record.expiresAt);
      if (expiresAtMs === null || expiresAtMs <= nowMs) {
        this.records.delete(token);
        removed += 1;
      }
    }
    return removed;
  }

  private enforceMaxEntries(): void {
    if (this.records.size <= this.maxEntries) {
      return;
    }

    const ordered = [...this.records.values()].sort((left, right) => {
      const leftMs = parseTimestamp(left.createdAt) ?? 0;
      const rightMs = parseTimestamp(right.createdAt) ?? 0;
      if (leftMs !== rightMs) {
        return leftMs - rightMs;
      }
      return left.token < right.token ? -1 : left.token > right.token ? 1 : 0;
    });

    const excess = this.records.size - this.maxEntries;
    for (let index = 0; index < excess; index += 1) {
      const record = ordered[index];
      if (record) {
        this.records.delete(record.token);
      }
    }
  }

  private async loadPersistedRecords(path: string): Promise<void> {
    let content = '';
    try {
      content = await readFile(path, 'utf8');
    } catch (error: unknown) {
      const code = (error as { code?: string }).code;
      if (code === 'ENOENT') {
        return;
      }
      throw error;
    }

    const lines = content.split('\n');
    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line) {
        continue;
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }

      const record = parsePersistedPreparedChange(parsed);
      if (!record) {
        continue;
      }

      this.records.set(record.token, record);
    }
  }

  private async ensurePersistDirectory(): Promise<void> {
    if (!this.persistPath || this.persistDirReady) {
      return;
    }

    await mkdir(dirname(this.persistPath), { recursive: true });
    this.persistDirReady = true;
  }

  private async appendPersistedRecord(record: PreparedChangeRecord): Promise<void> {
    if (!this.persistPath) {
      return;
    }

    const line = `${JSON.stringify(record)}\n`;
    const write = this.persistQueue.then(async () => {
      await this.ensurePersistDirectory();
      await appendFile(this.persistPath as string, line, 'utf8');
    });

    this.persistQueue = write.catch(() => undefined);
    await write;
  }
}
