# mcp-hs4

Production-oriented MCP server for HomeSeer HS4.

This project provides MCP tools, resources, and prompts so MCP-compatible LLM agents can read and control HS4 safely with auditability, guarded writes, and local-sidecar deployment.

## Start Here

1. Install and build:

```bash
npm install
npm run build
```

2. Configure environment:

```bash
cp .env.example .env
# set HS4_BASE_URL and any auth/guard settings needed for your installation
```

3. Run server (production path):

```bash
node dist/index.js
```

4. Optional development mode:

```bash
npm run dev
```

5. Register in Codex CLI:

```bash
codex mcp add hs4 \
  --env HS4_BASE_URL=http://127.0.0.1 \
  --env HS4_REQUIRE_CONFIRM=true \
  --env HS4_SAFE_MODE=read_write \
  --env MCP_LOG_LEVEL=info \
  -- node /absolute/path/to/mcp-hs4/dist/index.js
```

6. Smoke test:

```bash
codex mcp list
codex mcp get hs4 --json
codex exec --skip-git-repo-check -C /absolute/path/to/mcp-hs4 \
  "Use only hs4 MCP tools. Run hs4.selftest.run and summarize any warnings."
```

## At a Glance

- Contract namespaces: `hs4.*`, `hs4.admin.*`
- Runtime: Node 20+, TypeScript
- Transports: `stdio` (default), `http` (streamable MCP endpoint)
- Safety defaults: confirm+intent+reason guardrails, dry-run-first intent tools, audit logging
- Write reliability: post-write verification with fallback logic in `hs4.devices.set`

## Architecture

```text
MCP Client (Codex / Claude / Cursor / Cline)
  -> MCP transport (stdio or HTTP)
mcp-hs4 server
  -> HS4 JSON API (/JSON?request=...)
  -> HS4 script route (/runscript.html)
HomeSeer HS4
```

## Project Scope

- This repository is strictly the HomeSeer 4 MCP server implementation (`mcp-hs4`).
- Client-specific adapters, UIs, and app integrations belong in separate repositories.
- Public API contract in this repo is `hs4.*` and `hs4.admin.*`.

## Current Status

- Runtime: TypeScript/Node 20+
- MCP SDK: `@modelcontextprotocol/sdk`
- HS4 integration target: JSON API (`/JSON?request=...`) plus script command path (`/runscript.html`)
- Contract version: `1.0.0`
- Deployment profiles: `stdio` for local MCP client process spawning (default), `streamable-http` for optional local LAN service mode

## Implemented MCP Surface

### Namespaces

- `hs4.*` standard read and control operations
- `hs4.admin.*` privileged administration operations (disabled by default)

### Tools

Registered tools are listed below. For release verification, confirm the runtime contract with `hs4://capabilities/matrix`.

Core tools:

- `hs4.health.get`
- `hs4.help.route`
- `hs4.resolve.devices`
- `hs4.resolve.events`
- `hs4.resolve.cameras`
- `hs4.change.prepare`
- `hs4.change.commit`
- `hs4.intent.device_set_by_name`
- `hs4.intent.event_run_by_name`
- `hs4.intent.scene_activate`
- `hs4.selftest.run`
- `hs4.devices.list`
- `hs4.devices.get`
- `hs4.devices.controls.get`
- `hs4.devices.status.get`
- `hs4.devices.set`
- `hs4.events.list`
- `hs4.events.get`
- `hs4.events.definition.get`
- `hs4.events.run`
- `hs4.scripts.run`
- `hs4.plugins.function.call`
- `hs4.plugins.list`
- `hs4.cameras.list`
- `hs4.cameras.snapshot.get`
- `hs4.cameras.pan`
- `hs4.audit.query`

Admin tools:

- `hs4.admin.users.list`
- `hs4.admin.users.create`
- `hs4.admin.users.update`
- `hs4.admin.users.delete`
- `hs4.admin.users.set_role`
- `hs4.admin.plugins.catalog.get`
- `hs4.admin.plugins.install`
- `hs4.admin.plugins.update`
- `hs4.admin.plugins.remove`
- `hs4.admin.plugins.set_enabled`
- `hs4.admin.plugins.restart`
- `hs4.admin.interfaces.list`
- `hs4.admin.interfaces.add`
- `hs4.admin.interfaces.update`
- `hs4.admin.interfaces.remove`
- `hs4.admin.interfaces.restart`
- `hs4.admin.interfaces.diagnostics`
- `hs4.admin.system.backup.start`
- `hs4.admin.system.restore.start`
- `hs4.admin.system.service.restart`
- `hs4.admin.system.shutdown`
- `hs4.admin.system.config.get`
- `hs4.admin.system.config.set`
- `hs4.admin.cameras.config.list`
- `hs4.admin.cameras.config.create`
- `hs4.admin.cameras.config.update`
- `hs4.admin.cameras.config.delete`
- `hs4.admin.cameras.stream_profile.set`
- `hs4.admin.cameras.recording.set`
- `hs4.admin.events.create`
- `hs4.admin.events.update`
- `hs4.admin.events.delete`
- `hs4.admin.config.device_metadata.set`
- `hs4.admin.config.categories.list`
- `hs4.admin.config.category.upsert`
- `hs4.admin.config.category.delete`

### Resources

- `hs4://devices/catalog`
- `hs4://devices/catalog/full`
- `hs4://devices/status`
- `hs4://devices/status/full`
- `hs4://events/catalog`
- `hs4://capabilities/matrix`
- `hs4://audit/recent`
- `hs4://state/summary`
- `hs4://catalog/aliases`
- `hs4://agent/contract`
- `hs4://admin/users`
- `hs4://admin/interfaces`
- `hs4://admin/plugins`
- `hs4://admin/cameras/config`
- `hs4://admin/policy/state` (includes admin execution mode and related routing policy state)
- `hs4://admin/audit/diff`

### Prompts

- `hs4_safe_control`
- `hs4_scene_operator`
- `hs4_diagnostics`
- `hs4_agent_contract`
- `hs4_admin_change_control`
- `hs4_admin_backup_restore`
- `hs4_admin_plugin_lifecycle`

## Guarded Write Model

Mutating tools are policy-gated by default.

Base guard requirements for all mutating tools:

- `confirm=true` required (unless dry-run)
- `intent` and `reason` required (unless dry-run)
- Global read-only mode via `HS4_SAFE_MODE=read_only`
- Optional allowlists for device refs, event ids, script ids, camera ids, plugin functions
- Mutation attempts and outcomes are audit-logged

Admin tool guard model (`hs4.admin.*`):

- Inputs include `operationTier`, `domain`, `maintenanceWindowId`, `changeTicket`, and `riskLevel`
- `operationTier` currently defaults to `operator`
- When `operationTier=admin`, policy enforces:
- `HS4_ADMIN_ENABLED=true`
- Domain-specific admin flag enabled for the selected domain
- `maintenanceWindowId` present (and matching configured allowlist/required id when set)
- `changeTicket` present when `HS4_ADMIN_REQUIRE_CHANGE_TICKET=true`

## Admin Execution Modes

Admin tools support three execution routing modes:

- `adapter` (default): use adapter-backed admin execution paths first.
- `direct`: use direct HS4 admin execution paths.
- `auto`: try direct execution and cache unsupported operations so subsequent calls route straight to adapter.

Execution routing is controlled by:

- `HS4_ADMIN_EXECUTION_MODE` default: `adapter`
- `HS4_ADMIN_DIRECT_FALLBACK` default: `true` (allow direct/auto paths to fall back to adapter when direct execution is unsupported)
- `HS4_ADMIN_CAPABILITY_CACHE_TTL_SEC` default: `300` (cache TTL, in seconds, for unsupported direct-operation capability checks)

Production recommendation:

- Keep `HS4_ADMIN_EXECUTION_MODE=adapter`, `HS4_ADMIN_DIRECT_FALLBACK=true`, and `HS4_ADMIN_CAPABILITY_CACHE_TTL_SEC=300` unless you have a validated operational reason to force `direct`.
- `hs4://admin/policy/state` reports the active admin execution mode and related routing policy state so operators can verify runtime behavior.

