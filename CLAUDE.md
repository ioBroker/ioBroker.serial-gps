# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

ioBroker adapter that reads NMEA GPS data from a serial/USB GPS receiver and publishes it as ioBroker states. Written in TypeScript, compiled to `build/`, runs as an ioBroker `daemon` adapter (also supports `compact` mode).

## Commands

```bash
npm run build          # compile src/*.ts -> build/ via tsc -p tsconfig.build.json
npm run lint           # eslint -c eslint.config.mjs
npm test               # alias for test:integration
npm run test:integration   # mocha test/adapter.test.js --exit (spins up a real js-controller)
npm run test:package       # mocha test/package.test.js --exit (validates io-package.json / package.json)
```

Run a single integration assertion: `npx mocha test/adapter.test.js --exit --grep "must see position"`.

There is **no watch task**: edit `src/`, run `npm run build`, then test. `build/` is the published artifact (declared in `package.json` `files` and `main`); commit it only via the release flow, not by hand.

Releases use `@alcalzone/release-script`: `npm run release-patch | release-minor | release-major`. The version, changelog (`README.md`), and `io-package.json` `news` are kept in sync by the script — do not bump versions in those three places manually.

## Architecture

Almost everything lives in **`src/main.ts`** — a single `SerialGpsAdapter extends Adapter` class plus three pure module-level helpers. There is no parser module split; the NMEA logic is inline. The only other module is `src/lib/usedResources.ts` (see below).

**Used resources (js-controller 8):** `common.declareUsedResources: true` in `io-package.json` means the instance itself tells js-controller 8 which exclusive resources it occupies (`system.host.<name>.usedResources.serialPort`). Two types are reported (`usedResources.<type>`): `serialPort` and, in test mode, `udpPort`. `openPort()` asks for a conflicting instance before opening (`reportResourceConflict`), registers the resolved path once `open` succeeds and frees it on `close` (not on unload — the host handles stopped instances). `openUdpServer()` asks before binding and registers on `listening`; it is never freed, because the socket only closes on unload. The admin `test`/`detectBaudRate` only ask for conflicts. All helpers are feature-detected (`CONTROLLER_USED_RESOURCES`) and never throw, so older controllers are unaffected. A new resource type goes into the `UsedResources` map in that module.

**Data flow:** raw bytes → `processReceivedData()` (line buffering on `\n`) → `parseData()` (splits a line into `$`-delimited sentences, verifies checksum, dispatches by sentence type) → `setStateIfChangedAsync()` → ioBroker states under `gps.*` and `info.connection`.

**Two input sources feed the same pipeline:**
- `openPort()` — the real `SerialPort`. Handles `data`/`error`/`close` events and auto-reconnects after 5s via `reconnectTimer` (guarded with `||=` so only one timer is ever pending).
- `openUdpServer()` — a UDP socket on port **50547**, opened only when `config.test` is true. This is how the integration test injects NMEA sentences without hardware (see `test/adapter.test.js` sending UDP datagrams). Keep this path working when touching `processReceivedData`.

**Admin / config messages** are handled in the `message:` callback in the constructor, driven by `admin/jsonConfig.json` buttons:
- `list` → enumerate serial ports (`SerialPort.list()`) for the port dropdown.
- `detectBaudRate` → probe `[4800, 9600, 19200, 38400, 57600, 115200]` by opening each and watching 2s for a `$GxGGA`/`$GxRMC` sentence.
- `test` → confirm a GPS receiver responds on a given port/baud.
- `getMapUrl` → URL for the `iframeSendTo` of the "Current position" tab: `adapter/serial-gps/map.html?instance=N`, relative so that it is resolved against the admin page (reverse proxy prefix). `admin/map.html` is a static page served by admin; it loads `../../lib/js/socket.io.js` from admin (same connection as the classic settings pages), Leaflet from cdnjs, and subscribes to `serial-gps.N.gps.*` (position from `gps.latlon`, which is written in one piece). The other values of that tab are plain jsonConfig `state` items.
Both `detectBaudRate` and `test` temporarily `closePort()` the live port if it matches, then `openPort()` again afterward.

**NMEA parsing specifics worth knowing before editing `parseData`:**
- Sentence type is matched by suffix (`type.endsWith('GGA'|'RMC'|'GSA')`) so both `$GP*` (GPS) and `$GN*` (multi-GNSS) talkers are accepted.
- `nmeaToDecimal()` converts `ddmm.mmmm`/`dddmm.mmmm` to signed decimal degrees; degree-field width depends on hemisphere (2 for N/S, 3 for E/W).
- GGA sentences carry time but no date, so `lastDate` is cached from the most recent RMC and reused for GGA timestamps (`parseNmeaDateTime`).
- `position` state is `lon;lat`; `latlon` state is `lat;lon` — these orderings are intentional and consumed differently downstream.

**State writes are throttled:** `setStateIfChangedAsync()` skips writes when the value is unchanged *and* less than 60s old (dedup via the `lastStates` map). On top of it, `gps.*` values go through `setGpsStateAsync()` (at most once per `config.updateInterval` seconds) and the four position states through `setPositionAsync()` (interval plus `config.minDistance` meters from the last written position, `distanceMeters()` haversine). `gps.course` goes through `setCourseAsync()` (interval plus `config.minCourseChange` degrees, wrap-around at 360°, and only while the RMC speed is at least `config.minCourseSpeed` km/h). `info.connection` is never throttled. All four options default to `0` (off = previous behavior).

## Conventions

- State objects are declared statically in `io-package.json` `instanceObjects` (not created at runtime). Adding a new state means adding it there **with all i18n translations** (`en, de, ru, pt, nl, fr, it, es, pl, uk, zh-cn`) to match the existing entries, and admin UI labels go in `admin/i18n/*.json`.
- Some inline comments are in German; the surrounding code style is English. Match the file you are editing.
- Node `>=20`, js-controller `>=6.0.19`. `serialport` v13 is the only runtime dep besides `@iobroker/adapter-core`.
