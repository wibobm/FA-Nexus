# Change Log

All notable changes to this project will be documented in this file.



## [0.3.1 - 0.3.37] - 2026-01-27
### Changed
- Tool Options sliders no longer respond to plain scroll (except Subgrid Density) to avoid scroll interference; use Ctrl+wheel, drag, or type a value and commit with Enter/blur.

### Fixed
- 'Edit Path/Texture/Building' behaving  all kinds of weird because of some stuff introduced for 'Layer Manager'
- Path control points now render above ohter tiles in the scene so they are no longer blocked visually if you have tiles above higher elevation
- Cloud assets grids now refresh after delta manifest updates without requiring a full reindex.
- Cloud assets with identical filenames but different folder paths no longer collapse into a single entry.
- Other small fixes

### Known Bug
- 'Inner Wall' scale in Building tool being set to '25' in some instances.


## [0.3.0] - 2026-01-25

### Added
- **Layer Manager (MVP):** Right Sidebar tab with a list of all tiles within a scene, right under the 'Scenes' button.
    - Tiles are grouped by 'Elevation'
    - Per Layer/Elevation visibility & lock toggles
    - Elevation adjustments of selected tiles with 'Alt+Scroll wheel' (+Shift/Ctrl modifiers)
    - Selection sync between Layer Manager & canvas
    - Multi selection with Ctrl/Shift click
    - Canvas selevation range & selection limits -  set min/max, skip hidden/locked & 'Ignore foreground toggle' , selection box on canvas as well as 'Ctrl+A' will respect these canvas selection settings.
    - Visual 'Foreground starts at Elev <x>' marker as well as 'Scene Backround' and 'Scene Foreground'
    - Asset placement & premium editors start with elevation set to the highest currently selected tile.

- **Paths v2:** Significant rework of 'Paths' Editor 
    - Multiple paths can be drawn in a single session even at separate elevations, each with separate textures and settings. 'Edit Shapes' allows for any adn all adjustments to already placed paths within a sesssion.
    - *Foundry Walls* toggle, spawns Foundr walls that follow center point of placed path (can be set per-path within same session)
    - *Draw mode* - Freehand drawing instead of 'Curve' point & click option to draw paths, Drawn paths are simplified for optimization.
    - *Merge on Commit* toggle, merges all paths within a session at the same elevetion into a single tile (instead of each path being separate tile)
    - Double clicking now ends current path being placed - *Close Loop* is now a toggle.

- **Asset Scatter Brush:** Quickly scatter selected assets onto a canvas.
    - Options for size/density/spray diviation & spacing
    - Respects random scale, rotation and flips
    - Supports scattering assets in a single session at multiple elevations.
    - Scattered Assets are commited as a single 'Scatter' Tile per elevation. 

    *Warning* - Scatter tiles even tho appear as one tile still draw each scattered asset individually they are not one image, so if you 'overdo it' and spray thousands of assets in a single session, consider flattening said tile for better performance. 

- **Texture Painting Improvements**  
    - *Height Map Texture Painting* - With this option enabled, each texture generates a 'height map', which allows you to only paint certain portions of said texture based on their 'height'. This is fully customizable with a handy 'Preview' window which shows you what exactly you'll be painting.
    For example if you have a brick texture with a grout, you can set the height map in a way where you only paint the bricks while rest of the texture (grout between the bricks) stays transparent, so if you had for example a sandy background already placed, that sandy background will fill that grout instead of whatever the texture had there originally.
    - *Brush settings* - Instead of just one default brush option, you can now customize not only scale, but tip size, density, spray deviation & spacing of the brush, giving you much finer control over how the brush behaves. 
    - Polygon Lasso now supports 'Arc' segments with Shift click. 
    - *Solid Color painting* - option to paint with a solid color instead of a texture, allows you to paint in manual shadows for example. 

- **Flatten Improvements & Scene Export** 
    - New 'Flatten' Button at the bottom of 'Layer Manager'
    - *Output Snap* - Rounds the resulting tile to half or full grid squares for clean snapping.
    - Live output bounds preview
    - *Padding Adjust* - add or trim padding, adjusting the output bounds.
    - Persistent options (PPI, Quality etc.)
    - *Deconstruct offset respect* - if you move a flattned tile, it will deconstruct in new position isntead of snapping back where it was constructer.
    - *Chunking* - Large flattened tiles are split automatically in the background and 'stitched' together at runtime for better performance. You can see the split lines if you have debug enabled in the mod settings.
    - *Export/Flatten Scene* - You can export or flatten the whole scene (cropped to the scene bounds without padding) - accessible in bottom of layers manager with no tiles selected. Option to split by scene foreground elevation (produces separate background/foreground tiles/exports) as well as optional 'Chunking'.  Export exports the full scene image(s) to fa-nexus-assets/exports, scene background & foreground are included in the resulting images.

- **Undo/Redo:** Unified per-session history with `Ctrl+Z`/`Ctrl+Y (or Ctrl+Shift+Z)` in Paths Editor, Texture Painting, Building & Assets Scatter tools. 

- **Session UX unification:**
    - Auto-commit on tab change or nexus close
    - Slider values and settings in tool options are remembered, sliders can be right clicked to return to default value
    - All sliders now have an input value box where you can type in the desired value [#21](https://github.com/Forgotten-Adventures/FA-Nexus/issues/21)
    - Undo/Redo/Commit/Cancel buttons added to the panel
    - Cancel/Discard on ESC or 'Cancel' button press - with 'Are you sure' confirmation popup (double ESC to quickly cancel)

- **Shadowdark system support** Added system detection support for 'Shadowdark RPG' so Tokens can be used. (Thanks to [matteobarbieri](https://github.com/matteobarbieri) for PR! )

### Fixed
- Hidden tiles no longer render drop shadows. [#17](https://github.com/Forgotten-Adventures/FA-Nexus/issues/17)
- Path node selection no longer fails when width tangents are hidden and the node is very narrow. [#14](https://github.com/Forgotten-Adventures/FA-Nexus/issues/14)
- Patreon auth expiry now disconnects cleanly instead of leaving a stale session. [#26](https://github.com/Forgotten-Adventures/FA-Nexus/issues/26)
- "Shift BG & Tile Elevation Down" now re-applies the background render offset after Levels (and similar modules) update background elevation.
- Paths editor polish: Shadow offset step is now 0.01, "Wall Shadow" is labeled "Path Shadow".
- Textures tab includes Texture_Overlays from !Effects.
- Fixes for issues [#19](https://github.com/Forgotten-Adventures/FA-Nexus/issues/19) & [#28](https://github.com/Forgotten-Adventures/FA-Nexus/issues/28)

## [0.2.0] - 2025-12-14

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
