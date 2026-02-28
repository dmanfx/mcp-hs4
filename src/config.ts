import { z } from 'zod/v4';
import type { McpHttpAcceptMode } from './http/acceptNegotiation.js';

export type SafeMode = 'read_write' | 'read_only';
export type McpTransport = 'stdio' | 'http';
export type AdminExecutionMode = 'adapter' | 'direct' | 'auto';

export interface AppConfig {
  hs4BaseUrl: string;
  hs4User?: string;
  hs4Pass?: string;
  requestTimeoutMs: number;
  readRetries: number;
  readRetryBackoffMs: number;
  includeEverythingOnStatus: boolean;
  maxDevicesDefaultCap: number;
  statusCacheTtlMs: number;

  safeMode: SafeMode;
  requireConfirm: boolean;
  defaultDryRun: boolean;

  allowedDeviceRefs: Set<number> | null;
  allowedEventIds: Set<number> | null;
  allowedCameraIds: Set<number> | null;
  allowedScripts: Set<string> | null;
  allowedPluginFunctions: Set<string> | null;
  hs4AdminEnabled: boolean;
  hs4AdminUsersEnabled: boolean;
  hs4AdminPluginsEnabled: boolean;
  hs4AdminInterfacesEnabled: boolean;
  hs4AdminSystemEnabled: boolean;
  hs4AdminCamerasEnabled: boolean;
  hs4AdminEventsEnabled: boolean;
  hs4AdminConfigEnabled: boolean;
  hs4AdminMaintenanceWindowId?: string;
  hs4AdminAllowedMaintenanceWindowIds: Set<string> | null;
  hs4AdminRequireChangeTicket: boolean;
  hs4AdminRollbackEnabled: boolean;
  hs4AdminExecutionMode: AdminExecutionMode;
  hs4AdminDirectFallback: boolean;
  hs4AdminCapabilityCacheTtlSec: number;
  hs4AdminAllowedUserIds: Set<string> | null;
  hs4AdminAllowedPluginIds: Set<string> | null;
  hs4AdminAllowedInterfaceIds: Set<string> | null;
  hs4AdminAllowedCategoryIds: Set<string> | null;

  scriptPagePath: string;
  hs4EventsDataPath: string;
  hs4EventGroupsDataPath: string;
  hs4AliasLearnedEnabled: boolean;
  hs4AliasConfigPath?: string;
  hs4ChangeTokenTtlSec: number;
  hs4ChangeTokenMaxEntries: number;
  hs4ChangeTokenPersistPath?: string;

  mcpTransport: McpTransport;
  mcpHttpHost: string;
  mcpHttpPort: number;
  mcpHttpAllowNonLoopback: boolean;
  mcpHttpAcceptMode: McpHttpAcceptMode;
  mcpHttpAllowJsonOnly: boolean;
  mcpHttpAuthToken?: string;
  mcpHttpAuthRequiredNonLoopback: boolean;
  mcpHttpAuthProtectHealthz: boolean;

  logLevel: string;

  auditMaxEntries: number;
  auditPersistPath?: string;
}

