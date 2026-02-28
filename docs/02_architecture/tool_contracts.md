# Tool Contracts

This document defines MCP contracts at a practical level.

## Versioning

- Contract: `1.x`
- Compatibility model: single namespace with explicit admin guard semantics

## Guard Contract

### Base Guard (All Mutating Tools)

Mutating tool inputs include:

- `confirm: boolean`
- `intent: string`
- `reason: string`
- `dryRun: boolean`

Behavior:

- If policy denies: tool returns `isError=true` with reasons
- If `dryRun=true`: no HS4 mutation occurs; returns planned action
- If allowed: execute and return structured result + raw payload

### Actionable Errors (All Tools)

Every `isError=true` result includes:

- `error.code`
- `error.message`
- `error.retryable`
- `error.fixHint`
- `error.suggestedNextToolCalls[]`
- `error.details` (optional tool-specific context)

### Admin Guard (`hs4.admin.*`)

Admin tool inputs extend base guard with:

- `operationTier: "operator" | "admin"`
- `domain: "users" | "plugins" | "interfaces" | "system" | "cameras" | "events" | "config"`
- `changeTicket: string`
- `maintenanceWindowId: string`
- `riskLevel: "low" | "medium" | "high"`

Admin policy gates:

- `HS4_ADMIN_ENABLED=true` must be set
- Domain-specific admin enable flag must be set for the requested domain:
- `HS4_ADMIN_USERS_ENABLED`
- `HS4_ADMIN_PLUGINS_ENABLED`
- `HS4_ADMIN_INTERFACES_ENABLED`
- `HS4_ADMIN_SYSTEM_ENABLED`
- `HS4_ADMIN_CAMERAS_ENABLED`
- `HS4_ADMIN_EVENTS_ENABLED`
- `HS4_ADMIN_CONFIG_ENABLED`
- `HS4_ADMIN_MAINTENANCE_WINDOW_ID` (optional exact-match gate) and `HS4_ADMIN_ALLOWED_MAINTENANCE_WINDOW_IDS` (optional allowlist) can further constrain admin maintenance windows
- `HS4_ADMIN_REQUIRE_CHANGE_TICKET=true` requires non-empty `changeTicket`

### Admin Execution Routing

Admin mutation execution routing is configured with:

- `HS4_ADMIN_EXECUTION_MODE` (`adapter` | `direct` | `auto`, default `adapter`)
- `HS4_ADMIN_DIRECT_FALLBACK` (default `true`)
- `HS4_ADMIN_CAPABILITY_CACHE_TTL_SEC` (default `300`)

Mode behavior:

- `adapter`: route admin mutations through adapter-backed execution.
- `direct`: route admin mutations directly to HS4 admin execution paths.
- `auto`: try direct execution first, cache unsupported operations, and route unsupported operations to adapter.

Operational guidance:

- Production default should remain `adapter` with `HS4_ADMIN_DIRECT_FALLBACK=true`.
- Use `direct` only when adapter execution is intentionally bypassed and change-control evidence records that exception.
- Keep capability cache TTL non-zero in production unless you are actively troubleshooting capability drift.

Operational checks:

- Read `hs4://admin/policy/state` before admin mutations and confirm routing values match deployment intent.
- Run at least one admin dry-run in the selected mode during release validation.

Policy-state contract:

- `hs4://admin/policy/state` includes the active admin execution mode and related routing policy state so operators can validate runtime selection before privileged changes.

## Tool Specifications

### `hs4.health.get`

- Input: none
- Output: version, base URL, safe mode, admin gate status, timestamp

### `hs4.help.route`

- Input: natural-language `goal`, optional `mode`
- Output: ranked route suggestions with step-by-step tool templates

### `hs4.resolve.devices` / `hs4.resolve.events` / `hs4.resolve.cameras`

- Input: natural-language `query`, optional `limit`, optional hints
- Output: scored candidates with confidence and alias-match evidence
- Device resolver specifics:
- `hs4.resolve.devices` includes `recommendedRef` and per-item `recommended`.
- Device candidates include `actionability` metadata (`role`, `relationship`, `parentRef`, `controlPairCount`, `rank`) to help clients avoid wrapper/master targets.
- Resolver ranking prefers actionable endpoints for ambiguous device matches unless query tokens explicitly request wrapper context (`master`, `scene`, `parent`, `root`).

