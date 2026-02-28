import process from 'node:process';
import { readFile } from 'node:fs/promises';

import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';

import { loadConfig } from './config.js';
import { createLogger } from './logger.js';
import { AuditStore } from './audit/auditStore.js';
import { PolicyEngine } from './policy/policyEngine.js';
import { HS4Client } from './hs4/client.js';
import { buildMcpServer } from './mcp/server.js';
import { negotiateMcpPostAccept } from './http/acceptNegotiation.js';
import { AliasCatalog } from './alias/aliasCatalog.js';
import { ChangeTokenStore } from './change/changeTokenStore.js';

function parseAliasConfigPayload(value: unknown): Record<string, string[]> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }

  const result: Record<string, string[]> = {};
  for (const [key, aliases] of Object.entries(value as Record<string, unknown>)) {
    if (!Array.isArray(aliases)) {
      continue;
    }
    const normalized = aliases
      .filter((item): item is string => typeof item === 'string')
      .map((item) => item.trim())
      .filter(Boolean);
    if (normalized.length) {
      result[key] = normalized;
    }
  }

  return result;
}

async function loadAliasConfig(path: string | undefined): Promise<Record<string, string[]>> {
  if (!path) {
    return {};
  }

  try {
    const raw = await readFile(path, 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    return parseAliasConfigPayload(parsed);
  } catch {
    return {};
  }
}

function toWebHeaders(reqHeaders: Record<string, string | string[] | undefined>, acceptOverride?: string): Headers {
  const headers = new Headers();
  for (const [key, value] of Object.entries(reqHeaders)) {
    if (value === undefined) {
      continue;
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        headers.append(key, item);
      }
      continue;
    }
    headers.set(key, value);
  }

  if (acceptOverride) {
    headers.set('accept', acceptOverride);
  }

  return headers;
}

function toRequestUrl(req: { protocol: string; headers: Record<string, string | string[] | undefined>; originalUrl: string }): string {
  const fallbackHost = '127.0.0.1';
  const hostHeader = req.headers.host;
  const host = Array.isArray(hostHeader) ? hostHeader[0] : hostHeader;
  return `${req.protocol}://${host || fallbackHost}${req.originalUrl}`;
}

function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase().replace(/^\[(.*)\]$/, '$1');
  if (!normalized) {
    return false;
  }
  if (normalized === 'localhost' || normalized === '::1') {
    return true;
  }
  return normalized.startsWith('127.');
}

