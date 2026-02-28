import type { AppConfig } from '../config.js';

export type OperationTier = 'operator' | 'admin';
export type AdminDomain = 'users' | 'plugins' | 'interfaces' | 'system' | 'cameras' | 'events' | 'config';

export interface MutationPolicyInput {
  tool: string;
  action: string;
  confirm?: boolean;
  intent?: string;
  reason?: string;
  dryRun?: boolean;
  operationTier?: OperationTier;
  domain?: AdminDomain;
  maintenanceWindowId?: string;
  changeTicket?: string;
  targetRefs?: number[];
  eventIds?: number[];
  cameraIds?: number[];
  userIds?: string[];
  pluginIds?: string[];
  interfaceIds?: string[];
  categoryIds?: string[];
  scriptCommand?: string;
  pluginFunction?: string;
}

export interface MutationPolicyDecision {
  allowed: boolean;
  effectiveDryRun: boolean;
  reasons: string[];
  normalized?: {
    operationTier: OperationTier;
    domain?: AdminDomain;
    maintenanceWindowId?: string;
    changeTicket?: string;
    scriptId?: string;
    pluginFunction?: string;
  };
}

function extractScriptId(command: string | undefined): string | undefined {
  if (!command) {
    return undefined;
  }
  const cleaned = command.trim();
  if (!cleaned) {
    return undefined;
  }
  const beforeParen = cleaned.split('(')[0]?.trim();
  if (beforeParen) {
    return beforeParen.toLowerCase();
  }
  const firstToken = cleaned.split(/\s+/)[0]?.trim();
  return firstToken ? firstToken.toLowerCase() : undefined;
}

function normalizeOptionalText(raw: string | undefined): string | undefined {
  const trimmed = raw?.trim();
  return trimmed ? trimmed : undefined;
}

function normalizeIdList(values: string[] | undefined): string[] {
  if (!values?.length) {
    return [];
  }

  const normalized: string[] = [];
  for (const value of values) {
    const cleaned = value.trim().toLowerCase();
    if (cleaned) {
      normalized.push(cleaned);
    }
  }
  return normalized;
}

function adminDomainEnabled(config: AppConfig, domain: AdminDomain): boolean {
  switch (domain) {
    case 'users':
      return config.hs4AdminUsersEnabled ?? false;
    case 'plugins':
      return config.hs4AdminPluginsEnabled ?? false;
    case 'interfaces':
      return config.hs4AdminInterfacesEnabled ?? false;
    case 'system':
      return config.hs4AdminSystemEnabled ?? false;
    case 'cameras':
      return config.hs4AdminCamerasEnabled ?? false;
    case 'events':
      return config.hs4AdminEventsEnabled ?? false;
    case 'config':
      return config.hs4AdminConfigEnabled ?? false;
    default:
      return false;
  }
}

function collectBlockedIds(allowlist: Set<string> | null | undefined, values: string[]): string[] {
  if (!allowlist || values.length === 0) {
    return [];
  }
  return values.filter((value) => !allowlist.has(value));
}

export class PolicyEngine {
  constructor(private readonly config: AppConfig) {}