const envSchema = z.object({
  HS4_BASE_URL: z.string().optional(),
  HS4_USER: z.string().optional(),
  HS4_PASS: z.string().optional(),
  HS4_TIMEOUT_MS: z.string().optional(),
  HS4_READ_RETRIES: z.string().optional(),
  HS4_READ_RETRY_BACKOFF_MS: z.string().optional(),
  HS4_STATUS_INCLUDE_EVERYTHING: z.string().optional(),
  HS4_MAX_DEVICES_DEFAULT_CAP: z.string().optional(),
  HS4_STATUS_CACHE_TTL_MS: z.string().optional(),

  HS4_SAFE_MODE: z.string().optional(),
  HS4_REQUIRE_CONFIRM: z.string().optional(),
  HS4_DEFAULT_DRY_RUN: z.string().optional(),

  HS4_ALLOWED_DEVICE_REFS: z.string().optional(),
  HS4_ALLOWED_EVENT_IDS: z.string().optional(),
  HS4_ALLOWED_CAMERA_IDS: z.string().optional(),
  HS4_ALLOWED_SCRIPTS: z.string().optional(),
  HS4_ALLOWED_PLUGIN_FUNCTIONS: z.string().optional(),
  HS4_ADMIN_ENABLED: z.string().optional(),
  HS4_ADMIN_USERS_ENABLED: z.string().optional(),
  HS4_ADMIN_PLUGINS_ENABLED: z.string().optional(),
  HS4_ADMIN_INTERFACES_ENABLED: z.string().optional(),
  HS4_ADMIN_SYSTEM_ENABLED: z.string().optional(),
  HS4_ADMIN_CAMERAS_ENABLED: z.string().optional(),
  HS4_ADMIN_EVENTS_ENABLED: z.string().optional(),
  HS4_ADMIN_CONFIG_ENABLED: z.string().optional(),
  HS4_ADMIN_MAINTENANCE_WINDOW_ID: z.string().optional(),
  HS4_ADMIN_ALLOWED_MAINTENANCE_WINDOW_IDS: z.string().optional(),
  HS4_ADMIN_REQUIRE_CHANGE_TICKET: z.string().optional(),
  HS4_ADMIN_ROLLBACK_ENABLED: z.string().optional(),
  HS4_ADMIN_EXECUTION_MODE: z.string().optional(),
  HS4_ADMIN_DIRECT_FALLBACK: z.string().optional(),
  HS4_ADMIN_CAPABILITY_CACHE_TTL_SEC: z.string().optional(),
  HS4_ADMIN_ALLOWED_USER_IDS: z.string().optional(),
  HS4_ADMIN_ALLOWED_PLUGIN_IDS: z.string().optional(),
  HS4_ADMIN_ALLOWED_INTERFACE_IDS: z.string().optional(),
  HS4_ADMIN_ALLOWED_CATEGORY_IDS: z.string().optional(),

  HS4_SCRIPT_PAGE_PATH: z.string().optional(),
  HS4_EVENTS_DATA_PATH: z.string().optional(),
  HS4_EVENT_GROUPS_DATA_PATH: z.string().optional(),
  HS4_ALIAS_LEARNED_ENABLED: z.string().optional(),
  HS4_ALIAS_CONFIG_PATH: z.string().optional(),
  HS4_CHANGE_TOKEN_TTL_SEC: z.string().optional(),
  HS4_CHANGE_TOKEN_MAX_ENTRIES: z.string().optional(),
  HS4_CHANGE_TOKEN_PERSIST_PATH: z.string().optional(),

  MCP_TRANSPORT: z.string().optional(),
  MCP_HTTP_HOST: z.string().optional(),
  MCP_HTTP_PORT: z.string().optional(),
  MCP_HTTP_ALLOW_NON_LOOPBACK: z.string().optional(),
  MCP_HTTP_ACCEPT_MODE: z.string().optional(),
  MCP_HTTP_ALLOW_JSON_ONLY: z.string().optional(),
  MCP_HTTP_AUTH_TOKEN: z.string().optional(),
  MCP_HTTP_AUTH_REQUIRED_NON_LOOPBACK: z.string().optional(),
  MCP_HTTP_AUTH_PROTECT_HEALTHZ: z.string().optional(),

  MCP_LOG_LEVEL: z.string().optional(),

  MCP_AUDIT_MAX_ENTRIES: z.string().optional(),
  MCP_AUDIT_PERSIST_PATH: z.string().optional()
});

function normalizeBaseUrl(raw?: string): string {
  const fallback = 'http://127.0.0.1';
  if (!raw || !raw.trim()) {
    return fallback;
  }

  const trimmed = raw.trim().replace(/\/+$/, '');
  try {
    const parsed = new URL(trimmed);
    // Avoid accidental secret embedding like http://user:pass@host.
    parsed.username = '';
    parsed.password = '';
    // Avoid accidental query-credential embedding like ?user=...&pass=....
    parsed.searchParams.delete('user');
    parsed.searchParams.delete('pass');
    return parsed.toString().replace(/\/+$/, '');
  } catch {
    throw new Error(`Invalid HS4_BASE_URL: ${raw}`);
  }
}

function parseBoolean(raw: string | undefined, defaultValue: boolean): boolean {
  if (raw === undefined) {
    return defaultValue;
  }

  const normalized = raw.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) {
    return true;
  }
  if (['0', 'false', 'no', 'off'].includes(normalized)) {
    return false;
  }

  return defaultValue;
}

function parseNumber(raw: string | undefined, defaultValue: number, min: number, max: number): number {
  if (raw === undefined || raw.trim() === '') {
    return defaultValue;
  }
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    return defaultValue;
  }
  return Math.min(max, Math.max(min, Math.floor(n)));
}

function parseSafeMode(raw: string | undefined): SafeMode {
  const normalized = raw?.trim().toLowerCase();
  if (normalized === 'read_only') {
    return 'read_only';
  }
  return 'read_write';
}

function parseAdminExecutionMode(raw: string | undefined): AdminExecutionMode {
  const normalized = raw?.trim().toLowerCase();
  if (normalized === 'direct') {
    return 'direct';
  }
  if (normalized === 'auto') {
    return 'auto';
  }
  return 'adapter';
}

