export type ErrorCode =
  | 'AUTH'
  | 'NETWORK'
  | 'BAD_REQUEST'
  | 'NOT_FOUND'
  | 'HS4_ERROR'
  | 'POLICY_DENY'
  | 'TIMEOUT'
  | 'UNSUPPORTED_ON_TARGET'
  | 'INTERNAL'
  | 'UNKNOWN';

export interface SuggestedToolCall {
  name: string;
  args?: Record<string, unknown>;
}

export interface ActionableErrorFields {
  retryable: boolean;
  fixHint: string;
  suggestedNextToolCalls: SuggestedToolCall[];
}

const ACTIONABLE_ERROR_DEFAULTS: Record<ErrorCode, ActionableErrorFields> = {
  AUTH: {
    retryable: false,
    fixHint: 'Verify HS4 credentials and authentication settings before retrying.',
    suggestedNextToolCalls: [{ name: 'hs4.health.get' }]
  },
  NETWORK: {
    retryable: true,
    fixHint: 'Check HS4 host reachability and network connectivity, then retry.',
    suggestedNextToolCalls: [{ name: 'hs4.health.get' }, { name: 'hs4.selftest.run' }]
  },
  BAD_REQUEST: {
    retryable: false,
    fixHint: 'Fix tool arguments to match the input schema and required fields.',
    suggestedNextToolCalls: [{ name: 'hs4.help.route', args: { goal: 'validate arguments' } }]
  },
  NOT_FOUND: {
    retryable: false,
    fixHint: 'Resolve the target entity again and retry with a valid ID.',
    suggestedNextToolCalls: [
      { name: 'hs4.resolve.devices', args: { query: 'target name' } },
      { name: 'hs4.resolve.events', args: { query: 'event name' } }
    ]
  },
  HS4_ERROR: {
    retryable: false,
    fixHint: 'Inspect HS4-side errors and ensure the requested operation is supported for this target.',
    suggestedNextToolCalls: [{ name: 'hs4.health.get' }, { name: 'hs4.selftest.run' }]
  },
  POLICY_DENY: {
    retryable: false,
    fixHint: 'Update confirm/intent/reason or policy gates (allowlists, maintenance window, change ticket).',
    suggestedNextToolCalls: [{ name: 'hs4.audit.query', args: { result: 'blocked', limit: 10 } }]
  },
  TIMEOUT: {
    retryable: true,
    fixHint: 'Retry the operation and increase timeout if network latency is high.',
    suggestedNextToolCalls: [{ name: 'hs4.health.get' }]
  },
  UNSUPPORTED_ON_TARGET: {
    retryable: false,
    fixHint: 'Use an alternative supported endpoint or disable this feature for the current HS4 target.',
    suggestedNextToolCalls: [{ name: 'hs4.help.route', args: { goal: 'find supported alternative' } }]
  },
  INTERNAL: {
    retryable: true,
    fixHint: 'Retry once; if it fails again, inspect logs and audit records.',
    suggestedNextToolCalls: [{ name: 'hs4.audit.query', args: { result: 'error', limit: 20 } }]
  },
  UNKNOWN: {
    retryable: true,
    fixHint: 'Retry once; if it fails again, run diagnostics and inspect logs.',
    suggestedNextToolCalls: [{ name: 'hs4.selftest.run' }, { name: 'hs4.audit.query', args: { result: 'error', limit: 20 } }]
  }
};

export function actionableErrorFields(code: ErrorCode): ActionableErrorFields {
  const defaults = ACTIONABLE_ERROR_DEFAULTS[code] ?? ACTIONABLE_ERROR_DEFAULTS.UNKNOWN;
  return {
    retryable: defaults.retryable,
    fixHint: defaults.fixHint,
    suggestedNextToolCalls: defaults.suggestedNextToolCalls.map((item) => ({
      name: item.name,
      ...(item.args ? { args: { ...item.args } } : {})
    }))
  };
}

export class HS4McpError extends Error {
  public readonly code: ErrorCode;
  public readonly statusCode?: number;
  public readonly details?: Record<string, unknown>;

  constructor(
    code: ErrorCode,
    message: string,
    options?: {
      cause?: unknown;
      statusCode?: number;
      details?: Record<string, unknown>;
    }
  ) {
    super(message, { cause: options?.cause });
    this.name = 'HS4McpError';
    this.code = code;
    this.statusCode = options?.statusCode;
    this.details = options?.details;
  }
}

export function ensureError(value: unknown): Error {
  if (value instanceof Error) {
    return value;
  }
  return new Error(typeof value === 'string' ? value : JSON.stringify(value));
}

export function asHS4McpError(value: unknown): HS4McpError {
  if (value instanceof HS4McpError) {
    return value;
  }

  const err = ensureError(value);

  if (err.name === 'AbortError') {
    return new HS4McpError('TIMEOUT', err.message, { cause: err });
  }

  return new HS4McpError('INTERNAL', err.message, { cause: err });
}
