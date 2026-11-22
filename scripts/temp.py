#!/usr/bin/env python3
"""Read or ramp Sensi thermostat setpoints, over the same WebSocket as fan.py.

  python3 temp.py --status
  python3 temp.py --set-c 20 [--which NAME]              set target now
  python3 temp.py --ramp-c 20 --minutes 55 [--which N]   ramp slowly to target
  add --dry-run to print the plan without sending anything

Reuses fan.py's connection + token handling. Setpoints are integer degrees in the
unit's display_scale (Celsius on this account), so a Celsius target is rounded.

Ramp steps each open a FRESH socket: the Sensi socket.io server pings every 25 s
(pingInterval 25000 / pingTimeout 60000) and drops any connection that doesn't pong,
so a socket left idle across a ~14 min sleep is dead by the next step (BrokenPipe). Each step is retried once and a failed step does not abort the ramp.
"""
import argparse
import json
import sys
import time

import fan  # sibling module: connect(), hb_block(), access_token()


def c_to_scale(temp_c, scale):
    return round(temp_c * 9 / 5 + 32) if scale == "f" else round(temp_c)


def read_full_state(ws, settle=6.0):
    """{icd: {name, scale, mode, setpoint, cool, heat, display_temp}} for each unit."""
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
            s = dev.get("state") or {}
            cur = devices.get(icd, {})
            name = (dev.get("registration") or {}).get("name") or cur.get("name") or icd
            scale = s.get("display_scale", cur.get("scale", "f"))
            mode = s.get("operating_mode", cur.get("mode"))
            cool = s.get("current_cool_temp", cur.get("cool"))
            heat = s.get("current_heat_temp", cur.get("heat"))
            disp = s.get("display_temp", cur.get("display_temp"))
            devices[icd] = {"name": name, "scale": scale, "mode": mode,
                            "cool": cool, "heat": heat, "display_temp": disp}
    # This automation always operates the COOL setpoint (never heat), so the
    # room warms passively toward the target and the unit never calls for heat.
    for d in devices.values():
        d["setpoint"] = d.get("cool")
    return devices


def send_temp(ws, icd, target, scale):
    # mode is always 'cool' here (see ensure_cool) so we only ever move the cool setpoint.
    ws.send("421" + json.dumps(["set_temperature",
            {"icd_id": icd, "target_temp": target, "mode": "cool", "scale": scale}]))


def fresh_ws(wait_ack=5.0):
    """New authenticated socket, waited until the socket.io connect ack ('40')."""
    ws = fan.connect()
    deadline = time.time() + wait_ack
    while time.time() < deadline:
        try:
            ws.settimeout(max(0.5, deadline - time.time()))
            msg = ws.recv()
        except Exception:
            break
        if msg == "40":
            break
    return ws


def send_step(icd, val, scale, name, attempts=2):
    """One ramp step on its own short-lived socket. Returns True if the send went out.
    Prints the setpoint the server reports afterwards so the log shows what landed."""
    for attempt in range(1, attempts + 1):
        ws = None
        try:
            ws = fresh_ws()
            send_temp(ws, icd, val, scale)
            got = read_full_state(ws, settle=4).get(icd, {}).get("cool")
            note = "" if got is None else (f" (confirmed {got})" if got == val
                                           else f" (server reports {got})")
            print(f"  {name}: -> {val}{scale.upper()}{note}", flush=True)
            return True
        except Exception as e:  # noqa: BLE001
            print(f"  {name}: -> {val}{scale.upper()} FAILED attempt {attempt}: "
                  f"{type(e).__name__}: {e}", flush=True)
            time.sleep(5)
        finally:
            if ws is not None:
                try:
                    ws.close()
                except Exception:
                    pass
    return False


def send_mode(ws, icd, mode):
    ws.send("421" + json.dumps(["set_operating_mode", {"icd_id": icd, "value": mode}]))


def ensure_cool(ws, icd, d, dry):
    """Guarantee the unit is in cool mode so warming to a higher setpoint drifts up
    naturally (AC idle until the target) and never engages heat."""
    if d.get("mode") == "cool":
        return
    print(f"  {d['name']}: mode {d.get('mode')} -> cool (stay on cooling, no heat)")
    if not dry:
        send_mode(ws, icd, "cool")
        time.sleep(1)
    d["mode"] = "cool"


def targets_for(devices, which):
    return {icd: d for icd, d in devices.items()
            if not which or which.lower() in (d["name"] or "").lower()}


