import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { readFile, stat } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import * as z from 'zod/v4';
import type { Logger } from 'pino';

import type { AppConfig } from '../config.js';
import { actionableErrorFields, asHS4McpError, HS4McpError, type ErrorCode } from '../errors.js';
import type { AuditStore, AuditResult } from '../audit/auditStore.js';
import type { PolicyEngine } from '../policy/policyEngine.js';
import { AliasCatalog, normalizeAliasText, type AliasLookupResult } from '../alias/aliasCatalog.js';
import { ChangeTokenStore } from '../change/changeTokenStore.js';
import {
  normalizeCamerasPayload,
  normalizeEventsPayload,
  normalizePluginListPayload,
  normalizeStatusPayload,
  type NormalizedDevice,
  type NormalizedStatusSnapshot
} from '../hs4/normalizer.js';
import type { HS4Client } from '../hs4/client.js';

export interface ServerDependencies {
  config: AppConfig;
  logger: Logger;
  client: HS4Client;
  policy: PolicyEngine;
  audit: AuditStore;
  aliasCatalog?: AliasCatalog;
  changeTokenStore?: ChangeTokenStore;
}

interface GuardArgs {
  confirm?: boolean;
  intent?: string;
  reason?: string;
  dryRun?: boolean;
}

const ADMIN_OPERATION_TIERS = ['operator', 'admin'] as const;
type AdminOperationTier = (typeof ADMIN_OPERATION_TIERS)[number];

const ADMIN_DOMAINS = ['users', 'plugins', 'interfaces', 'system', 'cameras', 'events', 'config'] as const;
type AdminDomain = (typeof ADMIN_DOMAINS)[number];

const ADMIN_RISK_LEVELS = ['low', 'medium', 'high'] as const;
type AdminRiskLevel = (typeof ADMIN_RISK_LEVELS)[number];

interface AdminGuardArgs extends GuardArgs {
  operationTier?: AdminOperationTier;
  domain: AdminDomain;
  maintenanceWindowId?: string;
  changeTicket?: string;
  riskLevel?: AdminRiskLevel;
}

const ADMIN_MUTATION_RESULTS = ['planned', 'applied', 'partial', 'failed', 'rolled_back'] as const;
type AdminMutationResult = (typeof ADMIN_MUTATION_RESULTS)[number];

const ADMIN_ROLLBACK_RESULTS = ['not_needed', 'available', 'applied', 'failed'] as const;
type AdminRollbackResult = (typeof ADMIN_ROLLBACK_RESULTS)[number];

type AdminPrecheckItem = Record<string, unknown>;
type AdminStepItem = Record<string, unknown>;

interface AdminExecutionResult {
  result: AdminMutationResult;
  precheck: AdminPrecheckItem[];
  steps: AdminStepItem[];
  rollback: AdminRollbackResult;
  before?: unknown;
  after?: unknown;
  diff?: unknown;
  data?: unknown;
}

type StatusQueryParams = Parameters<HS4Client['getStatus']>[0];
type AdminExecutionRoute = 'adapter' | 'direct';

type CoreMutatingToolName =
  | 'hs4.devices.set'
  | 'hs4.events.run'
  | 'hs4.scripts.run'
  | 'hs4.plugins.function.call'
  | 'hs4.cameras.pan';

type SupportedPrepareToolName = CoreMutatingToolName | `hs4.admin.${string}`;

interface MutationGuardLike {
  confirm?: boolean;
  intent?: string;
  reason?: string;
  dryRun?: boolean;
  operationTier?: AdminOperationTier;
  domain?: AdminDomain;
  maintenanceWindowId?: string;
  changeTicket?: string;
  riskLevel?: AdminRiskLevel;
}

interface MutationPlanTarget extends Record<string, unknown> {
  ref?: number;
  camId?: number;
  id?: number;
  group?: string;
  name?: string;
  command?: string;
  plugin?: string;
  functionName?: string;
  toolName: SupportedPrepareToolName;
}

interface MutationPrepareResult {
  prepared: true;
  token: string;
  toolName: SupportedPrepareToolName;
  expiresAt: string;
  summary: Record<string, unknown>;
  policy: {
    reasons: string[];
    normalized: unknown;
  };
  target: MutationPlanTarget;
}

type DeviceSetMode = 'control_value' | 'set_status';

interface DeviceSetExecutionArgs {
  ref: number;
  mode: DeviceSetMode;
  value?: number;
  statusText?: string;
  source?: string;
  verify?: boolean;
}

interface DeviceResolutionMeta {
  ref: number;
  name: string;
  location: string;
  location2: string;
  relationship?: string;
  parentRef?: number;
  controlPairCount: number;
  capabilities: string[];
}

const CHILD_REF_KEY_PATTERN = /(child|children|associated|linked|related|relationship|relation|parent|root)/i;
const EVENT_BASE_KEYS = new Set([
  'id',
  'ID',
  'group',
  'Group',
  'name',
  'Name',
  'voice_command',
  'Voice_Command',
  'voice_command_enabled',
  'Voice_Command_Enabled'
]);
const EVENT_TRIGGER_KEYS = ['trigger', 'Trigger', 'triggers', 'Triggers'];
const EVENT_ACTION_KEYS = ['action', 'Action', 'actions', 'Actions'];
const EVENT_CONDITION_KEYS = ['condition', 'Condition', 'conditions', 'Conditions'];
const EVENT_DEFINITION_KEYS = ['definition', 'Definition', 'event', 'Event', 'data', 'Data', 'payload', 'Payload'];
const ADMIN_READ_ACTIONS = new Set([
  'users.list',
  'plugins.catalog.get',
  'interfaces.list',
  'interfaces.diagnostics',
  'system.config.get',
  'cameras.config.list',
  'config.categories.list'
]);

function toJsonText(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function successResult(data: unknown) {
  const structuredContent: Record<string, unknown> = {
    result: data
  };
  return {
    content: [
      {
        type: 'text' as const,
        text: toJsonText(data)
      }
    ],
    structuredContent
  };
}

function errorResult(code: ErrorCode, message: string, details?: unknown) {
  const actionable = actionableErrorFields(code);
  const error =
    details === undefined
      ? {
          code,
          message,
          ...actionable
        }
      : {
          code,
          message,
          ...actionable,
          details
        };
  return {
    isError: true,
    content: [
      {
        type: 'text' as const,
        text: toJsonText({
          error
        })
      }
    ],
    structuredContent: {
      error
    }
  };
}

function throwFromToolErrorResult(result: ReturnType<typeof errorResult>): never {
  const payload = result.structuredContent?.error as
    | {
        code?: ErrorCode;
        message?: string;
        details?: Record<string, unknown>;
      }
    | undefined;
  const code = payload?.code ?? 'UNKNOWN';
  const message = payload?.message ?? 'Tool operation failed.';
  throw new HS4McpError(code, message, {
    details: payload?.details
  });
}

function parseLimit(value: number | undefined, fallback: number, max: number): number {
  const numeric = typeof value === 'number' ? value : Number.NaN;
  if (!Number.isFinite(numeric)) {
    return fallback;
  }
  return Math.max(1, Math.min(max, Math.floor(numeric)));
}

function parseMaxDevices(value: number | undefined, defaultCap: number): number {
  return parseLimit(value, defaultCap, defaultCap);
}

function stripDeviceRaw(device: NormalizedDevice): Omit<NormalizedDevice, 'raw'> {
  const { raw: _raw, ...rest } = device;
  return rest;
}

function toDeviceOutput(
  devices: NormalizedDevice[],
  includeRaw: boolean
): Array<NormalizedDevice | Omit<NormalizedDevice, 'raw'>> {
  return includeRaw ? devices : devices.map((device) => stripDeviceRaw(device));
}

function toSnapshotOutput(
  snapshot: NormalizedStatusSnapshot,
  options: { includeRaw: boolean; maxDevices: number }
): {
  snapshot: {
    name: string;
    version: string;
    tempFormatF: boolean | null;
    devices: Array<NormalizedDevice | Omit<NormalizedDevice, 'raw'>>;
  };
  totalDevices: number;
  returnedDevices: number;
  truncated: boolean;
} {
  const totalDevices = snapshot.devices.length;
  const cappedDevices = snapshot.devices.slice(0, options.maxDevices);
  const devices = toDeviceOutput(cappedDevices, options.includeRaw);

  return {
    snapshot: {
      ...snapshot,
      devices
    },
    totalDevices,
    returnedDevices: devices.length,
    truncated: totalDevices > devices.length
  };
}

function normalizeRequestedRefs(refs: number[]): number[] {
  const result: number[] = [];
  const seen = new Set<number>();

  for (const ref of refs) {
    if (!Number.isFinite(ref)) {
      continue;
    }

    const normalized = Math.floor(ref);
    if (seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    result.push(normalized);
  }

  return result;
}

function collectRefsFromValue(value: unknown, refs: Set<number>): void {
  if (typeof value === 'number' && Number.isFinite(value)) {
    refs.add(Math.floor(value));
    return;
  }

  if (typeof value === 'string') {
    const tokens = value.match(/\d+/g) ?? [];
    for (const token of tokens) {
      const parsed = Number(token);
      if (Number.isFinite(parsed)) {
        refs.add(parsed);
      }
    }
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      collectRefsFromValue(item, refs);
    }
    return;
  }

  if (!value || typeof value !== 'object') {
    return;
  }

  for (const nested of Object.values(value as Record<string, unknown>)) {
    collectRefsFromValue(nested, refs);
  }
}

function extractChildRefs(device: NormalizedDevice): number[] {
  if (!device.raw || typeof device.raw !== 'object') {
    return [];
  }

  const refs = new Set<number>();
  const seen = new Set<object>();
  const stack: unknown[] = [device.raw];

  while (stack.length) {
    const current = stack.pop();
    if (!current || typeof current !== 'object') {
      continue;
    }

    const record = current as Record<string, unknown>;
    if (seen.has(record)) {
      continue;
    }
    seen.add(record);

    for (const [key, value] of Object.entries(record)) {
      if (CHILD_REF_KEY_PATTERN.test(key)) {
        collectRefsFromValue(value, refs);
      }

      if (value && typeof value === 'object') {
        stack.push(value);
      }
    }
  }

  refs.delete(device.ref);
  return Array.from(refs).sort((a, b) => a - b);
}

function statusCacheKey(params: StatusQueryParams): string {
  return JSON.stringify({
    ref: params.ref ?? null,
    location1: params.location1 ?? null,
    location2: params.location2 ?? null,
    compress: params.compress ?? null,
    everything: params.everything ?? null,
    voiceonly: params.voiceonly ?? null,
    excludeevents: params.excludeevents ?? null
  });
}

function createGuardSchema() {
  return {
    confirm: z.boolean().optional().describe('Must be true for mutating operations unless running dry-run.'),
    intent: z.string().min(3).optional().describe('High-level intent for this operation.'),
    reason: z.string().min(3).optional().describe('Reason/rationale for auditability.'),
    dryRun: z.boolean().optional().describe('If true, validates and simulates action without changing HS4.')
  };
}

function createAdminGuardSchema(domain: AdminDomain) {
  return {
    ...createGuardSchema(),
    operationTier: z
      .enum(ADMIN_OPERATION_TIERS)
      .optional()
      .default('operator')
      .describe('Privilege tier for this mutation.'),
    domain: z.literal(domain).describe(`Admin mutation domain; must be '${domain}'.`),
    maintenanceWindowId: z
      .string()
      .min(1)
      .optional()
      .describe('Required for non-dry-run admin mutations.'),
    changeTicket: z
      .string()
      .min(1)
      .optional()
      .describe('Required when policy enforces change-ticket gating.'),
    riskLevel: z
      .enum(ADMIN_RISK_LEVELS)
      .optional()
      .default('medium')
      .describe('Risk classification for audit and change-control workflows.')
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function firstDefined(record: Record<string, unknown>, keys: string[]): unknown {
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(record, key)) {
      return record[key];
    }
  }
  return undefined;
}

function summarizeEventRaw(raw: unknown): Record<string, unknown> {
  if (!isRecord(raw)) {
    return {
      hasRawRecord: false,
      hasExtendedDefinition: false,
      extendedKeys: []
    };
  }

  const rawKeys = Object.keys(raw).sort();
  const extendedKeys = rawKeys.filter((key) => !EVENT_BASE_KEYS.has(key));
  const trigger = firstDefined(raw, EVENT_TRIGGER_KEYS);
  const actions = firstDefined(raw, EVENT_ACTION_KEYS);
  const conditions = firstDefined(raw, EVENT_CONDITION_KEYS);
  const definition = firstDefined(raw, EVENT_DEFINITION_KEYS);

  return {
    hasRawRecord: true,
    hasExtendedDefinition: extendedKeys.length > 0,
    rawKeys,
    extendedKeys,
    trigger: trigger ?? null,
    actions: actions ?? null,
    conditions: conditions ?? null,
    definition: definition ?? null
  };
}

function asOptionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function asOptionalNumber(value: unknown): number | undefined {
  if (typeof value !== 'number') {
    return undefined;
  }
  if (!Number.isFinite(value)) {
    return undefined;
  }
  return value;
}

function asOptionalBoolean(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') {
    return value;
  }
  return undefined;
}

function toRecordArray(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is Record<string, unknown> => isRecord(item));
}

function parsePersistedEventsPayload(payload: unknown): Record<string, unknown>[] {
  if (Array.isArray(payload)) {
    return toRecordArray(payload);
  }

  if (!isRecord(payload)) {
    return [];
  }

  const candidate = firstDefined(payload, ['Events', 'events', 'items', 'Items']);
  if (Array.isArray(candidate)) {
    return toRecordArray(candidate);
  }

  return [];
}

function parseEventGroupMap(payload: unknown): Map<number, string> {
  const map = new Map<number, string>();
  for (const record of toRecordArray(payload)) {
    const ref = asOptionalNumber(firstDefined(record, ['Ref', 'ref']));
    const group = asOptionalString(firstDefined(record, ['Group', 'group']));
    if (typeof ref !== 'number' || !Number.isFinite(ref) || !group) {
      continue;
    }
    map.set(Math.floor(ref), group);
  }
  return map;
}

function readPersistedEventId(record: Record<string, unknown>): number | undefined {
  const value = asOptionalNumber(firstDefined(record, ['evRef', 'id', 'ID']));
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return undefined;
  }
  return Math.floor(value);
}

function readPersistedEventGroupRef(record: Record<string, unknown>): number | undefined {
  const value = asOptionalNumber(firstDefined(record, ['mvarGroupRef', 'groupRef', 'GroupRef']));
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return undefined;
  }
  return Math.floor(value);
}

function readPersistedEventName(record: Record<string, unknown>): string {
  return asOptionalString(firstDefined(record, ['Name', 'name'])) ?? '';
}

function readPersistedEventGroup(record: Record<string, unknown>, groupMap: Map<number, string>): string {
  const direct = asOptionalString(firstDefined(record, ['Group', 'group']));
  if (direct) {
    return direct;
  }

  const groupRef = readPersistedEventGroupRef(record);
  if (Number.isFinite(groupRef) && groupMap.has(groupRef as number)) {
    return groupMap.get(groupRef as number) ?? '';
  }

  return '';
}

function summarizePersistedTriggers(
  eventRecord: Record<string, unknown>,
  includeRaw: boolean
): { groups: Record<string, unknown>[]; refs: number[] } {
  const refs = new Set<number>();
  const triggersSummary: Record<string, unknown>[] = [];
  const triggers = firstDefined(eventRecord, ['Triggers', 'triggers']);

  if (!isRecord(triggers)) {
    return { groups: triggersSummary, refs: [] };
  }

  const trigGroups = firstDefined(triggers, ['TrigGroups', 'trigGroups', 'groups']);
  if (!isRecord(trigGroups)) {
    return { groups: triggersSummary, refs: [] };
  }

  for (const [groupKey, rawGroupValue] of Object.entries(trigGroups)) {
    const values =
      (isRecord(rawGroupValue) ? firstDefined(rawGroupValue, ['$values', 'values', 'Items']) : undefined) ??
      rawGroupValue;
    const triggersInGroup = toRecordArray(values).map((trigger, index) => {
      const deviceRef = asOptionalNumber(firstDefined(trigger, ['ev_trig_dvRef', 'dvRef', 'ref', 'Ref']));
      const normalizedDeviceRef = Number.isFinite(deviceRef) ? Math.floor(deviceRef as number) : null;
      if (Number.isFinite(normalizedDeviceRef) && (normalizedDeviceRef as number) > 0) {
        refs.add(normalizedDeviceRef as number);
      }

      return {
        index,
        type: asOptionalString(firstDefined(trigger, ['$type', 'type'])) ?? null,
        deviceRef: normalizedDeviceRef,
        triggerSubType:
          asOptionalNumber(firstDefined(trigger, ['TriggerSubType', 'mvarTriggerSubType', 'subType'])) ?? null,
        operationSelected: asOptionalBoolean(firstDefined(trigger, ['mvarOperationSelected', 'operationSelected'])) ?? null,
        anyDevice: asOptionalBoolean(firstDefined(trigger, ['AnyDevice', 'anyDevice'])) ?? null,
        anyValue: asOptionalBoolean(firstDefined(trigger, ['AnyValue', 'anyValue'])) ?? null,
        condition: asOptionalBoolean(firstDefined(trigger, ['Condition', 'condition'])) ?? null,
        valueStart:
          asOptionalNumber(firstDefined(trigger, ['mvarValue_or_Start', 'ValueStart', 'valueStart'])) ?? null,
        valueEnd: asOptionalNumber(firstDefined(trigger, ['ValEnd_Spec', 'ValueEnd', 'valueEnd'])) ?? null,
        ...(includeRaw ? { raw: trigger } : {})
      };
    });

    triggersSummary.push({
      groupKey,
      triggerCount: triggersInGroup.length,
      triggers: triggersInGroup,
      ...(includeRaw && isRecord(rawGroupValue) ? { raw: rawGroupValue } : {})
    });
  }

  return {
    groups: triggersSummary,
    refs: Array.from(refs).sort((left, right) => left - right)
  };
}

function summarizePersistedConditionalActions(
  eventRecord: Record<string, unknown>,
  includeRaw: boolean
): { blocks: Record<string, unknown>[]; actionRefs: number[]; conditionCount: number; actionCount: number } {
  const refs = new Set<number>();
  let conditionCount = 0;
  let actionCount = 0;

  const blocks = toRecordArray(firstDefined(eventRecord, ['ConditionalActions', 'conditionalActions'])).map(
    (block, blockIndex) => {
      const conditions = toRecordArray(firstDefined(block, ['mvarConditions', 'conditions', 'Conditions']));
      conditionCount += conditions.length;

      const actionsValue = firstDefined(block, ['mvarActions', 'actions', 'Actions']);
      const actionsRecord = isRecord(actionsValue) ? actionsValue : {};
      const actions: Record<string, unknown>[] = [];

      for (const [actionKey, rawAction] of Object.entries(actionsRecord)) {
        if (!isRecord(rawAction)) {
          continue;
        }

        const deviceActionsRecord = firstDefined(rawAction, ['devices', 'Devices']);
        const deviceActions: Record<string, unknown>[] = [];

        if (isRecord(deviceActionsRecord)) {
          for (const [deviceKey, rawDeviceAction] of Object.entries(deviceActionsRecord)) {
            if (!isRecord(rawDeviceAction)) {
              continue;
            }

            const dvRef = asOptionalNumber(firstDefined(rawDeviceAction, ['dvRef', 'ref', 'Ref']));
            const normalizedRef = Number.isFinite(dvRef) ? Math.floor(dvRef as number) : null;
            if (Number.isFinite(normalizedRef) && (normalizedRef as number) > 0) {
              refs.add(normalizedRef as number);
            }

            deviceActions.push({
              deviceKey,
              dvRef: normalizedRef,
              controlLabel: asOptionalString(firstDefined(rawDeviceAction, ['ControlLabel', 'label'])) ?? null,
              controlValue: asOptionalNumber(firstDefined(rawDeviceAction, ['ControlValue', 'value'])) ?? null,
              ...(includeRaw ? { raw: rawDeviceAction } : {})
            });
          }
        }

        const actionSummary: Record<string, unknown> = {
          actionKey,
          type: asOptionalString(firstDefined(rawAction, ['$type', 'type'])) ?? null,
          delay: asOptionalString(firstDefined(rawAction, ['delay', 'Delay'])) ?? null,
          deviceActions
        };

        const script = asOptionalString(firstDefined(rawAction, ['mvarScript', 'Script']));
        if (script) {
          actionSummary.script = script;
        }
        const method = asOptionalString(firstDefined(rawAction, ['mvarMethod', 'Method']));
        if (method) {
          actionSummary.method = method;
        }
        const params = asOptionalString(firstDefined(rawAction, ['mvarParams', 'Params']));
        if (params) {
          actionSummary.params = params;
        }

        if (includeRaw) {
          actionSummary.raw = rawAction;
        }

        actions.push(actionSummary);
        actionCount += 1;
      }

      const result: Record<string, unknown> = {
        blockIndex,
        conditionCount: conditions.length,
        actionCount: actions.length,
        actions
      };

      if (includeRaw) {
        result.conditions = conditions;
        result.raw = block;
      }

      return result;
    }
  );

  return {
    blocks,
    actionRefs: Array.from(refs).sort((left, right) => left - right),
    conditionCount,
    actionCount
  };
}

async function readJsonFile(filePath: string, label: string): Promise<unknown> {
  try {
    const raw = await readFile(filePath, 'utf8');
    return JSON.parse(raw);
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new HS4McpError('UNKNOWN', `Failed to parse ${label} JSON file.`, {
        details: { filePath, cause: error.message }
      });
    }
    throw new HS4McpError('UNKNOWN', `Failed to read ${label} file.`, {
      details: {
        filePath,
        cause: error instanceof Error ? error.message : String(error)
      }
    });
  }
}

function valuesEqual(left: unknown, right: unknown): boolean {
  try {
    return JSON.stringify(left) === JSON.stringify(right);
  } catch {
    return Object.is(left, right);
  }
}

function computeObjectDiff(before: unknown, after: unknown): Record<string, unknown> | undefined {
  if (before === undefined || after === undefined) {
    return undefined;
  }

  if (!isRecord(before) || !isRecord(after)) {
    return valuesEqual(before, after) ? undefined : { changed: true };
  }

  const changedKeys = Array.from(new Set([...Object.keys(before), ...Object.keys(after)]))
    .filter((key) => !valuesEqual(before[key], after[key]))
    .sort();

  return changedKeys.length
    ? {
        changed: true,
        changedKeys
      }
    : undefined;
}

function parseAdminExecutionResult(raw: unknown, action: string): AdminExecutionResult {
  if (!isRecord(raw)) {
    return {
      result: 'applied',
      precheck: [],
      steps: [{ name: action, status: 'applied' }],
      rollback: 'not_needed',
      data: raw
    };
  }

  const parsedResult = typeof raw.result === 'string' && ADMIN_MUTATION_RESULTS.includes(raw.result as AdminMutationResult)
    ? (raw.result as AdminMutationResult)
    : 'applied';

  const precheck = Array.isArray(raw.precheck)
    ? raw.precheck.filter((item): item is AdminPrecheckItem => isRecord(item))
    : [];

  const steps = Array.isArray(raw.steps) && raw.steps.length
    ? raw.steps.filter((item): item is AdminStepItem => isRecord(item))
    : [{ name: action, status: parsedResult }];

  const rollback = typeof raw.rollback === 'string' && ADMIN_ROLLBACK_RESULTS.includes(raw.rollback as AdminRollbackResult)
    ? (raw.rollback as AdminRollbackResult)
    : 'not_needed';

  const hasBefore = Object.prototype.hasOwnProperty.call(raw, 'before');
  const hasAfter = Object.prototype.hasOwnProperty.call(raw, 'after');
  const hasDiff = Object.prototype.hasOwnProperty.call(raw, 'diff');
  const hasData = Object.prototype.hasOwnProperty.call(raw, 'data');

  const passthrough = { ...raw };
  delete passthrough.result;
  delete passthrough.precheck;
  delete passthrough.steps;
  delete passthrough.rollback;
  delete passthrough.before;
  delete passthrough.after;
  delete passthrough.diff;
  delete passthrough.data;

  return {
    result: parsedResult,
    precheck,
    steps: steps.length ? steps : [{ name: action, status: parsedResult }],
    rollback,
    before: hasBefore ? raw.before : undefined,
    after: hasAfter ? raw.after : undefined,
    diff: hasDiff ? raw.diff : undefined,
    data: hasData ? raw.data : Object.keys(passthrough).length ? passthrough : undefined
  };
}