  evaluateMutation(input: MutationPolicyInput): MutationPolicyDecision {
    const reasons: string[] = [];
    const effectiveDryRun = Boolean(input.dryRun || this.config.defaultDryRun);
    const operationTier: OperationTier = input.operationTier === 'admin' ? 'admin' : 'operator';
    const domain = input.domain;
    const maintenanceWindowId = normalizeOptionalText(input.maintenanceWindowId);
    const changeTicket = normalizeOptionalText(input.changeTicket);

    if (this.config.safeMode === 'read_only' && !effectiveDryRun) {
      reasons.push('Server is running in read-only mode (HS4_SAFE_MODE=read_only).');
    }

    if (!effectiveDryRun && this.config.requireConfirm && input.confirm !== true) {
      reasons.push('Mutating operations require confirm=true.');
    }

    if (!effectiveDryRun && !input.intent?.trim()) {
      reasons.push('Mutating operations require a non-empty intent field.');
    }

    if (!effectiveDryRun && !input.reason?.trim()) {
      reasons.push('Mutating operations require a non-empty reason field.');
    }

    if (this.config.allowedDeviceRefs && input.targetRefs?.length) {
      const blocked = input.targetRefs.filter((ref) => !this.config.allowedDeviceRefs?.has(ref));
      if (blocked.length) {
        reasons.push(`Device refs not allowed by policy: ${blocked.join(', ')}`);
      }
    }

    if (this.config.allowedEventIds && input.eventIds?.length) {
      const blocked = input.eventIds.filter((id) => !this.config.allowedEventIds?.has(id));
      if (blocked.length) {
        reasons.push(`Event IDs not allowed by policy: ${blocked.join(', ')}`);
      }
    }

    if (this.config.allowedCameraIds && input.cameraIds?.length) {
      const blocked = input.cameraIds.filter((id) => !this.config.allowedCameraIds?.has(id));
      if (blocked.length) {
        reasons.push(`Camera IDs not allowed by policy: ${blocked.join(', ')}`);
      }
    }

    const scriptId = extractScriptId(input.scriptCommand);
    if (this.config.allowedScripts && scriptId && !this.config.allowedScripts.has(scriptId)) {
      reasons.push(`Script command '${scriptId}' is not allowed by policy.`);
    }

    const pluginFunction = input.pluginFunction?.trim().toLowerCase();
    if (
      this.config.allowedPluginFunctions &&
      pluginFunction &&
      !this.config.allowedPluginFunctions.has(pluginFunction)
    ) {
      reasons.push(`Plugin function '${pluginFunction}' is not allowed by policy.`);
    }

    const userIds = normalizeIdList(input.userIds);
    const pluginIds = normalizeIdList(input.pluginIds);
    const interfaceIds = normalizeIdList(input.interfaceIds);
    const categoryIds = normalizeIdList(input.categoryIds);

    const blockedUserIds = collectBlockedIds(this.config.hs4AdminAllowedUserIds, userIds);
    if (blockedUserIds.length) {
      reasons.push(`User IDs not allowed by policy: ${blockedUserIds.join(', ')}`);
    }

    const blockedPluginIds = collectBlockedIds(this.config.hs4AdminAllowedPluginIds, pluginIds);
    if (blockedPluginIds.length) {
      reasons.push(`Plugin IDs not allowed by policy: ${blockedPluginIds.join(', ')}`);
    }

    const blockedInterfaceIds = collectBlockedIds(this.config.hs4AdminAllowedInterfaceIds, interfaceIds);
    if (blockedInterfaceIds.length) {
      reasons.push(`Interface IDs not allowed by policy: ${blockedInterfaceIds.join(', ')}`);
    }

    const blockedCategoryIds = collectBlockedIds(this.config.hs4AdminAllowedCategoryIds, categoryIds);
    if (blockedCategoryIds.length) {
      reasons.push(`Category IDs not allowed by policy: ${blockedCategoryIds.join(', ')}`);
    }

    if (operationTier === 'admin') {
      if (!(this.config.hs4AdminEnabled ?? false)) {
        reasons.push('Admin operations are disabled (HS4_ADMIN_ENABLED=false).');
      }

      if (!domain) {
        reasons.push(
          'Admin operations require a domain (users/plugins/interfaces/system/cameras/events/config).'
        );
      } else if (!adminDomainEnabled(this.config, domain)) {
        reasons.push(`Admin domain '${domain}' is not enabled by policy.`);
      }

      if (!maintenanceWindowId) {
        reasons.push('Admin operations require a non-empty maintenanceWindowId.');
      }

      const requiredMaintenanceWindowId = normalizeOptionalText(this.config.hs4AdminMaintenanceWindowId);
      if (requiredMaintenanceWindowId && maintenanceWindowId !== requiredMaintenanceWindowId) {
        reasons.push(
          `maintenanceWindowId must match the configured value '${requiredMaintenanceWindowId}'.`
        );
      }

      const allowedMaintenanceWindows = this.config.hs4AdminAllowedMaintenanceWindowIds;
      if (allowedMaintenanceWindows && maintenanceWindowId && !allowedMaintenanceWindows.has(maintenanceWindowId)) {
        reasons.push(`maintenanceWindowId '${maintenanceWindowId}' is not allowed by policy.`);
      }

      const requireChangeTicket = this.config.hs4AdminRequireChangeTicket ?? true;
      if (requireChangeTicket && !changeTicket) {
        reasons.push('Admin operations require a non-empty changeTicket.');
      }
    }

    return {
      allowed: reasons.length === 0,
      effectiveDryRun,
      reasons,
      normalized: {
        operationTier,
        domain,
        maintenanceWindowId,
        changeTicket,
        scriptId,
        pluginFunction
      }
    };
  }
}