Two-phase mutation model (`hs4.change.*`):

- `hs4.change.prepare` validates and stages a mutation as a dry-run plan.
- `hs4.change.commit` executes the prepared token if policy checks still pass.
- Prepared tokens are TTL-bound and can be persisted across restarts.

Device write reliability (`hs4.devices.set`):

- Default mutation mode is `control_value`; use `set_status` only when explicitly required.
- `verify=true` by default; writes are followed by targeted fresh-state readback.
- `mode=set_status` with a value may be auto-switched to `control_value` when control pairs indicate that path is safer.
- If `set_status` does not converge, the server attempts a guarded `control_value` fallback when feasible.
- Non-converged writes return `HS4_ERROR` instead of reporting a false success.
- Successful write responses include convergence context (`requestedMode`, `mode`, `verification`, optional `modeAutoSwitch`, optional `fallback`).
- `dryRun=true` validates policy and schema only; it does not perform live write verification.

Resolver and intent targeting behavior:

- `hs4.resolve.devices` now returns `recommended=true` on the best mutation target and includes `recommendedRef`.
- For ambiguous parent/master vs endpoint matches, resolver ranking prefers actionable endpoints (for example child refs with control pairs) unless the query explicitly asks for `master`, `scene`, `parent`, or `root`.
- `hs4.intent.device_set_by_name` and device-fallback `hs4.intent.scene_activate` include `resolution` metadata and can emit `warnings` with code `PARENT_OR_WRAPPER_TARGET` when a wrapper/master target is chosen while an endpoint alternative exists.
- `hs4.intent.scene_activate` supports deterministic path control with `preferPath` (`auto`, `event`, `device_fallback`).
- `hs4.intent.scene_activate` returns `selection` metadata (`selectedPath`, `reason`, `topEventScore`, `topDeviceScore`, `eventMinScore`) so clients can explain why an event or device fallback path was selected.

Actionable error contract (all tools):

- Every error includes: `code`, `message`, `retryable`, `fixHint`, `suggestedNextToolCalls`.
- Tool-specific context remains under `details`.

## Contract Naming

Tool names in this project follow the `hs4.*` and `hs4.admin.*` contract shown above.

### Admin payload delta example

Standard script call:

```json
{
  "command": "my_script(arg1)",
  "confirm": true,
  "intent": "recover interface",
  "reason": "operator request"
}
```

Admin mutation call:

```json
{
  "command": "my_script(arg1)",
  "confirm": true,
  "intent": "recover interface",
  "reason": "operator request",
  "operationTier": "admin",
  "domain": "system",
  "maintenanceWindowId": "MW-2026-02-23-02",
  "changeTicket": "CHG-4821",
  "riskLevel": "medium"
}
```

## Detailed Setup and Client Integration

### 1) Install dependencies

```bash
npm install
```

### 2) Configure env

```bash
cp .env.example .env
# edit values as needed
```

### 3) Run in stdio mode (default)

```bash
npm run dev
```

## Client Setup

This server is primarily designed to be used as an MCP stdio server (the client spawns `node dist/index.js`).
HTTP mode is optional and mainly useful when a client only supports streamable HTTP MCP.

### Common stdio config pattern

- Command: `node`
- Args: `<absolute-path>/dist/index.js`
- Env: set `HS4_*` and `MCP_*` variables (do not put credentials in `HS4_BASE_URL`)

Example environment values:

```json
{
  "HS4_BASE_URL": "http://127.0.0.1",
  "HS4_REQUIRE_CONFIRM": "true",
  "HS4_SAFE_MODE": "read_write",
  "MCP_LOG_LEVEL": "info"
}
```

### Codex CLI (recommended)

Register:

```bash
codex mcp add hs4 \
  --env HS4_BASE_URL=http://127.0.0.1 \
  --env HS4_REQUIRE_CONFIRM=true \
  --env HS4_SAFE_MODE=read_write \
  --env MCP_LOG_LEVEL=info \
  -- node /absolute/path/to/mcp-hs4/dist/index.js
```