function stripAdminGuardFields(args: Record<string, unknown>): Record<string, unknown> {
  const payload = { ...args };
  delete payload.confirm;
  delete payload.intent;
  delete payload.reason;
  delete payload.dryRun;
  delete payload.operationTier;
  delete payload.domain;
  delete payload.maintenanceWindowId;
  delete payload.changeTicket;
  delete payload.riskLevel;
  return payload;
}

function isAdminChangeTicketRequired(config: AppConfig): boolean {
  const dynamic = config as unknown as Record<string, unknown>;
  if (typeof dynamic.requireChangeTicket === 'boolean') {
    return dynamic.requireChangeTicket;
  }
  if (typeof dynamic.adminChangeTicketRequired === 'boolean') {
    return dynamic.adminChangeTicketRequired;
  }

  const env = process.env.HS4_ADMIN_REQUIRE_CHANGE_TICKET ?? process.env.HS4_REQUIRE_CHANGE_TICKET;
  if (!env) {
    return false;
  }
  const normalized = env.trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
}

function capabilitiesMatrixFromStatus(status: ReturnType<typeof normalizeStatusPayload>) {
  const matrix: Record<string, number[]> = {};
  for (const device of status.devices) {
    for (const capability of device.capabilities) {
      if (!matrix[capability]) {
        matrix[capability] = [];
      }
      matrix[capability]?.push(device.ref);
    }
  }
  return matrix;
}

