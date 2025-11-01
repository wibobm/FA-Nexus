# Change Log

All notable changes to this project will be documented in this file.

## [0.1.3] - 2025-11-01

### Added
- Tile flattening workflow exposed on the tile HUD. Merges selected tiles into a single baked image, saves undo metadata, and adds a dedicated dialog for resolution/quality choices plus deconstruction support.

https://github.com/user-attachments/assets/37034115-77a0-4d6b-a0c7-d954ed52c246


### Fixed
- Assets tab card helper now resolves local texture/path file locations consistently. [#1](https://github.com/Forgotten-Adventures/FA-Nexus/issues/1)
- Updated premium texture and path editors to resolve module assets via Foundry's routed base path in an effort to fix bundle loading when the module runs from subdirectories. [#4](https://github.com/Forgotten-Adventures/FA-Nexus/issues/4)
- Pixel-perfect tile selection no longer blocks Foundry's native resize handle for standard assets; FA path and texture tiles keep their handles hidden to avoid unsupported scaling. [#5](https://github.com/Forgotten-Adventures/FA-Nexus/issues/5)

## [0.1.2] - 2025-10-29

### Added
- Premium paths now supports elevation based shadows with shadow geometry editing (Shift+click inserts points, Alt+click deletes), dedicated path shadow scale, offset, blur, opacity and dialation sliders, and adds saved presets.

### Changed
- Texture painting and Path placement remembers elevation between uses.


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
