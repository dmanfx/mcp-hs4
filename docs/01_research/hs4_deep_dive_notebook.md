# HS4 Deep Dive Notebook

Date: February 23, 2026

This notebook captures the distilled implementation-relevant findings from HomeSeer documentation and this server's live HS4 installation.

## Local Environment Facts (Verified)

- HS4 process: running
- Service: `homeseer.service` enabled
- Binary root: `/usr/local/HomeSeer`
- Version endpoint response: `{"Response":"4.2.22.4"}`
- HTTP port: `80` (`/usr/local/HomeSeer/Config/settings.ini`)
- SSL flag: disabled in that config (`gWebSvrSSLEnabled=False`)
- No-password local network mode appears enabled (`gNoPW192=True` in same config)

## API Base

- Endpoint style: `GET /JSON?request=<name>&...`
- Auth style: `user` and `pass` query parameters are documented and accepted by several endpoints.

## Key HS4 JSON Endpoints Used

### Core status/control

- `hsversion`
- `getstatus`
- `getcontrol`
- `getcontrol2`
- `controldevicebyvalue`
- `setdevicestatus`
- `setdeviceproperty`
- `getdeviceschanged`

### Events

- `getevents`
- `runevent`

### Plugins

- `pluginlist`
- `pluginfunction`

### Cameras

- `getcameras`
- `getcamerasnapshot`
- `pancamera`

## Endpoint Semantics (Doc Distillation)

### `getstatus`

Documented request shape includes:

- `ref` (single or comma-separated list)
- `location1`, `location2`
- `compress=[true|false]`
- `everything=[true|false]`
- `voiceonly=[true|false]`
- `excludeevents=true` supported with `everything=true`

High value note:

- `everything=true` returns status + control information and has stricter query support.

### `pluginfunction`

Documented shape includes:

- `plugin`, `function`, optional `instance`
- Positional parameters `P1...Pn`

### `runevent`

Two forms:

- `id=<EVENT_ID>`
- or `group=<GROUP>&name=<EVENT_NAME>`

### `setdevicestatus`

Doc indicates setting one or more of:

- device value
- display string
- source

## Script Execution Discovery (Local HS4 UI)

No explicit JSON `runscript` endpoint is clearly documented in the same set. In observed HS4 installs, script execution is implemented in the UI route:

- Page: `/runscript.html`
- JS action from the page:
- POST with `action=run_script_command`
- `scriptcommand=<command text>`

This behavior was observed directly in `/usr/local/HomeSeer/html/runscript.html` and shared page AJAX helper logic.

## Response Shape Quirks

- Some JSON APIs return object payloads with upper/lower-case variance.
- HS4 often returns stringy status responses (`ok`, or object with `Response`).
- UI AJAX endpoints can return serialized arrays of key/value command pairs, not plain JSON object maps.

## Implementation Consequences

- Normalize response paths defensively (`Devices`, `devices`, nested variants).
- Treat response message strings containing `error|failed|invalid|bad request` as HS4-level failures.
- Prefer `controldevicebyvalue`; fallback to `setdevicevaluebyref` when needed (validated working pattern in integration tests).
- Keep scripts behind strong policy controls because route-level behavior is powerful and not constrained to narrow typed operations.

## Sources

- `https://docs.homeseer.com/hspi/json-api`
- `https://docs.homeseer.com/hspi/getstatus`
- `https://docs.homeseer.com/hspi/getcontrol`
- `https://docs.homeseer.com/hspi/getcontrol2`
- `https://docs.homeseer.com/hspi/controldevicebyvalue`
- `https://docs.homeseer.com/hspi/controldevicebylabel`
- `https://docs.homeseer.com/hspi/controldevicebyindex`
- `https://docs.homeseer.com/hspi/setdevicestatus`
- `https://docs.homeseer.com/hspi/getevents`
- `https://docs.homeseer.com/hspi/runevent`
- `https://docs.homeseer.com/hspi/pluginfunction`
- `https://docs.homeseer.com/hspi/pluginlist`
- `https://docs.homeseer.com/hspi/getcameras`
- `https://docs.homeseer.com/hspi/getcamerasnapshot`
- `https://docs.homeseer.com/hspi/pancamera`
- `https://docs.homeseer.com/hspi/getdeviceschanged`
- `https://docs.homeseer.com/hspi/setdeviceproperty`
- Local files under `/usr/local/HomeSeer/`
