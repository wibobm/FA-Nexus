const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

/**
 * PlaceAsCompendiumFilterDialog
 * Dialog for filtering which compendium packs appear in the "Place Tokens As" actor search.
 */
export class PlaceAsCompendiumFilterDialog extends HandlebarsApplicationMixin(ApplicationV2) {
  static DEFAULT_OPTIONS = {
    id: 'fa-nexus-place-as-compendium-filter',
    tag: 'form',
    window: {
      frame: true,
      positioned: true,
      resizable: true,
      title: 'Filter Actor Compendiums'
    },
    position: { width: 420, height: 500 }
  };

  static PARTS = {
    form: { template: 'modules/fa-nexus/templates/tokens/place-as-compendium-filter-dialog.hbs' }
  };

  constructor({ manager, packs = [] } = {}) {
    super();
    this._manager = manager;
    this._packs = packs;
    this._searchQuery = '';
  }

  async _prepareContext() {
    const query = this._searchQuery.toLowerCase().trim();
    const filteredPacks = query
      ? this._packs.filter((pack) => {
          const labelMatch = pack.label.toLowerCase().includes(query);
          const folderMatch = pack.folder?.toLowerCase().includes(query);
          const idMatch = pack.id.toLowerCase().includes(query);
          return labelMatch || folderMatch || idMatch;
        })
      : this._packs;

    // Group packs by folder
    const groups = [];
    const folderMap = new Map();
    for (const pack of filteredPacks) {
      const folderName = pack.folder || 'Ungrouped';
      if (!folderMap.has(folderName)) {
        const group = { folder: folderName, packs: [], isUngrouped: !pack.folder };
        folderMap.set(folderName, group);
        groups.push(group);
      }
      folderMap.get(folderName).packs.push(pack);
    }
    // Sort groups: named folders first (alphabetically), then ungrouped
    groups.sort((a, b) => {
      if (a.isUngrouped && !b.isUngrouped) return 1;
      if (!a.isUngrouped && b.isUngrouped) return -1;
      return a.folder.localeCompare(b.folder);
    });

    const includedCount = this._packs.filter((p) => !p.excluded).length;
    const excludedCount = this._packs.filter((p) => p.excluded).length;
    const totalCount = this._packs.length;

    return {
      groups,
      hasGroups: groups.length > 0,
      hasPacks: filteredPacks.length > 0,
      totalCount,
      includedCount,
      excludedCount,
      hasExcluded: excludedCount > 0,
      searchQuery: this._searchQuery,
      emptyMessage: query ? 'No compendiums match your search.' : 'No actor compendiums available.'
    };
  }

  _onRender(context, options) {
    super._onRender(context, options);
    this._bindEvents();
  }

  _bindEvents() {
    const root = this.element;
    if (!root) return;

    const searchInput = root.querySelector('[data-filter-search]');
    if (searchInput) {
      searchInput.addEventListener('input', (event) => this._handleSearch(event));
    }

    const checkboxes = root.querySelectorAll('[data-pack-toggle]');
    for (const checkbox of checkboxes) {
      checkbox.addEventListener('change', (event) => this._handlePackToggle(event));
    }

    const includeAllButton = root.querySelector('[data-include-all]');
    if (includeAllButton) {
      includeAllButton.addEventListener('click', () => this._handleIncludeAll());
    }

    const excludeAllButton = root.querySelector('[data-exclude-all]');
    if (excludeAllButton) {
      excludeAllButton.addEventListener('click', () => this._handleExcludeAll());
    }
  }

  _handleSearch(event) {
    this._searchQuery = event?.target?.value || '';
    this.render();
  }

  _handlePackToggle(event) {
    const checkbox = event?.target;
    if (!checkbox) return;
    const packId = checkbox.dataset.packToggle;
    if (!packId) return;
    const included = checkbox.checked;
    const pack = this._packs.find((p) => p.id === packId);
    if (pack) {
      pack.excluded = !included;
    }
    this._manager?._setPackExcluded?.(packId, !included);
  }

  _handleIncludeAll() {
    const packIds = this._packs.map((p) => p.id);
    for (const pack of this._packs) {
      pack.excluded = false;
    }
    this._manager?._setMultiplePacksExcluded?.(packIds, false);
    this.render();
  }

  _handleExcludeAll() {
    const packIds = this._packs.map((p) => p.id);
    for (const pack of this._packs) {
      pack.excluded = true;
    }
    this._manager?._setMultiplePacksExcluded?.(packIds, true);
    this.render();
  }
}
