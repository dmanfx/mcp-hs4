# Security Policy

## Supported Versions

Security fixes are applied to the latest published version.

## Reporting a Vulnerability

If you discover a security issue:

1. Do not post exploit details publicly in issues.
2. Provide reproduction details, impacted versions, and mitigation ideas.
3. Coordinate disclosure timing before public release of details.

### Private Reporting Channel Template

Send reports privately to: `dmanfx@hotmail.com`.

Use this message template:

- Subject: `[MCP_HS4 Security] <short issue title>`
- Affected version(s):
- Deployment mode (`stdio` or `http`):
- Impact summary:
- Reproduction steps:
- Proof-of-concept artifacts (logs/redacted payloads):
- Suggested mitigation or patch direction:
- Preferred disclosure/contact timeline:

## Security Priorities

- Credential safety (`HS4_USER`, `HS4_PASS`, auth headers, credentialed URLs)
- Mutation guard integrity (`confirm`, `intent`, `reason`, safe mode, allowlists)
- Admin guard integrity (`operationTier`, change tickets, maintenance windows)
- HTTP exposure controls (`MCP_HTTP_ALLOW_NON_LOOPBACK`, accept negotiation behavior)
