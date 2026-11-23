# Changelog — pi-cc-compaction

## [Unreleased]

## [0.2.16] - 2026-11-23

### Fixed
- Trim a copy of Pi's cached settings rows instead of mutating the native render result. Settings typecheck cleanly without changing user configuration values.

### Changed
- Synchronize stable shared settings and current message/key descriptions with Loop, Monitor and Plugins; unfinished custom action pages are not shipped.
- Require tests and typechecking against Pi 1.6.0 before trusted npm publishing; use installed peers in CI without requiring a global Pi installation. Compaction behavior is unchanged.

## [0.2.15] - 2026-11-14

### Changed
- Show only loaded-package settings pages in `/pi_cc`; standalone Compaction no longer displays irrelevant Loop/Monitor or Plugins controls. Text commands remain compatible and unrelated stored values are preserved.
- Scope shared command ownership and capabilities to each Pi runtime, including safe reloads and mixed-version registry upgrades. Compaction thresholds, triggers and lifecycle are unchanged.
- Replace hard-coded Pi 1.3.0 typecheck paths with portable local peer/Pi release discovery and optional `PI_AGENT_DIR` / `PI_TYPESCRIPT_PATH` overrides.

## [0.2.14] - 2026-11-14

### Changed
- Synchronize shared pi-cc settings with Monitor and Loop: normalize panel/CLI values while preserving stored booleans, environment overrides and cross-package updates.
- Align the shared footer description with count-first labels; compaction thresholds, triggers and lifecycle are unchanged.

## [0.2.13] - 2026-11-03

### Added
- `tests/pi-internals.test.mjs` fails when a Pi release renames an internal the patches wrap (`SettingsManager.getCompactionSettings`, `ExtensionRunner.emitBeforeProviderRequest`, `ExtensionRunner.invalidate`), instead of quietly falling back to Pi's compaction thresholds.

### Changed
- The `/pi_cc` settings panel reports Pi as waiting on input (OSC 7501) while it is open.
