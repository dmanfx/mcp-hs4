import { describe, expect, test, vi } from 'vitest';

import { HS4Client, type HS4ClientOptions } from '../../src/hs4/client.js';

function makeLogger() {
  return {
    debug: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    error: vi.fn()
  };
}

function makeClient(
  fetchImpl: typeof fetch,
  overrides: Partial<Omit<HS4ClientOptions, 'fetchImpl'>> = {}
) {
  const logger = overrides.logger ?? (makeLogger() as HS4ClientOptions['logger']);
  return new HS4Client({
    baseUrl: 'http://127.0.0.1',
    timeoutMs: 5_000,
    readRetries: 0,
    readRetryBackoffMs: 10,
    scriptPagePath: '/runscript.html',
    logger,
    fetchImpl,
    ...overrides
  });
}

describe('HS4Client', () => {
  test('reads hsversion response', async () => {
    const fetchMock = vi.fn(async () => {
      return new Response(JSON.stringify({ Response: '4.2.22.4' }), {
        status: 200,
        headers: {
          'content-type': 'application/json'
        }
      });
    }) as unknown as typeof fetch;

    const client = makeClient(fetchMock);
    await expect(client.getVersion()).resolves.toBe('4.2.22.4');
  });

  test('falls back to setdevicevaluebyref if controldevicebyvalue returns HS4 error', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ Response: 'Error, bad request' }), {
          status: 200,
          headers: {
            'content-type': 'application/json'
          }
        })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ Response: 'ok' }), {
          status: 200,
          headers: {
            'content-type': 'application/json'
          }
        })
      ) as unknown as typeof fetch;

    const client = makeClient(fetchMock);
    const result = await client.controlDeviceByValue({ ref: 10, value: 100 });

    expect(result).toEqual({ Response: 'ok' });
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const firstUrl = (fetchMock.mock.calls[0]?.[0] as URL).toString();
    const secondUrl = (fetchMock.mock.calls[1]?.[0] as URL).toString();

    expect(firstUrl).toContain('request=controldevicebyvalue');
    expect(secondUrl).toContain('request=setdevicevaluebyref');
  });

  test('parses runscript ajax pair payload', async () => {
    const fetchMock = vi.fn(async () => {
      return new Response('["response","done"]', {
        status: 200,
        headers: {
          'content-type': 'application/json'
        }
      });
    }) as unknown as typeof fetch;

    const client = makeClient(fetchMock);
    const result = await client.runScriptCommand('hs.GetAppVersion()');

    expect(result.responseArray).toEqual(['response', 'done']);
    expect(result.commands[0]).toEqual({ key: 'response', value: 'done' });
  });

  test('sanitizes credentials from debug URL logs', async () => {
    const fetchMock = vi.fn(async () => {
      return new Response(JSON.stringify({ Response: '4.2.22.4' }), {
        status: 200,
        headers: {
          'content-type': 'application/json'
        }
      });
    }) as unknown as typeof fetch;

    const logger = makeLogger();
    const client = makeClient(fetchMock, {
      baseUrl: 'http://embedded-user:embedded-pass@127.0.0.1',
      user: 'api-user',
      pass: 'api-pass',
      logger: logger as HS4ClientOptions['logger']
    });

    await client.getVersion();

    expect(logger.debug).toHaveBeenCalledTimes(1);
    const logPayload = logger.debug.mock.calls[0]?.[0] as { url: string };
    expect(logPayload.url).toBe('http://127.0.0.1/JSON?request=hsversion');
    expect(logPayload.url).not.toContain('user=');
    expect(logPayload.url).not.toContain('pass=');
    expect(logPayload.url).not.toContain('@');
  });

  test('includes configured auth params on runscript requests', async () => {
    const fetchMock = vi.fn(async () => {
      return new Response('["response","ok"]', {
        status: 200,
        headers: {
          'content-type': 'application/json'
        }
      });
    }) as unknown as typeof fetch;

    const client = makeClient(fetchMock, {
      user: 'script-user',
      pass: 'script-pass'
    });

    await client.runScriptCommand('hs.GetAppVersion()');

    const requestUrl = fetchMock.mock.calls[0]?.[0] as URL;
    expect(requestUrl.pathname).toBe('/runscript.html');
    expect(requestUrl.searchParams.get('user')).toBe('script-user');
    expect(requestUrl.searchParams.get('pass')).toBe('script-pass');
  });

  test('builds expected JSON requests for admin methods', async () => {
    const fetchMock = vi.fn(async () => {
      return new Response(JSON.stringify({ Response: 'ok' }), {
        status: 200,
        headers: {
          'content-type': 'application/json'
        }
      });
    }) as unknown as typeof fetch;

    const client = makeClient(fetchMock);

    const cases: Array<{
      invoke: () => Promise<unknown>;
      request: string;
      params: Record<string, string>;
    }> = [
      {
        invoke: () => client.usersList({ includeRoles: true, includeDisabled: true }),
        request: 'userslist',
        params: { includeroles: 'true', includedisabled: 'true' }
      },
      {
        invoke: () =>
          client.usersCreate({
            username: 'new-user',
            password: 'p@ss',
            role: 'admin',
            enabled: true,
            email: 'new@example.com'
          }),
        request: 'userscreate',
        params: {
          username: 'new-user',
          password: 'p@ss',
          role: 'admin',
          enabled: 'true',
          email: 'new@example.com'
        }
      },
      {
        invoke: () => client.usersUpdate({ username: 'new-user', role: 'user', enabled: false }),
        request: 'usersupdate',
        params: { username: 'new-user', role: 'user', enabled: 'false' }
      },
      {
        invoke: () => client.usersDelete({ username: 'old-user' }),
        request: 'usersdelete',
        params: { username: 'old-user' }
      },
      {
        invoke: () => client.usersSetRole({ username: 'person', role: 'admin' }),
        request: 'userssetrole',
        params: { username: 'person', role: 'admin' }
      },
      {
        invoke: () => client.interfacesList({ includeDisabled: true }),
        request: 'interfaceslist',
        params: { includedisabled: 'true' }
      },
      {
        invoke: () =>
          client.interfaceAdd({
            name: 'zwave',
            type: 'serial',
            address: '/dev/ttyUSB0',
            enabled: true,
            config: 'baud=115200'
          }),
        request: 'interfaceadd',
        params: {
          name: 'zwave',
          type: 'serial',
          address: '/dev/ttyUSB0',
          enabled: 'true',
          config: 'baud=115200'
        }
      },
      {
        invoke: () => client.interfaceUpdate({ id: 'if-1', name: 'zwave-main', enabled: false }),
        request: 'interfaceupdate',
        params: { id: 'if-1', name: 'zwave-main', enabled: 'false' }
      },
      {
        invoke: () => client.interfaceRemove({ id: 'if-2' }),
        request: 'interfaceremove',
        params: { id: 'if-2' }
      },
      {
        invoke: () => client.interfaceRestart({ id: 'if-3' }),
        request: 'interfacerestart',
        params: { id: 'if-3' }
      },
      {
        invoke: () => client.interfaceDiagnostics({ id: 'if-3', verbose: true }),
        request: 'interfacediagnostics',
        params: { id: 'if-3', verbose: 'true' }
      },
      {
        invoke: () =>
          client.systemRestoreStart({
            backupId: 'backup-01',
            sourcePath: '/tmp/hs4-backup.zip'
          }),
        request: 'systemrestorestart',
        params: { backupid: 'backup-01', sourcepath: '/tmp/hs4-backup.zip' }
      },
      {
        invoke: () => client.systemConfigGet({ key: 'timezone' }),
        request: 'systemconfigget',
        params: { key: 'timezone' }
      },
      {
        invoke: () => client.systemConfigSet({ key: 'timezone', value: 'UTC' }),
        request: 'systemconfigset',
        params: { key: 'timezone', value: 'UTC' }
      },
      {
        invoke: () => client.camerasConfigList({ includeDisabled: true }),
        request: 'camerasconfiglist',
        params: { includedisabled: 'true' }
      },
      {
        invoke: () =>
          client.cameraConfigCreate({
            name: 'Garage',
            source: 'rtsp://cam/stream',
            profile: 'main',
            recording: true
          }),
        request: 'cameraconfigcreate',
        params: {
          name: 'Garage',
          source: 'rtsp://cam/stream',
          profile: 'main',
          recording: 'true'
        }
      },
      {
        invoke: () => client.cameraConfigUpdate({ camId: 22, name: 'Garage Side', recording: false }),
        request: 'cameraconfigupdate',
        params: { camid: '22', name: 'Garage Side', recording: 'false' }
      },
      {
        invoke: () => client.cameraConfigDelete({ camId: 23 }),
        request: 'cameraconfigdelete',
        params: { camid: '23' }
      },
      {
        invoke: () => client.cameraStreamProfileSet({ camId: 24, profile: 'substream' }),
        request: 'camerastreamprofileset',
        params: { camid: '24', profile: 'substream' }
      },
      {
        invoke: () => client.cameraRecordingSet({ camId: 25, enabled: false }),
        request: 'camerarecordingset',
        params: { camid: '25', enabled: 'false' }
      },
      {
        invoke: () =>
          client.eventsCreate({
            group: 'Security',
            name: 'Door Open',
            trigger: 'door-open',
            action: 'notify'
          }),
        request: 'eventscreate',
        params: { group: 'Security', name: 'Door Open', trigger: 'door-open', action: 'notify' }
      },
      {
        invoke: () =>
          client.eventsUpdate({
            id: 77,
            name: 'Door Open Updated',
            action: 'notify-and-log'
          }),
        request: 'eventsupdate',
        params: { id: '77', name: 'Door Open Updated', action: 'notify-and-log' }
      },
      {
        invoke: () => client.eventsDelete({ id: 78 }),
        request: 'eventsdelete',
        params: { id: '78' }
      },
      {
        invoke: () =>
          client.configDeviceMetadataSet({
            ref: 101,
            name: 'Kitchen Lamp',
            location: 'Kitchen',
            location2: 'Ceiling',
            category: 'Lighting'
          }),
        request: 'configdevicemetadataset',
        params: {
          ref: '101',
          name: 'Kitchen Lamp',
          location: 'Kitchen',
          location2: 'Ceiling',
          category: 'Lighting'
        }
      },
      {
        invoke: () => client.configCategoriesList({ includeSystem: true }),
        request: 'configcategorieslist',
        params: { includesystem: 'true' }
      },
      {
        invoke: () =>
          client.configCategoryUpsert({
            id: 9,
            name: 'HVAC',
            location1: 'Main Floor',
            location2: 'Utility'
          }),
        request: 'configcategoryupsert',
        params: { id: '9', name: 'HVAC', location1: 'Main Floor', location2: 'Utility' }
      },
      {
        invoke: () => client.configCategoryDelete({ id: 10 }),
        request: 'configcategorydelete',
        params: { id: '10' }
      }
    ];

    for (const item of cases) {
      await item.invoke();
    }

    expect(fetchMock).toHaveBeenCalledTimes(cases.length);
    for (const [index, item] of cases.entries()) {
      const requestUrl = fetchMock.mock.calls[index]?.[0] as URL;
      expect(requestUrl.pathname).toBe('/JSON');
      expect(requestUrl.searchParams.get('request')).toBe(item.request);
      for (const [key, value] of Object.entries(item.params)) {
        expect(requestUrl.searchParams.get(key)).toBe(value);
      }
    }
  });

  test('builds expected backup.html action request for systemBackupStart', async () => {
    const fetchMock = vi.fn(async () => {
      return new Response('', {
        status: 200,
        headers: {
          'content-type': 'text/html'
        }
      });
    }) as unknown as typeof fetch;

    const client = makeClient(fetchMock);

    await client.systemBackupStart({ destination: '/tmp/hs4-backup.zip', note: 'nightly' });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const requestUrl = fetchMock.mock.calls[0]?.[0] as URL;
    expect(requestUrl.pathname).toBe('/backup.html');

    const requestInit = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const requestBody = new URLSearchParams(String(requestInit.body));
    expect(requestBody.get('action')).toBe('backup');
    expect(requestBody.get('destination')).toBeNull();
    expect(requestBody.get('note')).toBeNull();
  });

  test('builds expected pluginfunction requests for plugin admin methods', async () => {
    const fetchMock = vi.fn(async () => {
      return new Response(JSON.stringify({ Response: 'ok' }), {
        status: 200,
        headers: {
          'content-type': 'application/json'
        }
      });
    }) as unknown as typeof fetch;

    const client = makeClient(fetchMock);

    await client.pluginCatalogGet({ channel: 'beta' });
    await client.pluginInstall({ pluginId: 'com.acme.camera', version: '1.2.3', instance: 'main' });
    await client.pluginUpdate({ pluginId: 'com.acme.camera', version: '1.2.4' });
    await client.pluginRemove({ pluginId: 'com.acme.camera' });
    await client.pluginSetEnabled({ pluginId: 'com.acme.camera', enabled: false });
    await client.pluginRestart({ pluginId: 'com.acme.camera', instance: 'main' });

    const expected: Array<{
      functionName: string;
      instance?: string;
      p1?: string;
      p2?: string;
    }> = [
      { functionName: 'CatalogGet', p1: 'beta' },
      { functionName: 'InstallPlugin', instance: 'main', p1: 'com.acme.camera', p2: '1.2.3' },
      { functionName: 'UpdatePlugin', p1: 'com.acme.camera', p2: '1.2.4' },
      { functionName: 'RemovePlugin', p1: 'com.acme.camera' },
      { functionName: 'SetPluginEnabled', p1: 'com.acme.camera', p2: 'false' },
      { functionName: 'RestartPlugin', instance: 'main', p1: 'com.acme.camera' }
    ];

    expect(fetchMock).toHaveBeenCalledTimes(expected.length);
    for (const [index, item] of expected.entries()) {
      const requestUrl = fetchMock.mock.calls[index]?.[0] as URL;
      expect(requestUrl.pathname).toBe('/JSON');
      expect(requestUrl.searchParams.get('request')).toBe('pluginfunction');
      expect(requestUrl.searchParams.get('plugin')).toBe('updater');
      expect(requestUrl.searchParams.get('function')).toBe(item.functionName);
      expect(requestUrl.searchParams.get('instance')).toBe(item.instance ?? null);
      expect(requestUrl.searchParams.get('P1')).toBe(item.p1 ?? null);
      expect(requestUrl.searchParams.get('P2')).toBe(item.p2 ?? null);
    }
  });

  test('builds expected runscript requests for system script methods', async () => {
    const fetchMock = vi.fn(async () => {
      return new Response('["response","ok"]', {
        status: 200,
        headers: {
          'content-type': 'application/json'
        }
      });
    }) as unknown as typeof fetch;

    const client = makeClient(fetchMock);

    await client.systemServiceRestart({ service: 'Main Service' });
    await client.systemShutdown({ delaySeconds: 30.9 });

    expect(fetchMock).toHaveBeenCalledTimes(2);

    const firstUrl = fetchMock.mock.calls[0]?.[0] as URL;
    expect(firstUrl.pathname).toBe('/runscript.html');
    const firstInit = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const firstBody = new URLSearchParams(String(firstInit.body));
    expect(firstBody.get('action')).toBe('run_script_command');
    expect(firstBody.get('scriptcommand')).toBe('hs.RestartService("Main Service")');

    const secondUrl = fetchMock.mock.calls[1]?.[0] as URL;
    expect(secondUrl.pathname).toBe('/runscript.html');
    const secondInit = fetchMock.mock.calls[1]?.[1] as RequestInit;
    const secondBody = new URLSearchParams(String(secondInit.body));
    expect(secondBody.get('action')).toBe('run_script_command');
    expect(secondBody.get('scriptcommand')).toBe('hs.Shutdown(30)');
  });

  test('returns UNSUPPORTED_ON_TARGET for optional endpoint errors', async () => {
    const fetchMock = vi.fn(async () => {
      return new Response(JSON.stringify({ Response: 'Error, bad request: unknown request userslist' }), {
        status: 200,
        headers: {
          'content-type': 'application/json'
        }
      });
    }) as unknown as typeof fetch;

    const client = makeClient(fetchMock);

    await expect(client.usersList()).rejects.toMatchObject({
      name: 'HS4McpError',
      code: 'UNSUPPORTED_ON_TARGET',
      details: expect.objectContaining({
        transport: 'json',
        endpoint: 'userslist',
        sourceCode: 'HS4_ERROR'
      })
    });
  });

  test('sanitizes credentials for runscript method debug logs', async () => {
    const fetchMock = vi.fn(async () => {
      return new Response('["response","ok"]', {
        status: 200,
        headers: {
          'content-type': 'application/json'
        }
      });
    }) as unknown as typeof fetch;

    const logger = makeLogger();
    const client = makeClient(fetchMock, {
      baseUrl: 'http://embedded-user:embedded-pass@127.0.0.1',
      user: 'api-user',
      pass: 'api-pass',
      logger: logger as HS4ClientOptions['logger']
    });

    await client.systemShutdown({ delaySeconds: 5 });

    expect(logger.debug).toHaveBeenCalledTimes(1);
    const logPayload = logger.debug.mock.calls[0]?.[0] as { url: string };
    expect(logPayload.url).toBe('http://127.0.0.1/runscript.html');
    expect(logPayload.url).not.toContain('user=');
    expect(logPayload.url).not.toContain('pass=');
    expect(logPayload.url).not.toContain('@');
  });
});
