# Hardening Guide

## Threat Model Focus

- Unauthorized mutation of home automation state
- Unauthorized use of privileged admin operations
- Credential leakage
- Overly broad script/plugin execution
- Replay or accidental high-frequency mutation loops

## Required Controls (Production)

1. Least-Privilege HS4 Identity
- Create a dedicated HS4 account for MCP usage.
- Restrict permissions to required device/event domains.

2. Guarded Writes Always On
- Keep `HS4_REQUIRE_CONFIRM=true`.
- Enforce meaningful `intent` and `reason`.
- Keep `hs4.devices.set` verification enabled (`verify=true`, default behavior).
- Prefer `mode=control_value` for device writes unless a known integration requires `set_status`.

3. Scope Constraints
- Use `HS4_ALLOWED_DEVICE_REFS` and `HS4_ALLOWED_EVENT_IDS`.
- Use `HS4_ALLOWED_SCRIPTS` and `HS4_ALLOWED_PLUGIN_FUNCTIONS`.

4. Read-Only Default for New Environments
- Start with `HS4_SAFE_MODE=read_only` until validation is complete.

5. Admin Surface Disabled by Default
- Keep `HS4_ADMIN_ENABLED=false` unless an approved change window is active.
- Keep per-domain admin flags (`HS4_ADMIN_*_ENABLED`) disabled unless explicitly needed.
- Treat `hs4.admin.*` as privileged break-glass operations.

6. Maintenance Window and Change Ticket Gates
- Keep `HS4_ADMIN_REQUIRE_CHANGE_TICKET=true`.
- Set `HS4_ADMIN_MAINTENANCE_WINDOW_ID` and/or `HS4_ADMIN_ALLOWED_MAINTENANCE_WINDOW_IDS` when strict window control is required.
- Require `changeTicket`, `maintenanceWindowId`, and `operationTier=admin` on admin mutations.

7. Domain-Scoped Admin Execution
- Enable only the domain flags needed for the current maintenance scope.
- Disable all unused `HS4_ADMIN_*_ENABLED` flags.

8. Admin Execution Routing Defaults
- Keep `HS4_ADMIN_EXECUTION_MODE=adapter` for production.
- Keep `HS4_ADMIN_DIRECT_FALLBACK=true` to preserve guarded continuity when direct path is unsupported.
- Keep `HS4_ADMIN_CAPABILITY_CACHE_TTL_SEC=300` (or another non-zero value) to avoid excessive capability probing.
- Use `HS4_ADMIN_EXECUTION_MODE=direct` only with explicit change-control approval and rollback coverage.

9. Local Binding
- Prefer loopback host (`127.0.0.1`) for HTTP mode.
- If binding to broader interfaces, use external auth/TLS and host restrictions.

10. Auditing
- Persist audits with `MCP_AUDIT_PERSIST_PATH`.
- Rotate and retain logs according to policy.

## Optional Advanced Controls

- Run MCP process under a dedicated OS user.
- Place HTTP mode behind reverse proxy with mTLS/OAuth.
- Add request-rate limits per tool in wrapper layer.
- Add command-level denylist for risky script calls.
- Enforce dual approval on admin maintenance windows.

## High-Risk Surfaces

- `hs4.scripts.run`
- `hs4.plugins.function.call`

Treat these as privileged operations and keep tightly allowlisted.

## Operational Hardening Checks

- Validate admin-deny behavior with `HS4_ADMIN_ENABLED=false` before every production cut.
- Validate admin-deny behavior with at least one disabled domain flag (`HS4_ADMIN_*_ENABLED=false`).
- Validate `hs4://admin/policy/state` reflects intended execution routing (`HS4_ADMIN_EXECUTION_MODE`, `HS4_ADMIN_DIRECT_FALLBACK`, `HS4_ADMIN_CAPABILITY_CACHE_TTL_SEC`).
- Execute admin integration suite only in staging.
- Complete and document rollback rehearsal for one admin mutation each release cycle.
