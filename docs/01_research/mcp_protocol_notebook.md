# MCP Protocol Notebook

Date: February 23, 2026

This notebook distills MCP implementation choices for `mcp-hs4`.

## Protocol/SDK Targets

- MCP TypeScript SDK: `@modelcontextprotocol/sdk` 1.26.0
- Server primitive: `McpServer`
- Transports:
- `StdioServerTransport`
- `StreamableHTTPServerTransport`

## Chosen Surface Model

- Tools for action-oriented operations (read and mutate)
- Resources for durable state snapshots and catalogs
- Prompts for safe operational workflows

## Why This Split

- Tools map cleanly to HS4 API calls and side effects.
- Resources reduce repetitive prompt/tool chatter for common model context.
- Prompts enforce consistent operator behavior in guardrail-heavy workflows.

## Key MCP Decisions

- Structured responses include both human-readable `content` and `structuredContent`.
- Mutating tools are policy-gated before execution.
- Audit trail is first-class and queryable as both tool and resource.
- HTTP mode is stateless-per-request server instance to reduce session coupling complexity in the initial release.

## Security-Relevant Mapping

- MCP tool arguments include explicit `confirm`, `intent`, `reason`, `dryRun` where mutation exists.
- Policy decisions are logged with allow/deny reasons.
- Read-only global mode can be enforced via environment.

## Future MCP Expansions

- Resource templates for per-ref URI discovery (`hs4://devices/{ref}`)
- Task-based long-running operations (if needed for heavy admin workflows)
- Optional OAuth-protected HTTP mode for remote gateway profile