function parseTransport(raw: string | undefined): McpTransport {
  const normalized = raw?.trim().toLowerCase();
  if (normalized === 'http') {
    return 'http';
  }
  return 'stdio';
}

function parseMcpHttpAcceptMode(raw: string | undefined): McpHttpAcceptMode {
  const normalized = raw?.trim().toLowerCase();
  if (normalized === 'strict') {
    return 'strict';
  }
  return 'compat';
}

function parseNumberAllowlist(raw: string | undefined): Set<number> | null {
  if (!raw || !raw.trim() || raw.trim() === '*') {
    return null;
  }

  const result = new Set<number>();
  const parts = raw
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);

  for (const part of parts) {
    if (part.includes('-')) {
      const [startRaw, endRaw] = part.split('-').map((x) => x.trim());
      const start = Number(startRaw);
      const end = Number(endRaw);
      if (!Number.isFinite(start) || !Number.isFinite(end)) {
        continue;
      }
      const from = Math.min(start, end);
      const to = Math.max(start, end);
      for (let i = from; i <= to; i += 1) {
        result.add(i);
      }
      continue;
    }

    const value = Number(part);
    if (Number.isFinite(value)) {
      result.add(value);
    }
  }

  return result;
}

function parseStringAllowlist(raw: string | undefined, options: { normalizeLowercase?: boolean } = {}): Set<string> | null {
  if (!raw || !raw.trim() || raw.trim() === '*') {
    return null;
  }

  const normalizeLowercase = options.normalizeLowercase ?? true;
  const values = raw
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);

  if (!values.length) {
    return null;
  }

  const normalized = normalizeLowercase ? values.map((part) => part.toLowerCase()) : values;
  return new Set(normalized);
}

function parseOptionalString(raw: string | undefined): string | undefined {
  const trimmed = raw?.trim();
  return trimmed ? trimmed : undefined;
}

