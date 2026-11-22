#!/usr/bin/env python3
"""Set or read the Sensi thermostat fan mode, independent of HomeKit.

Talks the same WebSocket protocol as the Homebridge plugin and reuses the
refresh token from ~/.homebridge/config.json. Running alongside Homebridge is
safe: Sensi's refresh_token grant is non-rotating (verified - repeated exchanges
return the same token), so this does not invalidate the token Homebridge holds.

  python3 fan.py --status              show fan mode for every thermostat
  python3 fan.py --on   [--which NAME] fan runs continuously
  python3 fan.py --auto [--which NAME] fan runs only with heat/cool
"""
import argparse
import json
import pathlib
import sys
import time
import urllib.parse
import urllib.request

try:
    from websocket import create_connection  # websocket-client
except ImportError:
    print("Missing dependency: pip3 install websocket-client", file=sys.stderr)
    raise

HB_CONFIG = pathlib.Path.home() / ".homebridge" / "config.json"
PLATFORM = "SensiFanPlatform"
OAUTH = "https://oauth.sensiapi.io/token"
WS = "wss://rt.sensiapi.io/thermostat/?transport=websocket"


def hb_block():
    cfg = json.loads(HB_CONFIG.read_text())
    block = next((p for p in cfg.get("platforms", []) if p.get("platform") == PLATFORM), None)
    if not block:
        raise SystemExit(f"No {PLATFORM} block in {HB_CONFIG}")
    return block


def access_token():
    """Exchange the refresh token. Client id/secret must match the issuing client."""
    b = hb_block()
    body = urllib.parse.urlencode({
        "client_id": b.get("clientId") or "fleet",
        "client_secret": b.get("clientSecret") or "",
        "grant_type": "refresh_token",
        "refresh_token": b["refreshToken"],
    }).encode()
    req = urllib.request.Request(OAUTH, data=body, headers={
        "Content-Type": "application/x-www-form-urlencoded; charset=utf-8",
        "Accept": "*/*",
    })
    return json.loads(urllib.request.urlopen(req, timeout=15).read())["access_token"]


def connect():
    return create_connection(WS, header=[f"Authorization: bearer {access_token()}"], timeout=20)


def read_state(ws, settle=6.0):
    """Collect device state frames for a few seconds; returns {icd_id: (name, fan_mode)}."""
    devices, deadline = {}, time.time() + settle
    while time.time() < deadline:
        try:
            ws.settimeout(max(0.5, deadline - time.time()))
            msg = ws.recv()
        except Exception:
            break
        if not isinstance(msg, str) or not msg.startswith("42"):
            continue
        try:
            event, payload = json.loads(msg[2:])[:2]
        except Exception:
            continue
        if event != "state" or not isinstance(payload, list):
            continue
        for dev in payload:
            icd = (dev.get("icd_id") or "").lower()
            if not icd:
                continue
            name, fan = devices.get(icd, (None, None))
            name = (dev.get("registration") or {}).get("name") or name or icd
            fan = (dev.get("state") or {}).get("fan_mode", fan)
            devices[icd] = (name, fan)
    return devices


def send_fan(ws, icd, mode):
    ws.send("421" + json.dumps(["set_fan_mode", {"icd_id": icd, "value": mode}]))


def main():
    ap = argparse.ArgumentParser()
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument("--status", action="store_true")
    g.add_argument("--on", action="store_true")
    g.add_argument("--auto", action="store_true")
    ap.add_argument("--which", help="thermostat name substring; default all")
    args = ap.parse_args()

    ws = connect()
    try:
        devices = read_state(ws)
        if not devices:
            print("No thermostat state received", file=sys.stderr)
            return 1

        targets = {
            icd: (name, fan) for icd, (name, fan) in devices.items()
            if not args.which or args.which.lower() in (name or "").lower()
        }
        if not targets:
            print(f"No thermostat matched {args.which!r}. Known: "
                  f"{', '.join(n for n, _ in devices.values())}", file=sys.stderr)
            return 1

        if args.status:
            for name, fan in targets.values():
                print(f"  {name}: fan_mode={fan}")
            return 0

        mode = "on" if args.on else "auto"
        for icd, (name, fan) in targets.items():
            if fan == mode:
                print(f"  {name}: already {mode}")
                continue
            send_fan(ws, icd, mode)
            print(f"  {name}: {fan} -> {mode}")
        time.sleep(2)  # let the frames flush before closing
        return 0
    finally:
        ws.close()


if __name__ == "__main__":
    sys.exit(main())
