# Contributing to MCP_HS4

Thanks for helping improve `mcp-hs4`.

## Ground Rules

- Keep the public tool contract stable unless a change is explicitly versioned.
- Preserve safety guard behavior for mutating operations.
- Keep this repository focused on standalone HomeSeer MCP server behavior.

## Local Development

```bash
npm install
npm run typecheck
npm run build
npm test
```

## Pull Request Expectations

- Include a concise summary of behavior changes.
- Include tests for any logic changes.
- Update docs when API, env vars, or operational behavior changes.
- Avoid committing secrets, credentials, or credentialed URLs.

## Scope Boundary

- Keep client/app-specific adapters and branding out of this repository.
- Integration examples should remain generic unless explicitly required by maintainers.
