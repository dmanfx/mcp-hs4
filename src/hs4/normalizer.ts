export interface NormalizedControlPair {
  label: string;
  value: number;
}

export interface NormalizedDevice {
  ref: number;
  name: string;
  location: string;
  location2: string;
  status: string;
  value: number | null;
  lastChange: string;
  interfaceName: string;
  controlPairs: NormalizedControlPair[];
  capabilities: string[];
  parentRef?: number;
  relationship?: string;
  associatedRefs?: number[];
  statusImage?: string;
  raw: unknown;
}

export interface NormalizedStatusSnapshot {
  name: string;
  version: string;
  tempFormatF: boolean | null;
  devices: NormalizedDevice[];
}

export interface NormalizedEvent {
  id: number;
  group: string;
  name: string;
  voiceCommand: string;
  voiceEnabled: boolean;
  raw: unknown;
}

export interface NormalizedPlugin {
  id: string;
  name: string;
  version: string;
  updateAvailable: boolean | null;
  raw: unknown;
}

export interface NormalizedCamera {
  camId: number;
  name: string;
  supportsPanTilt: boolean | null;
  raw: unknown;
}

function getPath(input: unknown, path: string): unknown {
  const parts = path.split('.');
  let current: unknown = input;
  for (const part of parts) {
    if (!current || typeof current !== 'object') {
      return undefined;
    }
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function firstArray(input: unknown, paths: string[]): unknown[] {
  for (const path of paths) {
    const candidate = getPath(input, path);
    if (Array.isArray(candidate)) {
      return candidate;
    }
  }
  return [];
}

function allArrays(input: unknown, paths: string[]): unknown[][] {
  const result: unknown[][] = [];
  for (const path of paths) {
    const candidate = getPath(input, path);
    if (Array.isArray(candidate)) {
      result.push(candidate);
    }
  }
  return result;
}

function toNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function toOptionalNumber(value: unknown): number | undefined {
  const parsed = toNumber(value);
  return parsed === null ? undefined : parsed;
}

function toStringValue(value: unknown): string {
  if (value === undefined || value === null) {
    return '';
  }
  return String(value);
}

function toOptionalString(value: unknown): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  return String(value);
}

function normalizeControlPairs(raw: unknown): NormalizedControlPair[] {
  const candidates = Array.isArray(raw)
    ? raw
    : firstArray(raw, ['control_pairs', 'ControlPairs', 'ControlPairs.ControlPair', 'Controls', 'controls']);

  const result: NormalizedControlPair[] = [];

  for (const pair of candidates) {
    if (!pair || typeof pair !== 'object') {
      continue;
    }

    const record = pair as Record<string, unknown>;
    const value = toNumber(record.ControlValue ?? record.value ?? record.Value);
    if (value === null) {
      continue;
    }

    const label = toStringValue(record.Label ?? record.label ?? record.Status ?? record.status ?? record.Name);
    result.push({ label, value });
  }

  return result;
}

const CHILD_DEVICE_ARRAY_PATHS = [
  'Children',
  'children',
  'ChildDevices',
  'child_devices',
  'AssociatedDevices',
  'associated_devices'
];

interface FlattenedDeviceRecord {
  raw: unknown;
  record: Record<string, unknown>;
  inferredParentRef: number | undefined;
}

function flattenDeviceRecords(devicesRaw: unknown[]): FlattenedDeviceRecord[] {
  const flattened: FlattenedDeviceRecord[] = [];
  const visited = new WeakSet<object>();
  const queue: Array<{ raw: unknown; inferredParentRef: number | undefined }> = devicesRaw.map((raw) => ({
    raw,
    inferredParentRef: undefined
  }));

  while (queue.length > 0) {
    const next = queue.shift();
    if (!next) {
      continue;
    }

    const { raw, inferredParentRef } = next;
    if (!raw || typeof raw !== 'object') {
      continue;
    }
    if (visited.has(raw)) {
      continue;
    }
    visited.add(raw);

    const record = raw as Record<string, unknown>;
    flattened.push({ raw, record, inferredParentRef });

    const ownRef = toOptionalNumber(record.ref ?? record.Ref ?? record.id ?? record.ID);
    const parentForChildren = ownRef ?? inferredParentRef;
    for (const children of allArrays(record, CHILD_DEVICE_ARRAY_PATHS)) {
      for (const child of children) {
        if (child && typeof child === 'object') {
          queue.push({
            raw: child,
            inferredParentRef: parentForChildren
          });
        }
      }
    }
  }

  return flattened;
}

function normalizeAssociatedRefs(record: Record<string, unknown>): number[] | undefined {
  const refs = new Set<number>();

  for (const candidates of allArrays(record, [
    'associated_refs',
    'associatedRefs',
    'AssociatedRefs',
    'AssociatedDevices',
    'associated_devices'
  ])) {
    for (const candidate of candidates) {
      if (candidate && typeof candidate === 'object') {
        const nested = candidate as Record<string, unknown>;
        const ref = toOptionalNumber(nested.ref ?? nested.Ref ?? nested.id ?? nested.ID);
        if (ref !== undefined) {
          refs.add(ref);
        }
        continue;
      }

      const ref = toOptionalNumber(candidate);
      if (ref !== undefined) {
        refs.add(ref);
      }
    }
  }

  return refs.size > 0 ? Array.from(refs) : undefined;
}

function mergeDevice(target: NormalizedDevice, source: NormalizedDevice): void {
  const pairKeys = new Set(target.controlPairs.map((pair) => `${pair.value}:${pair.label}`));
  for (const pair of source.controlPairs) {
    const key = `${pair.value}:${pair.label}`;
    if (!pairKeys.has(key)) {
      pairKeys.add(key);
      target.controlPairs.push(pair);
    }
  }

  const capabilities = new Set([...target.capabilities, ...source.capabilities]);
  target.capabilities = Array.from(capabilities);

  if (target.parentRef === undefined && source.parentRef !== undefined) {
    target.parentRef = source.parentRef;
  }
  if (target.relationship === undefined && source.relationship !== undefined) {
    target.relationship = source.relationship;
  }
  if (target.statusImage === undefined && source.statusImage !== undefined) {
    target.statusImage = source.statusImage;
  }
  if (source.associatedRefs?.length) {
    const mergedRefs = new Set([...(target.associatedRefs ?? []), ...source.associatedRefs]);
    target.associatedRefs = Array.from(mergedRefs);
  }
}

function deriveCapabilities(controlPairs: NormalizedControlPair[], status: string, name: string): string[] {
  const source = [
    ...controlPairs.map((pair) => pair.label.toLowerCase()),
    status.toLowerCase(),
    name.toLowerCase()
  ].join(' ');

  const capabilities = new Set<string>();

  if (/\bon\b|\boff\b|switch|light|binary/.test(source)) {
    capabilities.add('on_off');
  }
  if (/dim|bright|level|%/.test(source)) {
    capabilities.add('dimmer');
  }
  if (/lock|unlock|deadbolt/.test(source)) {
    capabilities.add('lock');
  }
  if (/open|close|blind|shade|garage|cover/.test(source)) {
    capabilities.add('cover');
  }
  if (/setpoint|thermostat|heat|cool|temperature/.test(source)) {
    capabilities.add('setpoint');
  }
  if (/fan/.test(source)) {
    capabilities.add('fan');
  }

  return Array.from(capabilities);
}

export function normalizeStatusPayload(payload: unknown): NormalizedStatusSnapshot {
  const devicesRaw = firstArray(payload, ['Devices', 'devices', 'response.Devices', 'Result.Devices']);

  const flattenedRecords = flattenDeviceRecords(devicesRaw);
  const devices: NormalizedDevice[] = [];
  const devicesByRef = new Map<number, NormalizedDevice>();

  for (const { raw, record, inferredParentRef } of flattenedRecords) {
    const ref = toNumber(record.ref ?? record.Ref ?? record.id ?? record.ID);
    if (ref === null) {
      continue;
    }

    const status = toStringValue(record.status ?? record.Status);
    const name = toStringValue(record.name ?? record.Name);
    const controlPairs = normalizeControlPairs(record);
    const normalizedDevice: NormalizedDevice = {
      ref,
      name,
      location: toStringValue(record.location ?? record.Location),
      location2: toStringValue(record.location2 ?? record.Location2),
      status,
      value: toNumber(record.value ?? record.Value),
      lastChange: toStringValue(record.last_change ?? record.Last_Change ?? record.LastChange),
      interfaceName: toStringValue(record.interface_name ?? record.Interface_Name),
      controlPairs,
      capabilities: deriveCapabilities(controlPairs, status, name),
      raw
    };

    const parentRef =
      toOptionalNumber(record.parentRef ?? record.ParentRef ?? record.parent_ref) ?? inferredParentRef;
    if (parentRef !== undefined) {
      normalizedDevice.parentRef = parentRef;
    }

    const relationship = toOptionalString(record.relationship ?? record.Relationship);
    if (relationship !== undefined) {
      normalizedDevice.relationship = relationship;
    }

    const associatedRefs = normalizeAssociatedRefs(record);
    if (associatedRefs) {
      normalizedDevice.associatedRefs = associatedRefs;
    }

    const statusImage = toOptionalString(record.statusImage ?? record.status_image ?? record.StatusImage);
    if (statusImage !== undefined) {
      normalizedDevice.statusImage = statusImage;
    }

    const existing = devicesByRef.get(ref);
    if (!existing) {
      devicesByRef.set(ref, normalizedDevice);
      devices.push(normalizedDevice);
      continue;
    }

    mergeDevice(existing, normalizedDevice);
  }

  const root = (payload ?? {}) as Record<string, unknown>;

  return {
    name: toStringValue(root.Name ?? root.name),
    version: toStringValue(root.Version ?? root.version),
    tempFormatF:
      typeof root.TempFormatF === 'boolean'
        ? root.TempFormatF
        : typeof root.tempFormatF === 'boolean'
          ? (root.tempFormatF as boolean)
          : null,
    devices
  };
}

export function normalizeEventsPayload(payload: unknown): NormalizedEvent[] {
  const eventsRaw = firstArray(payload, ['Events', 'events', 'response.Events']);
  const events: NormalizedEvent[] = [];

  for (const raw of eventsRaw) {
    if (!raw || typeof raw !== 'object') {
      continue;
    }
    const record = raw as Record<string, unknown>;
    const id = toNumber(record.id ?? record.ID);
    if (id === null) {
      continue;
    }

    events.push({
      id,
      group: toStringValue(record.Group ?? record.group),
      name: toStringValue(record.Name ?? record.name),
      voiceCommand: toStringValue(record.voice_command ?? record.Voice_Command),
      voiceEnabled: Boolean(record.voice_command_enabled ?? record.Voice_Command_Enabled),
      raw
    });
  }

  return events;
}

export function normalizePluginListPayload(payload: unknown): NormalizedPlugin[] {
  const pluginsRaw = firstArray(payload, ['Plugins', 'plugins', 'response.Plugins']);
  const plugins: NormalizedPlugin[] = [];

  for (const raw of pluginsRaw) {
    if (!raw || typeof raw !== 'object') {
      continue;
    }

    const record = raw as Record<string, unknown>;
    plugins.push({
      id: toStringValue(record.ID ?? record.id ?? record.pluginid),
      name: toStringValue(record.Name ?? record.name ?? record.plugin),
      version: toStringValue(record.Version ?? record.version),
      updateAvailable:
        typeof record.UpdateAvailable === 'boolean'
          ? record.UpdateAvailable
          : typeof record.update_available === 'boolean'
            ? (record.update_available as boolean)
            : null,
      raw
    });
  }

  return plugins;
}

export function normalizeCamerasPayload(payload: unknown): NormalizedCamera[] {
  const camerasRaw = firstArray(payload, ['Cameras', 'cameras', 'response.Cameras']);
  const cameras: NormalizedCamera[] = [];

  for (const raw of camerasRaw) {
    if (!raw || typeof raw !== 'object') {
      continue;
    }

    const record = raw as Record<string, unknown>;
    const camId = toNumber(record.id ?? record.camid ?? record.CamId ?? record.CamID);
    if (camId === null) {
      continue;
    }

    cameras.push({
      camId,
      name: toStringValue(record.name ?? record.Name),
      supportsPanTilt:
        typeof record.supports_pantilt === 'boolean'
          ? record.supports_pantilt
          : typeof record.SupportsPanTilt === 'boolean'
            ? record.SupportsPanTilt
            : null,
      raw
    });
  }

  return cameras;
}
