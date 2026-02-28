export type McpHttpAcceptMode = 'strict' | 'compat';

export interface McpHttpAcceptConfig {
  mode: McpHttpAcceptMode;
  allowJsonOnly: boolean;
}

export interface McpAcceptNegotiationResult {
  mode: McpHttpAcceptMode;
  allowJsonOnly: boolean;
  originalAccept: string;
  effectiveAccept: string;
  fallbackApplied: boolean;
  forceJsonResponse: boolean;
  acceptsExplicitJson: boolean;
  acceptsExplicitEventStream: boolean;
  allowed: boolean;
  rejectionMessage?: string;
}

function normalizeAccept(raw: string | string[] | undefined): string {
  if (Array.isArray(raw)) {
    return raw.join(',').trim();
  }
  return (raw ?? '').trim();
}

function parseMediaTypes(acceptHeader: string): Set<string> {
  const mediaTypes = new Set<string>();
  if (!acceptHeader) {
    return mediaTypes;
  }

  for (const entry of acceptHeader.split(',')) {
    const mediaType = entry.split(';', 1)[0]?.trim().toLowerCase();
    if (mediaType) {
      mediaTypes.add(mediaType);
    }
  }

  return mediaTypes;
}

function hasJsonLikeSupport(mediaTypes: Set<string>): boolean {
  return mediaTypes.has('application/json') || mediaTypes.has('application/*') || mediaTypes.has('*/*');
}

function hasEventStreamLikeSupport(mediaTypes: Set<string>): boolean {
  return mediaTypes.has('text/event-stream') || mediaTypes.has('text/*') || mediaTypes.has('*/*');
}

export function negotiateMcpPostAccept(rawAccept: string | string[] | undefined, config: McpHttpAcceptConfig): McpAcceptNegotiationResult {
  const originalAccept = normalizeAccept(rawAccept);
  const mediaTypes = parseMediaTypes(originalAccept);
  const acceptsExplicitJson = mediaTypes.has('application/json');
  const acceptsExplicitEventStream = mediaTypes.has('text/event-stream');
  const acceptsJsonLike = hasJsonLikeSupport(mediaTypes);
  const acceptsEventStreamLike = hasEventStreamLikeSupport(mediaTypes);

  if (config.mode === 'strict') {
    const allowed = acceptsExplicitJson && acceptsExplicitEventStream;
    return {
      mode: config.mode,
      allowJsonOnly: config.allowJsonOnly,
      originalAccept,
      effectiveAccept: originalAccept,
      fallbackApplied: false,
      forceJsonResponse: false,
      acceptsExplicitJson,
      acceptsExplicitEventStream,
      allowed,
      rejectionMessage: allowed
        ? undefined
        : 'Not Acceptable: Client must accept both application/json and text/event-stream'
    };
  }

  const supportsJsonOnlyFlow =
    config.allowJsonOnly && acceptsJsonLike && (!acceptsEventStreamLike || !acceptsExplicitEventStream);
  const canPatchWildcardOrMissing = acceptsJsonLike || acceptsEventStreamLike || !originalAccept;
  const canPatch = supportsJsonOnlyFlow || canPatchWildcardOrMissing;

  if (!canPatch) {
    return {
      mode: config.mode,
      allowJsonOnly: config.allowJsonOnly,
      originalAccept,
      effectiveAccept: originalAccept,
      fallbackApplied: false,
      forceJsonResponse: false,
      acceptsExplicitJson,
      acceptsExplicitEventStream,
      allowed: false,
      rejectionMessage: 'Not Acceptable: Client must accept application/json in compatibility mode'
    };
  }

  const effectiveMediaTypes = new Set(mediaTypes);
  effectiveMediaTypes.add('application/json');
  effectiveMediaTypes.add('text/event-stream');
  const effectiveAccept = Array.from(effectiveMediaTypes).join(', ');
  const fallbackApplied = effectiveAccept !== originalAccept;
  const forceJsonResponse = fallbackApplied || supportsJsonOnlyFlow || !acceptsExplicitEventStream;

  return {
    mode: config.mode,
    allowJsonOnly: config.allowJsonOnly,
    originalAccept,
    effectiveAccept,
    fallbackApplied,
    forceJsonResponse,
    acceptsExplicitJson,
    acceptsExplicitEventStream,
    allowed: true
  };
}
