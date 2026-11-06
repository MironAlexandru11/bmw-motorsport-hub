# Motorsport Hub — BMW MGU / iDrive 7

A single application with five pages:
1. **Dyno Live** — live power/torque estimate and a saved curve from a full-throttle pull.
2. **Drag Timer** — automatic launch detection, speed trace and interpolated splits.
3. **Best Times** — saved personal bests and recent runs.
4. **xDrive** — upstream experimental DSC/VIP/LMV implementation, with ECU-specific checks and two-press confirmation.
5. **Exhaust** — upstream DME controller and adapter architecture, with OPEN/CLOSE/OEM controls.

## Based on upstream code

This app reuses these upstream project components:
- `apps/live_adjustments/xdrive.js`
- `apps/live_adjustments/controller.js`
- `apps/live_adjustments/adapters.js`
- `apps/live_adjustments/real_adapters.js`
- `apps/live_adjustments/diaglink.js`
- `apps/draggy/timer.js`
- runtime modules supplied by `kit/`

The xDrive and exhaust modules are copied unchanged from the upstream source archive. Their original experimental/compatibility limitations still apply.

## Safety defaults

- **xDrive control defaults to Disabled.** Enable it in app Settings only after reading the upstream xDrive notes. `xDrive ON` is exposed only on the upstream's explicitly tested ECU index; OFF remains experimental and uses the upstream ECU gates and double confirmation.
- **Exhaust control defaults to Disarmed / Simulated.** In this mode it does not actuate the vehicle. The upstream real adapter is gated by DME matching and its own arm setting; not every DME has a validated real adapter.
- Dyno and drag calculations are estimates based on vehicle signals. Use only on a closed course / dynamometer and never operate the screen while driving.
- The app is not affiliated with BMW AG.

## Add to your `idrive7-apps` checkout

Copy the entire `apps/motorsport_hub/` directory into the upstream repository's `apps/` directory. Keep the upstream `kit/` directory and build scripts unchanged.

Run tests and offline preview from the repository root:

```sh
node kit/tools/test_live_adjustments.js
node kit/tools/test_bm3_protocol.js
python3 kit/tools/build.py motorsport_hub --preview-only
node kit/tools/emu.js motorsport_hub
```

`--preview-only` does not produce an installable MGU package. To create the installable `.mgu`, the repository's `oap-sdk/` extracted from the target head unit must be present, and the normal build command must succeed:

```sh
python3 kit/tools/build.py motorsport_hub
```

The `oap-sdk/` is intentionally not included in this source package. Obtain it from your own head unit using the exact procedure in the upstream README. Do not use an SDK dump from a different MGU software build.

## Repository publishing

For a personal MGU Store source, publish the complete repository (including `mgu-repo.json` and the app directory) to a GitHub repository, then add that repository's URL as a source in MGU Store. This archive is an overlay containing the new app folder; it is not itself a repository root and cannot be added directly as an MGU Store source.