function extractBearerToken(authorizationHeader: string | string[] | undefined): string | undefined {
  if (!authorizationHeader) {
    return undefined;
  }

  const rawValue = Array.isArray(authorizationHeader) ? authorizationHeader[0] : authorizationHeader;
  const match = rawValue.match(/^Bearer\s+(.+)$/i);
  if (!match) {
    return undefined;
  }
  const token = match[1]?.trim();
  return token || undefined;
}

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config.logLevel);

  const audit = new AuditStore(config.auditMaxEntries, config.auditPersistPath);
  const policy = new PolicyEngine(config);
  const aliasCatalog = new AliasCatalog({
    learnedEnabled: config.hs4AliasLearnedEnabled
  });
  aliasCatalog.setConfigAliases(await loadAliasConfig(config.hs4AliasConfigPath));
  const changeTokenStore = new ChangeTokenStore({
    ttlSec: config.hs4ChangeTokenTtlSec,
    maxEntries: config.hs4ChangeTokenMaxEntries,
    persistPath: config.hs4ChangeTokenPersistPath
  });
  await changeTokenStore.init();
  const client = new HS4Client({
    baseUrl: config.hs4BaseUrl,
    user: config.hs4User,
    pass: config.hs4Pass,
    timeoutMs: config.requestTimeoutMs,
    readRetries: config.readRetries,
    readRetryBackoffMs: config.readRetryBackoffMs,
    scriptPagePath: config.scriptPagePath,
    logger
  });

  const deps = {
    config,
    logger,
    client,
    policy,
    audit,
    aliasCatalog,
    changeTokenStore
  };

  if (config.mcpTransport === 'stdio') {
    const server = buildMcpServer(deps);
    const transport = new StdioServerTransport();
    await server.connect(transport);

    logger.info(
      {
        transport: 'stdio',
        baseUrl: config.hs4BaseUrl,
        safeMode: config.safeMode
      },
      'mcp-hs4 running on stdio'
    );

    const shutdown = async () => {
      logger.info('Shutting down stdio server');
      await server.close();
      process.exit(0);
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
    return;
  }

  const isLoopbackBinding = isLoopbackHost(config.mcpHttpHost);

  if (!isLoopbackBinding) {
    if (!config.mcpHttpAllowNonLoopback) {
      throw new Error(
        `Refusing to bind MCP HTTP transport to non-loopback host "${config.mcpHttpHost}". ` +
          'Set MCP_HTTP_ALLOW_NON_LOOPBACK=true to override intentionally.'
      );
    }
    logger.warn(
      {
        host: config.mcpHttpHost,
        port: config.mcpHttpPort
      },
      'MCP HTTP transport is binding to a non-loopback host because MCP_HTTP_ALLOW_NON_LOOPBACK is enabled'
    );
  }

  if (!isLoopbackBinding && config.mcpHttpAuthRequiredNonLoopback && !config.mcpHttpAuthToken) {
    throw new Error(
      'MCP_HTTP_AUTH_REQUIRED_NON_LOOPBACK=true requires MCP_HTTP_AUTH_TOKEN when binding non-loopback HTTP hosts.'
    );
  }

  const httpAuthRequired = Boolean(config.mcpHttpAuthToken) || (!isLoopbackBinding && config.mcpHttpAuthRequiredNonLoopback);

  const app = createMcpExpressApp({
    host: config.mcpHttpHost
  });

  const authorizeHttpRequest = (
    authorizationHeader: string | string[] | undefined,
    route: 'mcp' | 'healthz',
    res: {
      status: (status: number) => { json: (body: unknown) => void };
    }
  ): boolean => {
    const routeProtected = route === 'mcp' ? httpAuthRequired : httpAuthRequired && config.mcpHttpAuthProtectHealthz;
    if (!routeProtected) {
      return true;
    }

    const expectedToken = config.mcpHttpAuthToken;
    if (!expectedToken) {
      logger.error({ route }, 'HTTP auth is required but MCP_HTTP_AUTH_TOKEN is not configured');
      if (route === 'mcp') {
        res.status(500).json({
          jsonrpc: '2.0',
          error: {
            code: -32603,
            message: 'Server auth configuration error'
          },
          id: null
        });
      } else {
        res.status(500).json({
          status: 'error',
          error: 'Server auth configuration error',
          timestamp: new Date().toISOString()
        });
      }
      return false;
    }

    const providedToken = extractBearerToken(authorizationHeader);
    if (!providedToken) {
      logger.warn({ route }, 'HTTP request denied: missing Bearer token');
      if (route === 'mcp') {
        res.status(401).json({
          jsonrpc: '2.0',
          error: {
            code: -32001,
            message: 'Unauthorized'
          },
          id: null
        });
      } else {
        res.status(401).json({
          status: 'error',
          error: 'Unauthorized',
          timestamp: new Date().toISOString()
        });
      }
      return false;
    }

    if (providedToken !== expectedToken) {
      logger.warn({ route }, 'HTTP request denied: invalid Bearer token');
      if (route === 'mcp') {
        res.status(403).json({
          jsonrpc: '2.0',
          error: {
            code: -32003,
            message: 'Forbidden'
          },
          id: null
        });
      } else {
        res.status(403).json({
          status: 'error',
          error: 'Forbidden',
          timestamp: new Date().toISOString()
        });
      }
      return false;
    }

    return true;
  };

  app.get('/healthz', async (req, res) => {
    if (!authorizeHttpRequest(req.headers.authorization, 'healthz', res)) {
      return;
    }

    try {
      const version = await client.getVersion();
      res.status(200).json({
        status: 'ok',
        hs4Version: version,
        safeMode: config.safeMode,
        transport: config.mcpTransport,
        mcpHttpAuthRequired: httpAuthRequired,
        mcpHttpAuthProtectHealthz: config.mcpHttpAuthProtectHealthz,
        mcpHttpAcceptMode: config.mcpHttpAcceptMode,
        mcpHttpAllowJsonOnly: config.mcpHttpAllowJsonOnly,
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(503).json({
        status: 'error',
        error: message,
        timestamp: new Date().toISOString()
      });
    }
  });

  app.post('/mcp', async (req, res) => {
    if (!authorizeHttpRequest(req.headers.authorization, 'mcp', res)) {
      return;
    }

    const acceptNegotiation = negotiateMcpPostAccept(req.headers.accept, {
      mode: config.mcpHttpAcceptMode,
      allowJsonOnly: config.mcpHttpAllowJsonOnly
    });

    logger.info(
      {
        mode: acceptNegotiation.mode,
        allowJsonOnly: acceptNegotiation.allowJsonOnly,
        originalAccept: acceptNegotiation.originalAccept,
        effectiveAccept: acceptNegotiation.effectiveAccept,
        fallbackApplied: acceptNegotiation.fallbackApplied,
        forceJsonResponse: acceptNegotiation.forceJsonResponse
      },
      'MCP HTTP accept negotiation'
    );

    if (!acceptNegotiation.allowed) {
      res.status(406).json({
        jsonrpc: '2.0',
        error: {
          code: -32000,
          message: acceptNegotiation.rejectionMessage ?? 'Not Acceptable'
        },
        id: null
      });
      return;
    }

    const server = buildMcpServer(deps);

    try {
      if (acceptNegotiation.forceJsonResponse) {
        const transport = new WebStandardStreamableHTTPServerTransport({
          sessionIdGenerator: undefined,
          enableJsonResponse: true
        });

        await server.connect(transport);
        const webResponse = await transport.handleRequest(
          new Request(toRequestUrl(req), {
            method: req.method,
            headers: toWebHeaders(req.headers, acceptNegotiation.effectiveAccept)
          }),
          {
            parsedBody: req.body
          }
        );

        res.status(webResponse.status);
        webResponse.headers.forEach((value, key) => {
          res.setHeader(key, value);
        });

        if (webResponse.body) {
          const bodyText = await webResponse.text();
          res.send(bodyText);
        } else {
          res.end();
        }

        await transport.close().catch(() => undefined);
        await server.close().catch(() => undefined);
        return;
      }

      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);

      res.on('close', () => {
        transport.close().catch(() => undefined);
        server.close().catch(() => undefined);
      });
    } catch (error) {
      logger.error({ error }, 'HTTP transport request failed');
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: '2.0',
          error: {
            code: -32603,
            message: 'Internal server error'
          },
          id: null
        });
      }
      await server.close().catch(() => undefined);
    }
  });

  app.get('/mcp', (_req, res) => {
    res.status(405).json({
      jsonrpc: '2.0',
      error: {
        code: -32000,
        message: 'Method not allowed.'
      },
      id: null
    });
  });

  app.delete('/mcp', (_req, res) => {
    res.status(405).json({
      jsonrpc: '2.0',
      error: {
        code: -32000,
        message: 'Method not allowed.'
      },
      id: null
    });
  });

  const httpServer = app.listen(config.mcpHttpPort, config.mcpHttpHost, () => {
    logger.info(
      {
        transport: 'http',
        host: config.mcpHttpHost,
        port: config.mcpHttpPort,
        baseUrl: config.hs4BaseUrl,
        safeMode: config.safeMode,
        mcpHttpAuthRequired: httpAuthRequired,
        mcpHttpAuthProtectHealthz: config.mcpHttpAuthProtectHealthz
      },
      'mcp-hs4 running on streamable HTTP'
    );
  });

  const shutdown = () => {
    logger.info('Shutting down HTTP server');
    httpServer.close(() => process.exit(0));
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((error) => {
  const text = error instanceof Error ? error.stack ?? error.message : String(error);
  console.error(text);
  process.exit(1);
});
