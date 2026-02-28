# System Design

## Overview

`mcp-hs4` is a sidecar MCP server that translates MCP operations into HS4 API calls with normalization, policy gating, and audit logging.

## Components

1. `HS4Client`
- Handles HTTP requests to HS4 (`/JSON` + script UI action route)
- Applies timeouts and read retries
- Applies auth query params when configured
- Provides endpoint methods for tools/resources

2. `Normalizer`
- Converts heterogeneous HS4 payloads into stable internal DTOs
- Infers basic capabilities from control labels/status text

3. `PolicyEngine`
- Enforces guarded-write checks:
- confirm/intent/reason
- global read-only mode
- optional allowlists
- dry-run handling

4. `AuditStore`
- Ring buffer of operation records
- Optional JSONL persistence sink
- Query interface for tooling and resource exposure

5. `MCP Surface`
- Tools/resources/prompts registration
- Tool-level wrappers for policy + auditing + unified error handling
- Device-mutation reliability layer for post-write convergence verification and controlled fallback

6. `Transport Bootstrap`
- `stdio` mode for local process-hosted clients
- `http` mode with `/mcp` endpoint + `/healthz`

## Data Flow

1. MCP client invokes tool/resource.
2. Server validates input schema.
3. For mutating tools:
- Policy decision computed
- Optional dry-run short-circuit
4. HS4 call executed via `HS4Client`.
5. For device writes, server runs fresh-state convergence checks and conditional recovery (`set_status` -> `control_value`) before finalizing response.
6. Payload normalized/filtered.
7. Audit entry recorded.
8. MCP response returned.

## Failure Handling

- Timeout -> `TIMEOUT`
- Network failures -> `NETWORK`
- HTTP auth failures -> `AUTH`
- HS4 response-level failure strings -> `HS4_ERROR`
- Device-write non-convergence after verification/recovery -> `HS4_ERROR` with verification details
- Policy denies -> `POLICY_DENY`

## Deployment Boundaries

- Intended default: local host with HS4 (`127.0.0.1` pathing)
- Optional LAN-serving HTTP mode with host binding controls
- No cloud dependencies for core operation
