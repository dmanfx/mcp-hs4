# Operations Runbook

## Deployment Modes

### Stdio mode (recommended for local MCP clients)

```bash
npm run dev
```

### HTTP mode (optional)

```bash
MCP_TRANSPORT=http MCP_HTTP_HOST=127.0.0.1 MCP_HTTP_PORT=7422 npm run dev
```

For non-loopback binding, enforce token auth:

```bash
MCP_TRANSPORT=http MCP_HTTP_HOST=0.0.0.0 MCP_HTTP_ALLOW_NON_LOOPBACK=true MCP_HTTP_AUTH_TOKEN=replace-me npm run dev
```

Health check:

```bash
curl http://127.0.0.1:7422/healthz
```

If token auth is enabled and `MCP_HTTP_AUTH_PROTECT_HEALTHZ=true`:

```bash
curl -H "Authorization: Bearer replace-me" http://127.0.0.1:7422/healthz
```

## Environment Setup

1. Create `.env` from `.env.example`
2. Set `HS4_BASE_URL` and credentials if required
3. Set safety vars (`HS4_SAFE_MODE`, allowlists)
4. Set Admin flags (`HS4_ADMIN_ENABLED` plus per-domain `HS4_ADMIN_*_ENABLED`)
5. Set change-control guards (`HS4_ADMIN_REQUIRE_CHANGE_TICKET`, `HS4_ADMIN_MAINTENANCE_WINDOW_ID`, `HS4_ADMIN_ALLOWED_MAINTENANCE_WINDOW_IDS`)
6. Set admin execution routing (`HS4_ADMIN_EXECUTION_MODE`, `HS4_ADMIN_DIRECT_FALLBACK`, `HS4_ADMIN_CAPABILITY_CACHE_TTL_SEC`)
7. Production default: `HS4_ADMIN_EXECUTION_MODE=adapter`, `HS4_ADMIN_DIRECT_FALLBACK=true`, `HS4_ADMIN_CAPABILITY_CACHE_TTL_SEC=300`
8. Set scaling/cache defaults (`HS4_MAX_DEVICES_DEFAULT_CAP`, `HS4_STATUS_CACHE_TTL_MS`) for the target host
9. Keep `MCP_HTTP_ALLOW_NON_LOOPBACK=false` unless non-loopback binding is explicitly required
10. If HTTP is used, set `MCP_HTTP_AUTH_TOKEN`; keep `MCP_HTTP_AUTH_REQUIRED_NON_LOOPBACK=true`
11. Decide whether health endpoint requires auth (`MCP_HTTP_AUTH_PROTECT_HEALTHZ`, default `true`)
12. Configure alias behavior (`HS4_ALIAS_LEARNED_ENABLED`, optional `HS4_ALIAS_CONFIG_PATH`)
13. Configure prepared-change token behavior (`HS4_CHANGE_TOKEN_TTL_SEC`, `HS4_CHANGE_TOKEN_MAX_ENTRIES`, optional `HS4_CHANGE_TOKEN_PERSIST_PATH`)
14. Optionally set `MCP_AUDIT_PERSIST_PATH`

## Admin Execution Mode Selection

- `adapter` (default): preferred production mode for standard admin operations.
- `auto`: use when rolling out adapter coverage and you need controlled direct fallback.
- `direct`: use only for break-glass windows or validated adapter incompatibilities.
- Keep `HS4_ADMIN_DIRECT_FALLBACK=true` in production unless policy requires hard-fail behavior when direct routing is unsupported.
- Verify selected mode before privileged changes by reading `hs4://admin/policy/state`.

## Maintenance Window and Change Ticket Preconditions

Before any `hs4.admin.*` mutation:

1. Confirm maintenance window is active and still open
2. Confirm approved change ticket id exists and is in implementation state
3. Set request payload fields:
- `changeTicket`
- `maintenanceWindowId`
- `operationTier=admin`
4. Confirm rollback owner and rollback command path are documented

If any precondition fails, run admin calls in dry-run only and escalate through change control.

## Smoke Test Sequence