### `hs4.change.prepare` (staging)

- Input: `toolName`, `args`, optional `summary`
- Behavior: policy-evaluated dry-run staging; returns TTL-bound token
- Output: prepared token + policy normalization + target summary

### `hs4.change.commit` (mutating)

- Input: prepared `token`
- Behavior: re-evaluates policy and executes mutation if still allowed
- Output: commit result + audit linkage (`preparedAuditRef`, `commitAuditRef`)

### `hs4.intent.device_set_by_name` / `hs4.intent.event_run_by_name` / `hs4.intent.scene_activate`

- Input: objective/query + optional execute/guard fields
- Behavior: resolve target -> prepare mutation (default dry-run) -> optional commit
- Output: prepared envelope; when `execute=true`, includes committed result
- Device intent specifics:
- `hs4.intent.device_set_by_name` includes `resolution` metadata (selected ref/name/role and candidate refs).
- Device intents can include `warnings[]`; `PARENT_OR_WRAPPER_TARGET` flags wrapper/master resolution when a stronger endpoint alternative exists.
- `hs4.intent.scene_activate` applies the same warning model on device fallback resolution.
- `hs4.intent.scene_activate` path selection controls:
- `preferPath=auto` (default) balances event vs device-fallback confidence.
- `preferPath=event` enforces event resolution and returns `NOT_FOUND` when no event matches.
- `preferPath=device_fallback` enforces fallback-device resolution and returns `NOT_FOUND` when no device matches.
- `eventMinScore` (default `0.85`) gates when `auto` mode is allowed to pick event path.
- `hs4.intent.scene_activate` response includes `selection` metadata (`preferPath`, `selectedPath`, `reason`, `eventMinScore`, `topEventScore`, `topDeviceScore`).

### `hs4.selftest.run`

- Input: optional resolver refresh flag
- Output: read-only health matrix (`pass|warn|fail`) with per-check details

### `hs4.devices.list`

- Input: location/interface/capability filters, `includeControls` (default `false`), `includeRaw` (default `false`), optional `maxDevices`, pagination (`limit`, `offset`)
- Output: filtered normalized device list + paging/cap metadata (`total`, `returned`, `maxDevices`, `truncated`)

### `hs4.devices.get`

- Input: `refs[]`, `includeControls` (default `false`), `includeRaw` (default `false`), `resolveChildren` (default `true`), optional `maxDevices`
- Output: normalized devices matching requested refs and resolved child refs + explicit lookup metadata (`requestedRefs`, `found`, `missing`, `resolvedRefs`, `totalResolvedDevices`, `returnedDevices`, `truncated`)

### `hs4.devices.controls.get`

- Input: optional `refs[]`
- Output: raw control metadata payload

### `hs4.devices.status.get`

- Input: refs/locations/compress/everything flags, `includeRaw` (default `false`), optional `maxDevices`, `fresh` (default `false`)
- Output: normalized snapshot + request envelope and cap metadata (`totalDevices`, `returnedDevices`, `truncated`, `maxDevices`)

### `hs4.devices.set` (mutating)

- Input: `ref`, mode + value/status args + optional `verify` (default `true`) + base guard contract
- Defaults: `mode=control_value`, `verify=true`
- Modes:
- `control_value` -> `controldevicebyvalue` (fallback `setdevicevaluebyref`)
- `set_status` -> `setdevicestatus`
- Reliability behavior:
- With `verify=true`, server performs fresh post-write readback until converged or retries exhausted.
- `set_status` writes may be auto-routed to `control_value` when target control pairs clearly map the requested value.
- If `set_status` does not converge, server attempts one `control_value` recovery path when a matching control pair is available.
- If convergence still fails, tool returns `HS4_ERROR` with verification details instead of claiming success.
- Success payload includes `requestedMode`, `mode`, and `verification`; may include `modeAutoSwitch` and `fallback`.
- `dryRun=true` returns policy/safety validation output and does not perform convergence verification.

### `hs4.events.list`

- Input: optional name/group filters
- Output: normalized event list

### `hs4.events.get`

- Input: `id` or exact `group+name`, optional `includeRaw` (default `true`)
- Output: one matched event with extracted `details` (trigger/actions/conditions/definition when present in HS4 payload)

### `hs4.events.definition.get`