Verify registration:

```bash
codex mcp list
codex mcp get hs4 --json
```

Prompt-level test:

```bash
codex exec --skip-git-repo-check -C /absolute/path/to/mcp-hs4 \
  "Use only hs4 MCP tools. Run hs4.selftest.run and summarize any warnings."
```

### LLM Prompt Cookbook

Use these prompts as copy/paste starters for Codex or other MCP-capable agents.
Device names shown here are examples; replace them with names from your own HS4 installation.

1. Deterministic event-first scene activation

```text
Use only hs4 MCP tools.
Objective: activate "movie time".

Workflow:
1) Dry-run `hs4.intent.scene_activate` with:
   - objective: "movie time"
   - preferPath: "event"
   - execute: false
   - dryRun: true
   - confirm: true
   - intent: "Activate movie time scene"
   - reason: "Event-first deterministic scene activation"
2) If step 1 returns NOT_FOUND, run a second dry-run with preferPath: "device_fallback".
3) Execute only the successful path (`execute: true`, `dryRun: false`).
4) Report: `path`, `selection.selectedPath`, `selection.reason`, and any `warnings`.
```

2. Deterministic device-fallback scene activation

```text
Use only hs4 MCP tools.
Objective: activate "coffee bar" using direct device fallback.

Workflow:
1) Dry-run `hs4.intent.scene_activate` with:
   - objective: "coffee bar"
   - preferPath: "device_fallback"
   - fallbackDeviceValue: 99
   - execute: false
   - dryRun: true
   - confirm: true
   - intent: "Direct device fallback activation"
   - reason: "Prefer endpoint control over event path"
2) Execute the same call only if dry-run succeeds.
3) Return `selection` metadata and any `PARENT_OR_WRAPPER_TARGET` warnings.
```

3. Endpoint-first light control (avoid wrapper/master ghost success)

```text
Use only hs4 MCP tools.
Goal: turn on coffee bar and bar overhead to max.

Workflow:
1) Resolve candidates with `hs4.resolve.devices` for "coffee bar" and "bar overhead light", `includeEvidence=true`.
2) Choose each query's `recommendedRef` when available.
3) Write with `hs4.devices.set` using:
   - mode: "control_value"
   - value: 99
   - verify: true
   - confirm: true
   - intent/reason filled
4) Immediately read back using `hs4.devices.get` (`includeControls=true`) for written refs.
5) Report per-ref: requested mode, applied mode, verification result, status, and value.
```

4. Wrapper/master-safe intent flow

```text
Use only hs4 MCP tools.
Goal: act on "bar overhead light master" safely.

Workflow:
1) Run `hs4.intent.device_set_by_name` dry-run with query "bar overhead light master", mode "control_value", value 99.
2) If warnings include code `PARENT_OR_WRAPPER_TARGET`, re-run dry-run using the warning `suggestedRef` with `hs4.devices.set`.
3) Execute only after the second dry-run confirms endpoint targeting.
4) Return both runs and explain which target was committed and why.
```

5. Physical-state mismatch recovery prompt

```text
Use only hs4 MCP tools.
User says: "HS4 reports on, but the light is physically off."

Workflow:
1) Read current state with `hs4.devices.get` (`includeControls=true`).
2) Apply recovery pulse with `hs4.devices.set` (`mode=control_value`, `value=0`, `verify=true`) then `value=99`, both with confirm/intent/reason.
3) Re-read state after each write.
4) If still mismatched, run `hs4.intent.scene_activate` dry-run with `preferPath=device_fallback`, then execute if clean.
5) Report exact tool outputs and where convergence failed or succeeded.
```

### Claude Desktop

Add an MCP server entry (client UI/paths vary by OS and version; look for an MCP servers config section).
Most installations accept a config shaped like:

