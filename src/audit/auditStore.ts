import { appendFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

import type { ErrorCode } from '../errors.js';

export type AuditResult = 'allowed' | 'blocked' | 'success' | 'error' | 'dry_run';
export type OperationTier = 'operator' | 'admin';
export type AuditDomain = 'users' | 'plugins' | 'interfaces' | 'system' | 'cameras' | 'events' | 'config';
export type RollbackResult = 'not_needed' | 'available' | 'applied' | 'failed';

export interface AuditEntry {
  id: string;
  timestamp: string;
  tool: string;
  action: string;
  result: AuditResult;
  dryRun: boolean;
  operationTier?: OperationTier;
  domain?: AuditDomain;
  maintenanceWindowId?: string;
  changeTicket?: string;
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
  diff?: Record<string, unknown>;
  rollbackAttempted?: boolean;
  rollbackResult?: RollbackResult;
  durationMs?: number;
  errorCode?: ErrorCode;
  message?: string;
  target?: Record<string, unknown>;
  details?: Record<string, unknown>;
}

export interface AuditQuery {
  tool?: string;
  action?: string;
  result?: AuditResult;
  operationTier?: OperationTier;
  domain?: AuditDomain;
  maintenanceWindowId?: string;
  changeTicket?: string;
  rollbackResult?: RollbackResult;
  since?: string;
  limit?: number;
}

export class AuditStore {
  private readonly entries: AuditEntry[] = [];

  constructor(
    private readonly maxEntries: number,
    private readonly persistPath?: string
  ) {}

  async record(entry: Omit<AuditEntry, 'id' | 'timestamp'>): Promise<AuditEntry> {
    const created: AuditEntry = {
      id: randomUUID(),
      timestamp: new Date().toISOString(),
      ...entry
    };

    this.entries.push(created);
    if (this.entries.length > this.maxEntries) {
      this.entries.splice(0, this.entries.length - this.maxEntries);
    }

    if (this.persistPath) {
      const line = `${JSON.stringify(created)}\n`;
      await appendFile(this.persistPath, line, 'utf8').catch(() => undefined);
    }

    return created;
  }

  query(query: AuditQuery = {}): AuditEntry[] {
    const sinceMs = query.since ? Date.parse(query.since) : Number.NaN;
    const limit = query.limit && Number.isFinite(query.limit) ? Math.max(1, query.limit) : 100;

    const filtered = this.entries.filter((entry) => {
      if (query.tool && entry.tool !== query.tool) {
        return false;
      }
      if (query.action && entry.action !== query.action) {
        return false;
      }
      if (query.result && entry.result !== query.result) {
        return false;
      }
      if (query.operationTier && entry.operationTier !== query.operationTier) {
        return false;
      }
      if (query.domain && entry.domain !== query.domain) {
        return false;
      }
      if (query.maintenanceWindowId && entry.maintenanceWindowId !== query.maintenanceWindowId) {
        return false;
      }
      if (query.changeTicket && entry.changeTicket !== query.changeTicket) {
        return false;
      }
      if (query.rollbackResult && entry.rollbackResult !== query.rollbackResult) {
        return false;
      }
      if (Number.isFinite(sinceMs) && Date.parse(entry.timestamp) < sinceMs) {
        return false;
      }
      return true;
    });

    return filtered.slice(-limit).reverse();
  }

  latest(limit = 100): AuditEntry[] {
    return this.query({ limit });
  }
}