export function buildMcpServer(deps: ServerDependencies): McpServer {
  const { config, client, policy, logger, audit } = deps;
  const aliasCatalog =
    deps.aliasCatalog ??
    new AliasCatalog({
      learnedEnabled: config.hs4AliasLearnedEnabled
    });
  const changeTokenStore =
    deps.changeTokenStore ??
    new ChangeTokenStore({
      ttlSec: config.hs4ChangeTokenTtlSec,
      maxEntries: config.hs4ChangeTokenMaxEntries,
      persistPath: config.hs4ChangeTokenPersistPath
    });

  const server = new McpServer(
    {
      name: 'mcp-hs4',
      version: '1.0.0',
      websiteUrl: 'https://docs.homeseer.com/hspi/json-api'
    },
    {
      capabilities: {
        logging: {}
      }
    }
  );

  const defaultMaxDevices = parseLimit(config.maxDevicesDefaultCap, 250, 20_000);
  const statusCacheTtlMs = Math.max(0, Math.floor(config.statusCacheTtlMs));
  const statusCache = new Map<string, { payload: unknown; expiresAt: number }>();
  const adminExecutionMode = config.hs4AdminExecutionMode;
  const adminDirectFallback = config.hs4AdminDirectFallback;
  const adminCapabilityCacheTtlMs = Math.max(0, Math.floor(config.hs4AdminCapabilityCacheTtlSec * 1000));
  const adminCapabilityCache = new Map<string, { supported: boolean; expiresAt: number }>();
  const adminChangeTicketRequired = isAdminChangeTicketRequired(config);
  let changeTokenStoreReady = false;

  function clearStatusCache(): void {
    statusCache.clear();
  }

  function buildAdminScriptCommand(domain: AdminDomain, action: string, payload: Record<string, unknown>): string {
    return `mcp_admin.${domain}.${action} ${JSON.stringify(payload)}`;
  }

  async function getStatusPayload(params: StatusQueryParams, options: { fresh?: boolean } = {}): Promise<unknown> {
    if (statusCacheTtlMs <= 0) {
      return client.getStatus(params);
    }

    const key = statusCacheKey(params);
    if (!options.fresh) {
      const now = Date.now();
      const cached = statusCache.get(key);
      if (cached && cached.expiresAt > now) {
        return cached.payload;
      }

      if (cached) {
        statusCache.delete(key);
      }
    }

    const payload = await client.getStatus(params);
    statusCache.set(key, {
      payload,
      expiresAt: Date.now() + statusCacheTtlMs
    });
    return payload;
  }

  async function getInterfaceSummary(): Promise<{
    generatedAt: string;
    totalInterfaces: number;
    interfaces: Array<{ interfaceName: string; deviceCount: number; refs: number[] }>;
  }> {
    const payload = await getStatusPayload({
      compress: true,
      everything: false,
      excludeevents: true
    });
    const snapshot = normalizeStatusPayload(payload);
    const grouped = new Map<string, Set<number>>();

    for (const device of snapshot.devices) {
      const key = device.interfaceName || 'unknown';
      if (!grouped.has(key)) {
        grouped.set(key, new Set());
      }
      grouped.get(key)?.add(device.ref);
    }

    const interfaces = Array.from(grouped.entries())
      .map(([interfaceName, refs]) => ({
        interfaceName,
        deviceCount: refs.size,
        refs: Array.from(refs).sort((a, b) => a - b)
      }))
      .sort((left, right) => left.interfaceName.localeCompare(right.interfaceName));

    return {
      generatedAt: new Date().toISOString(),
      totalInterfaces: interfaces.length,
      interfaces
    };
  }

  async function getCategorySummary(): Promise<{
    generatedAt: string;
    categories: Array<{ category: string; rooms: string[]; refs: number[] }>;
  }> {
    const payload = await getStatusPayload({
      compress: true,
      everything: false,
      excludeevents: true
    });
    const snapshot = normalizeStatusPayload(payload);
    const grouped = new Map<string, { rooms: Set<string>; refs: Set<number> }>();

    for (const device of snapshot.devices) {
      const category = device.location || 'Uncategorized';
      if (!grouped.has(category)) {
        grouped.set(category, { rooms: new Set<string>(), refs: new Set<number>() });
      }
      const bucket = grouped.get(category);
      bucket?.rooms.add(device.location2 || 'Unassigned');
      bucket?.refs.add(device.ref);
    }

    const categories = Array.from(grouped.entries())
      .map(([category, value]) => ({
        category,
        rooms: Array.from(value.rooms).sort((a, b) => a.localeCompare(b)),
        refs: Array.from(value.refs).sort((a, b) => a - b)
      }))
      .sort((left, right) => left.category.localeCompare(right.category));

    return {
      generatedAt: new Date().toISOString(),
      categories
    };
  }

  const deviceNameByRef = new Map<number, string>();
  const deviceResolutionMetaByRef = new Map<number, DeviceResolutionMeta>();
  const eventById = new Map<number, { id: number; group: string; name: string }>();
  const cameraNameById = new Map<number, string>();

  async function ensureChangeTokenStoreInitialized(): Promise<void> {
    if (changeTokenStoreReady) {
      return;
    }
    await changeTokenStore.init();
    changeTokenStoreReady = true;
  }

  function adminCapabilityKey(domain: AdminDomain, action: string): string {
    return `${domain}:${action}`;
  }

  function isLikelyWrapperDevice(meta: DeviceResolutionMeta): boolean {
    const normalizedName = meta.name.trim().toLowerCase();
    if (normalizedName.includes(' master') || normalizedName.endsWith(' master')) {
      return true;
    }
    if (normalizedName.includes(' scene') || normalizedName.endsWith(' scene')) {
      return true;
    }
    if (meta.relationship === '2' && meta.controlPairCount === 0 && meta.parentRef === undefined) {
      return true;
    }
    return false;
  }

  function deviceActionabilityRank(meta: DeviceResolutionMeta | undefined, options: { preferWrapper: boolean }): number {
    if (!meta) {
      return 0;
    }
    let rank = 0;
    if (meta.relationship === '4' || meta.parentRef !== undefined) {
      rank += 3;
    }
    if (meta.controlPairCount > 0) {
      rank += 3;
    }
    if (meta.capabilities.includes('on_off') || meta.capabilities.includes('dimmer')) {
      rank += 2;
    }
    if (!options.preferWrapper && isLikelyWrapperDevice(meta)) {
      rank -= 4;
    }
    return rank;
  }

  function shouldPreferWrapperFromQuery(query: string): boolean {
    const normalized = normalizeAliasText(query);
    if (!normalized) {
      return false;
    }
    const tokens = normalized.split(' ').filter(Boolean);
    return tokens.includes('master') || tokens.includes('scene') || tokens.includes('parent') || tokens.includes('root');
  }

  function rerankDeviceAliasMatches(matches: AliasLookupResult[], query: string): AliasLookupResult[] {
    if (matches.length <= 1) {
      return matches;
    }
    const preferWrapper = shouldPreferWrapperFromQuery(query);
    return [...matches].sort((left, right) => {
      const scoreDelta = Math.abs(left.score - right.score);
      if (scoreDelta > 0.12) {
        return right.score - left.score;
      }

      const leftRank = deviceActionabilityRank(deviceResolutionMetaByRef.get(left.targetId), { preferWrapper });
      const rightRank = deviceActionabilityRank(deviceResolutionMetaByRef.get(right.targetId), { preferWrapper });
      if (leftRank !== rightRank) {
        return rightRank - leftRank;
      }
      if (left.score !== right.score) {
        return right.score - left.score;
      }
      if (left.provenance !== right.provenance) {
        return left.provenance === 'config' ? -1 : 1;
      }
      if (left.targetId !== right.targetId) {
        return left.targetId - right.targetId;
      }
      return left.canonicalName.localeCompare(right.canonicalName);
    });
  }

  function buildDeviceIntentWarnings(matches: AliasLookupResult[], query: string): Array<Record<string, unknown>> {
    if (!matches.length) {
      return [];
    }
    const chosen = matches[0]!;
    const chosenMeta = deviceResolutionMetaByRef.get(chosen.targetId);
    if (!chosenMeta || !isLikelyWrapperDevice(chosenMeta)) {
      return [];
    }

    const alternate = matches
      .slice(1)
      .find((match) => {
        const meta = deviceResolutionMetaByRef.get(match.targetId);
        return Boolean(
          meta &&
            !isLikelyWrapperDevice(meta) &&
            deviceActionabilityRank(meta, { preferWrapper: false }) >
              deviceActionabilityRank(chosenMeta, { preferWrapper: false })
        );
      });

    if (!alternate) {
      return [];
    }

    const alternateMeta = deviceResolutionMetaByRef.get(alternate.targetId);
    return [
      {
        code: 'PARENT_OR_WRAPPER_TARGET',
        message:
          `Query "${query}" resolved to wrapper/master device ref ${chosen.targetId} ` +
          `("${chosenMeta.name}"). Consider endpoint ref ${alternate.targetId} ` +
          `("${alternateMeta?.name ?? alternate.canonicalName}") for direct control.`,
        resolvedRef: chosen.targetId,
        suggestedRef: alternate.targetId
      }
    ];
  }

  function readAdminCapability(key: string): boolean | undefined {
    if (adminCapabilityCacheTtlMs <= 0) {
      return undefined;
    }
    const cached = adminCapabilityCache.get(key);
    if (!cached) {
      return undefined;
    }
    if (cached.expiresAt <= Date.now()) {
      adminCapabilityCache.delete(key);
      return undefined;
    }
    return cached.supported;
  }

  function writeAdminCapability(key: string, supported: boolean): void {
    if (adminCapabilityCacheTtlMs <= 0) {
      return;
    }
    adminCapabilityCache.set(key, {
      supported,
      expiresAt: Date.now() + adminCapabilityCacheTtlMs
    });
  }

  function asPayloadObject(value: unknown, context: string): Record<string, unknown> {
    if (!isRecord(value)) {
      throw new HS4McpError('BAD_REQUEST', `${context} must be an object payload.`);
    }
    return value;
  }

  function requiredPayloadString(payload: Record<string, unknown>, key: string, context: string): string {
    const raw = payload[key];
    if (typeof raw === 'string' && raw.trim()) {
      return raw.trim();
    }
    if (typeof raw === 'number' && Number.isFinite(raw)) {
      return String(raw);
    }
    throw new HS4McpError('BAD_REQUEST', `${context} requires '${key}'.`);
  }

  function requiredPayloadNumber(payload: Record<string, unknown>, key: string, context: string): number {
    const raw = payload[key];
    if (typeof raw === 'number' && Number.isFinite(raw)) {
      return raw;
    }
    throw new HS4McpError('BAD_REQUEST', `${context} requires numeric '${key}'.`);
  }

  function readString(input: Record<string, unknown>, key: string): string | undefined {
    const raw = input[key];
    return typeof raw === 'string' && raw.trim() ? raw : undefined;
  }

  function readNumber(input: Record<string, unknown>, key: string): number | undefined {
    const raw = input[key];
    return typeof raw === 'number' && Number.isFinite(raw) ? raw : undefined;
  }

  function readBoolean(input: Record<string, unknown>, key: string): boolean | undefined {
    const raw = input[key];
    return typeof raw === 'boolean' ? raw : undefined;
  }

  function parseSupportedPrepareToolName(raw: string): SupportedPrepareToolName | null {
    const toolName = raw.trim();
    if (!toolName.startsWith('hs4.')) {
      return null;
    }
    const coreMutatingTools: Set<string> = new Set([
      'hs4.devices.set',
      'hs4.events.run',
      'hs4.scripts.run',
      'hs4.plugins.function.call',
      'hs4.cameras.pan'
    ]);

    if (coreMutatingTools.has(toolName)) {
      return toolName as SupportedPrepareToolName;
    }

    if (toolName.startsWith('hs4.admin.')) {
      const detail = parseAdminMutationDetail(toolName);
      if (detail) {
        return toolName as SupportedPrepareToolName;
      }
    }

    return null;
  }

  function parseAdminMutationDetail(toolName: string): { domain: AdminDomain; action: string } | null {
    if (!toolName.startsWith('hs4.admin.')) {
      return null;
    }
    const tail = toolName.replace(/^hs4\.admin\./, '');
    const [domainRaw, ...actionParts] = tail.split('.');
    if (!domainRaw || actionParts.length === 0) {
      return null;
    }
    const domain = domainRaw as AdminDomain;
    if (!ADMIN_DOMAINS.includes(domain)) {
      return null;
    }
    const action = actionParts.join('.');
    if (!action || ADMIN_READ_ACTIONS.has(`${domain}.${action}`)) {
      return null;
    }
    return { domain, action };
  }

  function normalizeGuardArgs(args: Record<string, unknown>, options: { forceDryRun?: boolean }): MutationGuardLike {
    const normalized: MutationGuardLike = {
      confirm: readBoolean(args, 'confirm'),
      intent: readString(args, 'intent'),
      reason: readString(args, 'reason'),
      dryRun: options.forceDryRun === true ? true : readBoolean(args, 'dryRun')
    };

    if (readString(args, 'operationTier') === 'admin') {
      normalized.operationTier = 'admin';
    } else if (readString(args, 'operationTier') === 'operator') {
      normalized.operationTier = 'operator';
    }

    const domain = readString(args, 'domain');
    if (domain && ADMIN_DOMAINS.includes(domain as AdminDomain)) {
      normalized.domain = domain as AdminDomain;
    }

    const maintenanceWindowId = readString(args, 'maintenanceWindowId');
    if (maintenanceWindowId) {
      normalized.maintenanceWindowId = maintenanceWindowId;
    }

    const changeTicket = readString(args, 'changeTicket');
    if (changeTicket) {
      normalized.changeTicket = changeTicket;
    }

    const riskLevel = readString(args, 'riskLevel');
    if (riskLevel && ADMIN_RISK_LEVELS.includes(riskLevel as AdminRiskLevel)) {
      normalized.riskLevel = riskLevel as AdminRiskLevel;
    }

    return normalized;
  }

  function buildMutationTarget(toolName: SupportedPrepareToolName, args: Record<string, unknown>): MutationPlanTarget {
    return {
      toolName,
      ...(readNumber(args, 'ref') !== undefined ? { ref: readNumber(args, 'ref') } : {}),
      ...(readNumber(args, 'camId') !== undefined ? { camId: readNumber(args, 'camId') } : {}),
      ...(readNumber(args, 'id') !== undefined ? { id: readNumber(args, 'id') } : {}),
      ...(readString(args, 'group') ? { group: readString(args, 'group') } : {}),
      ...(readString(args, 'name') ? { name: readString(args, 'name') } : {}),
      ...(readString(args, 'command') ? { command: readString(args, 'command') } : {}),
      ...(readString(args, 'plugin') ? { plugin: readString(args, 'plugin') } : {}),
      ...(readString(args, 'functionName') ? { functionName: readString(args, 'functionName') } : {})
    };
  }

  function buildMutationPolicyInput(
    toolName: SupportedPrepareToolName,
    args: Record<string, unknown>,
    options: { forceDryRun?: boolean }
  ): Parameters<PolicyEngine['evaluateMutation']>[0] {
    const guard = normalizeGuardArgs(args, options);
    const base: Parameters<PolicyEngine['evaluateMutation']>[0] = {
      tool: toolName,
      action: `prepare:${toolName}`,
      confirm: guard.confirm,
      intent: guard.intent,
      reason: guard.reason,
      dryRun: guard.dryRun
    };

    if (toolName === 'hs4.devices.set') {
      const ref = readNumber(args, 'ref');
      return {
        ...base,
        targetRefs: Number.isFinite(ref) ? [ref as number] : []
      };
    }

    if (toolName === 'hs4.events.run') {
      const id = readNumber(args, 'id');
      return {
        ...base,
        eventIds: Number.isFinite(id) ? [id as number] : []
      };
    }

    if (toolName === 'hs4.scripts.run') {
      return {
        ...base,
        scriptCommand: readString(args, 'command')
      };
    }

    if (toolName === 'hs4.plugins.function.call') {
      const plugin = readString(args, 'plugin');
      const functionName = readString(args, 'functionName');
      return {
        ...base,
        pluginFunction: plugin && functionName ? `${plugin}:${functionName}`.toLowerCase() : undefined
      };
    }

    if (toolName === 'hs4.cameras.pan') {
      const camId = readNumber(args, 'camId');
      return {
        ...base,
        cameraIds: Number.isFinite(camId) ? [camId as number] : []
      };
    }

    const adminDetail = parseAdminMutationDetail(toolName);
    if (adminDetail) {
      const userId = readString(args, 'userId');
      const pluginId = readString(args, 'pluginId');
      const interfaceId = readString(args, 'interfaceId');
      const category = readString(args, 'category');
      return {
        ...base,
        action: `prepare:${adminDetail.action}`,
        operationTier: guard.operationTier ?? 'admin',
        domain: adminDetail.domain,
        maintenanceWindowId: guard.maintenanceWindowId,
        changeTicket: guard.changeTicket,
        userIds: userId ? [userId] : [],
        pluginIds: pluginId ? [pluginId] : [],
        interfaceIds: interfaceId ? [interfaceId] : [],
        categoryIds: category ? [category] : []
      };
    }

    return base;
  }

  async function refreshAliasCatalog(): Promise<{
    generatedAt: string;
    totalDevices: number;
    totalEvents: number;
    totalCameras: number;
    warnings?: Array<Record<string, unknown>>;
  }> {
    const warnings: Array<Record<string, unknown>> = [];

    let totalDevices = 0;
    try {
      const statusPayload = await getStatusPayload({
        compress: true,
        everything: false,
        excludeevents: true
      });
      const snapshot = normalizeStatusPayload(statusPayload);
      totalDevices = snapshot.devices.length;
      deviceNameByRef.clear();
      deviceResolutionMetaByRef.clear();
      for (const device of snapshot.devices) {
        deviceNameByRef.set(device.ref, device.name);
        deviceResolutionMetaByRef.set(device.ref, {
          ref: device.ref,
          name: device.name,
          location: device.location,
          location2: device.location2,
          relationship: device.relationship,
          parentRef: device.parentRef,
          controlPairCount: device.controlPairs.length,
          capabilities: [...device.capabilities]
        });
      }
      aliasCatalog.ingestDevices(
        snapshot.devices.map((device) => ({
          ref: device.ref,
          name: device.name,
          location: device.location,
          location2: device.location2
        }))
      );
    } catch (error) {
      const mapped = asHS4McpError(error);
      warnings.push({
        source: 'devices',
        code: mapped.code,
        message: mapped.message
      });
    }

    let totalEvents = 0;
    try {
      const eventsPayload = await client.getEvents();
      const events = normalizeEventsPayload(eventsPayload);
      totalEvents = events.length;
      eventById.clear();
      for (const event of events) {
        eventById.set(event.id, {
          id: event.id,
          group: event.group,
          name: event.name
        });
      }
      aliasCatalog.ingestEvents(events.map((event) => ({ id: event.id, group: event.group, name: event.name })));
    } catch (error) {
      const mapped = asHS4McpError(error);
      warnings.push({
        source: 'events',
        code: mapped.code,
        message: mapped.message
      });
    }

    let totalCameras = 0;
    try {
      const cameraPayload = await client.getCameras();
      const cameras = normalizeCamerasPayload(cameraPayload);
      totalCameras = cameras.length;
      cameraNameById.clear();
      for (const camera of cameras) {
        cameraNameById.set(camera.camId, camera.name);
      }
      aliasCatalog.ingestCameras(cameras.map((camera) => ({ id: camera.camId, name: camera.name })));
    } catch (error) {
      const mapped = asHS4McpError(error);
      warnings.push({
        source: 'cameras',
        code: mapped.code,
        message: mapped.message
      });
    }

    if (totalDevices === 0 && totalEvents === 0 && totalCameras === 0 && warnings.length) {
      throw new HS4McpError('HS4_ERROR', 'Unable to refresh alias catalog from HS4.', {
        details: { warnings }
      });
    }

    return {
      generatedAt: new Date().toISOString(),
      totalDevices,
      totalEvents,
      totalCameras,
      ...(warnings.length ? { warnings } : {})
    };
  }

  interface DeviceVerificationObserved {
    ref: number;
    name: string;
    status: string;
    value: number | null;
    controlPairs: Array<{ label: string; value: number }>;
  }

  interface DeviceVerificationChecks {
    deviceFound: boolean;
    valueMatch?: boolean;
    statusMatch?: boolean;
    matchedByControlPairLabel?: string;
  }

  interface DeviceVerificationResult {
    matched: boolean;
    attempts: number;
    expected: {
      value?: number;
      statusText?: string;
    };
    observed?: DeviceVerificationObserved;
    checks: DeviceVerificationChecks;
  }

  function normalizeStatusToken(value: string | undefined): string | undefined {
    if (!value) {
      return undefined;
    }
    const normalized = value.trim().toLowerCase();
    return normalized || undefined;
  }

  function statusTextMatches(actual: string, expected: string): boolean {
    const left = normalizeStatusToken(actual);
    const right = normalizeStatusToken(expected);
    if (!left || !right) {
      return false;
    }
    return left === right || left.includes(right) || right.includes(left);
  }

  function numericMatch(actual: number | null | undefined, expected: number): boolean {
    return typeof actual === 'number' && Number.isFinite(actual) && Math.abs(actual - expected) < 0.000001;
  }

  function summarizeDeviceForVerification(device: NormalizedDevice): DeviceVerificationObserved {
    return {
      ref: device.ref,
      name: device.name,
      status: device.status,
      value: device.value,
      controlPairs: device.controlPairs.slice(0, 32).map((pair) => ({
        label: pair.label,
        value: pair.value
      }))
    };
  }

  function findControlPairByValue(
    device: NormalizedDevice | DeviceVerificationObserved | undefined,
    value: number
  ): { label: string; value: number } | undefined {
    if (!device) {
      return undefined;
    }
    return device.controlPairs.find((pair) => numericMatch(pair.value, value));
  }

  async function getDeviceForVerification(ref: number): Promise<NormalizedDevice | undefined> {
    const payload = await getStatusPayload(
      {
        ref: String(ref),
        compress: false,
        everything: false,
        excludeevents: true
      },
      {
        fresh: true
      }
    );
    const snapshot = normalizeStatusPayload(payload);
    return snapshot.devices.find((device) => device.ref === ref);
  }

  function evaluateDeviceMatch(
    device: NormalizedDevice,
    expected: {
      value?: number;
      statusText?: string;
    }
  ): {
    matched: boolean;
    checks: DeviceVerificationChecks;
  } {
    const checks: DeviceVerificationChecks = {
      deviceFound: true
    };

    const expectedValue = expected.value;
    if (Number.isFinite(expectedValue)) {
      const pair = findControlPairByValue(device, expectedValue as number);
      const directMatch = numericMatch(device.value, expectedValue as number);
      const pairStatusMatch = pair ? statusTextMatches(device.status, pair.label) : false;
      checks.valueMatch = directMatch || pairStatusMatch;
      if (pairStatusMatch && pair) {
        checks.matchedByControlPairLabel = pair.label;
      }
    }

    if (expected.statusText) {
      checks.statusMatch = statusTextMatches(device.status, expected.statusText);
    }

    const valueMatchDefined = typeof checks.valueMatch === 'boolean';
    const statusMatchDefined = typeof checks.statusMatch === 'boolean';

    if (valueMatchDefined && statusMatchDefined) {
      return {
        matched: Boolean(checks.valueMatch || checks.statusMatch),
        checks
      };
    }

    if (valueMatchDefined) {
      return {
        matched: Boolean(checks.valueMatch),
        checks
      };
    }

    if (statusMatchDefined) {
      return {
        matched: Boolean(checks.statusMatch),
        checks
      };
    }

    return {
      matched: true,
      checks
    };
  }

  async function verifyDeviceWrite(
    ref: number,
    expected: {
      value?: number;
      statusText?: string;
    },
    options: {
      attempts?: number;
      delayMs?: number;
    } = {}
  ): Promise<DeviceVerificationResult> {
    const attempts = parseLimit(options.attempts, 4, 8);
    const delayMs = Math.max(0, Math.floor(options.delayMs ?? 250));
    let lastObserved: DeviceVerificationObserved | undefined;
    let lastChecks: DeviceVerificationChecks = {
      deviceFound: false
    };

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const device = await getDeviceForVerification(ref);
      if (device) {
        lastObserved = summarizeDeviceForVerification(device);
        const evaluated = evaluateDeviceMatch(device, expected);
        lastChecks = evaluated.checks;
        if (evaluated.matched) {
          return {
            matched: true,
            attempts: attempt,
            expected,
            observed: lastObserved,
            checks: evaluated.checks
          };
        }
      } else {
        lastChecks = {
          deviceFound: false
        };
      }

      if (attempt < attempts && delayMs > 0) {
        await delay(delayMs);
      }
    }

    return {
      matched: false,
      attempts,
      expected,
      ...(lastObserved ? { observed: lastObserved } : {}),
      checks: lastChecks
    };
  }

  async function executeDeviceSetMutation(args: DeviceSetExecutionArgs): Promise<Record<string, unknown>> {
    const hasValue = Number.isFinite(args.value);
    const normalizedStatusText = typeof args.statusText === 'string' ? args.statusText.trim() : undefined;
    const hasStatusText = Boolean(normalizedStatusText);
    const verify = args.verify !== false;

    if (args.mode === 'control_value' && !hasValue) {
      throw new HS4McpError('BAD_REQUEST', 'value is required when mode=control_value');
    }
    if (args.mode === 'set_status' && !hasValue && !hasStatusText) {
      throw new HS4McpError('BAD_REQUEST', 'value or statusText is required when mode=set_status');
    }

    let executedMode: DeviceSetMode = args.mode;
    let modeSwitchReason: string | undefined;
    let preflightDevice: NormalizedDevice | undefined;

    if (args.mode === 'set_status' && hasValue) {
      try {
        preflightDevice = await getDeviceForVerification(args.ref);
        const pair = findControlPairByValue(preflightDevice, args.value as number);
        if (pair) {
          executedMode = 'control_value';
          modeSwitchReason =
            `Requested mode=set_status but device control pair "${pair.label}" maps to value ${pair.value}; ` +
            'executed mode=control_value for reliability.';
        }
      } catch (error) {
        logger.debug(
          {
            ref: args.ref,
            requestedMode: args.mode,
            value: args.value,
            error: String(error)
          },
          'Device preflight failed; proceeding without mode auto-switch'
        );
      }
    }

    let raw: unknown;
    if (executedMode === 'control_value') {
      raw = await client.controlDeviceByValue({
        ref: args.ref,
        value: args.value as number
      });
    } else {
      raw = await client.setDeviceStatus({
        ref: args.ref,
        value: args.value,
        string: normalizedStatusText,
        source: args.source
      });
    }

    if (!verify) {
      return {
        applied: true,
        ref: args.ref,
        mode: executedMode,
        requestedMode: args.mode,
        ...(hasValue ? { value: args.value } : {}),
        ...(hasStatusText ? { statusText: normalizedStatusText } : {}),
        ...(args.source ? { source: args.source } : {}),
        ...(modeSwitchReason ? { modeAutoSwitch: modeSwitchReason } : {}),
        raw,
        verification: {
          performed: false
        }
      };
    }

    const expected = {
      ...(hasValue ? { value: args.value as number } : {}),
      ...(hasStatusText ? { statusText: normalizedStatusText as string } : {})
    };

    let verification = await verifyDeviceWrite(args.ref, expected);
    let fallback: Record<string, unknown> | undefined;
    if (!verification.matched && args.mode === 'set_status' && executedMode === 'set_status' && hasValue) {
      const discoveredPair =
        findControlPairByValue(preflightDevice, args.value as number) ??
        findControlPairByValue(verification.observed, args.value as number);

      if (discoveredPair) {
        const fallbackRaw = await client.controlDeviceByValue({
          ref: args.ref,
          value: args.value as number
        });
        verification = await verifyDeviceWrite(args.ref, expected);
        fallback = {
          attempted: true,
          mode: 'control_value',
          value: args.value,
          trigger: 'set_status verification mismatch',
          matched: verification.matched,
          raw: fallbackRaw
        };
      } else {
        fallback = {
          attempted: false,
          trigger: 'set_status verification mismatch',
          reason: 'No matching control pair discovered for requested value.'
        };
      }
    }

    if (!verification.matched) {
      throw new HS4McpError('HS4_ERROR', 'Device state did not converge to the requested target.', {
        details: {
          ref: args.ref,
          requestedMode: args.mode,
          executedMode,
          expected,
          verification,
          ...(fallback ? { fallback } : {})
        }
      });
    }

    return {
      applied: true,
      ref: args.ref,
      mode: executedMode,
      requestedMode: args.mode,
      ...(hasValue ? { value: args.value } : {}),
      ...(hasStatusText ? { statusText: normalizedStatusText } : {}),
      ...(args.source ? { source: args.source } : {}),
      ...(modeSwitchReason ? { modeAutoSwitch: modeSwitchReason } : {}),
      raw,
      verification,
      ...(fallback ? { fallback } : {})
    };
  }

  async function prepareMutation(
    toolName: SupportedPrepareToolName,
    args: Record<string, unknown>,
    summary: Record<string, unknown>
  ): Promise<ReturnType<typeof successResult> | ReturnType<typeof errorResult>> {
    await ensureChangeTokenStoreInitialized();

    const target = buildMutationTarget(toolName, args);
    const policyInput = buildMutationPolicyInput(toolName, args, { forceDryRun: true });
    const decision = policy.evaluateMutation(policyInput);
    const reasons = [...decision.reasons];
    if (!decision.allowed) {
      await audit.record({
        tool: 'hs4.change.prepare',
        action: 'prepare_mutation',
        result: 'blocked',
        dryRun: true,
        errorCode: 'POLICY_DENY',
        message: reasons.join(' '),
        target,
        details: {
          toolName,
          policy: decision.normalized
        }
      });
      return errorResult('POLICY_DENY', 'Prepared change blocked by policy.', { reasons, toolName, target });
    }

    const preparedAudit = await audit.record({
      tool: 'hs4.change.prepare',
      action: 'prepare_mutation',
      result: 'dry_run',
      dryRun: true,
      target,
      details: {
        toolName,
        summary,
        policy: decision.normalized
      }
    });

    const record = await changeTokenStore.create({
      toolName,
      args,
      summary,
      preparedAuditRef: preparedAudit.id
    });

    const data: MutationPrepareResult = {
      prepared: true,
      token: record.token,
      toolName,
      expiresAt: record.expiresAt,
      summary,
      policy: {
        reasons: decision.reasons,
        normalized: decision.normalized
      },
      target
    };
    return successResult({
      ...data,
      preparedAuditRef: preparedAudit.id
    });
  }

  async function executePreparedMutation(
    toolName: SupportedPrepareToolName,
    args: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    if (toolName === 'hs4.devices.set') {
      const ref = readNumber(args, 'ref');
      const modeRaw = readString(args, 'mode') ?? 'control_value';
      const value = readNumber(args, 'value');
      const statusText = readString(args, 'statusText');
      const source = readString(args, 'source');
      const verify = readBoolean(args, 'verify');
      if (!Number.isFinite(ref)) {
        throw new HS4McpError('BAD_REQUEST', 'ref is required for hs4.devices.set');
      }

      if (modeRaw !== 'control_value' && modeRaw !== 'set_status') {
        throw new HS4McpError('BAD_REQUEST', 'mode must be one of: control_value, set_status');
      }

      const execution = await executeDeviceSetMutation({
        ref: ref as number,
        mode: modeRaw,
        value,
        statusText,
        source,
        verify
      });
      return {
        toolName,
        ...execution
      };
    }

    if (toolName === 'hs4.events.run') {
      const id = readNumber(args, 'id');
      const group = readString(args, 'group');
      const name = readString(args, 'name');
      if (!Number.isFinite(id) && !(group && name)) {
        throw new HS4McpError('BAD_REQUEST', 'Provide id, or provide both group and name.');
      }
      const raw = await client.runEvent({
        id,
        group,
        name
      });
      return { invoked: true, toolName, id, group, name, raw };
    }

    if (toolName === 'hs4.scripts.run') {
      const command = readString(args, 'command');
      if (!command) {
        throw new HS4McpError('BAD_REQUEST', 'command is required for hs4.scripts.run');
      }
      const raw = await client.runScriptCommand(command);
      return { invoked: true, toolName, command, raw };
    }

    if (toolName === 'hs4.plugins.function.call') {
      const plugin = readString(args, 'plugin');
      const functionName = readString(args, 'functionName');
      const instance = readString(args, 'instance');
      const paramsRaw = args.params;
      const params = Array.isArray(paramsRaw)
        ? paramsRaw.filter(
            (item): item is string | number | boolean =>
              typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean'
          )
        : [];
      if (!plugin || !functionName) {
        throw new HS4McpError('BAD_REQUEST', 'plugin and functionName are required for hs4.plugins.function.call');
      }
      const raw = await client.pluginFunction({
        plugin,
        functionName,
        instance,
        params
      });
      return { invoked: true, toolName, plugin, functionName, instance, params, raw };
    }

    if (toolName === 'hs4.cameras.pan') {
      const camId = readNumber(args, 'camId');
      const direction = readString(args, 'direction');
      if (!Number.isFinite(camId) || !direction) {
        throw new HS4McpError('BAD_REQUEST', 'camId and direction are required for hs4.cameras.pan');
      }
      const raw = await client.panCamera({
        camId: camId as number,
        direction: direction as Parameters<HS4Client['panCamera']>[0]['direction']
      });
      return { applied: true, toolName, camId, direction, raw };
    }

    const adminDetail = parseAdminMutationDetail(toolName);
    if (adminDetail) {
      const payload = stripAdminGuardFields(args);
      const execution = await executeAdminScriptMutation({
        domain: adminDetail.domain,
        action: adminDetail.action,
        payload
      });
      return {
        toolName,
        result: execution.result,
        steps: execution.steps,
        rollback: execution.rollback,
        data: execution.data
      };
    }

    throw new HS4McpError('BAD_REQUEST', `Unsupported tool for prepared execution: ${toolName}`);
  }

  async function commitPreparedChange(
    token: string
  ): Promise<ReturnType<typeof successResult> | ReturnType<typeof errorResult>> {
    await ensureChangeTokenStoreInitialized();
    const record = changeTokenStore.get(token);
    if (!record) {
      return errorResult('NOT_FOUND', 'Prepared change token was not found or has expired.', {
        token
      });
    }

    if (record.committedAt) {
      return errorResult('BAD_REQUEST', 'Prepared change token has already been committed.', {
        token,
        committedAt: record.committedAt
      });
    }

    const toolName = parseSupportedPrepareToolName(record.toolName);
    if (!toolName) {
      return errorResult('BAD_REQUEST', 'Prepared change references an unsupported tool.', {
        toolName: record.toolName
      });
    }

    const commitArgs: Record<string, unknown> = {
      ...record.args,
      dryRun: false
    };
    const target = buildMutationTarget(toolName, commitArgs);
    const policyInput = buildMutationPolicyInput(toolName, commitArgs, { forceDryRun: false });
    const decision = policy.evaluateMutation(policyInput);

    if (!decision.allowed) {
      await audit.record({
        tool: 'hs4.change.commit',
        action: 'commit_prepared_mutation',
        result: 'blocked',
        dryRun: false,
        errorCode: 'POLICY_DENY',
        message: decision.reasons.join(' '),
        target,
        details: {
          token,
          toolName,
          preparedAuditRef: record.preparedAuditRef
        }
      });
      return errorResult('POLICY_DENY', 'Prepared change commit blocked by policy.', {
        token,
        toolName,
        reasons: decision.reasons
      });
    }

    const started = Date.now();
    try {
      const execution = await executePreparedMutation(toolName, commitArgs);
      const commitAudit = await audit.record({
        tool: 'hs4.change.commit',
        action: 'commit_prepared_mutation',
        result: 'success',
        dryRun: false,
        durationMs: Date.now() - started,
        target,
        details: {
          token,
          toolName,
          preparedAuditRef: record.preparedAuditRef,
          summary: record.summary
        }
      });
      await changeTokenStore.markCommitted(token, commitAudit.id);
      clearStatusCache();

      return successResult({
        committed: true,
        token,
        toolName,
        preparedAuditRef: record.preparedAuditRef,
        commitAuditRef: commitAudit.id,
        summary: record.summary,
        data: execution
      });
    } catch (error) {
      const mapped = asHS4McpError(error);
      await audit.record({
        tool: 'hs4.change.commit',
        action: 'commit_prepared_mutation',
        result: 'error',
        dryRun: false,
        durationMs: Date.now() - started,
        errorCode: mapped.code,
        message: mapped.message,
        target,
        details: {
          token,
          toolName,
          preparedAuditRef: record.preparedAuditRef,
          summary: record.summary
        }
      });
      return errorResult(mapped.code, mapped.message, mapped.details);
    }
  }

  async function auditRead<T>(tool: string, action: string, details: Record<string, unknown>, fn: () => Promise<T>) {
    const started = Date.now();
    try {
      const data = await fn();
      await audit.record({
        tool,
        action,
        result: 'success',
        dryRun: false,
        durationMs: Date.now() - started,
        details
      });
      return successResult(data);
    } catch (error) {
      const mapped = asHS4McpError(error);
      await audit.record({
        tool,
        action,
        result: 'error',
        dryRun: false,
        durationMs: Date.now() - started,
        errorCode: mapped.code,
        message: mapped.message,
        details
      });
      return errorResult(mapped.code, mapped.message, mapped.details);
    }
  }

  async function auditMutation<T>(options: {
    tool: string;
    action: string;
    guard: GuardArgs;
    target?: Record<string, unknown>;
    policyInput: {
      targetRefs?: number[];
      eventIds?: number[];
      cameraIds?: number[];
      scriptCommand?: string;
      pluginFunction?: string;
      targetIds?: Array<string | number>;
      operationTier?: AdminOperationTier;
      domain?: AdminDomain;
      maintenanceWindowId?: string;
      changeTicket?: string;
      riskLevel?: AdminRiskLevel;
    };
    adminMutation?: {
      enabled: boolean;
      requireChangeTicket: boolean;
    };
    execute: () => Promise<T>;
  }) {
    const started = Date.now();
    const isAdminMutation = options.adminMutation?.enabled === true;
    const adminGuard = isAdminMutation ? (options.guard as AdminGuardArgs) : undefined;

    const policyRequest = {
      tool: options.tool,
      action: options.action,
      confirm: options.guard.confirm,
      intent: options.guard.intent,
      reason: options.guard.reason,
      dryRun: options.guard.dryRun,
      targetRefs: options.policyInput.targetRefs,
      eventIds: options.policyInput.eventIds,
      cameraIds: options.policyInput.cameraIds,
      scriptCommand: options.policyInput.scriptCommand,
      pluginFunction: options.policyInput.pluginFunction,
      targetIds: options.policyInput.targetIds,
      operationTier: options.policyInput.operationTier ?? adminGuard?.operationTier,
      domain: options.policyInput.domain ?? adminGuard?.domain,
      maintenanceWindowId: options.policyInput.maintenanceWindowId ?? adminGuard?.maintenanceWindowId,
      changeTicket: options.policyInput.changeTicket ?? adminGuard?.changeTicket,
      riskLevel: options.policyInput.riskLevel ?? adminGuard?.riskLevel
    };

    const decision = policy.evaluateMutation(
      policyRequest as Parameters<PolicyEngine['evaluateMutation']>[0]
    );

    const precheck: AdminPrecheckItem[] = [];
    const reasons = [...decision.reasons];
    const effectiveDryRun = decision.effectiveDryRun;

    if (isAdminMutation && adminGuard) {
      precheck.push({
        check: 'policy',
        status: decision.allowed ? 'pass' : 'fail',
        reasons: decision.reasons,
        effectiveDryRun
      });

      const maintenanceWindowPresent = Boolean(adminGuard.maintenanceWindowId?.trim());
      const maintenanceWindowRequired = !effectiveDryRun;
      const maintenanceWindowOk = !maintenanceWindowRequired || maintenanceWindowPresent;
      precheck.push({
        check: 'maintenance_window',
        status: maintenanceWindowOk ? 'pass' : 'fail',
        required: maintenanceWindowRequired,
        maintenanceWindowId: adminGuard.maintenanceWindowId ?? null
      });
      if (!maintenanceWindowOk) {
        reasons.push('Admin mutations require maintenanceWindowId when dryRun=false.');
      }

      const changeTicketRequired = Boolean(options.adminMutation?.requireChangeTicket) && !effectiveDryRun;
      const changeTicketPresent = Boolean(adminGuard.changeTicket?.trim());
      const changeTicketOk = !changeTicketRequired || changeTicketPresent;
      precheck.push({
        check: 'change_ticket',
        status: changeTicketOk ? 'pass' : 'fail',
        required: changeTicketRequired,
        changeTicket: adminGuard.changeTicket ?? null
      });
      if (!changeTicketOk) {
        reasons.push('Admin mutations require changeTicket by policy.');
      }
    }

    const mutationAllowed = reasons.length === 0 && decision.allowed;
    if (!mutationAllowed) {
      const envelope = isAdminMutation
        ? {
            result: 'failed' as const,
            precheck,
            steps: [
              {
                name: options.action,
                status: 'blocked',
                reason: 'policy_deny'
              }
            ],
            rollback: 'not_needed' as const,
            operationTier: adminGuard?.operationTier ?? 'operator',
            domain: adminGuard?.domain ?? null,
            maintenanceWindowId: adminGuard?.maintenanceWindowId ?? null,
            changeTicket: adminGuard?.changeTicket ?? null,
            riskLevel: adminGuard?.riskLevel ?? 'medium'
          }
        : undefined;

      const auditDetails: Record<string, unknown> = {
        reasons
      };
      if (envelope) {
        auditDetails.operationTier = envelope.operationTier;
        auditDetails.domain = envelope.domain;
        auditDetails.maintenanceWindowId = envelope.maintenanceWindowId;
        auditDetails.changeTicket = envelope.changeTicket;
        auditDetails.riskLevel = envelope.riskLevel;
        auditDetails.rollback = envelope.rollback;
      }

      const auditEntry = await audit.record({
        tool: options.tool,
        action: options.action,
        result: 'blocked',
        dryRun: effectiveDryRun,
        durationMs: Date.now() - started,
        errorCode: 'POLICY_DENY',
        message: reasons.join(' '),
        target: options.target,
        details: auditDetails
      });

      if (envelope) {
        return errorResult('POLICY_DENY', 'Mutation blocked by policy.', {
          reasons,
          envelope: {
            ...envelope,
            auditRef: auditEntry.id
          }
        });
      }

      return errorResult('POLICY_DENY', 'Mutation blocked by policy.', { reasons });
    }

    if (effectiveDryRun) {
      if (isAdminMutation) {
        const envelope = {
          result: 'planned' as const,
          precheck,
          steps: [
            {
              name: options.action,
              status: 'planned'
            }
          ],
          rollback: 'not_needed' as const,
          operationTier: adminGuard?.operationTier ?? 'operator',
          domain: adminGuard?.domain ?? null,
          maintenanceWindowId: adminGuard?.maintenanceWindowId ?? null,
          changeTicket: adminGuard?.changeTicket ?? null,
          riskLevel: adminGuard?.riskLevel ?? 'medium',
          target: options.target,
          policy: {
            reasons: decision.reasons,
            normalized: decision.normalized
          }
        };

        const auditEntry = await audit.record({
          tool: options.tool,
          action: options.action,
          result: 'dry_run',
          dryRun: true,
          durationMs: Date.now() - started,
          target: options.target,
          details: {
            operationTier: envelope.operationTier,
            domain: envelope.domain,
            maintenanceWindowId: envelope.maintenanceWindowId,
            changeTicket: envelope.changeTicket,
            riskLevel: envelope.riskLevel,
            rollback: envelope.rollback
          }
        });

        return successResult({
          ...envelope,
          auditRef: auditEntry.id
        });
      }

      const dryRunData = {
        dryRun: true,
        action: options.action,
        target: options.target,
        policy: {
          reasons: decision.reasons,
          normalized: decision.normalized
        }
      };

      await audit.record({
        tool: options.tool,
        action: options.action,
        result: 'dry_run',
        dryRun: true,
        durationMs: Date.now() - started,
        target: options.target,
        details: dryRunData
      });

      return successResult(dryRunData);
    }

    try {
      const data = await options.execute();
      clearStatusCache();

      if (isAdminMutation) {
        const parsed = parseAdminExecutionResult(data, options.action);
        const mergedPrecheck = [...precheck, ...parsed.precheck];

        const auditEntry = await audit.record({
          tool: options.tool,
          action: options.action,
          result: 'success',
          dryRun: false,
          durationMs: Date.now() - started,
          target: options.target,
          details: {
            intent: options.guard.intent,
            reason: options.guard.reason,
            operationTier: adminGuard?.operationTier ?? 'operator',
            domain: adminGuard?.domain ?? null,
            maintenanceWindowId: adminGuard?.maintenanceWindowId ?? null,
            changeTicket: adminGuard?.changeTicket ?? null,
            riskLevel: adminGuard?.riskLevel ?? 'medium',
            before: parsed.before,
            after: parsed.after,
            diff: parsed.diff,
            rollback: parsed.rollback
          }
        });

        return successResult({
          result: parsed.result,
          precheck: mergedPrecheck,
          steps: parsed.steps,
          rollback: parsed.rollback,
          auditRef: auditEntry.id,
          operationTier: adminGuard?.operationTier ?? 'operator',
          domain: adminGuard?.domain ?? null,
          maintenanceWindowId: adminGuard?.maintenanceWindowId ?? null,
          changeTicket: adminGuard?.changeTicket ?? null,
          riskLevel: adminGuard?.riskLevel ?? 'medium',
          ...(parsed.before !== undefined ? { before: parsed.before } : {}),
          ...(parsed.after !== undefined ? { after: parsed.after } : {}),
          ...(parsed.diff !== undefined ? { diff: parsed.diff } : {}),
          ...(parsed.data !== undefined ? { data: parsed.data } : {})
        });
      }

      await audit.record({
        tool: options.tool,
        action: options.action,
        result: 'success',
        dryRun: false,
        durationMs: Date.now() - started,
        target: options.target,
        details: {
          intent: options.guard.intent,
          reason: options.guard.reason
        }
      });
      return successResult(data);
    } catch (error) {
      const mapped = asHS4McpError(error);

      if (isAdminMutation) {
        const auditEntry = await audit.record({
          tool: options.tool,
          action: options.action,
          result: 'error',
          dryRun: false,
          durationMs: Date.now() - started,
          errorCode: mapped.code,
          message: mapped.message,
          target: options.target,
          details: {
            operationTier: adminGuard?.operationTier ?? 'operator',
            domain: adminGuard?.domain ?? null,
            maintenanceWindowId: adminGuard?.maintenanceWindowId ?? null,
            changeTicket: adminGuard?.changeTicket ?? null,
            riskLevel: adminGuard?.riskLevel ?? 'medium',
            rollback: 'available'
          }
        });

        return errorResult(mapped.code, mapped.message, {
          ...(mapped.details && isRecord(mapped.details) ? mapped.details : { raw: mapped.details }),
          envelope: {
            result: 'failed',
            precheck,
            steps: [
              {
                name: options.action,
                status: 'failed',
                errorCode: mapped.code,
                message: mapped.message
              }
            ],
            rollback: 'available',
            auditRef: auditEntry.id,
            operationTier: adminGuard?.operationTier ?? 'operator',
            domain: adminGuard?.domain ?? null,
            maintenanceWindowId: adminGuard?.maintenanceWindowId ?? null,
            changeTicket: adminGuard?.changeTicket ?? null,
            riskLevel: adminGuard?.riskLevel ?? 'medium'
          }
        });
      }

      await audit.record({
        tool: options.tool,
        action: options.action,
        result: 'error',
        dryRun: false,
        durationMs: Date.now() - started,
        errorCode: mapped.code,
        message: mapped.message,
        target: options.target,
        details: mapped.details
      });
      return errorResult(mapped.code, mapped.message, mapped.details);
    }
  }

  type AdminPolicyExtras = {
    targetRefs?: number[];
    eventIds?: number[];
    cameraIds?: number[];
    scriptCommand?: string;
    pluginFunction?: string;
    targetIds?: Array<string | number>;
    operationTier?: AdminOperationTier;
    domain?: AdminDomain;
    maintenanceWindowId?: string;
    changeTicket?: string;
    riskLevel?: AdminRiskLevel;
  };

  function buildAdminPolicyInput(args: AdminGuardArgs, extras: AdminPolicyExtras = {}): AdminPolicyExtras {
    return {
      ...extras,
      operationTier: extras.operationTier ?? args.operationTier ?? 'operator',
      domain: extras.domain ?? args.domain,
      maintenanceWindowId: extras.maintenanceWindowId ?? args.maintenanceWindowId,
      changeTicket: extras.changeTicket ?? args.changeTicket,
      riskLevel: extras.riskLevel ?? args.riskLevel ?? 'medium'
    };
  }

  interface AdminRouteDispatchResult {
    route: AdminExecutionRoute;
    transport: string;
    raw: unknown;
    command?: string;
    fallbackFrom?: AdminExecutionRoute;
  }

  function isUnsupportedOnTarget(error: unknown): boolean {
    return asHS4McpError(error).code === 'UNSUPPORTED_ON_TARGET';
  }

  function throwDirectUnsupported(
    domain: AdminDomain,
    action: string,
    reason: string,
    details?: Record<string, unknown>
  ): never {
    throw new HS4McpError('UNSUPPORTED_ON_TARGET', `Direct admin route unsupported for ${domain}.${action}: ${reason}`, {
      details: {
        domain,
        action,
        ...(details ?? {})
      }
    });
  }

  async function executeAdminDirectMutation(options: {
    domain: AdminDomain;
    action: string;
    payload: Record<string, unknown>;
  }): Promise<{ transport: string; raw: unknown }> {
    const operation = `${options.domain}.${options.action}`;
    const payload = asPayloadObject(options.payload, operation);
    switch (operation) {
      case 'users.create': {
        const raw = await client.usersCreate({
          username: requiredPayloadString(payload, 'username', operation),
          password: readString(payload, 'password'),
          role: readString(payload, 'role'),
          enabled: readBoolean(payload, 'enabled'),
          email: readString(payload, 'email')
        });
        return { transport: 'userscreate', raw };
      }
      case 'users.update': {
        const raw = await client.usersUpdate({
          username: requiredPayloadString(payload, 'userId', operation),
          password: readString(payload, 'password'),
          role: readString(payload, 'role'),
          enabled: readBoolean(payload, 'enabled'),
          email: readString(payload, 'email')
        });
        return { transport: 'usersupdate', raw };
      }
      case 'users.delete': {
        if (readBoolean(payload, 'hardDelete') === true) {
          throwDirectUnsupported(options.domain, options.action, 'hardDelete=true requires adapter path.', {
            hardDelete: true
          });
        }
        const raw = await client.usersDelete({
          username: requiredPayloadString(payload, 'userId', operation)
        });
        return { transport: 'usersdelete', raw };
      }
      case 'users.set_role': {
        const raw = await client.usersSetRole({
          username: requiredPayloadString(payload, 'userId', operation),
          role: requiredPayloadString(payload, 'role', operation)
        });
        return { transport: 'userssetrole', raw };
      }
      case 'plugins.install': {
        const source = readString(payload, 'source');
        if (source) {
          throwDirectUnsupported(options.domain, options.action, 'source override is adapter-only.', {
            source
          });
        }
        const raw = await client.pluginInstall({
          pluginId: requiredPayloadString(payload, 'pluginId', operation),
          version: readString(payload, 'version')
        });
        return { transport: 'pluginfunction:updater.installplugin', raw };
      }
      case 'plugins.update': {
        const raw = await client.pluginUpdate({
          pluginId: requiredPayloadString(payload, 'pluginId', operation),
          version: readString(payload, 'targetVersion')
        });
        return { transport: 'pluginfunction:updater.updateplugin', raw };
      }
      case 'plugins.remove': {
        const raw = await client.pluginRemove({
          pluginId: requiredPayloadString(payload, 'pluginId', operation)
        });
        return { transport: 'pluginfunction:updater.removeplugin', raw };
      }
      case 'plugins.set_enabled': {
        const enabled = readBoolean(payload, 'enabled');
        if (enabled === undefined) {
          throw new HS4McpError('BAD_REQUEST', `${operation} requires 'enabled'.`);
        }
        const raw = await client.pluginSetEnabled({
          pluginId: requiredPayloadString(payload, 'pluginId', operation),
          enabled
        });
        return { transport: 'pluginfunction:updater.setpluginenabled', raw };
      }
      case 'plugins.restart': {
        const raw = await client.pluginRestart({
          pluginId: requiredPayloadString(payload, 'pluginId', operation),
          instance: readString(payload, 'instance')
        });
        return { transport: 'pluginfunction:updater.restartplugin', raw };
      }
      case 'interfaces.add': {
        const raw = await client.interfaceAdd({
          name: requiredPayloadString(payload, 'interfaceName', operation),
          type: requiredPayloadString(payload, 'interfaceType', operation),
          config: payload.settings === undefined ? undefined : JSON.stringify(payload.settings)
        });
        return { transport: 'interfaceadd', raw };
      }
      case 'interfaces.update': {
        const raw = await client.interfaceUpdate({
          id: requiredPayloadString(payload, 'interfaceId', operation),
          name: readString(payload, 'interfaceName'),
          config: payload.settings === undefined ? undefined : JSON.stringify(payload.settings)
        });
        return { transport: 'interfaceupdate', raw };
      }
      case 'interfaces.remove': {
        const raw = await client.interfaceRemove({
          id: requiredPayloadString(payload, 'interfaceId', operation)
        });
        return { transport: 'interfaceremove', raw };
      }
      case 'interfaces.restart': {
        const raw = await client.interfaceRestart({
          id: requiredPayloadString(payload, 'interfaceId', operation)
        });
        return { transport: 'interfacerestart', raw };
      }
      case 'system.backup.start': {
        if (payload.includeMedia === false) {
          throwDirectUnsupported(options.domain, options.action, 'includeMedia=false requires adapter path.', {
            includeMedia: false
          });
        }
        const raw = await client.systemBackupStart({
          note: readString(payload, 'label')
        });
        return { transport: 'backup.html', raw };
      }
      case 'system.restore.start': {
        if (readBoolean(payload, 'verifyOnly') === true) {
          throwDirectUnsupported(options.domain, options.action, 'verifyOnly=true requires adapter path.', {
            verifyOnly: true
          });
        }
        const raw = await client.systemRestoreStart({
          backupId: requiredPayloadString(payload, 'backupId', operation)
        });
        return { transport: 'systemrestorestart', raw };
      }
      case 'system.service.restart': {
        const raw = await client.systemServiceRestart({
          service: readString(payload, 'service')
        });
        return { transport: 'run_script_command:hs.RestartService', raw };
      }
      case 'system.shutdown': {
        const raw = await client.systemShutdown({
          delaySeconds: readNumber(payload, 'graceSeconds')
        });
        return { transport: 'run_script_command:hs.Shutdown', raw };
      }
      case 'system.config.set': {
        const value = payload.value;
        if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
          throw new HS4McpError('BAD_REQUEST', `${operation} requires key/value.`);
        }
        const raw = await client.systemConfigSet({
          key: requiredPayloadString(payload, 'key', operation),
          value
        });
        return { transport: 'systemconfigset', raw };
      }
      case 'cameras.config.create': {
        const raw = await client.cameraConfigCreate({
          name: requiredPayloadString(payload, 'name', operation),
          source: requiredPayloadString(payload, 'streamUrl', operation),
          profile: readString(payload, 'profile')
        });
        return { transport: 'cameraconfigcreate', raw };
      }
      case 'cameras.config.update': {
        const raw = await client.cameraConfigUpdate({
          camId: requiredPayloadNumber(payload, 'camId', operation),
          name: readString(payload, 'name'),
          source: readString(payload, 'streamUrl'),
          profile: readString(payload, 'profile')
        });
        return { transport: 'cameraconfigupdate', raw };
      }
      case 'cameras.config.delete': {
        const raw = await client.cameraConfigDelete({
          camId: requiredPayloadNumber(payload, 'camId', operation)
        });
        return { transport: 'cameraconfigdelete', raw };
      }
      case 'cameras.stream_profile.set': {
        const raw = await client.cameraStreamProfileSet({
          camId: requiredPayloadNumber(payload, 'camId', operation),
          profile: requiredPayloadString(payload, 'profile', operation)
        });
        return { transport: 'camerastreamprofileset', raw };
      }
      case 'cameras.recording.set': {
        if (payload.retentionDays !== undefined) {
          throwDirectUnsupported(options.domain, options.action, 'retentionDays requires adapter path.', {
            retentionDays: payload.retentionDays
          });
        }
        const enabled = readBoolean(payload, 'enabled');
        if (enabled === undefined) {
          throw new HS4McpError('BAD_REQUEST', `${operation} requires 'enabled'.`);
        }
        const raw = await client.cameraRecordingSet({
          camId: requiredPayloadNumber(payload, 'camId', operation),
          enabled
        });
        return { transport: 'camerarecordingset', raw };
      }
      case 'events.create': {
        if (payload.definition !== undefined) {
          throwDirectUnsupported(options.domain, options.action, 'definition payload requires adapter path.');
        }
        const raw = await client.eventsCreate({
          group: requiredPayloadString(payload, 'group', operation),
          name: requiredPayloadString(payload, 'name', operation)
        });
        return { transport: 'eventscreate', raw };
      }
      case 'events.update': {
        if (payload.definition !== undefined) {
          throwDirectUnsupported(options.domain, options.action, 'definition payload requires adapter path.');
        }
        if (readNumber(payload, 'eventId') === undefined) {
          throwDirectUnsupported(options.domain, options.action, 'eventId is required for direct updates.', {
            eventId: payload.eventId ?? null
          });
        }
        const raw = await client.eventsUpdate({
          id: requiredPayloadNumber(payload, 'eventId', operation),
          group: readString(payload, 'group'),
          name: readString(payload, 'name')
        });
        return { transport: 'eventsupdate', raw };
      }
      case 'events.delete': {
        if (readNumber(payload, 'eventId') === undefined) {
          throwDirectUnsupported(options.domain, options.action, 'eventId is required for direct deletes.', {
            eventId: payload.eventId ?? null
          });
        }
        const raw = await client.eventsDelete({
          id: requiredPayloadNumber(payload, 'eventId', operation)
        });
        return { transport: 'eventsdelete', raw };
      }
      case 'config.device_metadata.set': {
        const raw = await client.setDeviceProperty({
          ref: requiredPayloadNumber(payload, 'ref', operation),
          property: requiredPayloadString(payload, 'property', operation),
          value: requiredPayloadString(payload, 'value', operation)
        });
        return { transport: 'setdeviceproperty', raw };
      }
      case 'config.category.upsert':
      case 'config.category.delete': {
        return throwDirectUnsupported(
          options.domain,
          options.action,
          'category management currently routes through adapter.'
        );
      }
      default:
        return throwDirectUnsupported(options.domain, options.action, 'operation has no direct client mapping.');
    }
  }

  async function executeAdminAdapterMutation(options: {
    domain: AdminDomain;
    action: string;
    payload: Record<string, unknown>;
    fallbackFrom?: AdminExecutionRoute;
  }): Promise<AdminRouteDispatchResult> {
    const command = buildAdminScriptCommand(options.domain, options.action, options.payload);
    const raw = await client.runScriptCommand(command);
    return {
      route: 'adapter',
      transport: 'runScriptCommand',
      raw,
      command,
      ...(options.fallbackFrom ? { fallbackFrom: options.fallbackFrom } : {})
    };
  }

  async function executeAdminScriptMutation(options: {
    domain: AdminDomain;
    action: string;
    payload: Record<string, unknown>;
    rollback?: AdminRollbackResult;
    before?: () => Promise<unknown>;
    after?: () => Promise<unknown>;
  }): Promise<AdminExecutionResult> {
    const before = options.before ? await options.before() : undefined;
    const capabilityKey = adminCapabilityKey(options.domain, options.action);
    let dispatch: AdminRouteDispatchResult;

    if (adminExecutionMode === 'adapter') {
      dispatch = await executeAdminAdapterMutation(options);
    } else if (adminExecutionMode === 'direct') {
      try {
        const direct = await executeAdminDirectMutation(options);
        dispatch = {
          route: 'direct',
          transport: direct.transport,
          raw: direct.raw
        };
      } catch (error) {
        if (!adminDirectFallback || !isUnsupportedOnTarget(error)) {
          throw error;
        }
        dispatch = await executeAdminAdapterMutation({
          ...options,
          fallbackFrom: 'direct'
        });
      }
    } else {
      const cached = readAdminCapability(capabilityKey);
      if (cached === false) {
        dispatch = await executeAdminAdapterMutation(options);
      } else {
        try {
          const direct = await executeAdminDirectMutation(options);
          writeAdminCapability(capabilityKey, true);
          dispatch = {
            route: 'direct',
            transport: direct.transport,
            raw: direct.raw
          };
        } catch (error) {
          if (!isUnsupportedOnTarget(error)) {
            throw error;
          }
          writeAdminCapability(capabilityKey, false);
          if (!adminDirectFallback) {
            throw error;
          }
          dispatch = await executeAdminAdapterMutation({
            ...options,
            fallbackFrom: 'direct'
          });
        }
      }
    }

    const after = options.after ? await options.after() : undefined;
    const diff = computeObjectDiff(before, after);
    const fallbackData = dispatch.fallbackFrom
      ? {
          fallback: {
            from: dispatch.fallbackFrom,
            to: dispatch.route,
            reason: 'UNSUPPORTED_ON_TARGET'
          }
        }
      : {};

    if (dispatch.route === 'adapter') {
      const parsed = parseAdminExecutionResult(dispatch.raw, options.action);
      const parsedRawHasRollback = isRecord(dispatch.raw) && Object.prototype.hasOwnProperty.call(dispatch.raw, 'rollback');
      const steps = (parsed.steps.length ? parsed.steps : [{ name: options.action, status: parsed.result }]).map(
        (step, index) => ({
          ...step,
          route: dispatch.route,
          transport: typeof step.transport === 'string' ? step.transport : dispatch.transport,
          ...(dispatch.fallbackFrom && index === 0 ? { fallbackFrom: dispatch.fallbackFrom } : {})
        })
      );
      const data = {
        ...(isRecord(parsed.data) ? parsed.data : {}),
        route: dispatch.route,
        transport: dispatch.transport,
        ...(dispatch.command ? { command: dispatch.command } : {}),
        payload: options.payload,
        raw: dispatch.raw,
        ...fallbackData,
        ...(!isRecord(parsed.data) && parsed.data !== undefined ? { adapterData: parsed.data } : {})
      };

      return {
        result: parsed.result,
        precheck: parsed.precheck,
        steps,
        rollback: parsedRawHasRollback ? parsed.rollback : options.rollback ?? 'available',
        ...(before !== undefined ? { before } : {}),
        ...(after !== undefined ? { after } : {}),
        ...(diff !== undefined ? { diff } : {}),
        data
      };
    }

    return {
      result: 'applied',
      precheck: [],
      steps: [
        {
          name: options.action,
          status: 'applied',
          route: dispatch.route,
          transport: dispatch.transport
        }
      ],
      rollback: options.rollback ?? 'available',
      ...(before !== undefined ? { before } : {}),
      ...(after !== undefined ? { after } : {}),
      ...(diff !== undefined ? { diff } : {}),
      data: {
        route: dispatch.route,
        transport: dispatch.transport,
        payload: options.payload,
        raw: dispatch.raw,
        ...fallbackData
      }
    };
  }

  server.registerTool(
    'hs4.health.get',
    {
      description: 'Check HS4 connectivity, auth status and basic runtime metrics.'
    },
    async () => {
      return auditRead('hs4.health.get', 'read_health', {}, async () => {
        const [version, statusPayload] = await Promise.all([
          client.getVersion(),
          getStatusPayload({ compress: true, everything: false })
        ]);
        const status = normalizeStatusPayload(statusPayload);

        return {
          hs4Version: version,
          hs4BaseUrl: config.hs4BaseUrl,
          safeMode: config.safeMode,
          transport: config.mcpTransport,
          devicesDiscovered: status.devices.length,
          checkedAt: new Date().toISOString()
        };
      });
    }
  );

  server.registerTool(
    'hs4.help.route',
    {
      description: 'Route a natural-language goal to the safest recommended HS4 MCP tool workflow.',
      inputSchema: {
        goal: z.string().min(3),
        mode: z.enum(['read_only', 'dry_run', 'mutate']).optional().default('dry_run')
      }
    },
    async ({ goal, mode }) => {
      return auditRead('hs4.help.route', 'help_route', { goal, mode }, async () => {
        const normalized = goal.toLowerCase();
        const preferDryRun = mode !== 'mutate';
        const routes: Array<Record<string, unknown>> = [];

        if (normalized.includes('camera') || normalized.includes('snapshot') || normalized.includes('pan')) {
          routes.push({
            rank: 1,
            route: 'camera_control',
            confidence: 'high',
            steps: [
              { tool: 'hs4.resolve.cameras', argsTemplate: { query: goal, limit: 5 } },
              { tool: 'hs4.cameras.list', argsTemplate: {} },
              {
                tool: 'hs4.cameras.pan',
                argsTemplate: {
                  camId: '<resolvedCamId>',
                  direction: 'leftstart',
                  confirm: true,
                  intent: goal,
                  reason: 'operator requested camera movement',
                  dryRun: preferDryRun
                }
              }
            ]
          });
        }

        if (normalized.includes('scene') || normalized.includes('event') || normalized.includes('automation')) {
          routes.push({
            rank: routes.length + 1,
            route: 'event_execution',
            confidence: 'high',
            steps: [
              { tool: 'hs4.resolve.events', argsTemplate: { query: goal, limit: 5 } },
              {
                tool: 'hs4.events.run',
                argsTemplate: {
                  id: '<resolvedEventId>',
                  confirm: true,
                  intent: goal,
                  reason: 'operator requested scene execution',
                  dryRun: preferDryRun
                }
              },
              { tool: 'hs4.devices.status.get', argsTemplate: { refs: ['<affectedRefs>'] } }
            ]
          });
        }

        if (
          normalized.includes('device') ||
          normalized.includes('light') ||
          normalized.includes('switch') ||
          normalized.includes('dim')
        ) {
          routes.push({
            rank: routes.length + 1,
            route: 'device_control',
            confidence: normalized.includes('light') || normalized.includes('switch') ? 'high' : 'medium',
            steps: [
              { tool: 'hs4.resolve.devices', argsTemplate: { query: goal, limit: 5 } },
              {
                tool: 'hs4.devices.set',
                argsTemplate: {
                  ref: '<resolvedDeviceRef>',
                  mode: 'control_value',
                  value: '<controlValue>',
                  confirm: true,
                  intent: goal,
                  reason: 'operator requested device state change',
                  dryRun: preferDryRun
                }
              },
              { tool: 'hs4.devices.status.get', argsTemplate: { refs: ['<resolvedDeviceRef>'] } }
            ]
          });
        }

        if (!routes.length) {
          routes.push({
            rank: 1,
            route: 'generic_diagnostics',
            confidence: 'medium',
            steps: [
              { tool: 'hs4.health.get', argsTemplate: {} },
              { tool: 'hs4.selftest.run', argsTemplate: {} },
              { tool: 'hs4.help.route', argsTemplate: { goal: 'refine objective with entity names' } }
            ]
          });
        }

        return {
          goal,
          mode,
          routes
        };
      });
    }
  );

  server.registerTool(
    'hs4.resolve.devices',
    {
      description: 'Resolve likely device refs from a natural-language query.',
      inputSchema: {
        query: z.string().min(1),
        limit: z.number().int().optional().default(10),
        includeEvidence: z.boolean().optional().default(true)
      }
    },
    async ({ query, limit, includeEvidence }) => {
      return auditRead('hs4.resolve.devices', 'resolve_devices', { query, limit }, async () => {
        const refresh = await refreshAliasCatalog();
        const results = aliasCatalog.resolve('device', query, parseLimit(limit, 10, 100));
        const reranked = rerankDeviceAliasMatches(results, query);
        const output = reranked.map((result, index) => {
          const meta = deviceResolutionMetaByRef.get(result.targetId);
          return {
          ref: result.targetId,
          name: deviceNameByRef.get(result.targetId) ?? result.canonicalName,
          score: result.score,
          confidence: result.confidence,
          recommended: index === 0,
          ...(meta
            ? {
                actionability: {
                  rank: deviceActionabilityRank(meta, {
                    preferWrapper: shouldPreferWrapperFromQuery(query)
                  }),
                  role: isLikelyWrapperDevice(meta) ? 'wrapper_or_master' : 'endpoint',
                  relationship: meta.relationship ?? null,
                  parentRef: meta.parentRef ?? null,
                  controlPairCount: meta.controlPairCount
                }
              }
            : {}),
          ...(includeEvidence
            ? {
                evidence: {
                  matchedAlias: result.matchedAlias,
                  normalizedAlias: result.normalizedAlias,
                  provenance: result.provenance
                }
              }
            : {})
          };
        });

        return {
          query,
          refresh,
          totalMatches: output.length,
          disambiguationHint:
            output.length > 1
              ? 'Multiple candidate devices found. Prefer the recommended=true endpoint ref before mutation.'
              : undefined,
          recommendedRef: output[0]?.ref ?? null,
          items: output
        };
      });
    }
  );

  server.registerTool(
    'hs4.resolve.events',
    {
      description: 'Resolve likely event IDs from a natural-language query.',
      inputSchema: {
        query: z.string().min(1),
        groupHint: z.string().optional(),
        limit: z.number().int().optional().default(10),
        includeEvidence: z.boolean().optional().default(true)
      }
    },
    async ({ query, groupHint, limit, includeEvidence }) => {
      return auditRead('hs4.resolve.events', 'resolve_events', { query, groupHint, limit }, async () => {
        const refresh = await refreshAliasCatalog();
        let results = aliasCatalog.resolve('event', query, parseLimit(limit, 10, 100));
        if (groupHint?.trim()) {
          const normalizedHint = groupHint.trim().toLowerCase();
          results = results.filter((item) =>
            (eventById.get(item.targetId)?.group ?? '').toLowerCase().includes(normalizedHint)
          );
        }

        const output = results.map((result) => {
          const event = eventById.get(result.targetId);
          return {
            id: result.targetId,
            group: event?.group ?? 'unknown',
            name: event?.name ?? result.canonicalName,
            score: result.score,
            confidence: result.confidence,
            ...(includeEvidence
              ? {
                  evidence: {
                    matchedAlias: result.matchedAlias,
                    normalizedAlias: result.normalizedAlias,
                    provenance: result.provenance
                  }
                }
              : {})
          };
        });

        return {
          query,
          groupHint: groupHint ?? null,
          refresh,
          totalMatches: output.length,
          disambiguationHint:
            output.length > 1 ? 'Multiple candidate events found. Confirm the event id before running.' : undefined,
          items: output
        };
      });
    }
  );

  server.registerTool(
    'hs4.resolve.cameras',
    {
      description: 'Resolve likely camera IDs from a natural-language query.',
      inputSchema: {
        query: z.string().min(1),
        limit: z.number().int().optional().default(10),
        includeEvidence: z.boolean().optional().default(true)
      }
    },
    async ({ query, limit, includeEvidence }) => {
      return auditRead('hs4.resolve.cameras', 'resolve_cameras', { query, limit }, async () => {
        const refresh = await refreshAliasCatalog();
        const results = aliasCatalog.resolve('camera', query, parseLimit(limit, 10, 100));
        const output = results.map((result) => ({
          camId: result.targetId,
          name: cameraNameById.get(result.targetId) ?? result.canonicalName,
          score: result.score,
          confidence: result.confidence,
          ...(includeEvidence
            ? {
                evidence: {
                  matchedAlias: result.matchedAlias,
                  normalizedAlias: result.normalizedAlias,
                  provenance: result.provenance
                }
              }
            : {})
        }));

        return {
          query,
          refresh,
          totalMatches: output.length,
          disambiguationHint:
            output.length > 1 ? 'Multiple candidate cameras found. Confirm camId before mutation.' : undefined,
          items: output
        };
      });
    }
  );

  server.registerTool(
    'hs4.change.prepare',
    {
      description: 'Prepare a guarded mutation and return a commit token for two-phase execution.',
      inputSchema: {
        toolName: z.string().min(1),
        args: z.record(z.string(), z.unknown()).optional().default({}),
        summary: z.record(z.string(), z.unknown()).optional().default({})
      }
    },
    async ({ toolName, args, summary }) => {
      const resolvedTool = parseSupportedPrepareToolName(toolName);
      if (!resolvedTool) {
        return errorResult('BAD_REQUEST', 'toolName is not supported for two-phase prepare/commit.', {
          toolName
        });
      }

      return prepareMutation(resolvedTool, args, {
        ...summary,
        requestedToolName: toolName
      });
    }
  );

  server.registerTool(
    'hs4.change.commit',
    {
      description: 'Commit a previously prepared mutation token.',
      inputSchema: {
        token: z.string().min(1)
      }
    },
    async ({ token }) => {
      return commitPreparedChange(token);
    }
  );

  server.registerTool(
    'hs4.intent.device_set_by_name',
    {
      description: 'Resolve a device by name and prepare/optionally commit a device state change.',
      inputSchema: {
        query: z.string().min(1),
        mode: z.enum(['control_value', 'set_status']).optional().default('control_value'),
        value: z.number().optional(),
        statusText: z.string().optional(),
        source: z.string().optional(),
        execute: z.boolean().optional().default(false),
        confirm: z.boolean().optional(),
        intent: z.string().optional(),
        reason: z.string().optional(),
        dryRun: z.boolean().optional()
      }
    },
    async (args) => {
      return auditRead('hs4.intent.device_set_by_name', 'intent_device_set_by_name', { query: args.query }, async () => {
        await refreshAliasCatalog();
        const matches = rerankDeviceAliasMatches(aliasCatalog.resolve('device', args.query, 5), args.query);
        if (!matches.length) {
          throw new HS4McpError('NOT_FOUND', 'No matching device found for the provided query.', {
            details: {
              query: args.query
            }
          });
        }

        const chosen = matches[0]!;
        const warnings = buildDeviceIntentWarnings(matches, args.query);
        const chosenMeta = deviceResolutionMetaByRef.get(chosen.targetId);
        const mutationArgs: Record<string, unknown> = {
          ref: chosen.targetId,
          mode: args.mode,
          ...(args.value !== undefined ? { value: args.value } : {}),
          ...(args.statusText ? { statusText: args.statusText } : {}),
          ...(args.source ? { source: args.source } : {}),
          confirm: args.confirm,
          intent: args.intent ?? `Set device "${deviceNameByRef.get(chosen.targetId) ?? chosen.canonicalName}"`,
          reason: args.reason ?? 'intent tool orchestration',
          dryRun: args.dryRun ?? true
        };

        const prepared = await prepareMutation('hs4.devices.set', mutationArgs, {
          intentTool: 'hs4.intent.device_set_by_name',
          query: args.query,
          resolvedRef: chosen.targetId,
          resolvedName: deviceNameByRef.get(chosen.targetId) ?? chosen.canonicalName,
          warningCodes: warnings.map((warning) => warning.code)
        });
        const preparedPayload = (prepared as { structuredContent?: { result?: Record<string, unknown> } }).structuredContent
          ?.result;
        const resolution = {
          query: args.query,
          resolvedRef: chosen.targetId,
          resolvedName: deviceNameByRef.get(chosen.targetId) ?? chosen.canonicalName,
          resolvedRole: chosenMeta && isLikelyWrapperDevice(chosenMeta) ? 'wrapper_or_master' : 'endpoint',
          candidates: matches.map((match) => ({
            ref: match.targetId,
            score: match.score,
            confidence: match.confidence
          }))
        };

        if ((prepared as { isError?: boolean }).isError || args.execute !== true) {
          return {
            execute: false,
            prepared: preparedPayload ?? prepared,
            resolution,
            ...(warnings.length ? { warnings } : {})
          };
        }

        const token = preparedPayload?.token;
        if (typeof token !== 'string') {
          return {
            execute: false,
            prepared: preparedPayload ?? prepared,
            resolution,
            ...(warnings.length ? { warnings } : {})
          };
        }

        const committed = await commitPreparedChange(token);
        if ((committed as { isError?: boolean }).isError) {
          throwFromToolErrorResult(committed as ReturnType<typeof errorResult>);
        }

        return {
          execute: true,
          prepared: preparedPayload,
          committed: (committed as { structuredContent?: { result?: Record<string, unknown> } }).structuredContent?.result,
          resolution,
          ...(warnings.length ? { warnings } : {})
        };
      });
    }
  );

  server.registerTool(
    'hs4.intent.event_run_by_name',
    {
      description: 'Resolve an event by name/group and prepare/optionally commit event execution.',
      inputSchema: {
        query: z.string().min(1),
        groupHint: z.string().optional(),
        execute: z.boolean().optional().default(false),
        confirm: z.boolean().optional(),
        intent: z.string().optional(),
        reason: z.string().optional(),
        dryRun: z.boolean().optional()
      }
    },
    async (args) => {
      return auditRead('hs4.intent.event_run_by_name', 'intent_event_run_by_name', { query: args.query }, async () => {
        await refreshAliasCatalog();
        let matches = aliasCatalog.resolve('event', args.query, 5);
        if (args.groupHint?.trim()) {
          const normalizedGroupHint = args.groupHint.trim().toLowerCase();
          matches = matches.filter((match) =>
            (eventById.get(match.targetId)?.group ?? '').toLowerCase().includes(normalizedGroupHint)
          );
        }

        if (!matches.length) {
          throw new HS4McpError('NOT_FOUND', 'No matching event found for the provided query.', {
            details: {
              query: args.query,
              groupHint: args.groupHint
            }
          });
        }

        const chosen = matches[0]!;
        const event = eventById.get(chosen.targetId);
        const mutationArgs: Record<string, unknown> = {
          id: chosen.targetId,
          confirm: args.confirm,
          intent: args.intent ?? `Run event "${event?.name ?? chosen.canonicalName}"`,
          reason: args.reason ?? 'intent tool orchestration',
          dryRun: args.dryRun ?? true
        };

        const prepared = await prepareMutation('hs4.events.run', mutationArgs, {
          intentTool: 'hs4.intent.event_run_by_name',
          query: args.query,
          groupHint: args.groupHint ?? null,
          resolvedEventId: chosen.targetId
        });
        const preparedPayload = (prepared as { structuredContent?: { result?: Record<string, unknown> } }).structuredContent
          ?.result;

        if ((prepared as { isError?: boolean }).isError || args.execute !== true) {
          return {
            execute: false,
            prepared: preparedPayload ?? prepared
          };
        }

        const token = preparedPayload?.token;
        if (typeof token !== 'string') {
          return {
            execute: false,
            prepared: preparedPayload ?? prepared
          };
        }

        const committed = await commitPreparedChange(token);
        if ((committed as { isError?: boolean }).isError) {
          throwFromToolErrorResult(committed as ReturnType<typeof errorResult>);
        }

        return {
          execute: true,
          prepared: preparedPayload,
          committed: (committed as { structuredContent?: { result?: Record<string, unknown> } }).structuredContent?.result
        };
      });
    }
  );

  server.registerTool(
    'hs4.intent.scene_activate',
    {
      description: 'Activate a scene by resolving an event first, with device fallback when no event is found.',
      inputSchema: {
        objective: z.string().min(1),
        fallbackDeviceValue: z.number().optional().default(100),
        preferPath: z.enum(['auto', 'event', 'device_fallback']).optional().default('auto'),
        eventMinScore: z.number().optional().default(0.85),
        execute: z.boolean().optional().default(false),
        confirm: z.boolean().optional(),
        intent: z.string().optional(),
        reason: z.string().optional(),
        dryRun: z.boolean().optional()
      }
    },
    async (args) => {
      return auditRead(
        'hs4.intent.scene_activate',
        'intent_scene_activate',
        { objective: args.objective, preferPath: args.preferPath, eventMinScore: args.eventMinScore },
        async () => {
        await refreshAliasCatalog();
        const eventMatches = aliasCatalog.resolve('event', args.objective, 3);
        const deviceMatches = rerankDeviceAliasMatches(aliasCatalog.resolve('device', args.objective, 3), args.objective);
        const normalizedEventMinScore = Math.max(0, Math.min(1, Number(args.eventMinScore ?? 0.85)));
        const topEventScore = eventMatches[0]?.score ?? null;
        const topDeviceScore = deviceMatches[0]?.score ?? null;
        let selectedPath: 'event' | 'device_fallback' | null = null;
        let selectionReason = 'no_candidates';

        if (args.preferPath === 'event') {
          if (eventMatches.length) {
            selectedPath = 'event';
            selectionReason = 'prefer_path_event';
          } else {
            throw new HS4McpError('NOT_FOUND', 'No matching event found for objective with preferPath=event.', {
              details: {
                objective: args.objective,
                preferPath: args.preferPath
              }
            });
          }
        } else if (args.preferPath === 'device_fallback') {
          if (deviceMatches.length) {
            selectedPath = 'device_fallback';
            selectionReason = 'prefer_path_device_fallback';
          } else {
            throw new HS4McpError('NOT_FOUND', 'No matching device found for objective with preferPath=device_fallback.', {
              details: {
                objective: args.objective,
                preferPath: args.preferPath
              }
            });
          }
        } else {
          if (eventMatches.length && deviceMatches.length) {
            const eventScore = eventMatches[0]?.score ?? 0;
            const deviceScore = deviceMatches[0]?.score ?? 0;
            if (eventScore >= normalizedEventMinScore && eventScore >= deviceScore + 0.04) {
              selectedPath = 'event';
              selectionReason = 'auto_event_high_confidence';
            } else {
              selectedPath = 'device_fallback';
              selectionReason = 'auto_device_fallback';
            }
          } else if (eventMatches.length) {
            selectedPath = 'event';
            selectionReason = 'auto_event_only_candidate';
          } else if (deviceMatches.length) {
            selectedPath = 'device_fallback';
            selectionReason = 'auto_device_only_candidate';
          }
        }

        if (!selectedPath) {
          throw new HS4McpError('NOT_FOUND', 'No matching scene event or fallback device could be resolved.', {
            details: { objective: args.objective }
          });
        }

        const selection = {
          preferPath: args.preferPath,
          selectedPath,
          eventMinScore: normalizedEventMinScore,
          topEventScore,
          topDeviceScore,
          reason: selectionReason
        };

        if (selectedPath === 'event') {
          const chosen = eventMatches[0]!;
          const prepared = await prepareMutation(
            'hs4.events.run',
            {
              id: chosen.targetId,
              confirm: args.confirm,
              intent: args.intent ?? `Activate scene "${eventById.get(chosen.targetId)?.name ?? chosen.canonicalName}"`,
              reason: args.reason ?? 'scene activation intent orchestration',
              dryRun: args.dryRun ?? true
            },
            {
              intentTool: 'hs4.intent.scene_activate',
              path: 'event',
              objective: args.objective,
              resolvedEventId: chosen.targetId,
              selection
            }
          );
          const preparedPayload = (prepared as { structuredContent?: { result?: Record<string, unknown> } })
            .structuredContent?.result;

          if ((prepared as { isError?: boolean }).isError || args.execute !== true) {
            return {
              path: 'event',
              execute: false,
              prepared: preparedPayload ?? prepared,
              selection
            };
          }

          const token = preparedPayload?.token;
          if (typeof token !== 'string') {
            return {
              path: 'event',
              execute: false,
              prepared: preparedPayload ?? prepared,
              selection
            };
          }

          const committed = await commitPreparedChange(token);
          if ((committed as { isError?: boolean }).isError) {
            throwFromToolErrorResult(committed as ReturnType<typeof errorResult>);
          }
          return {
            path: 'event',
            execute: true,
            prepared: preparedPayload,
            committed: (committed as { structuredContent?: { result?: Record<string, unknown> } }).structuredContent?.result,
            selection
          };
        }

        const chosenDevice = deviceMatches[0]!;
        const fallbackWarnings = buildDeviceIntentWarnings(deviceMatches, args.objective);
        const prepared = await prepareMutation(
          'hs4.devices.set',
          {
            ref: chosenDevice.targetId,
            mode: 'control_value',
            value: args.fallbackDeviceValue,
            confirm: args.confirm,
            intent: args.intent ?? `Activate scene fallback on "${deviceNameByRef.get(chosenDevice.targetId) ?? chosenDevice.canonicalName}"`,
            reason: args.reason ?? 'scene activation fallback via device state',
            dryRun: args.dryRun ?? true
          },
          {
            intentTool: 'hs4.intent.scene_activate',
            path: 'device_fallback',
            objective: args.objective,
            resolvedRef: chosenDevice.targetId,
            warningCodes: fallbackWarnings.map((warning) => warning.code),
            selection
          }
        );

        const preparedPayload = (prepared as { structuredContent?: { result?: Record<string, unknown> } }).structuredContent
          ?.result;
        if ((prepared as { isError?: boolean }).isError || args.execute !== true) {
          return {
            path: 'device_fallback',
            execute: false,
            prepared: preparedPayload ?? prepared,
            selection,
            ...(fallbackWarnings.length ? { warnings: fallbackWarnings } : {})
          };
        }

        const token = preparedPayload?.token;
        if (typeof token !== 'string') {
          return {
            path: 'device_fallback',
            execute: false,
            prepared: preparedPayload ?? prepared,
            selection,
            ...(fallbackWarnings.length ? { warnings: fallbackWarnings } : {})
          };
        }
        const committed = await commitPreparedChange(token);
        if ((committed as { isError?: boolean }).isError) {
          throwFromToolErrorResult(committed as ReturnType<typeof errorResult>);
        }
        return {
          path: 'device_fallback',
          execute: true,
          prepared: preparedPayload,
          committed: (committed as { structuredContent?: { result?: Record<string, unknown> } }).structuredContent?.result,
          selection,
          ...(fallbackWarnings.length ? { warnings: fallbackWarnings } : {})
        };
      }
      );
    }
  );

  server.registerTool(
    'hs4.selftest.run',
    {
      description: 'Run a read-only MCP/HS4 health and capability self-test matrix.',
      inputSchema: {
        includeResolverRefresh: z.boolean().optional().default(true)
      }
    },
    async ({ includeResolverRefresh }) => {
      return auditRead('hs4.selftest.run', 'selftest_run', { includeResolverRefresh }, async () => {
        const checks: Array<Record<string, unknown>> = [];

        try {
          const version = await client.getVersion();
          checks.push({ check: 'hs4_version', status: 'pass', value: version });
        } catch (error) {
          const mapped = asHS4McpError(error);
          checks.push({ check: 'hs4_version', status: 'fail', code: mapped.code, message: mapped.message });
        }

        try {
          const payload = await getStatusPayload({
            compress: true,
            everything: false,
            excludeevents: true
          });
          const snapshot = normalizeStatusPayload(payload);
          checks.push({ check: 'devices_read', status: 'pass', count: snapshot.devices.length });
        } catch (error) {
          const mapped = asHS4McpError(error);
          checks.push({ check: 'devices_read', status: 'fail', code: mapped.code, message: mapped.message });
        }

        try {
          const events = normalizeEventsPayload(await client.getEvents());
          checks.push({ check: 'events_read', status: 'pass', count: events.length });
        } catch (error) {
          const mapped = asHS4McpError(error);
          checks.push({ check: 'events_read', status: 'fail', code: mapped.code, message: mapped.message });
        }

        try {
          const cameras = normalizeCamerasPayload(await client.getCameras());
          checks.push({ check: 'cameras_read', status: 'pass', count: cameras.length });
        } catch (error) {
          const mapped = asHS4McpError(error);
          checks.push({ check: 'cameras_read', status: 'warn', code: mapped.code, message: mapped.message });
        }

        try {
          await ensureChangeTokenStoreInitialized();
          const purged = await changeTokenStore.purgeExpired();
          checks.push({ check: 'change_token_store', status: 'pass', purgedExpired: purged });
        } catch (error) {
          const mapped = asHS4McpError(error);
          checks.push({ check: 'change_token_store', status: 'fail', code: mapped.code, message: mapped.message });
        }

        if (includeResolverRefresh) {
          try {
            const aliasRefresh = await refreshAliasCatalog();
            const aliasWarnings = Array.isArray(aliasRefresh.warnings) ? aliasRefresh.warnings : [];
            checks.push({
              check: 'alias_refresh',
              status: aliasWarnings.length ? 'warn' : 'pass',
              devices: aliasRefresh.totalDevices,
              events: aliasRefresh.totalEvents,
              cameras: aliasRefresh.totalCameras,
              ...(aliasWarnings.length ? { warnings: aliasWarnings } : {})
            });
          } catch (error) {
            const mapped = asHS4McpError(error);
            checks.push({ check: 'alias_refresh', status: 'warn', code: mapped.code, message: mapped.message });
          }
        }

        const failCount = checks.filter((check) => check.status === 'fail').length;
        const warnCount = checks.filter((check) => check.status === 'warn').length;
        const status = failCount > 0 ? 'fail' : warnCount > 0 ? 'warn' : 'pass';

        return {
          status,
          failCount,
          warnCount,
          checks
        };
      });
    }
  );

  server.registerTool(
    'hs4.devices.list',
    {
      description: 'List HS4 devices with filtering by location, interface, and capability.',
      inputSchema: {
        location1: z.string().optional(),
        location2: z.string().optional(),
        interfaceName: z.string().optional(),
        capability: z.string().optional(),
        includeControls: z.boolean().optional().default(false),
        includeRaw: z.boolean().optional().default(false),
        maxDevices: z.number().int().optional(),
        limit: z.number().optional().default(100),
        offset: z.number().optional().default(0)
      }
    },
    async ({ location1, location2, interfaceName, capability, includeControls, includeRaw, maxDevices, limit, offset }) => {
      return auditRead(
        'hs4.devices.list',
        'list_devices',
        {
          location1,
          location2,
          interfaceName,
          capability,
          includeControls,
          includeRaw,
          maxDevices
        },
        async () => {
          const effectiveMaxDevices = parseMaxDevices(maxDevices, defaultMaxDevices);
          const payload = await getStatusPayload({
            location1: location1 || undefined,
            location2: location2 || undefined,
            compress: !includeControls,
            everything: includeControls || config.includeEverythingOnStatus
          });
          const snapshot = normalizeStatusPayload(payload);

          let devices = snapshot.devices;

          if (location1) {
            const normalized = location1.toLowerCase();
            devices = devices.filter((device) => device.location.toLowerCase().includes(normalized));
          }
          if (location2) {
            const normalized = location2.toLowerCase();
            devices = devices.filter((device) => device.location2.toLowerCase().includes(normalized));
          }
          if (interfaceName) {
            const normalized = interfaceName.toLowerCase();
            devices = devices.filter((device) => device.interfaceName.toLowerCase().includes(normalized));
          }
          if (capability) {
            const normalized = capability.toLowerCase();
            devices = devices.filter((device) => device.capabilities.includes(normalized));
          }

          const totalMatched = devices.length;
          const cappedDevices = devices.slice(0, effectiveMaxDevices);
          const normalizedOffset = Math.max(0, Math.floor(typeof offset === 'number' ? offset : 0));
          const normalizedLimit = parseLimit(limit, 100, effectiveMaxDevices);
          const pagedItems = cappedDevices.slice(normalizedOffset, normalizedOffset + normalizedLimit);

          return {
            total: totalMatched,
            returned: pagedItems.length,
            maxDevices: effectiveMaxDevices,
            truncated: totalMatched > cappedDevices.length,
            offset: normalizedOffset,
            limit: normalizedLimit,
            includeRaw: Boolean(includeRaw),
            items: toDeviceOutput(pagedItems, Boolean(includeRaw))
          };
        }
      );
    }
  );

  server.registerTool(
    'hs4.devices.get',
    {
      description: 'Retrieve one or more devices by reference ID.',
      inputSchema: {
        refs: z.array(z.number().int()).min(1),
        includeControls: z.boolean().optional().default(false),
        includeRaw: z.boolean().optional().default(false),
        resolveChildren: z.boolean().optional().default(true),
        maxDevices: z.number().int().optional()
      }
    },
    async ({ refs, includeControls, includeRaw, resolveChildren, maxDevices }) => {
      return auditRead(
        'hs4.devices.get',
        'get_devices',
        { refs, includeControls, includeRaw, resolveChildren, maxDevices },
        async () => {
          const requestedRefs = normalizeRequestedRefs(refs);
          const effectiveMaxDevices = parseMaxDevices(maxDevices, defaultMaxDevices);
          const resolveChildrenEnabled = resolveChildren !== false;

          const payload = await getStatusPayload({
            compress: !includeControls,
            everything: includeControls || config.includeEverythingOnStatus,
            excludeevents: true
          });
          const snapshot = normalizeStatusPayload(payload);
          const devicesByRef = new Map<number, NormalizedDevice>();

          for (const device of snapshot.devices) {
            if (!devicesByRef.has(device.ref)) {
              devicesByRef.set(device.ref, device);
            }
          }

          const relatedByRef = new Map<number, Set<number>>();
          const linkRelated = (left: number, right: number): void => {
            if (left === right || !devicesByRef.has(left) || !devicesByRef.has(right)) {
              return;
            }
            const existing = relatedByRef.get(left);
            if (existing) {
              existing.add(right);
              return;
            }
            relatedByRef.set(left, new Set([right]));
          };

          for (const device of snapshot.devices) {
            for (const relatedRef of extractChildRefs(device)) {
              linkRelated(device.ref, relatedRef);
              linkRelated(relatedRef, device.ref);
            }
          }

          const found: number[] = [];
          const missing: number[] = [];
          const orderedRefs: number[] = [];
          const seenRefs = new Set<number>();

          for (const requestedRef of requestedRefs) {
            const root = devicesByRef.get(requestedRef);
            if (!root) {
              missing.push(requestedRef);
              continue;
            }

            found.push(requestedRef);
            if (!seenRefs.has(requestedRef)) {
              seenRefs.add(requestedRef);
              orderedRefs.push(requestedRef);
            }

            if (!resolveChildrenEnabled) {
              continue;
            }

            const relatedRefs = Array.from(relatedByRef.get(requestedRef) ?? []).sort((a, b) => a - b);
            for (const childRef of relatedRefs) {
              if (seenRefs.has(childRef)) {
                continue;
              }
              const child = devicesByRef.get(childRef);
              if (!child) {
                continue;
              }
              seenRefs.add(childRef);
              orderedRefs.push(childRef);
            }
          }

          const totalResolvedDevices = orderedRefs.length;
          const cappedRefs = orderedRefs.slice(0, effectiveMaxDevices);
          const resolvedItems = cappedRefs
            .map((ref) => devicesByRef.get(ref))
            .filter((device): device is NormalizedDevice => Boolean(device));

          return {
            requestedRefs,
            found,
            missing,
            includeRaw: Boolean(includeRaw),
            resolveChildren: resolveChildrenEnabled,
            maxDevices: effectiveMaxDevices,
            totalResolvedDevices,
            returnedDevices: resolvedItems.length,
            truncated: totalResolvedDevices > resolvedItems.length,
            resolvedRefs: resolvedItems.map((device) => device.ref),
            items: toDeviceOutput(resolvedItems, Boolean(includeRaw))
          };
        }
      );
    }
  );

  server.registerTool(
    'hs4.devices.controls.get',
    {
      description: 'Retrieve control pair metadata for one or more device refs.',
      inputSchema: {
        refs: z.array(z.number().int()).optional()
      }
    },
    async ({ refs }) => {
      return auditRead('hs4.devices.controls.get', 'get_controls', { refs }, async () => {
        const payload = await client.getControl2({
          ref: refs?.length ? refs.join(',') : undefined
        });
        return {
          refs: refs ?? null,
          raw: payload
        };
      });
    }
  );

  server.registerTool(
    'hs4.devices.status.get',
    {
      description: 'Fetch status snapshot for selected devices or full system.',
      inputSchema: {
        refs: z.array(z.number().int()).optional(),
        location1: z.string().optional(),
        location2: z.string().optional(),
        compress: z.boolean().optional().default(true),
        everything: z.boolean().optional().default(false),
        voiceonly: z.boolean().optional().default(false),
        excludeevents: z.boolean().optional().default(true),
        includeRaw: z.boolean().optional().default(false),
        maxDevices: z.number().int().optional(),
        fresh: z.boolean().optional().default(false)
      }
    },
    async ({ refs, location1, location2, compress, everything, voiceonly, excludeevents, includeRaw, maxDevices, fresh }) => {
      return auditRead(
        'hs4.devices.status.get',
        'get_status',
        {
          refs,
          location1,
          location2,
          compress,
          everything,
          voiceonly,
          excludeevents,
          includeRaw,
          maxDevices,
          fresh
        },
        async () => {
          const effectiveMaxDevices = parseMaxDevices(maxDevices, defaultMaxDevices);
          const statusRequest: StatusQueryParams = {
            ref: refs?.length ? refs.join(',') : undefined,
            location1,
            location2,
            compress,
            everything,
            voiceonly,
            excludeevents
          };

          const payload = await getStatusPayload(statusRequest, { fresh });

          const snapshot = normalizeStatusPayload(payload);
          const output = toSnapshotOutput(snapshot, {
            includeRaw: Boolean(includeRaw),
            maxDevices: effectiveMaxDevices
          });

          return {
            request: {
              refs,
              location1,
              location2,
              compress,
              everything,
              voiceonly,
              excludeevents,
              includeRaw: Boolean(includeRaw),
              maxDevices: effectiveMaxDevices,
              fresh: Boolean(fresh)
            },
            totalDevices: output.totalDevices,
            returnedDevices: output.returnedDevices,
            truncated: output.truncated,
            snapshot: output.snapshot
          };
        }
      );
    }
  );

  server.registerTool(
    'hs4.devices.set',
    {
      description:
        'Set a device state by control value (preferred) or setdevicestatus mode. Performs post-write verification by default and can auto-fallback to control_value when set_status does not converge.',
      inputSchema: {
        ref: z.number().int(),
        mode: z.enum(['control_value', 'set_status']).optional().default('control_value'),
        value: z.number().optional(),
        statusText: z.string().optional(),
        source: z.string().optional(),
        verify: z.boolean().optional().default(true),
        ...createGuardSchema()
      }
    },
    async (args) => {
      const target = { ref: args.ref, mode: args.mode };

      return auditMutation({
        tool: 'hs4.devices.set',
        action: 'set_device',
        guard: args,
        target,
        policyInput: {
          targetRefs: [args.ref]
        },
        execute: async () => {
          return executeDeviceSetMutation({
            ref: args.ref,
            mode: args.mode,
            value: args.value,
            statusText: args.statusText,
            source: args.source,
            verify: args.verify
          });
        }
      });
    }
  );

  server.registerTool(
    'hs4.events.list',
    {
      description: 'List HS4 events with optional group/name filters.',
      inputSchema: {
        groupContains: z.string().optional(),
        nameContains: z.string().optional(),
        limit: z.number().optional().default(500)
      }
    },
    async ({ groupContains, nameContains, limit }) => {
      return auditRead('hs4.events.list', 'list_events', { groupContains, nameContains }, async () => {
        const payload = await client.getEvents();
        let events = normalizeEventsPayload(payload);

        if (groupContains) {
          const normalized = groupContains.toLowerCase();
          events = events.filter((event) => event.group.toLowerCase().includes(normalized));
        }
        if (nameContains) {
          const normalized = nameContains.toLowerCase();
          events = events.filter((event) => event.name.toLowerCase().includes(normalized));
        }

        return {
          total: events.length,
          items: events.slice(0, parseLimit(limit, 500, 5_000))
        };
      });
    }
  );

  server.registerTool(
    'hs4.events.get',
    {
      description: 'Get a single HS4 event by id or exact group+name, including raw definition fields when available.',
      inputSchema: {
        id: z.number().int().optional(),
        group: z.string().optional(),
        name: z.string().optional(),
        includeRaw: z.boolean().optional().default(true)
      }
    },
    async ({ id, group, name, includeRaw }) => {
      if (!Number.isFinite(id) && !(group && name)) {
        return errorResult('BAD_REQUEST', 'Provide id, or provide both group and name.');
      }

      return auditRead('hs4.events.get', 'get_event', { id, group, name, includeRaw }, async () => {
        const payload = await client.getEvents();
        const events = normalizeEventsPayload(payload);

        let matchedBy: 'id' | 'group_name' = 'id';
        let event = events.find((entry) => Number.isFinite(id) && entry.id === (id as number));
        if (!event) {
          matchedBy = 'group_name';
          const normalizedGroup = (group ?? '').trim().toLowerCase();
          const normalizedName = (name ?? '').trim().toLowerCase();
          event = events.find(
            (entry) =>
              entry.group.trim().toLowerCase() === normalizedGroup && entry.name.trim().toLowerCase() === normalizedName
          );
        }

        if (!event) {
          throw new HS4McpError('BAD_REQUEST', 'Event not found.', {
            details: {
              id: Number.isFinite(id) ? id : undefined,
              group,
              name,
              totalEvents: events.length
            }
          });
        }

        return {
          matchedBy,
          id: event.id,
          group: event.group,
          name: event.name,
          voiceCommand: event.voiceCommand,
          voiceEnabled: event.voiceEnabled,
          details: summarizeEventRaw(event.raw),
          ...(includeRaw ? { raw: event.raw } : {})
        };
      });
    }
  );

  server.registerTool(
    'hs4.events.definition.get',
    {
      description:
        'Read and normalize full event definitions from persisted HS4 event files (triggers/actions/conditions).',
      inputSchema: {
        id: z.number().int().optional(),
        group: z.string().optional(),
        name: z.string().optional(),
        resolveDeviceRefs: z.boolean().optional().default(true),
        includeRaw: z.boolean().optional().default(false)
      }
    },
    async ({ id, group, name, resolveDeviceRefs, includeRaw }) => {
      if (!Number.isFinite(id) && !(group && name)) {
        return errorResult('BAD_REQUEST', 'Provide id, or provide both group and name.');
      }

      return auditRead(
        'hs4.events.definition.get',
        'get_event_definition',
        { id, group, name, resolveDeviceRefs, includeRaw },
        async () => {
          const eventsPath = config.hs4EventsDataPath;
          const eventGroupsPath = config.hs4EventGroupsDataPath;

          const [eventsPayload, eventsStats] = await Promise.all([
            readJsonFile(eventsPath, 'events'),
            stat(eventsPath).catch(() => null)
          ]);

          const warnings: Record<string, unknown>[] = [];
          let groupMap = new Map<number, string>();
          let groupsStats: Awaited<ReturnType<typeof stat>> | null = null;

          try {
            const [groupsPayload, groupFileStats] = await Promise.all([
              readJsonFile(eventGroupsPath, 'event-groups'),
              stat(eventGroupsPath).catch(() => null)
            ]);
            groupMap = parseEventGroupMap(groupsPayload);
            groupsStats = groupFileStats;
          } catch (error) {
            const hs4Error = asHS4McpError(error);
            logger.warn(
              { code: hs4Error.code, message: hs4Error.message, eventGroupsPath },
              'Unable to load event group file for persisted definition parsing.'
            );
            warnings.push({
              type: 'event_groups_unavailable',
              code: hs4Error.code,
              message: hs4Error.message,
              path: eventGroupsPath
            });
          }

          const events = parsePersistedEventsPayload(eventsPayload);
          const normalizedGroup = (group ?? '').trim().toLowerCase();
          const normalizedName = (name ?? '').trim().toLowerCase();

          let matchedBy: 'id' | 'group_name' = 'id';
          let matchedEvent = events.find((record) => Number.isFinite(id) && readPersistedEventId(record) === (id as number));
          if (!matchedEvent) {
            matchedBy = 'group_name';
            matchedEvent = events.find((record) => {
              const recordGroup = readPersistedEventGroup(record, groupMap).trim().toLowerCase();
              const recordName = readPersistedEventName(record).trim().toLowerCase();
              return recordGroup === normalizedGroup && recordName === normalizedName;
            });
          }

          if (!matchedEvent) {
            throw new HS4McpError('BAD_REQUEST', 'Event definition not found in persisted file.', {
              details: {
                id: Number.isFinite(id) ? id : undefined,
                group,
                name,
                eventsPath,
                totalEvents: events.length
              }
            });
          }

          const triggerSummary = summarizePersistedTriggers(matchedEvent, includeRaw);
          const actionsSummary = summarizePersistedConditionalActions(matchedEvent, includeRaw);
          const allRefs = Array.from(new Set([...triggerSummary.refs, ...actionsSummary.actionRefs])).sort(
            (left, right) => left - right
          );

          let resolvedDevices: Record<string, unknown>[] = [];
          if (resolveDeviceRefs && allRefs.length) {
            try {
              const statusPayload = await getStatusPayload(
                {
                  ref: allRefs.join(','),
                  compress: false,
                  everything: true,
                  excludeevents: true
                },
                { fresh: true }
              );
              const snapshot = normalizeStatusPayload(statusPayload);
              const byRef = new Map(snapshot.devices.map((device) => [device.ref, device]));
              resolvedDevices = allRefs.map((ref) => {
                const device = byRef.get(ref);
                if (!device) {
                  return { ref, found: false };
                }
                return {
                  ref: device.ref,
                  found: true,
                  name: device.name,
                  location: device.location,
                  location2: device.location2,
                  status: device.status,
                  value: device.value,
                  interfaceName: device.interfaceName,
                  capabilities: device.capabilities,
                  ...(includeRaw ? { raw: device.raw } : {})
                };
              });
            } catch (error) {
              const hs4Error = asHS4McpError(error);
              logger.warn(
                { code: hs4Error.code, message: hs4Error.message, refs: allRefs },
                'Unable to resolve event refs to devices.'
              );
              warnings.push({
                type: 'device_resolution_failed',
                code: hs4Error.code,
                message: hs4Error.message,
                refs: allRefs
              });
            }
          }

          const groupRef = readPersistedEventGroupRef(matchedEvent);
          const eventName = readPersistedEventName(matchedEvent);
          const eventGroup = readPersistedEventGroup(matchedEvent, groupMap);
          const triggerCount = triggerSummary.groups.reduce((sum, entry) => {
            const count = asOptionalNumber(entry.triggerCount);
            return sum + (count ?? 0);
          }, 0);

          return {
            matchedBy,
            source: {
              eventsPath,
              eventGroupsPath,
              eventsFileMtime: eventsStats?.mtime.toISOString() ?? null,
              eventGroupsFileMtime: groupsStats?.mtime.toISOString() ?? null,
              eventCount: events.length,
              eventGroupCount: groupMap.size
            },
            event: {
              id: readPersistedEventId(matchedEvent) ?? null,
              name: eventName || null,
              group: eventGroup || null,
              groupRef: Number.isFinite(groupRef) ? groupRef : null,
              type: asOptionalString(firstDefined(matchedEvent, ['sType', 'type'])) ?? null,
              lastTriggerTime:
                asOptionalString(firstDefined(matchedEvent, ['Last_Trigger_Time', 'lastTriggerTime'])) ?? null,
              voiceTag: asOptionalNumber(firstDefined(matchedEvent, ['Voice_Rec_Tag', 'voiceTag'])) ?? null
            },
            summary: {
              triggerGroupCount: triggerSummary.groups.length,
              triggerCount,
              actionBlockCount: actionsSummary.blocks.length,
              actionCount: actionsSummary.actionCount,
              conditionCount: actionsSummary.conditionCount
            },
            triggers: triggerSummary.groups,
            conditionalActions: actionsSummary.blocks,
            refs: {
              triggerDeviceRefs: triggerSummary.refs,
              actionDeviceRefs: actionsSummary.actionRefs,
              allDeviceRefs: allRefs
            },
            resolvedDevices,
            resolveDeviceRefs: Boolean(resolveDeviceRefs),
            ...(warnings.length ? { warnings } : {}),
            ...(includeRaw ? { raw: matchedEvent } : {})
          };
        }
      );
    }
  );

  server.registerTool(
    'hs4.events.run',
    {
      description: 'Run an HS4 event by id, or by group+name.',
      inputSchema: {
        id: z.number().int().optional(),
        group: z.string().optional(),
        name: z.string().optional(),
        ...createGuardSchema()
      }
    },
    async (args) => {
      if (!Number.isFinite(args.id) && !(args.group && args.name)) {
        return errorResult('BAD_REQUEST', 'Provide id, or provide both group and name.');
      }

      return auditMutation({
        tool: 'hs4.events.run',
        action: 'run_event',
        guard: args,
        target: {
          id: args.id,
          group: args.group,
          name: args.name
        },
        policyInput: {
          eventIds: Number.isFinite(args.id) ? [args.id as number] : undefined
        },
        execute: async () => {
          const raw = await client.runEvent({
            id: args.id,
            group: args.group,
            name: args.name
          });
          return {
            invoked: true,
            id: args.id,
            group: args.group,
            name: args.name,
            raw
          };
        }
      });
    }
  );

  server.registerTool(
    'hs4.scripts.run',
    {
      description:
        'Run a HomeSeer script command through runscript.html action handler. This is powerful and should be tightly allowlisted in production.',
      inputSchema: {
        command: z.string().min(1),
        ...createGuardSchema()
      }
    },
    async (args) => {
      return auditMutation({
        tool: 'hs4.scripts.run',
        action: 'run_script_command',
        guard: args,
        target: {
          command: args.command
        },
        policyInput: {
          scriptCommand: args.command
        },
        execute: async () => {
          const raw = await client.runScriptCommand(args.command);
          return {
            invoked: true,
            command: args.command,
            raw
          };
        }
      });
    }
  );

  server.registerTool(
    'hs4.plugins.function.call',
    {
      description: 'Call pluginfunction endpoint with positional P1..Pn parameters.',
      inputSchema: {
        plugin: z.string().min(1),
        functionName: z.string().min(1),
        instance: z.string().optional(),
        params: z.array(z.union([z.string(), z.number(), z.boolean()])).optional().default([]),
        ...createGuardSchema()
      }
    },
    async (args) => {
      const functionId = `${args.plugin}:${args.functionName}`.toLowerCase();

      return auditMutation({
        tool: 'hs4.plugins.function.call',
        action: 'plugin_function',
        guard: args,
        target: {
          plugin: args.plugin,
          functionName: args.functionName,
          instance: args.instance
        },
        policyInput: {
          pluginFunction: functionId
        },
        execute: async () => {
          const raw = await client.pluginFunction({
            plugin: args.plugin,
            functionName: args.functionName,
            instance: args.instance,
            params: args.params
          });

          return {
            invoked: true,
            plugin: args.plugin,
            functionName: args.functionName,
            instance: args.instance,
            params: args.params,
            raw
          };
        }
      });
    }
  );

  server.registerTool(
    'hs4.plugins.list',
    {
      description: 'List installed HS4 plugins and version/update metadata.'
    },
    async () => {
      return auditRead('hs4.plugins.list', 'list_plugins', {}, async () => {
        const payload = await client.getPluginList();
        return {
          plugins: normalizePluginListPayload(payload),
          raw: payload
        };
      });
    }
  );

  server.registerTool(
    'hs4.cameras.list',
    {
      description: 'List configured HS4 cameras.'
    },
    async () => {
      return auditRead('hs4.cameras.list', 'list_cameras', {}, async () => {
        const payload = await client.getCameras();
        return {
          cameras: normalizeCamerasPayload(payload),
          raw: payload
        };
      });
    }
  );

  server.registerTool(
    'hs4.cameras.snapshot.get',
    {
      description: 'Get camera snapshot payload for a camera ID.',
      inputSchema: {
        camId: z.number().int()
      }
    },
    async ({ camId }) => {
      return auditRead('hs4.cameras.snapshot.get', 'get_camera_snapshot', { camId }, async () => {
        const payload = await client.getCameraSnapshot(camId);
        return {
          camId,
          raw: payload
        };
      });
    }
  );

  server.registerTool(
    'hs4.cameras.pan',
    {
      description: 'Pan/tilt command for a camera via pancamera endpoint.',
      inputSchema: {
        camId: z.number().int(),
        direction: z.enum([
          'upstart',
          'upstop',
          'downstart',
          'downstop',
          'leftstart',
          'leftstop',
          'rightstart',
          'rightstop'
        ]),
        ...createGuardSchema()
      }
    },
    async (args) => {
      return auditMutation({
        tool: 'hs4.cameras.pan',
        action: 'pan_camera',
        guard: args,
        target: {
          camId: args.camId,
          direction: args.direction
        },
        policyInput: {
          cameraIds: [args.camId]
        },
        execute: async () => {
          const raw = await client.panCamera({
            camId: args.camId,
            direction: args.direction
          });
          return {
            applied: true,
            camId: args.camId,
            direction: args.direction,
            raw
          };
        }
      });
    }
  );

  server.registerTool(
    'hs4.audit.query',
    {
      description: 'Query in-memory/local audit log entries produced by MCP operations.',
      inputSchema: {
        tool: z.string().optional(),
        action: z.string().optional(),
        result: z.enum(['allowed', 'blocked', 'success', 'error', 'dry_run']).optional(),
        since: z.string().optional(),
        limit: z.number().optional().default(100)
      }
    },
    async ({ tool, action, result, since, limit }) => {
      return auditRead('hs4.audit.query', 'query_audit', { tool, action, result, since, limit }, async () => {
        return {
          entries: audit.query({
            tool,
            action,
            result: result as AuditResult | undefined,
            since,
            limit: parseLimit(limit, 100, 10_000)
          })
        };
      });
    }
  );

  server.registerTool(
    'hs4.admin.users.list',
    {
      description: 'List HS4 users in the admin namespace.',
      inputSchema: {
        includeDisabled: z.boolean().optional().default(true),
        limit: z.number().int().optional().default(200)
      }
    },
    async ({ includeDisabled, limit }) => {
      return auditRead(
        'hs4.admin.users.list',
        'admin_users_list',
        { includeDisabled, limit },
        async () => {
          const effectiveLimit = parseLimit(limit, 200, 5_000);
          const raw = await client.runScriptCommand(
            buildAdminScriptCommand('users', 'list', {
              includeDisabled: Boolean(includeDisabled),
              limit: effectiveLimit
            })
          );
          return {
            includeDisabled: Boolean(includeDisabled),
            limit: effectiveLimit,
            raw
          };
        }
      );
    }
  );

  server.registerTool(
    'hs4.admin.users.create',
    {
      description: 'Create a user account through admin controls.',
      inputSchema: {
        username: z.string().min(1),
        password: z.string().min(1).optional(),
        displayName: z.string().optional(),
        email: z.string().optional(),
        role: z.string().optional(),
        enabled: z.boolean().optional().default(true),
        ...createAdminGuardSchema('users')
      }
    },
    async (args) => {
      const payload = stripAdminGuardFields(args as Record<string, unknown>);
      return auditMutation({
        tool: 'hs4.admin.users.create',
        action: 'admin_users_create',
        guard: args,
        target: {
          username: args.username
        },
        policyInput: buildAdminPolicyInput(args, {
          targetIds: [args.username]
        }),
        adminMutation: {
          enabled: true,
          requireChangeTicket: adminChangeTicketRequired
        },
        execute: async () =>
          executeAdminScriptMutation({
            domain: 'users',
            action: 'create',
            payload
          })
      });
    }
  );

  server.registerTool(
    'hs4.admin.users.update',
    {
      description: 'Update an existing user account through admin controls.',
      inputSchema: {
        userId: z.union([z.number().int(), z.string().min(1)]),
        displayName: z.string().optional(),
        email: z.string().optional(),
        password: z.string().min(1).optional(),
        enabled: z.boolean().optional(),
        role: z.string().optional(),
        ...createAdminGuardSchema('users')
      }
    },
    async (args) => {
      const payload = stripAdminGuardFields(args as Record<string, unknown>);
      return auditMutation({
        tool: 'hs4.admin.users.update',
        action: 'admin_users_update',
        guard: args,
        target: {
          userId: args.userId
        },
        policyInput: buildAdminPolicyInput(args, {
          targetIds: [args.userId]
        }),
        adminMutation: {
          enabled: true,
          requireChangeTicket: adminChangeTicketRequired
        },
        execute: async () =>
          executeAdminScriptMutation({
            domain: 'users',
            action: 'update',
            payload
          })
      });
    }
  );

  server.registerTool(
    'hs4.admin.users.delete',
    {
      description: 'Delete a user account through admin controls.',
      inputSchema: {
        userId: z.union([z.number().int(), z.string().min(1)]),
        hardDelete: z.boolean().optional().default(false),
        ...createAdminGuardSchema('users')
      }
    },
    async (args) => {
      const payload = stripAdminGuardFields(args as Record<string, unknown>);
      return auditMutation({
        tool: 'hs4.admin.users.delete',
        action: 'admin_users_delete',
        guard: args,
        target: {
          userId: args.userId
        },
        policyInput: buildAdminPolicyInput(args, {
          targetIds: [args.userId]
        }),
        adminMutation: {
          enabled: true,
          requireChangeTicket: adminChangeTicketRequired
        },
        execute: async () =>
          executeAdminScriptMutation({
            domain: 'users',
            action: 'delete',
            payload
          })
      });
    }
  );

  server.registerTool(
    'hs4.admin.users.set_role',
    {
      description: 'Set the role for a user account through admin controls.',
      inputSchema: {
        userId: z.union([z.number().int(), z.string().min(1)]),
        role: z.string().min(1),
        ...createAdminGuardSchema('users')
      }
    },
    async (args) => {
      const payload = stripAdminGuardFields(args as Record<string, unknown>);
      return auditMutation({
        tool: 'hs4.admin.users.set_role',
        action: 'admin_users_set_role',
        guard: args,
        target: {
          userId: args.userId,
          role: args.role
        },
        policyInput: buildAdminPolicyInput(args, {
          targetIds: [args.userId]
        }),
        adminMutation: {
          enabled: true,
          requireChangeTicket: adminChangeTicketRequired
        },
        execute: async () =>
          executeAdminScriptMutation({
            domain: 'users',
            action: 'set_role',
            payload
          })
      });
    }
  );

  server.registerTool(
    'hs4.admin.plugins.catalog.get',
    {
      description: 'Get plugin catalog/install metadata in the admin namespace.',
      inputSchema: {
        includeRaw: z.boolean().optional().default(false)
      }
    },
    async ({ includeRaw }) => {
      return auditRead(
        'hs4.admin.plugins.catalog.get',
        'admin_plugins_catalog_get',
        { includeRaw },
        async () => {
          const raw = await client.getPluginList();
          const plugins = normalizePluginListPayload(raw);
          return {
            plugins,
            ...(includeRaw ? { raw } : {})
          };
        }
      );
    }
  );

  server.registerTool(
    'hs4.admin.plugins.install',
    {
      description: 'Install a plugin through admin controls.',
      inputSchema: {
        pluginId: z.string().min(1),
        version: z.string().optional(),
        source: z.string().optional(),
        ...createAdminGuardSchema('plugins')
      }
    },
    async (args) => {
      const payload = stripAdminGuardFields(args as Record<string, unknown>);
      return auditMutation({
        tool: 'hs4.admin.plugins.install',
        action: 'admin_plugins_install',
        guard: args,
        target: {
          pluginId: args.pluginId,
          version: args.version
        },
        policyInput: buildAdminPolicyInput(args, {
          targetIds: [args.pluginId]
        }),
        adminMutation: {
          enabled: true,
          requireChangeTicket: adminChangeTicketRequired
        },
        execute: async () =>
          executeAdminScriptMutation({
            domain: 'plugins',
            action: 'install',
            payload,
            before: async () => normalizePluginListPayload(await client.getPluginList()),
            after: async () => normalizePluginListPayload(await client.getPluginList())
          })
      });
    }
  );

  server.registerTool(
    'hs4.admin.plugins.update',
    {
      description: 'Update a plugin through admin controls.',
      inputSchema: {
        pluginId: z.string().min(1),
        targetVersion: z.string().optional(),
        ...createAdminGuardSchema('plugins')
      }
    },
    async (args) => {
      const payload = stripAdminGuardFields(args as Record<string, unknown>);
      return auditMutation({
        tool: 'hs4.admin.plugins.update',
        action: 'admin_plugins_update',
        guard: args,
        target: {
          pluginId: args.pluginId,
          targetVersion: args.targetVersion
        },
        policyInput: buildAdminPolicyInput(args, {
          targetIds: [args.pluginId]
        }),
        adminMutation: {
          enabled: true,
          requireChangeTicket: adminChangeTicketRequired
        },
        execute: async () =>
          executeAdminScriptMutation({
            domain: 'plugins',
            action: 'update',
            payload,
            before: async () => normalizePluginListPayload(await client.getPluginList()),
            after: async () => normalizePluginListPayload(await client.getPluginList())
          })
      });
    }
  );

  server.registerTool(
    'hs4.admin.plugins.remove',
    {
      description: 'Remove a plugin through admin controls.',
      inputSchema: {
        pluginId: z.string().min(1),
        ...createAdminGuardSchema('plugins')
      }
    },
    async (args) => {
      const payload = stripAdminGuardFields(args as Record<string, unknown>);
      return auditMutation({
        tool: 'hs4.admin.plugins.remove',
        action: 'admin_plugins_remove',
        guard: args,
        target: {
          pluginId: args.pluginId
        },
        policyInput: buildAdminPolicyInput(args, {
          targetIds: [args.pluginId]
        }),
        adminMutation: {
          enabled: true,
          requireChangeTicket: adminChangeTicketRequired
        },
        execute: async () =>
          executeAdminScriptMutation({
            domain: 'plugins',
            action: 'remove',
            payload,
            before: async () => normalizePluginListPayload(await client.getPluginList()),
            after: async () => normalizePluginListPayload(await client.getPluginList())
          })
      });
    }
  );

  server.registerTool(
    'hs4.admin.plugins.set_enabled',
    {
      description: 'Enable or disable a plugin through admin controls.',
      inputSchema: {
        pluginId: z.string().min(1),
        enabled: z.boolean(),
        ...createAdminGuardSchema('plugins')
      }
    },
    async (args) => {
      const payload = stripAdminGuardFields(args as Record<string, unknown>);
      return auditMutation({
        tool: 'hs4.admin.plugins.set_enabled',
        action: 'admin_plugins_set_enabled',
        guard: args,
        target: {
          pluginId: args.pluginId,
          enabled: args.enabled
        },
        policyInput: buildAdminPolicyInput(args, {
          targetIds: [args.pluginId]
        }),
        adminMutation: {
          enabled: true,
          requireChangeTicket: adminChangeTicketRequired
        },
        execute: async () =>
          executeAdminScriptMutation({
            domain: 'plugins',
            action: 'set_enabled',
            payload,
            before: async () => normalizePluginListPayload(await client.getPluginList()),
            after: async () => normalizePluginListPayload(await client.getPluginList())
          })
      });
    }
  );

  server.registerTool(
    'hs4.admin.plugins.restart',
    {
      description: 'Restart a plugin through admin controls.',
      inputSchema: {
        pluginId: z.string().min(1),
        instance: z.string().optional(),
        ...createAdminGuardSchema('plugins')
      }
    },
    async (args) => {
      const payload = stripAdminGuardFields(args as Record<string, unknown>);
      return auditMutation({
        tool: 'hs4.admin.plugins.restart',
        action: 'admin_plugins_restart',
        guard: args,
        target: {
          pluginId: args.pluginId,
          instance: args.instance
        },
        policyInput: buildAdminPolicyInput(args, {
          targetIds: [args.pluginId, ...(args.instance ? [args.instance] : [])]
        }),
        adminMutation: {
          enabled: true,
          requireChangeTicket: adminChangeTicketRequired
        },
        execute: async () =>
          executeAdminScriptMutation({
            domain: 'plugins',
            action: 'restart',
            payload
          })
      });
    }
  );

  server.registerTool(
    'hs4.admin.interfaces.list',
    {
      description: 'List interfaces derived from HS4 status metadata.',
      inputSchema: {
        includeRefs: z.boolean().optional().default(true)
      }
    },
    async ({ includeRefs }) => {
      return auditRead('hs4.admin.interfaces.list', 'admin_interfaces_list', { includeRefs }, async () => {
        const summary = await getInterfaceSummary();
        return {
          generatedAt: summary.generatedAt,
          totalInterfaces: summary.totalInterfaces,
          interfaces: includeRefs
            ? summary.interfaces
            : summary.interfaces.map((item) => ({
                interfaceName: item.interfaceName,
                deviceCount: item.deviceCount
              }))
        };
      });
    }
  );

  server.registerTool(
    'hs4.admin.interfaces.add',
    {
      description: 'Add an interface through admin controls.',
      inputSchema: {
        interfaceType: z.string().min(1),
        interfaceName: z.string().min(1),
        settings: z.record(z.string(), z.unknown()).optional(),
        ...createAdminGuardSchema('interfaces')
      }
    },
    async (args) => {
      const payload = stripAdminGuardFields(args as Record<string, unknown>);
      return auditMutation({
        tool: 'hs4.admin.interfaces.add',
        action: 'admin_interfaces_add',
        guard: args,
        target: {
          interfaceName: args.interfaceName,
          interfaceType: args.interfaceType
        },
        policyInput: buildAdminPolicyInput(args, {
          targetIds: [args.interfaceName]
        }),
        adminMutation: {
          enabled: true,
          requireChangeTicket: adminChangeTicketRequired
        },
        execute: async () =>
          executeAdminScriptMutation({
            domain: 'interfaces',
            action: 'add',
            payload,
            before: async () => getInterfaceSummary(),
            after: async () => getInterfaceSummary()
          })
      });
    }
  );

  server.registerTool(
    'hs4.admin.interfaces.update',
    {
      description: 'Update an interface through admin controls.',
      inputSchema: {
        interfaceId: z.union([z.number().int(), z.string().min(1)]),
        interfaceName: z.string().optional(),
        settings: z.record(z.string(), z.unknown()).optional(),
        ...createAdminGuardSchema('interfaces')
      }
    },
    async (args) => {
      const payload = stripAdminGuardFields(args as Record<string, unknown>);
      return auditMutation({
        tool: 'hs4.admin.interfaces.update',
        action: 'admin_interfaces_update',
        guard: args,
        target: {
          interfaceId: args.interfaceId,
          interfaceName: args.interfaceName
        },
        policyInput: buildAdminPolicyInput(args, {
          targetIds: [args.interfaceId]
        }),
        adminMutation: {
          enabled: true,
          requireChangeTicket: adminChangeTicketRequired
        },
        execute: async () =>
          executeAdminScriptMutation({
            domain: 'interfaces',
            action: 'update',
            payload,
            before: async () => getInterfaceSummary(),
            after: async () => getInterfaceSummary()
          })
      });
    }
  );

  server.registerTool(
    'hs4.admin.interfaces.remove',
    {
      description: 'Remove an interface through admin controls.',
      inputSchema: {
        interfaceId: z.union([z.number().int(), z.string().min(1)]),
        ...createAdminGuardSchema('interfaces')
      }
    },
    async (args) => {
      const payload = stripAdminGuardFields(args as Record<string, unknown>);
      return auditMutation({
        tool: 'hs4.admin.interfaces.remove',
        action: 'admin_interfaces_remove',
        guard: args,
        target: {
          interfaceId: args.interfaceId
        },
        policyInput: buildAdminPolicyInput(args, {
          targetIds: [args.interfaceId]
        }),
        adminMutation: {
          enabled: true,
          requireChangeTicket: adminChangeTicketRequired
        },
        execute: async () =>
          executeAdminScriptMutation({
            domain: 'interfaces',
            action: 'remove',
            payload,
            before: async () => getInterfaceSummary(),
            after: async () => getInterfaceSummary()
          })
      });
    }
  );

  server.registerTool(
    'hs4.admin.interfaces.restart',
    {
      description: 'Restart an interface through admin controls.',
      inputSchema: {
        interfaceId: z.union([z.number().int(), z.string().min(1)]),
        ...createAdminGuardSchema('interfaces')
      }
    },
    async (args) => {
      const payload = stripAdminGuardFields(args as Record<string, unknown>);
      return auditMutation({
        tool: 'hs4.admin.interfaces.restart',
        action: 'admin_interfaces_restart',
        guard: args,
        target: {
          interfaceId: args.interfaceId
        },
        policyInput: buildAdminPolicyInput(args, {
          targetIds: [args.interfaceId]
        }),
        adminMutation: {
          enabled: true,
          requireChangeTicket: adminChangeTicketRequired
        },
        execute: async () =>
          executeAdminScriptMutation({
            domain: 'interfaces',
            action: 'restart',
            payload
          })
      });
    }
  );

  server.registerTool(
    'hs4.admin.interfaces.diagnostics',
    {
      description: 'Collect interface diagnostics through the admin namespace.',
      inputSchema: {
        interfaceId: z.union([z.number().int(), z.string().min(1)]).optional(),
        level: z.enum(['basic', 'full']).optional().default('basic')
      }
    },
    async ({ interfaceId, level }) => {
      return auditRead(
        'hs4.admin.interfaces.diagnostics',
        'admin_interfaces_diagnostics',
        { interfaceId, level },
        async () => {
          const raw = await client.runScriptCommand(
            buildAdminScriptCommand('interfaces', 'diagnostics', {
              interfaceId: interfaceId ?? null,
              level
            })
          );
          return {
            interfaceId: interfaceId ?? null,
            level,
            raw
          };
        }
      );
    }
  );

  server.registerTool(
    'hs4.admin.system.backup.start',
    {
      description: 'Start a system backup workflow through admin controls.',
      inputSchema: {
        label: z.string().optional(),
        includeMedia: z.boolean().optional().default(true),
        ...createAdminGuardSchema('system')
      }
    },
    async (args) => {
      const payload = stripAdminGuardFields(args as Record<string, unknown>);
      return auditMutation({
        tool: 'hs4.admin.system.backup.start',
        action: 'admin_system_backup_start',
        guard: args,
        target: {
          label: args.label ?? null
        },
        policyInput: buildAdminPolicyInput(args, {
          targetIds: args.label ? [args.label] : []
        }),
        adminMutation: {
          enabled: true,
          requireChangeTicket: adminChangeTicketRequired
        },
        execute: async () =>
          executeAdminScriptMutation({
            domain: 'system',
            action: 'backup.start',
            payload,
            rollback: 'not_needed'
          })
      });
    }
  );

  server.registerTool(
    'hs4.admin.system.restore.start',
    {
      description: 'Start a system restore workflow through admin controls.',
      inputSchema: {
        backupId: z.string().min(1),
        verifyOnly: z.boolean().optional().default(false),
        ...createAdminGuardSchema('system')
      }
    },
    async (args) => {
      const payload = stripAdminGuardFields(args as Record<string, unknown>);
      return auditMutation({
        tool: 'hs4.admin.system.restore.start',
        action: 'admin_system_restore_start',
        guard: args,
        target: {
          backupId: args.backupId,
          verifyOnly: args.verifyOnly
        },
        policyInput: buildAdminPolicyInput(args, {
          targetIds: [args.backupId]
        }),
        adminMutation: {
          enabled: true,
          requireChangeTicket: adminChangeTicketRequired
        },
        execute: async () =>
          executeAdminScriptMutation({
            domain: 'system',
            action: 'restore.start',
            payload,
            rollback: 'available'
          })
      });
    }
  );

  server.registerTool(
    'hs4.admin.system.service.restart',
    {
      description: 'Restart an HS4 service through admin controls.',
      inputSchema: {
        service: z.string().min(1).default('hs4'),
        ...createAdminGuardSchema('system')
      }
    },
    async (args) => {
      const payload = stripAdminGuardFields(args as Record<string, unknown>);
      return auditMutation({
        tool: 'hs4.admin.system.service.restart',
        action: 'admin_system_service_restart',
        guard: args,
        target: {
          service: args.service
        },
        policyInput: buildAdminPolicyInput(args, {
          targetIds: [args.service]
        }),
        adminMutation: {
          enabled: true,
          requireChangeTicket: adminChangeTicketRequired
        },
        execute: async () =>
          executeAdminScriptMutation({
            domain: 'system',
            action: 'service.restart',
            payload
          })
      });
    }
  );

  server.registerTool(
    'hs4.admin.system.shutdown',
    {
      description: 'Issue a controlled system shutdown through admin controls.',
      inputSchema: {
        graceSeconds: z.number().int().optional().default(30),
        ...createAdminGuardSchema('system')
      }
    },
    async (args) => {
      const payload = stripAdminGuardFields(args as Record<string, unknown>);
      return auditMutation({
        tool: 'hs4.admin.system.shutdown',
        action: 'admin_system_shutdown',
        guard: args,
        target: {
          graceSeconds: args.graceSeconds
        },
        policyInput: buildAdminPolicyInput(args),
        adminMutation: {
          enabled: true,
          requireChangeTicket: adminChangeTicketRequired
        },
        execute: async () =>
          executeAdminScriptMutation({
            domain: 'system',
            action: 'shutdown',
            payload,
            rollback: 'not_needed'
          })
      });
    }
  );

  server.registerTool(
    'hs4.admin.system.config.get',
    {
      description: 'Read system-level configuration state through the admin namespace.',
      inputSchema: {
        includeStatusSummary: z.boolean().optional().default(true)
      }
    },
    async ({ includeStatusSummary }) => {
      return auditRead(
        'hs4.admin.system.config.get',
        'admin_system_config_get',
        { includeStatusSummary },
        async () => {
          const version = await client.getVersion();
          const payload = includeStatusSummary
            ? await getStatusPayload({
                compress: true,
                everything: false,
                excludeevents: true
              })
            : null;

          return {
            hs4Version: version,
            policy: {
              requireConfirm: config.requireConfirm,
              defaultDryRun: config.defaultDryRun,
              safeMode: config.safeMode
            },
            statusSummary:
              payload === null
                ? null
                : (() => {
                    const snapshot = normalizeStatusPayload(payload);
                    return {
                      name: snapshot.name,
                      version: snapshot.version,
                      devices: snapshot.devices.length
                    };
                  })()
          };
        }
      );
    }
  );

  server.registerTool(
    'hs4.admin.system.config.set',
    {
      description: 'Apply system-level config settings through admin controls.',
      inputSchema: {
        key: z.string().min(1),
        value: z.union([z.string(), z.number(), z.boolean()]),
        ...createAdminGuardSchema('system')
      }
    },
    async (args) => {
      const payload = stripAdminGuardFields(args as Record<string, unknown>);
      return auditMutation({
        tool: 'hs4.admin.system.config.set',
        action: 'admin_system_config_set',
        guard: args,
        target: {
          key: args.key
        },
        policyInput: buildAdminPolicyInput(args, {
          targetIds: [args.key]
        }),
        adminMutation: {
          enabled: true,
          requireChangeTicket: adminChangeTicketRequired
        },
        execute: async () =>
          executeAdminScriptMutation({
            domain: 'system',
            action: 'config.set',
            payload
          })
      });
    }
  );

  server.registerTool(
    'hs4.admin.cameras.config.list',
    {
      description: 'List camera configuration state in the admin namespace.',
      inputSchema: {
        includeRaw: z.boolean().optional().default(false)
      }
    },
    async ({ includeRaw }) => {
      return auditRead(
        'hs4.admin.cameras.config.list',
        'admin_cameras_config_list',
        { includeRaw },
        async () => {
          const raw = await client.getCameras();
          const cameras = normalizeCamerasPayload(raw);
          return {
            cameras,
            ...(includeRaw ? { raw } : {})
          };
        }
      );
    }
  );

  server.registerTool(
    'hs4.admin.cameras.config.create',
    {
      description: 'Create a camera config through admin controls.',
      inputSchema: {
        name: z.string().min(1),
        streamUrl: z.string().min(1),
        profile: z.string().optional(),
        ...createAdminGuardSchema('cameras')
      }
    },
    async (args) => {
      const payload = stripAdminGuardFields(args as Record<string, unknown>);
      return auditMutation({
        tool: 'hs4.admin.cameras.config.create',
        action: 'admin_cameras_config_create',
        guard: args,
        target: {
          name: args.name
        },
        policyInput: buildAdminPolicyInput(args, {
          targetIds: [args.name]
        }),
        adminMutation: {
          enabled: true,
          requireChangeTicket: adminChangeTicketRequired
        },
        execute: async () =>
          executeAdminScriptMutation({
            domain: 'cameras',
            action: 'config.create',
            payload,
            before: async () => normalizeCamerasPayload(await client.getCameras()),
            after: async () => normalizeCamerasPayload(await client.getCameras())
          })
      });
    }
  );

  server.registerTool(
    'hs4.admin.cameras.config.update',
    {
      description: 'Update a camera config through admin controls.',
      inputSchema: {
        camId: z.number().int(),
        name: z.string().optional(),
        streamUrl: z.string().optional(),
        profile: z.string().optional(),
        ...createAdminGuardSchema('cameras')
      }
    },
    async (args) => {
      const payload = stripAdminGuardFields(args as Record<string, unknown>);
      return auditMutation({
        tool: 'hs4.admin.cameras.config.update',
        action: 'admin_cameras_config_update',
        guard: args,
        target: {
          camId: args.camId
        },
        policyInput: buildAdminPolicyInput(args, {
          cameraIds: [args.camId],
          targetIds: [args.camId]
        }),
        adminMutation: {
          enabled: true,
          requireChangeTicket: adminChangeTicketRequired
        },
        execute: async () =>
          executeAdminScriptMutation({
            domain: 'cameras',
            action: 'config.update',
            payload,
            before: async () => normalizeCamerasPayload(await client.getCameras()),
            after: async () => normalizeCamerasPayload(await client.getCameras())
          })
      });
    }
  );

  server.registerTool(
    'hs4.admin.cameras.config.delete',
    {
      description: 'Delete a camera config through admin controls.',
      inputSchema: {
        camId: z.number().int(),
        ...createAdminGuardSchema('cameras')
      }
    },
    async (args) => {
      const payload = stripAdminGuardFields(args as Record<string, unknown>);
      return auditMutation({
        tool: 'hs4.admin.cameras.config.delete',
        action: 'admin_cameras_config_delete',
        guard: args,
        target: {
          camId: args.camId
        },
        policyInput: buildAdminPolicyInput(args, {
          cameraIds: [args.camId],
          targetIds: [args.camId]
        }),
        adminMutation: {
          enabled: true,
          requireChangeTicket: adminChangeTicketRequired
        },
        execute: async () =>
          executeAdminScriptMutation({
            domain: 'cameras',
            action: 'config.delete',
            payload,
            before: async () => normalizeCamerasPayload(await client.getCameras()),
            after: async () => normalizeCamerasPayload(await client.getCameras())
          })
      });
    }
  );

  server.registerTool(
    'hs4.admin.cameras.stream_profile.set',
    {
      description: 'Set a camera stream profile through admin controls.',
      inputSchema: {
        camId: z.number().int(),
        profile: z.string().min(1),
        ...createAdminGuardSchema('cameras')
      }
    },
    async (args) => {
      const payload = stripAdminGuardFields(args as Record<string, unknown>);
      return auditMutation({
        tool: 'hs4.admin.cameras.stream_profile.set',
        action: 'admin_cameras_stream_profile_set',
        guard: args,
        target: {
          camId: args.camId,
          profile: args.profile
        },
        policyInput: buildAdminPolicyInput(args, {
          cameraIds: [args.camId],
          targetIds: [args.camId, args.profile]
        }),
        adminMutation: {
          enabled: true,
          requireChangeTicket: adminChangeTicketRequired
        },
        execute: async () =>
          executeAdminScriptMutation({
            domain: 'cameras',
            action: 'stream_profile.set',
            payload
          })
      });
    }
  );

  server.registerTool(
    'hs4.admin.cameras.recording.set',
    {
      description: 'Set a camera recording state through admin controls.',
      inputSchema: {
        camId: z.number().int(),
        enabled: z.boolean(),
        retentionDays: z.number().int().optional(),
        ...createAdminGuardSchema('cameras')
      }
    },
    async (args) => {
      const payload = stripAdminGuardFields(args as Record<string, unknown>);
      return auditMutation({
        tool: 'hs4.admin.cameras.recording.set',
        action: 'admin_cameras_recording_set',
        guard: args,
        target: {
          camId: args.camId,
          enabled: args.enabled
        },
        policyInput: buildAdminPolicyInput(args, {
          cameraIds: [args.camId],
          targetIds: [args.camId]
        }),
        adminMutation: {
          enabled: true,
          requireChangeTicket: adminChangeTicketRequired
        },
        execute: async () =>
          executeAdminScriptMutation({
            domain: 'cameras',
            action: 'recording.set',
            payload
          })
      });
    }
  );

  server.registerTool(
    'hs4.admin.events.create',
    {
      description: 'Create an event definition through admin controls.',
      inputSchema: {
        group: z.string().min(1),
        name: z.string().min(1),
        definition: z.record(z.string(), z.unknown()).optional(),
        ...createAdminGuardSchema('events')
      }
    },
    async (args) => {
      const payload = stripAdminGuardFields(args as Record<string, unknown>);
      return auditMutation({
        tool: 'hs4.admin.events.create',
        action: 'admin_events_create',
        guard: args,
        target: {
          group: args.group,
          name: args.name
        },
        policyInput: buildAdminPolicyInput(args, {
          targetIds: [`${args.group}:${args.name}`]
        }),
        adminMutation: {
          enabled: true,
          requireChangeTicket: adminChangeTicketRequired
        },
        execute: async () =>
          executeAdminScriptMutation({
            domain: 'events',
            action: 'create',
            payload,
            before: async () => normalizeEventsPayload(await client.getEvents()),
            after: async () => normalizeEventsPayload(await client.getEvents())
          })
      });
    }
  );

  server.registerTool(
    'hs4.admin.events.update',
    {
      description: 'Update an event definition through admin controls.',
      inputSchema: {
        eventId: z.number().int().optional(),
        group: z.string().optional(),
        name: z.string().optional(),
        definition: z.record(z.string(), z.unknown()).optional(),
        ...createAdminGuardSchema('events')
      }
    },
    async (args) => {
      if (!Number.isFinite(args.eventId) && !(args.group && args.name)) {
        return errorResult('BAD_REQUEST', 'Provide eventId, or provide both group and name for updates.');
      }

      const payload = stripAdminGuardFields(args as Record<string, unknown>);
      const eventIds = Number.isFinite(args.eventId) ? [args.eventId as number] : undefined;
      return auditMutation({
        tool: 'hs4.admin.events.update',
        action: 'admin_events_update',
        guard: args,
        target: {
          eventId: args.eventId ?? null,
          group: args.group ?? null,
          name: args.name ?? null
        },
        policyInput: buildAdminPolicyInput(args, {
          eventIds,
          targetIds: Number.isFinite(args.eventId)
            ? [args.eventId as number]
            : args.group && args.name
              ? [`${args.group}:${args.name}`]
              : []
        }),
        adminMutation: {
          enabled: true,
          requireChangeTicket: adminChangeTicketRequired
        },
        execute: async () =>
          executeAdminScriptMutation({
            domain: 'events',
            action: 'update',
            payload,
            before: async () => normalizeEventsPayload(await client.getEvents()),
            after: async () => normalizeEventsPayload(await client.getEvents())
          })
      });
    }
  );

  server.registerTool(
    'hs4.admin.events.delete',
    {
      description: 'Delete an event definition through admin controls.',
      inputSchema: {
        eventId: z.number().int().optional(),
        group: z.string().optional(),
        name: z.string().optional(),
        ...createAdminGuardSchema('events')
      }
    },
    async (args) => {
      if (!Number.isFinite(args.eventId) && !(args.group && args.name)) {
        return errorResult('BAD_REQUEST', 'Provide eventId, or provide both group and name for deletes.');
      }

      const payload = stripAdminGuardFields(args as Record<string, unknown>);
      const eventIds = Number.isFinite(args.eventId) ? [args.eventId as number] : undefined;
      return auditMutation({
        tool: 'hs4.admin.events.delete',
        action: 'admin_events_delete',
        guard: args,
        target: {
          eventId: args.eventId ?? null,
          group: args.group ?? null,
          name: args.name ?? null
        },
        policyInput: buildAdminPolicyInput(args, {
          eventIds,
          targetIds: Number.isFinite(args.eventId)
            ? [args.eventId as number]
            : args.group && args.name
              ? [`${args.group}:${args.name}`]
              : []
        }),
        adminMutation: {
          enabled: true,
          requireChangeTicket: adminChangeTicketRequired
        },
        execute: async () =>
          executeAdminScriptMutation({
            domain: 'events',
            action: 'delete',
            payload,
            before: async () => normalizeEventsPayload(await client.getEvents()),
            after: async () => normalizeEventsPayload(await client.getEvents())
          })
      });
    }
  );

  server.registerTool(
    'hs4.admin.config.device_metadata.set',
    {
      description: 'Set a device metadata property through admin controls.',
      inputSchema: {
        ref: z.number().int(),
        property: z.string().min(1),
        value: z.string().min(1),
        ...createAdminGuardSchema('config')
      }
    },
    async (args) => {
      const payload = stripAdminGuardFields(args as Record<string, unknown>);
      return auditMutation({
        tool: 'hs4.admin.config.device_metadata.set',
        action: 'admin_config_device_metadata_set',
        guard: args,
        target: {
          ref: args.ref,
          property: args.property
        },
        policyInput: buildAdminPolicyInput(args, {
          targetRefs: [args.ref],
          targetIds: [args.ref, args.property]
        }),
        adminMutation: {
          enabled: true,
          requireChangeTicket: adminChangeTicketRequired
        },
        execute: async () =>
          executeAdminScriptMutation({
            domain: 'config',
            action: 'device_metadata.set',
            payload,
            before: async () =>
              normalizeStatusPayload(
                await getStatusPayload(
                  {
                    ref: String(args.ref),
                    compress: false,
                    everything: true,
                    excludeevents: true
                  },
                  { fresh: true }
                )
              ),
            after: async () =>
              normalizeStatusPayload(
                await getStatusPayload(
                  {
                    ref: String(args.ref),
                    compress: false,
                    everything: true,
                    excludeevents: true
                  },
                  { fresh: true }
                )
              )
          })
      });
    }
  );

  server.registerTool(
    'hs4.admin.config.categories.list',
    {
      description: 'List inferred category/room metadata through the admin namespace.',
      inputSchema: {
        includeRefs: z.boolean().optional().default(true)
      }
    },
    async ({ includeRefs }) => {
      return auditRead(
        'hs4.admin.config.categories.list',
        'admin_config_categories_list',
        { includeRefs },
        async () => {
          const summary = await getCategorySummary();
          return {
            generatedAt: summary.generatedAt,
            categories: includeRefs
              ? summary.categories
              : summary.categories.map((item) => ({
                  category: item.category,
                  rooms: item.rooms
                }))
          };
        }
      );
    }
  );

  server.registerTool(
    'hs4.admin.config.category.upsert',
    {
      description: 'Create or update a category through admin controls.',
      inputSchema: {
        category: z.string().min(1),
        rooms: z.array(z.string().min(1)).optional().default([]),
        ...createAdminGuardSchema('config')
      }
    },
    async (args) => {
      const payload = stripAdminGuardFields(args as Record<string, unknown>);
      return auditMutation({
        tool: 'hs4.admin.config.category.upsert',
        action: 'admin_config_category_upsert',
        guard: args,
        target: {
          category: args.category
        },
        policyInput: buildAdminPolicyInput(args, {
          targetIds: [args.category]
        }),
        adminMutation: {
          enabled: true,
          requireChangeTicket: adminChangeTicketRequired
        },
        execute: async () =>
          executeAdminScriptMutation({
            domain: 'config',
            action: 'category.upsert',
            payload,
            before: async () => getCategorySummary(),
            after: async () => getCategorySummary()
          })
      });
    }
  );

  server.registerTool(
    'hs4.admin.config.category.delete',
    {
      description: 'Delete a category through admin controls.',
      inputSchema: {
        category: z.string().min(1),
        ...createAdminGuardSchema('config')
      }
    },
    async (args) => {
      const payload = stripAdminGuardFields(args as Record<string, unknown>);
      return auditMutation({
        tool: 'hs4.admin.config.category.delete',
        action: 'admin_config_category_delete',
        guard: args,
        target: {
          category: args.category
        },
        policyInput: buildAdminPolicyInput(args, {
          targetIds: [args.category]
        }),
        adminMutation: {
          enabled: true,
          requireChangeTicket: adminChangeTicketRequired
        },
        execute: async () =>
          executeAdminScriptMutation({
            domain: 'config',
            action: 'category.delete',
            payload,
            before: async () => getCategorySummary(),
            after: async () => getCategorySummary()
          })
      });
    }
  );

  server.registerResource(
    'hs4-devices-catalog',
    'hs4://devices/catalog',
    {
      title: 'HS4 Devices Catalog',
      description: 'Thin normalized HS4 device catalog (raw fields excluded by default).',
      mimeType: 'application/json'
    },
    async () => {
      const payload = await getStatusPayload({
        compress: true,
        everything: false,
        excludeevents: true
      });
      const snapshot = normalizeStatusPayload(payload);
      const thinSnapshot = {
        ...snapshot,
        devices: toDeviceOutput(snapshot.devices, false)
      };
      return {
        contents: [
          {
            uri: 'hs4://devices/catalog',
            mimeType: 'application/json',
            text: toJsonText(thinSnapshot)
          }
        ]
      };
    }
  );

  server.registerResource(
    'hs4-devices-catalog-full',
    'hs4://devices/catalog/full',
    {
      title: 'HS4 Devices Catalog (Full)',
      description: 'Full normalized HS4 device catalog including raw fields.',
      mimeType: 'application/json'
    },
    async () => {
      const payload = await getStatusPayload({
        compress: false,
        everything: true,
        excludeevents: true
      });
      const snapshot = normalizeStatusPayload(payload);
      return {
        contents: [
          {
            uri: 'hs4://devices/catalog/full',
            mimeType: 'application/json',
            text: toJsonText(snapshot)
          }
        ]
      };
    }
  );

  server.registerResource(
    'hs4-devices-status',
    'hs4://devices/status',
    {
      title: 'HS4 Devices Status',
      description: 'Thin current HS4 status snapshot (raw fields excluded by default).',
      mimeType: 'application/json'
    },
    async () => {
      const payload = await getStatusPayload({ compress: true, everything: false });
      const snapshot = normalizeStatusPayload(payload);
      const thinSnapshot = {
        ...snapshot,
        devices: toDeviceOutput(snapshot.devices, false)
      };
      return {
        contents: [
          {
            uri: 'hs4://devices/status',
            mimeType: 'application/json',
            text: toJsonText(thinSnapshot)
          }
        ]
      };
    }
  );

  server.registerResource(
    'hs4-devices-status-full',
    'hs4://devices/status/full',
    {
      title: 'HS4 Devices Status (Full)',
      description: 'Full current HS4 status snapshot including raw fields.',
      mimeType: 'application/json'
    },
    async () => {
      const payload = await getStatusPayload({ compress: false, everything: true });
      const snapshot = normalizeStatusPayload(payload);
      return {
        contents: [
          {
            uri: 'hs4://devices/status/full',
            mimeType: 'application/json',
            text: toJsonText(snapshot)
          }
        ]
      };
    }
  );

  server.registerResource(
    'hs4-events-catalog',
    'hs4://events/catalog',
    {
      title: 'HS4 Events Catalog',
      description: 'Normalized list of events.',
      mimeType: 'application/json'
    },
    async () => {
      const payload = await client.getEvents();
      const events = normalizeEventsPayload(payload);
      return {
        contents: [
          {
            uri: 'hs4://events/catalog',
            mimeType: 'application/json',
            text: toJsonText(events)
          }
        ]
      };
    }
  );

  server.registerResource(
    'hs4-capability-matrix',
    'hs4://capabilities/matrix',
    {
      title: 'HS4 Capability Matrix',
      description: 'Capability->device ref matrix inferred from status/control metadata.',
      mimeType: 'application/json'
    },
    async () => {
      const payload = await getStatusPayload({ compress: false, everything: true, excludeevents: true });
      const snapshot = normalizeStatusPayload(payload);
      const matrix = capabilitiesMatrixFromStatus(snapshot);
      return {
        contents: [
          {
            uri: 'hs4://capabilities/matrix',
            mimeType: 'application/json',
            text: toJsonText({
              generatedAt: new Date().toISOString(),
              matrix
            })
          }
        ]
      };
    }
  );

  server.registerResource(
    'hs4-audit-recent',
    'hs4://audit/recent',
    {
      title: 'HS4 MCP Audit Log',
      description: 'Most recent MCP operations and mutation attempts.',
      mimeType: 'application/json'
    },
    async () => {
      return {
        contents: [
          {
            uri: 'hs4://audit/recent',
            mimeType: 'application/json',
            text: toJsonText(audit.latest(200))
          }
        ]
      };
    }
  );

  server.registerResource(
    'hs4-state-summary',
    'hs4://state/summary',
    {
      title: 'HS4 State Summary',
      description: 'Compact, low-token state summary for LLM context loading.',
      mimeType: 'application/json'
    },
    async () => {
      const warnings: Array<Record<string, unknown>> = [];
      const version = await client.getVersion().catch(() => 'unknown');

      let devices = 0;
      try {
        const statusPayload = await getStatusPayload({ compress: true, everything: false, excludeevents: true });
        const snapshot = normalizeStatusPayload(statusPayload);
        devices = snapshot.devices.length;
      } catch (error) {
        const mapped = asHS4McpError(error);
        warnings.push({ source: 'devices', code: mapped.code, message: mapped.message });
      }

      let eventsCount = 0;
      try {
        const eventsPayload = await client.getEvents();
        const events = normalizeEventsPayload(eventsPayload);
        eventsCount = events.length;
      } catch (error) {
        const mapped = asHS4McpError(error);
        warnings.push({ source: 'events', code: mapped.code, message: mapped.message });
      }

      let camerasCount = 0;
      try {
        const camerasPayload = await client.getCameras();
        const cameras = normalizeCamerasPayload(camerasPayload);
        camerasCount = cameras.length;
      } catch (error) {
        const mapped = asHS4McpError(error);
        warnings.push({ source: 'cameras', code: mapped.code, message: mapped.message });
      }

      const categorySummary = await getCategorySummary();
      const interfaceSummary = await getInterfaceSummary();
      const recentAudit = audit.latest(25);
      const recentErrors = recentAudit.filter((entry) => entry.result === 'error' || entry.result === 'blocked').length;

      const payload = {
        generatedAt: new Date().toISOString(),
        hs4Version: version,
        safeMode: config.safeMode,
        policy: {
          requireConfirm: config.requireConfirm,
          defaultDryRun: config.defaultDryRun,
          adminEnabled: config.hs4AdminEnabled
        },
        totals: {
          devices,
          events: eventsCount,
          cameras: camerasCount,
          categories: categorySummary.categories.length,
          interfaces: interfaceSummary.totalInterfaces
        },
        recentAudit: {
          entries: recentAudit.length,
          errorOrBlockedCount: recentErrors
        },
        topCategories: categorySummary.categories.slice(0, 10),
        topInterfaces: interfaceSummary.interfaces.slice(0, 10),
        ...(warnings.length ? { warnings } : {})
      };

      return {
        contents: [
          {
            uri: 'hs4://state/summary',
            mimeType: 'application/json',
            text: toJsonText(payload)
          }
        ]
      };
    }
  );

  server.registerResource(
    'hs4-catalog-aliases',
    'hs4://catalog/aliases',
    {
      title: 'HS4 Alias Catalog',
      description: 'Config+learned alias catalog used by hs4.resolve.* tools.',
      mimeType: 'application/json'
    },
    async () => {
      const refresh = await refreshAliasCatalog();
      const catalog = aliasCatalog.exportCatalog();
      return {
        contents: [
          {
            uri: 'hs4://catalog/aliases',
            mimeType: 'application/json',
            text: toJsonText({
              refresh,
              catalog
            })
          }
        ]
      };
    }
  );

  server.registerResource(
    'hs4-agent-contract',
    'hs4://agent/contract',
    {
      title: 'HS4 Agent Contract',
      description: 'Operational contract for LLM agents using the HS4 MCP toolset.',
      mimeType: 'application/json'
    },
    async () => {
      return {
        contents: [
          {
            uri: 'hs4://agent/contract',
            mimeType: 'application/json',
            text: toJsonText({
              generatedAt: new Date().toISOString(),
              contractVersion: '2026-02-25',
              rules: [
                'Resolve entity IDs before mutating tools.',
                'Prefer hs4.change.prepare before hs4.change.commit.',
                'Include confirm/intent/reason for mutating operations.',
                'For hs4.devices.set, prefer mode=control_value and keep verify=true unless intentionally disabled.',
                'Use dryRun=true when intent certainty is low.',
                'Use actionable error fields to select recovery steps.',
                'Use hs4.selftest.run when environment health is uncertain.'
              ],
              defaults: {
                intentToolsDryRunFirst: true,
                prepareCommitEnabled: true,
                actionableErrorsAlwaysOn: true
              },
              recommendedSequence: [
                'hs4.help.route',
                'hs4.resolve.devices|events|cameras',
                'hs4.change.prepare',
                'hs4.change.commit',
                'hs4.audit.query'
              ]
            })
          }
        ]
      };
    }
  );

  server.registerResource(
    'hs4-admin-users',
    'hs4://admin/users',
    {
      title: 'HS4 Admin Users',
      description: 'Current user/admin state from the admin namespace.',
      mimeType: 'application/json'
    },
    async () => {
      const users = await client.runScriptCommand(buildAdminScriptCommand('users', 'list', {}));
      return {
        contents: [
          {
            uri: 'hs4://admin/users',
            mimeType: 'application/json',
            text: toJsonText(users)
          }
        ]
      };
    }
  );

  server.registerResource(
    'hs4-admin-interfaces',
    'hs4://admin/interfaces',
    {
      title: 'HS4 Admin Interfaces',
      description: 'Interface-level summary derived for admin operations.',
      mimeType: 'application/json'
    },
    async () => {
      const summary = await getInterfaceSummary();
      return {
        contents: [
          {
            uri: 'hs4://admin/interfaces',
            mimeType: 'application/json',
            text: toJsonText(summary)
          }
        ]
      };
    }
  );

  server.registerResource(
    'hs4-admin-plugins',
    'hs4://admin/plugins',
    {
      title: 'HS4 Admin Plugins',
      description: 'Plugin catalog/install state used by admin lifecycle tools.',
      mimeType: 'application/json'
    },
    async () => {
      const payload = await client.getPluginList();
      return {
        contents: [
          {
            uri: 'hs4://admin/plugins',
            mimeType: 'application/json',
            text: toJsonText({
              plugins: normalizePluginListPayload(payload),
              raw: payload
            })
          }
        ]
      };
    }
  );

  server.registerResource(
    'hs4-admin-cameras-config',
    'hs4://admin/cameras/config',
    {
      title: 'HS4 Admin Cameras Config',
      description: 'Camera configuration payload for admin camera controls.',
      mimeType: 'application/json'
    },
    async () => {
      const payload = await client.getCameras();
      return {
        contents: [
          {
            uri: 'hs4://admin/cameras/config',
            mimeType: 'application/json',
            text: toJsonText({
              cameras: normalizeCamerasPayload(payload),
              raw: payload
            })
          }
        ]
      };
    }
  );

  server.registerResource(
    'hs4-admin-policy-state',
    'hs4://admin/policy/state',
    {
      title: 'HS4 Admin Policy State',
      description: 'Policy/guard defaults that impact admin mutation gating.',
      mimeType: 'application/json'
    },
    async () => {
      return {
        contents: [
          {
            uri: 'hs4://admin/policy/state',
            mimeType: 'application/json',
            text: toJsonText({
              safeMode: config.safeMode,
              requireConfirm: config.requireConfirm,
              defaultDryRun: config.defaultDryRun,
              adminChangeTicketRequired,
              adminExecution: {
                mode: config.hs4AdminExecutionMode,
                directFallback: config.hs4AdminDirectFallback,
                capabilityCacheTtlSec: config.hs4AdminCapabilityCacheTtlSec,
                capabilityCacheEntries: adminCapabilityCache.size
              },
              allowedDeviceRefsConfigured: Boolean(config.allowedDeviceRefs),
              allowedEventIdsConfigured: Boolean(config.allowedEventIds),
              allowedCameraIdsConfigured: Boolean(config.allowedCameraIds),
              allowedScriptsConfigured: Boolean(config.allowedScripts),
              allowedPluginFunctionsConfigured: Boolean(config.allowedPluginFunctions)
            })
          }
        ]
      };
    }
  );

  server.registerResource(
    'hs4-admin-audit-diff',
    'hs4://admin/audit/diff',
    {
      title: 'HS4 Admin Audit Diff',
      description: 'Recent admin audit entries with before/after/diff metadata.',
      mimeType: 'application/json'
    },
    async () => {
      const entries = audit
        .latest(500)
        .filter((entry) => entry.tool.startsWith('hs4.admin.'))
        .filter((entry) => {
          const details = entry.details;
          if (!details || typeof details !== 'object') {
            return false;
          }
          return 'before' in details || 'after' in details || 'diff' in details;
        });

      return {
        contents: [
          {
            uri: 'hs4://admin/audit/diff',
            mimeType: 'application/json',
            text: toJsonText(entries)
          }
        ]
      };
    }
  );

  server.registerPrompt(
    'hs4_safe_control',
    {
      title: 'HS4 Safe Control Prompt',
      description: 'Prompt template for guarded HS4 control operations.',
      argsSchema: {
        objective: z.string().describe('What you want to achieve in HS4.'),
        targetRefs: z.string().optional().describe('Comma-separated device refs if known.'),
        preferDryRun: z.boolean().optional().default(true)
      }
    },
    async ({ objective, targetRefs, preferDryRun }) => {
      return {
        messages: [
          {
            role: 'user',
            content: {
              type: 'text',
              text:
                `Objective: ${objective}\n` +
                `Known target refs: ${targetRefs ?? 'not specified'}\n` +
                `Use hs4.devices.status.get first to verify state, then use guarded mutation tools with ` +
                `confirm=true, intent, reason, and dryRun=${preferDryRun ? 'true' : 'false'}. ` +
                'For device writes, prefer hs4.devices.set mode=control_value with verify=true.'
            }
          }
        ]
      };
    }
  );

  server.registerPrompt(
    'hs4_scene_operator',
    {
      title: 'HS4 Scene Operator Prompt',
      description: 'Prompt template for event discovery and execution workflow.',
      argsSchema: {
        sceneGoal: z.string(),
        eventGroupHint: z.string().optional()
      }
    },
    async ({ sceneGoal, eventGroupHint }) => {
      return {
        messages: [
          {
            role: 'user',
            content: {
              type: 'text',
              text:
                `Goal: ${sceneGoal}\n` +
                `Group hint: ${eventGroupHint ?? 'none'}\n` +
                '1) Call hs4.events.list with filters.\n' +
                '2) Confirm candidate event id/name/group.\n' +
                '3) Run hs4.events.run with confirm=true, intent and reason.\n' +
                '4) Verify resulting state via hs4.devices.status.get.'
            }
          }
        ]
      };
    }
  );

  server.registerPrompt(
    'hs4_diagnostics',
    {
      title: 'HS4 Diagnostics Prompt',
      description: 'Prompt template for troubleshooting MCP-HS4 connectivity and control issues.',
      argsSchema: {
        symptom: z.string(),
        suspectedRef: z.number().int().optional()
      }
    },
    async ({ symptom, suspectedRef }) => {
      return {
        messages: [
          {
            role: 'user',
            content: {
              type: 'text',
              text:
                `Symptom: ${symptom}\n` +
                `Suspected ref: ${suspectedRef ?? 'not specified'}\n` +
                'Diagnostics sequence:\n' +
                '- hs4.health.get\n' +
                '- hs4.devices.status.get (targeted if ref known)\n' +
                '- hs4.devices.controls.get (to inspect control values)\n' +
                '- hs4.audit.query (recent errors/blocks)'
            }
          }
        ]
      };
    }
  );

  server.registerPrompt(
    'hs4_agent_contract',
    {
      title: 'HS4 Agent Contract',
      description: 'Prompt contract for safe, deterministic LLM operation against HS4 MCP.',
      argsSchema: {
        objective: z.string().optional(),
        mode: z.enum(['read_only', 'dry_run', 'mutate']).optional().default('dry_run')
      }
    },
    async ({ objective, mode }) => {
      return {
        messages: [
          {
            role: 'user',
            content: {
              type: 'text',
              text:
                `Objective: ${objective ?? 'not specified'}\n` +
                `Mode: ${mode}\n` +
                'Contract:\n' +
                '1) Use hs4.help.route to determine the best workflow.\n' +
                '2) Resolve IDs with hs4.resolve.devices/events/cameras.\n' +
                '3) For mutations, prepare first using hs4.change.prepare.\n' +
                '4) Commit only when explicitly requested using hs4.change.commit.\n' +
                '5) Include confirm=true, intent, and reason for mutating paths.\n' +
                '6) For hs4.devices.set, prefer mode=control_value and keep verify=true.\n' +
                '7) Prefer dryRun=true when confidence is low.\n' +
                '8) On errors, use retryable/fixHint/suggestedNextToolCalls fields.\n' +
                '9) Verify outcomes via hs4.devices.status.get / hs4.audit.query.'
            }
          }
        ]
      };
    }
  );

  server.registerPrompt(
    'hs4_admin_change_control',
    {
      title: 'HS4 Admin Change Control',
      description: 'Prompt template for maintenance-window-gated admin mutations.',
      argsSchema: {
        objective: z.string(),
        domain: z.enum(ADMIN_DOMAINS),
        maintenanceWindowId: z.string().optional(),
        changeTicket: z.string().optional(),
        riskLevel: z.enum(ADMIN_RISK_LEVELS).optional().default('medium'),
        dryRun: z.boolean().optional().default(true)
      }
    },
    async ({ objective, domain, maintenanceWindowId, changeTicket, riskLevel, dryRun }) => {
      return {
        messages: [
          {
            role: 'user',
            content: {
              type: 'text',
              text:
                `Objective: ${objective}\n` +
                `Domain: ${domain}\n` +
                `Maintenance window: ${maintenanceWindowId ?? 'required for non-dry-run'}\n` +
                `Change ticket: ${changeTicket ?? 'required when policy-enforced'}\n` +
                `Risk level: ${riskLevel}\n` +
                `Use dryRun=${dryRun} first when uncertain. Include operationTier, domain, maintenanceWindowId, changeTicket, and riskLevel in mutation calls.`
            }
          }
        ]
      };
    }
  );

  server.registerPrompt(
    'hs4_admin_backup_restore',
    {
      title: 'HS4 Admin Backup/Restore',
      description: 'Prompt template for backup/restore runbooks in the admin namespace.',
      argsSchema: {
        objective: z.string(),
        backupId: z.string().optional(),
        maintenanceWindowId: z.string().optional(),
        changeTicket: z.string().optional()
      }
    },
    async ({ objective, backupId, maintenanceWindowId, changeTicket }) => {
      return {
        messages: [
          {
            role: 'user',
            content: {
              type: 'text',
              text:
                `Objective: ${objective}\n` +
                `Backup id: ${backupId ?? 'not specified'}\n` +
                `Maintenance window: ${maintenanceWindowId ?? 'required for apply'}\n` +
                `Change ticket: ${changeTicket ?? 'required when policy-enforced'}\n` +
                'Recommended sequence:\n' +
                '- hs4.admin.system.config.get\n' +
                '- hs4.admin.system.backup.start (dryRun first)\n' +
                '- hs4.admin.system.restore.start (when needed)\n' +
                '- hs4.admin.system.service.restart for post-restore stabilization.'
            }
          }
        ]
      };
    }
  );

  server.registerPrompt(
    'hs4_admin_plugin_lifecycle',
    {
      title: 'HS4 Admin Plugin Lifecycle',
      description: 'Prompt template for plugin install/update/remove/restart lifecycle.',
      argsSchema: {
        pluginId: z.string(),
        lifecycleAction: z.enum(['install', 'update', 'remove', 'set_enabled', 'restart']),
        maintenanceWindowId: z.string().optional(),
        changeTicket: z.string().optional(),
        riskLevel: z.enum(ADMIN_RISK_LEVELS).optional().default('medium')
      }
    },
    async ({ pluginId, lifecycleAction, maintenanceWindowId, changeTicket, riskLevel }) => {
      return {
        messages: [
          {
            role: 'user',
            content: {
              type: 'text',
              text:
                `Plugin: ${pluginId}\n` +
                `Action: ${lifecycleAction}\n` +
                `Maintenance window: ${maintenanceWindowId ?? 'required for non-dry-run'}\n` +
                `Change ticket: ${changeTicket ?? 'required when policy-enforced'}\n` +
                `Risk level: ${riskLevel}\n` +
                'Use hs4.admin.plugins.catalog.get for baseline, then run the selected mutation with full admin guard fields and review rollback/auditRef in the envelope.'
            }
          }
        ]
      };
    }
  );

  logger.info({ transport: config.mcpTransport }, 'MCP HS4 server constructed');
  return server;
}
