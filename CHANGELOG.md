# Change Log

All notable changes to this project will be documented in this file.

## [0.1.1] - 2025-10-26

### Added
- Asset Placement can now re-open and edit existing FA tiles
- Added per-asset shadow controls ( dilation/spread & offset), blur & opacity still per elevation.
- Press `Space` during placement to pin the asset preview in place while you tweak shadows, flips, scale, etc.

### Changed
- Alt+Ctrl/Cmd now nudges elevation in 0.01 increments (Shift still applies the coarse ×5 boost) across asset placement, premium path editing, and premium texture painting; scrolling text now displays hundredths to make micro-adjustments visible.
- Ctrl/Cmd+Shift+Wheel rotates assets in 1° steps (15° remains the default), keeping visual tweaks consistent with the tool-option hints.
- The tool-options controller and placement overlay were tuned to avoid jumpy reflows, ensuring the expanded shadow UI and randomization controls stay in sync with pointer gestures.

### Fixed
- Tile pixel selection ignores tiles at 0 opacity zero, preventing “ghost” hits.
- Asset shadow previews clamp offset handles to the circular gizmo, stopping wild swings when testing large spreads.
- Clamped max spread/offset inputs so extreme values no longer break the shared shadow compositor or cause layout flicker when reopening the tool panel.

## [0.1.0] - 2025-09-04

Initial public release.