1. `hs4.health.get`
2. `hs4.selftest.run` (expect `pass` or known `warn` conditions only)
3. `hs4.help.route` with representative objective (verify route template quality)
4. `hs4.resolve.devices/events/cameras` (verify deterministic scored matches)
5. Confirm `hs4.resolve.devices` returns `recommendedRef` aligned to actionable endpoints (not wrapper/master refs) for ambiguous names
6. `hs4.intent.scene_activate` dry-run with `preferPath=device_fallback` on an objective that also matches an event; verify `selection.selectedPath=device_fallback`
7. `hs4.intent.scene_activate` dry-run with `preferPath=event` on an objective without a matching event; verify `NOT_FOUND` and `details.preferPath=event`
8. `hs4.devices.list` (small filtered query)
9. `hs4.devices.get` with a known parent ref and `resolveChildren=true`; verify child refs appear in `resolvedRefs`
10. `hs4.devices.get` with one invalid ref; verify `missing` reports it cleanly
11. `hs4.devices.status.get` with `maxDevices` set and `fresh=true`; verify bounded response and cache-bypass path
12. `hs4.events.list`
13. `hs4.events.get` on a known event id (verify definition details if present)
14. `hs4.events.definition.get` on a known event id (verify trigger/action refs and resolved devices)
15. `hs4.plugins.list`
16. Read `hs4://state/summary`, `hs4://catalog/aliases`, and `hs4://agent/contract`
17. Read `hs4://admin/policy/state`; verify execution routing values match intended deployment mode
18. Mutation dry-run (`hs4.devices.set` with `dryRun=true`)
19. Controlled real mutation on test target using `hs4.devices.set` with `mode=control_value` and `verify=true`
20. Optional reliability check: invoke `mode=set_status` on same target and verify response includes auto-switch/fallback evidence when applicable
21. Two-phase mutation check (`hs4.change.prepare` then `hs4.change.commit`) on a reversible test target
22. Admin negative test with `HS4_ADMIN_ENABLED=false`; verify `hs4.admin.*` calls are denied
23. Admin domain-gate test with an unset domain flag (for example `HS4_ADMIN_SYSTEM_ENABLED=false`); verify deny
24. Admin positive dry-run with `operationTier=admin`, `domain`, `changeTicket`, and `maintenanceWindowId`
25. Admin routing check: verify one admin dry-run aligns with selected execution mode policy state
26. In HTTP mode, verify auth denies missing token (`401`) and wrong token (`403`) on `POST /mcp`
27. In HTTP mode, verify `/healthz` auth behavior matches `MCP_HTTP_AUTH_PROTECT_HEALTHZ`
28. Review startup/request logs and confirm no credential leakage (`HS4_USER`, `HS4_PASS`, auth header values)

## Staging-Only Admin Suite

Run the admin integration suite only in staging. Minimum suite coverage:

1. `hs4.admin.system.config.get` read path
2. `hs4.admin.system.config.set` dry-run and live mutation path
3. Ticket/window field omission must return guard-deny result
4. `hs4.audit.query` must show gate decision and payload metadata

## Rollback Rehearsal

Before production release, run one rehearsal in staging:

1. Execute one reversible admin mutation
2. Trigger rollback sequence inside the same maintenance window
3. Verify state return through `hs4.devices.status.get`
4. Attach rehearsal evidence to the release ticket

## Incident Triage

### Symptom: all tool calls failing

- Check HS4 service status (`homeseer.service`)
- Verify `HS4_BASE_URL`
- Validate auth credentials
- Inspect MCP logs for `AUTH`, `NETWORK`, `TIMEOUT`

### Symptom: writes blocked unexpectedly

- Check `HS4_SAFE_MODE`
- Verify `confirm`, `intent`, `reason` in request
- Check allowlists (`HS4_ALLOWED_*`)
- Query `hs4.audit.query` for deny reason

### Symptom: write reported success but physical state did not change

- Re-run `hs4.devices.status.get` with `fresh=true` on target refs to rule out stale reads
- Inspect `hs4.devices.set` response fields: `requestedMode`, `mode`, `verification`, `modeAutoSwitch`, `fallback`
- Prefer `mode=control_value` with `verify=true` for dimmers/switches
- Use `hs4.devices.controls.get` to confirm control-pair values for the target device
- If convergence still fails, treat as transport/device issue and triage at HS4/plugin/protocol layer

### Symptom: admin writes blocked unexpectedly

- Check `HS4_ADMIN_ENABLED`
- Check per-domain flag (`HS4_ADMIN_USERS_ENABLED`, `HS4_ADMIN_SYSTEM_ENABLED`, etc.)
- Verify `operationTier=admin` in request
- Verify `changeTicket` and `maintenanceWindowId` request fields
- Verify active maintenance window and ticket approval status
- Verify `HS4_ADMIN_MAINTENANCE_WINDOW_ID` / `HS4_ADMIN_ALLOWED_MAINTENANCE_WINDOW_IDS` constraints

### Symptom: admin call routed through an unexpected execution path

- Check `HS4_ADMIN_EXECUTION_MODE`
- Check `HS4_ADMIN_DIRECT_FALLBACK`
- Check `HS4_ADMIN_CAPABILITY_CACHE_TTL_SEC` (use shorter TTL or `0` during capability troubleshooting)
- Read `hs4://admin/policy/state` and confirm runtime routing policy matches deployment intent

### Symptom: scripts not executing

- Verify `/runscript.html` reachable on HS4 host
- Validate command format
- Check `HS4_ALLOWED_SCRIPTS`

### Symptom: HTTP requests denied with 401/403

- Verify `Authorization: Bearer <token>` is sent
- Verify `MCP_HTTP_AUTH_TOKEN` matches client token
- Check whether `/healthz` auth is enabled via `MCP_HTTP_AUTH_PROTECT_HEALTHZ`

### Symptom: sensitive values appear in logs

- Stop sharing logs externally until redaction is confirmed
- Verify logs do not print `HS4_PASS`, raw `Authorization` headers, or full credentialed URLs
- Rotate credentials if leaked, then restart and re-run smoke tests

## Rollback

- Stop current process
- Revert to previous release tag/artifact
- Reapply prior `.env`
- Re-run smoke tests
- Re-run one admin deny check with `HS4_ADMIN_ENABLED=false` or a disabled domain flag
