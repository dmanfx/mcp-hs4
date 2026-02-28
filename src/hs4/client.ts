import type { Logger } from 'pino';

import { HS4McpError, type ErrorCode } from '../errors.js';

export interface HS4ClientOptions {
  baseUrl: string;
  user?: string;
  pass?: string;
  timeoutMs: number;
  readRetries: number;
  readRetryBackoffMs: number;
  scriptPagePath: string;
  logger: Logger;
  fetchImpl?: typeof fetch;
}

interface JsonRequestOptions {
  mutating?: boolean;
  idempotent?: boolean;
}

const UNSUPPORTED_ON_TARGET_CODE = 'UNSUPPORTED_ON_TARGET' as ErrorCode;

const OPTIONAL_ENDPOINT_UNSUPPORTED_HINTS = [
  'unknown request',
  'unknown action',
  'not supported',
  'unsupported',
  'does not exist',
  'not available',
  'method not found',
  'error, bad request'
];

const SENSITIVE_LOG_KEYS = new Set([
  'pass',
  'password',
  'token',
  'authorization',
  'auth',
  'secret',
  'apikey',
  'api_key',
  'scriptcommand'
]);

function redactForLog(value: unknown, options: { depth: number; maxDepth: number; seen: WeakSet<object> }): unknown {
  if (!value || typeof value !== 'object') {
    return value;
  }

  if (options.depth >= options.maxDepth) {
    return '[REDACTED:DEPTH_LIMIT]';
  }

  if (options.seen.has(value)) {
    return '[REDACTED:CYCLE]';
  }
  options.seen.add(value);

  if (Array.isArray(value)) {
    return value.map((item) => redactForLog(item, { ...options, depth: options.depth + 1 }));
  }

  const record = value as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(record)) {
    const normalizedKey = key.trim().toLowerCase();
    if (SENSITIVE_LOG_KEYS.has(normalizedKey)) {
      result[key] = '[REDACTED]';
      continue;
    }
    result[key] = redactForLog(nested, { ...options, depth: options.depth + 1 });
  }
  return result;
}

function sanitizeParamsForLog(params: Record<string, unknown>): Record<string, unknown> {
  return redactForLog(params, { depth: 0, maxDepth: 6, seen: new WeakSet<object>() }) as Record<string, unknown>;
}

function isHs4ErrorMessage(message: string): boolean {
  const lower = message.toLowerCase();
  return (
    lower.includes('error') ||
    lower.includes('failed') ||
    lower.includes('invalid') ||
    lower.includes('bad request')
  );
}

