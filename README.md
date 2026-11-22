# homebridge-sensi-fan

A fork of [`homebridge-sensi`](https://github.com/kitradrago/homebridge-sensi) that adds
the thing the upstream plugin advertises but does not actually implement: **fan mode control**.

Upstream ships a `setFanMode()` method in its API client, but nothing ever calls it and no fan
service is exposed to HomeKit. This fork adds the missing service plus a few reliability fixes.

## What it exposes

Each Sensi thermostat becomes one HomeKit accessory with:

| Service | Purpose |
| --- | --- |
| Switch — "`<Thermostat> Fan`" | **ON** = `fan_mode: on` (blower runs continuously), **OFF** = `fan_mode: auto` |
| Thermostat | temperature + heat/cool/auto/off (optional) |
| Temperature / Humidity sensors | current readings (optional) |

A plain Switch is used rather than `Fanv2` because the Apple Home app does not surface
`Fanv2`'s `TargetFanState` (manual/auto) characteristic, which is the one that actually
matches Sensi's on/auto semantics. A switch is unambiguous and works in Home automations,
scenes, Siri, and Shortcuts.

## Install

Needs Node 18+ and a working [Homebridge](https://homebridge.io).

```sh
git clone https://github.com/MCPGuru/sensi-fan-control.git
cd sensi-fan-control
npm install          # also compiles the TypeScript into dist/
npm install -g .     # makes Homebridge see the plugin
```

Add the platform to `~/.homebridge/config.json` (or use the Homebridge UI, which reads
`config.schema.json`):

```json
{
  "platform": "SensiFanPlatform",
  "name": "Sensi",
  "refreshToken": "filled in by sensi-setup.js",
  "exposeThermostat": true,
  "exposeSensors": true
}
```

## Setup: getting a Sensi token

The plugin signs in with a **refresh token** from your own Sensi account. There are two ways
to get one. Both use the same account as the free Sensi mobile app; neither needs the paid
`manager.sensicomfort.com` portal.

**A. Capture it from the Sensi app (works with this repo as published)**

1. Run `mitmproxy -w /tmp/sensi.flows`, and trust the mitmproxy certificate on the phone
2. Set this machine as the phone's HTTP proxy
3. Force-quit and reopen the Sensi app so it signs in again
4. Find the POST to `oauth.sensiapi.io/token` and copy `refresh_token` from the reply
5. `node sensi-setup.js --token <that token>`

**B. Sign in with your Sensi email and password**

```sh
SENSI_ANDROID_CLIENT_SECRET='...' node sensi-setup.js --login
```

This uses the Sensi Android app's own sign-in client. That client's secret is **not included
in this repository**; you can read it from the same captured traffic as in A (the
`client_secret` field of the app's own token request). If Emerson blocks this route, use A.

Either path checks the credential, writes it to `~/.homebridge/config.json`, and restarts
Homebridge.

2. Confirm it worked:

   ```sh
   tail -f ~/.homebridge/homebridge.log
   ```

   Look for `OAuth success`, `WebSocket connected`, and `Registered accessory`.

`sensi-setup.js --check` re-validates the stored credential. Note that every exchange
rotates the refresh token, so `--check` writes the rotated value back to
`~/.homebridge/sensi-fan-token.json`; restart Homebridge afterwards.

## Bedtime automation (Apple Home)

Time-based automations require a home hub (Apple TV, HomePod, or iPad kept at home).

- **Home app → Automation → +  → A Time of Day Occurs** → bedtime → *Bedroom Fan* **on**
- Second automation at wake time → *Bedroom Fan* **off**

To attach it to an existing routine instead, add the switch to your Good Night scene
(on) and Good Morning scene (off).

## Changes from upstream

- **Fan mode is actually exposed.** New `SensiFanAccessory` wires `set_fan_mode` to a switch.
- **Refresh tokens are persisted.** Sensi rotates the refresh token on every exchange;
  upstream kept the new one in memory only, so a restart after rotation could fail to
  authenticate. The rotated token is now stored in `~/.homebridge/sensi-fan-token.json`.
  The value in `config.json` acts as a seed — replacing it there overrides the stored one.
- **Cached accessories are reused.** Upstream called `registerPlatformAccessories()`
  unconditionally, ignoring accessories restored via `configureAccessory()`. On the second
  start that registers a duplicate UUID, which Homebridge rejects.
- **WebSockets are torn down before reconnecting.** Upstream reassigned `this.ws` without
  closing or removing listeners from the previous socket, leaking sockets and stacking
  handlers on each reconnect.
- **Failed commands surface in HomeKit.** Setters return success and the fan switch throws
  a `SERVICE_COMMUNICATION_FAILURE` rather than silently reporting success while the
  command was dropped.
- Optional `exposeThermostat` / `exposeSensors` flags, and a clean `shutdown` handler.

## Rebuilding after edits

```sh
npm run build && npm install -g .
```

Then restart Homebridge.

## Without Homebridge: two small Python scripts

`scripts/fan.py` and `scripts/temp.py` talk to Sensi directly, for cron jobs and scripts.
They read the same refresh token from the `SensiFanPlatform` block of
`~/.homebridge/config.json`, so they can run beside the plugin. They need one package:
`pip3 install websocket-client`.

```sh
python3 scripts/fan.py --status                  # fan mode of every thermostat
python3 scripts/fan.py --on   --which Bedroom    # blower runs continuously
python3 scripts/fan.py --auto --which Bedroom    # blower only with heating/cooling

python3 scripts/temp.py --status
python3 scripts/temp.py --set-c 20 --which Bedroom
python3 scripts/temp.py --ramp-c 20 --minutes 55 # lower or raise the target slowly
python3 scripts/temp.py --ramp-c 20 --minutes 55 --dry-run
```

Example: a nightly "fan on at 9 pm, auto at 7 am" is two cron lines calling `fan.py`.

## What we learned about the Sensi service

These are observations from running this daily, not official documentation.

- **Sign-in.** `POST https://oauth.sensiapi.io/token` with `grant_type=refresh_token`. The
  access token it returns is used as a bearer token on the WebSocket.
- **Refresh tokens.** The reply can carry a new refresh token. The plugin saves whatever
  comes back (`~/.homebridge/sensi-fan-token.json`). In our use, repeated exchanges returned
  the same token, which is why the scripts can share it with the plugin; do not rely on that.
- **Live connection.** `wss://rt.sensiapi.io/thermostat/?transport=websocket` is a socket.io
  connection. After connecting, the server pushes a `state` message for every thermostat on
  the account; commands such as `set_fan_mode` (`on` / `auto`) and `set_temperature` are
  sent as socket.io events addressed to a thermostat's `icd_id`.
- **The server pings every 25 seconds** and drops a connection that does not answer. A
  script that sleeps between steps must open a fresh connection for each step.
- **Setpoints are whole degrees** in the thermostat's display scale, so a Celsius target is
  rounded on a Fahrenheit thermostat and the other way round.
- **A command can be accepted and still not take effect.** Read the state back and re-send
  if the thermostat did not move; `temp.py` does this up to three times.
- **The first state read after connecting can be empty or incomplete.** Wait a few seconds
  and read again before trusting it.
- **Fan mode is a plain on/auto**, so a HomeKit Switch fits better than a Fan service.
- **macOS:** a Homebridge started by launchd can be silently refused access to the local
  network. Run `node grant-local-network.js` once from a Terminal window on the Mac itself
  to raise the permission prompt.

## Credits and licence

MIT. Original plugin: [kitradrago/homebridge-sensi](https://github.com/kitradrago/homebridge-sensi).
Not affiliated with or endorsed by Emerson, Copeland or Sensi. Use at your own risk; this
relies on an undocumented service that can change without notice.
