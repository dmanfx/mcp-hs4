import { describe, expect, test } from 'vitest';

import { negotiateMcpPostAccept } from '../../src/http/acceptNegotiation.js';

describe('negotiateMcpPostAccept', () => {
  test('strict mode allows explicit application/json + text/event-stream', () => {
    const result = negotiateMcpPostAccept('application/json, text/event-stream', {
      mode: 'strict',
      allowJsonOnly: false
    });

    expect(result.allowed).toBe(true);
    expect(result.fallbackApplied).toBe(false);
    expect(result.forceJsonResponse).toBe(false);
  });

  test('strict mode rejects json-only accept header', () => {
    const result = negotiateMcpPostAccept('application/json', {
      mode: 'strict',
      allowJsonOnly: true
    });

    expect(result.allowed).toBe(false);
    expect(result.rejectionMessage).toContain('both application/json and text/event-stream');
  });

  test('compat mode patches json-only accept header and forces json response', () => {
    const result = negotiateMcpPostAccept('application/json', {
      mode: 'compat',
      allowJsonOnly: true
    });

    expect(result.allowed).toBe(true);
    expect(result.fallbackApplied).toBe(true);
    expect(result.effectiveAccept).toContain('application/json');
    expect(result.effectiveAccept).toContain('text/event-stream');
    expect(result.forceJsonResponse).toBe(true);
  });

  test('compat mode with wildcard accept patches explicit media types', () => {
    const result = negotiateMcpPostAccept('*/*', {
      mode: 'compat',
      allowJsonOnly: true
    });

    expect(result.allowed).toBe(true);
    expect(result.fallbackApplied).toBe(true);
    expect(result.effectiveAccept).toContain('application/json');
    expect(result.effectiveAccept).toContain('text/event-stream');
  });

  test('compat mode leaves explicit dual-accept unchanged', () => {
    const result = negotiateMcpPostAccept('application/json, text/event-stream', {
      mode: 'compat',
      allowJsonOnly: true
    });

    expect(result.allowed).toBe(true);
    expect(result.fallbackApplied).toBe(false);
    expect(result.forceJsonResponse).toBe(false);
  });

  test('compat mode rejects non-json accept header', () => {
    const result = negotiateMcpPostAccept('text/plain', {
      mode: 'compat',
      allowJsonOnly: true
    });

    expect(result.allowed).toBe(false);
    expect(result.rejectionMessage).toContain('application/json');
  });

  test('compat mode accepts missing accept header with fallback', () => {
    const result = negotiateMcpPostAccept(undefined, {
      mode: 'compat',
      allowJsonOnly: true
    });

    expect(result.allowed).toBe(true);
    expect(result.fallbackApplied).toBe(true);
    expect(result.forceJsonResponse).toBe(true);
  });
});