def main():
    ap = argparse.ArgumentParser()
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument("--status", action="store_true")
    g.add_argument("--set-c", type=float, metavar="C")
    g.add_argument("--ramp-c", type=float, metavar="C")
    ap.add_argument("--minutes", type=float, default=55)
    ap.add_argument("--which")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    ws = fan.connect()
    try:
        devices = read_full_state(ws)
        # The first read sometimes returns nothing, or units with no
        # setpoint (16 Nov: "no readable setpoint, skipping" - the whole night's
        # cooling was lost). Reconnect and read again, up to two more times.
        for _ in range(2):
            if devices and all(d.get("setpoint") is not None for d in devices.values()):
                break
            try:
                ws.close()
            except Exception:
                pass
            time.sleep(5)
            ws = fan.connect()
            devices = read_full_state(ws)
        if not devices:
            print("No thermostat state received", file=sys.stderr)
            return 1
        tgts = targets_for(devices, args.which)
        if not tgts:
            print(f"No thermostat matched {args.which!r}", file=sys.stderr)
            return 1

        if args.status:
            for d in tgts.values():
                print(f"  {d['name']}: mode={d['mode']} scale={d['scale']} "
                      f"cool={d['cool']} heat={d['heat']} display={d['display_temp']}")
            return 0

        if args.set_c is not None:
            for icd, d in tgts.items():
                ensure_cool(ws, icd, d, args.dry_run)
                t = c_to_scale(args.set_c, d["scale"])
                print(f"  {d['name']}: cool setpoint -> {t}{d['scale'].upper()}")
                if not args.dry_run:
                    send_temp(ws, icd, t, d["scale"])
            time.sleep(2)
            return 0

        # --ramp-c: step each unit from its current setpoint down to target over `minutes`
        final = {icd: c_to_scale(args.ramp_c, d["scale"]) for icd, d in tgts.items()}
        plans = {}
        for icd, d in tgts.items():
            start = d["setpoint"]
            end = final[icd]
            if start is None:
                print(f"  {d['name']}: no readable setpoint, skipping")
                continue
            ensure_cool(ws, icd, d, args.dry_run)
            if start <= end:
                print(f"  {d['name']}: already at/below {end}{d['scale'].upper()} "
                      f"(setpoint {start}); nothing to ramp")
                continue
            steps = int(start - end)  # one step per integer degree
            plans[icd] = (start, end, steps)
            print(f"  {d['name']}: ramp {start} -> {end}{d['scale'].upper()} "
                  f"in {steps} steps over {args.minutes:.0f} min")

        if not plans:
            return 0
        if args.dry_run:
            return 0

        # The planning socket would be dead by the first step (see module docstring);
        # close it now and give every step its own connection.
        ws.close()
        max_steps = max(s for _, _, s in plans.values())
        interval = (args.minutes * 60) / max_steps if max_steps else 0
        failed = 0
        for i in range(1, max_steps + 1):
            time.sleep(interval)
            for icd, (start, end, steps) in plans.items():
                # linear: after i of max_steps, how far this unit should have moved
                frac = i / max_steps
                val = int(round(start - (start - end) * frac))
                val = max(end, val)
                d = devices[icd]
                if not send_step(icd, val, d["scale"], d["name"]):
                    failed += 1
        # Final check: a step can be sent without landing - one night
        # a unit stayed at 21 after "-> 20C (server reports 21)". Read the
        # setpoints back and re-send the target to any unit not there, up to 3 times.
        for _ in range(3):
            time.sleep(20)
            try:
                chk = fresh_ws()
                now_state = read_full_state(chk, settle=5)
                chk.close()
            except Exception:  # noqa: BLE001
                now_state = {}
            short = [icd for icd, (start, end, steps) in plans.items()
                     if now_state.get(icd, {}).get("cool") != end]
            if not short:
                print("  final check: all at target", flush=True)
                break
            for icd in short:
                d = devices[icd]
                print(f"  final check: {d['name']} at "
                      f"{now_state.get(icd, {}).get('cool')}, re-sending", flush=True)
                if not send_step(icd, plans[icd][1], d["scale"], d["name"]):
                    failed += 1
        else:
            failed += 1
            print("  final check: target still not reached after 3 re-sends", file=sys.stderr)
        if failed:
            print(f"  {failed} step(s) failed", file=sys.stderr)
        return 1 if failed else 0
    finally:
        ws.close()


if __name__ == "__main__":
    sys.exit(main())