```json
{
  "mcpServers": {
    "hs4": {
      "command": "node",
      "args": ["/absolute/path/to/mcp-hs4/dist/index.js"],
      "env": {
        "HS4_BASE_URL": "http://127.0.0.1",
        "HS4_REQUIRE_CONFIRM": "true",
        "HS4_SAFE_MODE": "read_write",
        "MCP_LOG_LEVEL": "info"
      }
    }
  }
}
```

### Cursor

Cursor’s MCP UI/config evolves quickly; use the same stdio pattern:

- Add MCP server named `hs4`
- Command `node`
- Args `.../dist/index.js`
- Env includes `HS4_BASE_URL`, `HS4_REQUIRE_CONFIRM`, `HS4_SAFE_MODE`

### Cline (VS Code)

Cline’s MCP settings also evolve; use the same stdio pattern:

- Add MCP server named `hs4`
- Command `node`
- Args `.../dist/index.js`
- Env includes `HS4_BASE_URL`, `HS4_REQUIRE_CONFIRM`, `HS4_SAFE_MODE`

### 4) Optional: run as HTTP MCP service

```bash
MCP_TRANSPORT=http MCP_HTTP_HOST=127.0.0.1 MCP_HTTP_PORT=7422 npm run dev
```

Health endpoint in HTTP mode:

```bash
curl http://127.0.0.1:7422/healthz
```

When exposing beyond loopback, set an auth token and include `Authorization: Bearer <token>` on `POST /mcp` (and `/healthz` unless disabled):

```bash
MCP_TRANSPORT=http \
MCP_HTTP_HOST=0.0.0.0 \
MCP_HTTP_ALLOW_NON_LOOPBACK=true \
MCP_HTTP_AUTH_TOKEN=replace-me \
npm run dev
```

### HTTP Client Compatibility (JSON-only clients)

Some MCP clients send `Accept: application/json` only on `POST /mcp`.

- `MCP_HTTP_ACCEPT_MODE=compat` (default) allows these clients.
- `MCP_HTTP_ALLOW_JSON_ONLY=true` (default) enables a compatibility fallback that still preserves streamable clients.
- `MCP_HTTP_ACCEPT_MODE=strict` enforces explicit `application/json` and `text/event-stream`.

Compatibility probes:

```bash
# JSON-only client probe (should pass in compat mode)
curl -si -X POST http://127.0.0.1:7422/mcp \
  -H 'content-type: application/json' \
  -H 'accept: application/json' \
  --data '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"diag","version":"0"}}}'

# Strict streamable probe
curl -si -X POST http://127.0.0.1:7422/mcp \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  --data '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"diag","version":"0"}}}'
```

Token-protected probe:

```bash
curl -si -X POST http://127.0.0.1:7422/mcp \
  -H 'content-type: application/json' \
  -H 'accept: application/json' \
  -H 'authorization: Bearer replace-me' \
  --data '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"diag","version":"0"}}}'
```

## Build and Test

```bash
npm run typecheck
npm run build
npm test
```

## Environment Variables

See `.env.example` for complete list. Important ones:

