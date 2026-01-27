import { NexusLogger as Logger } from './nexus-logger.js';
import {
  GRID_SNAP_SUBDIV_SETTING_KEY,
  GRID_SNAP_SUBDIV_MIN,
  GRID_SNAP_SUBDIV_MAX,
  GRID_SNAP_SUBDIV_DEFAULT,
  normalizeGridSnapSubdivision,
  formatGridSnapSubdivisionLabel,
  readGridSnapSubdivisionSetting
} from './grid-snap-utils.js';

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

const MODULE_ID = 'fa-nexus';
const TOOL_WINDOW_SETTING_KEY = 'toolOptionsWindowPos';
const GRID_SNAP_SETTING_KEY = 'gridSnap';
const SHORTCUTS_SETTING_KEY = 'toolOptionsShortcuts';
const DEFAULT_WINDOW_TITLE = 'Tool Options';

/**
 * ToolOptionsWindow
 * Lightweight application shell that reflects the currently active canvas tool.
 */
class ToolOptionsWindow extends HandlebarsApplicationMixin(ApplicationV2) {
  static DEFAULT_OPTIONS = foundry.utils.mergeObject(
    foundry.utils.deepClone(super.DEFAULT_OPTIONS ?? {}),
    {
      id: 'fa-nexus-tool-options',
      tag: 'section',
      position: { width: 320, height: 400 },
      window: {
        resizable: true,
        minimizable: true,
        title: DEFAULT_WINDOW_TITLE
      }
    },
    { inplace: false }
  );

  static PARTS = foundry.utils.mergeObject(
    foundry.utils.deepClone(super.PARTS ?? {}),
    {
      body: { template: 'modules/fa-nexus/templates/tool-options.hbs' }
    },
    { inplace: false }
  );

  constructor({
    controller,
    gridSnapEnabled = true,
    gridSnapAvailable = true,
    gridSnapSubdivisions = GRID_SNAP_SUBDIV_DEFAULT,
    toolOptions = {}
  } = {}) {
    super();
    this._controller = controller;
    this._activeTool = null;
    this._restoringPosition = false;
    this._gridSnapEnabled = !!gridSnapEnabled;
    this._gridSnapAvailable = !!gridSnapAvailable;
    this._gridSnapSubdivisions = this._normalizeGridSnapSubdivision(gridSnapSubdivisions);
    this._gridSnapToggle = null;
    this._gridSnapResolutionRoot = null;
    this._gridSnapResolutionSlider = null;
    this._gridSnapResolutionDisplay = null;
    this._boundGridSnapChange = (event) => this._handleGridSnapChange(event);
    this._boundGridSnapResolutionInput = (event) => this._handleGridSnapResolutionInput(event, false);
    this._boundGridSnapResolutionCommit = (event) => this._handleGridSnapResolutionInput(event, true);
    this._toolOptionState = toolOptions && typeof toolOptions === 'object' ? toolOptions : {};
    this._dropShadowToggle = null;
    this._boundDropShadowChange = (event) => this._handleDropShadowChange(event);
    this._dropShadowRoot = null;
    this._dropShadowAlphaSlider = null;
    this._dropShadowDilationSlider = null;
    this._dropShadowBlurSlider = null;
    this._dropShadowOffsetControl = null;
    this._dropShadowOffsetCircle = null;
    this._dropShadowOffsetHandle = null;
    this._dropShadowPreviewRoot = null;
    this._dropShadowPreviewImage = null;
    this._dropShadowOffsetMaxDistance = 40;
    this._dropShadowOffsetPointerId = null;
    this._dropShadowOffsetPointerActive = false;
    this._dropShadowAlphaDisplay = null;
    this._resizeObserver = null;
    this._userResizing = false;
    this._savedHeight = null;
    this._dropShadowDilationDisplay = null;
    this._dropShadowBlurDisplay = null;
    this._dropShadowOffsetDistanceDisplay = null;
    this._dropShadowOffsetAngleDisplay = null;
    this._dropShadowCollapseButton = null;
    this._dropShadowBody = null;
    this._dropShadowPresetsRoot = null;
    this._dropShadowPresetButtons = [];
    this._dropShadowResetButton = null;
    this._shortcutsRoot = null;
    this._shortcutsToggle = null;
    this._shortcutsContent = null;
    this._shortcutsCollapsed = false;
    this._shortcutsCollapsedByTool = new Map();
    this._restoreShortcutsState();
    this._boundShortcutsToggle = (event) => this._handleShortcutsToggle(event);
    this._boundDropShadowAlphaInput = (event) => this._handleDropShadowSlider(event, 'setDropShadowAlpha', false);
    this._boundDropShadowAlphaCommit = (event) => this._handleDropShadowSlider(event, 'setDropShadowAlpha', true);
    this._boundDropShadowDilationInput = (event) => this._handleDropShadowSlider(event, 'setDropShadowDilation', false);
    this._boundDropShadowDilationCommit = (event) => this._handleDropShadowSlider(event, 'setDropShadowDilation', true);
    this._boundDropShadowBlurInput = (event) => this._handleDropShadowSlider(event, 'setDropShadowBlur', false);
    this._boundDropShadowBlurCommit = (event) => this._handleDropShadowSlider(event, 'setDropShadowBlur', true);
    this._boundDropShadowOffsetPointerDown = (event) => this._handleDropShadowOffsetPointerDown(event);
    this._boundDropShadowOffsetPointerMove = (event) => this._handleDropShadowOffsetPointerMove(event);
    this._boundDropShadowOffsetPointerUp = (event) => this._handleDropShadowOffsetPointerUp(event);
    this._boundDropShadowOffsetContext = (event) => this._handleDropShadowOffsetContext(event);
    this._boundDropShadowCollapse = (event) => this._handleDropShadowCollapse(event);
    this._boundDropShadowPresetClick = (event) => this._handleDropShadowPresetClick(event);
    this._boundDropShadowPresetContext = (event) => this._handleDropShadowPresetContext(event);
    this._boundDropShadowReset = (event) => this._handleDropShadowReset(event);
    this._boundResettableContext = (event) => this._handleResettableContext(event);
    this._customToggleBindings = new Map();
    this._resettableContextRoot = null;
    this._sliderWheelRoot = null;
    this._boundSliderWheel = (event) => this._handleSliderWheel(event);
    this._placementRoot = null;
    this._placementPushTopButton = null;
    this._placementPushBottomButton = null;
    this._placementOrderDisplay = null;
    this._placementHint = null;
    this._placementStateLabels = [];
    this._placementSwitchRoots = [];
    this._boundPlacementPushTop = (event) => this._handlePlacementPush(event, 'top');
    this._boundPlacementPushBottom = (event) => this._handlePlacementPush(event, 'bottom');
    this._textureToolsRoot = null;
    this._textureModeLabel = null;
    this._textureModeButtons = [];
    this._textureModeButtonMap = new Map();
    this._textureActionsRoot = null;
    this._textureActionButtons = [];
    this._textureActionButtonMap = new Map();
    this._textureStatusDisplay = null;
    this._textureHintDisplay = null;
    this._boundTextureModeClick = (event) => this._handleTextureModeClick(event);
    this._boundTextureActionClick = (event) => this._handleTextureActionClick(event);
    this._editorActionsRoot = null;
    this._editorActionButtons = [];
    this._editorActionButtonMap = new Map();
    this._boundEditorActionClick = (event) => this._handleEditorActionClick(event);
    this._textureOpacityRoot = null;
    this._textureOpacitySlider = null;
    this._textureOpacityDisplay = null;
    this._boundTextureOpacityInput = (event) => this._handleTextureOpacity(event, false);
    this._boundTextureOpacityCommit = (event) => this._handleTextureOpacity(event, true);
    this._textureBrushRoot = null;
    this._textureBrushSizeSlider = null;
    this._textureBrushSizeDisplay = null;
    this._textureParticleSizeSlider = null;
    this._textureParticleSizeDisplay = null;
    this._textureParticleDensitySlider = null;
    this._textureParticleDensityDisplay = null;
    this._textureSprayDeviationSlider = null;
    this._textureSprayDeviationDisplay = null;
    this._textureBrushSpacingSlider = null;
    this._textureBrushSpacingDisplay = null;
    this._boundTextureBrushSizeInput = (event) => this._handleTextureBrushSetting(event, 'setBrushSize', false);
    this._boundTextureBrushSizeCommit = (event) => this._handleTextureBrushSetting(event, 'setBrushSize', true);
    this._boundTextureParticleSizeInput = (event) => this._handleTextureBrushSetting(event, 'setParticleSize', false);
    this._boundTextureParticleSizeCommit = (event) => this._handleTextureBrushSetting(event, 'setParticleSize', true);
    this._boundTextureParticleDensityInput = (event) => this._handleTextureBrushSetting(event, 'setParticleDensity', false);
    this._boundTextureParticleDensityCommit = (event) => this._handleTextureBrushSetting(event, 'setParticleDensity', true);
    this._boundTextureSprayDeviationInput = (event) => this._handleTextureBrushSetting(event, 'setSprayDeviation', false);
    this._boundTextureSprayDeviationCommit = (event) => this._handleTextureBrushSetting(event, 'setSprayDeviation', true);
    this._boundTextureBrushSpacingInput = (event) => this._handleTextureBrushSetting(event, 'setBrushSpacing', false);
    this._boundTextureBrushSpacingCommit = (event) => this._handleTextureBrushSetting(event, 'setBrushSpacing', true);
    this._assetScatterRoot = null;
    this._assetScatterBrushSizeSlider = null;
    this._assetScatterBrushSizeDisplay = null;
    this._assetScatterDensitySlider = null;
    this._assetScatterDensityDisplay = null;
    this._assetScatterSprayDeviationSlider = null;
    this._assetScatterSprayDeviationDisplay = null;
    this._assetScatterSpacingSlider = null;
    this._assetScatterSpacingDisplay = null;
    this._boundAssetScatterBrushSizeInput = (event) => this._handleAssetScatterSetting(event, 'setScatterBrushSize', false);
    this._boundAssetScatterBrushSizeCommit = (event) => this._handleAssetScatterSetting(event, 'setScatterBrushSize', true);
    this._boundAssetScatterDensityInput = (event) => this._handleAssetScatterSetting(event, 'setScatterDensity', false);
    this._boundAssetScatterDensityCommit = (event) => this._handleAssetScatterSetting(event, 'setScatterDensity', true);
    this._boundAssetScatterSprayDeviationInput = (event) => this._handleAssetScatterSetting(event, 'setScatterSprayDeviation', false);
    this._boundAssetScatterSprayDeviationCommit = (event) => this._handleAssetScatterSetting(event, 'setScatterSprayDeviation', true);
    this._boundAssetScatterSpacingInput = (event) => this._handleAssetScatterSetting(event, 'setScatterSpacing', false);
    this._boundAssetScatterSpacingCommit = (event) => this._handleAssetScatterSetting(event, 'setScatterSpacing', true);
    this._heightMapRoot = null;
    this._heightMapCollapseButton = null;
    this._heightMapBody = null;
    this._boundHeightMapCollapse = (event) => this._handleHeightMapCollapse(event);
    this._heightBrushRoot = null;
    this._heightBrushMinSlider = null;
    this._heightBrushMaxSlider = null;
    this._heightBrushMinDisplay = null;
    this._heightBrushMaxDisplay = null;
    this._boundHeightBrushMinInput = (event) => this._handleHeightBrushThreshold(event, 'min', false);
    this._boundHeightBrushMinCommit = (event) => this._handleHeightBrushThreshold(event, 'min', true);
    this._boundHeightBrushMaxInput = (event) => this._handleHeightBrushThreshold(event, 'max', false);
    this._boundHeightBrushMaxCommit = (event) => this._handleHeightBrushThreshold(event, 'max', true);
    this._heightBrushContrastSlider = null;
    this._heightBrushLiftSlider = null;
    this._heightBrushContrastDisplay = null;
    this._heightBrushLiftDisplay = null;
    this._boundHeightBrushContrastInput = (event) => this._handleHeightBrushTuning(event, 'contrast', false);
    this._boundHeightBrushContrastCommit = (event) => this._handleHeightBrushTuning(event, 'contrast', true);
    this._boundHeightBrushLiftInput = (event) => this._handleHeightBrushTuning(event, 'lift', false);
    this._boundHeightBrushLiftCommit = (event) => this._handleHeightBrushTuning(event, 'lift', true);
    this._textureLayerRoot = null;
    this._textureLayerSlider = null;
    this._textureLayerDisplay = null;
    this._boundTextureLayerInput = (event) => this._handleTextureLayerOpacity(event, false);
    this._boundTextureLayerCommit = (event) => this._handleTextureLayerOpacity(event, true);
    this._pathOpacityRoot = null;
    this._pathOpacitySlider = null;
    this._pathOpacityDisplay = null;
    this._boundPathOpacityInput = (event) => this._handlePathOpacity(event, false);
    this._boundPathOpacityCommit = (event) => this._handlePathOpacity(event, true);
    this._pathScaleRoot = null;
    this._pathScaleSlider = null;
    this._pathScaleDisplay = null;
    this._boundPathScaleInput = (event) => this._handlePathScale(event, false);
    this._boundPathScaleCommit = (event) => this._handlePathScale(event, true);
    this._boundPathScaleWheel = (event) => this._handlePathScaleWheel(event);
    this._fillElevationRoot = null;
    this._fillElevationInput = null;
    this._fillElevationDisplay = null;
    this._boundFillElevationInput = (event) => this._handleFillElevation(event, false);
    this._boundFillElevationCommit = (event) => this._handleFillElevation(event, true);
    this._boundFillElevationWheel = (event) => this._handleFillElevationWheel(event);
    this._fillElevationLogState = {
      missingRootLogged: false,
      lastAvailableState: null
    };
    this._fillElevationRerenderJob = null;
    this._placeAsNamingRerenderJob = null;
    this._placeAsNamingRerenderRevision = null;
    this._placeAsNamingRerenderCount = 0;
    this._pathOffsetRoot = null;
    this._pathOffsetXSlider = null;
    this._pathOffsetYSlider = null;
    this._pathOffsetXDisplay = null;
    this._pathOffsetYDisplay = null;
    this._boundPathOffsetXInput = (event) => this._handlePathOffset(event, 'x', false);
    this._boundPathOffsetXCommit = (event) => this._handlePathOffset(event, 'x', true);
    this._boundPathOffsetYInput = (event) => this._handlePathOffset(event, 'y', false);
    this._boundPathOffsetYCommit = (event) => this._handlePathOffset(event, 'y', true);
    this._pathTensionRoot = null;
    this._pathTensionSlider = null;
    this._pathTensionDisplay = null;
    this._boundPathTensionInput = (event) => this._handlePathTension(event, false);
    this._boundPathTensionCommit = (event) => this._handlePathTension(event, true);
    this._pathSimplifyRoot = null;
    this._pathSimplifySlider = null;
    this._pathSimplifyDisplay = null;
    this._boundPathSimplifyInput = (event) => this._handlePathSimplify(event, false);
    this._boundPathSimplifyCommit = (event) => this._handlePathSimplify(event, true);
    this._showWidthTangentsRoot = null;
    this._showWidthTangentsToggle = null;
    this._boundShowWidthTangentsChange = (event) => this._handleShowWidthTangentsChange(event);
    this._textureOffsetRoot = null;
    this._textureOffsetXSlider = null;
    this._textureOffsetYSlider = null;
    this._textureOffsetXDisplay = null;
    this._textureOffsetYDisplay = null;
    this._boundTextureOffsetXInput = (event) => this._handleTextureOffset(event, 'x', false);
    this._boundTextureOffsetXCommit = (event) => this._handleTextureOffset(event, 'x', true);
    this._boundTextureOffsetYInput = (event) => this._handleTextureOffset(event, 'y', false);
    this._boundTextureOffsetYCommit = (event) => this._handleTextureOffset(event, 'y', true);
    this._fillTextureOffsetRoot = null;
    this._fillTextureOffsetXSlider = null;
    this._fillTextureOffsetYSlider = null;
    this._fillTextureOffsetXDisplay = null;
    this._fillTextureOffsetYDisplay = null;
    this._boundFillTextureOffsetXInput = (event) => this._handleFillTextureOffset(event, 'x', false);
    this._boundFillTextureOffsetXCommit = (event) => this._handleFillTextureOffset(event, 'x', true);
    this._boundFillTextureOffsetYInput = (event) => this._handleFillTextureOffset(event, 'y', false);
    this._boundFillTextureOffsetYCommit = (event) => this._handleFillTextureOffset(event, 'y', true);
    this._placeAsSearchInput = null;
    this._placeAsList = null;
    this._placeAsLinkedToggle = null;
    this._placeAsAppendNumberToggle = null;
    this._placeAsPrependAdjectiveToggle = null;
    this._placeAsToggleButton = null;
    this._placeAsHpModeSelect = null;
    this._placeAsHpPercentInput = null;
    this._placeAsHpStaticInput = null;
    this._placeAsHpModeHint = null;
    this._placeAsHpPercentHint = null;
    this._placeAsHpStaticHint = null;
    this._placeAsHpStaticError = null;
    this._placeAsHpPercentRow = null;
    this._placeAsHpStaticRow = null;
    this._boundPlaceAsSearch = (event) => this._handlePlaceAsSearch(event);
    this._boundPlaceAsOptionClick = (event) => this._handlePlaceAsOptionClick(event);
    this._boundPlaceAsLinkedChange = (event) => this._handlePlaceAsLinked(event);
    this._boundPlaceAsAppendNumberChange = (event) => this._handlePlaceAsAppendNumber(event);
    this._boundPlaceAsPrependAdjectiveChange = (event) => this._handlePlaceAsPrependAdjective(event);
    this._boundPlaceAsToggle = (event) => this._handlePlaceAsToggle(event);
    this._boundPlaceAsFilter = (event) => this._handlePlaceAsFilter(event);
    this._placeAsFilterButton = null;
    this._boundPlaceAsHpMode = (event) => this._handlePlaceAsHpMode(event);
    this._boundPlaceAsHpPercent = (event) => this._handlePlaceAsHpPercent(event);
    this._boundPlaceAsHpStatic = (event) => this._handlePlaceAsHpStatic(event);
    this._flipRoot = null;
    this._flipDisplay = null;
    this._flipPreviewDisplay = null;
    this._flipHorizontalButton = null;
    this._flipVerticalButton = null;
    this._flipHorizontalRandomButton = null;
    this._flipVerticalRandomButton = null;
    this._boundFlipHorizontal = (event) => this._handleFlipHorizontal(event);
    this._boundFlipVertical = (event) => this._handleFlipVertical(event);
    this._boundFlipHorizontalRandom = (event) => this._handleFlipRandomHorizontal(event);
    this._boundFlipVerticalRandom = (event) => this._handleFlipRandomVertical(event);
    this._scaleRoot = null;
    this._scaleDisplay = null;
    this._scaleBaseSlider = null;
    this._scaleRandomButton = null;
    this._scaleStrengthRow = null;
    this._scaleStrengthSlider = null;
    this._scaleStrengthDisplay = null;
    this._boundScaleInput = (event) => this._handleScaleInput(event);
    this._boundScaleRandom = (event) => this._handleScaleRandom(event);
    this._boundScaleStrength = (event) => this._handleScaleStrength(event);
    this._rotationRoot = null;
    this._rotationDisplay = null;
    this._rotationBaseSlider = null;
    this._rotationRandomButton = null;
    this._rotationStrengthRow = null;
    this._rotationStrengthSlider = null;
    this._rotationStrengthDisplay = null;
    this._boundRotationInput = (event) => this._handleRotationInput(event);
    this._boundRotationStrength = (event) => this._handleRotationStrength(event);
    this._boundRotationRandom = (event) => this._handleRotationRandom(event);
    this._pathShadowRoot = null;
    this._pathShadowToggle = null;
    this._pathShadowEditToggle = null;
    this._pathShadowEditRoot = null;
    this._pathShadowOffsetSlider = null;
    this._pathShadowOffsetDisplay = null;
    this._pathShadowAlphaSlider = null;
    this._pathShadowAlphaDisplay = null;
    this._pathShadowBlurSlider = null;
    this._pathShadowBlurDisplay = null;
    this._pathShadowDilationSlider = null;
    this._pathShadowDilationDisplay = null;
    this._pathShadowPresetsRoot = null;
    this._pathShadowPresetButtons = [];
    this._pathShadowResetButton = null;
    this._pathShadowEditResetButton = null;
    this._pathShadowElevationDisplay = null;
    this._pathShadowNoteDisplay = null;
    this._boundPathShadowToggle = (event) => this._handlePathShadowToggle(event);
    this._boundPathShadowEditToggle = (event) => this._handlePathShadowEdit(event);
    this._boundPathShadowScaleInput = (event) => this._handlePathShadowSlider(event, 'setPathShadowScale', false);
    this._boundPathShadowScaleCommit = (event) => this._handlePathShadowSlider(event, 'setPathShadowScale', true);
    this._boundPathShadowOffsetInput = (event) => this._handlePathShadowSlider(event, 'setPathShadowOffset', false);
    this._boundPathShadowOffsetCommit = (event) => this._handlePathShadowSlider(event, 'setPathShadowOffset', true);
    this._boundPathShadowAlphaInput = (event) => this._handlePathShadowSlider(event, 'setPathShadowAlpha', false);
    this._boundPathShadowAlphaCommit = (event) => this._handlePathShadowSlider(event, 'setPathShadowAlpha', true);
    this._boundPathShadowBlurInput = (event) => this._handlePathShadowSlider(event, 'setPathShadowBlur', false);
    this._boundPathShadowBlurCommit = (event) => this._handlePathShadowSlider(event, 'setPathShadowBlur', true);
    this._boundPathShadowDilationInput = (event) => this._handlePathShadowSlider(event, 'setPathShadowDilation', false);
    this._boundPathShadowDilationCommit = (event) => this._handlePathShadowSlider(event, 'setPathShadowDilation', true);
    this._boundPathShadowPresetClick = (event) => this._handlePathShadowPresetClick(event);
    this._boundPathShadowPresetContext = (event) => this._handlePathShadowPresetContext(event);
    this._boundPathShadowReset = (event) => this._handlePathShadowReset(event);
    this._boundPathShadowEditReset = (event) => this._handlePathShadowEditReset(event);
    this._pathFeatherRoot = null;
    this._pathFeatherStartToggle = null;
    this._pathFeatherEndToggle = null;
    this._pathFeatherStartSlider = null;
    this._pathFeatherEndSlider = null;
    this._pathFeatherStartValue = null;
    this._pathFeatherEndValue = null;
    this._pathFeatherHint = null;
    this._boundPathFeatherStartToggle = (event) => this._handlePathFeatherToggle(event, 'start');
    this._boundPathFeatherEndToggle = (event) => this._handlePathFeatherToggle(event, 'end');
    this._boundPathFeatherStartInput = (event) => this._handlePathFeatherLength(event, 'start', false);
    this._boundPathFeatherStartCommit = (event) => this._handlePathFeatherLength(event, 'start', true);
    this._boundPathFeatherEndInput = (event) => this._handlePathFeatherLength(event, 'end', false);
    this._boundPathFeatherEndCommit = (event) => this._handlePathFeatherLength(event, 'end', true);
    this._opacityFeatherRoot = null;
    this._opacityFeatherStartToggle = null;
    this._opacityFeatherEndToggle = null;
    this._opacityFeatherStartSlider = null;
    this._opacityFeatherEndSlider = null;
    this._opacityFeatherStartValue = null;
    this._opacityFeatherEndValue = null;
    this._opacityFeatherHint = null;
    this._boundOpacityFeatherStartToggle = (event) => this._handleOpacityFeatherToggle(event, 'start');
    this._boundOpacityFeatherEndToggle = (event) => this._handleOpacityFeatherToggle(event, 'end');
    this._boundOpacityFeatherStartInput = (event) => this._handleOpacityFeatherLength(event, 'start', false);
    this._boundOpacityFeatherStartCommit = (event) => this._handleOpacityFeatherLength(event, 'start', true);
    this._boundOpacityFeatherEndInput = (event) => this._handleOpacityFeatherLength(event, 'end', false);
    this._boundOpacityFeatherEndCommit = (event) => this._handleOpacityFeatherLength(event, 'end', true);
    this._pendingScrollState = null;
    this._pendingContentStyle = null;
    this._resetScrollNextRender = false;
    this._syncWindowTitle();
  }

  _syncDropShadowPreview(preview) {
    const root = this._dropShadowPreviewRoot;
    const image = this._dropShadowPreviewImage;
    if (!root || !image) return;
    const hasPreview = preview && typeof preview === 'object' && typeof preview.src === 'string' && preview.src.length > 0;
    if (hasPreview) {
      if (image.src !== preview.src) image.src = preview.src;
      if (preview.alt !== undefined) image.alt = String(preview.alt || '');
      root.classList.remove('is-empty');
    } else {
      if (image.hasAttribute('src')) image.removeAttribute('src');
      image.alt = '';
      root.classList.add('is-empty');
    }
  }

  applyDropShadowPreview(preview) {
    if (!this._toolOptionState || typeof this._toolOptionState !== 'object') {
      this._toolOptionState = {};
    }
    const controls = this._toolOptionState.dropShadowControls && typeof this._toolOptionState.dropShadowControls === 'object'
      ? this._toolOptionState.dropShadowControls
      : {};
    if (preview && typeof preview === 'object' && typeof preview.src === 'string' && preview.src.length > 0) {
      controls.preview = preview;
    } else {
      delete controls.preview;
    }
    this._toolOptionState.dropShadowControls = controls;
    if (this.rendered) this._syncDropShadowPreview(controls.preview || null);
  }

  render(force, options) {
    if (this.rendered) {
      if (this._resetScrollNextRender) this._pendingScrollState = { top: 0, left: 0 };
      else this._pendingScrollState = this._measureScrollState();
      this._pendingContentStyle = this._measureContentStyle();
    } else {
      this._pendingScrollState = null;
      this._pendingContentStyle = null;
    }
    return super.render(force, options);
  }

  get activeTool() {
    return this._activeTool;
  }

  setActiveTool(tool) {
    const previousId = this._activeTool?.id ?? null;
    const next = tool ? { id: String(tool.id || ''), label: String(tool.label || tool.id || '') } : null;
    this._activeTool = next;
    const nextId = next?.id ?? null;
    if (nextId && this._shortcutsCollapsedByTool.has(nextId)) {
      this._shortcutsCollapsed = !!this._shortcutsCollapsedByTool.get(nextId);
    } else {
      this._shortcutsCollapsed = false;
    }
    if (!nextId) this._shortcutsCollapsed = false;
    this._syncShortcutsControls();
    this._syncWindowTitle();
    if (nextId !== previousId) this._resetScrollNextRender = true;
    if (this.rendered) this.render(false);
  }

  _shouldForceRenderForStateChange(previousState = {}, nextState = {}) {
    const prevRevision = previousState?.layoutRevision ?? null;
    const nextRevision = nextState?.layoutRevision ?? null;
    if (prevRevision !== nextRevision) return true;
    const paths = [
      ['texturePaint', 'available'],
      ['texturePaint', 'opacity', 'available'],
      ['textureBrush', 'available'],
      ['assetScatter', 'available'],
      ['heightBrush', 'available'],
      ['heightMap', 'available'],
      ['layerOpacity', 'available'],
      ['textureOffset', 'available'],
      ['scale', 'available'],
      ['rotation', 'available'],
      ['pathAppearance', 'available'],
      ['pathAppearance', 'layerOpacity', 'available'],
      ['pathAppearance', 'scale', 'available'],
      ['pathAppearance', 'textureOffset', 'available'],
      ['pathAppearance', 'tension', 'available'],
      ['pathAppearance', 'freehandSimplify', 'available'],
      ['pathAppearance', 'showWidthTangents', 'available'],
      ['fillElevation', 'available'],
      ['fillTexture', 'available'],
      ['fillTexture', 'offset', 'available'],
      ['pathShadow', 'available'],
      ['pathFeather', 'available'],
      ['opacityFeather', 'available'],
      ['dropShadowControls', 'available'],
      ['dropShadow', 'available'],
      ['flip', 'available'],
      ['placeAs', 'naming', 'available'],
      ['doorControls', 'available'],
      ['doorControls', 'frameSettings'],
      ['windowControls', 'available'],
      ['windowControls', 'sillSettings'],
      ['windowControls', 'textureSettings'],
      ['windowControls', 'frameSettings'],
      ['shapeStacking', 'available']
    ];
    const valueAtPath = (state, path) => {
      let cursor = state;
      for (const segment of path) {
        if (!cursor || typeof cursor !== 'object') return undefined;
        cursor = cursor[segment];
      }
      return typeof cursor === 'boolean' ? cursor : !!cursor;
    };
    return paths.some((path) => {
      const previous = valueAtPath(previousState, path);
      const next = valueAtPath(nextState, path);
      return !previous && !!next;
    });
  }

  setActiveToolOptions(options = {}, { suppressRender = false } = {}) {
    const nextState = options && typeof options === 'object' ? options : {};
    const previousState = this._toolOptionState && typeof this._toolOptionState === 'object'
      ? this._toolOptionState
      : {};
    const forceRender = suppressRender && this.rendered && this._shouldForceRenderForStateChange(previousState, nextState);
    this._toolOptionState = nextState;
    if (this.rendered && (!suppressRender || forceRender)) this.render(false);
    else if (this.rendered) {
      this._syncGridSnapControl();
      this._syncDropShadowControl();
      this._syncDropShadowControls();
      this._syncTextureToolControls();
      this._syncEditorActions();
      this._syncTextureOpacityControl();
      this._syncTextureBrushControls();
      this._syncAssetScatterControls();
      this._syncHeightMapControls();
      this._syncHeightBrushControls();
      this._syncTextureOffsetControls();
      this._syncTextureLayerControl();
      this._syncPathAppearanceControls();
      this._syncFillElevationControl();
      this._syncFillTextureControls();
      this._syncCustomToggles();
      this._syncPlacementControls();
      this._syncFlipControls();
      this._syncScaleControls();
      this._syncRotationControls();
      this._syncPathShadowControls();
      this._syncPathFeatherControls();
      this._syncOpacityFeatherControls();
      this._syncShortcutsControls();
      this._syncPlaceAsControls();
      this._syncDoorControls();
      this._syncWindowControls();
    }
  }

  _resolveWindowTitle() {
    const label = typeof this._activeTool?.label === 'string' ? this._activeTool.label.trim() : '';
    if (label.length > 0) return `${label} Options`;
    return DEFAULT_WINDOW_TITLE;
  }

  _syncWindowTitle() {
    const title = this._resolveWindowTitle();
    try {
      if (!this.options.window || typeof this.options.window !== 'object') this.options.window = {};
      this.options.window.title = title;
    } catch (_) {}
    try {
      const appWindow = this.window;
      if (appWindow) {
        if (typeof appWindow.setTitle === 'function') appWindow.setTitle(title);
        else appWindow.title = title;
      }
    } catch (_) {}
    try {
      const headerTitle = this.element?.querySelector('.window-title');
      if (headerTitle) headerTitle.textContent = title;
    } catch (_) {}
  }

  async _prepareContext() {
    const tool = this._activeTool;
    const canToggleGridSnap = !!(this._controller?.supportsGridSnap?.() && this._gridSnapAvailable);
    const gridSnapResolution = this._prepareGridSnapResolution();
    const options = this._toolOptionState || {};
    const dropShadow = options.dropShadow || {};
    const dropShadowTooltip = typeof dropShadow.tooltip === 'string' && dropShadow.tooltip.length
      ? dropShadow.tooltip
      : 'Toggle drop shadows for asset placements.';
    const dropShadowHint = typeof dropShadow.hint === 'string' ? dropShadow.hint : '';
    const dropShadowControls = this._prepareDropShadowControls(options.dropShadowControls, dropShadow);
    const hintLines = (() => {
      if (Array.isArray(options.hints)) {
        return options.hints.filter((line) => typeof line === 'string' && line.trim().length).map((line) => line.trim());
      }
      if (typeof options.hints === 'string' && options.hints.trim().length) {
        return [options.hints.trim()];
      }
      return [];
    })();
    const shortcuts = {
      available: hintLines.length > 0,
      collapsed: !!this._shortcutsCollapsed,
      lines: hintLines
    };
    const mapToggle = (toggle) => ({
      id: String(toggle?.id || ''),
      group: typeof toggle?.group === 'string' ? toggle.group : '',
      label: String(toggle?.label || ''),
      tooltip: String(toggle?.tooltip || ''),
      onLabel: typeof toggle?.onLabel === 'string' ? toggle.onLabel : '',
      offLabel: typeof toggle?.offLabel === 'string' ? toggle.offLabel : '',
      enabled: !!toggle?.enabled,
      disabled: !!toggle?.disabled
    });
    const mapAction = (action) => ({
      id: String(action?.id || ''),
      label: String(action?.label || ''),
      tooltip: String(action?.tooltip || ''),
      primary: !!action?.primary,
      disabled: !!action?.disabled
    });
    const allToggleList = Array.isArray(options.customToggles)
      ? options.customToggles.map(mapToggle).filter((toggle) => toggle.id.length)
      : [];
    const subtoolToggleList = Array.isArray(options.subtoolToggles)
      ? options.subtoolToggles.map(mapToggle).filter((toggle) => toggle.id.length)
      : allToggleList.filter((toggle) => toggle.group === 'subtool');
    const subtoolOptionToggleList = allToggleList.filter((toggle) => toggle.group === 'subtool-option');
    const heightMapToggleList = allToggleList.filter((toggle) => toggle.group === 'height-map');
    const nonSubtoolToggleList = allToggleList.filter((toggle) => !['subtool', 'subtool-option', 'height-map'].includes(toggle.group));
    const placementToggleList = nonSubtoolToggleList.filter((toggle) => toggle.group === 'placement');
    const customToggleList = nonSubtoolToggleList.filter((toggle) => toggle.group !== 'placement');
    const editorActionList = Array.isArray(options.editorActions)
      ? options.editorActions.map(mapAction).filter((action) => action.id.length)
      : [];
    const placeAs = options.placeAs && typeof options.placeAs === 'object' ? options.placeAs : null;
    const scale = this._prepareScaleContext(options.scale);
    const rotation = this._prepareRotationContext(options.rotation);
    const flip = this._prepareFlipContext(options.flip);
    const texturePaint = this._prepareTexturePaintContext(options.texturePaint);
    const textureBrush = this._prepareTextureBrushContext(options.textureBrush);
    const assetScatter = this._prepareAssetScatterContext(options.assetScatter);
    const heightBrush = this._prepareHeightBrushContext(options.heightBrush);
    const heightMap = this._prepareHeightMapContext(options.heightMap, heightMapToggleList, heightBrush);
    const textureOffset = this._prepareTextureOffsetContext(options.textureOffset);
    const fillTexture = this._prepareFillTextureContext(options.fillTexture);
    const layerOpacity = this._prepareLayerOpacityContext(options.layerOpacity);
    const pathShadow = this._preparePathShadowContext(options.pathShadow);
    const pathAppearance = this._preparePathAppearanceContext(options.pathAppearance);
    const pathFeather = this._preparePathFeatherContext(options.pathFeather);
    const opacityFeather = this._prepareOpacityFeatherContext(options.opacityFeather);
    const fillElevation = this._prepareFillElevationContext(options.fillElevation);
    const shapeStackingRaw = options.shapeStacking && typeof options.shapeStacking === 'object'
      ? options.shapeStacking
      : null;
    const shapeStacking = shapeStackingRaw && shapeStackingRaw.available
      ? {
          available: true,
          hasSelection: !!shapeStackingRaw.hasSelection,
          orderLabel: typeof shapeStackingRaw.orderLabel === 'string' ? shapeStackingRaw.orderLabel : '',
          elevationLabel: typeof shapeStackingRaw.elevationLabel === 'string' ? shapeStackingRaw.elevationLabel : '',
          pushTopDisabled: !!shapeStackingRaw.pushTopDisabled,
          pushBottomDisabled: !!shapeStackingRaw.pushBottomDisabled,
          hint: typeof shapeStackingRaw.hint === 'string' ? shapeStackingRaw.hint : ''
        }
      : { available: false };
    return {
      hasActiveTool: !!tool,
      activeToolId: tool?.id ?? null,
      activeToolLabel: tool?.label ?? '',
      gridSnapEnabled: !!this._gridSnapEnabled,
      gridSnapAvailable: canToggleGridSnap,
      gridSnapResolution,
      showDropShadowToggle: !!dropShadow.available,
      dropShadowEnabled: !!dropShadow.enabled,
      dropShadowDisabled: !!dropShadow.disabled,
      dropShadowTooltip,
      dropShadowHint: dropShadowHint,
      dropShadowControls,
      shortcuts,
      hasSubtoolToggles: subtoolToggleList.length > 0,
      subtoolToggles: subtoolToggleList,
      hasSubtoolOptions: subtoolOptionToggleList.length > 0,
      subtoolOptions: subtoolOptionToggleList,
      hasEditorActions: editorActionList.length > 0,
      editorActions: editorActionList,
      hasHeightMapToggles: heightMapToggleList.length > 0,
      heightMapToggles: heightMapToggleList,
      heightMap,
      hasPlacementToggles: placementToggleList.length > 0,
      placementToggles: placementToggleList,
      hasCustomToggles: customToggleList.length > 0,
      customToggles: customToggleList,
      flip,
      scale,
      placeAs: placeAs || { available: false },
      rotation,
      texturePaint,
      textureBrush,
      assetScatter,
      heightBrush,
      textureOffset,
      fillTexture,
      layerOpacity,
      pathShadow,
      fillElevation,
      pathAppearance,
      pathFeather,
      opacityFeather,
      shapeStacking,
      doorControls: options.doorControls || null,
      windowControls: options.windowControls || null
    };
  }

  _prepareFillTextureContext(raw) {
    if (!raw || typeof raw !== 'object' || !raw.available) {
      return { available: false };
    }
    const coerceAxis = (axisRaw = {}) => {
      const min = Number.isFinite(axisRaw.min) ? Number(axisRaw.min) : -500;
      const max = Number.isFinite(axisRaw.max) ? Number(axisRaw.max) : 500;
      const step = Number.isFinite(axisRaw.step) && Number(axisRaw.step) > 0 ? Number(axisRaw.step) : 1;
      const value = Number.isFinite(axisRaw.value) ? Number(axisRaw.value) : 0;
      const display = typeof axisRaw.display === 'string' ? axisRaw.display : `${Math.round(value)} px`;
      return {
        min,
        max,
        step,
        value,
        display,
        disabled: !!axisRaw.disabled
      };
    };
    const offsetRaw = raw.offset && typeof raw.offset === 'object' ? raw.offset : {};
    const offsetAvailable = offsetRaw.available !== false;
    const offset = offsetAvailable
      ? {
          available: true,
          label: typeof offsetRaw.label === 'string' && offsetRaw.label.length ? offsetRaw.label : 'Fill Texture Offset',
          hint: typeof offsetRaw.hint === 'string' ? offsetRaw.hint : '',
          disabled: !!offsetRaw.disabled,
          x: coerceAxis(offsetRaw.x),
          y: coerceAxis(offsetRaw.y)
        }
      : { available: false };
    return {
      available: true,
      offset,
      // Preserve any upstream extras (scale/rotation already exposed separately)
      scale: raw.scale,
      rotation: raw.rotation
    };
  }

  _prepareGridSnapResolution() {
    const controllerAllows = this._controller?.isGridSnapSettingAvailable?.();
    const available = !!(this._gridSnapAvailable && (controllerAllows !== false));
    if (!available) return { available: false };
    const value = this._normalizeGridSnapSubdivision(this._gridSnapSubdivisions);
    return {
      available: true,
      min: GRID_SNAP_SUBDIV_MIN,
      max: GRID_SNAP_SUBDIV_MAX,
      step: 1,
      value,
      display: this._formatGridSnapResolutionDisplay(value),
      hint: '0 = full grid, 1 = halves, 2 = thirds, 3 = quarters, 4 = fifths',
      disabled: false
    };
  }

  _prepareFlipContext(raw) {
    if (!raw || typeof raw !== 'object' || !raw.available) {
      return { available: false };
    }
    const coerceString = (value, fallback = '') => (typeof value === 'string' ? value : fallback);
    const coerceBool = (value) => !!value;
    const buildAxis = (axisRaw = {}) => {
      const data = axisRaw && typeof axisRaw === 'object' ? axisRaw : {};
      const randomButtonVisible = data.randomButtonVisible !== undefined ? !!data.randomButtonVisible : true;
      return {
        active: coerceBool(data.active),
        label: coerceString(data.label, 'Flip'),
        tooltip: coerceString(data.tooltip, ''),
        disabled: coerceBool(data.disabled),
        aria: coerceString(data.aria, 'Toggle mirroring'),
        previewDiff: coerceBool(data.previewDiff),
        randomEnabled: coerceBool(data.randomEnabled),
        randomLabel: coerceString(data.randomLabel, 'Random'),
        randomTooltip: coerceString(data.randomTooltip, data.randomEnabled ? 'Disable random' : 'Enable random'),
        randomDisabled: coerceBool(data.randomDisabled),
        randomAria: coerceString(data.randomAria, 'Toggle random mirroring'),
        randomPreviewDiff: coerceBool(data.randomPreviewDiff),
        randomButtonVisible
      };
    };
    return {
      available: true,
      display: coerceString(raw.display, 'None'),
      previewDisplay: coerceString(raw.previewDisplay, ''),
      randomHint: coerceString(raw.randomHint, ''),
      horizontal: buildAxis(raw.horizontal),
      vertical: buildAxis(raw.vertical)
    };
  }

  _prepareScaleContext(raw) {
    if (!raw || typeof raw !== 'object' || !raw.available) {
      return { available: false };
    }
    const clamp = (value, min, max, fallback) => {
      const num = Number(value);
      if (!Number.isFinite(num)) return fallback;
      return Math.min(max, Math.max(min, num));
    };
    const min = Number.isFinite(raw.min) ? Number(raw.min) : 10;
    const max = Number.isFinite(raw.max) ? Number(raw.max) : 250;
    const step = Number.isFinite(raw.step) && Number(raw.step) > 0 ? Number(raw.step) : 1;
    const value = clamp(raw.value, min, max, Math.max(min, Math.min(max, 100)));
    const randomEnabled = !!raw.randomEnabled;
    const strengthMin = Number.isFinite(raw.strengthMin) ? Number(raw.strengthMin) : 0;
    const strengthMax = Number.isFinite(raw.strengthMax) ? Number(raw.strengthMax) : 100;
    const strengthStep = Number.isFinite(raw.strengthStep) && Number(raw.strengthStep) > 0 ? Number(raw.strengthStep) : 1;
    const strength = clamp(raw.strength, strengthMin, strengthMax, strengthMin);
    const display = typeof raw.display === 'string' ? raw.display : `${Math.round(value)}%`;
    const strengthDisplay = typeof raw.strengthDisplay === 'string'
      ? raw.strengthDisplay
      : `±${Math.round(strength)}%`;
    const randomLabel = typeof raw.randomLabel === 'string' ? raw.randomLabel : 'Random';
    const randomTooltip = typeof raw.randomTooltip === 'string'
      ? raw.randomTooltip
      : (randomEnabled ? 'Disable random scale' : 'Enable random scale');
    const randomHint = typeof raw.randomHint === 'string' ? raw.randomHint : '';
    const randomButtonVisible = raw.randomButtonVisible !== undefined ? !!raw.randomButtonVisible : true;
    return {
      available: true,
      min,
      max,
      step,
      value,
      display,
      randomEnabled,
      strength,
      strengthMin,
      strengthMax,
      strengthStep,
      strengthDisplay,
      randomLabel,
      randomTooltip,
      randomHint,
      randomButtonVisible
    };
  }

  _prepareFillElevationContext(raw) {
    if (!raw || typeof raw !== 'object') return { available: false };
    const available = !!raw.available;
    if (!available) return { available: false };
    const coerceNumber = (value, fallback) => {
      const num = Number(value);
      return Number.isFinite(num) ? num : fallback;
    };
    const value = coerceNumber(raw.value, 0);
    return {
      available: true,
      label: typeof raw.label === 'string' && raw.label.length ? raw.label : 'Fill Elevation',
      min: coerceNumber(raw.min, -9999),
      max: coerceNumber(raw.max, 9999),
      step: coerceNumber(raw.step, 0.01),
      value,
      display: typeof raw.display === 'string' && raw.display.length ? raw.display : String(value),
      disabled: !!raw.disabled,
      hint: typeof raw.hint === 'string' ? raw.hint : ''
    };
  }

  _prepareRotationContext(raw) {
    if (!raw || typeof raw !== 'object' || !raw.available) {
      return { available: false };
    }
    const clamp = (value, min, max, fallback) => {
      const num = Number(value);
      if (!Number.isFinite(num)) return fallback;
      return Math.min(max, Math.max(min, num));
    };
    const min = Number.isFinite(raw.min) ? Number(raw.min) : 0;
    const max = Number.isFinite(raw.max) ? Number(raw.max) : 360;
    const step = Number.isFinite(raw.step) && Number(raw.step) > 0 ? Number(raw.step) : 1;
    const value = clamp(raw.value, min, max, min);
    const randomEnabled = !!raw.randomEnabled;
    const strengthMin = Number.isFinite(raw.strengthMin) ? Number(raw.strengthMin) : 0;
    const strengthMax = Number.isFinite(raw.strengthMax) ? Number(raw.strengthMax) : 180;
    const strengthStep = Number.isFinite(raw.strengthStep) && Number(raw.strengthStep) > 0 ? Number(raw.strengthStep) : 1;
    const strength = clamp(raw.strength, strengthMin, strengthMax, strengthMin);
    const display = typeof raw.display === 'string' ? raw.display : `${Math.round(value)}°`;
    const strengthDisplay = typeof raw.strengthDisplay === 'string'
      ? raw.strengthDisplay
      : (strength > 0 ? `±${Math.round(strength)}°` : '±0°');
    const randomLabel = typeof raw.randomLabel === 'string' ? raw.randomLabel : 'Random';
    const randomTooltip = typeof raw.randomTooltip === 'string'
      ? raw.randomTooltip
      : (randomEnabled ? 'Disable random rotation' : 'Enable random rotation');
    const randomHint = typeof raw.randomHint === 'string' ? raw.randomHint : '';
    const randomButtonVisible = raw.randomButtonVisible !== undefined ? !!raw.randomButtonVisible : true;
    return {
      available: true,
      min,
      max,
      step,
      value,
      display,
      randomEnabled,
      strength,
      strengthMin,
      strengthMax,
      strengthStep,
      strengthDisplay,
      randomLabel,
      randomTooltip,
      randomHint,
      randomButtonVisible
    };
  }

  _prepareTexturePaintContext(raw) {
    if (!raw || typeof raw !== 'object' || !raw.available) {
      return { available: false, opacity: { available: false } };
    }
    const coerceString = (value, fallback = '') => (typeof value === 'string' ? value : fallback);
    const coerceBool = (value) => !!value;
    const modes = Array.isArray(raw.modes)
      ? raw.modes.map((entry) => {
        const id = coerceString(entry?.id, '');
        if (!id) return null;
        return {
          id,
          label: coerceString(entry?.label, id),
          tooltip: coerceString(entry?.tooltip, ''),
          icon: coerceString(entry?.icon, ''),
          active: coerceBool(entry?.active),
          disabled: coerceBool(entry?.disabled)
        };
      }).filter(Boolean)
      : [];
    const actions = Array.isArray(raw.actions)
      ? raw.actions.map((entry) => {
        const id = coerceString(entry?.id, '');
        if (!id) return null;
        return {
          id,
          label: coerceString(entry?.label, id),
          tooltip: coerceString(entry?.tooltip, ''),
          primary: coerceBool(entry?.primary),
          disabled: coerceBool(entry?.disabled)
        };
      }).filter(Boolean)
      : [];
    const opacity = this._prepareTextureOpacityContext(raw.opacity);
    const activeModeLabel = (() => {
      const active = modes.find((mode) => mode.active);
      if (active) return active.label;
      return modes[0]?.label || 'Brush';
    })();
    return {
      available: true,
      modeLabel: coerceString(raw.modeLabel, activeModeLabel),
      status: coerceString(raw.status, ''),
      hint: coerceString(raw.hint, ''),
      modes,
      actions: actions.length ? actions : null,
      opacity
    };
  }

  _prepareTextureBrushContext(raw) {
    if (!raw || typeof raw !== 'object' || !raw.available) {
      return { available: false };
    }
    const clamp = (value, min, max, fallback) => {
      const num = Number(value);
      if (!Number.isFinite(num)) return fallback;
      return Math.min(max, Math.max(min, num));
    };
    const buildAxis = (axisRaw = {}, defaults = {}, formatDisplay) => {
      const minDefault = Number.isFinite(defaults.min) ? Number(defaults.min) : 0;
      const maxDefault = Number.isFinite(defaults.max) ? Number(defaults.max) : 100;
      const stepDefault = Number.isFinite(defaults.step) && Number(defaults.step) > 0 ? Number(defaults.step) : 1;
      const min = Number.isFinite(axisRaw.min) ? Number(axisRaw.min) : minDefault;
      const max = Number.isFinite(axisRaw.max) ? Number(axisRaw.max) : maxDefault;
      const step = Number.isFinite(axisRaw.step) && Number(axisRaw.step) > 0 ? Number(axisRaw.step) : stepDefault;
      const fallbackValue = Number.isFinite(defaults.value) ? Number(defaults.value) : min;
      const value = clamp(axisRaw.value, min, max, fallbackValue);
      const display = typeof axisRaw.display === 'string'
        ? axisRaw.display
        : (typeof formatDisplay === 'function' ? formatDisplay(value) : String(value));
      return {
        min,
        max,
        step,
        value,
        display,
        disabled: !!axisRaw.disabled || !!raw.disabled
      };
    };
    const brushSize = buildAxis(raw.brushSize, { min: 1, max: 2000, step: 1 }, (value) => `${Math.round(value)}px`);
    const particleSize = buildAxis(raw.particleSize, { min: 1, max: 100, step: 1 }, (value) => `${Math.round(value)}%`);
    const particleDensity = buildAxis(raw.particleDensity, { min: 1, max: 25, step: 1 }, (value) => `${Math.round(value)}`);
    const sprayDeviation = buildAxis(raw.sprayDeviation, { min: 0, max: 100, step: 1 }, (value) => `${Math.round(value)}%`);
    const spacing = buildAxis(raw.spacing, { min: 1, max: 200, step: 1 }, (value) => `${Math.round(value)}%`);
    return {
      available: true,
      disabled: !!raw.disabled,
      brushSize,
      particleSize,
      particleDensity,
      sprayDeviation,
      spacing,
      hint: typeof raw.hint === 'string' ? raw.hint : ''
    };
  }

  _prepareAssetScatterContext(raw) {
    if (!raw || typeof raw !== 'object' || !raw.available) {
      return { available: false };
    }
    const clamp = (value, min, max, fallback) => {
      const num = Number(value);
      if (!Number.isFinite(num)) return fallback;
      return Math.min(max, Math.max(min, num));
    };
    const buildAxis = (axisRaw = {}, defaults = {}, formatDisplay) => {
      const minDefault = Number.isFinite(defaults.min) ? Number(defaults.min) : 0;
      const maxDefault = Number.isFinite(defaults.max) ? Number(defaults.max) : 100;
      const stepDefault = Number.isFinite(defaults.step) && Number(defaults.step) > 0 ? Number(defaults.step) : 1;
      const min = Number.isFinite(axisRaw.min) ? Number(axisRaw.min) : minDefault;
      const max = Number.isFinite(axisRaw.max) ? Number(axisRaw.max) : maxDefault;
      const step = Number.isFinite(axisRaw.step) && Number(axisRaw.step) > 0 ? Number(axisRaw.step) : stepDefault;
      const fallbackValue = Number.isFinite(defaults.value) ? Number(defaults.value) : min;
      const value = clamp(axisRaw.value, min, max, fallbackValue);
      const display = typeof axisRaw.display === 'string'
        ? axisRaw.display
        : (typeof formatDisplay === 'function' ? formatDisplay(value) : String(value));
      return {
        min,
        max,
        step,
        value,
        display,
        disabled: !!axisRaw.disabled || !!raw.disabled
      };
    };
    const brushSize = buildAxis(raw.brushSize, { min: 1, max: 2400, step: 1 }, (value) => `${Math.round(value)}px`);
    const density = buildAxis(raw.density, { min: 1, max: 20, step: 1 }, (value) => `${Math.round(value)}`);
    const sprayDeviation = buildAxis(raw.sprayDeviation, { min: 0, max: 100, step: 1 }, (value) => `${Math.round(value)}%`);
    const spacing = buildAxis(raw.spacing, { min: 0, max: 200, step: 1 }, (value) => `${Math.round(value)}%`);
    return {
      available: true,
      disabled: !!raw.disabled,
      brushSize,
      density,
      sprayDeviation,
      spacing,
      hint: typeof raw.hint === 'string' ? raw.hint : ''
    };
  }

  _prepareHeightMapContext(raw, toggleList = [], heightBrush = { available: false }) {
    const base = raw && typeof raw === 'object' ? raw : {};
    const hasToggles = Array.isArray(toggleList) && toggleList.length > 0;
    const hasBrush = !!heightBrush?.available;
    return {
      available: hasToggles || hasBrush,
      collapsed: !!base.collapsed,
      disabled: !!base.disabled,
      hasToggles,
      toggles: toggleList
    };
  }

  _prepareHeightBrushContext(raw) {
    if (!raw || typeof raw !== 'object' || !raw.available) {
      return { available: false };
    }
    const clamp = (value, min, max, fallback) => {
      const num = Number(value);
      if (!Number.isFinite(num)) return fallback;
      return Math.min(max, Math.max(min, num));
    };
    const buildAxis = (axisRaw = {}, fallbackValue = 0) => {
      const min = Number.isFinite(axisRaw.min) ? Number(axisRaw.min) : 0;
      const max = Number.isFinite(axisRaw.max) ? Number(axisRaw.max) : 100;
      const step = Number.isFinite(axisRaw.step) && Number(axisRaw.step) > 0 ? Number(axisRaw.step) : 1;
      const value = clamp(axisRaw.value, min, max, fallbackValue);
      const display = typeof axisRaw.display === 'string' ? axisRaw.display : `${Math.round(value)}%`;
      return {
        min,
        max,
        step,
        value,
        display,
        disabled: !!axisRaw.disabled || !!raw.disabled
      };
    };
    const minAxis = buildAxis(raw.min, 0);
    const maxAxis = buildAxis(raw.max, 100);
    const contrastAxis = raw.contrast ? buildAxis(raw.contrast, 1) : null;
    const liftAxis = raw.lift ? buildAxis(raw.lift, 0) : null;
    return {
      available: true,
      label: typeof raw.label === 'string' ? raw.label : 'Height Threshold',
      hint: typeof raw.hint === 'string' ? raw.hint : '',
      min: minAxis,
      max: maxAxis,
      tuningLabel: typeof raw.tuningLabel === 'string' ? raw.tuningLabel : '',
      tuningHint: typeof raw.tuningHint === 'string' ? raw.tuningHint : '',
      contrast: contrastAxis,
      lift: liftAxis
    };
  }

  _prepareTextureOpacityContext(raw) {
    if (!raw || typeof raw !== 'object' || raw.available === false) {
      return { available: false };
    }
    const clamp = (value, min, max, fallback) => {
      const num = Number(value);
      if (!Number.isFinite(num)) return fallback;
      return Math.min(max, Math.max(min, num));
    };
    const min = Number.isFinite(raw.min) ? Number(raw.min) : 1;
    const max = Number.isFinite(raw.max) ? Number(raw.max) : 100;
    const step = Number.isFinite(raw.step) && Number(raw.step) > 0 ? Number(raw.step) : 1;
    const fallbackValue = Math.max(min, Math.min(max, 100));
    const value = clamp(raw.value, min, max, fallbackValue);
    const display = typeof raw.display === 'string' ? raw.display : `${Math.round(value)}%`;
    return {
      available: true,
      min,
      max,
      step,
      value,
      display,
      disabled: !!raw.disabled,
      hint: typeof raw.hint === 'string' ? raw.hint : ''
    };
  }

  _prepareTextureOffsetContext(raw) {
    if (!raw || typeof raw !== 'object' || !raw.available) {
      return { available: false };
    }
    const buildAxis = (axisRaw = {}) => {
      const min = Number.isFinite(axisRaw.min) ? Number(axisRaw.min) : -500;
      const max = Number.isFinite(axisRaw.max) ? Number(axisRaw.max) : 500;
      const step = Number.isFinite(axisRaw.step) && Number(axisRaw.step) > 0 ? Number(axisRaw.step) : 1;
      const value = Number.isFinite(axisRaw.value) ? Number(axisRaw.value) : 0;
      const display = typeof axisRaw.display === 'string' ? axisRaw.display : `${Math.round(value)} px`;
      return {
        min,
        max,
        step,
        value,
        display
      };
    };
    const disabled = !!raw.disabled;
    const hint = typeof raw.hint === 'string' ? raw.hint : '';
    const x = buildAxis(raw.x || {});
    const y = buildAxis(raw.y || {});
    return {
      available: true,
      hint,
      disabled,
      x: { ...x, disabled: !!(x.disabled || disabled) },
      y: { ...y, disabled: !!(y.disabled || disabled) }
    };
  }

  _prepareLayerOpacityContext(raw) {
    if (!raw || typeof raw !== 'object' || !raw.available) {
      return { available: false };
    }
    const min = Number.isFinite(raw.min) ? Number(raw.min) : 0;
    const max = Number.isFinite(raw.max) ? Number(raw.max) : 100;
    const step = Number.isFinite(raw.step) && Number(raw.step) > 0 ? Number(raw.step) : 1;
    const value = Number.isFinite(raw.value) ? Number(raw.value) : max;
    const display = typeof raw.display === 'string' ? raw.display : `${Math.round(value)}%`;
    return {
      available: true,
      min,
      max,
      step,
      value,
      display
    };
  }

  _preparePathFeatherContext(raw) {
    if (!raw || typeof raw !== 'object' || raw.available === false) {
      return { available: false };
    }
    const unitLabel = typeof raw.unitLabel === 'string' && raw.unitLabel.trim().length ? raw.unitLabel.trim() : 'grid';
    const hint = typeof raw.hint === 'string' ? raw.hint : '';
    const normalizeLength = (lengthRaw = {}) => {
      const min = Number.isFinite(lengthRaw.min) ? Number(lengthRaw.min) : 0;
      const max = Number.isFinite(lengthRaw.max) ? Number(lengthRaw.max) : 10;
      const step = Number.isFinite(lengthRaw.step) && Number(lengthRaw.step) > 0 ? Number(lengthRaw.step) : 0.1;
      const value = Number.isFinite(lengthRaw.value) ? Number(lengthRaw.value) : 0;
      const clamped = Math.min(max, Math.max(min, value));
      const display = typeof lengthRaw.display === 'string' ? lengthRaw.display : `${clamped.toFixed(2)} ${unitLabel}`;
      return {
        min,
        max,
        step,
        value: clamped,
        display,
        disabled: !!lengthRaw.disabled
      };
    };
    const normalizeEndpoint = (endpointRaw = {}) => {
      const enabled = !!endpointRaw.enabled;
      const length = normalizeLength(endpointRaw.length || {});
      return { enabled, length };
    };
    const start = normalizeEndpoint(raw.start);
    const end = normalizeEndpoint(raw.end);
    return {
      available: true,
      unitLabel,
      hint,
      start,
      end
    };
  }

  _prepareOpacityFeatherContext(raw) {
    if (!raw || typeof raw !== 'object' || raw.available === false) {
      return { available: false };
    }
    const unitLabel = typeof raw.unitLabel === 'string' && raw.unitLabel.trim().length ? raw.unitLabel.trim() : 'grid';
    const hint = typeof raw.hint === 'string' ? raw.hint : '';
    const normalizeEndpoint = (endpointRaw = {}) => {
      const enabled = !!endpointRaw.enabled;
      const lengthRaw = endpointRaw.length || {};
      const min = Number.isFinite(lengthRaw.min) ? Number(lengthRaw.min) : 0;
      const max = Number.isFinite(lengthRaw.max) ? Number(lengthRaw.max) : 10;
      const step = Number.isFinite(lengthRaw.step) && Number(lengthRaw.step) > 0 ? Number(lengthRaw.step) : 0.1;
      const value = Number.isFinite(lengthRaw.value) ? Number(lengthRaw.value) : 0;
      const clamped = Math.min(max, Math.max(min, value));
      const display = typeof lengthRaw.display === 'string' ? lengthRaw.display : `${clamped.toFixed(2)} ${unitLabel}`;
      return {
        enabled,
        length: {
          min,
          max,
          step,
          value: clamped,
          display,
          disabled: !!lengthRaw.disabled
        }
      };
    };
    const start = normalizeEndpoint(raw.start || {});
    const end = normalizeEndpoint(raw.end || {});
    return {
      available: true,
      unitLabel,
      hint,
      start,
      end
    };
  }

  _preparePathShadowContext(raw) {
    if (!raw || typeof raw !== 'object' || !raw.available) {
      return { available: false };
    }
    const coerceNumber = (value, fallback) => {
      const num = Number(value);
      return Number.isFinite(num) ? num : fallback;
    };
    const coerceString = (value, fallback = '') => (typeof value === 'string' ? value : fallback);
    const coerceBool = (value) => !!value;
    const normalizeSlider = (config = {}, defaults = {}) => ({
      min: coerceNumber(config.min, defaults.min ?? 0),
      max: coerceNumber(config.max, defaults.max ?? 1),
      step: coerceNumber(config.step, defaults.step ?? 0.1),
      value: coerceNumber(config.value, defaults.value ?? 0),
      display: coerceString(config.display, defaults.display ?? String(coerceNumber(config.value, defaults.value ?? 0))),
      disabled: coerceBool(config.disabled),
      hint: coerceString(config.hint, '')
    });
    const normalizePreset = (entry, index) => {
      const data = entry && typeof entry === 'object' ? entry : {};
      const saved = coerceBool(data.saved);
      const idx = Number.isInteger(data.index) ? Number(data.index) : index;
      const label = coerceString(data.label, String(index + 1));
      const baseTooltip = saved
        ? `Click to apply preset ${index + 1}.`
        : `Shift+Click to save preset ${index + 1}.`;
      const tooltip = coerceString(data.tooltip, baseTooltip);
      return {
        index: idx,
        label,
        saved,
        active: coerceBool(data.active),
        tooltip
      };
    };
    return {
      available: true,
      enabled: coerceBool(raw.enabled),
      disabled: coerceBool(raw.disabled),
      editMode: coerceBool(raw.editMode),
      editAvailable: raw.editAvailable !== false,
      editDisabled: coerceBool(raw.editDisabled),
      editReset: (() => {
        const resetRaw = raw.editReset && typeof raw.editReset === 'object' ? raw.editReset : null;
        if (!resetRaw) return null;
        return {
          disabled: coerceBool(resetRaw.disabled),
          tooltip: coerceString(resetRaw.tooltip, '')
        };
      })(),
      activePreset: Number.isInteger(raw.activePreset) ? Number(raw.activePreset) : -1,
      presets: Array.isArray(raw.presets) ? raw.presets.map((entry, index) => normalizePreset(entry, index)) : [],
      presetsHint: coerceString(raw.presetsHint, ''),
      reset: (() => {
        const resetRaw = raw.reset && typeof raw.reset === 'object' ? raw.reset : {};
        return {
          disabled: coerceBool(resetRaw.disabled),
          tooltip: coerceString(resetRaw.tooltip, '')
        };
      })(),
      context: (() => {
        const contextRaw = raw.context && typeof raw.context === 'object' ? raw.context : {};
        return {
          display: coerceString(contextRaw.display, '0'),
          note: coerceString(contextRaw.note, '')
        };
      })(),
      scale: normalizeSlider(raw.scale, {
        min: 10,
        max: 250,
        step: 1,
        value: 100,
        display: '100%',
        disabled: false
      }),
      offset: normalizeSlider(raw.offset, { min: 0, max: 0, step: 0.01, value: 0, display: '0' }),
      alpha: normalizeSlider(raw.alpha, { min: 0, max: 1, step: 0.01, value: 1, display: '100%' }),
      blur: normalizeSlider(raw.blur, { min: 0, max: 5, step: 0.1, value: 0, display: '0 px' }),
      dilation: normalizeSlider(raw.dilation, { min: 0, max: 5, step: 0.1, value: 0, display: '0 px' })
    };
  }

  _prepareDropShadowControls(raw, dropShadowState) {
    if (!raw || typeof raw !== 'object' || !raw.available) {
      return { available: false };
    }
    const disabled = !!raw.disabled || !!dropShadowState?.disabled;
    const coerceNumber = (value, fallback) => {
      const num = Number(value);
      if (!Number.isFinite(num)) return fallback;
      return num;
    };
    const coerceString = (val, fallback) => {
      if (val === undefined || val === null) return fallback;
      const str = String(val);
      return str.length ? str : fallback;
    };
    const coerceEntry = (entry, defaults) => {
      const data = entry && typeof entry === 'object' ? entry : {};
      const entryDisabled = disabled || !!data.disabled;
      return {
        label: coerceString(data.label, defaults.label),
        value: coerceString(data.value ?? defaults.value, defaults.value),
        min: coerceNumber(data.min, defaults.min),
        max: coerceNumber(data.max, defaults.max),
        step: coerceNumber(data.step, defaults.step),
        display: coerceString(data.display, defaults.display),
        hint: coerceString(data.hint, ''),
        disabled: entryDisabled
      };
    };
    const alpha = coerceEntry(raw.alpha, { label: 'Opacity', value: '65', min: 0, max: 100, step: 1, display: '65%' });
    const dilation = coerceEntry(raw.dilation, { label: 'Spread', value: '1.6', min: 0, max: 20, step: 0.1, display: '1.6 px' });
    const blur = coerceEntry(raw.blur, { label: 'Blur', value: '1.8', min: 0, max: 12, step: 0.1, display: '1.8 px' });
    const offsetRaw = raw.offset && typeof raw.offset === 'object' ? raw.offset : {};
    const offset = {
      distance: Number(offsetRaw.distance ?? 0) || 0,
      angle: Number(offsetRaw.angle ?? 0) || 0,
      maxDistance: Number(offsetRaw.maxDistance ?? 40) || 40,
      displayDistance: coerceString(offsetRaw.displayDistance, '0.0 px'),
      displayAngle: coerceString(offsetRaw.displayAngle, '0°'),
      hint: coerceString(offsetRaw.hint, ''),
      disabled
    };
    const collapsed = !!raw.collapsed;
    const presets = Array.isArray(raw.presets)
      ? raw.presets.map((entry, index) => {
        const data = entry && typeof entry === 'object' ? entry : {};
        return {
          index,
          label: coerceString(data.label, String(index + 1)),
          saved: !!data.saved,
          active: !!data.active,
          tooltip: coerceString(data.tooltip, data.saved ? `Click to apply preset ${index + 1}.` : `Shift+Click to save preset ${index + 1}.`)
        };
      })
      : [];
    const contextRaw = raw.context && typeof raw.context === 'object' ? raw.context : {};
    const context = {
      display: coerceString(contextRaw.display, ''),
      status: coerceString(contextRaw.status, ''),
      note: coerceString(contextRaw.note, ''),
      tileCount: coerceNumber(contextRaw.tileCount, 0) || 0,
      hasTiles: !!contextRaw.hasTiles,
      source: coerceString(contextRaw.source, '')
    };
    return {
      available: true,
      disabled,
      collapsed,
      presets,
      alpha,
      dilation,
      blur,
      offset,
      context
    };
  }

  setPosition(position) {
    const result = super.setPosition(position);
    // Update saved height when position changes (including user resizes)
    if (position?.height && Number.isFinite(position.height)) {
      this._savedHeight = position.height;
    }
    this._persistWindowPosition();
    return result;
  }

  _preparePathAppearanceContext(raw) {
    const data = raw && typeof raw === 'object' ? raw : {};
    const layerOpacity = this._prepareLayerOpacityContext(data.layerOpacity);
    const textureOffset = this._prepareTextureOffsetContext(data.textureOffset);
    const scale = this._preparePathScaleContext(data.scale);
    const tension = this._preparePathTensionContext(data.tension);
    const freehandSimplify = this._prepareFreehandSimplifyContext(data.freehandSimplify);
    const showWidthTangents = this._prepareShowWidthTangentsContext(data.showWidthTangents);
    const hint = typeof data.hint === 'string' ? data.hint : '';
    return {
      available: !!(layerOpacity.available || textureOffset.available || scale.available || tension.available || freehandSimplify.available || showWidthTangents.available),
      hint,
      layerOpacity,
      textureOffset,
      scale,
      tension,
      freehandSimplify,
      showWidthTangents
    };
  }

  _prepareShowWidthTangentsContext(raw) {
    if (!raw || typeof raw !== 'object' || !raw.available) return { available: false };
    return {
      available: true,
      enabled: !!raw.enabled,
      label: typeof raw.label === 'string' ? raw.label : 'Show Width Tangents',
      tooltip: typeof raw.tooltip === 'string' ? raw.tooltip : 'Display width adjustment handles.',
      disabled: !!raw.disabled
    };
  }

  _preparePathScaleContext(raw) {
    if (!raw || typeof raw !== 'object' || !raw.available) return { available: false };
    const value = Number(raw.value ?? 100);
    const min = Number(raw.min ?? 10);
    const max = Number(raw.max ?? 250);
    const step = Number(raw.step ?? 1);
    const disabled = !!raw.disabled;
    const display = typeof raw.display === 'string' ? raw.display : `${Math.round(value)}%`;
    return {
      available: true,
      min,
      max,
      step,
      value,
      display,
      disabled
    };
  }

  _preparePathTensionContext(raw) {
    if (!raw || typeof raw !== 'object' || !raw.available) return { available: false };
    const value = Number(raw.value ?? 0);
    const min = Number(raw.min ?? 0);
    const max = Number(raw.max ?? 1);
    const step = Number(raw.step ?? 0.01);
    const disabled = !!raw.disabled;
    const display = typeof raw.display === 'string' ? raw.display : value.toFixed(2);
    return {
      available: true,
      min,
      max,
      step,
      value,
      display,
      disabled
    };
  }

  _prepareFreehandSimplifyContext(raw) {
    if (!raw || typeof raw !== 'object' || !raw.available) return { available: false };
    const value = Number(raw.value ?? 0);
    const min = Number(raw.min ?? 0);
    const max = Number(raw.max ?? 1);
    const step = Number(raw.step ?? 0.01);
    const disabled = !!raw.disabled;
    const display = typeof raw.display === 'string' ? raw.display : value.toFixed(2);
    const hint = typeof raw.hint === 'string' ? raw.hint : '';
    return {
      available: true,
      min,
      max,
      step,
      value,
      display,
      hint,
      disabled
    };
  }

  _onRender(initial, ctx) {
    super._onRender(initial, ctx);
    this._syncWindowTitle();
    try {
      const root = this.element;
      root?.classList?.add('fa-nexus-tool-options-root');
      if (root) root.dataset.faNexusToolOverlay = 'true';
    } catch (_) {}
    this._bindControls();
    this._ensurePlaceAsNamingSection();
    this._restoreContentStyle();
    this._restoreScrollState();
    if (initial) {
      this._restoreWindowPosition();
      this._setupResizeObserver();
    }
    this._resetScrollNextRender = false;
  }

  _onClose(options = {}) {
    this._cleanupResizeObserver();
    this._persistWindowPosition();
    this._unbindControls();
    if (this._placeAsNamingRerenderJob) {
      clearTimeout(this._placeAsNamingRerenderJob);
      this._placeAsNamingRerenderJob = null;
    }
    this._placeAsNamingRerenderRevision = null;
    this._placeAsNamingRerenderCount = 0;
    this._pendingScrollState = null;
    this._pendingContentStyle = null;
    this._resetScrollNextRender = false;
    try { this._controller?._handleWindowClosed(this); } catch (_) {}
    super._onClose(options);
  }

  _ensurePlaceAsNamingSection() {
    const naming = this._toolOptionState?.placeAs?.naming || {};
    if (!naming?.available) return;
    const root = this.element;
    if (!root) return;
    const hasToggle = !!(
      root.querySelector('[data-place-as-append-number]')
      || root.querySelector('[data-place-as-prepend-adjective]')
      || root.querySelector('.fa-nexus-place-as__naming')
    );
    if (hasToggle) return;

    // The tool state can update while a render is in-flight, leaving the DOM in an older layout.
    // If the state expects the naming section but the DOM doesn't have it, force a follow-up render.
    const revision = this._toolOptionState?.layoutRevision ?? null;
    if (revision !== this._placeAsNamingRerenderRevision) {
      this._placeAsNamingRerenderRevision = revision;
      this._placeAsNamingRerenderCount = 0;
    }
    if (this._placeAsNamingRerenderCount >= 2) return;
    if (this._placeAsNamingRerenderJob) return;
    this._placeAsNamingRerenderCount += 1;
    this._placeAsNamingRerenderJob = setTimeout(() => {
      this._placeAsNamingRerenderJob = null;
      try {
        if (this.rendered) this.render(false);
      } catch (_) {}
    }, 0);
  }

  _measureScrollState() {
    try {
      const container = this._getScrollContainer();
      if (!container) return null;
      return {
        top: Number(container.scrollTop) || 0,
        left: Number(container.scrollLeft) || 0
      };
    } catch (_) {
      return null;
    }
  }

  _restoreScrollState() {
    const container = this._getScrollContainer();
    if (!container) {
      this._pendingScrollState = null;
      return;
    }
    const state = this._pendingScrollState;
    if (state && typeof state === 'object') {
      if (Number.isFinite(state.top)) container.scrollTop = state.top;
      if (Number.isFinite(state.left)) container.scrollLeft = state.left;
    } else if (this._resetScrollNextRender) {
      container.scrollTop = 0;
      container.scrollLeft = 0;
    }
    this._pendingScrollState = null;
  }

  _getScrollContainer() {
    const root = this.element;
    if (!root) return null;
    return (
      root.querySelector('[data-fa-nexus-scroll-container]')
      || root.querySelector('.fa-nexus-tool-options__content')
      || root.querySelector('.fa-nexus-tool-options')
      || root.querySelector('.window-content')
      || root
    );
  }

  _measureContentStyle() {
    try {
      const content = this.element?.querySelector('.window-content');
      if (!content) return null;
      return content.getAttribute('style') ?? '';
    } catch (_) {
      return null;
    }
  }

  _restoreContentStyle() {
    const style = this._pendingContentStyle;
    this._pendingContentStyle = null;
    if (style === null || style === undefined) return;
    const content = this.element?.querySelector('.window-content');
    if (!content) return;
    if (style === '') content.removeAttribute('style');
    else content.setAttribute('style', style);
  }

  _bindDisplayInput(display, inputHandler, commitHandler) {
    if (!display || display.tagName !== 'INPUT') return;
    const isNumberInput = display.type === 'number';
    if (inputHandler && !isNumberInput) display.addEventListener('input', inputHandler);
    if (commitHandler) {
      display.addEventListener('change', commitHandler);
      if (isNumberInput) {
        const existingHandler = display._faNexusCommitKeydown;
        if (existingHandler) {
          try { display.removeEventListener('keydown', existingHandler); } catch (_) {}
        }
        const keydownHandler = (event) => {
          if (event.key !== 'Enter') return;
          event.preventDefault();
          commitHandler(event);
        };
        display.addEventListener('keydown', keydownHandler);
        display._faNexusCommitKeydown = keydownHandler;
      }
    }
  }

  _unbindDisplayInput(display, inputHandler, commitHandler) {
    if (!display || display.tagName !== 'INPUT') return;
    if (inputHandler) {
      try { display.removeEventListener('input', inputHandler); } catch (_) {}
    }
    if (commitHandler) {
      try { display.removeEventListener('change', commitHandler); } catch (_) {}
    }
    const keydownHandler = display._faNexusCommitKeydown;
    if (keydownHandler) {
      try { display.removeEventListener('keydown', keydownHandler); } catch (_) {}
      try { delete display._faNexusCommitKeydown; } catch (_) {}
    }
  }

  _applyDefaultValue(target, value) {
    if (!target || typeof target.setAttribute !== 'function') return;
    const hasValue = value !== undefined && value !== null && value !== '';
    if (!hasValue || (typeof value === 'number' && !Number.isFinite(value))) {
      try { target.removeAttribute('data-fa-nexus-default-value'); } catch (_) {}
      return;
    }
    try { target.setAttribute('data-fa-nexus-default-value', String(value)); } catch (_) {}
  }

  _inferStepDecimals(step) {
    const numeric = Number(step);
    if (!Number.isFinite(numeric) || numeric <= 0) return null;
    if (numeric >= 1) return 0;
    const text = String(step);
    const dot = text.indexOf('.');
    if (dot === -1) return 0;
    const decimals = text.length - dot - 1;
    return decimals > 0 ? decimals : 0;
  }

  _normalizeNumericInputValue(value, step) {
    if (value === '' || value === null || value === undefined) return value;
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return value;
    const decimals = this._inferStepDecimals(step);
    if (decimals === null) return numeric;
    return Number(numeric.toFixed(decimals));
  }

  _syncDisplayValue(display, data = {}, { disabled = false } = {}) {
    if (!display) return;
    const text = data.display || '';
    if (display.tagName === 'INPUT') {
      const isFocused = (typeof document !== 'undefined' && document.activeElement === display);
      const rawValue = data.value ?? '';
      const normalizedValue = (display.type === 'number')
        ? this._normalizeNumericInputValue(rawValue, data.step ?? display.step)
        : rawValue;
      const nextValue = normalizedValue === null || normalizedValue === undefined ? '' : String(normalizedValue);
      if (!isFocused && display.value !== nextValue) display.value = nextValue;
      if (data.min !== undefined) display.min = String(data.min);
      if (data.max !== undefined) display.max = String(data.max);
      if (data.step !== undefined) display.step = String(data.step);
      this._applyDefaultValue(display, data.defaultValue);
      display.disabled = !!data.disabled || !!disabled;
      if (text) display.title = text;
      else display.removeAttribute('title');
    } else if (display.textContent !== text) {
      display.textContent = text;
    }
  }

  _bindControls() {
    this._unbindControls();
    try {
      const root = this.element;
      if (!root) return;
      root.addEventListener('contextmenu', this._boundResettableContext);
      root.addEventListener('wheel', this._boundSliderWheel, { passive: false });
      this._resettableContextRoot = root;
      this._sliderWheelRoot = root;
      const gridToggle = root.querySelector('#fa-nexus-grid-snap-toggle');
      if (gridToggle) {
        gridToggle.checked = !!this._gridSnapEnabled;
        const controllerAllows = this._controller?.isGridSnapSettingAvailable?.();
        const canToggle = this._gridSnapAvailable && (controllerAllows !== false);
        gridToggle.disabled = !canToggle;
        gridToggle.addEventListener('change', this._boundGridSnapChange);
        this._gridSnapToggle = gridToggle;
      }
      this._bindGridSnapResolutionControl();
      const dropToggle = root.querySelector('#fa-nexus-drop-shadow-toggle');
      if (dropToggle) {
        const dropState = this._toolOptionState?.dropShadow || {};
        dropToggle.checked = !!dropState.enabled;
        dropToggle.disabled = !!dropState.disabled;
        dropToggle.addEventListener('change', this._boundDropShadowChange);
        this._dropShadowToggle = dropToggle;
      }
      this._bindDropShadowControls();
      this._bindTextureToolControls();
      this._bindEditorActions();
      this._bindTextureOpacityControl();
      this._bindTextureBrushControls();
      this._bindAssetScatterControls();
      this._bindHeightMapControls();
      this._bindHeightBrushControls();
      this._bindTextureLayerControl();
      this._bindTextureOffsetControls();
      this._bindPathAppearanceControls();
      this._bindFillElevationControl();
      this._bindFillTextureControls();
      this._bindFlipControls();
      this._bindScaleControls();
      this._bindRotationControls();
      this._bindPathShadowControls();
      this._bindPathFeatherControls();
      this._bindOpacityFeatherControls();
      this._bindCustomToggles();
      this._bindPlacementControls();
      this._syncDoorControls();
      this._syncWindowControls();
      this._bindShortcutsControls();
      const placeAsToggle = root.querySelector('[data-place-as-toggle]');
      if (placeAsToggle) {
        placeAsToggle.addEventListener('click', this._boundPlaceAsToggle);
        this._placeAsToggleButton = placeAsToggle;
      }
      const placeAsFilter = root.querySelector('[data-place-as-filter]');
      if (placeAsFilter) {
        placeAsFilter.addEventListener('click', this._boundPlaceAsFilter);
        this._placeAsFilterButton = placeAsFilter;
      }
      const placeAsSearch = root.querySelector('#fa-nexus-place-as-search');
      if (placeAsSearch) {
        placeAsSearch.addEventListener('input', this._boundPlaceAsSearch);
        this._placeAsSearchInput = placeAsSearch;
      }
      const placeAsList = root.querySelector('[data-fa-nexus-place-as-list]');
      if (placeAsList) {
        placeAsList.addEventListener('click', this._boundPlaceAsOptionClick);
        this._placeAsList = placeAsList;
      }
      const placeAsLinked = root.querySelector('[data-place-as-linked]');
      if (placeAsLinked) {
        placeAsLinked.addEventListener('change', this._boundPlaceAsLinkedChange);
        this._placeAsLinkedToggle = placeAsLinked;
      }
      const placeAsAppendNumber = root.querySelector('[data-place-as-append-number]');
      if (placeAsAppendNumber) {
        placeAsAppendNumber.addEventListener('change', this._boundPlaceAsAppendNumberChange);
        this._placeAsAppendNumberToggle = placeAsAppendNumber;
      }
      const placeAsPrependAdjective = root.querySelector('[data-place-as-prepend-adjective]');
      if (placeAsPrependAdjective) {
        placeAsPrependAdjective.addEventListener('change', this._boundPlaceAsPrependAdjectiveChange);
        this._placeAsPrependAdjectiveToggle = placeAsPrependAdjective;
      }
      const hpMode = root.querySelector('[data-place-as-hp-mode]');
      if (hpMode) {
        hpMode.addEventListener('change', this._boundPlaceAsHpMode);
        this._placeAsHpModeSelect = hpMode;
      }
      const hpPercent = root.querySelector('[data-place-as-hp-percent]');
      if (hpPercent) {
        hpPercent.addEventListener('input', this._boundPlaceAsHpPercent);
        this._placeAsHpPercentInput = hpPercent;
      }
      const hpStatic = root.querySelector('[data-place-as-hp-static]');
      if (hpStatic) {
        hpStatic.addEventListener('input', this._boundPlaceAsHpStatic);
        this._placeAsHpStaticInput = hpStatic;
      }
      this._placeAsHpModeHint = root.querySelector('[data-place-as-hp-mode-hint]');
      this._placeAsHpPercentHint = root.querySelector('[data-place-as-hp-percent-hint]');
      this._placeAsHpStaticHint = root.querySelector('[data-place-as-hp-static-hint]');
      this._placeAsHpStaticError = root.querySelector('[data-place-as-hp-static-error]');
      this._placeAsHpPercentRow = root.querySelector('[data-place-as-hp-percent-row]');
      this._placeAsHpStaticRow = root.querySelector('[data-place-as-hp-static-row]');
      this._syncPlaceAsControls();
    } catch (_) {}
  }

  _unbindControls() {
    if (this._resettableContextRoot) {
      try { this._resettableContextRoot.removeEventListener('contextmenu', this._boundResettableContext); }
      catch (_) {}
      this._resettableContextRoot = null;
    }
    if (this._sliderWheelRoot) {
      try { this._sliderWheelRoot.removeEventListener('wheel', this._boundSliderWheel); } catch (_) {}
      this._sliderWheelRoot = null;
    }
    if (this._gridSnapToggle) {
      try { this._gridSnapToggle.removeEventListener('change', this._boundGridSnapChange); }
      catch (_) {}
      this._gridSnapToggle = null;
    }
    this._unbindGridSnapResolutionControl();
    if (this._dropShadowToggle) {
      try { this._dropShadowToggle.removeEventListener('change', this._boundDropShadowChange); }
      catch (_) {}
      this._dropShadowToggle = null;
    }
    this._unbindDropShadowControls();
    this._unbindTextureToolControls();
    this._unbindEditorActions();
    this._unbindTextureOpacityControl();
    this._unbindTextureBrushControls();
    this._unbindAssetScatterControls();
    this._unbindHeightMapControls();
    this._unbindHeightBrushControls();
    this._unbindTextureLayerControl();
    this._unbindTextureOffsetControls();
    this._unbindPathAppearanceControls();
    this._unbindFillElevationControl();
    this._unbindFillTextureControls();
    this._unbindFlipControls();
    this._unbindScaleControls();
    this._unbindRotationControls();
    this._unbindPathShadowControls();
    this._unbindPathFeatherControls();
    this._unbindOpacityFeatherControls();
    this._unbindPlacementControls();
    this._unbindShortcutsControls();
    if (this._customToggleBindings?.size) {
      for (const [toggle, handler] of this._customToggleBindings.entries()) {
        try { toggle.removeEventListener('change', handler); } catch (_) {}
      }
      this._customToggleBindings.clear();
    }
    if (this._placeAsToggleButton) {
      try { this._placeAsToggleButton.removeEventListener('click', this._boundPlaceAsToggle); }
      catch (_) {}
      this._placeAsToggleButton = null;
    }
    if (this._placeAsFilterButton) {
      try { this._placeAsFilterButton.removeEventListener('click', this._boundPlaceAsFilter); }
      catch (_) {}
      this._placeAsFilterButton = null;
    }
    if (this._placeAsSearchInput) {
      try { this._placeAsSearchInput.removeEventListener('input', this._boundPlaceAsSearch); }
      catch (_) {}
      this._placeAsSearchInput = null;
    }
    if (this._placeAsList) {
      try { this._placeAsList.removeEventListener('click', this._boundPlaceAsOptionClick); }
      catch (_) {}
      this._placeAsList = null;
    }
    if (this._placeAsLinkedToggle) {
      try { this._placeAsLinkedToggle.removeEventListener('change', this._boundPlaceAsLinkedChange); }
      catch (_) {}
      this._placeAsLinkedToggle = null;
    }
    if (this._placeAsAppendNumberToggle) {
      try { this._placeAsAppendNumberToggle.removeEventListener('change', this._boundPlaceAsAppendNumberChange); }
      catch (_) {}
      this._placeAsAppendNumberToggle = null;
    }
    if (this._placeAsPrependAdjectiveToggle) {
      try { this._placeAsPrependAdjectiveToggle.removeEventListener('change', this._boundPlaceAsPrependAdjectiveChange); }
      catch (_) {}
      this._placeAsPrependAdjectiveToggle = null;
    }
    if (this._placeAsHpModeSelect) {
      try { this._placeAsHpModeSelect.removeEventListener('change', this._boundPlaceAsHpMode); }
      catch (_) {}
      this._placeAsHpModeSelect = null;
    }
    if (this._placeAsHpPercentInput) {
      try { this._placeAsHpPercentInput.removeEventListener('input', this._boundPlaceAsHpPercent); }
      catch (_) {}
      this._placeAsHpPercentInput = null;
    }
    if (this._placeAsHpStaticInput) {
      try { this._placeAsHpStaticInput.removeEventListener('input', this._boundPlaceAsHpStatic); }
      catch (_) {}
      this._placeAsHpStaticInput = null;
    }
    this._placeAsHpModeHint = null;
    this._placeAsHpPercentHint = null;
    this._placeAsHpStaticHint = null;
    this._placeAsHpStaticError = null;
    this._placeAsHpPercentRow = null;
    this._placeAsHpStaticRow = null;
  }

  _handleResettableContext(event) {
    if (!event || event.defaultPrevented) return;
    const target = event.target;
    if (!target || typeof target.closest !== 'function') return;
    const input = target.closest('input[type="range"], input[type="number"]');
    if (!input || input.disabled) return;
    const defaultValue = input.dataset?.faNexusDefaultValue;
    if (defaultValue === undefined || defaultValue === null || defaultValue === '') return;
    event.preventDefault();
    event.stopPropagation();
    if (input.value !== String(defaultValue)) {
      input.value = String(defaultValue);
    }
    try {
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    } catch (_) {}
  }

  _handleSliderWheel(event) {
    if (!event || event.defaultPrevented) return;
    const target = event.target;
    if (!target || typeof target.closest !== 'function') return;
    const slider = target.closest('input[type="range"]');
    if (!slider || slider.disabled) return;
    if (typeof slider.matches === 'function' && slider.matches('[data-fa-nexus-grid-snap-slider]')) return;
    if (event.ctrlKey) {
      const delta = Number(event.deltaY) || Number(event.deltaX) || 0;
      if (!delta) return;
      const min = Number(slider.min ?? 0);
      const max = Number(slider.max ?? 0);
      let step = Number(slider.step ?? 1);
      if (!Number.isFinite(step) || step <= 0) step = 1;
      const direction = delta < 0 ? 1 : -1;
      const current = Number(slider.value);
      const base = Number.isFinite(current) ? current : min;
      let next = base + (step * direction);
      const clampMin = Number.isFinite(min) ? min : 0;
      const clampMax = Number.isFinite(max) ? max : clampMin;
      next = Math.min(clampMax, Math.max(clampMin, next));
      const decimals = this._inferStepDecimals(step);
      if (decimals !== null) next = Number(next.toFixed(decimals));
      if (next !== base) {
        slider.value = String(next);
        try { slider.dispatchEvent(new Event('input', { bubbles: true })); } catch (_) {}
      }
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    const container = this._getScrollContainer();
    if (container) {
      const deltaY = Number(event.deltaY) || 0;
      const deltaX = Number(event.deltaX) || 0;
      if (deltaY) container.scrollTop += deltaY;
      if (deltaX) container.scrollLeft += deltaX;
    }
    event.preventDefault();
    event.stopPropagation();
  }

  _handleGridSnapChange(event) {
    const target = event?.currentTarget || event?.target;
    if (!target) return;
    target.indeterminate = false;
    const next = !!target.checked;
    const controller = this._controller;
    if (!controller?.requestGridSnapToggle) {
      this.setGridSnapEnabled(next);
      return;
    }
    try {
      const result = controller.requestGridSnapToggle(next);
      if (result?.then) {
        result.then((success) => {
          if (!success) target.checked = !!this._gridSnapEnabled;
        }).catch(() => {
          target.checked = !!this._gridSnapEnabled;
        });
      } else if (result === false) {
        target.checked = !!this._gridSnapEnabled;
      }
    } catch (_) {
      target.checked = !!this._gridSnapEnabled;
    }
  }

  _handleDropShadowChange(event) {
    const target = event?.currentTarget || event?.target;
    if (!target) return;
    const next = !!target.checked;
    const controller = this._controller;
    if (!controller?.requestDropShadowToggle) {
      target.checked = !!this._toolOptionState?.dropShadow?.enabled;
      return;
    }
    try {
      const result = controller.requestDropShadowToggle(next);
      if (result?.then) {
        result.then((success) => {
          if (!success) target.checked = !!this._toolOptionState?.dropShadow?.enabled;
        }).catch(() => {
          target.checked = !!this._toolOptionState?.dropShadow?.enabled;
        });
      } else if (result === false) {
        target.checked = !!this._toolOptionState?.dropShadow?.enabled;
      }
    } catch (_) {
      target.checked = !!this._toolOptionState?.dropShadow?.enabled;
    }
  }

  setGridSnapEnabled(enabled) {
    const next = !!enabled;
    if (this._gridSnapEnabled === next) return;
    this._gridSnapEnabled = next;
    this._syncGridSnapControl();
  }

  setGridSnapAvailable(available) {
    const next = !!available;
    if (this._gridSnapAvailable === next) return;
    this._gridSnapAvailable = next;
    this._syncGridSnapControl();
  }

  _syncGridSnapControl() {
    const toggle = this._gridSnapToggle;
    if (!toggle) return;
    toggle.checked = !!this._gridSnapEnabled;
    const controllerAllows = this._controller?.isGridSnapSettingAvailable?.();
    const canToggle = this._gridSnapAvailable && (controllerAllows !== false);
    toggle.disabled = !canToggle;
    this._syncGridSnapResolutionControl();
  }

  _normalizeGridSnapSubdivision(value) {
    return normalizeGridSnapSubdivision(value);
  }

  _formatGridSnapResolutionDisplay(value) {
    return formatGridSnapSubdivisionLabel(value);
  }

  _syncGridSnapResolutionControl() {
    const root = this._gridSnapResolutionRoot;
    if (!root) return;
    const slider = this._gridSnapResolutionSlider;
    const display = this._gridSnapResolutionDisplay;
    const controllerAllows = this._controller?.isGridSnapSettingAvailable?.();
    const available = this._gridSnapAvailable && (controllerAllows !== false);
    root.classList.toggle('is-disabled', !available);
    if (slider) {
      slider.disabled = !available;
      slider.value = String(this._gridSnapSubdivisions);
    }
    if (display) {
      this._syncDisplayValue(display, {
        min: slider?.min,
        max: slider?.max,
        step: slider?.step,
        value: this._gridSnapSubdivisions,
        display: this._formatGridSnapResolutionDisplay(this._gridSnapSubdivisions),
        disabled: !available
      }, { disabled: !available });
    }
  }

  _bindGridSnapResolutionControl() {
    const root = this.element?.querySelector('[data-fa-nexus-grid-snap-root]');
    if (!root) {
      this._unbindGridSnapResolutionControl();
      return;
    }
    this._gridSnapResolutionRoot = root;
    const slider = root.querySelector('[data-fa-nexus-grid-snap-slider]');
    this._gridSnapResolutionSlider = slider || null;
    this._gridSnapResolutionDisplay = root.querySelector('[data-fa-nexus-grid-snap-display]') || null;
    if (slider) {
      slider.value = String(this._gridSnapSubdivisions);
      slider.addEventListener('input', this._boundGridSnapResolutionInput);
      slider.addEventListener('change', this._boundGridSnapResolutionCommit);
    }
    this._bindDisplayInput(this._gridSnapResolutionDisplay, this._boundGridSnapResolutionInput, this._boundGridSnapResolutionCommit);
    this._syncGridSnapResolutionControl();
  }

  _unbindGridSnapResolutionControl() {
    if (this._gridSnapResolutionSlider) {
      try {
        this._gridSnapResolutionSlider.removeEventListener('input', this._boundGridSnapResolutionInput);
        this._gridSnapResolutionSlider.removeEventListener('change', this._boundGridSnapResolutionCommit);
      } catch (_) {}
    }
    this._unbindDisplayInput(this._gridSnapResolutionDisplay, this._boundGridSnapResolutionInput, this._boundGridSnapResolutionCommit);
    this._gridSnapResolutionSlider = null;
    this._gridSnapResolutionDisplay = null;
    this._gridSnapResolutionRoot = null;
  }

  _handleGridSnapResolutionInput(event, commit) {
    const target = event?.currentTarget || event?.target;
    if (!target) return;
    const value = this._normalizeGridSnapSubdivision(target.value);
    this._gridSnapSubdivisions = value;
    if (this._gridSnapResolutionDisplay) {
      this._syncDisplayValue(this._gridSnapResolutionDisplay, {
        value,
        display: this._formatGridSnapResolutionDisplay(value)
      });
    }
    if (!commit) return;
    const controller = this._controller;
    if (!controller?.requestGridSnapSubdivisionChange) return;
    try {
      const result = controller.requestGridSnapSubdivisionChange(value);
      if (result?.then) {
        result.catch(() => this._resetGridSnapResolutionControl());
      } else if (result === false) {
        this._resetGridSnapResolutionControl();
      }
    } catch (_) {
      this._resetGridSnapResolutionControl();
    }
  }

  _resetGridSnapResolutionControl() {
    const controllerValue = this._controller?.getGridSnapSubdivisions?.();
    if (controllerValue === undefined || controllerValue === null) return;
    this._gridSnapSubdivisions = this._normalizeGridSnapSubdivision(controllerValue);
    if (this._gridSnapResolutionSlider) {
      this._gridSnapResolutionSlider.value = String(this._gridSnapSubdivisions);
    }
    if (this._gridSnapResolutionDisplay) {
      this._syncDisplayValue(this._gridSnapResolutionDisplay, {
        value: this._gridSnapSubdivisions,
        display: this._formatGridSnapResolutionDisplay(this._gridSnapSubdivisions)
      });
    }
  }

  setGridSnapSubdivisions(value) {
    const normalized = this._normalizeGridSnapSubdivision(value);
    if (this._gridSnapSubdivisions === normalized) return;
    this._gridSnapSubdivisions = normalized;
    this._syncGridSnapResolutionControl();
  }

  _syncDropShadowControl() {
    const toggle = this._dropShadowToggle;
    if (!toggle) return;
    const dropState = this._toolOptionState?.dropShadow || {};
    toggle.checked = !!dropState.enabled;
    toggle.disabled = !!dropState.disabled;
  }

  _bindDropShadowControls() {
    const root = this.element?.querySelector('[data-fa-nexus-drop-shadow-root]') || null;
    if (!root) {
      this._unbindDropShadowControls();
      return;
    }
    this._dropShadowRoot = root;
    this._dropShadowAlphaDisplay = root.querySelector('[data-fa-nexus-drop-shadow-alpha-display]') || null;
    this._dropShadowDilationDisplay = root.querySelector('[data-fa-nexus-drop-shadow-dilation-display]') || null;
    this._dropShadowBlurDisplay = root.querySelector('[data-fa-nexus-drop-shadow-blur-display]') || null;
    this._dropShadowOffsetDistanceDisplay = root.querySelector('[data-fa-nexus-drop-shadow-offset-distance-display]') || null;
    this._dropShadowOffsetAngleDisplay = root.querySelector('[data-fa-nexus-drop-shadow-offset-angle-display]') || null;
    this._dropShadowElevationDisplay = root.querySelector('[data-fa-nexus-drop-shadow-elevation]') || null;
    this._dropShadowStatusDisplay = root.querySelector('[data-fa-nexus-drop-shadow-status]') || null;
    this._dropShadowNoteDisplay = root.querySelector('[data-fa-nexus-drop-shadow-note]') || null;
    this._dropShadowCollapseButton = root.querySelector('[data-fa-nexus-drop-shadow-toggle]') || null;
    if (this._dropShadowCollapseButton) {
      this._dropShadowCollapseButton.addEventListener('click', this._boundDropShadowCollapse);
    }
    this._dropShadowBody = root.querySelector('[data-fa-nexus-drop-shadow-body]') || null;
    this._dropShadowPresetsRoot = root.querySelector('[data-fa-nexus-drop-shadow-presets]') || null;
    if (this._dropShadowPresetsRoot) {
      this._dropShadowPresetButtons = Array.from(this._dropShadowPresetsRoot.querySelectorAll('[data-fa-nexus-drop-shadow-preset]'));
      for (const button of this._dropShadowPresetButtons) {
        button.addEventListener('click', this._boundDropShadowPresetClick);
        button.addEventListener('contextmenu', this._boundDropShadowPresetContext);
      }
    } else {
      this._dropShadowPresetButtons = [];
    }
    this._dropShadowResetButton = root.querySelector('[data-fa-nexus-drop-shadow-reset]') || null;
    if (this._dropShadowResetButton) {
      this._dropShadowResetButton.addEventListener('click', this._boundDropShadowReset);
    }

    const alphaSlider = root.querySelector('[data-fa-nexus-drop-shadow-alpha]');
    if (alphaSlider) {
      alphaSlider.addEventListener('input', this._boundDropShadowAlphaInput);
      alphaSlider.addEventListener('change', this._boundDropShadowAlphaCommit);
      this._dropShadowAlphaSlider = alphaSlider;
    }
    this._bindDisplayInput(this._dropShadowAlphaDisplay, this._boundDropShadowAlphaInput, this._boundDropShadowAlphaCommit);
    const dilationSlider = root.querySelector('[data-fa-nexus-drop-shadow-dilation]');
    if (dilationSlider) {
      dilationSlider.addEventListener('input', this._boundDropShadowDilationInput);
      dilationSlider.addEventListener('change', this._boundDropShadowDilationCommit);
      this._dropShadowDilationSlider = dilationSlider;
    }
    this._bindDisplayInput(this._dropShadowDilationDisplay, this._boundDropShadowDilationInput, this._boundDropShadowDilationCommit);
    const blurSlider = root.querySelector('[data-fa-nexus-drop-shadow-blur]');
    if (blurSlider) {
      blurSlider.addEventListener('input', this._boundDropShadowBlurInput);
      blurSlider.addEventListener('change', this._boundDropShadowBlurCommit);
      this._dropShadowBlurSlider = blurSlider;
    }
    this._bindDisplayInput(this._dropShadowBlurDisplay, this._boundDropShadowBlurInput, this._boundDropShadowBlurCommit);
    const offsetControl = root.querySelector('[data-fa-nexus-drop-shadow-offset-control]');
    if (offsetControl) {
      offsetControl.addEventListener('pointerdown', this._boundDropShadowOffsetPointerDown);
      offsetControl.addEventListener('contextmenu', this._boundDropShadowOffsetContext);
      this._dropShadowOffsetControl = offsetControl;
      this._dropShadowOffsetMaxDistance = Number(offsetControl.dataset.maxDistance) || 40;
    }
    this._dropShadowOffsetCircle = root.querySelector('[data-fa-nexus-drop-shadow-offset-circle]') || null;
    this._dropShadowPreviewRoot = root.querySelector('[data-fa-nexus-drop-shadow-offset-preview]') || null;
    this._dropShadowPreviewImage = root.querySelector('[data-fa-nexus-drop-shadow-offset-preview-image]') || null;
    this._dropShadowOffsetHandle = root.querySelector('[data-fa-nexus-drop-shadow-offset-handle]') || null;

    this._syncDropShadowControls();
  }

  _unbindDropShadowControls() {
    if (this._dropShadowAlphaSlider) {
      try {
        this._dropShadowAlphaSlider.removeEventListener('input', this._boundDropShadowAlphaInput);
        this._dropShadowAlphaSlider.removeEventListener('change', this._boundDropShadowAlphaCommit);
      } catch (_) {}
    }
    this._unbindDisplayInput(this._dropShadowAlphaDisplay, this._boundDropShadowAlphaInput, this._boundDropShadowAlphaCommit);
    if (this._dropShadowDilationSlider) {
      try {
        this._dropShadowDilationSlider.removeEventListener('input', this._boundDropShadowDilationInput);
        this._dropShadowDilationSlider.removeEventListener('change', this._boundDropShadowDilationCommit);
      } catch (_) {}
    }
    this._unbindDisplayInput(this._dropShadowDilationDisplay, this._boundDropShadowDilationInput, this._boundDropShadowDilationCommit);
    if (this._dropShadowBlurSlider) {
      try {
        this._dropShadowBlurSlider.removeEventListener('input', this._boundDropShadowBlurInput);
        this._dropShadowBlurSlider.removeEventListener('change', this._boundDropShadowBlurCommit);
      } catch (_) {}
    }
    this._unbindDisplayInput(this._dropShadowBlurDisplay, this._boundDropShadowBlurInput, this._boundDropShadowBlurCommit);
    if (this._dropShadowOffsetControl) {
      try { this._dropShadowOffsetControl.removeEventListener('pointerdown', this._boundDropShadowOffsetPointerDown); } catch (_) {}
      try { this._dropShadowOffsetControl.removeEventListener('contextmenu', this._boundDropShadowOffsetContext); } catch (_) {}
    }
    if (this._dropShadowCollapseButton) {
      try { this._dropShadowCollapseButton.removeEventListener('click', this._boundDropShadowCollapse); } catch (_) {}
    }
    if (Array.isArray(this._dropShadowPresetButtons)) {
      for (const button of this._dropShadowPresetButtons) {
        try { button.removeEventListener('click', this._boundDropShadowPresetClick); } catch (_) {}
        try { button.removeEventListener('contextmenu', this._boundDropShadowPresetContext); } catch (_) {}
      }
    }
    if (this._dropShadowResetButton) {
      try { this._dropShadowResetButton.removeEventListener('click', this._boundDropShadowReset); } catch (_) {}
    }
    this._releaseDropShadowOffsetPointer();
    this._dropShadowRoot = null;
    this._dropShadowAlphaSlider = null;
    this._dropShadowDilationSlider = null;
    this._dropShadowBlurSlider = null;
    this._dropShadowOffsetControl = null;
    this._dropShadowOffsetCircle = null;
    this._dropShadowPreviewRoot = null;
    this._dropShadowPreviewImage = null;
    this._dropShadowOffsetHandle = null;
    this._dropShadowAlphaDisplay = null;
    this._dropShadowDilationDisplay = null;
    this._dropShadowBlurDisplay = null;
    this._dropShadowOffsetDistanceDisplay = null;
    this._dropShadowOffsetAngleDisplay = null;
    this._dropShadowElevationDisplay = null;
    this._dropShadowStatusDisplay = null;
    this._dropShadowNoteDisplay = null;
    this._dropShadowCollapseButton = null;
    this._dropShadowBody = null;
    this._dropShadowPresetsRoot = null;
    this._dropShadowPresetButtons = [];
    this._dropShadowResetButton = null;
  }

  _syncDropShadowControls() {
    const state = this._toolOptionState?.dropShadowControls;
    if (!this._dropShadowRoot || !state || !state.available) {
      return;
    }
    const assign = (slider, display, entry) => {
      if (!slider || !entry) return;
      if (entry.min !== undefined) slider.min = entry.min;
      if (entry.max !== undefined) slider.max = entry.max;
      if (entry.step !== undefined) slider.step = entry.step;
      if (entry.value !== undefined) slider.value = entry.value;
      slider.disabled = !!entry.disabled;
      if (display) this._syncDisplayValue(display, entry);
    };
    const collapsed = !!state.collapsed;
    if (this._dropShadowRoot) {
      this._dropShadowRoot.classList.toggle('is-collapsed', collapsed);
    }
    if (this._dropShadowBody) {
      if (collapsed) this._dropShadowBody.setAttribute('aria-hidden', 'true');
      else this._dropShadowBody.removeAttribute('aria-hidden');
    }
    if (this._dropShadowCollapseButton) {
      this._dropShadowCollapseButton.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
      this._dropShadowCollapseButton.setAttribute('aria-label', collapsed ? 'Expand shadow settings' : 'Collapse shadow settings');
      this._dropShadowCollapseButton.classList.toggle('is-collapsed', collapsed);
      this._dropShadowCollapseButton.disabled = !!state.disabled;
    }
    assign(this._dropShadowAlphaSlider, this._dropShadowAlphaDisplay, state.alpha);
    assign(this._dropShadowDilationSlider, this._dropShadowDilationDisplay, state.dilation);
    assign(this._dropShadowBlurSlider, this._dropShadowBlurDisplay, state.blur);
    if (state.offset) {
      const disabled = !!state.offset.disabled;
      this._dropShadowOffsetMaxDistance = Number(state.offset.maxDistance) || this._dropShadowOffsetMaxDistance || 40;
      if (this._dropShadowOffsetControl) {
        this._dropShadowOffsetControl.dataset.maxDistance = String(this._dropShadowOffsetMaxDistance);
        this._dropShadowOffsetControl.dataset.disabled = disabled ? 'true' : 'false';
        this._dropShadowOffsetControl.classList.toggle('is-disabled', disabled);
      }
      if (disabled) this._releaseDropShadowOffsetPointer();
      if (this._dropShadowOffsetDistanceDisplay) {
        this._dropShadowOffsetDistanceDisplay.textContent = state.offset.displayDistance ?? '';
      }
      if (this._dropShadowOffsetAngleDisplay) {
      this._dropShadowOffsetAngleDisplay.textContent = state.offset.displayAngle ?? '';
      }
      this._positionDropShadowOffsetHandle(state.offset.distance, state.offset.angle, state.offset.maxDistance);
    }
    const presetEntries = Array.isArray(state.presets) ? state.presets : [];
    if (Array.isArray(this._dropShadowPresetButtons)) {
      for (const button of this._dropShadowPresetButtons) {
        const index = Number(button.dataset.faNexusDropShadowPreset);
        const entry = Number.isInteger(index) && presetEntries[index] ? presetEntries[index] : presetEntries.find?.((item) => item?.index === index);
        const saved = !!entry?.saved;
        const active = !!entry?.active;
        button.classList.toggle('is-empty', !saved);
        button.classList.toggle('is-active', active);
        button.disabled = !!state.disabled;
        button.title = entry?.tooltip || (saved ? 'Click to apply preset.' : 'Shift+Click to save preset.');
        button.setAttribute('aria-pressed', active ? 'true' : 'false');
      }
    }
    if (this._dropShadowResetButton) {
      this._dropShadowResetButton.disabled = !!state.disabled;
    }
    const context = state.context || {};
    if (this._dropShadowElevationDisplay) {
      if (context.display) {
        this._dropShadowElevationDisplay.textContent = `Elevation ${context.display}`;
        this._dropShadowElevationDisplay.classList.remove('is-hidden');
      } else {
        this._dropShadowElevationDisplay.textContent = '';
        this._dropShadowElevationDisplay.classList.add('is-hidden');
      }
    }
    if (this._dropShadowStatusDisplay) {
      this._dropShadowStatusDisplay.textContent = context.status || '';
      this._dropShadowStatusDisplay.classList.toggle('is-hidden', !context.status);
    }
    if (this._dropShadowNoteDisplay) {
      this._dropShadowNoteDisplay.textContent = context.note || '';
      this._dropShadowNoteDisplay.classList.toggle('is-hidden', !context.note);
    }
    this._syncDropShadowPreview(state.preview);
  }

  _handleDropShadowSlider(event, handlerName, commit) {
    const target = event?.currentTarget || event?.target;
    if (!target) return;
    const value = target.value;
    const controller = this._controller;
    if (!controller) return;
    try {
      const result = controller.invokeToolHandler(handlerName, value, commit);
      if (result?.then) {
        result.catch(() => {}).finally(() => this._syncDropShadowControls());
      } else {
        this._syncDropShadowControls();
      }
    } catch (_) {
      this._syncDropShadowControls();
    }
  }

  _handleDropShadowCollapse(event) {
    if (event) {
      event.preventDefault();
      event.stopPropagation();
    }
    const controller = this._controller;
    if (!controller?.invokeToolHandler) return;
    try { controller.invokeToolHandler('toggleDropShadowCollapsed'); }
    catch (_) {}
  }

  _handleDropShadowPresetClick(event) {
    const button = event?.currentTarget || event?.target;
    if (!button) return;
    const index = Number(button.dataset.faNexusDropShadowPreset);
    if (!Number.isInteger(index)) return;
    if (event) {
      event.preventDefault();
      event.stopPropagation();
    }
    const save = !!(event?.shiftKey || event?.altKey || event?.metaKey);
    const controller = this._controller;
    if (!controller?.invokeToolHandler) return;
    try {
      const result = controller.invokeToolHandler('handleDropShadowPreset', index, save);
      if (result?.then) {
        result.catch(() => {}).finally(() => this._syncDropShadowControls());
      } else {
        this._syncDropShadowControls();
      }
    } catch (_) {
      this._syncDropShadowControls();
    }
  }

  _handleDropShadowPresetContext(event) {
    const button = event?.currentTarget || event?.target;
    if (!button) return;
    if (event) {
      event.preventDefault();
      event.stopPropagation();
    }
    const index = Number(button.dataset.faNexusDropShadowPreset);
    if (!Number.isInteger(index)) return;
    const controller = this._controller;
    if (!controller?.invokeToolHandler) return;
    try {
      const result = controller.invokeToolHandler('handleDropShadowPreset', index, true);
      if (result?.then) {
        result.catch(() => {}).finally(() => this._syncDropShadowControls());
      } else {
        this._syncDropShadowControls();
      }
    } catch (_) {
      this._syncDropShadowControls();
    }
  }

  _handleDropShadowReset(event) {
    if (event) {
      event.preventDefault();
      event.stopPropagation();
    }
    const controller = this._controller;
    if (!controller?.invokeToolHandler) return;
    try {
      const result = controller.invokeToolHandler('resetDropShadow');
      if (result?.then) {
        result.catch(() => {}).finally(() => this._syncDropShadowControls());
      } else {
        this._syncDropShadowControls();
      }
    } catch (_) {
      this._syncDropShadowControls();
    }
  }

  _handleDropShadowOffsetContext(event) {
    if (event) {
      event.preventDefault();
      event.stopPropagation();
    }
    const controller = this._controller;
    if (!controller?.invokeToolHandler) return;
    try {
      const result = controller.invokeToolHandler('resetDropShadowOffset');
      if (result?.then) {
        result.catch(() => {}).finally(() => this._syncDropShadowControls());
      } else {
        this._syncDropShadowControls();
      }
    } catch (_) {
      this._syncDropShadowControls();
    }
  }

  _handleDropShadowOffsetPointerDown(event) {
    if (!this._dropShadowOffsetControl || event.button !== 0) return;
    if (this._dropShadowOffsetControl.dataset.disabled === 'true') return;
    this._dropShadowOffsetPointerId = event.pointerId;
    this._dropShadowOffsetPointerActive = true;
    try { this._dropShadowOffsetControl.setPointerCapture(event.pointerId); } catch (_) {}
    window.addEventListener('pointermove', this._boundDropShadowOffsetPointerMove, { passive: false });
    window.addEventListener('pointerup', this._boundDropShadowOffsetPointerUp, { passive: false });
    window.addEventListener('pointercancel', this._boundDropShadowOffsetPointerUp, { passive: false });
    event.preventDefault();
    this._updateDropShadowOffsetFromPointer(event, false);
  }

  _handleDropShadowOffsetPointerMove(event) {
    if (!this._dropShadowOffsetPointerActive) return;
    if (this._dropShadowOffsetPointerId !== null && event.pointerId !== this._dropShadowOffsetPointerId) return;
    event.preventDefault();
    this._updateDropShadowOffsetFromPointer(event, false);
  }

  _handleDropShadowOffsetPointerUp(event) {
    if (!this._dropShadowOffsetPointerActive) return;
    if (this._dropShadowOffsetPointerId !== null && event.pointerId !== this._dropShadowOffsetPointerId) return;
    event.preventDefault();
    this._updateDropShadowOffsetFromPointer(event, true);
    this._releaseDropShadowOffsetPointer();
  }

  _releaseDropShadowOffsetPointer() {
    if (this._dropShadowOffsetPointerId !== null && this._dropShadowOffsetControl) {
      try { this._dropShadowOffsetControl.releasePointerCapture(this._dropShadowOffsetPointerId); } catch (_) {}
    }
    window.removeEventListener('pointermove', this._boundDropShadowOffsetPointerMove, false);
    window.removeEventListener('pointerup', this._boundDropShadowOffsetPointerUp, false);
    window.removeEventListener('pointercancel', this._boundDropShadowOffsetPointerUp, false);
    this._dropShadowOffsetPointerId = null;
    this._dropShadowOffsetPointerActive = false;
  }

  _updateDropShadowOffsetFromPointer(event, commit) {
    if (!this._dropShadowOffsetCircle || !this._controller) return;
    const rect = this._dropShadowOffsetCircle.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;
    const dx = event.clientX - centerX;
    const dy = event.clientY - centerY;
    const radius = Math.min(rect.width, rect.height) / 2;
    if (radius <= 0) return;
    const maxDistance = this._dropShadowOffsetMaxDistance || 40;
    const radial = Math.min(1, Math.sqrt(dx * dx + dy * dy) / radius);
    const distance = Math.min(maxDistance, Math.max(0, radial * maxDistance));
    let angle = Math.atan2(dy, dx) * (180 / Math.PI);
    if (!Number.isFinite(angle)) angle = 0;
    angle = (angle + 360) % 360;
    this._positionDropShadowOffsetHandle(distance, angle, maxDistance);
    const result = this._controller.invokeToolHandler('setDropShadowOffset', distance, angle, !!commit);
    if (result?.then) {
      result.catch(() => {}).finally(() => this._syncDropShadowControls());
    } else {
      this._syncDropShadowControls();
    }
  }

  _positionDropShadowOffsetHandle(distance, angle, maxDistance) {
    if (!this._dropShadowOffsetHandle || !this._dropShadowOffsetCircle) return;
    const rect = this._dropShadowOffsetCircle.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const radius = Math.min(rect.width, rect.height) / 2;
    if (radius <= 0) return;
    const effectiveMax = Number(maxDistance) || this._dropShadowOffsetMaxDistance || 40;
    const ratio = effectiveMax > 0 ? Math.min(1, Math.max(0, distance / effectiveMax)) : 0;
    const theta = (Number(angle) || 0) * (Math.PI / 180);
    const offsetX = Math.cos(theta) * radius * ratio;
    const offsetY = Math.sin(theta) * radius * ratio;
    this._dropShadowOffsetHandle.style.setProperty('--fa-nexus-drop-shadow-offset-x', `${offsetX}px`);
    this._dropShadowOffsetHandle.style.setProperty('--fa-nexus-drop-shadow-offset-y', `${offsetY}px`);
  }

  _bindTextureToolControls() {
    const root = this.element?.querySelector('[data-fa-nexus-texture-tools-root]') || null;
    if (!root) {
      this._unbindTextureToolControls();
      return;
    }
    this._textureToolsRoot = root;
    this._textureModeLabel = root.querySelector('[data-fa-nexus-texture-mode-label]') || null;
    this._textureStatusDisplay = root.querySelector('[data-fa-nexus-texture-status]') || null;
    this._textureHintDisplay = root.querySelector('[data-fa-nexus-texture-hint]') || null;
    this._textureActionsRoot = root.querySelector('.fa-nexus-texture-tools__actions') || null;

    const modeButtons = Array.from(root.querySelectorAll('[data-fa-nexus-texture-mode]'));
    this._textureModeButtons = modeButtons;
    this._textureModeButtonMap = new Map();
    for (const button of modeButtons) {
      button.addEventListener('click', this._boundTextureModeClick);
      const id = button.dataset?.faNexusTextureMode || '';
      if (id) this._textureModeButtonMap.set(id, button);
    }

    const actionButtons = Array.from(root.querySelectorAll('[data-fa-nexus-texture-action]'));
    this._textureActionButtons = actionButtons;
    this._textureActionButtonMap = new Map();
    for (const button of actionButtons) {
      button.addEventListener('click', this._boundTextureActionClick);
      const id = button.dataset?.faNexusTextureAction || '';
      if (id) this._textureActionButtonMap.set(id, button);
    }

    this._syncTextureToolControls();
  }

  _unbindTextureToolControls() {
    if (this._textureModeButtons?.length) {
      for (const button of this._textureModeButtons) {
        try { button.removeEventListener('click', this._boundTextureModeClick); }
        catch (_) {}
      }
    }
    if (this._textureActionButtons?.length) {
      for (const button of this._textureActionButtons) {
        try { button.removeEventListener('click', this._boundTextureActionClick); }
        catch (_) {}
      }
    }
    this._textureModeButtons = [];
    this._textureModeButtonMap = new Map();
    this._textureActionButtons = [];
    this._textureActionButtonMap = new Map();
    this._textureToolsRoot = null;
    this._textureModeLabel = null;
    this._textureStatusDisplay = null;
    this._textureHintDisplay = null;
    this._textureActionsRoot = null;
  }

  _syncTextureToolControls() {
    if (!this._textureToolsRoot) return;
    const state = this._toolOptionState?.texturePaint || {};
    if (!state.available) {
      this._textureToolsRoot.hidden = true;
      return;
    }
    this._textureToolsRoot.hidden = false;
    if (this._textureModeLabel) {
      const label = state.modeLabel || '';
      if (this._textureModeLabel.textContent !== label) this._textureModeLabel.textContent = label;
    }
    if (this._textureStatusDisplay) {
      const status = state.status || '';
      this._textureStatusDisplay.textContent = status;
      this._textureStatusDisplay.hidden = !status;
    }
    if (this._textureHintDisplay) {
      const hint = state.hint || '';
      this._textureHintDisplay.textContent = hint;
      this._textureHintDisplay.hidden = !hint;
    }
    const modes = Array.isArray(state.modes) ? state.modes : [];
    for (const [id, button] of this._textureModeButtonMap.entries()) {
      const modeState = modes.find((mode) => mode.id === id) || null;
      if (!modeState) {
        button.hidden = true;
        continue;
      }
      button.hidden = false;
      button.disabled = !!modeState.disabled;
      button.classList.toggle('is-active', !!modeState.active);
      button.setAttribute('aria-pressed', modeState.active ? 'true' : 'false');
      if (modeState.tooltip) button.title = modeState.tooltip;
      else button.removeAttribute('title');
      const labelEl = button.querySelector('span');
      if (labelEl && modeState.label && labelEl.textContent !== modeState.label) {
        labelEl.textContent = modeState.label;
      }
    }
    if (this._textureActionsRoot) {
      const hasActions = Array.isArray(state.actions) && state.actions.length > 0;
      this._textureActionsRoot.hidden = !hasActions;
    }
    const actions = Array.isArray(state.actions) ? state.actions : [];
    for (const [id, button] of this._textureActionButtonMap.entries()) {
      const actionState = actions.find((action) => action.id === id) || null;
      if (!actionState) {
        button.hidden = true;
        continue;
      }
      button.hidden = false;
      button.disabled = !!actionState.disabled;
      button.classList.toggle('is-primary', !!actionState.primary);
      if (actionState.tooltip) button.title = actionState.tooltip;
      else button.removeAttribute('title');
      const labelEl = button.querySelector('span');
      if (labelEl && actionState.label && labelEl.textContent !== actionState.label) {
        labelEl.textContent = actionState.label;
      }
    }
  }

  _bindEditorActions() {
    const root = this.element?.querySelector('[data-fa-nexus-editor-actions-root]') || null;
    if (!root) {
      this._unbindEditorActions();
      return;
    }
    this._editorActionsRoot = root;
    const actionButtons = Array.from(root.querySelectorAll('[data-fa-nexus-editor-action]'));
    this._editorActionButtons = actionButtons;
    this._editorActionButtonMap = new Map();
    for (const button of actionButtons) {
      button.addEventListener('click', this._boundEditorActionClick);
      const id = button.dataset?.faNexusEditorAction || '';
      if (id) this._editorActionButtonMap.set(id, button);
    }
    this._syncEditorActions();
  }

  _unbindEditorActions() {
    if (this._editorActionButtons?.length) {
      for (const button of this._editorActionButtons) {
        try { button.removeEventListener('click', this._boundEditorActionClick); }
        catch (_) {}
      }
    }
    this._editorActionButtons = [];
    this._editorActionButtonMap = new Map();
    this._editorActionsRoot = null;
  }

  _syncEditorActions() {
    if (!this._editorActionsRoot) return;
    const actionStateList = Array.isArray(this._toolOptionState?.editorActions)
      ? this._toolOptionState.editorActions
      : [];
    if (!actionStateList.length) {
      this._editorActionsRoot.hidden = true;
      return;
    }
    this._editorActionsRoot.hidden = false;
    const stateMap = new Map();
    for (const entry of actionStateList) {
      const id = String(entry?.id || '');
      if (!id) continue;
      stateMap.set(id, {
        id,
        label: String(entry?.label || ''),
        tooltip: String(entry?.tooltip || ''),
        primary: !!entry?.primary,
        disabled: !!entry?.disabled
      });
    }
    for (const button of this._editorActionButtons || []) {
      const id = button.dataset?.faNexusEditorAction || '';
      const actionState = stateMap.get(id);
      if (!actionState) {
        button.hidden = true;
        continue;
      }
      button.hidden = false;
      button.disabled = !!actionState.disabled;
      button.classList.toggle('is-primary', !!actionState.primary);
      if (actionState.tooltip) button.title = actionState.tooltip;
      else button.removeAttribute('title');
      const labelEl = button.querySelector('span');
      if (labelEl && actionState.label && labelEl.textContent !== actionState.label) {
        labelEl.textContent = actionState.label;
      }
    }
  }

  _handleTextureModeClick(event) {
    const button = event?.currentTarget || event?.target;
    if (!button) return;
    const id = button.dataset?.faNexusTextureMode;
    if (!id) return;
    event?.preventDefault?.();
    event?.stopPropagation?.();
    const controller = this._controller;
    if (!controller?.invokeToolHandler) return;
    try {
      const result = controller.invokeToolHandler('setTextureMode', id);
      if (result?.then) {
        result.catch(() => {}).finally(() => this._syncTextureToolControls());
      } else {
        this._syncTextureToolControls();
      }
    } catch (_) {
      this._syncTextureToolControls();
    }
  }

  _handleTextureActionClick(event) {
    const button = event?.currentTarget || event?.target;
    if (!button) return;
    const id = button.dataset?.faNexusTextureAction;
    if (!id) return;
    event?.preventDefault?.();
    event?.stopPropagation?.();
    const controller = this._controller;
    if (!controller?.invokeToolHandler) return;
    try {
      const result = controller.invokeToolHandler('handleTextureAction', id);
      if (result?.then) {
        result.catch(() => {}).finally(() => this._syncTextureToolControls());
      } else {
        this._syncTextureToolControls();
      }
    } catch (_) {
      this._syncTextureToolControls();
    }
  }

  _handleEditorActionClick(event) {
    const button = event?.currentTarget || event?.target;
    if (!button) return;
    const id = button.dataset?.faNexusEditorAction;
    if (!id) return;
    event?.preventDefault?.();
    event?.stopPropagation?.();
    const controller = this._controller;
    if (!controller?.invokeToolHandler) return;
    try {
      const result = controller.invokeToolHandler('handleEditorAction', id);
      if (result?.then) {
        result.catch(() => {}).finally(() => this._syncEditorActions());
      } else {
        this._syncEditorActions();
      }
    } catch (_) {
      this._syncEditorActions();
    }
  }

  _bindTextureOpacityControl() {
    const root = this.element?.querySelector('[data-fa-nexus-texture-opacity-root]') || null;
    if (!root) {
      this._unbindTextureOpacityControl();
      return;
    }
    this._textureOpacityRoot = root;
    const slider = root.querySelector('[data-fa-nexus-texture-opacity]');
    if (slider) {
      slider.addEventListener('input', this._boundTextureOpacityInput);
      slider.addEventListener('change', this._boundTextureOpacityCommit);
      this._textureOpacitySlider = slider;
    }
    this._textureOpacityDisplay = root.querySelector('[data-fa-nexus-texture-opacity-display]') || null;
    this._bindDisplayInput(this._textureOpacityDisplay, this._boundTextureOpacityInput, this._boundTextureOpacityCommit);
    this._syncTextureOpacityControl();
  }

  _handleTextureBrushSetting(event, handlerName, commit) {
    const slider = event?.currentTarget || event?.target;
    if (!slider || !handlerName) return;
    const controller = this._controller;
    if (!controller?.invokeToolHandler) return;
    try {
      const value = Number(slider.value);
      const result = controller.invokeToolHandler(handlerName, value, !!commit);
      if (result?.then) {
        result.catch(() => {}).finally(() => this._syncTextureBrushControls());
      } else {
        this._syncTextureBrushControls();
      }
    } catch (_) {
      this._syncTextureBrushControls();
    }
  }

  _bindTextureBrushControls() {
    const root = this.element?.querySelector('[data-fa-nexus-texture-brush-root]') || null;
    if (!root) {
      this._unbindTextureBrushControls();
      return;
    }
    this._textureBrushRoot = root;
    const brushSize = root.querySelector('[data-fa-nexus-texture-brush-size]');
    if (brushSize) {
      brushSize.addEventListener('input', this._boundTextureBrushSizeInput);
      brushSize.addEventListener('change', this._boundTextureBrushSizeCommit);
      this._textureBrushSizeSlider = brushSize;
    }
    const particleSize = root.querySelector('[data-fa-nexus-texture-particle-size]');
    if (particleSize) {
      particleSize.addEventListener('input', this._boundTextureParticleSizeInput);
      particleSize.addEventListener('change', this._boundTextureParticleSizeCommit);
      this._textureParticleSizeSlider = particleSize;
    }
    const particleDensity = root.querySelector('[data-fa-nexus-texture-particle-density]');
    if (particleDensity) {
      particleDensity.addEventListener('input', this._boundTextureParticleDensityInput);
      particleDensity.addEventListener('change', this._boundTextureParticleDensityCommit);
      this._textureParticleDensitySlider = particleDensity;
    }
    const sprayDeviation = root.querySelector('[data-fa-nexus-texture-spray-deviation]');
    if (sprayDeviation) {
      sprayDeviation.addEventListener('input', this._boundTextureSprayDeviationInput);
      sprayDeviation.addEventListener('change', this._boundTextureSprayDeviationCommit);
      this._textureSprayDeviationSlider = sprayDeviation;
    }
    const brushSpacing = root.querySelector('[data-fa-nexus-texture-brush-spacing]');
    if (brushSpacing) {
      brushSpacing.addEventListener('input', this._boundTextureBrushSpacingInput);
      brushSpacing.addEventListener('change', this._boundTextureBrushSpacingCommit);
      this._textureBrushSpacingSlider = brushSpacing;
    }
    this._textureBrushSizeDisplay = root.querySelector('[data-fa-nexus-texture-brush-size-display]') || null;
    this._textureParticleSizeDisplay = root.querySelector('[data-fa-nexus-texture-particle-size-display]') || null;
    this._textureParticleDensityDisplay = root.querySelector('[data-fa-nexus-texture-particle-density-display]') || null;
    this._textureSprayDeviationDisplay = root.querySelector('[data-fa-nexus-texture-spray-deviation-display]') || null;
    this._textureBrushSpacingDisplay = root.querySelector('[data-fa-nexus-texture-brush-spacing-display]') || null;
    this._bindDisplayInput(this._textureBrushSizeDisplay, this._boundTextureBrushSizeInput, this._boundTextureBrushSizeCommit);
    this._bindDisplayInput(this._textureParticleSizeDisplay, this._boundTextureParticleSizeInput, this._boundTextureParticleSizeCommit);
    this._bindDisplayInput(this._textureParticleDensityDisplay, this._boundTextureParticleDensityInput, this._boundTextureParticleDensityCommit);
    this._bindDisplayInput(this._textureSprayDeviationDisplay, this._boundTextureSprayDeviationInput, this._boundTextureSprayDeviationCommit);
    this._bindDisplayInput(this._textureBrushSpacingDisplay, this._boundTextureBrushSpacingInput, this._boundTextureBrushSpacingCommit);
    this._syncTextureBrushControls();
  }

  _handleAssetScatterSetting(event, handlerName, commit) {
    const slider = event?.currentTarget || event?.target;
    if (!slider || !handlerName) return;
    const controller = this._controller;
    if (!controller?.invokeToolHandler) return;
    try {
      const value = Number(slider.value);
      const result = controller.invokeToolHandler(handlerName, value, !!commit);
      if (result?.then) {
        result.catch(() => {}).finally(() => this._syncAssetScatterControls());
      } else {
        this._syncAssetScatterControls();
      }
    } catch (_) {
      this._syncAssetScatterControls();
    }
  }

  _bindAssetScatterControls() {
    const root = this.element?.querySelector('[data-fa-nexus-asset-scatter-root]') || null;
    if (!root) {
      this._unbindAssetScatterControls();
      return;
    }
    this._assetScatterRoot = root;
    const brushSize = root.querySelector('[data-fa-nexus-asset-scatter-size]');
    if (brushSize) {
      brushSize.addEventListener('input', this._boundAssetScatterBrushSizeInput);
      brushSize.addEventListener('change', this._boundAssetScatterBrushSizeCommit);
      this._assetScatterBrushSizeSlider = brushSize;
    }
    const density = root.querySelector('[data-fa-nexus-asset-scatter-density]');
    if (density) {
      density.addEventListener('input', this._boundAssetScatterDensityInput);
      density.addEventListener('change', this._boundAssetScatterDensityCommit);
      this._assetScatterDensitySlider = density;
    }
    const spray = root.querySelector('[data-fa-nexus-asset-scatter-spray]');
    if (spray) {
      spray.addEventListener('input', this._boundAssetScatterSprayDeviationInput);
      spray.addEventListener('change', this._boundAssetScatterSprayDeviationCommit);
      this._assetScatterSprayDeviationSlider = spray;
    }
    const spacing = root.querySelector('[data-fa-nexus-asset-scatter-spacing]');
    if (spacing) {
      spacing.addEventListener('input', this._boundAssetScatterSpacingInput);
      spacing.addEventListener('change', this._boundAssetScatterSpacingCommit);
      this._assetScatterSpacingSlider = spacing;
    }
    this._assetScatterBrushSizeDisplay = root.querySelector('[data-fa-nexus-asset-scatter-size-display]') || null;
    this._assetScatterDensityDisplay = root.querySelector('[data-fa-nexus-asset-scatter-density-display]') || null;
    this._assetScatterSprayDeviationDisplay = root.querySelector('[data-fa-nexus-asset-scatter-spray-display]') || null;
    this._assetScatterSpacingDisplay = root.querySelector('[data-fa-nexus-asset-scatter-spacing-display]') || null;
    this._bindDisplayInput(this._assetScatterBrushSizeDisplay, this._boundAssetScatterBrushSizeInput, this._boundAssetScatterBrushSizeCommit);
    this._bindDisplayInput(this._assetScatterDensityDisplay, this._boundAssetScatterDensityInput, this._boundAssetScatterDensityCommit);
    this._bindDisplayInput(this._assetScatterSprayDeviationDisplay, this._boundAssetScatterSprayDeviationInput, this._boundAssetScatterSprayDeviationCommit);
    this._bindDisplayInput(this._assetScatterSpacingDisplay, this._boundAssetScatterSpacingInput, this._boundAssetScatterSpacingCommit);
    this._syncAssetScatterControls();
  }

  _handleHeightBrushThreshold(event, axis, commit) {
    const slider = event?.currentTarget || event?.target;
    if (!slider) return;
    if (this._controller?.invokeToolHandler) {
      this._controller.invokeToolHandler('setHeightThreshold', axis, slider.value, !!commit);
    }
  }

  _handleHeightBrushTuning(event, key, commit) {
    const slider = event?.currentTarget || event?.target;
    if (!slider) return;
    const handler = key === 'contrast' ? 'setHeightContrast' : 'setHeightLift';
    if (this._controller?.invokeToolHandler) {
      this._controller.invokeToolHandler(handler, slider.value, !!commit);
    }
  }

  _bindHeightMapControls() {
    const root = this.element?.querySelector('[data-fa-nexus-height-map-root]') || null;
    if (!root) {
      this._unbindHeightMapControls();
      return;
    }
    this._heightMapRoot = root;
    this._heightMapCollapseButton = root.querySelector('[data-fa-nexus-height-map-toggle]') || null;
    if (this._heightMapCollapseButton) {
      this._heightMapCollapseButton.addEventListener('click', this._boundHeightMapCollapse);
    }
    this._heightMapBody = root.querySelector('[data-fa-nexus-height-map-body]') || null;
    this._syncHeightMapControls();
  }

  _unbindHeightMapControls() {
    if (this._heightMapCollapseButton) {
      try { this._heightMapCollapseButton.removeEventListener('click', this._boundHeightMapCollapse); } catch (_) {}
    }
    this._heightMapRoot = null;
    this._heightMapCollapseButton = null;
    this._heightMapBody = null;
  }

  _syncHeightMapControls() {
    if (!this._heightMapRoot) return;
    const state = this._toolOptionState?.heightMap || { available: false };
    const available = !!state.available;
    if (!available) {
      this._heightMapRoot.hidden = true;
      return;
    }
    this._heightMapRoot.hidden = false;
    const collapsed = !!state.collapsed;
    this._heightMapRoot.classList.toggle('is-collapsed', collapsed);
    if (this._heightMapBody) {
      if (collapsed) this._heightMapBody.setAttribute('aria-hidden', 'true');
      else this._heightMapBody.removeAttribute('aria-hidden');
    }
    if (this._heightMapCollapseButton) {
      this._heightMapCollapseButton.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
      this._heightMapCollapseButton.setAttribute('aria-label', collapsed ? 'Expand height map settings' : 'Collapse height map settings');
      this._heightMapCollapseButton.classList.toggle('is-collapsed', collapsed);
      this._heightMapCollapseButton.disabled = !!state.disabled;
    }
  }

  _handleHeightMapCollapse(event) {
    if (event) {
      event.preventDefault();
      event.stopPropagation();
    }
    const controller = this._controller;
    if (!controller?.invokeToolHandler) return;
    try { controller.invokeToolHandler('toggleHeightMapCollapsed'); }
    catch (_) {}
  }

  _bindHeightBrushControls() {
    const root = this.element?.querySelector('[data-fa-nexus-height-brush-root]') || null;
    if (!root) {
      this._unbindHeightBrushControls();
      return;
    }
    this._heightBrushRoot = root;
    const minSlider = root.querySelector('[data-fa-nexus-height-threshold-min]');
    if (minSlider) {
      minSlider.addEventListener('input', this._boundHeightBrushMinInput);
      minSlider.addEventListener('change', this._boundHeightBrushMinCommit);
      this._heightBrushMinSlider = minSlider;
    }
    const maxSlider = root.querySelector('[data-fa-nexus-height-threshold-max]');
    if (maxSlider) {
      maxSlider.addEventListener('input', this._boundHeightBrushMaxInput);
      maxSlider.addEventListener('change', this._boundHeightBrushMaxCommit);
      this._heightBrushMaxSlider = maxSlider;
    }
    const contrastSlider = root.querySelector('[data-fa-nexus-height-contrast]');
    if (contrastSlider) {
      contrastSlider.addEventListener('input', this._boundHeightBrushContrastInput);
      contrastSlider.addEventListener('change', this._boundHeightBrushContrastCommit);
      this._heightBrushContrastSlider = contrastSlider;
    }
    const liftSlider = root.querySelector('[data-fa-nexus-height-lift]');
    if (liftSlider) {
      liftSlider.addEventListener('input', this._boundHeightBrushLiftInput);
      liftSlider.addEventListener('change', this._boundHeightBrushLiftCommit);
      this._heightBrushLiftSlider = liftSlider;
    }
    this._heightBrushMinDisplay = root.querySelector('[data-fa-nexus-height-threshold-min-display]') || null;
    this._heightBrushMaxDisplay = root.querySelector('[data-fa-nexus-height-threshold-max-display]') || null;
    this._heightBrushContrastDisplay = root.querySelector('[data-fa-nexus-height-contrast-display]') || null;
    this._heightBrushLiftDisplay = root.querySelector('[data-fa-nexus-height-lift-display]') || null;
    this._bindDisplayInput(this._heightBrushMinDisplay, this._boundHeightBrushMinInput, this._boundHeightBrushMinCommit);
    this._bindDisplayInput(this._heightBrushMaxDisplay, this._boundHeightBrushMaxInput, this._boundHeightBrushMaxCommit);
    this._bindDisplayInput(this._heightBrushContrastDisplay, this._boundHeightBrushContrastInput, this._boundHeightBrushContrastCommit);
    this._bindDisplayInput(this._heightBrushLiftDisplay, this._boundHeightBrushLiftInput, this._boundHeightBrushLiftCommit);
    this._syncHeightBrushControls();
  }

  _bindTextureLayerControl() {
    const root = this.element?.querySelector('[data-fa-nexus-texture-layer-root]') || null;
    if (!root) {
      this._unbindTextureLayerControl();
      return;
    }
    this._textureLayerRoot = root;
    const slider = root.querySelector('[data-fa-nexus-texture-layer]');
    if (slider) {
      slider.addEventListener('input', this._boundTextureLayerInput);
      slider.addEventListener('change', this._boundTextureLayerCommit);
      this._textureLayerSlider = slider;
    }
    this._textureLayerDisplay = root.querySelector('[data-fa-nexus-texture-layer-display]') || null;
    this._bindDisplayInput(this._textureLayerDisplay, this._boundTextureLayerInput, this._boundTextureLayerCommit);
    this._syncTextureLayerControl();
  }

  _bindTextureOffsetControls() {
    const root = this.element?.querySelector('[data-fa-nexus-texture-offset-root]') || null;
    if (!root) {
      this._unbindTextureOffsetControls();
      return;
    }
    this._textureOffsetRoot = root;
    const xSlider = root.querySelector('[data-fa-nexus-texture-offset-x]');
    if (xSlider) {
      xSlider.addEventListener('input', this._boundTextureOffsetXInput);
      xSlider.addEventListener('change', this._boundTextureOffsetXCommit);
      this._textureOffsetXSlider = xSlider;
    }
    const ySlider = root.querySelector('[data-fa-nexus-texture-offset-y]');
    if (ySlider) {
      ySlider.addEventListener('input', this._boundTextureOffsetYInput);
      ySlider.addEventListener('change', this._boundTextureOffsetYCommit);
      this._textureOffsetYSlider = ySlider;
    }
    this._textureOffsetXDisplay = root.querySelector('[data-fa-nexus-texture-offset-x-display]') || null;
    this._textureOffsetYDisplay = root.querySelector('[data-fa-nexus-texture-offset-y-display]') || null;
    this._bindDisplayInput(this._textureOffsetXDisplay, this._boundTextureOffsetXInput, this._boundTextureOffsetXCommit);
    this._bindDisplayInput(this._textureOffsetYDisplay, this._boundTextureOffsetYInput, this._boundTextureOffsetYCommit);
    this._syncTextureOffsetControls();
  }

  _unbindTextureOpacityControl() {
    if (this._textureOpacitySlider) {
      try {
        this._textureOpacitySlider.removeEventListener('input', this._boundTextureOpacityInput);
        this._textureOpacitySlider.removeEventListener('change', this._boundTextureOpacityCommit);
      } catch (_) {}
    }
    this._unbindDisplayInput(this._textureOpacityDisplay, this._boundTextureOpacityInput, this._boundTextureOpacityCommit);
    this._textureOpacityRoot = null;
    this._textureOpacitySlider = null;
    this._textureOpacityDisplay = null;
  }

  _unbindTextureBrushControls() {
    if (this._textureBrushSizeSlider) {
      try {
        this._textureBrushSizeSlider.removeEventListener('input', this._boundTextureBrushSizeInput);
        this._textureBrushSizeSlider.removeEventListener('change', this._boundTextureBrushSizeCommit);
      } catch (_) {}
    }
    if (this._textureParticleSizeSlider) {
      try {
        this._textureParticleSizeSlider.removeEventListener('input', this._boundTextureParticleSizeInput);
        this._textureParticleSizeSlider.removeEventListener('change', this._boundTextureParticleSizeCommit);
      } catch (_) {}
    }
    if (this._textureParticleDensitySlider) {
      try {
        this._textureParticleDensitySlider.removeEventListener('input', this._boundTextureParticleDensityInput);
        this._textureParticleDensitySlider.removeEventListener('change', this._boundTextureParticleDensityCommit);
      } catch (_) {}
    }
    if (this._textureSprayDeviationSlider) {
      try {
        this._textureSprayDeviationSlider.removeEventListener('input', this._boundTextureSprayDeviationInput);
        this._textureSprayDeviationSlider.removeEventListener('change', this._boundTextureSprayDeviationCommit);
      } catch (_) {}
    }
    if (this._textureBrushSpacingSlider) {
      try {
        this._textureBrushSpacingSlider.removeEventListener('input', this._boundTextureBrushSpacingInput);
        this._textureBrushSpacingSlider.removeEventListener('change', this._boundTextureBrushSpacingCommit);
      } catch (_) {}
    }
    this._unbindDisplayInput(this._textureBrushSizeDisplay, this._boundTextureBrushSizeInput, this._boundTextureBrushSizeCommit);
    this._unbindDisplayInput(this._textureParticleSizeDisplay, this._boundTextureParticleSizeInput, this._boundTextureParticleSizeCommit);
    this._unbindDisplayInput(this._textureParticleDensityDisplay, this._boundTextureParticleDensityInput, this._boundTextureParticleDensityCommit);
    this._unbindDisplayInput(this._textureSprayDeviationDisplay, this._boundTextureSprayDeviationInput, this._boundTextureSprayDeviationCommit);
    this._unbindDisplayInput(this._textureBrushSpacingDisplay, this._boundTextureBrushSpacingInput, this._boundTextureBrushSpacingCommit);
    this._textureBrushRoot = null;
    this._textureBrushSizeSlider = null;
    this._textureBrushSizeDisplay = null;
    this._textureParticleSizeSlider = null;
    this._textureParticleSizeDisplay = null;
    this._textureParticleDensitySlider = null;
    this._textureParticleDensityDisplay = null;
    this._textureSprayDeviationSlider = null;
    this._textureSprayDeviationDisplay = null;
    this._textureBrushSpacingSlider = null;
    this._textureBrushSpacingDisplay = null;
  }

  _unbindAssetScatterControls() {
    if (this._assetScatterBrushSizeSlider) {
      try {
        this._assetScatterBrushSizeSlider.removeEventListener('input', this._boundAssetScatterBrushSizeInput);
        this._assetScatterBrushSizeSlider.removeEventListener('change', this._boundAssetScatterBrushSizeCommit);
      } catch (_) {}
    }
    if (this._assetScatterDensitySlider) {
      try {
        this._assetScatterDensitySlider.removeEventListener('input', this._boundAssetScatterDensityInput);
        this._assetScatterDensitySlider.removeEventListener('change', this._boundAssetScatterDensityCommit);
      } catch (_) {}
    }
    if (this._assetScatterSprayDeviationSlider) {
      try {
        this._assetScatterSprayDeviationSlider.removeEventListener('input', this._boundAssetScatterSprayDeviationInput);
        this._assetScatterSprayDeviationSlider.removeEventListener('change', this._boundAssetScatterSprayDeviationCommit);
      } catch (_) {}
    }
    if (this._assetScatterSpacingSlider) {
      try {
        this._assetScatterSpacingSlider.removeEventListener('input', this._boundAssetScatterSpacingInput);
        this._assetScatterSpacingSlider.removeEventListener('change', this._boundAssetScatterSpacingCommit);
      } catch (_) {}
    }
    this._unbindDisplayInput(this._assetScatterBrushSizeDisplay, this._boundAssetScatterBrushSizeInput, this._boundAssetScatterBrushSizeCommit);
    this._unbindDisplayInput(this._assetScatterDensityDisplay, this._boundAssetScatterDensityInput, this._boundAssetScatterDensityCommit);
    this._unbindDisplayInput(this._assetScatterSprayDeviationDisplay, this._boundAssetScatterSprayDeviationInput, this._boundAssetScatterSprayDeviationCommit);
    this._unbindDisplayInput(this._assetScatterSpacingDisplay, this._boundAssetScatterSpacingInput, this._boundAssetScatterSpacingCommit);
    this._assetScatterRoot = null;
    this._assetScatterBrushSizeSlider = null;
    this._assetScatterBrushSizeDisplay = null;
    this._assetScatterDensitySlider = null;
    this._assetScatterDensityDisplay = null;
    this._assetScatterSprayDeviationSlider = null;
    this._assetScatterSprayDeviationDisplay = null;
    this._assetScatterSpacingSlider = null;
    this._assetScatterSpacingDisplay = null;
  }

  _unbindHeightBrushControls() {
    if (this._heightBrushMinSlider) {
      try {
        this._heightBrushMinSlider.removeEventListener('input', this._boundHeightBrushMinInput);
        this._heightBrushMinSlider.removeEventListener('change', this._boundHeightBrushMinCommit);
      } catch (_) {}
    }
    if (this._heightBrushMaxSlider) {
      try {
        this._heightBrushMaxSlider.removeEventListener('input', this._boundHeightBrushMaxInput);
        this._heightBrushMaxSlider.removeEventListener('change', this._boundHeightBrushMaxCommit);
      } catch (_) {}
    }
    if (this._heightBrushContrastSlider) {
      try {
        this._heightBrushContrastSlider.removeEventListener('input', this._boundHeightBrushContrastInput);
        this._heightBrushContrastSlider.removeEventListener('change', this._boundHeightBrushContrastCommit);
      } catch (_) {}
    }
    if (this._heightBrushLiftSlider) {
      try {
        this._heightBrushLiftSlider.removeEventListener('input', this._boundHeightBrushLiftInput);
        this._heightBrushLiftSlider.removeEventListener('change', this._boundHeightBrushLiftCommit);
      } catch (_) {}
    }
    this._unbindDisplayInput(this._heightBrushMinDisplay, this._boundHeightBrushMinInput, this._boundHeightBrushMinCommit);
    this._unbindDisplayInput(this._heightBrushMaxDisplay, this._boundHeightBrushMaxInput, this._boundHeightBrushMaxCommit);
    this._unbindDisplayInput(this._heightBrushContrastDisplay, this._boundHeightBrushContrastInput, this._boundHeightBrushContrastCommit);
    this._unbindDisplayInput(this._heightBrushLiftDisplay, this._boundHeightBrushLiftInput, this._boundHeightBrushLiftCommit);
    this._heightBrushRoot = null;
    this._heightBrushMinSlider = null;
    this._heightBrushMaxSlider = null;
    this._heightBrushContrastSlider = null;
    this._heightBrushLiftSlider = null;
    this._heightBrushMinDisplay = null;
    this._heightBrushMaxDisplay = null;
    this._heightBrushContrastDisplay = null;
    this._heightBrushLiftDisplay = null;
  }

  _unbindTextureLayerControl() {
    if (this._textureLayerSlider) {
      try {
        this._textureLayerSlider.removeEventListener('input', this._boundTextureLayerInput);
        this._textureLayerSlider.removeEventListener('change', this._boundTextureLayerCommit);
      } catch (_) {}
    }
    this._unbindDisplayInput(this._textureLayerDisplay, this._boundTextureLayerInput, this._boundTextureLayerCommit);
    this._textureLayerRoot = null;
    this._textureLayerSlider = null;
    this._textureLayerDisplay = null;
  }

  _unbindTextureOffsetControls() {
    if (this._textureOffsetXSlider) {
      try {
        this._textureOffsetXSlider.removeEventListener('input', this._boundTextureOffsetXInput);
        this._textureOffsetXSlider.removeEventListener('change', this._boundTextureOffsetXCommit);
      } catch (_) {}
    }
    if (this._textureOffsetYSlider) {
      try {
        this._textureOffsetYSlider.removeEventListener('input', this._boundTextureOffsetYInput);
        this._textureOffsetYSlider.removeEventListener('change', this._boundTextureOffsetYCommit);
      } catch (_) {}
    }
    this._unbindDisplayInput(this._textureOffsetXDisplay, this._boundTextureOffsetXInput, this._boundTextureOffsetXCommit);
    this._unbindDisplayInput(this._textureOffsetYDisplay, this._boundTextureOffsetYInput, this._boundTextureOffsetYCommit);
    this._textureOffsetRoot = null;
    this._textureOffsetXSlider = null;
    this._textureOffsetYSlider = null;
    this._textureOffsetXDisplay = null;
    this._textureOffsetYDisplay = null;
  }

  _syncTextureOpacityControl() {
    if (!this._textureOpacityRoot) return;
    const state = this._toolOptionState?.texturePaint?.opacity || { available: false };
    if (!state.available) {
      this._textureOpacityRoot.hidden = true;
      return;
    }
    this._textureOpacityRoot.hidden = false;
    if (this._textureOpacitySlider) {
      if (state.min !== undefined) this._textureOpacitySlider.min = String(state.min);
      if (state.max !== undefined) this._textureOpacitySlider.max = String(state.max);
      if (state.step !== undefined) this._textureOpacitySlider.step = String(state.step);
      if (state.value !== undefined) {
        const nextValue = String(state.value);
        if (this._textureOpacitySlider.value !== nextValue) this._textureOpacitySlider.value = nextValue;
      }
      this._applyDefaultValue(this._textureOpacitySlider, state.defaultValue);
      this._textureOpacitySlider.disabled = !!state.disabled;
    }
    if (this._textureOpacityDisplay) {
      this._syncDisplayValue(this._textureOpacityDisplay, state);
    }
  }

  _syncTextureBrushControls() {
    if (!this._textureBrushRoot) return;
    const state = this._toolOptionState?.textureBrush || { available: false };
    if (!state.available) {
      this._textureBrushRoot.hidden = true;
      return;
    }
    this._textureBrushRoot.hidden = false;
    const applySlider = (slider, data, display) => {
      if (!slider || !data) return;
      if (data.min !== undefined) slider.min = String(data.min);
      if (data.max !== undefined) slider.max = String(data.max);
      if (data.step !== undefined) slider.step = String(data.step);
      if (data.value !== undefined) {
        const nextValue = String(data.value);
        if (slider.value !== nextValue) slider.value = nextValue;
      }
      this._applyDefaultValue(slider, data.defaultValue);
      slider.disabled = !!state.disabled || !!data.disabled;
      if (display) this._syncDisplayValue(display, data, { disabled: state.disabled });
    };
    applySlider(this._textureBrushSizeSlider, state.brushSize, this._textureBrushSizeDisplay);
    applySlider(this._textureParticleSizeSlider, state.particleSize, this._textureParticleSizeDisplay);
    applySlider(this._textureParticleDensitySlider, state.particleDensity, this._textureParticleDensityDisplay);
    applySlider(this._textureSprayDeviationSlider, state.sprayDeviation, this._textureSprayDeviationDisplay);
    applySlider(this._textureBrushSpacingSlider, state.spacing, this._textureBrushSpacingDisplay);
  }

  _syncAssetScatterControls() {
    if (!this._assetScatterRoot) return;
    const state = this._toolOptionState?.assetScatter || { available: false };
    if (!state.available) {
      this._assetScatterRoot.hidden = true;
      return;
    }
    this._assetScatterRoot.hidden = false;
    const applySlider = (slider, data, display) => {
      if (!slider || !data) return;
      if (data.min !== undefined) slider.min = String(data.min);
      if (data.max !== undefined) slider.max = String(data.max);
      if (data.step !== undefined) slider.step = String(data.step);
      if (data.value !== undefined) {
        const nextValue = String(data.value);
        if (slider.value !== nextValue) slider.value = nextValue;
      }
      this._applyDefaultValue(slider, data.defaultValue);
      slider.disabled = !!state.disabled || !!data.disabled;
      if (display) this._syncDisplayValue(display, data, { disabled: state.disabled });
    };
    applySlider(this._assetScatterBrushSizeSlider, state.brushSize, this._assetScatterBrushSizeDisplay);
    applySlider(this._assetScatterDensitySlider, state.density, this._assetScatterDensityDisplay);
    applySlider(this._assetScatterSprayDeviationSlider, state.sprayDeviation, this._assetScatterSprayDeviationDisplay);
    applySlider(this._assetScatterSpacingSlider, state.spacing, this._assetScatterSpacingDisplay);
  }

  _syncHeightBrushControls() {
    if (!this._heightBrushRoot) return;
    const state = this._toolOptionState?.heightBrush || { available: false };
    if (!state.available) {
      this._heightBrushRoot.hidden = true;
      return;
    }
    this._heightBrushRoot.hidden = false;
    if (this._heightBrushMinSlider) {
      if (state.min?.min !== undefined) this._heightBrushMinSlider.min = String(state.min.min);
      if (state.min?.max !== undefined) this._heightBrushMinSlider.max = String(state.min.max);
      if (state.min?.step !== undefined) this._heightBrushMinSlider.step = String(state.min.step);
      if (state.min?.value !== undefined) {
        const nextMin = String(state.min.value);
        if (this._heightBrushMinSlider.value !== nextMin) this._heightBrushMinSlider.value = nextMin;
      }
      this._applyDefaultValue(this._heightBrushMinSlider, state.min?.defaultValue);
      this._heightBrushMinSlider.disabled = !!state.min?.disabled || !!state.disabled;
    }
    if (this._heightBrushMaxSlider) {
      if (state.max?.min !== undefined) this._heightBrushMaxSlider.min = String(state.max.min);
      if (state.max?.max !== undefined) this._heightBrushMaxSlider.max = String(state.max.max);
      if (state.max?.step !== undefined) this._heightBrushMaxSlider.step = String(state.max.step);
      if (state.max?.value !== undefined) {
        const nextMax = String(state.max.value);
        if (this._heightBrushMaxSlider.value !== nextMax) this._heightBrushMaxSlider.value = nextMax;
      }
      this._applyDefaultValue(this._heightBrushMaxSlider, state.max?.defaultValue);
      this._heightBrushMaxSlider.disabled = !!state.max?.disabled || !!state.disabled;
    }
    if (this._heightBrushContrastSlider) {
      if (state.contrast?.min !== undefined) this._heightBrushContrastSlider.min = String(state.contrast.min);
      if (state.contrast?.max !== undefined) this._heightBrushContrastSlider.max = String(state.contrast.max);
      if (state.contrast?.step !== undefined) this._heightBrushContrastSlider.step = String(state.contrast.step);
      if (state.contrast?.value !== undefined) {
        const nextContrast = String(state.contrast.value);
        if (this._heightBrushContrastSlider.value !== nextContrast) this._heightBrushContrastSlider.value = nextContrast;
      }
      this._applyDefaultValue(this._heightBrushContrastSlider, state.contrast?.defaultValue);
      this._heightBrushContrastSlider.disabled = !!state.contrast?.disabled || !!state.disabled;
    }
    if (this._heightBrushLiftSlider) {
      if (state.lift?.min !== undefined) this._heightBrushLiftSlider.min = String(state.lift.min);
      if (state.lift?.max !== undefined) this._heightBrushLiftSlider.max = String(state.lift.max);
      if (state.lift?.step !== undefined) this._heightBrushLiftSlider.step = String(state.lift.step);
      if (state.lift?.value !== undefined) {
        const nextLift = String(state.lift.value);
        if (this._heightBrushLiftSlider.value !== nextLift) this._heightBrushLiftSlider.value = nextLift;
      }
      this._applyDefaultValue(this._heightBrushLiftSlider, state.lift?.defaultValue);
      this._heightBrushLiftSlider.disabled = !!state.lift?.disabled || !!state.disabled;
    }
    if (this._heightBrushMinDisplay) {
      this._syncDisplayValue(this._heightBrushMinDisplay, state.min || {});
    }
    if (this._heightBrushMaxDisplay) {
      this._syncDisplayValue(this._heightBrushMaxDisplay, state.max || {});
    }
    if (this._heightBrushContrastDisplay) {
      this._syncDisplayValue(this._heightBrushContrastDisplay, state.contrast || {});
    }
    if (this._heightBrushLiftDisplay) {
      this._syncDisplayValue(this._heightBrushLiftDisplay, state.lift || {});
    }
  }

  _syncTextureLayerControl() {
    if (!this._textureLayerRoot) return;
    const state = this._toolOptionState?.layerOpacity || { available: false };
    if (!state.available) {
      this._textureLayerRoot.hidden = true;
      return;
    }
    this._textureLayerRoot.hidden = false;
    if (this._textureLayerSlider) {
      if (state.min !== undefined) this._textureLayerSlider.min = String(state.min);
      if (state.max !== undefined) this._textureLayerSlider.max = String(state.max);
      if (state.step !== undefined) this._textureLayerSlider.step = String(state.step);
      if (state.value !== undefined) {
        const nextValue = String(state.value);
        if (this._textureLayerSlider.value !== nextValue) this._textureLayerSlider.value = nextValue;
      }
      this._applyDefaultValue(this._textureLayerSlider, state.defaultValue);
    }
    if (this._textureLayerDisplay) {
      this._syncDisplayValue(this._textureLayerDisplay, state);
    }
  }

  _syncTextureOffsetControls() {
    if (!this._textureOffsetRoot) return;
    const state = this._toolOptionState?.textureOffset || { available: false };
    if (!state.available) {
      this._textureOffsetRoot.hidden = true;
      return;
    }
    this._textureOffsetRoot.hidden = false;
    if (this._textureOffsetXSlider) {
      if (state.x?.min !== undefined) this._textureOffsetXSlider.min = String(state.x.min);
      if (state.x?.max !== undefined) this._textureOffsetXSlider.max = String(state.x.max);
      if (state.x?.step !== undefined) this._textureOffsetXSlider.step = String(state.x.step);
      if (state.x?.value !== undefined) {
        const nextX = String(state.x.value);
        if (this._textureOffsetXSlider.value !== nextX) this._textureOffsetXSlider.value = nextX;
      }
      this._applyDefaultValue(this._textureOffsetXSlider, state.x?.defaultValue);
      this._textureOffsetXSlider.disabled = !!state.x?.disabled || !!state.disabled;
    }
    if (this._textureOffsetYSlider) {
      if (state.y?.min !== undefined) this._textureOffsetYSlider.min = String(state.y.min);
      if (state.y?.max !== undefined) this._textureOffsetYSlider.max = String(state.y.max);
      if (state.y?.step !== undefined) this._textureOffsetYSlider.step = String(state.y.step);
      if (state.y?.value !== undefined) {
        const nextY = String(state.y.value);
        if (this._textureOffsetYSlider.value !== nextY) this._textureOffsetYSlider.value = nextY;
      }
      this._applyDefaultValue(this._textureOffsetYSlider, state.y?.defaultValue);
      this._textureOffsetYSlider.disabled = !!state.y?.disabled || !!state.disabled;
    }
    if (this._textureOffsetXDisplay) {
      this._syncDisplayValue(this._textureOffsetXDisplay, state.x || {}, { disabled: state.disabled });
    }
    if (this._textureOffsetYDisplay) {
      this._syncDisplayValue(this._textureOffsetYDisplay, state.y || {}, { disabled: state.disabled });
    }
  }

  _bindPathAppearanceControls() {
    this._bindPathOpacityControl();
    this._bindPathScaleControl();
    this._bindPathOffsetControls();
    this._bindPathTensionControls();
    this._bindPathSimplifyControls();
    this._bindShowWidthTangentsControls();
    this._syncPathAppearanceControls();
  }

  _unbindPathAppearanceControls() {
    this._unbindPathOpacityControl();
    this._unbindPathScaleControl();
    this._unbindPathOffsetControls();
    this._unbindPathTensionControls();
    this._unbindPathSimplifyControls();
    this._unbindShowWidthTangentsControls();
  }

  _syncPathAppearanceControls() {
    this._syncPathOpacityControl();
    this._syncPathScaleControl();
    this._syncPathOffsetControls();
    this._syncPathTensionControls();
    this._syncPathSimplifyControls();
    this._syncShowWidthTangentsControls();
  }

  _bindFillTextureControls() {
    const state = this._toolOptionState?.fillTexture?.offset || { available: false };
    if (!state?.available) {
      this._unbindFillTextureControls();
      return;
    }
    const root = this.element?.querySelector('[data-fa-nexus-fill-offset-root]') || null;
    if (!root) {
      this._unbindFillTextureControls();
      return;
    }
    this._fillTextureOffsetRoot = root;
    const xSlider = root.querySelector('[data-fa-nexus-fill-offset-x]');
    if (xSlider) {
      xSlider.addEventListener('input', this._boundFillTextureOffsetXInput);
      xSlider.addEventListener('change', this._boundFillTextureOffsetXCommit);
      this._fillTextureOffsetXSlider = xSlider;
    }
    const ySlider = root.querySelector('[data-fa-nexus-fill-offset-y]');
    if (ySlider) {
      ySlider.addEventListener('input', this._boundFillTextureOffsetYInput);
      ySlider.addEventListener('change', this._boundFillTextureOffsetYCommit);
      this._fillTextureOffsetYSlider = ySlider;
    }
    this._fillTextureOffsetXDisplay = root.querySelector('[data-fa-nexus-fill-offset-x-display]') || null;
    this._fillTextureOffsetYDisplay = root.querySelector('[data-fa-nexus-fill-offset-y-display]') || null;
    this._bindDisplayInput(this._fillTextureOffsetXDisplay, this._boundFillTextureOffsetXInput, this._boundFillTextureOffsetXCommit);
    this._bindDisplayInput(this._fillTextureOffsetYDisplay, this._boundFillTextureOffsetYInput, this._boundFillTextureOffsetYCommit);
    this._syncFillTextureControls();
  }

  _unbindFillTextureControls() {
    if (this._fillTextureOffsetXSlider) {
      try {
        this._fillTextureOffsetXSlider.removeEventListener('input', this._boundFillTextureOffsetXInput);
        this._fillTextureOffsetXSlider.removeEventListener('change', this._boundFillTextureOffsetXCommit);
      } catch (_) {}
    }
    if (this._fillTextureOffsetYSlider) {
      try {
        this._fillTextureOffsetYSlider.removeEventListener('input', this._boundFillTextureOffsetYInput);
        this._fillTextureOffsetYSlider.removeEventListener('change', this._boundFillTextureOffsetYCommit);
      } catch (_) {}
    }
    this._unbindDisplayInput(this._fillTextureOffsetXDisplay, this._boundFillTextureOffsetXInput, this._boundFillTextureOffsetXCommit);
    this._unbindDisplayInput(this._fillTextureOffsetYDisplay, this._boundFillTextureOffsetYInput, this._boundFillTextureOffsetYCommit);
    this._fillTextureOffsetRoot = null;
    this._fillTextureOffsetXSlider = null;
    this._fillTextureOffsetYSlider = null;
    this._fillTextureOffsetXDisplay = null;
    this._fillTextureOffsetYDisplay = null;
  }

  _syncFillTextureControls() {
    if (!this._fillTextureOffsetRoot) return;
    const state = this._toolOptionState?.fillTexture?.offset || { available: false };
    if (!state.available) {
      this._fillTextureOffsetRoot.hidden = true;
      return;
    }
    this._fillTextureOffsetRoot.hidden = false;
    if (this._fillTextureOffsetXSlider) {
      if (state.x?.min !== undefined) this._fillTextureOffsetXSlider.min = String(state.x.min);
      if (state.x?.max !== undefined) this._fillTextureOffsetXSlider.max = String(state.x.max);
      if (state.x?.step !== undefined) this._fillTextureOffsetXSlider.step = String(state.x.step);
      if (state.x?.value !== undefined) {
        const nextX = String(state.x.value);
        if (this._fillTextureOffsetXSlider.value !== nextX) this._fillTextureOffsetXSlider.value = nextX;
      }
      this._applyDefaultValue(this._fillTextureOffsetXSlider, state.x?.defaultValue);
      this._fillTextureOffsetXSlider.disabled = !!state.x?.disabled || !!state.disabled;
    }
    if (this._fillTextureOffsetYSlider) {
      if (state.y?.min !== undefined) this._fillTextureOffsetYSlider.min = String(state.y.min);
      if (state.y?.max !== undefined) this._fillTextureOffsetYSlider.max = String(state.y.max);
      if (state.y?.step !== undefined) this._fillTextureOffsetYSlider.step = String(state.y.step);
      if (state.y?.value !== undefined) {
        const nextY = String(state.y.value);
        if (this._fillTextureOffsetYSlider.value !== nextY) this._fillTextureOffsetYSlider.value = nextY;
      }
      this._applyDefaultValue(this._fillTextureOffsetYSlider, state.y?.defaultValue);
      this._fillTextureOffsetYSlider.disabled = !!state.y?.disabled || !!state.disabled;
    }
    if (this._fillTextureOffsetXDisplay) {
      this._syncDisplayValue(this._fillTextureOffsetXDisplay, state.x || {}, { disabled: state.disabled });
    }
    if (this._fillTextureOffsetYDisplay) {
      this._syncDisplayValue(this._fillTextureOffsetYDisplay, state.y || {}, { disabled: state.disabled });
    }
  }

  _bindFillElevationControl() {
    const state = this._toolOptionState?.fillElevation || {};
    if (!state?.available) {
      this._unbindFillElevationControl();
      return;
    }
    const root = this.element?.querySelector('[data-fa-nexus-fill-elevation-root]') || null;
    if (!root) {
      if (!this._fillElevationLogState.missingRootLogged) {
        Logger.warn?.('ToolOptions.fillElevation.rootMissing', {
          available: !!state.available,
          hasTemplateInput: !!this.element?.querySelector('[data-fa-nexus-fill-elevation-input]'),
          layoutRevision: this._toolOptionState?.layoutRevision ?? null
        });
        this._fillElevationLogState.missingRootLogged = true;
      }
      if (!this._fillElevationRerenderJob && this.rendered) {
        this._fillElevationRerenderJob = setTimeout(() => {
          this._fillElevationRerenderJob = null;
          try {
            Logger.info?.('ToolOptions.fillElevation.forceRerender', {
              layoutRevision: this._toolOptionState?.layoutRevision ?? null
            });
            this.render(false);
          } catch (_) {}
        }, 0);
      }
      this._unbindFillElevationControl();
      return;
    }
    if (this._fillElevationRerenderJob) {
      clearTimeout(this._fillElevationRerenderJob);
      this._fillElevationRerenderJob = null;
    }
    this._fillElevationLogState.missingRootLogged = false;
    this._fillElevationRoot = root;
    const input = root.querySelector('[data-fa-nexus-fill-elevation-input]') || null;
    if (input) {
      input.addEventListener('input', this._boundFillElevationInput);
      input.addEventListener('change', this._boundFillElevationCommit);
    }
    this._fillElevationInput = input;
    this._fillElevationDisplay = root.querySelector('[data-fa-nexus-fill-elevation-display]') || null;
  }

  _unbindFillElevationControl() {
    if (this._fillElevationInput) {
      try { this._fillElevationInput.removeEventListener('input', this._boundFillElevationInput); } catch (_) {}
      try { this._fillElevationInput.removeEventListener('change', this._boundFillElevationCommit); } catch (_) {}
    }
    this._fillElevationRoot = null;
    this._fillElevationInput = null;
    this._fillElevationDisplay = null;
  }

  _syncFillElevationControl() {
    if (!this._fillElevationRoot) return;
    const state = this._toolOptionState?.fillElevation || { available: false };
    const available = !!state.available;
    if (this._fillElevationLogState.lastAvailableState !== available) {
      Logger.info?.('ToolOptions.fillElevation.stateChanged', {
        available,
        disabled: !!state.disabled,
        layoutRevision: this._toolOptionState?.layoutRevision ?? null
      });
      this._fillElevationLogState.lastAvailableState = available;
    }
    if (!available) {
      this._fillElevationRoot.hidden = true;
      return;
    }
    this._fillElevationRoot.hidden = false;
    if (this._fillElevationInput) {
      if (state.min !== undefined) this._fillElevationInput.min = String(state.min);
      if (state.max !== undefined) this._fillElevationInput.max = String(state.max);
      if (state.step !== undefined) this._fillElevationInput.step = String(state.step);
      if (state.value !== undefined) {
        const next = String(state.value);
        if (this._fillElevationInput.value !== next) this._fillElevationInput.value = next;
      }
      this._applyDefaultValue(this._fillElevationInput, state.defaultValue);
      this._fillElevationInput.disabled = !!state.disabled;
    }
    if (this._fillElevationDisplay) {
      const text = state.display || '';
      if (this._fillElevationDisplay.textContent !== text) this._fillElevationDisplay.textContent = text;
    }
  }

  _bindPathOpacityControl() {
    const root = this.element?.querySelector('[data-fa-nexus-path-opacity-root]') || null;
    if (!root) {
      this._unbindPathOpacityControl();
      return;
    }
    this._pathOpacityRoot = root;
    const slider = root.querySelector('[data-fa-nexus-path-opacity]') || null;
    if (slider) {
      slider.addEventListener('input', this._boundPathOpacityInput);
      slider.addEventListener('change', this._boundPathOpacityCommit);
    }
    this._pathOpacitySlider = slider;
    this._pathOpacityDisplay = root.querySelector('[data-fa-nexus-path-opacity-display]') || null;
    this._bindDisplayInput(this._pathOpacityDisplay, this._boundPathOpacityInput, this._boundPathOpacityCommit);
  }

  _unbindPathOpacityControl() {
    if (this._pathOpacitySlider) {
      try { this._pathOpacitySlider.removeEventListener('input', this._boundPathOpacityInput); } catch (_) {}
      try { this._pathOpacitySlider.removeEventListener('change', this._boundPathOpacityCommit); } catch (_) {}
    }
    this._unbindDisplayInput(this._pathOpacityDisplay, this._boundPathOpacityInput, this._boundPathOpacityCommit);
    this._pathOpacityRoot = null;
    this._pathOpacitySlider = null;
    this._pathOpacityDisplay = null;
  }

  _syncPathOpacityControl() {
    if (!this._pathOpacityRoot) return;
    const state = this._toolOptionState?.pathAppearance?.layerOpacity || { available: false };
    if (!state.available) {
      this._pathOpacityRoot.hidden = true;
      return;
    }
    this._pathOpacityRoot.hidden = false;
    if (this._pathOpacitySlider) {
      if (state.min !== undefined) this._pathOpacitySlider.min = String(state.min);
      if (state.max !== undefined) this._pathOpacitySlider.max = String(state.max);
      if (state.step !== undefined) this._pathOpacitySlider.step = String(state.step);
      if (state.value !== undefined) {
        const next = String(state.value);
        if (this._pathOpacitySlider.value !== next) this._pathOpacitySlider.value = next;
      }
      this._applyDefaultValue(this._pathOpacitySlider, state.defaultValue);
      this._pathOpacitySlider.disabled = !!state.disabled;
    }
    if (this._pathOpacityDisplay) {
      this._syncDisplayValue(this._pathOpacityDisplay, state);
    }
  }

  _handlePathOpacity(event, commit) {
    const slider = event?.currentTarget || event?.target;
    if (!slider) return;
    const value = slider.value;
    const controller = this._controller;
    if (!controller?.invokeToolHandler) return;
    try {
      const result = controller.invokeToolHandler('setLayerOpacity', value, !!commit);
      if (result?.then) result.catch(() => {}).finally(() => this._syncPathOpacityControl());
      else this._syncPathOpacityControl();
    } catch (_) {
      this._syncPathOpacityControl();
    }
  }

  _bindPathScaleControl() {
    const root = this.element?.querySelector('[data-fa-nexus-path-scale-root]') || null;
    if (!root) {
      this._unbindPathScaleControl();
      return;
    }
    this._pathScaleRoot = root;
    const slider = root.querySelector('[data-fa-nexus-path-scale]') || null;
    if (slider) {
      slider.addEventListener('input', this._boundPathScaleInput);
      slider.addEventListener('change', this._boundPathScaleCommit);
    }
    this._pathScaleSlider = slider;
    this._pathScaleDisplay = root.querySelector('[data-fa-nexus-path-scale-display]') || null;
    this._bindDisplayInput(this._pathScaleDisplay, this._boundPathScaleInput, this._boundPathScaleCommit);
  }

  _unbindPathScaleControl() {
    if (this._pathScaleSlider) {
      try { this._pathScaleSlider.removeEventListener('input', this._boundPathScaleInput); } catch (_) {}
      try { this._pathScaleSlider.removeEventListener('change', this._boundPathScaleCommit); } catch (_) {}
    }
    this._unbindDisplayInput(this._pathScaleDisplay, this._boundPathScaleInput, this._boundPathScaleCommit);
    this._pathScaleRoot = null;
    this._pathScaleSlider = null;
    this._pathScaleDisplay = null;
  }

  _syncPathScaleControl() {
    if (!this._pathScaleRoot) return;
    const state = this._toolOptionState?.pathAppearance?.scale || { available: false };
    if (!state.available) {
      this._pathScaleRoot.hidden = true;
      return;
    }
    this._pathScaleRoot.hidden = false;
    if (this._pathScaleSlider) {
      if (state.min !== undefined) this._pathScaleSlider.min = String(state.min);
      if (state.max !== undefined) this._pathScaleSlider.max = String(state.max);
      if (state.step !== undefined) this._pathScaleSlider.step = String(state.step);
      if (state.value !== undefined) {
        const next = String(state.value);
        if (this._pathScaleSlider.value !== next) this._pathScaleSlider.value = next;
      }
      this._applyDefaultValue(this._pathScaleSlider, state.defaultValue);
      this._pathScaleSlider.disabled = !!state.disabled;
    }
    if (this._pathScaleDisplay) {
      this._syncDisplayValue(this._pathScaleDisplay, state);
    }
  }

  _handlePathScale(event, commit) {
    const slider = event?.currentTarget || event?.target;
    if (!slider) return;
    const value = slider.value;
    const controller = this._controller;
    if (!controller?.invokeToolHandler) return;
    try {
      const result = controller.invokeToolHandler('setPathScale', value, !!commit);
      if (result?.then) result.catch(() => {}).finally(() => this._syncPathScaleControl());
      else this._syncPathScaleControl();
    } catch (_) {
      this._syncPathScaleControl();
    }
  }

  _handlePathScaleWheel(event) {
    if (!event) return;
    const slider = event.currentTarget || this._pathScaleSlider;
    if (!slider || slider.disabled) return;
    event.preventDefault?.();
    event.stopPropagation?.();
    event.stopImmediatePropagation?.();
    const state = this._toolOptionState?.pathAppearance?.scale || {};
    const min = Number(slider.min ?? state.min ?? 0);
    const max = Number(slider.max ?? state.max ?? 0);
    const rawStep = Number(slider.step ?? state.step ?? 1);
    const baseStep = Number.isFinite(rawStep) && rawStep > 0 ? rawStep : 1;
    const fine = event.ctrlKey || event.metaKey;
    const coarse = event.shiftKey;
    const step = Math.max(0.01, (fine ? baseStep / 10 : baseStep) * (coarse ? 5 : 1));
    const current = Number(slider.value);
    const safeCurrent = Number.isFinite(current) ? current : Number(state.value ?? min) || min;
    const direction = event.deltaY < 0 ? 1 : -1;
    const clamp = (val, lo, hi) => Math.min(hi, Math.max(lo, val));
    const nextValue = clamp(Math.round((safeCurrent + (direction * step)) * 100) / 100, Number.isFinite(min) ? min : safeCurrent, Number.isFinite(max) && max > 0 ? max : safeCurrent);
    slider.value = String(nextValue);
    this._handlePathScale({ currentTarget: slider }, true);
  }

  _handleFillElevation(event, commit) {
    const input = event?.currentTarget || event?.target;
    if (!input) return;
    const value = input.value;
    const controller = this._controller;
    if (!controller?.invokeToolHandler) return;
    try {
      const result = controller.invokeToolHandler('setFillElevation', value, !!commit);
      if (result?.then) result.catch(() => {}).finally(() => this._syncFillElevationControl());
      else this._syncFillElevationControl();
    } catch (_) {
      this._syncFillElevationControl();
    }
  }

  _handleFillElevationWheel(event) {
    if (!event) return;
    if (!event.altKey) return;
    if (!this._fillElevationInput || this._fillElevationInput.disabled) return;
    event.preventDefault?.();
    event.stopPropagation?.();
    event.stopImmediatePropagation?.();
    const state = this._toolOptionState?.fillElevation || {};
    const baseStep = Number(state.step) || 0.01;
    const fine = event.ctrlKey || event.metaKey;
    const coarseMultiplier = event.shiftKey ? 5 : 1;
    const step = Math.max(0.001, (fine ? baseStep / 10 : baseStep) * coarseMultiplier);
    const current = Number(this._fillElevationInput.value);
    const safeCurrent = Number.isFinite(current) ? current : 0;
    const direction = event.deltaY < 0 ? 1 : -1;
    const nextValue = Math.round((safeCurrent + (direction * step)) * 100) / 100;
    this._fillElevationInput.value = String(nextValue);
    this._handleFillElevation({ currentTarget: this._fillElevationInput }, true);
  }

  _bindPathOffsetControls() {
    const root = this.element?.querySelector('[data-fa-nexus-path-offset-root]') || null;
    if (!root) {
      this._unbindPathOffsetControls();
      return;
    }
    this._pathOffsetRoot = root;
    const xSlider = root.querySelector('[data-fa-nexus-path-offset-x]') || null;
    if (xSlider) {
      xSlider.addEventListener('input', this._boundPathOffsetXInput);
      xSlider.addEventListener('change', this._boundPathOffsetXCommit);
    }
    this._pathOffsetXSlider = xSlider;
    const ySlider = root.querySelector('[data-fa-nexus-path-offset-y]') || null;
    if (ySlider) {
      ySlider.addEventListener('input', this._boundPathOffsetYInput);
      ySlider.addEventListener('change', this._boundPathOffsetYCommit);
    }
    this._pathOffsetYSlider = ySlider;
    this._pathOffsetXDisplay = root.querySelector('[data-fa-nexus-path-offset-x-display]') || null;
    this._pathOffsetYDisplay = root.querySelector('[data-fa-nexus-path-offset-y-display]') || null;
    this._bindDisplayInput(this._pathOffsetXDisplay, this._boundPathOffsetXInput, this._boundPathOffsetXCommit);
    this._bindDisplayInput(this._pathOffsetYDisplay, this._boundPathOffsetYInput, this._boundPathOffsetYCommit);
  }

  _unbindPathOffsetControls() {
    if (this._pathOffsetXSlider) {
      try { this._pathOffsetXSlider.removeEventListener('input', this._boundPathOffsetXInput); } catch (_) {}
      try { this._pathOffsetXSlider.removeEventListener('change', this._boundPathOffsetXCommit); } catch (_) {}
    }
    if (this._pathOffsetYSlider) {
      try { this._pathOffsetYSlider.removeEventListener('input', this._boundPathOffsetYInput); } catch (_) {}
      try { this._pathOffsetYSlider.removeEventListener('change', this._boundPathOffsetYCommit); } catch (_) {}
    }
    this._unbindDisplayInput(this._pathOffsetXDisplay, this._boundPathOffsetXInput, this._boundPathOffsetXCommit);
    this._unbindDisplayInput(this._pathOffsetYDisplay, this._boundPathOffsetYInput, this._boundPathOffsetYCommit);
    this._pathOffsetRoot = null;
    this._pathOffsetXSlider = null;
    this._pathOffsetYSlider = null;
    this._pathOffsetXDisplay = null;
    this._pathOffsetYDisplay = null;
  }

  _syncPathOffsetControls() {
    if (!this._pathOffsetRoot) return;
    const state = this._toolOptionState?.pathAppearance?.textureOffset || { available: false };
    if (!state.available) {
      this._pathOffsetRoot.hidden = true;
      return;
    }
    this._pathOffsetRoot.hidden = false;
    if (this._pathOffsetXSlider) {
      const x = state.x || {};
      if (x.min !== undefined) this._pathOffsetXSlider.min = String(x.min);
      if (x.max !== undefined) this._pathOffsetXSlider.max = String(x.max);
      if (x.step !== undefined) this._pathOffsetXSlider.step = String(x.step);
      if (x.value !== undefined) {
        const next = String(x.value);
        if (this._pathOffsetXSlider.value !== next) this._pathOffsetXSlider.value = next;
      }
      this._applyDefaultValue(this._pathOffsetXSlider, x.defaultValue);
      this._pathOffsetXSlider.disabled = !!x.disabled || !!state.disabled;
    }
    if (this._pathOffsetYSlider) {
      const y = state.y || {};
      if (y.min !== undefined) this._pathOffsetYSlider.min = String(y.min);
      if (y.max !== undefined) this._pathOffsetYSlider.max = String(y.max);
      if (y.step !== undefined) this._pathOffsetYSlider.step = String(y.step);
      if (y.value !== undefined) {
        const next = String(y.value);
        if (this._pathOffsetYSlider.value !== next) this._pathOffsetYSlider.value = next;
      }
      this._applyDefaultValue(this._pathOffsetYSlider, y.defaultValue);
      this._pathOffsetYSlider.disabled = !!y.disabled || !!state.disabled;
    }
    if (this._pathOffsetXDisplay) {
      this._syncDisplayValue(this._pathOffsetXDisplay, state.x || {}, { disabled: state.disabled });
    }
    if (this._pathOffsetYDisplay) {
      this._syncDisplayValue(this._pathOffsetYDisplay, state.y || {}, { disabled: state.disabled });
    }
  }

  _handlePathOffset(event, axis, commit) {
    const slider = event?.currentTarget || event?.target;
    if (!slider) return;
    const value = slider.value;
    const controller = this._controller;
    if (!controller?.invokeToolHandler) return;
    try {
      const result = controller.invokeToolHandler('setTextureOffset', axis, value, !!commit);
      if (result?.then) result.catch(() => {}).finally(() => this._syncPathOffsetControls());
      else this._syncPathOffsetControls();
    } catch (_) {
      this._syncPathOffsetControls();
    }
  }

  _bindPathTensionControls() {
    const root = this.element?.querySelector('[data-fa-nexus-path-tension-root]') || null;
    if (!root) {
      this._unbindPathTensionControls();
      return;
    }
    this._pathTensionRoot = root;
    const slider = root.querySelector('[data-fa-nexus-path-tension]') || null;
    if (slider) {
      slider.addEventListener('input', this._boundPathTensionInput);
      slider.addEventListener('change', this._boundPathTensionCommit);
    }
    this._pathTensionSlider = slider;
    this._pathTensionDisplay = root.querySelector('[data-fa-nexus-path-tension-display]') || null;
    this._bindDisplayInput(this._pathTensionDisplay, this._boundPathTensionInput, this._boundPathTensionCommit);
  }

  _unbindPathTensionControls() {
    if (this._pathTensionSlider) {
      try { this._pathTensionSlider.removeEventListener('input', this._boundPathTensionInput); } catch (_) {}
      try { this._pathTensionSlider.removeEventListener('change', this._boundPathTensionCommit); } catch (_) {}
    }
    this._unbindDisplayInput(this._pathTensionDisplay, this._boundPathTensionInput, this._boundPathTensionCommit);
    this._pathTensionRoot = null;
    this._pathTensionSlider = null;
    this._pathTensionDisplay = null;
  }

  _syncPathTensionControls() {
    if (!this._pathTensionRoot) return;
    const state = this._toolOptionState?.pathAppearance?.tension || { available: false };
    if (!state.available) {
      this._pathTensionRoot.hidden = true;
      return;
    }
    this._pathTensionRoot.hidden = false;
    if (this._pathTensionSlider) {
      if (state.min !== undefined) this._pathTensionSlider.min = String(state.min);
      if (state.max !== undefined) this._pathTensionSlider.max = String(state.max);
      if (state.step !== undefined) this._pathTensionSlider.step = String(state.step);
      if (state.value !== undefined) {
        const next = String(state.value);
        if (this._pathTensionSlider.value !== next) this._pathTensionSlider.value = next;
      }
      this._applyDefaultValue(this._pathTensionSlider, state.defaultValue);
      this._pathTensionSlider.disabled = !!state.disabled;
    }
    if (this._pathTensionDisplay) {
      this._syncDisplayValue(this._pathTensionDisplay, state);
    }
  }

  _handlePathTension(event, commit) {
    const slider = event?.currentTarget || event?.target;
    if (!slider) return;
    const value = slider.value;
    const controller = this._controller;
    if (!controller?.invokeToolHandler) return;
    try {
      const result = controller.invokeToolHandler('setPathTensionValue', value, !!commit);
      if (result?.then) result.catch(() => {}).finally(() => this._syncPathTensionControls());
      else this._syncPathTensionControls();
    } catch (_) {
      this._syncPathTensionControls();
    }
  }

  _bindPathSimplifyControls() {
    const root = this.element?.querySelector('[data-fa-nexus-path-simplify-root]') || null;
    if (!root) {
      this._unbindPathSimplifyControls();
      return;
    }
    this._pathSimplifyRoot = root;
    const slider = root.querySelector('[data-fa-nexus-path-simplify]') || null;
    if (slider) {
      slider.addEventListener('input', this._boundPathSimplifyInput);
      slider.addEventListener('change', this._boundPathSimplifyCommit);
    }
    this._pathSimplifySlider = slider;
    this._pathSimplifyDisplay = root.querySelector('[data-fa-nexus-path-simplify-display]') || null;
    this._bindDisplayInput(this._pathSimplifyDisplay, this._boundPathSimplifyInput, this._boundPathSimplifyCommit);
  }

  _unbindPathSimplifyControls() {
    if (this._pathSimplifySlider) {
      try { this._pathSimplifySlider.removeEventListener('input', this._boundPathSimplifyInput); } catch (_) {}
      try { this._pathSimplifySlider.removeEventListener('change', this._boundPathSimplifyCommit); } catch (_) {}
    }
    this._unbindDisplayInput(this._pathSimplifyDisplay, this._boundPathSimplifyInput, this._boundPathSimplifyCommit);
    this._pathSimplifyRoot = null;
    this._pathSimplifySlider = null;
    this._pathSimplifyDisplay = null;
  }

  _syncPathSimplifyControls() {
    if (!this._pathSimplifyRoot) return;
    const state = this._toolOptionState?.pathAppearance?.freehandSimplify || { available: false };
    if (!state.available) {
      this._pathSimplifyRoot.hidden = true;
      return;
    }
    this._pathSimplifyRoot.hidden = false;
    if (this._pathSimplifySlider) {
      if (state.min !== undefined) this._pathSimplifySlider.min = String(state.min);
      if (state.max !== undefined) this._pathSimplifySlider.max = String(state.max);
      if (state.step !== undefined) this._pathSimplifySlider.step = String(state.step);
      if (state.value !== undefined) {
        const next = String(state.value);
        if (this._pathSimplifySlider.value !== next) this._pathSimplifySlider.value = next;
      }
      this._applyDefaultValue(this._pathSimplifySlider, state.defaultValue);
      this._pathSimplifySlider.disabled = !!state.disabled;
    }
    if (this._pathSimplifyDisplay) {
      this._syncDisplayValue(this._pathSimplifyDisplay, state);
    }
  }

  _handlePathSimplify(event, commit) {
    const slider = event?.currentTarget || event?.target;
    if (!slider) return;
    const value = slider.value;
    const controller = this._controller;
    if (!controller?.invokeToolHandler) return;
    try {
      const result = controller.invokeToolHandler('setFreehandSimplify', value, !!commit);
      if (result?.then) result.catch(() => {}).finally(() => this._syncPathSimplifyControls());
      else this._syncPathSimplifyControls();
    } catch (_) {
      this._syncPathSimplifyControls();
    }
  }

  _bindShowWidthTangentsControls() {
    const root = this.element?.querySelector('[data-fa-nexus-show-width-tangents-root]') || null;
    if (!root) {
      this._unbindShowWidthTangentsControls();
      return;
    }
    this._showWidthTangentsRoot = root;
    const toggle = root.querySelector('[data-fa-nexus-show-width-tangents]') || null;
    if (toggle) {
      toggle.addEventListener('change', this._boundShowWidthTangentsChange);
    }
    this._showWidthTangentsToggle = toggle;
  }

  _unbindShowWidthTangentsControls() {
    if (this._showWidthTangentsToggle) {
      try { this._showWidthTangentsToggle.removeEventListener('change', this._boundShowWidthTangentsChange); } catch (_) {}
    }
    this._showWidthTangentsRoot = null;
    this._showWidthTangentsToggle = null;
  }

  _syncShowWidthTangentsControls() {
    if (!this._showWidthTangentsRoot) return;
    const state = this._toolOptionState?.pathAppearance?.showWidthTangents || { available: false };
    if (!state.available) {
      this._showWidthTangentsRoot.hidden = true;
      return;
    }
    this._showWidthTangentsRoot.hidden = false;
    if (this._showWidthTangentsToggle) {
      this._showWidthTangentsToggle.checked = !!state.enabled;
      this._showWidthTangentsToggle.disabled = !!state.disabled;
    }
  }

  _handleShowWidthTangentsChange(event) {
    const toggle = event?.currentTarget || event?.target;
    if (!toggle) return;
    const enabled = toggle.checked;
    const controller = this._controller;
    if (!controller?.invokeToolHandler) return;
    try {
      const result = controller.invokeToolHandler('setShowWidthTangents', enabled);
      if (result?.then) result.catch(() => {}).finally(() => this._syncShowWidthTangentsControls());
      else this._syncShowWidthTangentsControls();
    } catch (_) {
      this._syncShowWidthTangentsControls();
    }
  }

  _handleTextureOpacity(event, commit) {
    const slider = event?.currentTarget || event?.target;
    if (!slider) return;
    const value = slider.value;
    const controller = this._controller;
    if (!controller?.invokeToolHandler) return;
    try {
      const result = controller.invokeToolHandler('setTextureOpacity', value, !!commit);
      if (result?.then) {
        result.catch(() => {}).finally(() => this._syncTextureOpacityControl());
      } else {
        this._syncTextureOpacityControl();
      }
    } catch (_) {
      this._syncTextureOpacityControl();
    }
  }

  _handleTextureOffset(event, axis, commit) {
    const slider = event?.currentTarget || event?.target;
    if (!slider) return;
    const value = slider.value;
    const controller = this._controller;
    if (!controller?.invokeToolHandler) return;
    try {
      const result = controller.invokeToolHandler('setTextureOffset', axis, value, !!commit);
      if (result?.then) {
        result.catch(() => {}).finally(() => this._syncTextureOffsetControls());
      } else {
        this._syncTextureOffsetControls();
      }
    } catch (_) {
      this._syncTextureOffsetControls();
    }
  }

  _handleFillTextureOffset(event, axis, commit) {
    const slider = event?.currentTarget || event?.target;
    if (!slider) return;
    const value = slider.value;
    const controller = this._controller;
    if (!controller?.invokeToolHandler) return;
    try {
      const result = controller.invokeToolHandler('setFillTextureOffset', axis, value, !!commit);
      if (result?.then) {
        result.catch(() => {}).finally(() => this._syncFillTextureControls());
      } else {
        this._syncFillTextureControls();
      }
    } catch (_) {
      this._syncFillTextureControls();
    }
  }

  _handleTextureLayerOpacity(event, commit) {
    const slider = event?.currentTarget || event?.target;
    if (!slider) return;
    const value = slider.value;
    const controller = this._controller;
    if (!controller?.invokeToolHandler) return;
    try {
      const result = controller.invokeToolHandler('setLayerOpacity', value, !!commit);
      if (result?.then) {
        result.catch(() => {}).finally(() => this._syncTextureLayerControl());
      } else {
        this._syncTextureLayerControl();
      }
    } catch (_) {
      this._syncTextureLayerControl();
    }
  }

  _bindFlipControls() {
    const root = this.element?.querySelector('[data-fa-nexus-flip-root]') || null;
    if (!root) {
      this._unbindFlipControls();
      return;
    }
    this._flipRoot = root;
    this._flipDisplay = root.querySelector('[data-fa-nexus-flip-display]') || null;
    this._flipPreviewDisplay = root.querySelector('[data-fa-nexus-flip-preview]') || null;

    const horizontalButton = root.querySelector('[data-fa-nexus-flip-horizontal]');
    if (horizontalButton) {
      horizontalButton.addEventListener('click', this._boundFlipHorizontal);
      this._flipHorizontalButton = horizontalButton;
    }
    const horizontalRandomButton = root.querySelector('[data-fa-nexus-flip-horizontal-random]');
    if (horizontalRandomButton) {
      horizontalRandomButton.addEventListener('click', this._boundFlipHorizontalRandom);
      this._flipHorizontalRandomButton = horizontalRandomButton;
    }
    const verticalButton = root.querySelector('[data-fa-nexus-flip-vertical]');
    if (verticalButton) {
      verticalButton.addEventListener('click', this._boundFlipVertical);
      this._flipVerticalButton = verticalButton;
    }
    const verticalRandomButton = root.querySelector('[data-fa-nexus-flip-vertical-random]');
    if (verticalRandomButton) {
      verticalRandomButton.addEventListener('click', this._boundFlipVerticalRandom);
      this._flipVerticalRandomButton = verticalRandomButton;
    }

    this._syncFlipControls();
  }

  _unbindFlipControls() {
    if (this._flipHorizontalButton) {
      try { this._flipHorizontalButton.removeEventListener('click', this._boundFlipHorizontal); } catch (_) {}
    }
    if (this._flipHorizontalRandomButton) {
      try { this._flipHorizontalRandomButton.removeEventListener('click', this._boundFlipHorizontalRandom); } catch (_) {}
    }
    if (this._flipVerticalButton) {
      try { this._flipVerticalButton.removeEventListener('click', this._boundFlipVertical); } catch (_) {}
    }
    if (this._flipVerticalRandomButton) {
      try { this._flipVerticalRandomButton.removeEventListener('click', this._boundFlipVerticalRandom); } catch (_) {}
    }
    this._flipRoot = null;
    this._flipDisplay = null;
    this._flipPreviewDisplay = null;
    this._flipHorizontalButton = null;
    this._flipVerticalButton = null;
    this._flipHorizontalRandomButton = null;
    this._flipVerticalRandomButton = null;
  }

  _syncFlipControls() {
    if (!this._flipRoot) return;
    const state = this._toolOptionState?.flip || {};
    if (!state.available) {
      this._flipRoot.hidden = true;
      return;
    }
    this._flipRoot.hidden = false;
    if (this._flipDisplay) {
      const text = state.display || 'None';
      if (this._flipDisplay.textContent !== text) this._flipDisplay.textContent = text;
    }
    if (this._flipPreviewDisplay) {
      const preview = state.previewDisplay || '';
      if (preview) {
        this._flipPreviewDisplay.textContent = preview;
        this._flipPreviewDisplay.hidden = false;
      } else {
        this._flipPreviewDisplay.textContent = '';
        this._flipPreviewDisplay.hidden = true;
      }
    }
    const horizontal = state.horizontal || {};
    const vertical = state.vertical || {};
    const syncAxisButton = (button, axisState) => {
      if (!button || !axisState) return;
      const active = !!axisState.active;
      const previewDiff = !!axisState.previewDiff;
      const aria = axisState.aria || axisState.label || 'Toggle mirroring';
      const tooltip = axisState.tooltip || '';
      button.classList.toggle('is-active', active);
      button.classList.toggle('has-preview-diff', previewDiff);
      button.setAttribute('aria-pressed', active ? 'true' : 'false');
      button.setAttribute('aria-label', aria);
      if (tooltip) button.title = tooltip;
      else button.removeAttribute('title');
      button.disabled = !!axisState.disabled;
      const labelSpan = button.querySelector('span');
      if (labelSpan && axisState.label && labelSpan.textContent !== axisState.label) {
        labelSpan.textContent = axisState.label;
      }
    };
    const syncAxisRandomButton = (button, axisState, defaultAria) => {
      if (!button || !axisState) return;
      const enabled = !!axisState.randomEnabled;
      const label = axisState.randomLabel || 'Random';
      const tooltip = axisState.randomTooltip || '';
      const aria = axisState.randomAria || defaultAria;
      button.classList.toggle('is-active', enabled);
      button.classList.toggle('has-preview-diff', !!axisState.randomPreviewDiff);
      button.setAttribute('aria-pressed', enabled ? 'true' : 'false');
      button.setAttribute('aria-label', aria);
      if (tooltip) button.title = tooltip;
      else button.removeAttribute('title');
      button.disabled = !!axisState.randomDisabled;
      const labelSpan = button.querySelector('span');
      if (labelSpan && labelSpan.textContent !== label) {
        labelSpan.textContent = label;
      }
    };

    if (this._flipHorizontalButton) {
      syncAxisButton(this._flipHorizontalButton, horizontal);
    }
    if (this._flipHorizontalRandomButton) {
      syncAxisRandomButton(this._flipHorizontalRandomButton, horizontal, 'Toggle random horizontal mirroring');
    }
    if (this._flipVerticalButton) {
      syncAxisButton(this._flipVerticalButton, vertical);
    }
    if (this._flipVerticalRandomButton) {
      syncAxisRandomButton(this._flipVerticalRandomButton, vertical, 'Toggle random vertical mirroring');
    }
  }

  _bindScaleControls() {
    const root = this.element?.querySelector('[data-fa-nexus-scale-root]') || null;
    if (!root) {
      this._unbindScaleControls();
      return;
    }
    this._scaleRoot = root;
    this._scaleDisplay = root.querySelector('[data-fa-nexus-scale-display]') || null;
    this._bindDisplayInput(this._scaleDisplay, this._boundScaleInput, this._boundScaleInput);

    const baseSlider = root.querySelector('[data-fa-nexus-scale-base]');
    if (baseSlider) {
      baseSlider.addEventListener('input', this._boundScaleInput);
      baseSlider.addEventListener('change', this._boundScaleInput);
      this._scaleBaseSlider = baseSlider;
    }

    const randomButton = root.querySelector('[data-fa-nexus-scale-random]');
    if (randomButton) {
      randomButton.addEventListener('click', this._boundScaleRandom);
      this._scaleRandomButton = randomButton;
    }

    const strengthRow = root.querySelector('[data-fa-nexus-scale-strength-row]') || null;
    this._scaleStrengthRow = strengthRow;

    const strengthSlider = root.querySelector('[data-fa-nexus-scale-strength]');
    if (strengthSlider) {
      strengthSlider.addEventListener('input', this._boundScaleStrength);
      strengthSlider.addEventListener('change', this._boundScaleStrength);
      this._scaleStrengthSlider = strengthSlider;
    }
    this._scaleStrengthDisplay = root.querySelector('[data-fa-nexus-scale-strength-label]') || null;
    this._bindDisplayInput(this._scaleStrengthDisplay, this._boundScaleStrength, this._boundScaleStrength);

    this._syncScaleControls();
  }

  _unbindScaleControls() {
    if (this._scaleBaseSlider) {
      try {
        this._scaleBaseSlider.removeEventListener('input', this._boundScaleInput);
        this._scaleBaseSlider.removeEventListener('change', this._boundScaleInput);
      } catch (_) {}
    }
    if (this._scaleStrengthSlider) {
      try {
        this._scaleStrengthSlider.removeEventListener('input', this._boundScaleStrength);
        this._scaleStrengthSlider.removeEventListener('change', this._boundScaleStrength);
      } catch (_) {}
    }
    this._unbindDisplayInput(this._scaleDisplay, this._boundScaleInput, this._boundScaleInput);
    this._unbindDisplayInput(this._scaleStrengthDisplay, this._boundScaleStrength, this._boundScaleStrength);
    if (this._scaleRandomButton) {
      try { this._scaleRandomButton.removeEventListener('click', this._boundScaleRandom); }
      catch (_) {}
    }
    this._scaleRoot = null;
    this._scaleDisplay = null;
    this._scaleBaseSlider = null;
    this._scaleRandomButton = null;
    this._scaleStrengthRow = null;
    this._scaleStrengthSlider = null;
    this._scaleStrengthDisplay = null;
  }

  _syncScaleControls() {
    if (!this._scaleRoot) return;
    const state = this._toolOptionState?.scale || {};
    if (this._scaleDisplay) {
      this._syncDisplayValue(this._scaleDisplay, state);
    }
    if (this._scaleBaseSlider) {
      if (state.min !== undefined) this._scaleBaseSlider.min = String(state.min);
      if (state.max !== undefined) this._scaleBaseSlider.max = String(state.max);
      if (state.step !== undefined) this._scaleBaseSlider.step = String(state.step);
      if (state.value !== undefined) {
        const nextValue = String(state.value);
        if (this._scaleBaseSlider.value !== nextValue) this._scaleBaseSlider.value = nextValue;
      }
      this._applyDefaultValue(this._scaleBaseSlider, state.defaultValue);
      this._scaleBaseSlider.disabled = !!state.disabled;
    }
    const randomVisible = state.randomButtonVisible !== false;
    if (this._scaleRandomButton) {
      this._scaleRandomButton.hidden = !randomVisible;
      this._scaleRandomButton.classList.toggle('is-hidden', !randomVisible);
      const active = randomVisible && !!state.randomEnabled;
      this._scaleRandomButton.classList.toggle('is-active', active);
      this._scaleRandomButton.setAttribute('aria-pressed', active ? 'true' : 'false');
      this._scaleRandomButton.disabled = !randomVisible || !!state.disabled;
      if (state.randomTooltip) this._scaleRandomButton.title = state.randomTooltip;
      const labelSpan = this._scaleRandomButton.querySelector('span');
      if (labelSpan && state.randomLabel && labelSpan.textContent !== state.randomLabel) {
        labelSpan.textContent = state.randomLabel;
      }
    }
    const strengthVisible = randomVisible && !!state.randomEnabled;
    if (this._scaleStrengthRow) {
      this._scaleStrengthRow.hidden = !strengthVisible;
    }
    if (this._scaleStrengthSlider) {
      if (state.strengthMin !== undefined) this._scaleStrengthSlider.min = String(state.strengthMin);
      if (state.strengthMax !== undefined) this._scaleStrengthSlider.max = String(state.strengthMax);
      const step = state.strengthStep !== undefined ? state.strengthStep : 1;
      this._scaleStrengthSlider.step = String(step);
      if (state.strength !== undefined) {
        const nextStrength = String(state.strength);
        if (this._scaleStrengthSlider.value !== nextStrength) this._scaleStrengthSlider.value = nextStrength;
      }
      this._applyDefaultValue(this._scaleStrengthSlider, state.strengthDefault);
      this._scaleStrengthSlider.disabled = !strengthVisible;
    }
    if (this._scaleStrengthDisplay) {
      this._syncDisplayValue(this._scaleStrengthDisplay, {
        min: state.strengthMin,
        max: state.strengthMax,
        step: state.strengthStep,
        value: state.strength,
        display: state.strengthDisplay || '',
        defaultValue: state.strengthDefault
      });
    }
  }

  _handleFlipHorizontal(event) {
    if (event) {
      event.preventDefault?.();
      event.stopPropagation?.();
    }
    this._controller?.invokeToolHandler?.('toggleFlipHorizontal');
  }

  _handleFlipVertical(event) {
    if (event) {
      event.preventDefault?.();
      event.stopPropagation?.();
    }
    this._controller?.invokeToolHandler?.('toggleFlipVertical');
  }

  _handleFlipRandomHorizontal(event) {
    if (event) {
      event.preventDefault?.();
      event.stopPropagation?.();
    }
    this._controller?.invokeToolHandler?.('toggleFlipHorizontalRandom');
  }

  _handleFlipRandomVertical(event) {
    if (event) {
      event.preventDefault?.();
      event.stopPropagation?.();
    }
    this._controller?.invokeToolHandler?.('toggleFlipVerticalRandom');
  }

  _handleScaleInput(event) {
    const value = event?.currentTarget?.value ?? event?.target?.value;
    const commit = event?.type === 'change';
    if (this._controller?.invokeToolHandler) {
      try {
        const result = this._controller.invokeToolHandler('setScale', value, commit);
        if (result?.then) {
          result.catch(() => {}).finally(() => this._syncScaleControls());
        } else {
          this._syncScaleControls();
        }
      } catch (_) {
        this._syncScaleControls();
      }
    }
  }

  _handleScaleStrength(event) {
    const value = event?.currentTarget?.value ?? event?.target?.value;
    if (this._controller?.invokeToolHandler) {
      this._controller.invokeToolHandler('setScaleRandomStrength', value);
    }
  }

  _handleScaleRandom(event) {
    event?.preventDefault?.();
    if (this._controller?.invokeToolHandler) {
      this._controller.invokeToolHandler('toggleScaleRandom');
    }
  }

  _bindRotationControls() {
    const root = this.element?.querySelector('[data-fa-nexus-rotation-root]') || null;
    if (!root) {
      this._unbindRotationControls();
      return;
    }
    this._rotationRoot = root;
    this._rotationDisplay = root.querySelector('[data-fa-nexus-rotation-display]') || null;
    this._bindDisplayInput(this._rotationDisplay, this._boundRotationInput, this._boundRotationInput);

    const baseSlider = root.querySelector('[data-fa-nexus-rotation-base]');
    if (baseSlider) {
      baseSlider.addEventListener('input', this._boundRotationInput);
      baseSlider.addEventListener('change', this._boundRotationInput);
      this._rotationBaseSlider = baseSlider;
    }

    const randomButton = root.querySelector('[data-fa-nexus-rotation-random]');
    if (randomButton) {
      randomButton.addEventListener('click', this._boundRotationRandom);
      this._rotationRandomButton = randomButton;
    }

    const strengthRow = root.querySelector('[data-fa-nexus-rotation-strength-row]') || null;
    this._rotationStrengthRow = strengthRow;
    const strengthSlider = root.querySelector('[data-fa-nexus-rotation-strength]');
    if (strengthSlider) {
      strengthSlider.addEventListener('input', this._boundRotationStrength);
      strengthSlider.addEventListener('change', this._boundRotationStrength);
      this._rotationStrengthSlider = strengthSlider;
    }
    this._rotationStrengthDisplay = root.querySelector('[data-fa-nexus-rotation-strength-label]') || null;
    this._bindDisplayInput(this._rotationStrengthDisplay, this._boundRotationStrength, this._boundRotationStrength);

    this._syncRotationControls();
  }

  _unbindRotationControls() {
    if (this._rotationBaseSlider) {
      try {
        this._rotationBaseSlider.removeEventListener('input', this._boundRotationInput);
        this._rotationBaseSlider.removeEventListener('change', this._boundRotationInput);
      } catch (_) {}
    }
    if (this._rotationStrengthSlider) {
      try {
        this._rotationStrengthSlider.removeEventListener('input', this._boundRotationStrength);
        this._rotationStrengthSlider.removeEventListener('change', this._boundRotationStrength);
      } catch (_) {}
    }
    this._unbindDisplayInput(this._rotationDisplay, this._boundRotationInput, this._boundRotationInput);
    this._unbindDisplayInput(this._rotationStrengthDisplay, this._boundRotationStrength, this._boundRotationStrength);
    if (this._rotationRandomButton) {
      try { this._rotationRandomButton.removeEventListener('click', this._boundRotationRandom); }
      catch (_) {}
    }
    this._rotationRoot = null;
    this._rotationDisplay = null;
    this._rotationBaseSlider = null;
    this._rotationRandomButton = null;
    this._rotationStrengthRow = null;
    this._rotationStrengthSlider = null;
    this._rotationStrengthDisplay = null;
  }

  _syncRotationControls() {
    if (!this._rotationRoot) return;
    const state = this._toolOptionState?.rotation || {};
    if (this._rotationDisplay) {
      this._syncDisplayValue(this._rotationDisplay, state);
    }
    if (this._rotationBaseSlider) {
      if (state.min !== undefined) this._rotationBaseSlider.min = String(state.min);
      if (state.max !== undefined) this._rotationBaseSlider.max = String(state.max);
      if (state.step !== undefined) this._rotationBaseSlider.step = String(state.step);
      if (state.value !== undefined) {
        const nextValue = String(state.value);
        if (this._rotationBaseSlider.value !== nextValue) this._rotationBaseSlider.value = nextValue;
      }
      this._applyDefaultValue(this._rotationBaseSlider, state.defaultValue);
      this._rotationBaseSlider.disabled = !!state.disabled;
    }
    const randomVisible = state.randomButtonVisible !== false;
    if (this._rotationRandomButton) {
      this._rotationRandomButton.hidden = !randomVisible;
      this._rotationRandomButton.classList.toggle('is-hidden', !randomVisible);
      const active = randomVisible && !!state.randomEnabled;
      this._rotationRandomButton.classList.toggle('is-active', active);
      this._rotationRandomButton.setAttribute('aria-pressed', active ? 'true' : 'false');
      this._rotationRandomButton.disabled = !randomVisible || !!state.disabled;
      if (state.randomTooltip) this._rotationRandomButton.title = state.randomTooltip;
      const labelSpan = this._rotationRandomButton.querySelector('span');
      if (labelSpan && state.randomLabel && labelSpan.textContent !== state.randomLabel) {
        labelSpan.textContent = state.randomLabel;
      }
    }
    const strengthVisible = randomVisible && !!state.randomEnabled;
    if (this._rotationStrengthRow) {
      this._rotationStrengthRow.hidden = !strengthVisible;
    }
    if (this._rotationStrengthSlider) {
      if (state.strengthMin !== undefined) this._rotationStrengthSlider.min = String(state.strengthMin);
      if (state.strengthMax !== undefined) this._rotationStrengthSlider.max = String(state.strengthMax);
      const step = state.strengthStep !== undefined ? state.strengthStep : 1;
      this._rotationStrengthSlider.step = String(step);
      if (state.strength !== undefined) {
        const nextStrength = String(state.strength);
        if (this._rotationStrengthSlider.value !== nextStrength) this._rotationStrengthSlider.value = nextStrength;
      }
      this._applyDefaultValue(this._rotationStrengthSlider, state.strengthDefault);
      this._rotationStrengthSlider.disabled = !strengthVisible;
    }
    if (this._rotationStrengthDisplay) {
      this._syncDisplayValue(this._rotationStrengthDisplay, {
        min: state.strengthMin,
        max: state.strengthMax,
        step: state.strengthStep,
        value: state.strength,
        display: state.strengthDisplay || '',
        defaultValue: state.strengthDefault
      });
    }
  }

  _handleRotationInput(event) {
    const value = event?.currentTarget?.value ?? event?.target?.value;
    const commit = event?.type === 'change';
    if (this._controller?.invokeToolHandler) {
      try {
        const result = this._controller.invokeToolHandler('setRotation', value, commit);
        if (result?.then) {
          result.catch(() => {}).finally(() => this._syncRotationControls());
        } else {
          this._syncRotationControls();
        }
      } catch (_) {
        this._syncRotationControls();
      }
    }
  }

  _handleRotationStrength(event) {
    const value = event?.currentTarget?.value ?? event?.target?.value;
    if (this._controller?.invokeToolHandler) {
      this._controller.invokeToolHandler('setRotationRandomStrength', value);
    }
  }

  _handleRotationRandom(event) {
    event?.preventDefault?.();
    if (this._controller?.invokeToolHandler) {
      this._controller.invokeToolHandler('toggleRotationRandom');
    }
  }

  _bindPathShadowControls() {
    const root = this.element?.querySelector('[data-fa-nexus-path-shadow]') || null;
    if (!root) {
      this._unbindPathShadowControls();
      return;
    }
    if (this._pathShadowRoot === root) {
      this._syncPathShadowControls();
      return;
    }
    this._unbindPathShadowControls();
    this._pathShadowRoot = root;
    const toggle = root.querySelector('[data-fa-nexus-path-shadow-toggle]') || null;
    if (toggle) {
      toggle.addEventListener('change', this._boundPathShadowToggle);
      this._pathShadowToggle = toggle;
    }
    const editToggle = root.querySelector('[data-fa-nexus-path-shadow-edit]') || null;
    if (editToggle) {
      editToggle.addEventListener('change', this._boundPathShadowEditToggle);
      this._pathShadowEditToggle = editToggle;
    }
    this._pathShadowEditRoot = root.querySelector('[data-fa-nexus-path-shadow-edit-row]')
      || root.querySelector('[data-fa-nexus-path-shadow-edit-root]')
      || (editToggle ? editToggle.closest('label') : null);
    this._pathShadowPresetsRoot = root.querySelector('[data-fa-nexus-path-shadow-presets]') || null;
    if (this._pathShadowPresetsRoot) {
      this._pathShadowPresetButtons = Array.from(this._pathShadowPresetsRoot.querySelectorAll('[data-fa-nexus-path-shadow-preset]'));
      for (const button of this._pathShadowPresetButtons) {
        button.addEventListener('click', this._boundPathShadowPresetClick);
        button.addEventListener('contextmenu', this._boundPathShadowPresetContext);
      }
    } else {
      this._pathShadowPresetButtons = [];
    }
    this._pathShadowResetButton = root.querySelector('[data-fa-nexus-path-shadow-reset]') || null;
    if (this._pathShadowResetButton) {
      this._pathShadowResetButton.addEventListener('click', this._boundPathShadowReset);
    }
    this._pathShadowEditResetButton = root.querySelector('[data-fa-nexus-path-shadow-edit-reset]') || null;
    if (this._pathShadowEditResetButton) {
      this._pathShadowEditResetButton.addEventListener('click', this._boundPathShadowEditReset);
    }
    this._pathShadowElevationDisplay = root.querySelector('[data-fa-nexus-path-shadow-elevation]') || null;
    this._pathShadowNoteDisplay = root.querySelector('[data-fa-nexus-path-shadow-note]') || null;
    const scaleSlider = root.querySelector('[data-fa-nexus-path-shadow-scale]') || null;
    if (scaleSlider) {
      scaleSlider.addEventListener('input', this._boundPathShadowScaleInput);
      scaleSlider.addEventListener('change', this._boundPathShadowScaleCommit);
      this._pathShadowScaleSlider = scaleSlider;
    }
    const offsetSlider = root.querySelector('[data-fa-nexus-path-shadow-offset]') || null;
    if (offsetSlider) {
      offsetSlider.addEventListener('input', this._boundPathShadowOffsetInput);
      offsetSlider.addEventListener('change', this._boundPathShadowOffsetCommit);
      this._pathShadowOffsetSlider = offsetSlider;
    }
    const alphaSlider = root.querySelector('[data-fa-nexus-path-shadow-alpha]') || null;
    if (alphaSlider) {
      alphaSlider.addEventListener('input', this._boundPathShadowAlphaInput);
      alphaSlider.addEventListener('change', this._boundPathShadowAlphaCommit);
      this._pathShadowAlphaSlider = alphaSlider;
    }
    const blurSlider = root.querySelector('[data-fa-nexus-path-shadow-blur]') || null;
    if (blurSlider) {
      blurSlider.addEventListener('input', this._boundPathShadowBlurInput);
      blurSlider.addEventListener('change', this._boundPathShadowBlurCommit);
      this._pathShadowBlurSlider = blurSlider;
    }
    const dilationSlider = root.querySelector('[data-fa-nexus-path-shadow-dilation]') || null;
    if (dilationSlider) {
      dilationSlider.addEventListener('input', this._boundPathShadowDilationInput);
      dilationSlider.addEventListener('change', this._boundPathShadowDilationCommit);
      this._pathShadowDilationSlider = dilationSlider;
    }
    this._pathShadowScaleDisplay = root.querySelector('[data-fa-nexus-path-shadow-scale-display]') || null;
    this._pathShadowOffsetDisplay = root.querySelector('[data-fa-nexus-path-shadow-offset-display]') || null;
    this._pathShadowAlphaDisplay = root.querySelector('[data-fa-nexus-path-shadow-alpha-display]') || null;
    this._pathShadowBlurDisplay = root.querySelector('[data-fa-nexus-path-shadow-blur-display]') || null;
    this._pathShadowDilationDisplay = root.querySelector('[data-fa-nexus-path-shadow-dilation-display]') || null;
    this._bindDisplayInput(this._pathShadowScaleDisplay, this._boundPathShadowScaleInput, this._boundPathShadowScaleCommit);
    this._bindDisplayInput(this._pathShadowOffsetDisplay, this._boundPathShadowOffsetInput, this._boundPathShadowOffsetCommit);
    this._bindDisplayInput(this._pathShadowAlphaDisplay, this._boundPathShadowAlphaInput, this._boundPathShadowAlphaCommit);
    this._bindDisplayInput(this._pathShadowBlurDisplay, this._boundPathShadowBlurInput, this._boundPathShadowBlurCommit);
    this._bindDisplayInput(this._pathShadowDilationDisplay, this._boundPathShadowDilationInput, this._boundPathShadowDilationCommit);
    this._syncPathShadowControls();
  }

  _unbindPathShadowControls() {
    if (this._pathShadowToggle) {
      try { this._pathShadowToggle.removeEventListener('change', this._boundPathShadowToggle); }
      catch (_) {}
    }
    if (this._pathShadowEditToggle) {
      try { this._pathShadowEditToggle.removeEventListener('change', this._boundPathShadowEditToggle); }
      catch (_) {}
    }
    if (Array.isArray(this._pathShadowPresetButtons) && this._pathShadowPresetButtons.length) {
      for (const button of this._pathShadowPresetButtons) {
        try { button.removeEventListener('click', this._boundPathShadowPresetClick); } catch (_) {}
        try { button.removeEventListener('contextmenu', this._boundPathShadowPresetContext); } catch (_) {}
      }
    }
    if (this._pathShadowResetButton) {
      try { this._pathShadowResetButton.removeEventListener('click', this._boundPathShadowReset); }
      catch (_) {}
    }
    if (this._pathShadowEditResetButton) {
      try { this._pathShadowEditResetButton.removeEventListener('click', this._boundPathShadowEditReset); }
      catch (_) {}
    }
    if (this._pathShadowScaleSlider) {
      try {
        this._pathShadowScaleSlider.removeEventListener('input', this._boundPathShadowScaleInput);
        this._pathShadowScaleSlider.removeEventListener('change', this._boundPathShadowScaleCommit);
      } catch (_) {}
    }
    if (this._pathShadowOffsetSlider) {
      try {
        this._pathShadowOffsetSlider.removeEventListener('input', this._boundPathShadowOffsetInput);
        this._pathShadowOffsetSlider.removeEventListener('change', this._boundPathShadowOffsetCommit);
      } catch (_) {}
    }
    if (this._pathShadowAlphaSlider) {
      try {
        this._pathShadowAlphaSlider.removeEventListener('input', this._boundPathShadowAlphaInput);
        this._pathShadowAlphaSlider.removeEventListener('change', this._boundPathShadowAlphaCommit);
      } catch (_) {}
    }
    if (this._pathShadowBlurSlider) {
      try {
        this._pathShadowBlurSlider.removeEventListener('input', this._boundPathShadowBlurInput);
        this._pathShadowBlurSlider.removeEventListener('change', this._boundPathShadowBlurCommit);
      } catch (_) {}
    }
    if (this._pathShadowDilationSlider) {
      try {
        this._pathShadowDilationSlider.removeEventListener('input', this._boundPathShadowDilationInput);
        this._pathShadowDilationSlider.removeEventListener('change', this._boundPathShadowDilationCommit);
      } catch (_) {}
    }
    this._unbindDisplayInput(this._pathShadowScaleDisplay, this._boundPathShadowScaleInput, this._boundPathShadowScaleCommit);
    this._unbindDisplayInput(this._pathShadowOffsetDisplay, this._boundPathShadowOffsetInput, this._boundPathShadowOffsetCommit);
    this._unbindDisplayInput(this._pathShadowAlphaDisplay, this._boundPathShadowAlphaInput, this._boundPathShadowAlphaCommit);
    this._unbindDisplayInput(this._pathShadowBlurDisplay, this._boundPathShadowBlurInput, this._boundPathShadowBlurCommit);
    this._unbindDisplayInput(this._pathShadowDilationDisplay, this._boundPathShadowDilationInput, this._boundPathShadowDilationCommit);
    this._pathShadowRoot = null;
    this._pathShadowToggle = null;
    this._pathShadowEditToggle = null;
    this._pathShadowEditRoot = null;
    this._pathShadowPresetsRoot = null;
    this._pathShadowPresetButtons = [];
    this._pathShadowResetButton = null;
    this._pathShadowEditResetButton = null;
    this._pathShadowScaleSlider = null;
    this._pathShadowOffsetSlider = null;
    this._pathShadowAlphaSlider = null;
    this._pathShadowBlurSlider = null;
    this._pathShadowDilationSlider = null;
    this._pathShadowScaleDisplay = null;
    this._pathShadowOffsetDisplay = null;
    this._pathShadowAlphaDisplay = null;
    this._pathShadowBlurDisplay = null;
    this._pathShadowDilationDisplay = null;
    this._pathShadowElevationDisplay = null;
    this._pathShadowNoteDisplay = null;
  }

  _syncPathShadowControls() {
    const state = this._toolOptionState?.pathShadow || { available: false };
    if (this._pathShadowRoot) {
      this._pathShadowRoot.classList.toggle('is-hidden', !state.available);
    }
    if (!state.available) return;
    const editAvailable = state.editAvailable !== false;
    if (this._pathShadowEditRoot) {
      this._pathShadowEditRoot.classList.toggle('is-hidden', !editAvailable);
    }
    if (this._pathShadowToggle) {
      this._pathShadowToggle.checked = !!state.enabled;
      this._pathShadowToggle.disabled = !!state.disabled;
    }
    if (this._pathShadowEditToggle) {
      this._pathShadowEditToggle.checked = !!state.editMode;
      this._pathShadowEditToggle.disabled = !state.enabled || !!state.editDisabled || !editAvailable;
    }
    if (this._pathShadowElevationDisplay) {
      const displayValue = state.context?.display ?? '0';
      this._pathShadowElevationDisplay.textContent = `Elevation ${displayValue}`;
    }
    if (this._pathShadowNoteDisplay) {
      const note = state.context?.note ?? '';
      if (note) {
        this._pathShadowNoteDisplay.textContent = note;
        this._pathShadowNoteDisplay.classList.remove('is-hidden');
      } else {
        this._pathShadowNoteDisplay.textContent = '';
        this._pathShadowNoteDisplay.classList.add('is-hidden');
      }
    }
    const hasPresets = Array.isArray(state.presets) && state.presets.length > 0;
    if (this._pathShadowPresetsRoot) {
      this._pathShadowPresetsRoot.classList.toggle('is-hidden', !hasPresets);
    }
    if (hasPresets && Array.isArray(this._pathShadowPresetButtons) && this._pathShadowPresetButtons.length) {
      for (const button of this._pathShadowPresetButtons) {
        const index = Number(button.dataset.faNexusPathShadowPreset);
        const preset = state.presets.find((entry) => Number(entry?.index) === index)
          ?? state.presets[index] ?? null;
        const saved = !!preset?.saved;
        const active = !!preset?.active;
        button.classList.toggle('is-active', active);
        button.classList.toggle('is-empty', !saved);
        if (preset?.label) button.textContent = preset.label;
        if (preset?.tooltip) button.title = preset.tooltip;
        button.disabled = !!state.disabled;
      }
    }
    if (this._pathShadowResetButton) {
      const disabled = !!state.reset?.disabled;
      this._pathShadowResetButton.disabled = disabled;
      const tooltip = state.reset?.tooltip;
      if (tooltip && tooltip.length) this._pathShadowResetButton.title = tooltip;
    }
    if (this._pathShadowEditResetButton) {
      const disabled = !!state.editReset?.disabled;
      this._pathShadowEditResetButton.disabled = disabled;
      const tooltip = state.editReset?.tooltip;
      if (tooltip && tooltip.length) this._pathShadowEditResetButton.title = tooltip;
    }
    if (this._pathShadowScaleSlider && state.scale) {
      const cfg = state.scale;
      if (cfg.min !== undefined) this._pathShadowScaleSlider.min = String(cfg.min);
      if (cfg.max !== undefined) this._pathShadowScaleSlider.max = String(cfg.max);
      if (cfg.step !== undefined) this._pathShadowScaleSlider.step = String(cfg.step);
      if (cfg.value !== undefined) {
        const next = String(cfg.value);
        if (this._pathShadowScaleSlider.value !== next) this._pathShadowScaleSlider.value = next;
      }
      this._pathShadowScaleSlider.disabled = !!cfg.disabled;
      if (this._pathShadowScaleDisplay) {
        this._syncDisplayValue(this._pathShadowScaleDisplay, cfg);
      }
    }
    if (this._pathShadowOffsetSlider && state.offset) {
      const cfg = state.offset;
      if (cfg.min !== undefined) this._pathShadowOffsetSlider.min = String(cfg.min);
      if (cfg.max !== undefined) this._pathShadowOffsetSlider.max = String(cfg.max);
      if (cfg.step !== undefined) this._pathShadowOffsetSlider.step = String(cfg.step);
      if (cfg.value !== undefined) {
        const next = String(cfg.value);
        if (this._pathShadowOffsetSlider.value !== next) this._pathShadowOffsetSlider.value = next;
      }
      this._pathShadowOffsetSlider.disabled = !!cfg.disabled;
      if (this._pathShadowOffsetDisplay) {
        this._syncDisplayValue(this._pathShadowOffsetDisplay, cfg);
      }
    }
    if (this._pathShadowAlphaSlider && state.alpha) {
      const cfg = state.alpha;
      if (cfg.min !== undefined) this._pathShadowAlphaSlider.min = String(cfg.min);
      if (cfg.max !== undefined) this._pathShadowAlphaSlider.max = String(cfg.max);
      if (cfg.step !== undefined) this._pathShadowAlphaSlider.step = String(cfg.step);
      if (cfg.value !== undefined) {
        const next = String(cfg.value);
        if (this._pathShadowAlphaSlider.value !== next) this._pathShadowAlphaSlider.value = next;
      }
      this._pathShadowAlphaSlider.disabled = !!cfg.disabled;
      if (this._pathShadowAlphaDisplay) {
        this._syncDisplayValue(this._pathShadowAlphaDisplay, cfg);
      }
    }
    if (this._pathShadowBlurSlider && state.blur) {
      const cfg = state.blur;
      if (cfg.min !== undefined) this._pathShadowBlurSlider.min = String(cfg.min);
      if (cfg.max !== undefined) this._pathShadowBlurSlider.max = String(cfg.max);
      if (cfg.step !== undefined) this._pathShadowBlurSlider.step = String(cfg.step);
      if (cfg.value !== undefined) {
        const next = String(cfg.value);
        if (this._pathShadowBlurSlider.value !== next) this._pathShadowBlurSlider.value = next;
      }
      this._pathShadowBlurSlider.disabled = !!cfg.disabled;
      if (this._pathShadowBlurDisplay) {
        this._syncDisplayValue(this._pathShadowBlurDisplay, cfg);
      }
    }
    if (this._pathShadowDilationSlider && state.dilation) {
      const cfg = state.dilation;
      if (cfg.min !== undefined) this._pathShadowDilationSlider.min = String(cfg.min);
      if (cfg.max !== undefined) this._pathShadowDilationSlider.max = String(cfg.max);
      if (cfg.step !== undefined) this._pathShadowDilationSlider.step = String(cfg.step);
      if (cfg.value !== undefined) {
        const next = String(cfg.value);
        if (this._pathShadowDilationSlider.value !== next) this._pathShadowDilationSlider.value = next;
      }
      this._pathShadowDilationSlider.disabled = !!cfg.disabled;
      if (this._pathShadowDilationDisplay) {
        this._syncDisplayValue(this._pathShadowDilationDisplay, cfg);
      }
    }
  }

  _handlePathShadowToggle(event) {
    if (!this._controller?.invokeToolHandler) return;
    const enabled = !!(event?.currentTarget?.checked ?? event?.target?.checked);
    try { this._controller.invokeToolHandler('setPathShadowEnabled', enabled); }
    catch (_) {}
  }

  _handlePathShadowEdit(event) {
    if (!this._controller?.invokeToolHandler) return;
    const enabled = !!(event?.currentTarget?.checked ?? event?.target?.checked);
    try { this._controller.invokeToolHandler('setPathShadowEditMode', enabled); }
    catch (_) {}
  }

  _handlePathShadowSlider(event, handlerId, commit) {
    if (!this._controller?.invokeToolHandler) return;
    const value = event?.currentTarget?.value ?? event?.target?.value;
    const numeric = Number(value);
    const payload = Number.isFinite(numeric) ? numeric : value;
    try { this._controller.invokeToolHandler(handlerId, payload, !!commit); }
    catch (_) {}
  }

  _handlePathShadowPresetClick(event) {
    const button = event?.currentTarget || event?.target;
    if (!button) return;
    const index = Number(button.dataset.faNexusPathShadowPreset);
    if (!Number.isInteger(index)) return;
    if (event) {
      event.preventDefault();
      event.stopPropagation();
    }
    const save = !!(event?.shiftKey || event?.altKey || event?.metaKey);
    const controller = this._controller;
    if (!controller?.invokeToolHandler) return;
    try {
      const result = controller.invokeToolHandler('handlePathShadowPreset', index, save);
      if (result?.then) {
        result.catch(() => {}).finally(() => this._syncPathShadowControls());
      } else {
        this._syncPathShadowControls();
      }
    } catch (_) {
      this._syncPathShadowControls();
    }
  }

  _handlePathShadowPresetContext(event) {
    const button = event?.currentTarget || event?.target;
    if (!button) return;
    if (event) {
      event.preventDefault();
      event.stopPropagation();
    }
    const index = Number(button.dataset.faNexusPathShadowPreset);
    if (!Number.isInteger(index)) return;
    const controller = this._controller;
    if (!controller?.invokeToolHandler) return;
    try {
      const result = controller.invokeToolHandler('handlePathShadowPreset', index, true);
      if (result?.then) {
        result.catch(() => {}).finally(() => this._syncPathShadowControls());
      } else {
        this._syncPathShadowControls();
      }
    } catch (_) {
      this._syncPathShadowControls();
    }
  }

  _handlePathShadowReset(event) {
    if (event) {
      event.preventDefault();
      event.stopPropagation();
    }
    const controller = this._controller;
    if (!controller?.invokeToolHandler) return;
    try {
      const result = controller.invokeToolHandler('resetPathShadowSettings');
      if (result?.then) {
        result.catch(() => {}).finally(() => this._syncPathShadowControls());
      } else {
        this._syncPathShadowControls();
      }
    } catch (_) {
      this._syncPathShadowControls();
    }
  }

  _handlePathShadowEditReset(event) {
    if (event) {
      event.preventDefault();
      event.stopPropagation();
    }
    const controller = this._controller;
    if (!controller?.invokeToolHandler) return;
    try {
      const result = controller.invokeToolHandler('resetPathShadowEdit');
      if (result?.then) {
        result.catch(() => {}).finally(() => this._syncPathShadowControls());
      } else {
        this._syncPathShadowControls();
      }
    } catch (_) {
      this._syncPathShadowControls();
    }
  }

  _bindPathFeatherControls() {
    const root = this.element?.querySelector('[data-fa-nexus-path-feather]') || null;
    if (!root) {
      this._unbindPathFeatherControls();
      return;
    }
    this._pathFeatherRoot = root;
    const startToggle = root.querySelector('[data-fa-nexus-feather-start-toggle]') || null;
    const endToggle = root.querySelector('[data-fa-nexus-feather-end-toggle]') || null;
    if (startToggle) {
      startToggle.addEventListener('change', this._boundPathFeatherStartToggle);
      this._pathFeatherStartToggle = startToggle;
    }
    if (endToggle) {
      endToggle.addEventListener('change', this._boundPathFeatherEndToggle);
      this._pathFeatherEndToggle = endToggle;
    }
    this._pathFeatherStartSlider = root.querySelector('[data-fa-nexus-feather-start-length]') || null;
    this._pathFeatherEndSlider = root.querySelector('[data-fa-nexus-feather-end-length]') || null;
    if (this._pathFeatherStartSlider) {
      this._pathFeatherStartSlider.addEventListener('input', this._boundPathFeatherStartInput);
      this._pathFeatherStartSlider.addEventListener('change', this._boundPathFeatherStartCommit);
    }
    if (this._pathFeatherEndSlider) {
      this._pathFeatherEndSlider.addEventListener('input', this._boundPathFeatherEndInput);
      this._pathFeatherEndSlider.addEventListener('change', this._boundPathFeatherEndCommit);
    }
    this._pathFeatherStartValue = root.querySelector('[data-fa-nexus-feather-start-display]') || null;
    this._pathFeatherEndValue = root.querySelector('[data-fa-nexus-feather-end-display]') || null;
    this._bindDisplayInput(this._pathFeatherStartValue, this._boundPathFeatherStartInput, this._boundPathFeatherStartCommit);
    this._bindDisplayInput(this._pathFeatherEndValue, this._boundPathFeatherEndInput, this._boundPathFeatherEndCommit);
    this._pathFeatherHint = root.querySelector('[data-fa-nexus-feather-hint]') || null;
    this._syncPathFeatherControls();
  }

  _unbindPathFeatherControls() {
    if (this._pathFeatherStartToggle) {
      try { this._pathFeatherStartToggle.removeEventListener('change', this._boundPathFeatherStartToggle); }
      catch (_) {}
    }
    if (this._pathFeatherEndToggle) {
      try { this._pathFeatherEndToggle.removeEventListener('change', this._boundPathFeatherEndToggle); }
      catch (_) {}
    }
    if (this._pathFeatherStartSlider) {
      try {
        this._pathFeatherStartSlider.removeEventListener('input', this._boundPathFeatherStartInput);
        this._pathFeatherStartSlider.removeEventListener('change', this._boundPathFeatherStartCommit);
      } catch (_) {}
    }
    if (this._pathFeatherEndSlider) {
      try {
        this._pathFeatherEndSlider.removeEventListener('input', this._boundPathFeatherEndInput);
        this._pathFeatherEndSlider.removeEventListener('change', this._boundPathFeatherEndCommit);
      } catch (_) {}
    }
    this._unbindDisplayInput(this._pathFeatherStartValue, this._boundPathFeatherStartInput, this._boundPathFeatherStartCommit);
    this._unbindDisplayInput(this._pathFeatherEndValue, this._boundPathFeatherEndInput, this._boundPathFeatherEndCommit);
    this._pathFeatherRoot = null;
    this._pathFeatherStartToggle = null;
    this._pathFeatherEndToggle = null;
    this._pathFeatherStartSlider = null;
    this._pathFeatherEndSlider = null;
    this._pathFeatherStartValue = null;
    this._pathFeatherEndValue = null;
    this._pathFeatherHint = null;
  }

  _syncPathFeatherControls() {
    const state = this._toolOptionState?.pathFeather || { available: false };
    if (this._pathFeatherRoot) {
      this._pathFeatherRoot.classList.toggle('is-hidden', !state.available);
    }
    if (!state.available) return;
    if (this._pathFeatherStartToggle && state.start) {
      this._pathFeatherStartToggle.checked = !!state.start.enabled;
    }
    if (this._pathFeatherEndToggle && state.end) {
      this._pathFeatherEndToggle.checked = !!state.end.enabled;
    }
    if (this._pathFeatherStartSlider && state.start?.length) {
      const length = state.start.length;
      if (length.min !== undefined) this._pathFeatherStartSlider.min = String(length.min);
      if (length.max !== undefined) this._pathFeatherStartSlider.max = String(length.max);
      if (length.step !== undefined) this._pathFeatherStartSlider.step = String(length.step);
      if (length.value !== undefined) {
        const next = String(length.value);
        if (this._pathFeatherStartSlider.value !== next) this._pathFeatherStartSlider.value = next;
      }
      this._applyDefaultValue(this._pathFeatherStartSlider, length.defaultValue);
      this._pathFeatherStartSlider.disabled = !!length.disabled;
      if (this._pathFeatherStartValue) {
        this._syncDisplayValue(this._pathFeatherStartValue, length);
      }
    }
    if (this._pathFeatherEndSlider && state.end?.length) {
      const length = state.end.length;
      if (length.min !== undefined) this._pathFeatherEndSlider.min = String(length.min);
      if (length.max !== undefined) this._pathFeatherEndSlider.max = String(length.max);
      if (length.step !== undefined) this._pathFeatherEndSlider.step = String(length.step);
      if (length.value !== undefined) {
        const next = String(length.value);
        if (this._pathFeatherEndSlider.value !== next) this._pathFeatherEndSlider.value = next;
      }
      this._applyDefaultValue(this._pathFeatherEndSlider, length.defaultValue);
      this._pathFeatherEndSlider.disabled = !!length.disabled;
      if (this._pathFeatherEndValue) {
        this._syncDisplayValue(this._pathFeatherEndValue, length);
      }
    }
    if (this._pathFeatherHint) {
      const text = state.hint || '';
      this._pathFeatherHint.textContent = text;
      this._pathFeatherHint.classList.toggle('is-hidden', !text);
    }
  }

  _handlePathFeatherToggle(event, endpoint) {
    const input = event?.currentTarget || event?.target;
    if (!input) return;
    if (this._controller?.invokeToolHandler) {
      this._controller.invokeToolHandler('setFeatherShrinkEnabled', endpoint, !!input.checked);
    }
  }

  _handlePathFeatherLength(event, endpoint, commit) {
    const slider = event?.currentTarget || event?.target;
    if (!slider) return;
    if (this._controller?.invokeToolHandler) {
      this._controller.invokeToolHandler('setFeatherLength', endpoint, slider.value, !!commit);
    }
  }

  _bindOpacityFeatherControls() {
    const root = this.element?.querySelector('[data-fa-nexus-opacity-feather]') || null;
    if (!root) {
      this._unbindOpacityFeatherControls();
      return;
    }
    this._opacityFeatherRoot = root;
    const startToggle = root.querySelector('[data-fa-nexus-opacity-start-toggle]');
    const endToggle = root.querySelector('[data-fa-nexus-opacity-end-toggle]');
    if (startToggle) {
      startToggle.addEventListener('change', this._boundOpacityFeatherStartToggle);
      this._opacityFeatherStartToggle = startToggle;
    }
    if (endToggle) {
      endToggle.addEventListener('change', this._boundOpacityFeatherEndToggle);
      this._opacityFeatherEndToggle = endToggle;
    }
    const startSlider = root.querySelector('[data-fa-nexus-opacity-start-length]');
    const endSlider = root.querySelector('[data-fa-nexus-opacity-end-length]');
    if (startSlider) {
      startSlider.addEventListener('input', this._boundOpacityFeatherStartInput);
      startSlider.addEventListener('change', this._boundOpacityFeatherStartCommit);
      this._opacityFeatherStartSlider = startSlider;
    }
    if (endSlider) {
      endSlider.addEventListener('input', this._boundOpacityFeatherEndInput);
      endSlider.addEventListener('change', this._boundOpacityFeatherEndCommit);
      this._opacityFeatherEndSlider = endSlider;
    }
    this._opacityFeatherStartValue = root.querySelector('[data-fa-nexus-opacity-start-display]') || null;
    this._opacityFeatherEndValue = root.querySelector('[data-fa-nexus-opacity-end-display]') || null;
    this._bindDisplayInput(this._opacityFeatherStartValue, this._boundOpacityFeatherStartInput, this._boundOpacityFeatherStartCommit);
    this._bindDisplayInput(this._opacityFeatherEndValue, this._boundOpacityFeatherEndInput, this._boundOpacityFeatherEndCommit);
    this._opacityFeatherHint = root.querySelector('[data-fa-nexus-opacity-hint]') || null;
    this._syncOpacityFeatherControls();
  }

  _unbindOpacityFeatherControls() {
    if (this._opacityFeatherStartToggle) {
      try { this._opacityFeatherStartToggle.removeEventListener('change', this._boundOpacityFeatherStartToggle); }
      catch (_) {}
    }
    if (this._opacityFeatherEndToggle) {
      try { this._opacityFeatherEndToggle.removeEventListener('change', this._boundOpacityFeatherEndToggle); }
      catch (_) {}
    }
    if (this._opacityFeatherStartSlider) {
      try {
        this._opacityFeatherStartSlider.removeEventListener('input', this._boundOpacityFeatherStartInput);
        this._opacityFeatherStartSlider.removeEventListener('change', this._boundOpacityFeatherStartCommit);
      } catch (_) {}
    }
    if (this._opacityFeatherEndSlider) {
      try {
        this._opacityFeatherEndSlider.removeEventListener('input', this._boundOpacityFeatherEndInput);
        this._opacityFeatherEndSlider.removeEventListener('change', this._boundOpacityFeatherEndCommit);
      } catch (_) {}
    }
    this._unbindDisplayInput(this._opacityFeatherStartValue, this._boundOpacityFeatherStartInput, this._boundOpacityFeatherStartCommit);
    this._unbindDisplayInput(this._opacityFeatherEndValue, this._boundOpacityFeatherEndInput, this._boundOpacityFeatherEndCommit);
    this._opacityFeatherRoot = null;
    this._opacityFeatherStartToggle = null;
    this._opacityFeatherEndToggle = null;
    this._opacityFeatherStartSlider = null;
    this._opacityFeatherEndSlider = null;
    this._opacityFeatherStartValue = null;
    this._opacityFeatherEndValue = null;
    this._opacityFeatherHint = null;
  }

  _syncOpacityFeatherControls() {
    const state = this._toolOptionState?.opacityFeather || { available: false };
    if (this._opacityFeatherRoot) {
      this._opacityFeatherRoot.classList.toggle('is-hidden', !state.available);
    }
    if (!state.available) return;
    if (this._opacityFeatherStartToggle && state.start) {
      this._opacityFeatherStartToggle.checked = !!state.start.enabled;
    }
    if (this._opacityFeatherEndToggle && state.end) {
      this._opacityFeatherEndToggle.checked = !!state.end.enabled;
    }
    if (this._opacityFeatherStartSlider && state.start?.length) {
      const length = state.start.length;
      if (length.min !== undefined) this._opacityFeatherStartSlider.min = String(length.min);
      if (length.max !== undefined) this._opacityFeatherStartSlider.max = String(length.max);
      if (length.step !== undefined) this._opacityFeatherStartSlider.step = String(length.step);
      if (length.value !== undefined) {
        const next = String(length.value);
        if (this._opacityFeatherStartSlider.value !== next) this._opacityFeatherStartSlider.value = next;
      }
      this._applyDefaultValue(this._opacityFeatherStartSlider, length.defaultValue);
      this._opacityFeatherStartSlider.disabled = !state.start.enabled || !!length.disabled;
      if (this._opacityFeatherStartValue) {
        this._syncDisplayValue(this._opacityFeatherStartValue, length, { disabled: !state.start.enabled });
      }
    }
    if (this._opacityFeatherEndSlider && state.end?.length) {
      const length = state.end.length;
      if (length.min !== undefined) this._opacityFeatherEndSlider.min = String(length.min);
      if (length.max !== undefined) this._opacityFeatherEndSlider.max = String(length.max);
      if (length.step !== undefined) this._opacityFeatherEndSlider.step = String(length.step);
      if (length.value !== undefined) {
        const next = String(length.value);
        if (this._opacityFeatherEndSlider.value !== next) this._opacityFeatherEndSlider.value = next;
      }
      this._applyDefaultValue(this._opacityFeatherEndSlider, length.defaultValue);
      this._opacityFeatherEndSlider.disabled = !state.end.enabled || !!length.disabled;
      if (this._opacityFeatherEndValue) {
        this._syncDisplayValue(this._opacityFeatherEndValue, length, { disabled: !state.end.enabled });
      }
    }
    if (this._opacityFeatherHint) {
      const text = state.hint || '';
      this._opacityFeatherHint.textContent = text;
      this._opacityFeatherHint.classList.toggle('is-hidden', !text);
    }
  }

  _handleOpacityFeatherToggle(event, endpoint) {
    const checkbox = event?.currentTarget || event?.target;
    if (!checkbox) return;
    if (this._controller?.invokeToolHandler) {
      this._controller.invokeToolHandler('setOpacityFeatherEnabled', endpoint, !!checkbox.checked);
    }
  }

  _handleOpacityFeatherLength(event, endpoint, commit) {
    const slider = event?.currentTarget || event?.target;
    if (!slider) return;
    if (this._controller?.invokeToolHandler) {
      this._controller.invokeToolHandler('setOpacityFeatherLength', endpoint, slider.value, !!commit);
    }
  }

  _bindCustomToggles() {
    if (!this.element) return;
    const toggles = this.element.querySelectorAll('[data-fa-nexus-custom-toggle]');
    for (const toggle of toggles) {
      if (this._customToggleBindings.has(toggle)) continue;
      const id = toggle.getAttribute('data-fa-nexus-custom-toggle');
      if (!id) continue;
      const handler = (event) => {
        event.target.indeterminate = false;
        const next = !!event.target.checked;
        const result = this._controller?.requestCustomToggle?.(id, next);
        if (result && typeof result.then === 'function') {
          result.then((success) => {
            if (success === false) event.target.checked = !next;
          }).catch(() => {
            event.target.checked = !next;
          });
        } else if (result === false) {
          event.target.checked = !next;
        }
      };
      toggle.addEventListener('change', handler);
      this._customToggleBindings.set(toggle, handler);
    }
    this._syncCustomToggles();
  }

  _syncCustomToggles() {
    if (!this.element) return;
    const stateList = [];
    if (Array.isArray(this._toolOptionState?.customToggles)) {
      stateList.push(...this._toolOptionState.customToggles);
    }
    if (Array.isArray(this._toolOptionState?.subtoolToggles)) {
      stateList.push(...this._toolOptionState.subtoolToggles);
    }
    const stateMap = new Map();
    for (const toggle of stateList) {
      if (!toggle || typeof toggle !== 'object') continue;
      const id = String(toggle.id || '');
      if (!id) continue;
      stateMap.set(id, toggle);
    }
    const toggles = this.element.querySelectorAll('[data-fa-nexus-custom-toggle]');
    for (const toggle of toggles) {
      const id = toggle.getAttribute('data-fa-nexus-custom-toggle');
      const state = stateMap.get(id) || {};
      toggle.checked = !!state.enabled;
      toggle.disabled = !!state.disabled;
      if (state.tooltip) toggle.title = String(state.tooltip);
    }
  }

  _handlePlacementPush(event, direction = 'top') {
    if (event) {
      event.preventDefault();
      event.stopPropagation();
    }
    const handlerId = direction === 'bottom' ? 'pushSelectedWallToBottom' : 'pushSelectedWallToTop';
    try { this._controller?.invokeToolHandler?.(handlerId); }
    catch (_) {}
  }

  _bindPlacementControls() {
    const root = this.element?.querySelector('[data-fa-nexus-placement-root]');
    if (!root) {
      this._unbindPlacementControls();
      return;
    }
    this._placementRoot = root;
    this._placementSwitchRoots = Array.from(root.querySelectorAll('[data-fa-nexus-switch]') || []);
    const pushTop = root.querySelector('[data-fa-nexus-stack-top]');
    if (pushTop) {
      pushTop.addEventListener('click', this._boundPlacementPushTop);
      this._placementPushTopButton = pushTop;
    }
    const pushBottom = root.querySelector('[data-fa-nexus-stack-bottom]');
    if (pushBottom) {
      pushBottom.addEventListener('click', this._boundPlacementPushBottom);
      this._placementPushBottomButton = pushBottom;
    }
    this._placementOrderDisplay = root.querySelector('[data-fa-nexus-placement-order]') || null;
    this._placementHint = root.querySelector('[data-fa-nexus-placement-hint]') || null;
    this._placementStateLabels = Array.from(root.querySelectorAll('[data-fa-nexus-switch-state]') || []);
    this._syncPlacementControls();
  }

  _unbindPlacementControls() {
    if (this._placementPushTopButton) {
      try { this._placementPushTopButton.removeEventListener('click', this._boundPlacementPushTop); }
      catch (_) {}
      this._placementPushTopButton = null;
    }
    if (this._placementPushBottomButton) {
      try { this._placementPushBottomButton.removeEventListener('click', this._boundPlacementPushBottom); }
      catch (_) {}
      this._placementPushBottomButton = null;
    }
    this._placementRoot = null;
    this._placementOrderDisplay = null;
    this._placementHint = null;
    this._placementStateLabels = [];
    this._placementSwitchRoots = [];
  }

  _syncPlacementControls() {
    if (!this._placementRoot) return;
    const stateList = Array.isArray(this._toolOptionState?.customToggles)
      ? this._toolOptionState.customToggles
      : [];
    const stateMap = new Map();
    for (const toggle of stateList) {
      if (!toggle || typeof toggle !== 'object') continue;
      const id = String(toggle.id || '');
      if (!id.length) continue;
      stateMap.set(id, toggle);
    }
    if (Array.isArray(this._placementSwitchRoots)) {
      for (const root of this._placementSwitchRoots) {
        const id = root?.dataset?.faNexusSwitch || root?.getAttribute?.('data-fa-nexus-switch') || '';
        if (!id) continue;
        const state = stateMap.get(id) || {};
        const input = root.querySelector('input[type="checkbox"]');
        if (input) {
          input.checked = !!state.enabled;
          input.disabled = !!state.disabled;
        }
        root.classList.toggle('is-on', !!state.enabled);
        root.classList.toggle('is-disabled', !!state.disabled);
      }
    }
    if (Array.isArray(this._placementStateLabels)) {
      for (const label of this._placementStateLabels) {
        const rawId = label?.dataset?.faNexusSwitchState || label?.getAttribute?.('data-fa-nexus-switch-state') || '';
        if (!rawId) continue;
        const baseId = rawId.replace(/-on$|-off$/, '');
        const state = stateMap.get(baseId) || {};
        const isOn = !!state.enabled;
        const onLabel = typeof state.onLabel === 'string' && state.onLabel.length ? state.onLabel : 'On';
        const offLabel = typeof state.offLabel === 'string' && state.offLabel.length ? state.offLabel : 'Off';
        const wantOn = rawId.endsWith('-on');
        const text = wantOn ? onLabel : offLabel;
        if (label.textContent !== text) label.textContent = text;
        label.classList.toggle('is-active', (wantOn && isOn) || (!wantOn && !isOn));
      }
    }
    const stacking = this._toolOptionState?.shapeStacking || { available: false };
    const available = !!stacking.available;
    if (this._placementPushTopButton) {
      this._placementPushTopButton.disabled = !available || !!stacking.pushTopDisabled;
    }
    if (this._placementPushBottomButton) {
      this._placementPushBottomButton.disabled = !available || !!stacking.pushBottomDisabled;
    }
    if (this._placementOrderDisplay) {
      const text = available ? (stacking.orderLabel || '') : '';
      this._placementOrderDisplay.textContent = text;
      this._placementOrderDisplay.classList.toggle('is-hidden', !text);
    }
    if (this._placementHint) {
      const hint = available ? (stacking.hint || '') : '';
      this._placementHint.textContent = hint;
      this._placementHint.classList.toggle('is-hidden', !hint);
    }
  }

  _syncDoorControls() {
    if (!this.element) return;
    const state = this._toolOptionState?.doorControls || null;
    const root = this.element.querySelector('[data-fa-nexus-door-root]');
    if (!root) return;
    if (!state) {
      root.style.display = 'none';
      return;
    }
    root.style.display = '';
    if (!root._faDoorBound) {
      const pick = root.querySelector('[data-fa-nexus-door-pick]');
      if (pick) pick.addEventListener('click', () => this._controller?.invokeToolHandler?.('pickDoorTexture'));
      const clear = root.querySelector('[data-fa-nexus-door-clear]');
      if (clear) clear.addEventListener('click', () => this._controller?.invokeToolHandler?.('clearDoorTexture'));
      const applyDefault = root.querySelector('[data-fa-nexus-door-apply-default]');
      if (applyDefault) applyDefault.addEventListener('click', () => this._controller?.invokeToolHandler?.('applyDoorDefaults'));
      const clearSelection = root.querySelector('[data-fa-nexus-door-clear-selection]');
      if (clearSelection) clearSelection.addEventListener('click', () => this._controller?.invokeToolHandler?.('clearPortalSelection'));
      const framePick = root.querySelector('[data-fa-nexus-door-frame-pick]');
      if (framePick) framePick.addEventListener('click', () => this._controller?.invokeToolHandler?.('pickDoorFrameTexture'));
      const frameClear = root.querySelector('[data-fa-nexus-door-frame-clear]');
      if (frameClear) frameClear.addEventListener('click', () => this._controller?.invokeToolHandler?.('clearDoorFrameTexture'));
      const flip = root.querySelector('[data-fa-nexus-door-flip]');
      if (flip) flip.addEventListener('change', (ev) => this._controller?.invokeToolHandler?.('setDoorFlip', !!ev.target.checked));
      const dbl = root.querySelector('[data-fa-nexus-door-double]');
      if (dbl) dbl.addEventListener('change', (ev) => this._controller?.invokeToolHandler?.('setDoorDouble', !!ev.target.checked));
      const flipDir = root.querySelector('[data-fa-nexus-door-direction-flip]');
      if (flipDir) flipDir.addEventListener('change', (ev) => this._controller?.invokeToolHandler?.('setDoorDirectionFlip', !!ev.target.checked));
      const dirSelect = root.querySelector('[data-fa-nexus-door-direction]');
      if (dirSelect) {
        dirSelect.addEventListener('change', (ev) => {
          const dirVal = Number(ev.target.value);
          this._controller?.invokeToolHandler?.('setDoorDirection', dirVal === -1 ? -1 : 1);
        });
      }
      const animSelect = root.querySelector('[data-fa-nexus-door-animation]');
      if (animSelect) {
        animSelect.addEventListener('change', (ev) => {
          const val = ev.target.value;
          this._controller?.invokeToolHandler?.('setDoorAnimation', val);
        });
      }
      const frameScaleSlider = root.querySelector('[data-fa-nexus-door-frame-scale]');
      if (frameScaleSlider) {
        frameScaleSlider.addEventListener('input', (ev) => {
          const val = Number(ev.target.value);
          this._controller?.invokeToolHandler?.('setDoorFrameScale', val, false);
        });
        frameScaleSlider.addEventListener('change', (ev) => {
          const val = Number(ev.target.value);
          this._controller?.invokeToolHandler?.('setDoorFrameScale', val, true);
        });
      }
      const frameScaleDisplay = root.querySelector('[data-fa-nexus-door-frame-scale-display]');
      if (frameScaleDisplay) {
        this._bindDisplayInput(frameScaleDisplay, null, (ev) => {
          const val = Number(ev.target.value);
          this._controller?.invokeToolHandler?.('setDoorFrameScale', val, true);
        });
      }
      const frameOffsetXSlider = root.querySelector('[data-fa-nexus-door-frame-offset-x]');
      if (frameOffsetXSlider) {
        frameOffsetXSlider.addEventListener('input', (ev) => {
          const val = Number(ev.target.value);
          this._controller?.invokeToolHandler?.('setDoorFrameOffsetX', val, false);
        });
        frameOffsetXSlider.addEventListener('change', (ev) => {
          const val = Number(ev.target.value);
          this._controller?.invokeToolHandler?.('setDoorFrameOffsetX', val, true);
        });
      }
      const frameOffsetXDisplay = root.querySelector('[data-fa-nexus-door-frame-offset-x-display]');
      if (frameOffsetXDisplay) {
        this._bindDisplayInput(frameOffsetXDisplay, null, (ev) => {
          const val = Number(ev.target.value);
          this._controller?.invokeToolHandler?.('setDoorFrameOffsetX', val, true);
        });
      }
      const frameOffsetYSlider = root.querySelector('[data-fa-nexus-door-frame-offset-y]');
      if (frameOffsetYSlider) {
        frameOffsetYSlider.addEventListener('input', (ev) => {
          const val = Number(ev.target.value);
          this._controller?.invokeToolHandler?.('setDoorFrameOffsetY', val, false);
        });
        frameOffsetYSlider.addEventListener('change', (ev) => {
          const val = Number(ev.target.value);
          this._controller?.invokeToolHandler?.('setDoorFrameOffsetY', val, true);
        });
      }
      const frameOffsetYDisplay = root.querySelector('[data-fa-nexus-door-frame-offset-y-display]');
      if (frameOffsetYDisplay) {
        this._bindDisplayInput(frameOffsetYDisplay, null, (ev) => {
          const val = Number(ev.target.value);
          this._controller?.invokeToolHandler?.('setDoorFrameOffsetY', val, true);
        });
      }
      const frameRotationSlider = root.querySelector('[data-fa-nexus-door-frame-rotation]');
      if (frameRotationSlider) {
        frameRotationSlider.addEventListener('input', (ev) => {
          const val = Number(ev.target.value);
          this._controller?.invokeToolHandler?.('setDoorFrameRotation', val, false);
        });
        frameRotationSlider.addEventListener('change', (ev) => {
          const val = Number(ev.target.value);
          this._controller?.invokeToolHandler?.('setDoorFrameRotation', val, true);
        });
      }
      const frameRotationDisplay = root.querySelector('[data-fa-nexus-door-frame-rotation-display]');
      if (frameRotationDisplay) {
        this._bindDisplayInput(frameRotationDisplay, null, (ev) => {
          const val = Number(ev.target.value);
          this._controller?.invokeToolHandler?.('setDoorFrameRotation', val, true);
        });
      }
      root._faDoorBound = true;
    }
    const selection = root.querySelector('[data-fa-nexus-door-selection]');
    if (selection) selection.textContent = state.selectionLabel || '';
    const applyDefault = root.querySelector('[data-fa-nexus-door-apply-default]');
    if (applyDefault) applyDefault.disabled = !!state.disabled || !state.hasSelection;
    const clearSelection = root.querySelector('[data-fa-nexus-door-clear-selection]');
    if (clearSelection) clearSelection.disabled = !!state.disabled || !state.hasSelection;
    const pick = root.querySelector('[data-fa-nexus-door-pick]');
    if (pick) {
      pick.disabled = !!state.disabled;
      const labelSpan = pick.querySelector('span');
      if (labelSpan) labelSpan.textContent = state.textureLabel || 'Pick Door Texture';
    }
    const clear = root.querySelector('[data-fa-nexus-door-clear]');
    if (clear) clear.disabled = !!state.disabled;
    const framePick = root.querySelector('[data-fa-nexus-door-frame-pick]');
    if (framePick) {
      framePick.disabled = !!state.disabled;
      const labelSpan = framePick.querySelector('span');
      if (labelSpan) labelSpan.textContent = state.frameLabel || 'Pick Door Frame';
    }
    const frameClear = root.querySelector('[data-fa-nexus-door-frame-clear]');
    if (frameClear) frameClear.disabled = !!state.disabled;
    const flip = root.querySelector('[data-fa-nexus-door-flip]');
    if (flip) {
      flip.checked = !!state.flip;
      flip.disabled = !!state.disabled;
    }
    const dbl = root.querySelector('[data-fa-nexus-door-double]');
    if (dbl) {
      dbl.checked = !!state.double;
      dbl.disabled = !!state.disabled;
    }
    const flipDir = root.querySelector('[data-fa-nexus-door-direction-flip]');
    if (flipDir) {
      flipDir.checked = !!state.directionFlip;
      flipDir.disabled = !!state.disabled;
    }
    const dirSelect = root.querySelector('[data-fa-nexus-door-direction]');
    if (dirSelect) {
      dirSelect.value = String(state.direction === -1 ? -1 : 1);
      dirSelect.disabled = !!state.disabled;
    }
    const animSelect = root.querySelector('[data-fa-nexus-door-animation]');
    if (animSelect && Array.isArray(state.animations)) {
      const desired = state.selectedAnimation || '';
      animSelect.value = desired && animSelect.querySelector(`option[value="${desired}"]`) ? desired : animSelect.value;
      animSelect.disabled = !!state.disabled;
    }
    // Sync frame settings sliders
    const frameSettings = state.frameSettings || null;
    const frameSettingsRoot = root.querySelector('[data-fa-nexus-door-frame-settings]');
    if (frameSettingsRoot) {
      frameSettingsRoot.style.display = frameSettings ? '' : 'none';
    }
    if (frameSettings) {
      const scaleSlider = root.querySelector('[data-fa-nexus-door-frame-scale]');
      const scaleDisplay = root.querySelector('[data-fa-nexus-door-frame-scale-display]');
      const scaleState = {
        min: frameSettings.scaleMin,
        max: frameSettings.scaleMax,
        step: frameSettings.scaleStep,
        value: frameSettings.scale ?? 1,
        defaultValue: frameSettings.scaleDefault,
        display: frameSettings.scaleDisplay || '',
        disabled: !!state.disabled
      };
      if (scaleSlider) {
        if (scaleState.min !== undefined) scaleSlider.min = String(scaleState.min);
        if (scaleState.max !== undefined) scaleSlider.max = String(scaleState.max);
        if (scaleState.step !== undefined) scaleSlider.step = String(scaleState.step);
        if (scaleState.value !== undefined) {
          const next = String(scaleState.value);
          if (scaleSlider.value !== next) scaleSlider.value = next;
        }
        this._applyDefaultValue(scaleSlider, scaleState.defaultValue);
        scaleSlider.disabled = !!scaleState.disabled;
      }
      if (scaleDisplay) {
        this._syncDisplayValue(scaleDisplay, scaleState, { disabled: scaleState.disabled });
      }
      const offsetXSlider = root.querySelector('[data-fa-nexus-door-frame-offset-x]');
      const offsetXDisplay = root.querySelector('[data-fa-nexus-door-frame-offset-x-display]');
      const offsetXState = {
        min: frameSettings.offsetMin,
        max: frameSettings.offsetMax,
        step: frameSettings.offsetStep,
        value: frameSettings.offsetX ?? 0,
        defaultValue: frameSettings.offsetXDefault,
        display: frameSettings.offsetXDisplay || '',
        disabled: !!state.disabled
      };
      if (offsetXSlider) {
        if (offsetXState.min !== undefined) offsetXSlider.min = String(offsetXState.min);
        if (offsetXState.max !== undefined) offsetXSlider.max = String(offsetXState.max);
        if (offsetXState.step !== undefined) offsetXSlider.step = String(offsetXState.step);
        if (offsetXState.value !== undefined) {
          const next = String(offsetXState.value);
          if (offsetXSlider.value !== next) offsetXSlider.value = next;
        }
        this._applyDefaultValue(offsetXSlider, offsetXState.defaultValue);
        offsetXSlider.disabled = !!offsetXState.disabled;
      }
      if (offsetXDisplay) {
        this._syncDisplayValue(offsetXDisplay, offsetXState, { disabled: offsetXState.disabled });
      }
      const offsetYSlider = root.querySelector('[data-fa-nexus-door-frame-offset-y]');
      const offsetYDisplay = root.querySelector('[data-fa-nexus-door-frame-offset-y-display]');
      const offsetYState = {
        min: frameSettings.offsetMin,
        max: frameSettings.offsetMax,
        step: frameSettings.offsetStep,
        value: frameSettings.offsetY ?? 0,
        defaultValue: frameSettings.offsetYDefault,
        display: frameSettings.offsetYDisplay || '',
        disabled: !!state.disabled
      };
      if (offsetYSlider) {
        if (offsetYState.min !== undefined) offsetYSlider.min = String(offsetYState.min);
        if (offsetYState.max !== undefined) offsetYSlider.max = String(offsetYState.max);
        if (offsetYState.step !== undefined) offsetYSlider.step = String(offsetYState.step);
        if (offsetYState.value !== undefined) {
          const next = String(offsetYState.value);
          if (offsetYSlider.value !== next) offsetYSlider.value = next;
        }
        this._applyDefaultValue(offsetYSlider, offsetYState.defaultValue);
        offsetYSlider.disabled = !!offsetYState.disabled;
      }
      if (offsetYDisplay) {
        this._syncDisplayValue(offsetYDisplay, offsetYState, { disabled: offsetYState.disabled });
      }
      const rotationSlider = root.querySelector('[data-fa-nexus-door-frame-rotation]');
      const rotationDisplay = root.querySelector('[data-fa-nexus-door-frame-rotation-display]');
      const rotationState = {
        min: frameSettings.rotationMin,
        max: frameSettings.rotationMax,
        step: frameSettings.rotationStep,
        value: frameSettings.rotation ?? 0,
        defaultValue: frameSettings.rotationDefault,
        display: frameSettings.rotationDisplay || '',
        disabled: !!state.disabled || !!frameSettings.rotationDisabled
      };
      if (rotationSlider) {
        if (rotationState.min !== undefined) rotationSlider.min = String(rotationState.min);
        if (rotationState.max !== undefined) rotationSlider.max = String(rotationState.max);
        if (rotationState.step !== undefined) rotationSlider.step = String(rotationState.step);
        if (rotationState.value !== undefined) {
          const next = String(rotationState.value);
          if (rotationSlider.value !== next) rotationSlider.value = next;
        }
        this._applyDefaultValue(rotationSlider, rotationState.defaultValue);
        rotationSlider.disabled = !!rotationState.disabled;
      }
      if (rotationDisplay) {
        this._syncDisplayValue(rotationDisplay, rotationState, { disabled: rotationState.disabled });
      }
    }
  }

  _syncWindowControls() {
    if (!this.element) return;
    const state = this._toolOptionState?.windowControls || null;
    const root = this.element.querySelector('[data-fa-nexus-window-root]');
    if (!root) return;
    if (!state) {
      root.style.display = 'none';
      return;
    }
    root.style.display = '';
    if (!root._faWindowBound) {
      const applyDefault = root.querySelector('[data-fa-nexus-window-apply-default]');
      if (applyDefault) applyDefault.addEventListener('click', () => this._controller?.invokeToolHandler?.('applyWindowDefaults'));
      const clearSelection = root.querySelector('[data-fa-nexus-window-clear-selection]');
      if (clearSelection) clearSelection.addEventListener('click', () => this._controller?.invokeToolHandler?.('clearPortalSelection'));
      // Animated toggle
      const animatedToggle = root.querySelector('[data-fa-nexus-window-animated]');
      if (animatedToggle) animatedToggle.addEventListener('change', (ev) => this._controller?.invokeToolHandler?.('setWindowAnimated', !!ev.target.checked));
      const animSelect = root.querySelector('[data-fa-nexus-window-animation]');
      if (animSelect) animSelect.addEventListener('change', (ev) => this._controller?.invokeToolHandler?.('setWindowAnimation', ev.target.value));
      const dirSelect = root.querySelector('[data-fa-nexus-window-direction]');
      if (dirSelect) dirSelect.addEventListener('change', (ev) => this._controller?.invokeToolHandler?.('setWindowDirection', Number(ev.target.value)));
      const flipToggle = root.querySelector('[data-fa-nexus-window-flip]');
      if (flipToggle) flipToggle.addEventListener('change', (ev) => this._controller?.invokeToolHandler?.('setWindowFlip', !!ev.target.checked));
      const doubleToggle = root.querySelector('[data-fa-nexus-window-double]');
      if (doubleToggle) doubleToggle.addEventListener('change', (ev) => this._controller?.invokeToolHandler?.('setWindowDouble', !!ev.target.checked));
      const directionFlipToggle = root.querySelector('[data-fa-nexus-window-direction-flip]');
      if (directionFlipToggle) directionFlipToggle.addEventListener('change', (ev) => this._controller?.invokeToolHandler?.('setWindowDirectionFlip', !!ev.target.checked));
      // Sill controls
      const sillPick = root.querySelector('[data-fa-nexus-window-sill-pick]');
      if (sillPick) sillPick.addEventListener('click', () => this._controller?.invokeToolHandler?.('pickWindowSillTexture'));
      const sillClear = root.querySelector('[data-fa-nexus-window-sill-clear]');
      if (sillClear) sillClear.addEventListener('click', () => this._controller?.invokeToolHandler?.('clearWindowSillTexture'));
      const sillScaleSlider = root.querySelector('[data-fa-nexus-window-sill-scale]');
      if (sillScaleSlider) {
        sillScaleSlider.addEventListener('input', (ev) => this._controller?.invokeToolHandler?.('setWindowSillScale', Number(ev.target.value), false));
        sillScaleSlider.addEventListener('change', (ev) => this._controller?.invokeToolHandler?.('setWindowSillScale', Number(ev.target.value), true));
      }
      const sillScaleDisplay = root.querySelector('[data-fa-nexus-window-sill-scale-display]');
      if (sillScaleDisplay) {
        this._bindDisplayInput(sillScaleDisplay, null, (ev) => this._controller?.invokeToolHandler?.('setWindowSillScale', Number(ev.target.value), true));
      }
      const sillOffsetXSlider = root.querySelector('[data-fa-nexus-window-sill-offset-x]');
      if (sillOffsetXSlider) {
        sillOffsetXSlider.addEventListener('input', (ev) => this._controller?.invokeToolHandler?.('setWindowSillOffsetX', Number(ev.target.value), false));
        sillOffsetXSlider.addEventListener('change', (ev) => this._controller?.invokeToolHandler?.('setWindowSillOffsetX', Number(ev.target.value), true));
      }
      const sillOffsetXDisplay = root.querySelector('[data-fa-nexus-window-sill-offset-x-display]');
      if (sillOffsetXDisplay) {
        this._bindDisplayInput(sillOffsetXDisplay, null, (ev) => this._controller?.invokeToolHandler?.('setWindowSillOffsetX', Number(ev.target.value), true));
      }
      const sillOffsetYSlider = root.querySelector('[data-fa-nexus-window-sill-offset-y]');
      if (sillOffsetYSlider) {
        sillOffsetYSlider.addEventListener('input', (ev) => this._controller?.invokeToolHandler?.('setWindowSillOffsetY', Number(ev.target.value), false));
        sillOffsetYSlider.addEventListener('change', (ev) => this._controller?.invokeToolHandler?.('setWindowSillOffsetY', Number(ev.target.value), true));
      }
      const sillOffsetYDisplay = root.querySelector('[data-fa-nexus-window-sill-offset-y-display]');
      if (sillOffsetYDisplay) {
        this._bindDisplayInput(sillOffsetYDisplay, null, (ev) => this._controller?.invokeToolHandler?.('setWindowSillOffsetY', Number(ev.target.value), true));
      }
      // Window texture controls
      const texturePick = root.querySelector('[data-fa-nexus-window-texture-pick]');
      if (texturePick) texturePick.addEventListener('click', () => this._controller?.invokeToolHandler?.('pickWindowTexture'));
      const textureClear = root.querySelector('[data-fa-nexus-window-texture-clear]');
      if (textureClear) textureClear.addEventListener('click', () => this._controller?.invokeToolHandler?.('clearWindowTexture'));
      const textureScaleSlider = root.querySelector('[data-fa-nexus-window-texture-scale]');
      if (textureScaleSlider) {
        textureScaleSlider.addEventListener('input', (ev) => this._controller?.invokeToolHandler?.('setWindowTextureScale', Number(ev.target.value), false));
        textureScaleSlider.addEventListener('change', (ev) => this._controller?.invokeToolHandler?.('setWindowTextureScale', Number(ev.target.value), true));
      }
      const textureScaleDisplay = root.querySelector('[data-fa-nexus-window-texture-scale-display]');
      if (textureScaleDisplay) {
        this._bindDisplayInput(textureScaleDisplay, null, (ev) => this._controller?.invokeToolHandler?.('setWindowTextureScale', Number(ev.target.value), true));
      }
      const textureOffsetXSlider = root.querySelector('[data-fa-nexus-window-texture-offset-x]');
      if (textureOffsetXSlider) {
        textureOffsetXSlider.addEventListener('input', (ev) => this._controller?.invokeToolHandler?.('setWindowTextureOffsetX', Number(ev.target.value), false));
        textureOffsetXSlider.addEventListener('change', (ev) => this._controller?.invokeToolHandler?.('setWindowTextureOffsetX', Number(ev.target.value), true));
      }
      const textureOffsetXDisplay = root.querySelector('[data-fa-nexus-window-texture-offset-x-display]');
      if (textureOffsetXDisplay) {
        this._bindDisplayInput(textureOffsetXDisplay, null, (ev) => this._controller?.invokeToolHandler?.('setWindowTextureOffsetX', Number(ev.target.value), true));
      }
      const textureOffsetYSlider = root.querySelector('[data-fa-nexus-window-texture-offset-y]');
      if (textureOffsetYSlider) {
        textureOffsetYSlider.addEventListener('input', (ev) => this._controller?.invokeToolHandler?.('setWindowTextureOffsetY', Number(ev.target.value), false));
        textureOffsetYSlider.addEventListener('change', (ev) => this._controller?.invokeToolHandler?.('setWindowTextureOffsetY', Number(ev.target.value), true));
      }
      const textureOffsetYDisplay = root.querySelector('[data-fa-nexus-window-texture-offset-y-display]');
      if (textureOffsetYDisplay) {
        this._bindDisplayInput(textureOffsetYDisplay, null, (ev) => this._controller?.invokeToolHandler?.('setWindowTextureOffsetY', Number(ev.target.value), true));
      }
      // Frame controls
      const framePick = root.querySelector('[data-fa-nexus-window-frame-pick]');
      if (framePick) framePick.addEventListener('click', () => this._controller?.invokeToolHandler?.('pickWindowFrameTexture'));
      const frameClear = root.querySelector('[data-fa-nexus-window-frame-clear]');
      if (frameClear) frameClear.addEventListener('click', () => this._controller?.invokeToolHandler?.('clearWindowFrameTexture'));
      const frameScaleSlider = root.querySelector('[data-fa-nexus-window-frame-scale]');
      if (frameScaleSlider) {
        frameScaleSlider.addEventListener('input', (ev) => this._controller?.invokeToolHandler?.('setWindowFrameScale', Number(ev.target.value), false));
        frameScaleSlider.addEventListener('change', (ev) => this._controller?.invokeToolHandler?.('setWindowFrameScale', Number(ev.target.value), true));
      }
      const frameScaleDisplay = root.querySelector('[data-fa-nexus-window-frame-scale-display]');
      if (frameScaleDisplay) {
        this._bindDisplayInput(frameScaleDisplay, null, (ev) => this._controller?.invokeToolHandler?.('setWindowFrameScale', Number(ev.target.value), true));
      }
      const frameOffsetXSlider = root.querySelector('[data-fa-nexus-window-frame-offset-x]');
      if (frameOffsetXSlider) {
        frameOffsetXSlider.addEventListener('input', (ev) => this._controller?.invokeToolHandler?.('setWindowFrameOffsetX', Number(ev.target.value), false));
        frameOffsetXSlider.addEventListener('change', (ev) => this._controller?.invokeToolHandler?.('setWindowFrameOffsetX', Number(ev.target.value), true));
      }
      const frameOffsetXDisplay = root.querySelector('[data-fa-nexus-window-frame-offset-x-display]');
      if (frameOffsetXDisplay) {
        this._bindDisplayInput(frameOffsetXDisplay, null, (ev) => this._controller?.invokeToolHandler?.('setWindowFrameOffsetX', Number(ev.target.value), true));
      }
      const frameOffsetYSlider = root.querySelector('[data-fa-nexus-window-frame-offset-y]');
      if (frameOffsetYSlider) {
        frameOffsetYSlider.addEventListener('input', (ev) => this._controller?.invokeToolHandler?.('setWindowFrameOffsetY', Number(ev.target.value), false));
        frameOffsetYSlider.addEventListener('change', (ev) => this._controller?.invokeToolHandler?.('setWindowFrameOffsetY', Number(ev.target.value), true));
      }
      const frameOffsetYDisplay = root.querySelector('[data-fa-nexus-window-frame-offset-y-display]');
      if (frameOffsetYDisplay) {
        this._bindDisplayInput(frameOffsetYDisplay, null, (ev) => this._controller?.invokeToolHandler?.('setWindowFrameOffsetY', Number(ev.target.value), true));
      }
      const frameRotationSlider = root.querySelector('[data-fa-nexus-window-frame-rotation]');
      if (frameRotationSlider) {
        frameRotationSlider.addEventListener('input', (ev) => this._controller?.invokeToolHandler?.('setWindowFrameRotation', Number(ev.target.value), false));
        frameRotationSlider.addEventListener('change', (ev) => this._controller?.invokeToolHandler?.('setWindowFrameRotation', Number(ev.target.value), true));
      }
      const frameRotationDisplay = root.querySelector('[data-fa-nexus-window-frame-rotation-display]');
      if (frameRotationDisplay) {
        this._bindDisplayInput(frameRotationDisplay, null, (ev) => this._controller?.invokeToolHandler?.('setWindowFrameRotation', Number(ev.target.value), true));
      }
      root._faWindowBound = true;
    }
    // Sync UI state
    const selection = root.querySelector('[data-fa-nexus-window-selection]');
    if (selection) selection.textContent = state.selectionLabel || '';
    const applyDefault = root.querySelector('[data-fa-nexus-window-apply-default]');
    if (applyDefault) applyDefault.disabled = !!state.disabled || !state.hasSelection;
    const clearSelection = root.querySelector('[data-fa-nexus-window-clear-selection]');
    if (clearSelection) clearSelection.disabled = !!state.disabled || !state.hasSelection;
    const animatedToggle = root.querySelector('[data-fa-nexus-window-animated]');
    if (animatedToggle) {
      animatedToggle.checked = !!state.animated;
      animatedToggle.disabled = !!state.disabled;
    }
    const animSelect = root.querySelector('[data-fa-nexus-window-animation]');
    if (animSelect && Array.isArray(state.animations)) {
      const desired = state.selectedAnimation || '';
      animSelect.value = desired && animSelect.querySelector(`option[value="${desired}"]`) ? desired : animSelect.value;
      animSelect.disabled = !!state.disabled;
    }
    const dirSelect = root.querySelector('[data-fa-nexus-window-direction]');
    if (dirSelect && Array.isArray(state.directions)) {
      const desired = state.direction === -1 ? -1 : 1;
      dirSelect.value = String(desired);
      dirSelect.disabled = !!state.disabled;
    }
    const flipToggle = root.querySelector('[data-fa-nexus-window-flip]');
    if (flipToggle) {
      flipToggle.checked = !!state.flip;
      flipToggle.disabled = !!state.disabled;
    }
    const doubleToggle = root.querySelector('[data-fa-nexus-window-double]');
    if (doubleToggle) {
      doubleToggle.checked = !!state.double;
      doubleToggle.disabled = !!state.disabled;
    }
    // Sill UI
    const sillPick = root.querySelector('[data-fa-nexus-window-sill-pick]');
    if (sillPick) {
      sillPick.disabled = !!state.disabled;
      const labelSpan = sillPick.querySelector('span');
      if (labelSpan) labelSpan.textContent = state.sillLabel || 'Pick Sill';
    }
    const sillClear = root.querySelector('[data-fa-nexus-window-sill-clear]');
    if (sillClear) sillClear.disabled = !!state.disabled;
    const sillSettings = state.sillSettings || null;
    const sillSettingsRoot = root.querySelector('[data-fa-nexus-window-sill-settings]');
    if (sillSettingsRoot) sillSettingsRoot.style.display = sillSettings ? '' : 'none';
    if (sillSettings) {
      const scaleSlider = root.querySelector('[data-fa-nexus-window-sill-scale]');
      const scaleDisplay = root.querySelector('[data-fa-nexus-window-sill-scale-display]');
      const scaleState = {
        min: sillSettings.scaleMin,
        max: sillSettings.scaleMax,
        step: sillSettings.scaleStep,
        value: sillSettings.scale ?? 1,
        defaultValue: sillSettings.scaleDefault,
        display: sillSettings.scaleDisplay || '',
        disabled: !!state.disabled
      };
      if (scaleSlider) {
        if (scaleState.min !== undefined) scaleSlider.min = String(scaleState.min);
        if (scaleState.max !== undefined) scaleSlider.max = String(scaleState.max);
        if (scaleState.step !== undefined) scaleSlider.step = String(scaleState.step);
        if (scaleState.value !== undefined) {
          const next = String(scaleState.value);
          if (scaleSlider.value !== next) scaleSlider.value = next;
        }
        this._applyDefaultValue(scaleSlider, scaleState.defaultValue);
        scaleSlider.disabled = !!scaleState.disabled;
      }
      if (scaleDisplay) {
        this._syncDisplayValue(scaleDisplay, scaleState, { disabled: scaleState.disabled });
      }
      const offsetXSlider = root.querySelector('[data-fa-nexus-window-sill-offset-x]');
      const offsetXDisplay = root.querySelector('[data-fa-nexus-window-sill-offset-x-display]');
      const offsetXState = {
        min: sillSettings.offsetMin,
        max: sillSettings.offsetMax,
        step: sillSettings.offsetStep,
        value: sillSettings.offsetX ?? 0,
        defaultValue: sillSettings.offsetXDefault,
        display: sillSettings.offsetXDisplay || '',
        disabled: !!state.disabled
      };
      if (offsetXSlider) {
        if (offsetXState.min !== undefined) offsetXSlider.min = String(offsetXState.min);
        if (offsetXState.max !== undefined) offsetXSlider.max = String(offsetXState.max);
        if (offsetXState.step !== undefined) offsetXSlider.step = String(offsetXState.step);
        if (offsetXState.value !== undefined) {
          const next = String(offsetXState.value);
          if (offsetXSlider.value !== next) offsetXSlider.value = next;
        }
        this._applyDefaultValue(offsetXSlider, offsetXState.defaultValue);
        offsetXSlider.disabled = !!offsetXState.disabled;
      }
      if (offsetXDisplay) {
        this._syncDisplayValue(offsetXDisplay, offsetXState, { disabled: offsetXState.disabled });
      }
      const offsetYSlider = root.querySelector('[data-fa-nexus-window-sill-offset-y]');
      const offsetYDisplay = root.querySelector('[data-fa-nexus-window-sill-offset-y-display]');
      const offsetYState = {
        min: sillSettings.offsetMin,
        max: sillSettings.offsetMax,
        step: sillSettings.offsetStep,
        value: sillSettings.offsetY ?? 0,
        defaultValue: sillSettings.offsetYDefault,
        display: sillSettings.offsetYDisplay || '',
        disabled: !!state.disabled
      };
      if (offsetYSlider) {
        if (offsetYState.min !== undefined) offsetYSlider.min = String(offsetYState.min);
        if (offsetYState.max !== undefined) offsetYSlider.max = String(offsetYState.max);
        if (offsetYState.step !== undefined) offsetYSlider.step = String(offsetYState.step);
        if (offsetYState.value !== undefined) {
          const next = String(offsetYState.value);
          if (offsetYSlider.value !== next) offsetYSlider.value = next;
        }
        this._applyDefaultValue(offsetYSlider, offsetYState.defaultValue);
        offsetYSlider.disabled = !!offsetYState.disabled;
      }
      if (offsetYDisplay) {
        this._syncDisplayValue(offsetYDisplay, offsetYState, { disabled: offsetYState.disabled });
      }
    }
    // Window texture UI
    const texturePick = root.querySelector('[data-fa-nexus-window-texture-pick]');
    if (texturePick) {
      texturePick.disabled = !!state.disabled;
      const labelSpan = texturePick.querySelector('span');
      if (labelSpan) labelSpan.textContent = state.textureLabel || 'Pick Window';
    }
    const textureClear = root.querySelector('[data-fa-nexus-window-texture-clear]');
    if (textureClear) textureClear.disabled = !!state.disabled;
    const textureSettings = state.textureSettings || null;
    const textureSettingsRoot = root.querySelector('[data-fa-nexus-window-texture-settings]');
    if (textureSettingsRoot) textureSettingsRoot.style.display = textureSettings ? '' : 'none';
    if (textureSettings) {
      const scaleSlider = root.querySelector('[data-fa-nexus-window-texture-scale]');
      const scaleDisplay = root.querySelector('[data-fa-nexus-window-texture-scale-display]');
      const scaleState = {
        min: textureSettings.scaleMin,
        max: textureSettings.scaleMax,
        step: textureSettings.scaleStep,
        value: textureSettings.scale ?? 1,
        defaultValue: textureSettings.scaleDefault,
        display: textureSettings.scaleDisplay || '',
        disabled: !!state.disabled
      };
      if (scaleSlider) {
        if (scaleState.min !== undefined) scaleSlider.min = String(scaleState.min);
        if (scaleState.max !== undefined) scaleSlider.max = String(scaleState.max);
        if (scaleState.step !== undefined) scaleSlider.step = String(scaleState.step);
        if (scaleState.value !== undefined) {
          const next = String(scaleState.value);
          if (scaleSlider.value !== next) scaleSlider.value = next;
        }
        this._applyDefaultValue(scaleSlider, scaleState.defaultValue);
        scaleSlider.disabled = !!scaleState.disabled;
      }
      if (scaleDisplay) {
        this._syncDisplayValue(scaleDisplay, scaleState, { disabled: scaleState.disabled });
      }
      const offsetXSlider = root.querySelector('[data-fa-nexus-window-texture-offset-x]');
      const offsetXDisplay = root.querySelector('[data-fa-nexus-window-texture-offset-x-display]');
      const offsetXState = {
        min: textureSettings.offsetMin,
        max: textureSettings.offsetMax,
        step: textureSettings.offsetStep,
        value: textureSettings.offsetX ?? 0,
        defaultValue: textureSettings.offsetXDefault,
        display: textureSettings.offsetXDisplay || '',
        disabled: !!state.disabled
      };
      if (offsetXSlider) {
        if (offsetXState.min !== undefined) offsetXSlider.min = String(offsetXState.min);
        if (offsetXState.max !== undefined) offsetXSlider.max = String(offsetXState.max);
        if (offsetXState.step !== undefined) offsetXSlider.step = String(offsetXState.step);
        if (offsetXState.value !== undefined) {
          const next = String(offsetXState.value);
          if (offsetXSlider.value !== next) offsetXSlider.value = next;
        }
        this._applyDefaultValue(offsetXSlider, offsetXState.defaultValue);
        offsetXSlider.disabled = !!offsetXState.disabled;
      }
      if (offsetXDisplay) {
        this._syncDisplayValue(offsetXDisplay, offsetXState, { disabled: offsetXState.disabled });
      }
      const offsetYSlider = root.querySelector('[data-fa-nexus-window-texture-offset-y]');
      const offsetYDisplay = root.querySelector('[data-fa-nexus-window-texture-offset-y-display]');
      const offsetYState = {
        min: textureSettings.offsetMin,
        max: textureSettings.offsetMax,
        step: textureSettings.offsetStep,
        value: textureSettings.offsetY ?? 0,
        defaultValue: textureSettings.offsetYDefault,
        display: textureSettings.offsetYDisplay || '',
        disabled: !!state.disabled
      };
      if (offsetYSlider) {
        if (offsetYState.min !== undefined) offsetYSlider.min = String(offsetYState.min);
        if (offsetYState.max !== undefined) offsetYSlider.max = String(offsetYState.max);
        if (offsetYState.step !== undefined) offsetYSlider.step = String(offsetYState.step);
        if (offsetYState.value !== undefined) {
          const next = String(offsetYState.value);
          if (offsetYSlider.value !== next) offsetYSlider.value = next;
        }
        this._applyDefaultValue(offsetYSlider, offsetYState.defaultValue);
        offsetYSlider.disabled = !!offsetYState.disabled;
      }
      if (offsetYDisplay) {
        this._syncDisplayValue(offsetYDisplay, offsetYState, { disabled: offsetYState.disabled });
      }
    }
    // Frame UI
    const framePick = root.querySelector('[data-fa-nexus-window-frame-pick]');
    if (framePick) {
      framePick.disabled = !!state.disabled;
      const labelSpan = framePick.querySelector('span');
      if (labelSpan) labelSpan.textContent = state.frameLabel || 'Pick Frame';
    }
    const frameClear = root.querySelector('[data-fa-nexus-window-frame-clear]');
    if (frameClear) frameClear.disabled = !!state.disabled;
    const frameSettings = state.frameSettings || null;
    const frameSettingsRoot = root.querySelector('[data-fa-nexus-window-frame-settings]');
    if (frameSettingsRoot) frameSettingsRoot.style.display = frameSettings ? '' : 'none';
    if (frameSettings) {
      const scaleSlider = root.querySelector('[data-fa-nexus-window-frame-scale]');
      const scaleDisplay = root.querySelector('[data-fa-nexus-window-frame-scale-display]');
      const scaleState = {
        min: frameSettings.scaleMin,
        max: frameSettings.scaleMax,
        step: frameSettings.scaleStep,
        value: frameSettings.scale ?? 1,
        defaultValue: frameSettings.scaleDefault,
        display: frameSettings.scaleDisplay || '',
        disabled: !!state.disabled
      };
      if (scaleSlider) {
        if (scaleState.min !== undefined) scaleSlider.min = String(scaleState.min);
        if (scaleState.max !== undefined) scaleSlider.max = String(scaleState.max);
        if (scaleState.step !== undefined) scaleSlider.step = String(scaleState.step);
        if (scaleState.value !== undefined) {
          const next = String(scaleState.value);
          if (scaleSlider.value !== next) scaleSlider.value = next;
        }
        this._applyDefaultValue(scaleSlider, scaleState.defaultValue);
        scaleSlider.disabled = !!scaleState.disabled;
      }
      if (scaleDisplay) {
        this._syncDisplayValue(scaleDisplay, scaleState, { disabled: scaleState.disabled });
      }
      const offsetXSlider = root.querySelector('[data-fa-nexus-window-frame-offset-x]');
      const offsetXDisplay = root.querySelector('[data-fa-nexus-window-frame-offset-x-display]');
      const offsetXState = {
        min: frameSettings.offsetMin,
        max: frameSettings.offsetMax,
        step: frameSettings.offsetStep,
        value: frameSettings.offsetX ?? 0,
        defaultValue: frameSettings.offsetXDefault,
        display: frameSettings.offsetXDisplay || '',
        disabled: !!state.disabled
      };
      if (offsetXSlider) {
        if (offsetXState.min !== undefined) offsetXSlider.min = String(offsetXState.min);
        if (offsetXState.max !== undefined) offsetXSlider.max = String(offsetXState.max);
        if (offsetXState.step !== undefined) offsetXSlider.step = String(offsetXState.step);
        if (offsetXState.value !== undefined) {
          const next = String(offsetXState.value);
          if (offsetXSlider.value !== next) offsetXSlider.value = next;
        }
        this._applyDefaultValue(offsetXSlider, offsetXState.defaultValue);
        offsetXSlider.disabled = !!offsetXState.disabled;
      }
      if (offsetXDisplay) {
        this._syncDisplayValue(offsetXDisplay, offsetXState, { disabled: offsetXState.disabled });
      }
      const offsetYSlider = root.querySelector('[data-fa-nexus-window-frame-offset-y]');
      const offsetYDisplay = root.querySelector('[data-fa-nexus-window-frame-offset-y-display]');
      const offsetYState = {
        min: frameSettings.offsetMin,
        max: frameSettings.offsetMax,
        step: frameSettings.offsetStep,
        value: frameSettings.offsetY ?? 0,
        defaultValue: frameSettings.offsetYDefault,
        display: frameSettings.offsetYDisplay || '',
        disabled: !!state.disabled
      };
      if (offsetYSlider) {
        if (offsetYState.min !== undefined) offsetYSlider.min = String(offsetYState.min);
        if (offsetYState.max !== undefined) offsetYSlider.max = String(offsetYState.max);
        if (offsetYState.step !== undefined) offsetYSlider.step = String(offsetYState.step);
        if (offsetYState.value !== undefined) {
          const next = String(offsetYState.value);
          if (offsetYSlider.value !== next) offsetYSlider.value = next;
        }
        this._applyDefaultValue(offsetYSlider, offsetYState.defaultValue);
        offsetYSlider.disabled = !!offsetYState.disabled;
      }
      if (offsetYDisplay) {
        this._syncDisplayValue(offsetYDisplay, offsetYState, { disabled: offsetYState.disabled });
      }
      const rotationSlider = root.querySelector('[data-fa-nexus-window-frame-rotation]');
      const rotationDisplay = root.querySelector('[data-fa-nexus-window-frame-rotation-display]');
      const rotationState = {
        min: frameSettings.rotationMin,
        max: frameSettings.rotationMax,
        step: frameSettings.rotationStep,
        value: frameSettings.rotation ?? 0,
        defaultValue: frameSettings.rotationDefault,
        display: frameSettings.rotationDisplay || '',
        disabled: !!state.disabled || !!frameSettings.rotationDisabled
      };
      if (rotationSlider) {
        if (rotationState.min !== undefined) rotationSlider.min = String(rotationState.min);
        if (rotationState.max !== undefined) rotationSlider.max = String(rotationState.max);
        if (rotationState.step !== undefined) rotationSlider.step = String(rotationState.step);
        if (rotationState.value !== undefined) {
          const next = String(rotationState.value);
          if (rotationSlider.value !== next) rotationSlider.value = next;
        }
        this._applyDefaultValue(rotationSlider, rotationState.defaultValue);
        rotationSlider.disabled = !!rotationState.disabled;
      }
      if (rotationDisplay) {
        this._syncDisplayValue(rotationDisplay, rotationState, { disabled: rotationState.disabled });
      }
    }
  }

  _bindShortcutsControls() {
    this._shortcutsRoot = null;
    this._shortcutsToggle = null;
    this._shortcutsContent = null;
    const root = this.element?.querySelector('[data-fa-nexus-shortcuts-root]');
    if (!root) return;
    this._shortcutsRoot = root;
    const toggle = root.querySelector('[data-fa-nexus-shortcuts-toggle]');
    if (toggle) {
      toggle.addEventListener('click', this._boundShortcutsToggle);
      this._shortcutsToggle = toggle;
    }
    this._shortcutsContent = root.querySelector('[data-fa-nexus-shortcuts-content]');
    this._syncShortcutsControls();
  }

  _unbindShortcutsControls() {
    if (this._shortcutsToggle) {
      try { this._shortcutsToggle.removeEventListener('click', this._boundShortcutsToggle); }
      catch (_) {}
    }
    this._shortcutsRoot = null;
    this._shortcutsToggle = null;
    this._shortcutsContent = null;
  }

  _restoreShortcutsState() {
    const settings = globalThis?.game?.settings;
    if (!settings || typeof settings.get !== 'function') return;
    try {
      const saved = settings.get(MODULE_ID, SHORTCUTS_SETTING_KEY);
      this._applyShortcutsSetting(saved);
    } catch (_) {
      // ignore malformed data
    }
  }

  _applyShortcutsSetting(raw) {
    const next = new Map();
    if (raw && typeof raw === 'object') {
      for (const [key, value] of Object.entries(raw)) {
        const toolId = String(key || '');
        if (!toolId || !value) continue;
        next.set(toolId, true);
      }
    }

    let changed = next.size !== this._shortcutsCollapsedByTool.size;
    if (!changed) {
      for (const [toolId] of next) {
        if (!this._shortcutsCollapsedByTool.has(toolId)) {
          changed = true;
          break;
        }
      }
      if (!changed) {
        for (const key of this._shortcutsCollapsedByTool.keys()) {
          if (!next.has(key)) {
            changed = true;
            break;
          }
        }
      }
    }

    if (!changed) {
      // Still ensure current collapsed flag reflects persisted data
      const activeId = this._activeTool?.id;
      this._shortcutsCollapsed = !!(activeId && next.has(activeId));
      this._syncShortcutsControls();
      return;
    }

    this._shortcutsCollapsedByTool.clear();
    for (const [toolId] of next) {
      this._shortcutsCollapsedByTool.set(toolId, true);
    }

    const activeId = this._activeTool?.id;
    this._shortcutsCollapsed = !!(activeId && this._shortcutsCollapsedByTool.has(activeId));
    this._syncShortcutsControls();
  }

  applyShortcutsSetting(raw) {
    this._applyShortcutsSetting(raw);
  }

  _persistShortcutsState() {
    const settings = globalThis?.game?.settings;
    if (!settings || typeof settings.set !== 'function') return;
    try {
      const payload = {};
      for (const [toolId] of this._shortcutsCollapsedByTool) {
        if (!toolId) continue;
        payload[toolId] = true;
      }
      const maybePromise = settings.set(MODULE_ID, SHORTCUTS_SETTING_KEY, payload);
      if (maybePromise?.catch) maybePromise.catch(() => {});
    } catch (_) {
      // ignore persistence errors
    }
  }

  _syncShortcutsControls() {
    const root = this._shortcutsRoot;
    if (!root) return;
    const collapsed = !!this._shortcutsCollapsed;
    root.classList.toggle('is-collapsed', collapsed);
    if (this._shortcutsToggle) {
      this._shortcutsToggle.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
    }
    if (this._shortcutsContent) {
      this._shortcutsContent.hidden = collapsed;
    }
  }

  _handleShortcutsToggle(event) {
    if (event) {
      event.preventDefault?.();
      event.stopPropagation?.();
    }
    this._shortcutsCollapsed = !this._shortcutsCollapsed;
    const activeId = this._activeTool?.id;
    if (activeId) {
      if (this._shortcutsCollapsed) this._shortcutsCollapsedByTool.set(activeId, true);
      else this._shortcutsCollapsedByTool.delete(activeId);
      this._persistShortcutsState();
    }
    this._syncShortcutsControls();
  }

  _syncPlaceAsControls() {
    const state = this._toolOptionState?.placeAs || {};
    const toggle = this._placeAsToggleButton;
    if (toggle) {
      toggle.setAttribute('aria-expanded', state.open ? 'true' : 'false');
      const labelEl = toggle.querySelector('.fa-nexus-place-as__selection-label');
      if (labelEl) {
        const nextLabel = state.selectedLabel || 'Create new basic actor';
        if (labelEl.textContent !== nextLabel) labelEl.textContent = nextLabel;
      }
      const subtitle = state.selectedSubtitle || '';
      let subtitleEl = toggle.querySelector('.fa-nexus-place-as__selection-subtitle');
      if (subtitle) {
        if (!subtitleEl) {
          subtitleEl = document.createElement('span');
          subtitleEl.className = 'fa-nexus-place-as__selection-subtitle';
          subtitleEl.textContent = subtitle;
          const wrapper = toggle.querySelector('.fa-nexus-place-as__selection-text');
          if (wrapper) wrapper.appendChild(subtitleEl);
        } else if (subtitleEl.textContent !== subtitle) {
          subtitleEl.textContent = subtitle;
        }
        if (subtitleEl) subtitleEl.hidden = false;
      } else if (subtitleEl) {
        subtitleEl.textContent = '';
        subtitleEl.hidden = true;
      }
    }
    const container = this.element?.querySelector('.fa-nexus-place-as');
    if (container) container.classList.toggle('is-open', !!state.open);
    if (this._placeAsSearchInput) {
      this._placeAsSearchInput.value = state.searchValue || '';
      if (state.open) {
        const el = this._placeAsSearchInput;
        if (document.activeElement !== el) {
          try { el.focus({ preventScroll: true }); } catch (_) { el.focus(); }
        }
        const len = el.value.length;
        try { el.setSelectionRange(len, len); } catch (_) {}
      }
    }
    if (this._placeAsLinkedToggle) {
      this._placeAsLinkedToggle.checked = !!state.linked;
      this._placeAsLinkedToggle.disabled = !!state.linkedDisabled;
      const label = this._placeAsLinkedToggle.closest('label');
      if (label && state.linkedTooltip) label.title = state.linkedTooltip;
    }
    const namingState = state.naming || {};
    if (this._placeAsAppendNumberToggle) {
      this._placeAsAppendNumberToggle.checked = !!namingState.appendNumber;
      this._placeAsAppendNumberToggle.disabled = !namingState.available;
      const label = this._placeAsAppendNumberToggle.closest('label');
      if (label && namingState.appendNumberTooltip) label.title = namingState.appendNumberTooltip;
    }
    if (this._placeAsPrependAdjectiveToggle) {
      this._placeAsPrependAdjectiveToggle.checked = !!namingState.prependAdjective;
      this._placeAsPrependAdjectiveToggle.disabled = !namingState.available;
      const label = this._placeAsPrependAdjectiveToggle.closest('label');
      if (label && namingState.prependAdjectiveTooltip) label.title = namingState.prependAdjectiveTooltip;
    }
    if (this._placeAsList) {
      const selectedId = state.selectedId || '';
      const buttons = this._placeAsList.querySelectorAll('[data-place-as-option]');
      for (const button of buttons) {
        const id = button.getAttribute('data-place-as-option');
        button.classList.toggle('is-selected', !!selectedId && id === selectedId);
      }
    }
    const hpState = state.hp || {};
    if (this._placeAsHpModeSelect) {
      if (Array.isArray(hpState.modeOptions)) {
        const optionMap = new Map();
        for (const option of hpState.modeOptions) {
          if (!option) continue;
          optionMap.set(String(option.id), option);
        }
        for (const optionElement of this._placeAsHpModeSelect.options) {
          const entry = optionMap.get(optionElement.value);
          if (!entry) continue;
          optionElement.disabled = !!entry.disabled;
          if (entry.label && optionElement.textContent !== entry.label) {
            optionElement.textContent = entry.label;
          }
          optionElement.selected = !!entry.selected;
        }
      }
      if (hpState.mode) this._placeAsHpModeSelect.value = hpState.mode;
    }
    if (this._placeAsHpModeHint) {
      const hint = hpState.modeHint || '';
      this._placeAsHpModeHint.textContent = hint;
      this._placeAsHpModeHint.hidden = !hint;
    }
    if (this._placeAsHpPercentRow) {
      this._placeAsHpPercentRow.hidden = !hpState.showPercent;
    }
    if (this._placeAsHpPercentInput) {
      const percentFocused = document.activeElement === this._placeAsHpPercentInput;
      const percentValue = hpState.percentValue !== undefined && hpState.percentValue !== null
        ? String(hpState.percentValue)
        : '';
      if (!percentFocused && this._placeAsHpPercentInput.value !== percentValue) {
        this._placeAsHpPercentInput.value = percentValue;
      }
      this._placeAsHpPercentInput.disabled = !hpState.showPercent;
    }
    if (this._placeAsHpPercentHint) {
      const hint = hpState.percentHint || '';
      this._placeAsHpPercentHint.textContent = hint;
      this._placeAsHpPercentHint.hidden = !hpState.showPercent || !hint;
    }
    if (this._placeAsHpStaticRow) {
      this._placeAsHpStaticRow.hidden = !hpState.showStatic;
    }
    if (this._placeAsHpStaticInput) {
      const staticFocused = document.activeElement === this._placeAsHpStaticInput;
      const staticValue = typeof hpState.staticValue === 'string' ? hpState.staticValue : '';
      if (!staticFocused && this._placeAsHpStaticInput.value !== staticValue) {
        this._placeAsHpStaticInput.value = staticValue;
      }
      this._placeAsHpStaticInput.classList.toggle('has-error', !!hpState.staticError);
      if (hpState.staticError) {
        this._placeAsHpStaticInput.setAttribute('aria-invalid', 'true');
      } else {
        this._placeAsHpStaticInput.removeAttribute('aria-invalid');
      }
      this._placeAsHpStaticInput.disabled = !hpState.showStatic;
    }
    if (this._placeAsHpStaticHint) {
      const hint = hpState.staticHint || '';
      this._placeAsHpStaticHint.textContent = hint;
      this._placeAsHpStaticHint.hidden = !hpState.showStatic || !hint;
    }
    if (this._placeAsHpStaticError) {
      const error = hpState.staticError || '';
      this._placeAsHpStaticError.textContent = error;
      this._placeAsHpStaticError.hidden = !error;
    }
  }

  _handlePlaceAsSearch(event) {
    const value = event?.currentTarget?.value ?? '';
    const result = this._controller?.invokeToolHandler?.('setPlaceAsSearch', value);
    if (result?.then) {
      result.finally(() => this._syncPlaceAsControls());
    } else {
      this._syncPlaceAsControls();
    }
  }

  _handlePlaceAsOptionClick(event) {
    const button = event?.target?.closest?.('[data-place-as-option]');
    if (!button) return;
    event.preventDefault();
    event.stopPropagation();
    const optionId = button.getAttribute('data-place-as-option') || '';
    const result = this._controller?.invokeToolHandler?.('selectPlaceAsOption', optionId);
    if (result?.then) {
      result.finally(() => this._syncPlaceAsControls());
    } else {
      this._syncPlaceAsControls();
    }
  }

  _handlePlaceAsLinked(event) {
    const checked = !!event?.currentTarget?.checked;
    const result = this._controller?.invokeToolHandler?.('setPlaceAsLinked', checked);
    if (result?.then) {
      result.finally(() => this._syncPlaceAsControls());
    } else {
      this._syncPlaceAsControls();
    }
  }

  _handlePlaceAsAppendNumber(event) {
    const checked = !!event?.currentTarget?.checked;
    const result = this._controller?.invokeToolHandler?.('setPlaceAsAppendNumber', checked);
    if (result?.then) {
      result.finally(() => this._syncPlaceAsControls());
    } else {
      this._syncPlaceAsControls();
    }
  }

  _handlePlaceAsPrependAdjective(event) {
    const checked = !!event?.currentTarget?.checked;
    const result = this._controller?.invokeToolHandler?.('setPlaceAsPrependAdjective', checked);
    if (result?.then) {
      result.finally(() => this._syncPlaceAsControls());
    } else {
      this._syncPlaceAsControls();
    }
  }

  _handlePlaceAsToggle(event) {
    if (event) {
      event.preventDefault?.();
      event.stopPropagation?.();
    }
    const result = this._controller?.invokeToolHandler?.('togglePlaceAsOpen');
    if (result?.then) {
      result.finally(() => this._syncPlaceAsControls());
    } else {
      this._syncPlaceAsControls();
    }
  }

  _handlePlaceAsFilter(event) {
    if (event) {
      event.preventDefault?.();
      event.stopPropagation?.();
    }
    this._controller?.invokeToolHandler?.('openCompendiumFilterDialog');
  }

  _handlePlaceAsHpMode(event) {
    const value = event?.currentTarget?.value ?? '';
    const result = this._controller?.invokeToolHandler?.('setPlaceAsHpMode', value);
    if (result?.then) {
      result.finally(() => this._syncPlaceAsControls());
    } else {
      this._syncPlaceAsControls();
    }
  }

  _handlePlaceAsHpPercent(event) {
    const value = event?.currentTarget?.value ?? '';
    const result = this._controller?.invokeToolHandler?.('setPlaceAsHpPercent', value);
    if (result?.then) {
      result.finally(() => this._syncPlaceAsControls());
    } else {
      this._syncPlaceAsControls();
    }
  }

  _handlePlaceAsHpStatic(event) {
    const value = event?.currentTarget?.value ?? '';
    const result = this._controller?.invokeToolHandler?.('setPlaceAsHpStatic', value);
    if (result?.then) {
      result.finally(() => this._syncPlaceAsControls());
    } else {
      this._syncPlaceAsControls();
    }
  }

  _persistWindowPosition() {
    if (this._restoringPosition) return;
    const settings = globalThis?.game?.settings;
    if (!settings || typeof settings.set !== 'function') return;
    try {
      const pos = this.position;
      if (!pos) return;
      const state = {};
      if (Number.isFinite(pos.left)) state.left = pos.left;
      if (Number.isFinite(pos.top)) state.top = pos.top;
      if (Number.isFinite(pos.width)) state.width = pos.width;
      if (Number.isFinite(pos.height)) state.height = pos.height;
      if (!Object.keys(state).length) return;
      const maybePromise = settings.set(MODULE_ID, TOOL_WINDOW_SETTING_KEY, state);
      if (maybePromise?.catch) maybePromise.catch(() => {});
    } catch (_) {}
  }

  _restoreWindowPosition() {
    const settings = globalThis?.game?.settings;
    if (!settings || typeof settings.get !== 'function') return;
    try {
      const saved = settings.get(MODULE_ID, TOOL_WINDOW_SETTING_KEY);
      if (!saved || typeof saved !== 'object') return;
      const current = foundry.utils.deepClone(this.position ?? {}) || {};
      let hasValue = false;
      if (Number.isFinite(saved.left)) { current.left = saved.left; hasValue = true; }
      if (Number.isFinite(saved.top)) { current.top = saved.top; hasValue = true; }
      if (Number.isFinite(saved.width)) { current.width = saved.width; hasValue = true; }
      if (Number.isFinite(saved.height)) { 
        current.height = saved.height; 
        this._savedHeight = saved.height; // Store for resize observer
        hasValue = true; 
      }
      if (!hasValue) return;
      this._restoringPosition = true;
      try { super.setPosition(current); }
      finally { this._restoringPosition = false; }
    } catch (_) {
      this._restoringPosition = false;
    }
  }

  _setupResizeObserver() {
    if (this._resizeObserver) return;
    try {
      const frame = this.element?.querySelector('.window-frame');
      if (!frame) return;

      this._resizeObserver = new ResizeObserver((entries) => {
        if (this._userResizing || !this._savedHeight) return;

        for (const entry of entries) {
          const { height } = entry.contentRect;
          if (Math.abs(height - this._savedHeight) > 10) { // Allow some tolerance
            // Height changed significantly, likely due to auto-sizing
            this._forceSavedHeight();
            break;
          }
        }
      });
      this._resizeObserver.observe(frame);

      // Listen for user resize events
      const handleResizeStart = () => { this._userResizing = true; };
      const handleResizeEnd = () => { 
        this._userResizing = false;
        // Update saved height after user resize
        this._savedHeight = this.position?.height || this._savedHeight;
      };

      frame.addEventListener('mousedown', (e) => {
        if (e.target.closest('.window-resizable-handle')) handleResizeStart();
      });
      frame.addEventListener('touchstart', (e) => {
        if (e.target.closest('.window-resizable-handle')) handleResizeStart();
      });
      document.addEventListener('mouseup', handleResizeEnd);
      document.addEventListener('touchend', handleResizeEnd);

    } catch (error) {
      Logger.warn('ToolOptionsWindow.resizeObserver.setupFailed', error);
    }
  }

  _cleanupResizeObserver() {
    if (this._resizeObserver) {
      try { this._resizeObserver.disconnect(); } catch (_) {}
      this._resizeObserver = null;
    }
    this._userResizing = false;
    this._savedHeight = null;
  }

  _forceSavedHeight() {
    if (!this._savedHeight) return;
    const current = foundry.utils.deepClone(this.position ?? {}) || {};
    current.height = this._savedHeight;
    this._restoringPosition = true;
    try { super.setPosition(current); }
    finally { this._restoringPosition = false; }
  }
}

/**
 * Central controller that coordinates the tool options window across placement
 * managers and premium editors.
 */
class ToolOptionsController {
  constructor() {
    this._window = null;
    this._activeTools = new Map();
    this._needsGridSnapResync = false;
    this._gridSnapEnabled = this._readGridSnapSetting();
    this._needsGridSnapSubdivResync = false;
    this._gridSnapSubdivisions = this._readGridSnapSubdivisionSetting();
    this._settingsHook = null;
    this._settingsAvailable = this._canAccessSettings();
    this._ensureSettingsListener();
    this._toolOptions = new Map();
    this._stateListeners = new Set();
  }

  activateTool(toolId, { label } = {}) {
    if (!toolId) return;
    const id = String(toolId);
    const entry = { id, label: label ? String(label) : id };
    this._activeTools.set(id, entry);
    const win = this._ensureWindow();
    const options = this._getToolState(id);
    if (options) win.setActiveToolOptions(options, { suppressRender: true });
    else win.setActiveToolOptions({}, { suppressRender: true });
    win.setActiveTool(entry);
    if (!win.rendered) win.render(true);
    else win.render(false);
    try { win.bringToFront?.(); } catch (_) {}
    this._notifyStateListeners();
  }

  updateTool(toolId, { label } = {}) {
    if (!toolId || !this._activeTools.has(String(toolId))) return;
    const id = String(toolId);
    const existing = this._activeTools.get(id);
    const next = {
      id,
      label: label ? String(label) : (existing?.label ?? id)
    };
    this._activeTools.set(id, next);
    if (this._window) this._window.setActiveTool(next);
    this._notifyStateListeners();
  }

  deactivateTool(toolId) {
    if (!toolId) return;
    const id = String(toolId);
    const current = this._window?.activeTool?.id ?? null;
    const removed = this._activeTools.delete(id);

    if (!removed) {
      this._notifyStateListeners();
      return;
    }

    if (!this._activeTools.size) {
      if (this._window?.rendered) {
        try { this._window.close({ animate: false }); } catch (_) {}
      } else if (this._window) {
        try { this._window.setActiveTool(null); } catch (_) {}
        this._window = null;
      }
      this._notifyStateListeners();
      return;
    }

    if (current === id) {
      const [, lastEntry] = Array.from(this._activeTools).pop() || [];
      if (lastEntry) this._window?.setActiveTool(lastEntry);
      else if (this._window) {
        try { this._window.setActiveTool(null); } catch (_) {}
      }
    }
    this._notifyStateListeners();
  }

  _ensureWindow() {
    if (this._window) return this._window;
    const available = this.supportsGridSnap();
    this._window = new ToolOptionsWindow({
      controller: this,
      gridSnapEnabled: this._gridSnapEnabled,
      gridSnapAvailable: available,
      gridSnapSubdivisions: this._gridSnapSubdivisions,
      toolOptions: this._getToolState(null)
    });
    return this._window;
  }

  setToolOptions(toolId, payload = {}) {
    if (!toolId) return;
    const id = String(toolId);
    const state = payload.state && typeof payload.state === 'object' ? payload.state : (typeof payload === 'object' ? payload : {});
    const handlers = payload.handlers && typeof payload.handlers === 'object' ? payload.handlers : {};
    const suppressRender = payload?.suppressRender !== undefined ? !!payload.suppressRender : true;
    this._toolOptions.set(id, { state, handlers });
    if (this._window && this._window.activeTool?.id === id) {
      this._window.setActiveToolOptions(state, { suppressRender });
    }
  }

  reopenWindow({ focus = true } = {}) {
    if (!this._activeTools.size) {
      this._notifyStateListeners();
      return false;
    }
    const win = this._ensureWindow();
    let entry = null;
    const activeId = win?.activeTool?.id;
    if (activeId && this._activeTools.has(activeId)) {
      entry = this._activeTools.get(activeId);
    } else {
      const entries = Array.from(this._activeTools.values());
      entry = entries.length ? entries[entries.length - 1] : null;
    }
    if (entry) {
      const state = this._getToolState(entry.id);
      if (state) win.setActiveToolOptions(state, { suppressRender: true });
      else win.setActiveToolOptions({}, { suppressRender: true });
      win.setActiveTool(entry);
    } else {
      win.setActiveToolOptions({}, { suppressRender: true });
      try { win.setActiveTool(null); } catch (_) {}
    }
    if (!win.rendered) win.render(true);
    else win.render(false);
    if (win?.minimized) {
      try { win.maximize(); } catch (_) {}
    }
    if (focus) {
      try { win.bringToFront?.(); } catch (_) {}
    }
    this._notifyStateListeners();
    return true;
  }

  getGridSnapSubdivisions() {
    return this._gridSnapSubdivisions;
  }

  requestDropShadowToggle(enabled) {
    const activeId = this._window?.activeTool?.id;
    if (!activeId) return false;
    const handler = this._getToolHandlers(activeId).setDropShadowEnabled;
    if (typeof handler !== 'function') return false;
    try {
      const result = handler(enabled);
      if (result?.then) return result;
      return result;
    } catch (_) {
      return false;
    }
  }

  requestCustomToggle(toggleId, enabled) {
    const activeId = this._window?.activeTool?.id;
    if (!activeId || !toggleId) return false;
    const customHandlers = this._getToolHandlers(activeId).customToggles || {};
    const handler = customHandlers?.[toggleId];
    if (typeof handler !== 'function') return false;
    try {
      const result = handler(enabled);
      if (result?.then) return result;
      return result;
    } catch (_) {
      return false;
    }
  }

  invokeToolHandler(handlerName, ...args) {
    if (!handlerName) return false;
    const activeId = this._window?.activeTool?.id;
    if (!activeId) return false;
    const handler = this._getToolHandlers(activeId)?.[handlerName];
    if (typeof handler !== 'function') return false;
    try {
      const result = handler(...args);
      if (result?.then) return result;
      return result;
    } catch (_) {
      return false;
    }
  }

  updateDropShadowPreview(toolId, preview) {
    if (!toolId) return;
    const id = String(toolId);
    if (!this._toolOptions.has(id)) return;
    const entry = this._toolOptions.get(id);
    if (!entry || typeof entry !== 'object') return;
    const state = entry.state && typeof entry.state === 'object' ? entry.state : {};
    const controls = state.dropShadowControls && typeof state.dropShadowControls === 'object'
      ? state.dropShadowControls
      : {};
    const normalized = preview && typeof preview === 'object' && typeof preview.src === 'string' && preview.src.length > 0
      ? {
          src: preview.src,
          width: Number.isFinite(preview.width) ? Number(preview.width) : null,
          height: Number.isFinite(preview.height) ? Number(preview.height) : null,
          signature: typeof preview.signature === 'string' ? preview.signature : null,
          updatedAt: Number.isFinite(preview.updatedAt) ? Number(preview.updatedAt) : Date.now(),
          alt: typeof preview.alt === 'string' ? preview.alt : ''
        }
      : null;
    if (normalized) controls.preview = normalized;
    else delete controls.preview;
    state.dropShadowControls = controls;
    entry.state = state;
    this._toolOptions.set(id, entry);
    if (this._window?.activeTool?.id === id) {
      this._window.applyDropShadowPreview(normalized);
    }
  }

  _getToolState(toolId) {
    if (!toolId) return {};
    return this._toolOptions.get(String(toolId))?.state || {};
  }

  _getToolHandlers(toolId) {
    if (!toolId) return {};
    return this._toolOptions.get(String(toolId))?.handlers || {};
  }

  supportsGridSnap() {
    this._ensureSettingsListener();
    const available = this._canAccessSettings();
    const availabilityChanged = this._settingsAvailable !== available;
    if (availabilityChanged) {
      this._settingsAvailable = available;
      if (!available) {
        if (this._window) this._window.setGridSnapAvailable(false);
      }
    }
    if (available && (availabilityChanged || this._needsGridSnapResync)) {
      const stored = this._readGridSnapSetting();
      this._updateGridSnapState(stored, { syncWindow: true });
    }
    if (available && (availabilityChanged || this._needsGridSnapSubdivResync)) {
      const storedSubdiv = this._readGridSnapSubdivisionSetting();
      this._updateGridSnapSubdivisionsState(storedSubdiv, { syncWindow: true });
    }
    if (this._window) this._window.setGridSnapAvailable(available);
    return available;
  }

  isGridSnapSettingAvailable() {
    return this._settingsAvailable;
  }

  async requestGridSnapToggle(enabled) {
    const next = !!enabled;
    const previous = !!this._gridSnapEnabled;
    const canPersist = this.supportsGridSnap();
    this._updateGridSnapState(next, { syncWindow: true });
    if (!canPersist) return true;
    try {
      await game.settings.set(MODULE_ID, GRID_SNAP_SETTING_KEY, next);
      return true;
    } catch (error) {
      Logger.warn('ToolOptionsController.gridSnap.saveFailed', error);
      this._updateGridSnapState(previous, { syncWindow: true });
      try {
        ui?.notifications?.warn?.('Failed to update grid snapping. Please try again.');
      } catch (_) {}
      return false;
    }
  }

  async requestGridSnapSubdivisionChange(value) {
    const next = this._normalizeGridSnapSubdivisionValue(value);
    const previous = this._gridSnapSubdivisions;
    if (next === previous) return true;
    const canPersist = this.supportsGridSnap();
    this._updateGridSnapSubdivisionsState(next, { syncWindow: true });
    if (!canPersist) return true;
    try {
      await game.settings.set(MODULE_ID, GRID_SNAP_SUBDIV_SETTING_KEY, next);
      return true;
    } catch (error) {
      Logger.warn('ToolOptionsController.gridSnapSubdiv.saveFailed', error);
      this._updateGridSnapSubdivisionsState(previous, { syncWindow: true });
      try {
        ui?.notifications?.warn?.('Failed to update snap density. Please try again.');
      } catch (_) {}
      return false;
    }
  }

  _ensureSettingsListener() {
    if (this._settingsHook || !globalThis?.Hooks || typeof globalThis.Hooks.on !== 'function') return;
    const handler = (setting) => this._handleSettingUpdated(setting);
    try {
      globalThis.Hooks.on('updateSetting', handler);
      this._settingsHook = handler;
    } catch (error) {
      Logger.warn('ToolOptionsController.settingsHookFailed', error);
      this._settingsHook = null;
    }
  }

  _handleSettingUpdated(setting) {
    if (!setting || setting.namespace !== MODULE_ID) return;
    if (setting.key === GRID_SNAP_SETTING_KEY) {
      this._updateGridSnapState(!!setting.value, { syncWindow: true });
      return;
    }
    if (setting.key === GRID_SNAP_SUBDIV_SETTING_KEY) {
      this._updateGridSnapSubdivisionsState(setting.value, { syncWindow: true });
      return;
    }
    if (setting.key === SHORTCUTS_SETTING_KEY) {
      this._window?.applyShortcutsSetting?.(setting.value);
    }
  }

  _updateGridSnapState(value, { syncWindow = false } = {}) {
    const next = !!value;
    if (this._gridSnapEnabled === next) {
      if (syncWindow && this._window) this._window.setGridSnapEnabled(next);
      return;
    }
    this._gridSnapEnabled = next;
    if (syncWindow && this._window) this._window.setGridSnapEnabled(next);
    try {
      const hooks = globalThis?.Hooks;
      hooks?.callAll?.('fa-nexus:gridSnapChanged', next);
    } catch (_) {}
  }

  _normalizeGridSnapSubdivisionValue(value) {
    return normalizeGridSnapSubdivision(value);
  }

  _updateGridSnapSubdivisionsState(value, { syncWindow = false } = {}) {
    const next = this._normalizeGridSnapSubdivisionValue(value);
    if (this._gridSnapSubdivisions === next) {
      if (syncWindow && this._window) this._window.setGridSnapSubdivisions(next);
      return;
    }
    this._gridSnapSubdivisions = next;
    if (syncWindow && this._window) this._window.setGridSnapSubdivisions(next);
    try {
      const hooks = globalThis?.Hooks;
      hooks?.callAll?.('fa-nexus:gridSnapSubdivisionsChanged', { value: next });
    } catch (_) {}
  }

  _readGridSnapSetting() {
    if (!this._canAccessSettings()) {
      this._needsGridSnapResync = true;
      return true;
    }
    try {
      const value = !!game.settings.get(MODULE_ID, GRID_SNAP_SETTING_KEY);
      this._needsGridSnapResync = false;
      return value;
    } catch (error) {
      Logger.warn('ToolOptionsController.gridSnap.readFailed', error);
      this._needsGridSnapResync = true;
      return true;
    }
  }

  _readGridSnapSubdivisionSetting() {
    if (!this._canAccessSettings()) {
      this._needsGridSnapSubdivResync = true;
      return GRID_SNAP_SUBDIV_DEFAULT;
    }
    try {
      const value = readGridSnapSubdivisionSetting();
      this._needsGridSnapSubdivResync = false;
      return value;
    } catch (error) {
      Logger.warn('ToolOptionsController.gridSnapSubdiv.readFailed', error);
      this._needsGridSnapSubdivResync = true;
      return GRID_SNAP_SUBDIV_DEFAULT;
    }
  }

  _canAccessSettings() {
    const settings = globalThis?.game?.settings;
    return !!(settings && typeof settings.get === 'function' && typeof settings.set === 'function');
  }

  _handleWindowClosed(instance) {
    if (this._window === instance) {
      this._window = null;
    }
    this._notifyStateListeners();
  }

  addStateListener(listener) {
    if (typeof listener !== 'function') return () => {};
    this._stateListeners.add(listener);
    try {
      listener(this.getWindowState());
    } catch (_) {}
    return () => {
      this._stateListeners.delete(listener);
    };
  }

  getWindowState() {
    return this._collectStateSnapshot();
  }

  _collectStateSnapshot() {
    return {
      hasActiveTool: this._activeTools.size > 0,
      isWindowOpen: !!this._window,
      activeToolId: this._window?.activeTool?.id ?? null
    };
  }

  _notifyStateListeners() {
    if (!this._stateListeners.size) return;
    const snapshot = this._collectStateSnapshot();
    for (const listener of this._stateListeners) {
      try {
        listener(snapshot);
      } catch (_) {}
    }
  }
}

export const toolOptionsController = new ToolOptionsController();
export { ToolOptionsWindow };
