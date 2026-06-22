#!/usr/bin/env python3
"""
PTSD Night Watch — BLE Bridge
Connects to Bangle.js 2 watch and forwards PTSD Night Watch events
to the web server via HTTP.

Usage:
    pip install -r requirements.txt
    python bridge.py [--server http://localhost:8742] [--watch Bangle.js 2]
"""

import asyncio
import json
import sys
import time
import argparse
import logging

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
log = logging.getLogger("bridge")

try:
    from bleak import BleakScanner, BleakClient
except ImportError:
    log.error("bleak not installed. Run: pip install bleak aiohttp")
    sys.exit(1)

try:
    import aiohttp
except ImportError:
    log.error("aiohttp not installed. Run: pip install aiohttp")
    sys.exit(1)

PTSDNIGHT_SVC = "a19585e9-0001-49d0-015f-b3e2b9a0c854"
CHR_LOG = "a19585e9-0002-49d0-015f-b3e2b9a0c854"
CHR_STATUS = "a19585e9-0003-49d0-015f-b3e2b9a0c854"
CHR_CSV = "a19585e9-0004-49d0-015f-b3e2b9a0c854"

class Bridge:
    def __init__(self, server_url="http://localhost:8742", watch_name=None):
        self.server_url = server_url.rstrip("/")
        self.watch_name = watch_name
        self.client = None
        self.session = None
        self.running = False
        self.last_event_count = 0

    async def post_event(self, ev):
        """Post a single event to the server."""
        try:
            async with self.session.post(
                f"{self.server_url}/api/event",
                json=ev,
                timeout=aiohttp.ClientTimeout(total=5)
            ) as resp:
                if resp.status != 200:
                    log.warning(f"Server returned {resp.status}")
                else:
                    data = await resp.json()
                    count = data.get("total", 0)
                    if count != self.last_event_count:
                        self.last_event_count = count
        except aiohttp.ClientError as e:
            log.warning(f"Failed to post event: {e}")
        except Exception as e:
            log.warning(f"Unexpected error posting event: {e}")

    async def post_batch(self, events):
        """Post a batch of events to the server."""
        if not events:
            return
        try:
            async with self.session.post(
                f"{self.server_url}/api/batch",
                json=events,
                timeout=aiohttp.ClientTimeout(total=10)
            ) as resp:
                if resp.status != 200:
                    log.warning(f"Batch post returned {resp.status}")
        except Exception as e:
            log.warning(f"Failed to post batch: {e}")

    def handle_log_notify(self, sender, data):
        """Handle notification from the Log characteristic."""
        try:
            text = data.decode("utf-8", errors="replace")
            lines = text.split("\n")
            events = []
            for line in lines:
                line = line.strip()
                if not line:
                    continue
                try:
                    ev = json.loads(line)
                except json.JSONDecodeError:
                    # Could be a partial line
                    continue
                if ev.get("t"):
                    ev["sent"] = time.strftime(
                        "%Y-%m-%dT%H:%M:%S", time.localtime(ev["t"])
                    )
                events.append(ev)
                self._print_event(ev)

            if events:
                asyncio.ensure_future(self.post_batch(events))
        except Exception as e:
            log.error(f"Log notify handler error: {e}")

    def handle_status_notify(self, sender, data):
        """Handle notification from the Status characteristic."""
        try:
            text = data.decode("utf-8", errors="replace").strip()
            if not text:
                return
            st = json.loads(text)
            bpm = st.get("bpm", "?")
            alert = "ALERT" if st.get("alert") else "OK"
            trm = "T" if st.get("trm") else "-"
            log.info(f"Status: BPM={bpm} [{alert}] spike={st.get('spike','?')} trm={st.get('trmLvl','?')} entries={st.get('entries','?')}")
        except json.JSONDecodeError:
            pass
        except Exception as e:
            log.error(f"Status notify handler error: {e}")

    def _print_event(self, ev):
        """Print a formatted event to the console."""
        etype = ev.get("type", "?")
        if etype == "bpm":
            log.info(f"BPM: {ev.get('bpm','?')} (conf: {ev.get('conf','?')}%)")
        elif etype == "alert":
            log.warning(f"⚠️  ALERT! BPM={ev.get('bpm','?')} spike=+{ev.get('spike','?')} reason={ev.get('reason','?')}")
        elif etype == "tremor":
            if ev.get("trmDet"):
                log.info(f"Tremor ON  level={ev.get('trmLvl','?')}")
        elif etype == "recovery":
            log.info(f"Recovery after {ev.get('calmSecs','?')}s")
        elif etype in ("start", "stop", "config"):
            log.info(f"{etype}: {json.dumps(ev)}")

    async def find_watch(self):
        """Scan for Bangle.js devices and return the first match."""
        log.info("Scanning for Bangle.js devices (5 seconds)...")
        devices = await BleakScanner.discover(timeout=5.0)

        bangles = []
        for d in devices:
            name = d.name or ""
            if "bangle" in name.lower():
                bangles.append(d)

        if not bangles:
            log.warning("No Bangle.js devices found")
            return None

        log.info(f"Found {len(bangles)} Bangle.js device(s):")
        for i, d in enumerate(bangles):
            log.info(f"  [{i}] {d.name} ({d.address}) RSSI: {d.rssi}")

        if self.watch_name:
            for d in bangles:
                if self.watch_name.lower() in (d.name or "").lower():
                    return d
            log.warning(f"No device matching '{self.watch_name}' found")

        return bangles[0]

    async def connect_and_stream(self, address):
        """Connect to the watch and start streaming data."""
        log.info(f"Connecting to {address}...")

        self.client = BleakClient(address, timeout=15.0)
        try:
            await self.client.connect()
            if not self.client.is_connected:
                log.error("Failed to connect")
                return False

            log.info(f"Connected: {self.client.is_connected}")

            # Verify the PTSD Night service is available
            svc = self.client.services.get_service(PTSDNIGHT_SVC)
            if not svc:
                log.error("PTSD Night Watch service not found. Is the app running on the watch?")
                return False

            log.info("PTSD Night Watch service found")

            # Subscribe to notifications
            await self.client.start_notify(CHR_LOG, self.handle_log_notify)
            await self.client.start_notify(CHR_STATUS, self.handle_status_notify)
            log.info("Subscribed to Log and Status notifications")

            # Read initial CSV
            try:
                csv_data = await self.client.read_gatt_char(CHR_CSV)
                if csv_data:
                    log.info(f"Initial CSV data: {len(csv_data)} bytes")
            except Exception:
                pass

            # Keep running and handle disconnection
            self.running = True

            def disconnect_handler(client):
                log.warning("Watch disconnected!")
                self.running = False

            self.client.set_disconnected_callback(disconnect_handler)

            while self.running and self.client.is_connected:
                await asyncio.sleep(1)

            return True

        except asyncio.TimeoutError:
            log.error("Connection timed out")
            return False
        except Exception as e:
            log.error(f"Connection error: {e}")
            return False
        finally:
            if self.client and self.client.is_connected:
                try:
                    await self.client.stop_notify(CHR_LOG)
                    await self.client.stop_notify(CHR_STATUS)
                except Exception:
                    pass
                await self.client.disconnect()
            log.info("Disconnected")

    async def run(self):
        """Main loop — find watch, connect, reconnect on disconnect."""
        self.session = aiohttp.ClientSession()

        # Test server connectivity
        try:
            async with self.session.get(
                f"{self.server_url}/api/status",
                timeout=aiohttp.ClientTimeout(total=5)
            ) as resp:
                if resp.status == 200:
                    data = await resp.json()
                    log.info(f"Server OK — {data.get('totalEvents', 0)} events stored")
                else:
                    log.warning(f"Server responded with status {resp.status}")
        except aiohttp.ClientError:
            log.warning(f"Server at {self.server_url} is not reachable. Data will be printed locally.")
        except Exception as e:
            log.warning(f"Cannot reach server: {e}")

        while True:
            device = await self.find_watch()
            if not device:
                log.info("Retrying scan in 5 seconds...")
                await asyncio.sleep(5)
                continue

            log.info(f"Using device: {device.name} ({device.address})")
            connected = await self.connect_and_stream(device.address)

            if not connected:
                log.info("Retrying in 5 seconds...")
                await asyncio.sleep(5)
            else:
                log.info("Session ended. Reconnecting in 3 seconds...")
                await asyncio.sleep(3)


def main():
    parser = argparse.ArgumentParser(description="PTSD Night Watch BLE Bridge")
    parser.add_argument(
        "--server", default="http://localhost:8742",
        help="Server URL (default: http://localhost:8742)"
    )
    parser.add_argument(
        "--watch", default=None,
        help="Watch name to filter (e.g. 'Bangle.js 2')"
    )
    args = parser.parse_args()

    bridge = Bridge(server_url=args.server, watch_name=args.watch)

    async def shutdown():
        if bridge.client and bridge.client.is_connected:
            await bridge.client.disconnect()
        if bridge.session:
            await bridge.session.close()

    loop = asyncio.new_event_loop()
    try:
        loop.run_until_complete(bridge.run())
    except KeyboardInterrupt:
        log.info("Stopped by user")
    finally:
        loop.run_until_complete(shutdown())
        loop.close()


if __name__ == "__main__":
    main()
