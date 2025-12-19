# Change Log

All notable changes to this project will be documented in this file.

## [0.2.2] - 2025-12-14

### Added
- **Building Tool:** Construct building footprints with help of rectangle, elipse and polygon shapes (with arcs support) and inner walls that auto-generate foundry walls, place textured doors, windows and gaps and preview the full structure in real-time before committing. Supports texture assignment per wall, adjsutable floor texture, automatic shadow generation matching asset elevation rules and multiple buildings in one session that get separated on commit. 
- **Subgrid Density** slider for 'Snap to Grid' — choose from full, 1/2 , 1/3 , 1/4 , 1/5 grid snapping options. 
- **Direct URLs for free cloud content** option in module settings, when enabled, free cloud tokens and assets will be loaded directly from the public URL instead of being downloaded and cached locally - saving storage space.
- **Restricted player access** to FA Nexus and it's module settings. [#3](https://github.com/Forgotten-Adventures/FA-Nexus/issues/3)
- **Floating Launcher** option in module settings, when enabled,the Nexus Launcher button floats freely and can be dragged anywhere on screen isntead of being docked above the players list.
- **S3 bucket support:** Source selector now properly saves S3 buckets as valid content sources. Also added S3 support for 'Cloud Download Folder(s)' [#12](https://github.com/Forgotten-Adventures/FA-Nexus/issues/12)
- **Compendium filtering for Place Token As:** Filter which compendiums appear in actor suggestions to avoid duplicates across SRD, homebrew, and official modules. [#2](https://github.com/Forgotten-Adventures/FA-Nexus/issues/2)

### Changed
- Reworked "Keep Tokens Above Tile Elevations" to shift tile render elevation down by 1 for all tiles below elevation 1, leaving tokens and visual FX unmodified.
- Scene background is pushed down to elevation -5 while the feature is enabled to prevent it from obscuring shifted tiles.
- **Asset Drop Shadow** - Enabled by default.
- **Paths Shadows** - Smoother blur and consistency across all zoom levels.
- **Paths Width Tangents** - Width Tangents are hidden by default, can be activated with a tickbox in the tool panel, they also ignore 'snap to grid' setting.
- **Paths Thumbnails** - Paths & Walls are displayed in wide aspect ration, significantly improving selection at a glance.

### Fixed
- Tile render ordering is now more compatible with Sequencer/JB2A/Automated Animations or other modules relying on placing stuff above tokens since tokens are no longer repositioned.
- Keyboard nudging (WASD/Arrow Keys) no longer floors tile elevation to 0 when dz is unchanged, preserving fractional elevations.
- Foundry VTT zoom no longer stops at 0.2 on large scenes when FA Nexus is active. [#6](https://github.com/Forgotten-Adventures/FA-Nexus/issues/6)
- Pixel-perfect selection no longer captures color-fill tiles across the entire canvas [#7](https://github.com/Forgotten-Adventures/FA-Nexus/issues/7)
- Random Color on Placement now works correctly with local tokens instead of erroring about uncached images. [#8](https://github.com/Forgotten-Adventures/FA-Nexus/issues/8)
- Added an option to not modify actor size when applying artwork from differently-sized creatures through 'Update Actor Token'. [#11](https://github.com/Forgotten-Adventures/FA-Nexus/issues/11)
- "Place Token As" now preserves prototype token settings (e.g. Append Incrementing number & Prepend random adjective) instead of ignoring custom configurations. Also added these 2 options into the Token Placement options so they can be set when 'Placing Token As' [#9](https://github.com/Forgotten-Adventures/FA-Nexus/issues/9)

## [0.1.3] - 2025-11-01

### Added
- Tile flattening workflow exposed on the tile HUD. Merges selected tiles into a single baked image, saves undo metadata, and adds a dedicated dialog for resolution/quality choices plus deconstruction support. [#1](https://github.com/Forgotten-Adventures/FA-Nexus/issues/1)

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
