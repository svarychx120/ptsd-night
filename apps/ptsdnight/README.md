# PTSD Night Watch

Monitors heart rate and body tremors in real time. Vibrates continuously if
either high BPM or tremors are detected, providing a physical alert during
PTSD episodes, panic attacks, or high-stress moments.

## Features

- **Heart rate monitoring** — optical sensor reads live BPM
- **Tremor detection** — accelerometer at 25Hz detects high-frequency
  low-amplitude movements across all axes (shaking/tremors)
- **Continuous vibration** — buzzes until BPM drops and tremors stop

## Usage

- Tap top bar (shows T:5/10) to cycle tremor sensitivity 1-10
- Tap upper half of screen to raise HR threshold (+5)
- Tap lower half of screen to lower HR threshold (-5)
- Press the button to exit

## Bluetooth Log

The app exposes a BLE GATT service (`a19585e9-0001-49d0-015f-b3e2b9a0c854`) with
three characteristics:

| Characteristic | UUID | Properties | Description |
|---|---|---|---|
| Log | `...-0002-...` | Read, Notify | Newline-delimited JSON log entries (last ~220 bytes) |
| Status | `...-0003-...` | Read, Notify | Live status JSON: bpm, conf, trm, trmLvl, trmTicks, spike, alert, entries |
| CSV | `...-0004-...` | Read | Full CSV log (persisted to `ptsdnight.log` every 30s) |

**Log entry types:**
- `start` / `stop` — session start/end
- `bpm` — heart rate reading with confidence
- `tremor` — tremor state changes (detected/lost)
- `alert` — alert triggered (reason: spike, max, spike+max)
- `recovery` — alert cleared after sustained calm
- `config` — sensitivity/threshold changes

The log file is also written to on-watch storage as CSV for offline retrieval.