export function loadConfig(): AppConfig {
  const parsed = envSchema.parse(process.env);

  const hs4BaseUrl = normalizeBaseUrl(parsed.HS4_BASE_URL);
  const scriptPagePath = parsed.HS4_SCRIPT_PAGE_PATH?.trim() || '/runscript.html';
  const hs4EventsDataPath =
    parsed.HS4_EVENTS_DATA_PATH?.trim() || '/usr/local/HomeSeer/Data/HomeSeerData_2.json/events.json';
  const hs4EventGroupsDataPath =
    parsed.HS4_EVENT_GROUPS_DATA_PATH?.trim() || '/usr/local/HomeSeer/Data/HomeSeerData_2.json/eventgroups.json';

  return {
    hs4BaseUrl,
    hs4User: parsed.HS4_USER?.trim() || undefined,
    hs4Pass: parsed.HS4_PASS?.trim() || undefined,
    requestTimeoutMs: parseNumber(parsed.HS4_TIMEOUT_MS, 10_000, 500, 120_000),
    readRetries: parseNumber(parsed.HS4_READ_RETRIES, 2, 0, 10),
    readRetryBackoffMs: parseNumber(parsed.HS4_READ_RETRY_BACKOFF_MS, 200, 10, 10_000),
    includeEverythingOnStatus: parseBoolean(parsed.HS4_STATUS_INCLUDE_EVERYTHING, false),
    maxDevicesDefaultCap: parseNumber(parsed.HS4_MAX_DEVICES_DEFAULT_CAP, 250, 1, 20_000),
    statusCacheTtlMs: parseNumber(parsed.HS4_STATUS_CACHE_TTL_MS, 1_500, 0, 60_000),

    safeMode: parseSafeMode(parsed.HS4_SAFE_MODE),
    requireConfirm: parseBoolean(parsed.HS4_REQUIRE_CONFIRM, true),
    defaultDryRun: parseBoolean(parsed.HS4_DEFAULT_DRY_RUN, false),

    allowedDeviceRefs: parseNumberAllowlist(parsed.HS4_ALLOWED_DEVICE_REFS),
    allowedEventIds: parseNumberAllowlist(parsed.HS4_ALLOWED_EVENT_IDS),
    allowedCameraIds: parseNumberAllowlist(parsed.HS4_ALLOWED_CAMERA_IDS),
    allowedScripts: parseStringAllowlist(parsed.HS4_ALLOWED_SCRIPTS),
    allowedPluginFunctions: parseStringAllowlist(parsed.HS4_ALLOWED_PLUGIN_FUNCTIONS),
    hs4AdminEnabled: parseBoolean(parsed.HS4_ADMIN_ENABLED, false),
    hs4AdminUsersEnabled: parseBoolean(parsed.HS4_ADMIN_USERS_ENABLED, false),
    hs4AdminPluginsEnabled: parseBoolean(parsed.HS4_ADMIN_PLUGINS_ENABLED, false),
    hs4AdminInterfacesEnabled: parseBoolean(parsed.HS4_ADMIN_INTERFACES_ENABLED, false),
    hs4AdminSystemEnabled: parseBoolean(parsed.HS4_ADMIN_SYSTEM_ENABLED, false),
    hs4AdminCamerasEnabled: parseBoolean(parsed.HS4_ADMIN_CAMERAS_ENABLED, false),
    hs4AdminEventsEnabled: parseBoolean(parsed.HS4_ADMIN_EVENTS_ENABLED, false),
    hs4AdminConfigEnabled: parseBoolean(parsed.HS4_ADMIN_CONFIG_ENABLED, false),
    hs4AdminMaintenanceWindowId: parseOptionalString(parsed.HS4_ADMIN_MAINTENANCE_WINDOW_ID),
    hs4AdminAllowedMaintenanceWindowIds: parseStringAllowlist(parsed.HS4_ADMIN_ALLOWED_MAINTENANCE_WINDOW_IDS, {
      normalizeLowercase: false
    }),
    hs4AdminRequireChangeTicket: parseBoolean(parsed.HS4_ADMIN_REQUIRE_CHANGE_TICKET, true),
    hs4AdminRollbackEnabled: parseBoolean(parsed.HS4_ADMIN_ROLLBACK_ENABLED, true),
    hs4AdminExecutionMode: parseAdminExecutionMode(parsed.HS4_ADMIN_EXECUTION_MODE),
    hs4AdminDirectFallback: parseBoolean(parsed.HS4_ADMIN_DIRECT_FALLBACK, true),
    hs4AdminCapabilityCacheTtlSec: parseNumber(parsed.HS4_ADMIN_CAPABILITY_CACHE_TTL_SEC, 300, 0, 86_400),
    hs4AdminAllowedUserIds: parseStringAllowlist(parsed.HS4_ADMIN_ALLOWED_USER_IDS),
    hs4AdminAllowedPluginIds: parseStringAllowlist(parsed.HS4_ADMIN_ALLOWED_PLUGIN_IDS),
    hs4AdminAllowedInterfaceIds: parseStringAllowlist(parsed.HS4_ADMIN_ALLOWED_INTERFACE_IDS),
    hs4AdminAllowedCategoryIds: parseStringAllowlist(parsed.HS4_ADMIN_ALLOWED_CATEGORY_IDS),

    scriptPagePath,
    hs4EventsDataPath,
    hs4EventGroupsDataPath,
    hs4AliasLearnedEnabled: parseBoolean(parsed.HS4_ALIAS_LEARNED_ENABLED, true),
    hs4AliasConfigPath: parseOptionalString(parsed.HS4_ALIAS_CONFIG_PATH),
    hs4ChangeTokenTtlSec: parseNumber(parsed.HS4_CHANGE_TOKEN_TTL_SEC, 900, 30, 86_400),
    hs4ChangeTokenMaxEntries: parseNumber(parsed.HS4_CHANGE_TOKEN_MAX_ENTRIES, 2_000, 100, 200_000),
    hs4ChangeTokenPersistPath: parseOptionalString(parsed.HS4_CHANGE_TOKEN_PERSIST_PATH),

    mcpTransport: parseTransport(parsed.MCP_TRANSPORT),
    mcpHttpHost: parsed.MCP_HTTP_HOST?.trim() || '127.0.0.1',
    mcpHttpPort: parseNumber(parsed.MCP_HTTP_PORT, 7422, 1, 65535),
    mcpHttpAllowNonLoopback: parseBoolean(parsed.MCP_HTTP_ALLOW_NON_LOOPBACK, false),
    mcpHttpAcceptMode: parseMcpHttpAcceptMode(parsed.MCP_HTTP_ACCEPT_MODE),
    mcpHttpAllowJsonOnly: parseBoolean(parsed.MCP_HTTP_ALLOW_JSON_ONLY, true),
    mcpHttpAuthToken: parseOptionalString(parsed.MCP_HTTP_AUTH_TOKEN),
    mcpHttpAuthRequiredNonLoopback: parseBoolean(parsed.MCP_HTTP_AUTH_REQUIRED_NON_LOOPBACK, true),
    mcpHttpAuthProtectHealthz: parseBoolean(parsed.MCP_HTTP_AUTH_PROTECT_HEALTHZ, true),

    logLevel: parsed.MCP_LOG_LEVEL?.trim() || 'info',

    auditMaxEntries: parseNumber(parsed.MCP_AUDIT_MAX_ENTRIES, 5_000, 100, 1_000_000),
    auditPersistPath: parsed.MCP_AUDIT_PERSIST_PATH?.trim() || undefined
  };
}