- `HS4_BASE_URL` default: `http://127.0.0.1`
- `HS4_USER`, `HS4_PASS`
- `HS4_SAFE_MODE` one of `read_write`, `read_only`
- `HS4_REQUIRE_CONFIRM` default: `true`
- `HS4_MAX_DEVICES_DEFAULT_CAP` default: `250` (global default cap for device-heavy reads)
- `HS4_STATUS_CACHE_TTL_MS` default: `1500` (`0` disables status cache)
- `HS4_SCRIPT_PAGE_PATH` default: `/runscript.html`
- `HS4_EVENTS_DATA_PATH` default: `/usr/local/HomeSeer/Data/HomeSeerData_2.json/events.json`
- `HS4_EVENT_GROUPS_DATA_PATH` default: `/usr/local/HomeSeer/Data/HomeSeerData_2.json/eventgroups.json`
- `HS4_ALIAS_LEARNED_ENABLED` default: `true` (enable learned aliases for resolver tools)
- `HS4_ALIAS_CONFIG_PATH` optional path to alias JSON (`device:<ref>`, `event:<id>`, `camera:<id>` keys)
- `HS4_CHANGE_TOKEN_TTL_SEC` default: `900`
- `HS4_CHANGE_TOKEN_MAX_ENTRIES` default: `2000`
- `HS4_CHANGE_TOKEN_PERSIST_PATH` optional JSONL persistence path for prepared tokens
- `HS4_ALLOWED_DEVICE_REFS`, `HS4_ALLOWED_EVENT_IDS`, `HS4_ALLOWED_CAMERA_IDS`
- `HS4_ALLOWED_SCRIPTS` (lower-case ids)
- `HS4_ALLOWED_PLUGIN_FUNCTIONS` in `plugin:function` format (lower-case)
- `HS4_ADMIN_ENABLED` default: `false`
- `HS4_ADMIN_USERS_ENABLED` default: `false`
- `HS4_ADMIN_PLUGINS_ENABLED` default: `false`
- `HS4_ADMIN_INTERFACES_ENABLED` default: `false`
- `HS4_ADMIN_SYSTEM_ENABLED` default: `false`
- `HS4_ADMIN_CAMERAS_ENABLED` default: `false`
- `HS4_ADMIN_EVENTS_ENABLED` default: `false`
- `HS4_ADMIN_CONFIG_ENABLED` default: `false`
- `HS4_ADMIN_MAINTENANCE_WINDOW_ID` optional strict window id
- `HS4_ADMIN_ALLOWED_MAINTENANCE_WINDOW_IDS` optional allowlist
- `HS4_ADMIN_REQUIRE_CHANGE_TICKET` default: `true`
- `HS4_ADMIN_ROLLBACK_ENABLED` default: `true`
- `HS4_ADMIN_EXECUTION_MODE` one of `adapter`, `direct`, `auto` (default: `adapter`)
- `HS4_ADMIN_DIRECT_FALLBACK` default: `true` (recommended in production to preserve guarded fallback to adapter when direct is unsupported)
- `HS4_ADMIN_CAPABILITY_CACHE_TTL_SEC` default: `300` (admin routing capability cache TTL in seconds; keep non-zero in production)
- `HS4_ADMIN_ALLOWED_USER_IDS`, `HS4_ADMIN_ALLOWED_PLUGIN_IDS`, `HS4_ADMIN_ALLOWED_INTERFACE_IDS`, `HS4_ADMIN_ALLOWED_CATEGORY_IDS`
- `MCP_TRANSPORT` one of `stdio`, `http`
- `MCP_HTTP_ALLOW_NON_LOOPBACK` default: `false` (must be `true` to intentionally bind non-loopback HTTP hosts)
- `MCP_HTTP_ACCEPT_MODE` one of `compat`, `strict` (default: `compat`)
- `MCP_HTTP_ALLOW_JSON_ONLY` default: `true` (json-only `Accept` fallback in compat mode)
- `MCP_HTTP_AUTH_TOKEN` optional bearer token for HTTP auth (required for non-loopback when `MCP_HTTP_AUTH_REQUIRED_NON_LOOPBACK=true`)
- `MCP_HTTP_AUTH_REQUIRED_NON_LOOPBACK` default: `true` (startup fails on non-loopback HTTP bind without token)
- `MCP_HTTP_AUTH_PROTECT_HEALTHZ` default: `true` (health endpoint also requires bearer token when auth is enabled)
- `MCP_AUDIT_PERSIST_PATH` (optional JSONL audit sink)

## HS4 Script Execution Note

`hs4.scripts.run` uses `POST /runscript.html` with:

- `action=run_script_command`
- `scriptcommand=<command>`

This behavior is based on HS4 UI implementation patterns in `/usr/local/HomeSeer/html/runscript.html` (path may vary by installation). It is powerful; use strict allowlists in production.

## Documentation

- Research: `docs/01_research/`
- Architecture: `docs/02_architecture/`
- Operations and hardening: `docs/04_operations/`
- Admin enhancements backlog: `docs/05_roadmap/admin_full_parity.txt`

## Project Policies

- Contribution guide: `CONTRIBUTING.md`
- Security policy: `SECURITY.md`
