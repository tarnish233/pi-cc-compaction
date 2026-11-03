# Changelog — pi-cc-compaction

## [Unreleased]

### Added
- `tests/pi-internals.test.mjs` fails when a Pi release renames an internal the patches wrap (`SettingsManager.getCompactionSettings`, `ExtensionRunner.emitBeforeProviderRequest`, `ExtensionRunner.invalidate`), instead of quietly falling back to Pi's compaction thresholds.

### Changed
- The `/pi_cc` settings panel reports Pi as waiting on input (OSC 7501) while it is open.