function maybeErrorFromResponse(payload: unknown): string | null {
  if (typeof payload === 'string') {
    return isHs4ErrorMessage(payload) ? payload : null;
  }

  if (!payload || typeof payload !== 'object') {
    return null;
  }

  const record = payload as Record<string, unknown>;
  const responseMessage = record.Response ?? record.response ?? record.Message ?? record.message;
  if (typeof responseMessage === 'string' && isHs4ErrorMessage(responseMessage)) {
    return responseMessage;
  }

  return null;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sanitizeUrlForLog(url: URL): string {
  const sanitized = new URL(url.toString());
  sanitized.username = '';
  sanitized.password = '';
  sanitized.searchParams.delete('user');
  sanitized.searchParams.delete('pass');
  return sanitized.toString();
}

function escapeScriptString(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

export class HS4Client {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: HS4ClientOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  private applyAuthParams(url: URL): URL {
    if (this.options.user) {
      url.searchParams.set('user', this.options.user);
    }
    if (this.options.pass) {
      url.searchParams.set('pass', this.options.pass);
    }

    return url;
  }

  private buildJsonUrl(request: string, params: Record<string, unknown> = {}): URL {
    const url = new URL('/JSON', this.options.baseUrl);
    url.searchParams.set('request', request);

    for (const [key, value] of Object.entries(params)) {
      if (value === undefined || value === null || value === '') {
        continue;
      }
      url.searchParams.set(key, String(value));
    }

    return this.applyAuthParams(url);
  }

  private async executeFetch(
    url: URL,
    init: RequestInit,
    options: { idempotent: boolean }
  ): Promise<Response> {
    const retries = options.idempotent ? this.options.readRetries : 0;

    let lastError: unknown;
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.options.timeoutMs);

      try {
        const response = await this.fetchImpl(url, {
          ...init,
          signal: controller.signal
        });
        clearTimeout(timeout);

        if (options.idempotent && response.status >= 500 && attempt < retries) {
          await wait(this.options.readRetryBackoffMs * (attempt + 1));
          continue;
        }

        return response;
      } catch (error) {
        clearTimeout(timeout);
        lastError = error;
        if (attempt >= retries) {
          break;
        }
        await wait(this.options.readRetryBackoffMs * (attempt + 1));
      }
    }

    const err = lastError as Error;
    if (err?.name === 'AbortError') {
      throw new HS4McpError('TIMEOUT', `Request timed out for ${url.pathname}`, { cause: err });
    }
    throw new HS4McpError('NETWORK', `Network failure for ${url.pathname}`, { cause: err });
  }

  private async parseResponse(response: Response): Promise<unknown> {
    const rawText = await response.text();

    if (!response.ok) {
      const code: ErrorCode = response.status === 401 || response.status === 403 ? 'AUTH' : 'BAD_REQUEST';
      throw new HS4McpError(code, `HTTP ${response.status} ${response.statusText}: ${rawText}`, {
        statusCode: response.status
      });
    }

    const contentType = response.headers.get('content-type') ?? '';
    if (contentType.includes('application/json')) {
      try {
        return JSON.parse(rawText);
      } catch {
        return rawText;
      }
    }

    const trimmed = rawText.trim();
    if ((trimmed.startsWith('{') || trimmed.startsWith('[')) && trimmed.length > 1) {
      try {
        return JSON.parse(trimmed);
      } catch {
        return rawText;
      }
    }

    return rawText;
  }

  private async requestJson(
    request: string,
    params: Record<string, unknown> = {},
    options: JsonRequestOptions = {}
  ): Promise<unknown> {
    const url = this.buildJsonUrl(request, params);

    this.options.logger.debug(
      { request, url: sanitizeUrlForLog(url), params: sanitizeParamsForLog(params) },
      'HS4 JSON request'
    );

    const response = await this.executeFetch(
      url,
      {
        method: 'GET',
        headers: {
          Accept: 'application/json,text/plain,*/*'
        }
      },
      {
        idempotent: options.idempotent ?? !options.mutating
      }
    );

    const parsed = await this.parseResponse(response);
    const maybeError = maybeErrorFromResponse(parsed);
    if (maybeError) {
      throw new HS4McpError('HS4_ERROR', maybeError);
    }

    return parsed;
  }

  private throwUnsupportedOnTarget(message: string, details?: Record<string, unknown>): never {
    throw new HS4McpError(UNSUPPORTED_ON_TARGET_CODE, message, { details });
  }

  private isUnsupportedOptionalError(error: HS4McpError): boolean {
    if (error.code === UNSUPPORTED_ON_TARGET_CODE) {
      return true;
    }

    if (error.code === 'BAD_REQUEST' && error.statusCode === 404) {
      return true;
    }

    if (error.code !== 'HS4_ERROR' && error.code !== 'BAD_REQUEST' && error.code !== 'UNKNOWN') {
      return false;
    }

    const lower = error.message.toLowerCase();
    return OPTIONAL_ENDPOINT_UNSUPPORTED_HINTS.some((hint) => lower.includes(hint));
  }

  private rethrowUnsupportedOptional(
    error: unknown,
    context: {
      operation: string;
      transport: 'json' | 'pluginfunction' | 'runscript' | 'html_action';
      endpoint: string;
      params?: Record<string, unknown>;
    }
  ): never {
    if (error instanceof HS4McpError && this.isUnsupportedOptionalError(error)) {
      this.throwUnsupportedOnTarget(`${context.operation} is unsupported on this HS4 target.`, {
        transport: context.transport,
        endpoint: context.endpoint,
        params: context.params,
        sourceCode: error.code,
        sourceStatusCode: error.statusCode
      });
    }

    throw error;
  }

  private async requestOptionalJson(
    operation: string,
    request: string,
    params: Record<string, unknown> = {},
    options: JsonRequestOptions = {}
  ): Promise<unknown> {
    try {
      return await this.requestJson(request, params, options);
    } catch (error) {
      this.rethrowUnsupportedOptional(error, {
        operation,
        transport: 'json',
        endpoint: request,
        params
      });
    }
  }

  private async requestOptionalPluginFunction(args: {
    operation: string;
    plugin: string;
    functionName: string;
    instance?: string;
    params?: Array<string | number | boolean>;
  }): Promise<unknown> {
    try {
      return await this.pluginFunction({
        plugin: args.plugin,
        functionName: args.functionName,
        instance: args.instance,
        params: args.params
      });
    } catch (error) {
      this.rethrowUnsupportedOptional(error, {
        operation: args.operation,
        transport: 'pluginfunction',
        endpoint: `${args.plugin}:${args.functionName}`,
        params: {
          instance: args.instance,
          args: args.params
        }
      });
    }
  }

  private async requestOptionalScriptCommand(
    operation: string,
    scriptCommand: string,
    params: Record<string, unknown> = {}
  ): Promise<unknown> {
    try {
      return await this.runScriptCommand(scriptCommand);
    } catch (error) {
      this.rethrowUnsupportedOptional(error, {
        operation,
        transport: 'runscript',
        endpoint: 'run_script_command',
        params: {
          ...params,
          scriptCommand
        }
      });
    }
  }

  private async requestOptionalHtmlAction(
    operation: string,
    pagePath: string,
    action: string,
    params: Record<string, unknown> = {}
  ): Promise<unknown> {
    const normalizedPath = pagePath.startsWith('/') ? pagePath : `/${pagePath}`;
    const url = new URL(normalizedPath, this.options.baseUrl);
    this.applyAuthParams(url);

    this.options.logger.debug(
      { request: action, url: sanitizeUrlForLog(url), params: sanitizeParamsForLog(params) },
      'HS4 HTML action request'
    );

    const body = new URLSearchParams();
    body.set('action', action);
    for (const [key, value] of Object.entries(params)) {
      if (value === undefined || value === null || value === '') {
        continue;
      }
      body.set(key, String(value));
    }

    try {
      const response = await this.executeFetch(
        url,
        {
          method: 'POST',
          headers: {
            Accept: 'application/json,text/plain,*/*',
            'Content-Type': 'application/x-www-form-urlencoded'
          },
          body: body.toString()
        },
        {
          idempotent: false
        }
      );

      return await this.parseResponse(response);
    } catch (error) {
      this.rethrowUnsupportedOptional(error, {
        operation,
        transport: 'html_action',
        endpoint: `${normalizedPath}?action=${action}`,
        params
      });
    }
  }

  async getVersion(): Promise<string> {
    const payload = await this.requestJson('hsversion', {}, { idempotent: true });
    if (typeof payload === 'string') {
      return payload;
    }
    if (payload && typeof payload === 'object') {
      const value = (payload as Record<string, unknown>).Response;
      return String(value ?? 'unknown');
    }
    return 'unknown';
  }

  async getStatus(params: {
    ref?: string;
    location1?: string;
    location2?: string;
    compress?: boolean;
    everything?: boolean;
    voiceonly?: boolean;
    excludeevents?: boolean;
  }): Promise<unknown> {
    return this.requestJson('getstatus', params, { idempotent: true });
  }

  async getControl(params: { ref?: string; controlsOnly?: boolean } = {}): Promise<unknown> {
    return this.requestJson('getcontrol', params, { idempotent: true });
  }

  async getControl2(params: { ref?: string } = {}): Promise<unknown> {
    return this.requestJson('getcontrol2', params, { idempotent: true });
  }

  async getEvents(): Promise<unknown> {
    return this.requestJson('getevents', {}, { idempotent: true });
  }

  async runEvent(args: { id?: number; group?: string; name?: string }): Promise<unknown> {
    return this.requestJson(
      'runevent',
      {
        id: args.id,
        group: args.group,
        name: args.name
      },
      { mutating: true, idempotent: false }
    );
  }

  async controlDeviceByValue(args: { ref: number; value: number }): Promise<unknown> {
    try {
      return await this.requestJson(
        'controldevicebyvalue',
        {
          ref: args.ref,
          value: args.value
        },
        { mutating: true, idempotent: false }
      );
    } catch (error) {
      this.options.logger.warn(
        { ref: args.ref, value: args.value, error: String(error) },
        'controldevicebyvalue failed, falling back to setdevicevaluebyref'
      );
      return this.requestJson(
        'setdevicevaluebyref',
        {
          ref: args.ref,
          value: args.value
        },
        { mutating: true, idempotent: false }
      );
    }
  }

  async setDeviceStatus(args: {
    ref: number;
    value?: number;
    string?: string;
    source?: string;
  }): Promise<unknown> {
    return this.requestJson(
      'setdevicestatus',
      {
        ref: args.ref,
        value: args.value,
        string: args.string,
        source: args.source
      },
      { mutating: true, idempotent: false }
    );
  }

  async getDevicesChanged(deviceChangeId: number): Promise<unknown> {
    return this.requestJson(
      'getdeviceschanged',
      {
        devicechangeid: deviceChangeId
      },
      { idempotent: true }
    );
  }

  async pluginFunction(args: {
    plugin: string;
    functionName: string;
    instance?: string;
    params?: Array<string | number | boolean>;
  }): Promise<unknown> {
    const query: Record<string, unknown> = {
      plugin: args.plugin,
      function: args.functionName,
      instance: args.instance
    };

    for (const [index, value] of (args.params ?? []).entries()) {
      query[`P${index + 1}`] = value;
    }

    return this.requestJson('pluginfunction', query, { mutating: true, idempotent: false });
  }

  async getPluginList(): Promise<unknown> {
    return this.requestJson('pluginlist', {}, { idempotent: true });
  }

  async getCameras(): Promise<unknown> {
    return this.requestJson('getcameras', {}, { idempotent: true });
  }

  async getCameraSnapshot(camId: number): Promise<unknown> {
    return this.requestJson(
      'getcamerasnapshot',
      {
        camid: camId
      },
      { idempotent: true }
    );
  }

  async panCamera(args: { camId: number; direction: string }): Promise<unknown> {
    return this.requestJson(
      'pancamera',
      {
        camid: args.camId,
        direction: args.direction
      },
      { mutating: true, idempotent: false }
    );
  }

  async setDeviceProperty(args: { ref?: number; property: string; value: string }): Promise<unknown> {
    return this.requestJson(
      'setdeviceproperty',
      {
        ref: args.ref,
        property: args.property,
        value: args.value
      },
      { mutating: true, idempotent: false }
    );
  }

  async usersList(params: { includeRoles?: boolean; includeDisabled?: boolean } = {}): Promise<unknown> {
    return this.requestOptionalJson(
      'usersList',
      'userslist',
      {
        includeroles: params.includeRoles,
        includedisabled: params.includeDisabled
      },
      { idempotent: true }
    );
  }

  async usersCreate(args: {
    username: string;
    password?: string;
    role?: string;
    enabled?: boolean;
    email?: string;
  }): Promise<unknown> {
    return this.requestOptionalJson(
      'usersCreate',
      'userscreate',
      {
        username: args.username,
        password: args.password,
        role: args.role,
        enabled: args.enabled,
        email: args.email
      },
      { mutating: true, idempotent: false }
    );
  }

  async usersUpdate(args: {
    username: string;
    password?: string;
    role?: string;
    enabled?: boolean;
    email?: string;
  }): Promise<unknown> {
    return this.requestOptionalJson(
      'usersUpdate',
      'usersupdate',
      {
        username: args.username,
        password: args.password,
        role: args.role,
        enabled: args.enabled,
        email: args.email
      },
      { mutating: true, idempotent: false }
    );
  }

  async usersDelete(args: { username: string }): Promise<unknown> {
    return this.requestOptionalJson(
      'usersDelete',
      'usersdelete',
      {
        username: args.username
      },
      { mutating: true, idempotent: false }
    );
  }

  async usersSetRole(args: { username: string; role: string }): Promise<unknown> {
    return this.requestOptionalJson(
      'usersSetRole',
      'userssetrole',
      {
        username: args.username,
        role: args.role
      },
      { mutating: true, idempotent: false }
    );
  }

  async pluginCatalogGet(params: { channel?: string } = {}): Promise<unknown> {
    const callParams: Array<string | number | boolean> = [];
    if (params.channel) {
      callParams.push(params.channel);
    }

    return this.requestOptionalPluginFunction({
      operation: 'pluginCatalogGet',
      plugin: 'updater',
      functionName: 'CatalogGet',
      params: callParams.length ? callParams : undefined
    });
  }

  async pluginInstall(args: { pluginId: string; version?: string; instance?: string }): Promise<unknown> {
    const callParams: Array<string | number | boolean> = [args.pluginId];
    if (args.version) {
      callParams.push(args.version);
    }

    return this.requestOptionalPluginFunction({
      operation: 'pluginInstall',
      plugin: 'updater',
      functionName: 'InstallPlugin',
      instance: args.instance,
      params: callParams
    });
  }

  async pluginUpdate(args: { pluginId: string; version?: string; instance?: string }): Promise<unknown> {
    const callParams: Array<string | number | boolean> = [args.pluginId];
    if (args.version) {
      callParams.push(args.version);
    }

    return this.requestOptionalPluginFunction({
      operation: 'pluginUpdate',
      plugin: 'updater',
      functionName: 'UpdatePlugin',
      instance: args.instance,
      params: callParams
    });
  }

  async pluginRemove(args: { pluginId: string; instance?: string }): Promise<unknown> {
    return this.requestOptionalPluginFunction({
      operation: 'pluginRemove',
      plugin: 'updater',
      functionName: 'RemovePlugin',
      instance: args.instance,
      params: [args.pluginId]
    });
  }

  async pluginSetEnabled(args: {
    pluginId: string;
    enabled: boolean;
    instance?: string;
  }): Promise<unknown> {
    return this.requestOptionalPluginFunction({
      operation: 'pluginSetEnabled',
      plugin: 'updater',
      functionName: 'SetPluginEnabled',
      instance: args.instance,
      params: [args.pluginId, args.enabled]
    });
  }

  async pluginRestart(args: { pluginId: string; instance?: string }): Promise<unknown> {
    return this.requestOptionalPluginFunction({
      operation: 'pluginRestart',
      plugin: 'updater',
      functionName: 'RestartPlugin',
      instance: args.instance,
      params: [args.pluginId]
    });
  }

  async interfacesList(params: { includeDisabled?: boolean } = {}): Promise<unknown> {
    return this.requestOptionalJson(
      'interfacesList',
      'interfaceslist',
      {
        includedisabled: params.includeDisabled
      },
      { idempotent: true }
    );
  }

  async interfaceAdd(args: {
    name: string;
    type?: string;
    address?: string;
    enabled?: boolean;
    config?: string;
  }): Promise<unknown> {
    return this.requestOptionalJson(
      'interfaceAdd',
      'interfaceadd',
      {
        name: args.name,
        type: args.type,
        address: args.address,
        enabled: args.enabled,
        config: args.config
      },
      { mutating: true, idempotent: false }
    );
  }

  async interfaceUpdate(args: {
    id: string;
    name?: string;
    enabled?: boolean;
    config?: string;
  }): Promise<unknown> {
    return this.requestOptionalJson(
      'interfaceUpdate',
      'interfaceupdate',
      {
        id: args.id,
        name: args.name,
        enabled: args.enabled,
        config: args.config
      },
      { mutating: true, idempotent: false }
    );
  }

  async interfaceRemove(args: { id: string }): Promise<unknown> {
    return this.requestOptionalJson(
      'interfaceRemove',
      'interfaceremove',
      {
        id: args.id
      },
      { mutating: true, idempotent: false }
    );
  }

  async interfaceRestart(args: { id: string }): Promise<unknown> {
    return this.requestOptionalJson(
      'interfaceRestart',
      'interfacerestart',
      {
        id: args.id
      },
      { mutating: true, idempotent: false }
    );
  }

  async interfaceDiagnostics(args: { id: string; verbose?: boolean }): Promise<unknown> {
    return this.requestOptionalJson(
      'interfaceDiagnostics',
      'interfacediagnostics',
      {
        id: args.id,
        verbose: args.verbose
      },
      { idempotent: true }
    );
  }

  async systemBackupStart(_args: { destination?: string; note?: string } = {}): Promise<unknown> {
    return this.requestOptionalHtmlAction('systemBackupStart', '/backup.html', 'backup');
  }

  async systemRestoreStart(args: { backupId?: string; sourcePath?: string } = {}): Promise<unknown> {
    return this.requestOptionalJson(
      'systemRestoreStart',
      'systemrestorestart',
      {
        backupid: args.backupId,
        sourcepath: args.sourcePath
      },
      { mutating: true, idempotent: false }
    );
  }

  async systemServiceRestart(args: { service?: string } = {}): Promise<unknown> {
    const command = args.service
      ? `hs.RestartService("${escapeScriptString(args.service)}")`
      : 'hs.RestartService()';
    return this.requestOptionalScriptCommand('systemServiceRestart', command, {
      service: args.service
    });
  }

  async systemShutdown(args: { delaySeconds?: number } = {}): Promise<unknown> {
    const delaySeconds =
      typeof args.delaySeconds === 'number' && Number.isFinite(args.delaySeconds)
        ? Math.max(0, Math.floor(args.delaySeconds))
        : 0;

    return this.requestOptionalScriptCommand('systemShutdown', `hs.Shutdown(${delaySeconds})`, {
      delaySeconds
    });
  }

  async systemConfigGet(params: { key?: string } = {}): Promise<unknown> {
    return this.requestOptionalJson(
      'systemConfigGet',
      'systemconfigget',
      {
        key: params.key
      },
      { idempotent: true }
    );
  }

  async systemConfigSet(args: { key: string; value: string | number | boolean }): Promise<unknown> {
    return this.requestOptionalJson(
      'systemConfigSet',
      'systemconfigset',
      {
        key: args.key,
        value: args.value
      },
      { mutating: true, idempotent: false }
    );
  }

  async camerasConfigList(params: { includeDisabled?: boolean } = {}): Promise<unknown> {
    return this.requestOptionalJson(
      'camerasConfigList',
      'camerasconfiglist',
      {
        includedisabled: params.includeDisabled
      },
      { idempotent: true }
    );
  }

  async cameraConfigCreate(args: {
    name: string;
    source: string;
    profile?: string;
    recording?: boolean;
  }): Promise<unknown> {
    return this.requestOptionalJson(
      'cameraConfigCreate',
      'cameraconfigcreate',
      {
        name: args.name,
        source: args.source,
        profile: args.profile,
        recording: args.recording
      },
      { mutating: true, idempotent: false }
    );
  }

  async cameraConfigUpdate(args: {
    camId: number;
    name?: string;
    source?: string;
    profile?: string;
    recording?: boolean;
  }): Promise<unknown> {
    return this.requestOptionalJson(
      'cameraConfigUpdate',
      'cameraconfigupdate',
      {
        camid: args.camId,
        name: args.name,
        source: args.source,
        profile: args.profile,
        recording: args.recording
      },
      { mutating: true, idempotent: false }
    );
  }

  async cameraConfigDelete(args: { camId: number }): Promise<unknown> {
    return this.requestOptionalJson(
      'cameraConfigDelete',
      'cameraconfigdelete',
      {
        camid: args.camId
      },
      { mutating: true, idempotent: false }
    );
  }

  async cameraStreamProfileSet(args: { camId: number; profile: string }): Promise<unknown> {
    return this.requestOptionalJson(
      'cameraStreamProfileSet',
      'camerastreamprofileset',
      {
        camid: args.camId,
        profile: args.profile
      },
      { mutating: true, idempotent: false }
    );
  }

  async cameraRecordingSet(args: { camId: number; enabled: boolean }): Promise<unknown> {
    return this.requestOptionalJson(
      'cameraRecordingSet',
      'camerarecordingset',
      {
        camid: args.camId,
        enabled: args.enabled
      },
      { mutating: true, idempotent: false }
    );
  }

  async eventsCreate(args: {
    group: string;
    name: string;
    trigger?: string;
    action?: string;
  }): Promise<unknown> {
    return this.requestOptionalJson(
      'eventsCreate',
      'eventscreate',
      {
        group: args.group,
        name: args.name,
        trigger: args.trigger,
        action: args.action
      },
      { mutating: true, idempotent: false }
    );
  }

  async eventsUpdate(args: {
    id: number;
    group?: string;
    name?: string;
    trigger?: string;
    action?: string;
  }): Promise<unknown> {
    return this.requestOptionalJson(
      'eventsUpdate',
      'eventsupdate',
      {
        id: args.id,
        group: args.group,
        name: args.name,
        trigger: args.trigger,
        action: args.action
      },
      { mutating: true, idempotent: false }
    );
  }

  async eventsDelete(args: { id: number }): Promise<unknown> {
    return this.requestOptionalJson(
      'eventsDelete',
      'eventsdelete',
      {
        id: args.id
      },
      { mutating: true, idempotent: false }
    );
  }

  async configDeviceMetadataSet(args: {
    ref: number;
    name?: string;
    location?: string;
    location2?: string;
    category?: string;
  }): Promise<unknown> {
    return this.requestOptionalJson(
      'configDeviceMetadataSet',
      'configdevicemetadataset',
      {
        ref: args.ref,
        name: args.name,
        location: args.location,
        location2: args.location2,
        category: args.category
      },
      { mutating: true, idempotent: false }
    );
  }

  async configCategoriesList(params: { includeSystem?: boolean } = {}): Promise<unknown> {
    return this.requestOptionalJson(
      'configCategoriesList',
      'configcategorieslist',
      {
        includesystem: params.includeSystem
      },
      { idempotent: true }
    );
  }

  async configCategoryUpsert(args: {
    id?: number;
    name: string;
    location1?: string;
    location2?: string;
  }): Promise<unknown> {
    return this.requestOptionalJson(
      'configCategoryUpsert',
      'configcategoryupsert',
      {
        id: args.id,
        name: args.name,
        location1: args.location1,
        location2: args.location2
      },
      { mutating: true, idempotent: false }
    );
  }

  async configCategoryDelete(args: { id: number }): Promise<unknown> {
    return this.requestOptionalJson(
      'configCategoryDelete',
      'configcategorydelete',
      {
        id: args.id
      },
      { mutating: true, idempotent: false }
    );
  }

  async runScriptCommand(scriptCommand: string): Promise<{
    responseArray: unknown[];
    commands: Array<{ key: string; value: unknown }>;
  }> {
    const path = this.options.scriptPagePath.startsWith('/')
      ? this.options.scriptPagePath
      : `/${this.options.scriptPagePath}`;
    const url = new URL(path, this.options.baseUrl);
    this.applyAuthParams(url);

    this.options.logger.debug(
      { request: 'run_script_command', url: sanitizeUrlForLog(url) },
      'HS4 script request'
    );

    const body = new URLSearchParams();
    body.set('action', 'run_script_command');
    body.set('scriptcommand', scriptCommand);

    const response = await this.executeFetch(
      url,
      {
        method: 'POST',
        headers: {
          Accept: 'application/json,text/plain,*/*',
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: body.toString()
      },
      {
        idempotent: false
      }
    );

    const parsed = await this.parseResponse(response);

    const asArray = Array.isArray(parsed)
      ? parsed
      : typeof parsed === 'string'
        ? (() => {
            try {
              return JSON.parse(parsed);
            } catch {
              return [parsed];
            }
          })()
        : [parsed];

    const commands: Array<{ key: string; value: unknown }> = [];

    for (let i = 0; i < asArray.length; i += 2) {
      const key = typeof asArray[i] === 'string' ? asArray[i] : `item_${i}`;
      const value = asArray[i + 1];
      commands.push({ key, value });
    }

    return {
      responseArray: asArray,
      commands
    };
  }
}
