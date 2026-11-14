# Changelog — pi-cc-compaction

## [Unreleased]

## [0.2.14] - 2026-11-14

### Changed
- Synchronize shared pi-cc settings with Monitor and Loop: normalize panel/CLI values while preserving stored booleans, environment overrides and cross-package updates.
- Align the shared footer description with count-first labels; compaction thresholds, triggers and lifecycle are unchanged.

## [0.2.13] - 2026-11-03

### Added
- `tests/pi-internals.test.mjs` fails when a Pi release renames an internal the patches wrap (`SettingsManager.getCompactionSettings`, `ExtensionRunner.emitBeforeProviderRequest`, `ExtensionRunner.invalidate`), instead of quietly falling back to Pi's compaction thresholds.

### Changed
- The `/pi_cc` settings panel reports Pi as waiting on input (OSC 7501) while it is open.
