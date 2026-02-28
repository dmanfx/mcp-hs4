import { describe, expect, test } from 'vitest';

import { normalizeEventsPayload, normalizeStatusPayload } from '../../src/hs4/normalizer.js';

describe('normalizeStatusPayload', () => {
  test('normalizes device refs and capabilities', () => {
    const payload = {
      Name: 'HomeSeer Devices',
      Version: '1.0',
      TempFormatF: true,
      Devices: [
        {
          ref: 10,
          name: 'Kitchen Light',
          location: 'Kitchen',
          location2: 'Main',
          value: 0,
          status: 'Off',
          control_pairs: [
            { Label: 'Off', ControlValue: 0 },
            { Label: 'On', ControlValue: 100 }
          ]
        }
      ]
    };

    const normalized = normalizeStatusPayload(payload);

    expect(normalized.devices).toHaveLength(1);
    expect(normalized.devices[0]?.ref).toBe(10);
    expect(normalized.devices[0]?.capabilities).toContain('on_off');
  });

  test('captures HS4 ControlPairs when present', () => {
    const payload = {
      Devices: [
        {
          Ref: 11,
          Name: 'Porch Light',
          Status: 'Off',
          ControlPairs: [
            { Status: 'Off', ControlValue: 0 },
            { Status: 'On', ControlValue: 100 }
          ]
        }
      ]
    };

    const normalized = normalizeStatusPayload(payload);

    expect(normalized.devices).toHaveLength(1);
    expect(normalized.devices[0]?.controlPairs).toEqual([
      { label: 'Off', value: 0 },
      { label: 'On', value: 100 }
    ]);
    expect(normalized.devices[0]?.capabilities).toContain('on_off');
  });

  test('flattens child devices and includes relationship metadata', () => {
    const payload = {
      Devices: [
        {
          Ref: 1,
          Name: 'Parent Device',
          Status: 'Ready',
          AssociatedDevices: [
            99,
            {
              Ref: 2,
              Name: 'Child Switch',
              Status: 'Off',
              Relationship: 'child',
              StatusImage: '/images/child-switch.png'
            }
          ],
          Children: [
            {
              Ref: 3,
              Name: 'Child Sensor',
              Status: 'Open',
              relationship: 'zone',
              status_image: '/images/child-sensor.png'
            }
          ]
        }
      ]
    };

    const normalized = normalizeStatusPayload(payload);
    const parent = normalized.devices.find((device) => device.ref === 1);
    const childSwitch = normalized.devices.find((device) => device.ref === 2);
    const childSensor = normalized.devices.find((device) => device.ref === 3);

    expect(normalized.devices).toHaveLength(3);
    expect(parent?.associatedRefs).toEqual(expect.arrayContaining([99, 2]));
    expect(parent?.associatedRefs).toHaveLength(2);
    expect(childSwitch?.parentRef).toBe(1);
    expect(childSwitch?.relationship).toBe('child');
    expect(childSwitch?.statusImage).toBe('/images/child-switch.png');
    expect(childSensor?.parentRef).toBe(1);
    expect(childSensor?.relationship).toBe('zone');
    expect(childSensor?.statusImage).toBe('/images/child-sensor.png');
  });
});

describe('normalizeEventsPayload', () => {
  test('normalizes events list', () => {
    const payload = {
      Events: [
        {
          Group: 'Lights',
          Name: 'Night On',
          id: 123,
          voice_command: 'night mode',
          voice_command_enabled: true
        }
      ]
    };

    const events = normalizeEventsPayload(payload);

    expect(events).toHaveLength(1);
    expect(events[0]?.id).toBe(123);
    expect(events[0]?.group).toBe('Lights');
  });
});