- Input: `id` or exact `group+name`, optional `resolveDeviceRefs` (default `true`), optional `includeRaw` (default `false`)
- Output: persisted-event definition parsed from `events.json`/`eventgroups.json`, including normalized triggers, conditional actions, condition counts, referenced device refs, and optional resolved device metadata

### `hs4.events.run` (mutating)

- Input: `id` or `group+name` + base guard contract
- Output: invocation result + raw payload

### `hs4.plugins.list`

- Input: none
- Output: normalized plugin list

### `hs4.cameras.list`

- Input: none
- Output: normalized camera list

### `hs4.cameras.snapshot.get`

- Input: `camId`
- Output: raw snapshot payload

### `hs4.cameras.pan` (mutating)

- Input: `camId`, pan direction + base guard contract
- Output: invocation result + raw payload

### `hs4.audit.query`

- Input: filters + limit
- Output: audit entry list

### `hs4.scripts.run` (mutating)

- Input: `command` + base guard contract
- Output: invocation result + parsed runscript response array/commands

### `hs4.plugins.function.call` (mutating)

- Input: `plugin`, `functionName`, optional instance + params + base guard contract
- Output: invocation result + raw payload

### `hs4.admin.*` Admin Tool Catalog

Users:

- `hs4.admin.users.list`
- `hs4.admin.users.create`
- `hs4.admin.users.update`
- `hs4.admin.users.delete`
- `hs4.admin.users.set_role`

Plugins:

- `hs4.admin.plugins.catalog.get`
- `hs4.admin.plugins.install`
- `hs4.admin.plugins.update`
- `hs4.admin.plugins.remove`
- `hs4.admin.plugins.set_enabled`
- `hs4.admin.plugins.restart`

Interfaces:

- `hs4.admin.interfaces.list`
- `hs4.admin.interfaces.add`
- `hs4.admin.interfaces.update`
- `hs4.admin.interfaces.remove`
- `hs4.admin.interfaces.restart`
- `hs4.admin.interfaces.diagnostics`

System:

- `hs4.admin.system.backup.start`
- `hs4.admin.system.restore.start`
- `hs4.admin.system.service.restart`
- `hs4.admin.system.shutdown`
- `hs4.admin.system.config.get`
- `hs4.admin.system.config.set`

Cameras:

- `hs4.admin.cameras.config.list`
- `hs4.admin.cameras.config.create`
- `hs4.admin.cameras.config.update`
- `hs4.admin.cameras.config.delete`
- `hs4.admin.cameras.stream_profile.set`
- `hs4.admin.cameras.recording.set`

Events:

- `hs4.admin.events.create`
- `hs4.admin.events.update`
- `hs4.admin.events.delete`

Config:

- `hs4.admin.config.device_metadata.set`
- `hs4.admin.config.categories.list`
- `hs4.admin.config.category.upsert`
- `hs4.admin.config.category.delete`

## Admin Result Envelope

Admin mutation tools return the envelope directly in `structuredContent.result`.

Required fields:

- `result: "planned" | "applied" | "failed"`
- `precheck: Array<...>`
- `steps: Array<...>`
- `rollback: "not_needed" | "available"`
- `auditRef: string`
- `operationTier: "operator" | "admin"`
- `domain: string | null`
- `maintenanceWindowId: string | null`
- `changeTicket: string | null`
- `riskLevel: "low" | "medium" | "high"`

Optional fields:

- `before: object`
- `after: object`
- `diff: object`
- `data: object`

## Resources

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
- `hs4://admin/policy/state`
- `hs4://admin/audit/diff`

Resource behavior:

- `hs4://devices/catalog` and `hs4://devices/status` are thin variants (raw device fields excluded).
- `hs4://devices/catalog/full` and `hs4://devices/status/full` are full variants (raw device fields included).
- `hs4://state/summary` is optimized for low-token context loading.
- `hs4://catalog/aliases` exposes config + learned alias records used by resolvers.
- `hs4://agent/contract` captures LLM workflow rules and mutation safety defaults.
- Admin resources expose user/interface/plugin/camera config state, computed admin policy state, and recent admin audit diffs.

## Prompts

- `hs4_safe_control`
- `hs4_scene_operator`
- `hs4_diagnostics`
- `hs4_agent_contract`
- `hs4_admin_change_control`
- `hs4_admin_backup_restore`
- `hs4_admin_plugin_lifecycle`
