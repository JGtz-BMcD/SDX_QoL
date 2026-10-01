// ==UserScript==
// @name         SDx QoL Improvement
// @namespace    https://burnsmcd.com
// @version      1.5
// @description  SDx quality-of-life improvements: shift-select, keyboard shortcuts, truncated-cell tooltips, session-expiry indicator, column manager, per-list remembered page size (applied before the first load), To Do List row highlighting, optional auto-close of the To Do List step-details panel, bulk file download (bypasses SDx's 100-file dialog limit), and in-page PDF preview with next/previous, search, zoom, fit, print and download.
// @match        https://*.intergraphsmartcloud.com/*
// @grant        none
// @require      https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js
// @downloadURL https://raw.githubusercontent.com/JGtz-BMcD/SDX_QoL/main/SDx-QoL-Improvement.user.js
// @updateURL https://raw.githubusercontent.com/JGtz-BMcD/SDX_QoL/main/SDx-QoL-Improvement.user.js
// @run-at       document-start
// @author        Josue Gutierrez
// ==/UserScript==
(function () {
    'use strict';
    if (window.__sdxQoLImprovementV10Loaded) return;
    window.__sdxQoLImprovementV10Loaded = true;
    const SCRIPT_NAME = 'SDx QoL Improvement';
    const STORAGE_PREFIX = 'sdxQoLSettingsV10';
    const CHECKBOX_SELECTOR = 'input[type="checkbox"].mdc-checkbox__native-control';
    let lastCheckbox = null;
    let lastUrl = location.href;
    let activeTab = 'columns';
    // Row/page-size: the user sets it via Apply (or a preset) in the Rows
    // tab, it's saved per-list, and maybeAutoApplyPageSize() restores it
    // automatically the next time that same list loads. It does not hide
    // rendered rows - it only asks the Kendo grid/pager for a different page
    // size.
    let lastAppliedPageSize = null;
    const MANAGER = {
        buttonId: 'sdx-qol-manager-button',
        menuId: 'sdx-qol-manager-menu',
        styleId: 'sdx-qol-manager-style'
    };
    const DL_BUTTON_ID = 'sdx-qol-dl-files-btn';
    const DL_MODAL_ID = 'sdx-qol-dl-files-modal';
    console.log(`${SCRIPT_NAME} loaded`);
    //////////////////////////////////////////////////////////////////////
    // MODULE 0
    // EARLY KENDO DATASOURCE HOOK (page size)
    //////////////////////////////////////////////////////////////////////
    // Confirmed via live capture: SDx's list grid has serverPaging on, its
    // dataSource is built separately from the grid (grid.options.dataSource
    // is null) and defaults to pageSize 100, so its very first request is
    // .../AllDocuments_<id>?$top=100. Restoring the saved size AFTER that
    // load forces a second full re-render. Instead, patch Kendo's DataSource
    // constructor as soon as Kendo exists, so a list whose saved size isn't
    // 100 is created with that size and loads once.
    // Entirely best-effort: if the hook never finds Kendo, or the saved size
    // can't be determined yet, nothing changes and maybeAutoApplyPageSize()
    // (Module 4) restores it afterwards exactly as before.
    const SDX_DEFAULT_PAGE_SIZE = 100;
    function patchKendoDataSource(DataSourceClass) {
        const proto = DataSourceClass && (DataSourceClass.fn || DataSourceClass.prototype);
        if (!proto || typeof proto.init !== 'function') return false;
        if (proto.__sdxQoLPageSizePatched) return true;
        const originalInit = proto.init;
        proto.init = function (options) {
            try {
                if (
                    isTopFrame() &&
                    options && typeof options === 'object' && !Array.isArray(options) &&
                    options.serverPaging &&
                    Number(options.pageSize) === SDX_DEFAULT_PAGE_SIZE
                ) {
                    const desired = Math.max(1, Number(loadSettings().pageSize) || SDX_DEFAULT_PAGE_SIZE);
                    if (desired !== SDX_DEFAULT_PAGE_SIZE) {
                        options.pageSize = desired;
                        console.log(`${SCRIPT_NAME}: page-size hook - created list data source at saved size ${desired} (skipping the 100-row first load)`);
                    }
                }
            } catch (err) {
                console.warn('SDx QoL: page-size hook failed (falling back to post-load restore)', err);
            }
            return originalInit.apply(this, arguments);
        };
        proto.__sdxQoLPageSizePatched = true;
        return true;
    }
    (function installKendoDataSourceHook() {
        if (!isTopFrame()) return;
        const startedAt = Date.now();
        const timer = setInterval(function () {
            let patched = false;
            try {
                const k = window.kendo;
                if (k && k.data && k.data.DataSource) {
                    patched = patchKendoDataSource(k.data.DataSource);
                    if (patched) console.log(`${SCRIPT_NAME}: page-size hook installed`);
                }
            } catch (err) {
                console.warn('SDx QoL: could not install page-size hook', err);
                patched = true; // don't retry a throwing install forever
            }
            if (patched || Date.now() - startedAt > 60000) clearInterval(timer);
        }, 5);
    })();
    //////////////////////////////////////////////////////////////////////
    // MODULE 0B
    // PASSIVE AUTH-TOKEN WATCHER
    //////////////////////////////////////////////////////////////////////
    // SDx renews its session token while you work, and the renewed token is
    // not always written to sessionStorage. To always use a current one, this
    // only LOOKS at the Authorization header SDx's own page already attaches
    // to its own requests (it changes nothing about those requests) and
    // remembers the one that expires latest. Used by getSdxAuthToken().
    let capturedAuthToken = null;
    function rememberAuthToken(raw) {
        const token = stripBearerPrefix(raw);
        if (!looksLikeJwt(token)) return;
        if (!capturedAuthToken || jwtExpiryMs(token) >= jwtExpiryMs(capturedAuthToken)) {
            capturedAuthToken = token;
        }
    }
    function readHeaderCaseInsensitive(headers, name) {
        if (!headers) return null;
        try {
            if (typeof Headers !== 'undefined' && headers instanceof Headers) return headers.get(name);
            if (Array.isArray(headers)) {
                const pair = headers.find(p => String(p[0]).toLowerCase() === name);
                return pair ? pair[1] : null;
            }
            for (const key of Object.keys(headers)) {
                if (key.toLowerCase() === name) return headers[key];
            }
        } catch (err) { /* ignore */ }
        return null;
    }
    (function installAuthTokenWatcher() {
        if (!isTopFrame()) return;
        try {
            const originalFetch = window.fetch;
            if (typeof originalFetch === 'function') {
                window.fetch = function (input, init) {
                    try {
                        const value =
                            readHeaderCaseInsensitive(init && init.headers, 'authorization') ||
                            (input && typeof input === 'object' ? readHeaderCaseInsensitive(input.headers, 'authorization') : null);
                        if (value) rememberAuthToken(value);
                    } catch (err) { /* never break the page's own request */ }
                    return originalFetch.apply(this, arguments);
                };
            }
            const originalSetRequestHeader = XMLHttpRequest.prototype.setRequestHeader;
            XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
                try {
                    if (String(name).toLowerCase() === 'authorization') rememberAuthToken(value);
                } catch (err) { /* never break the page's own request */ }
                return originalSetRequestHeader.apply(this, arguments);
            };
        } catch (err) {
            console.warn('SDx QoL: could not install auth token watcher', err);
        }
    })();
    //////////////////////////////////////////////////////////////////////
    // SHARED HELPERS
    //////////////////////////////////////////////////////////////////////
    function normalizeText(text) {
        return String(text || '')
            .replace(/\s+/g, ' ')
            .trim();
    }
    function isVisible(el) {
        if (!el) return false;
        const style = getComputedStyle(el);
        return (
            el.offsetParent !== null &&
            style.display !== 'none' &&
            style.visibility !== 'hidden'
        );
    }
    // FIX: the old selector was `closest('input, textarea, select, ...')`, which
    // matches ANY <input>, including checkboxes/radios. That meant that right
    // after clicking a row checkbox (which keeps focus on that checkbox), every
    // keyboard shortcut below was silently blocked - this is why Esc "select all"
    // appeared broken. Only genuine text-entry inputs should suppress shortcuts.
    function isTypingTarget(el) {
        if (!el || !el.closest) return false;
        if (el.closest('textarea, select, [contenteditable="true"], .monaco-editor')) {
            return true;
        }
        const input = el.closest('input');
        if (!input) return false;
        const nonTypingTypes = ['checkbox', 'radio', 'button', 'submit', 'reset', 'range', 'color', 'file', 'image'];
        const type = String(input.type || 'text').toLowerCase();
        return !nonTypingTypes.includes(type);
    }
    function fireInputEvents(el) {
        if (!el) return;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
    }
    function debounce(fn, waitMs) {
        let timer = null;
        return function (...args) {
            clearTimeout(timer);
            timer = setTimeout(() => fn.apply(this, args), waitMs);
        };
    }
    // Tampermonkey's @match runs this script in every frame on the page,
    // including small embedded frames like the View and Markup annotation
    // editor - those have their own little toolbars, which is why the
    // Columns/Rows button was showing up in places it shouldn't. It should
    // only ever appear in the main top-level SDx app frame.
    function isTopFrame() {
        try {
            return window.self === window.top;
        } catch (err) {
            // Cross-origin frame access throws - treat as "not top" to be safe.
            return false;
        }
    }
    function getPageType() {
        const href = location.href.toLowerCase();
        const hash = location.hash.toLowerCase();
        const title = document.title.toLowerCase();
        if (href.includes('todo-list') || hash.includes('todo-list')) return 'todo-list';
        if (href.includes('viewandmarkup') || hash.includes('viewandmarkup')) return 'markup-view';
        if (href.includes('results') || hash.includes('results')) return 'results-list';
        if (href.includes('dashboards') || hash.includes('dashboards')) return 'dashboards';
        if (href.includes('documents') || title.includes('documents')) return 'documents';
        return 'generic';
    }
    function getPageKey() {
        return `${STORAGE_PREFIX}:${getPageType()}:${normalizeText(document.title || 'SDx')}`;
    }
    function getDefaultSettings() {
        return {
            hiddenColumns: [],
            hideOrphanCells: false,
            pageSize: 100,
            // Row highlighting only ever applies on the To Do List page (see
            // getPageType()/applyRowHighlighting), but the schema lives here
            // alongside the other per-page settings for consistency.
            rowHighlighting: {
                overdueEnabled: true,
                lowCompletionEnabled: false,
                lowCompletionThreshold: 25,
                highCompletionEnabled: true,
                highCompletionThreshold: 49
            },
            // Also only ever applies on the To Do List page - see
            // maybeSuppressStepDetailsPanel().
            suppressStepDetailsPanel: false
        };
    }
    function cleanRowHighlighting(raw) {
        const defaults = getDefaultSettings().rowHighlighting;
        const src = raw && typeof raw === 'object' ? raw : {};
        function cleanThreshold(value, fallback) {
            const num = Number(value);
            return Number.isFinite(num) ? Math.min(100, Math.max(0, num)) : fallback;
        }
        return {
            overdueEnabled: typeof src.overdueEnabled === 'boolean' ? src.overdueEnabled : defaults.overdueEnabled,
            lowCompletionEnabled: typeof src.lowCompletionEnabled === 'boolean' ? src.lowCompletionEnabled : defaults.lowCompletionEnabled,
            lowCompletionThreshold: cleanThreshold(src.lowCompletionThreshold, defaults.lowCompletionThreshold),
            highCompletionEnabled: typeof src.highCompletionEnabled === 'boolean' ? src.highCompletionEnabled : defaults.highCompletionEnabled,
            highCompletionThreshold: cleanThreshold(src.highCompletionThreshold, defaults.highCompletionThreshold)
        };
    }
    function loadSettings() {
        try {
            const raw = localStorage.getItem(getPageKey());
            if (!raw) return getDefaultSettings();
            const parsed = JSON.parse(raw);
            // Compatibility with older version that stored only hiddenColumns array.
            if (Array.isArray(parsed)) {
                return {
                    hiddenColumns: parsed,
                    hideOrphanCells: false,
                    pageSize: 100,
                    rowHighlighting: cleanRowHighlighting(null),
                    suppressStepDetailsPanel: false
                };
            }
            return {
                hiddenColumns: Array.isArray(parsed.hiddenColumns) ? parsed.hiddenColumns : [],
                hideOrphanCells: Boolean(parsed.hideOrphanCells),
                pageSize: Number.isFinite(Number(parsed.pageSize ?? parsed.maxVisibleRows))
                    ? Math.max(1, Number(parsed.pageSize ?? parsed.maxVisibleRows))
                    : 100,
                rowHighlighting: cleanRowHighlighting(parsed.rowHighlighting),
                suppressStepDetailsPanel: Boolean(parsed.suppressStepDetailsPanel)
            };
        } catch (err) {
            console.warn('SDx QoL: loadSettings failed', err);
            return getDefaultSettings();
        }
    }
    function saveSettings(settings) {
        try {
            const clean = {
                hiddenColumns: [
                    ...new Set(
                        (settings.hiddenColumns || [])
                            .map(normalizeText)
                            .filter(Boolean)
                    )
                ],
                hideOrphanCells: Boolean(settings.hideOrphanCells),
                pageSize: Number.isFinite(Number(settings.pageSize ?? settings.maxVisibleRows))
                    ? Math.max(1, Number(settings.pageSize ?? settings.maxVisibleRows))
                    : 100,
                rowHighlighting: cleanRowHighlighting(settings.rowHighlighting),
                suppressStepDetailsPanel: Boolean(settings.suppressStepDetailsPanel)
            };
            localStorage.setItem(getPageKey(), JSON.stringify(clean));
        } catch (err) {
            console.warn('SDx QoL: saveSettings failed', err);
        }
    }
    function setNativeValue(el, value) {
        if (!el) return;
        const valueSetter = Object.getOwnPropertyDescriptor(el, 'value')?.set;
        const prototype = Object.getPrototypeOf(el);
        const prototypeValueSetter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
        if (prototypeValueSetter && valueSetter !== prototypeValueSetter) {
            prototypeValueSetter.call(el, value);
        } else if (valueSetter) {
            valueSetter.call(el, value);
        } else {
            el.value = value;
        }
        fireInputEvents(el);
    }
    function getVisibleText(el) {
        return normalizeText(el ? el.innerText || el.textContent || '' : '');
    }
    function clickElement(el) {
        if (!el) return;
        el.dispatchEvent(new MouseEvent('mousedown', {
            bubbles: true,
            cancelable: true,
            view: window
        }));
        el.dispatchEvent(new MouseEvent('mouseup', {
            bubbles: true,
            cancelable: true,
            view: window
        }));
        el.click();
    }
    //////////////////////////////////////////////////////////////////////
    // MODULE 1
    // SHIFT + CLICK MULTI-SELECTION
    //////////////////////////////////////////////////////////////////////
    function getVisibleCheckboxes() {
        return [...document.querySelectorAll(CHECKBOX_SELECTOR)]
            .filter(cb => isVisible(cb))
            .filter(cb => !cb.disabled);
    }
    function setCheckboxState(cb, desiredState) {
        if (!cb) return;
        if (cb.checked !== desiredState) {
            cb.click();
            fireInputEvents(cb);
        }
    }
    // Large shift+click ranges (a few hundred rows) were locking up the tab
    // long enough to trigger the browser's own "page unresponsive" warning,
    // since each cb.click() synchronously runs Angular/Kendo's own change
    // detection - and if a user closes/reloads the tab during that freeze
    // instead of waiting it out, the selection is left silently incomplete.
    // Processing the same range in small chunks spread across animation
    // frames keeps the browser responsive regardless of range size, with no
    // change to which boxes end up checked or their order.
    function selectCheckboxRange(startCb, endCb, desiredState) {
        const boxes = getVisibleCheckboxes();
        const startIndex = boxes.indexOf(startCb);
        const endIndex = boxes.indexOf(endCb);
        if (startIndex < 0 || endIndex < 0) return;
        const minIndex = Math.min(startIndex, endIndex);
        const maxIndex = Math.max(startIndex, endIndex);
        const range = boxes.slice(minIndex, maxIndex + 1);
        const CHUNK_SIZE = 40;
        let index = 0;
        function processChunk() {
            const end = Math.min(index + CHUNK_SIZE, range.length);
            for (; index < end; index++) {
                setCheckboxState(range[index], desiredState);
            }
            if (index < range.length) {
                requestAnimationFrame(processChunk);
            }
        }
        processChunk();
    }
    document.addEventListener('click', function (e) {
        const checkbox = e.target.closest ? e.target.closest(CHECKBOX_SELECTOR) : null;
        if (!checkbox) return;
        if (e.shiftKey && lastCheckbox) {
            selectCheckboxRange(lastCheckbox, checkbox, checkbox.checked);
        }
        lastCheckbox = checkbox;
    }, true);
    //////////////////////////////////////////////////////////////////////
    // MODULE 2
    // KEYBOARD SHORTCUTS
    //////////////////////////////////////////////////////////////////////
    function selectAllVisibleCheckboxes() {
        getVisibleCheckboxes().forEach(cb => {
            if (!cb.checked) {
                cb.click();
                fireInputEvents(cb);
            }
        });
    }
    // Defense-in-depth: some SDx list views select rows via Kendo's own
    // row-selection (k-selected / aria-selected) in addition to, or instead of,
    // a checkbox. Escape should clear that too.
    function clearKendoGridSelection() {
        document.querySelectorAll('.k-grid, .k-treelist, .k-listview').forEach(gridEl => {
            const widget = getKendoWidgetFromElement(gridEl, ['kendoGrid', 'kendoTreeList', 'kendoListView']);
            if (widget && typeof widget.clearSelection === 'function') {
                try {
                    widget.clearSelection();
                } catch (err) {
                    console.warn('SDx QoL: clearSelection failed', err);
                }
            }
        });
        document.querySelectorAll('.k-selected, [aria-selected="true"]').forEach(el => {
            el.classList.remove('k-selected');
            if (el.getAttribute('aria-selected') === 'true') {
                el.setAttribute('aria-selected', 'false');
            }
        });
    }
    function clearAllVisibleCheckboxes() {
        getVisibleCheckboxes().forEach(cb => {
            if (cb.checked) {
                cb.click();
                fireInputEvents(cb);
            }
        });
        clearKendoGridSelection();
        // Backup pass for stubborn Angular / Material checkbox state.
        setTimeout(function () {
            getVisibleCheckboxes().forEach(cb => {
                if (cb.checked) {
                    cb.checked = false;
                    fireInputEvents(cb);
                }
            });
        }, 75);
        lastCheckbox = null;
    }
    function handleGlobalKeydown(e) {
        if (isTypingTarget(e.target)) return;
        const key = String(e.key || '').toLowerCase();
        if (key === 'escape' || key === 'esc') {
            // If our own manager menu is open, Escape closes it first.
            const menu = document.getElementById(MANAGER.menuId);
            if (menu) {
                e.preventDefault();
                e.stopPropagation();
                e.stopImmediatePropagation();
                closeManagerMenu();
                return;
            }
        }
        if (e.altKey && e.shiftKey && key === 'a') {
            const boxes = getVisibleCheckboxes();
            if (boxes.length > 0) {
                e.preventDefault();
                e.stopPropagation();
                e.stopImmediatePropagation();
                selectAllVisibleCheckboxes();
            }
            return;
        }
        if (key === 'escape' || key === 'esc') {
            const boxes = getVisibleCheckboxes();
            if (boxes.some(cb => cb.checked)) {
                e.preventDefault();
                e.stopPropagation();
                e.stopImmediatePropagation();
                clearAllVisibleCheckboxes();
            }
        }
    }
    // Registered on both window and document, in capture phase, and the script
    // runs at document-start so this attaches before SDx's own app scripts do.
    // Capture on `window` fires before capture on `document`, which fires before
    // anything else on the page - this gives our shortcuts first crack at the
    // event so SDx's own handlers can't swallow it first.
    window.addEventListener('keydown', handleGlobalKeydown, true);
    document.addEventListener('keydown', handleGlobalKeydown, true);
    //////////////////////////////////////////////////////////////////////
    // MODULE 3
    // COLUMN & ROW MANAGER
    //////////////////////////////////////////////////////////////////////
    function getHeaderName(headerEl) {
        if (!headerEl) return '';
        const clone = headerEl.cloneNode(true);
        clone.querySelectorAll(
            'button, svg, mat-icon, .mat-sort-header-arrow, .k-icon'
        ).forEach(el => el.remove());
        return normalizeText(clone.innerText || clone.textContent || '');
    }
    function getHeaderRow() {
        const selectors = [
            '[role="row"] [role="columnheader"]',
            'tr th',
            '.mat-mdc-header-row .mat-mdc-header-cell',
            '.mat-header-row .mat-header-cell',
            '.ag-header-row .ag-header-cell',
            '.k-grid-header tr th'
        ];
        for (const selector of selectors) {
            const header = document.querySelector(selector);
            if (header && header.parentElement) return header.parentElement;
        }
        return null;
    }
    function isProtectedColumn(index, name, rawName) {
        const cleanName = normalizeText(name).toLowerCase();
        const cleanRaw = normalizeText(rawName).toLowerCase();
        // Protect first unlabeled checkbox column.
        if (index === 0 && !cleanRaw) return true;
        // Protect common key columns.
        if (cleanName === 'name') return true;
        if (cleanName === '[unlabeled column 1]') return true;
        return false;
    }
    function getHeaderCells() {
        const headerRow = getHeaderRow();
        if (!headerRow) return [];
        const headers = [...headerRow.children].filter(el => {
            return (
                el.matches('[role="columnheader"], th, .mat-mdc-header-cell, .mat-header-cell, .ag-header-cell, .k-header, .k-table-th') ||
                el.getAttribute('role') === 'columnheader'
            );
        });
        return headers.map((el, index) => {
            const rawName = getHeaderName(el);
            const name = rawName || `[Unlabeled Column ${index + 1}]`;
            return {
                el,
                index,
                rawName,
                name,
                isProtected: isProtectedColumn(index, name, rawName)
            };
        });
    }
    function getGridRows() {
        const selectors = [
            'tr',
            '[role="row"]',
            '.mat-mdc-row',
            '.mat-row',
            '.ag-row',
            '.k-table-row',
            '.k-master-row'
        ];
        // Use a Set instead of Array#includes to keep this O(n) instead of O(n^2)
        // on large grids (SDx document lists can run into the hundreds of rows).
        const seen = new Set();
        selectors.forEach(selector => {
            document.querySelectorAll(selector).forEach(row => seen.add(row));
        });
        return [...seen];
    }
    function isHeaderRow(row) {
        if (!row) return false;
        return !!row.querySelector(
            '[role="columnheader"], th, .mat-mdc-header-cell, .mat-header-cell, .ag-header-cell, .k-header, .k-table-th'
        );
    }
    function getDirectCellsForRow(row) {
        if (!row) return [];
        return [...row.children].filter(el => {
            return (
                el.matches('[role="gridcell"], [role="cell"], td, th, .mat-mdc-cell, .mat-cell, .ag-cell, .k-table-td') ||
                el.getAttribute('role') === 'gridcell' ||
                el.getAttribute('role') === 'cell'
            );
        });
    }
    function getDataRows() {
        return getGridRows()
            .filter(row => !isHeaderRow(row))
            .filter(row => {
                const cells = getDirectCellsForRow(row);
                const text = normalizeText(row.innerText || row.textContent || '');
                return cells.length > 0 && text.length > 0;
            });
    }
    // Given a header cell, returns the data <table> that sits under the SAME
    // header table (header tables and content tables appear in matching DOM
    // order inside a .k-grid: [locked header, main header] / [locked body,
    // main body]). Returns null when the structure isn't a recognizable
    // Kendo grid, in which case callers keep their old, unscoped behavior.
    function getPairedContentTable(headerCellEl) {
        try {
            const headerTable = headerCellEl && headerCellEl.closest ? headerCellEl.closest('table') : null;
            const grid = headerTable ? headerTable.closest('.k-grid') : null;
            if (!headerTable || !grid) return null;
            const tables = [...grid.querySelectorAll('table')];
            const headerTables = tables.filter(t => t.querySelector('thead th, thead td'));
            const contentTables = tables.filter(t => !t.querySelector('thead') && t.querySelector('tbody tr'));
            if (headerTables.length === 0 || headerTables.length !== contentTables.length) return null;
            const idx = headerTables.indexOf(headerTable);
            return idx >= 0 ? contentTables[idx] : null;
        } catch (err) {
            return null;
        }
    }
    function clearHiddenColumns() {
        document
            .querySelectorAll('.sdx-qol-hidden-column, .sdx-qol-hidden-orphan-cell')
            .forEach(el => {
                el.classList.remove('sdx-qol-hidden-column');
                el.classList.remove('sdx-qol-hidden-orphan-cell');
            });
    }
    function applyHiddenColumns() {
        const settings = loadSettings();
        const hiddenColumns = settings.hiddenColumns || [];
        const hideOrphanCells = Boolean(settings.hideOrphanCells);
        // Nothing configured: just make sure no stale classes linger.
        if (hiddenColumns.length === 0 && !hideOrphanCells) {
            clearHiddenColumns();
            return;
        }
        const headers = getHeaderCells();
        if (headers.length === 0) return;
        const indexesToHide = new Set();
        headers.forEach(header => {
            if (header.isProtected) return;
            const name = normalizeText(header.name);
            if (hiddenColumns.includes(name)) {
                indexesToHide.add(header.index);
            }
        });
        const headerCount = headers.length;
        // Diff-based: only touch classes that actually need to change, instead
        // of clearing everything and re-adding (which caused needless style
        // recalculation and visible flicker on large grids).
        const setClass = (el, cls, on) => {
            if (el.classList.contains(cls) !== on) el.classList.toggle(cls, on);
        };
        headers.forEach(header => {
            setClass(header.el, 'sdx-qol-hidden-column', indexesToHide.has(header.index));
        });
        // Kendo grids with locked (frozen) columns - like SDx's lists, where
        // Name/checkbox/actions are frozen - are really TWO separate tables
        // side by side. Header indexes come from just ONE of them (the
        // scrolling side), so applying them to rows of the other (locked)
        // table hid the wrong cells (e.g. the checkbox/actions/name cells
        // when "Alt Doc Name" or "Title" was hidden). Only touch rows that
        // belong to the same table pair as the header row we measured.
        const scopeTable = getPairedContentTable(headers[0].el);
        getGridRows().forEach(row => {
            if (isHeaderRow(row)) return;
            if (scopeTable && row.closest('table') !== scopeTable) return;
            const cells = getDirectCellsForRow(row);
            // Fallback when the table pairing couldn't be determined: a row
            // with fewer cells than the header row can't be the same table
            // (e.g. the narrower locked side), so don't index into it.
            if (!scopeTable && cells.length > 0 && cells.length < headerCount) return;
            cells.forEach((cell, index) => {
                const header = headers[index];
                if (header && header.isProtected) {
                    setClass(cell, 'sdx-qol-hidden-column', false);
                    setClass(cell, 'sdx-qol-hidden-orphan-cell', false);
                    return;
                }
                setClass(cell, 'sdx-qol-hidden-column', indexesToHide.has(index));
                setClass(cell, 'sdx-qol-hidden-orphan-cell', hideOrphanCells && index >= headerCount);
            });
        });
    }
    //////////////////////////////////////////////////////////////////////
    // MODULE 3A
    // TO DO LIST ROW HIGHLIGHTING
    //////////////////////////////////////////////////////////////////////
    // Only ever active on the To Do List page (getPageType() === 'todo-list').
    // Reuses the same header/row index-matching that applyHiddenColumns()
    // already relies on elsewhere in this file.
    const ROW_HIGHLIGHT_CLASSES = [
        'sdx-qol-row-overdue',
        'sdx-qol-row-low-completion',
        'sdx-qol-row-high-completion'
    ];
    function findColumnIndexByName(headers, matchers) {
        const found = headers.find(header => {
            const name = header.name.toLowerCase();
            return matchers.some(matcher => name.includes(matcher));
        });
        return found ? found.index : -1;
    }
    function isTargetDateOverdue(text) {
        const trimmed = normalizeText(text);
        if (!trimmed) return false;
        const parsed = new Date(trimmed);
        if (Number.isNaN(parsed.getTime())) return false;
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        parsed.setHours(0, 0, 0, 0);
        return parsed.getTime() < today.getTime();
    }
    function parseCompletionPercent(text) {
        const trimmed = normalizeText(text).replace('%', '');
        if (!trimmed) return null;
        const num = Number(trimmed);
        return Number.isFinite(num) ? num : null;
    }
    function isConsolidationRfr(text) {
        return normalizeText(text).toLowerCase().includes('consolidation');
    }
    function clearRowHighlighting() {
        document.querySelectorAll(ROW_HIGHLIGHT_CLASSES.map(c => `.${c}`).join(', '))
            .forEach(row => row.classList.remove(...ROW_HIGHLIGHT_CLASSES));
    }
    function applyRowHighlighting() {
        clearRowHighlighting();
        if (getPageType() !== 'todo-list') return;
        const settings = loadSettings();
        const hl = settings.rowHighlighting;
        if (!hl.overdueEnabled && !hl.lowCompletionEnabled && !hl.highCompletionEnabled) return;
        const headers = getHeaderCells();
        if (headers.length === 0) return;
        const targetDateIdx = findColumnIndexByName(headers, ['target date']);
        const completionIdx = findColumnIndexByName(headers, ['completion']);
        const rfrIdx = findColumnIndexByName(headers, ['rfr']);
        getGridRows().forEach(row => {
            if (isHeaderRow(row)) return;
            const cells = getDirectCellsForRow(row);
            if (cells.length === 0) return;
            if (hl.overdueEnabled && targetDateIdx >= 0 && cells[targetDateIdx]) {
                const cell = cells[targetDateIdx];
                const text = normalizeText(cell.innerText || cell.textContent || '');
                if (isTargetDateOverdue(text)) {
                    row.classList.add('sdx-qol-row-overdue');
                    return; // Overdue always wins over completion-based coloring.
                }
            }
            if ((hl.lowCompletionEnabled || hl.highCompletionEnabled) && rfrIdx >= 0 && completionIdx >= 0 && cells[rfrIdx] && cells[completionIdx]) {
                const rfrText = normalizeText(cells[rfrIdx].innerText || cells[rfrIdx].textContent || '');
                if (!isConsolidationRfr(rfrText)) return;
                const value = parseCompletionPercent(cells[completionIdx].innerText || cells[completionIdx].textContent || '');
                if (value === null) return;
                if (hl.lowCompletionEnabled && value < hl.lowCompletionThreshold) {
                    row.classList.add('sdx-qol-row-low-completion');
                } else if (hl.highCompletionEnabled && value > hl.highCompletionThreshold) {
                    row.classList.add('sdx-qol-row-high-completion');
                }
            }
        });
    }
    //////////////////////////////////////////////////////////////////////
    // MODULE 3B
    // TO DO LIST - AUTO-CLOSE STEP DETAILS PANEL
    //////////////////////////////////////////////////////////////////////
    // Clicking the row action icon on the To Do List opens two things at
    // once: the useful left-hand Actions flyout (Add Reviewer, Consolidate
    // QA Reviews, Reassign, ...) and a large, mostly-unused <sda-resize-panel>
    // docked at the bottom of the screen (Task / Document revision / Workflow
    // tabs). There's no separate handle to stop just the bottom panel from
    // opening, so instead: let SDx open it as normal, then immediately click
    // its own built-in close ("X") button - the same thing a user would do by
    // hand, so it uses SDx's own close logic rather than us fighting the
    // Angular layout with CSS.
    function isStepDetailsPanelOpen() {
        const contentEl = document.querySelector('sda-resize-panel .resize-panel-content');
        return !!contentEl && contentEl.offsetHeight > 20;
    }
    function maybeSuppressStepDetailsPanel() {
        if (getPageType() !== 'todo-list') return;
        const settings = loadSettings();
        if (!settings.suppressStepDetailsPanel) return;
        if (!isStepDetailsPanelOpen()) return;
        const closeBtn = document.querySelector('sda-resize-panel .close-details button');
        if (closeBtn) {
            clickElement(closeBtn);
        }
    }
    //////////////////////////////////////////////////////////////////////
    // MODULE 3C
    // SDx KENDO PAGE-SIZE HELPERS
    //////////////////////////////////////////////////////////////////////
    function getKendoPagerElements() {
        return [...document.querySelectorAll('.k-pager, .k-grid-pager, [data-role="pager"]')]
            .filter(isVisible);
    }
    function getLikelyMainPager() {
        const pagers = getKendoPagerElements();
        if (!pagers.length) return null;
        const pagersWithInfo = pagers.filter(pager => {
            const text = getVisibleText(pager).toLowerCase();
            return text.includes(' of ') && text.includes('items');
        });
        return pagersWithInfo[0] || pagers[0];
    }
    function parsePagerInfo(pager) {
        const info = pager ? pager.querySelector('.k-pager-info') : null;
        const text = getVisibleText(info || pager);
        const match = text.match(/(\d+)\s*-\s*(\d+)\s*of\s*(\d+)/i);
        if (!match) {
            return {
                first: null,
                last: null,
                total: null,
                currentPageSize: null,
                text
            };
        }
        const first = Number(match[1]);
        const last = Number(match[2]);
        const total = Number(match[3]);
        return {
            first,
            last,
            total,
            currentPageSize: Math.max(1, last - first + 1),
            text
        };
    }
    function getJQueryObject(el) {
        try {
            if (window.jQuery) return window.jQuery(el);
            if (window.$) return window.$(el);
        } catch (err) {
            console.warn('SDx QoL: jQuery lookup failed', err);
        }
        return null;
    }
    function getKendoWidgetFromElement(el, names) {
        if (!el) return null;
        const jq = getJQueryObject(el);
        if (jq && typeof jq.data === 'function') {
            for (const name of names) {
                const widget = jq.data(name);
                if (widget) return widget;
            }
        }
        return null;
    }
    function findKendoGridFromPager(pager) {
        if (!pager) return null;
        const controlledId = pager.getAttribute('aria-controls');
        if (controlledId) {
            const controlled = document.getElementById(controlledId);
            if (controlled) {
                const directGrid = getKendoWidgetFromElement(controlled, [
                    'kendoGrid',
                    'kendoTreeList',
                    'kendoListView'
                ]);
                if (directGrid) return directGrid;
                const parentGridEl = controlled.closest('.k-grid, .k-treelist, .k-listview');
                if (parentGridEl) {
                    const parentGrid = getKendoWidgetFromElement(parentGridEl, [
                        'kendoGrid',
                        'kendoTreeList',
                        'kendoListView'
                    ]);
                    if (parentGrid) return parentGrid;
                }
            }
        }
        const nearbyGridEl =
            pager.closest('.k-grid, .k-treelist, .k-listview') ||
            document.querySelector('.k-grid, .k-treelist, .k-listview');
        if (nearbyGridEl) {
            const grid = getKendoWidgetFromElement(nearbyGridEl, [
                'kendoGrid',
                'kendoTreeList',
                'kendoListView'
            ]);
            if (grid) return grid;
        }
        return null;
    }
    function findKendoPagerWidget(pager) {
        if (!pager) return null;
        return getKendoWidgetFromElement(pager, [
            'kendoPager'
        ]);
    }
    function applyPageSizeViaKendoDataSource(pageSize, statusEl) {
        const pagerEl = getLikelyMainPager();
        if (!pagerEl) {
            return {
                success: false,
                message: 'Could not find a Kendo pager on this page.'
            };
        }
        const gridWidget = findKendoGridFromPager(pagerEl);
        if (gridWidget && gridWidget.dataSource && typeof gridWidget.dataSource.pageSize === 'function') {
            try {
                gridWidget.dataSource.pageSize(pageSize);
                if (typeof gridWidget.dataSource.page === 'function') {
                    gridWidget.dataSource.page(1);
                }
                // No manual gridWidget.refresh() here: changing the data
                // source's page size already triggers a read and the grid
                // refreshes itself when the data arrives. Forcing a refresh
                // before that data exists made SDx's own dataBinding handler
                // throw "Cannot read properties of undefined (reading 'length')".
                return {
                    success: true,
                    message: `Applied page size through Kendo grid data source: ${pageSize}`
                };
            } catch (err) {
                console.warn('SDx QoL: grid dataSource pageSize failed', err);
            }
        }
        const pagerWidget = findKendoPagerWidget(pagerEl);
        if (pagerWidget && pagerWidget.dataSource && typeof pagerWidget.dataSource.pageSize === 'function') {
            try {
                pagerWidget.dataSource.pageSize(pageSize);
                if (typeof pagerWidget.dataSource.page === 'function') {
                    pagerWidget.dataSource.page(1);
                }
                // As above: the data source change refreshes the pager itself.
                return {
                    success: true,
                    message: `Applied page size through Kendo pager data source: ${pageSize}`
                };
            } catch (err) {
                console.warn('SDx QoL: pager dataSource pageSize failed', err);
            }
        }
        const info = parsePagerInfo(pagerEl);
        return {
            success: false,
            message: `Found Kendo pager, but no exposed Kendo dataSource API was available. Pager currently shows: ${info.text || 'unknown'}`
        };
    }
    function getPageSizeSearchRoots() {
        const candidates = [
            ...document.querySelectorAll(
                '[role="navigation"], .mat-mdc-paginator, .mat-paginator, .k-pager, .k-grid-pager, .pagination, footer, div, form'
            )
        ].filter(isVisible);
        const preferred = candidates.filter(el => {
            const text = getVisibleText(el).toLowerCase();
            return (
                text.includes('items per page') ||
                text.includes('rows per page') ||
                text.includes('per page') ||
                text.includes('page size') ||
                (text.includes('items') && text.includes('of')) ||
                (text.includes('page') && text.includes('of'))
            );
        });
        return preferred.length ? preferred : candidates;
    }
    function findNativePageSizeSelect(value) {
        const roots = getPageSizeSearchRoots();
        for (const root of roots) {
            const selects = [...root.querySelectorAll('select')].filter(isVisible);
            for (const select of selects) {
                const options = [...select.options || []];
                const hasValue = options.some(opt => {
                    const optionText = normalizeText(opt.textContent);
                    const optionValue = String(opt.value || '').trim();
                    return optionText === String(value) || optionValue === String(value);
                });
                if (hasValue) return select;
            }
        }
        return null;
    }
    function findNativePageSizeInput() {
        const roots = getPageSizeSearchRoots();
        for (const root of roots) {
            const inputs = [...root.querySelectorAll('input[type="number"], input[type="text"]')].filter(isVisible);
            for (const input of inputs) {
                const aria = normalizeText(input.getAttribute('aria-label')).toLowerCase();
                const placeholder = normalizeText(input.getAttribute('placeholder')).toLowerCase();
                const nearbyText = getVisibleText(input.closest('label, div, form') || input.parentElement).toLowerCase();
                if (
                    aria.includes('page size') ||
                    aria.includes('rows per page') ||
                    aria.includes('items per page') ||
                    placeholder.includes('page size') ||
                    placeholder.includes('rows per page') ||
                    placeholder.includes('items per page') ||
                    nearbyText.includes('per page') ||
                    nearbyText.includes('page size')
                ) {
                    return input;
                }
            }
        }
        return null;
    }
    function findComboPageSizeControl() {
        const roots = getPageSizeSearchRoots();
        for (const root of roots) {
            const combos = [
                ...root.querySelectorAll(
                    '[role="combobox"], .mat-mdc-select, .mat-select, .k-dropdownlist, .k-combobox, .k-picker'
                )
            ].filter(isVisible);
            if (combos.length) {
                return combos[combos.length - 1];
            }
        }
        return null;
    }
    function findOpenOverlayOption(value) {
        const desired = String(value);
        const options = [
            ...document.querySelectorAll(
                '[role="option"], mat-option, .mat-mdc-option, .mat-option, .k-list-item, .k-item, li'
            )
        ].filter(isVisible);
        return options.find(opt => {
            const text = normalizeText(opt.innerText || opt.textContent || '');
            return text === desired || text.startsWith(`${desired} `);
        });
    }
    function applySdxPageSize(value, statusEl) {
        const pageSize = Math.max(1, Number(value || 100));
        function setStatus(message, isError) {
            if (!statusEl) return;
            statusEl.textContent = message;
            statusEl.style.color = isError ? '#b00020' : '#107c10';
        }
        // 1. Best method for your SDx page: Kendo Grid/Pager dataSource.
        const kendoResult = applyPageSizeViaKendoDataSource(pageSize, statusEl);
        if (kendoResult.success) {
            lastAppliedPageSize = pageSize;
            setStatus(kendoResult.message, false);
            return true;
        }
        console.warn('SDx QoL: Kendo dataSource method did not work:', kendoResult.message);
        // 2. Native select fallback.
        const select = findNativePageSizeSelect(pageSize);
        if (select) {
            setNativeValue(select, String(pageSize));
            select.dispatchEvent(new Event('change', { bubbles: true }));
            lastAppliedPageSize = pageSize;
            setStatus(`Applied page size through native select: ${pageSize}`, false);
            return true;
        }
        // 3. Native input fallback.
        const input = findNativePageSizeInput();
        if (input) {
            setNativeValue(input, String(pageSize));
            input.dispatchEvent(new KeyboardEvent('keydown', {
                key: 'Enter',
                code: 'Enter',
                bubbles: true,
                cancelable: true
            }));
            input.dispatchEvent(new KeyboardEvent('keyup', {
                key: 'Enter',
                code: 'Enter',
                bubbles: true,
                cancelable: true
            }));
            lastAppliedPageSize = pageSize;
            setStatus(`Applied page size through native input: ${pageSize}`, false);
            return true;
        }
        // 4. Dropdown fallback.
        const combo = findComboPageSizeControl();
        if (combo) {
            clickElement(combo);
            setTimeout(function () {
                const option = findOpenOverlayOption(pageSize);
                if (option) {
                    clickElement(option);
                    lastAppliedPageSize = pageSize;
                    setStatus(`Applied page size through dropdown option: ${pageSize}`, false);
                } else {
                    setStatus(`Found a dropdown, but could not find a ${pageSize} option.`, true);
                }
            }, 250);
            return true;
        }
        setStatus(kendoResult.message || 'Could not find an SDx page-size control or Kendo data source on this page.', true);
        return false;
    }
    //////////////////////////////////////////////////////////////////////
    // MODULE 3D
    // MANAGER STYLES
    //////////////////////////////////////////////////////////////////////
    function injectStyles() {
        if (document.getElementById(MANAGER.styleId)) return;
        const style = document.createElement('style');
        style.id = MANAGER.styleId;
        style.textContent = `
            #${MANAGER.buttonId} {
                margin-left: 8px !important;
                padding: 5px 12px !important;
                border: 1px solid #005a9e !important;
                border-radius: 4px !important;
                background: #0078d4 !important;
                color: #ffffff !important;
                font: 13px Arial, sans-serif !important;
                font-weight: 600 !important;
                cursor: pointer !important;
                height: 30px !important;
                line-height: 18px !important;
                display: inline-flex !important;
                align-items: center !important;
                gap: 5px !important;
                vertical-align: middle !important;
                box-shadow: 0 1px 3px rgba(0,0,0,0.25) !important;
            }
            #${MANAGER.buttonId}:hover {
                background: #106ebe !important;
                border-color: #004578 !important;
            }
            #${MANAGER.menuId} {
                position: absolute !important;
                z-index: 999999 !important;
                min-width: 340px !important;
                max-width: 480px !important;
                max-height: 540px !important;
                overflow: auto !important;
                padding: 10px !important;
                background: #ffffff !important;
                color: #222222 !important;
                border: 1px solid rgba(0,0,0,0.25) !important;
                border-radius: 6px !important;
                box-shadow: 0 6px 24px rgba(0,0,0,0.25) !important;
                font: 13px Arial, sans-serif !important;
            }
            #${MANAGER.menuId} .sdx-title {
                font-weight: 700 !important;
                margin-bottom: 8px !important;
                color: #111111 !important;
            }
            #${MANAGER.menuId} .sdx-subtitle {
                color: #666666 !important;
                font-size: 12px !important;
                margin-bottom: 8px !important;
            }
            #${MANAGER.menuId} .sdx-tabs {
                display: flex !important;
                gap: 6px !important;
                margin-bottom: 10px !important;
                border-bottom: 1px solid #dddddd !important;
                padding-bottom: 6px !important;
            }
            #${MANAGER.menuId} .sdx-tab {
                padding: 5px 10px !important;
                border: 1px solid #bbbbbb !important;
                border-radius: 4px !important;
                background: #ffffff !important;
                color: #222222 !important;
                cursor: pointer !important;
                font: 12px Arial, sans-serif !important;
            }
            #${MANAGER.menuId} .sdx-tab.active {
                background: #0078d4 !important;
                color: #ffffff !important;
                border-color: #005a9e !important;
                font-weight: 700 !important;
            }
            #${MANAGER.menuId} .sdx-item {
                display: flex !important;
                align-items: center !important;
                gap: 8px !important;
                padding: 4px 2px !important;
                cursor: pointer !important;
                border-radius: 4px !important;
            }
            #${MANAGER.menuId} .sdx-item:hover {
                background: #f4f4f4 !important;
            }
            #${MANAGER.menuId} .sdx-section {
                margin-top: 10px !important;
                padding-top: 10px !important;
                border-top: 1px solid #dddddd !important;
            }
            #${MANAGER.menuId} .sdx-note {
                color: #777777 !important;
                font-size: 11px !important;
                margin: 4px 0 8px 24px !important;
            }
            #${MANAGER.menuId} .sdx-protected {
                color: #777777 !important;
                font-size: 11px !important;
                margin-left: auto !important;
                font-style: italic !important;
            }
            #${MANAGER.menuId} .sdx-row-control {
                margin: 10px 0 !important;
            }
            #${MANAGER.menuId} .sdx-row-control label {
                display: block !important;
                font-weight: 700 !important;
                margin-bottom: 5px !important;
            }
            #${MANAGER.menuId} .sdx-row-control input {
                width: 130px !important;
                padding: 5px !important;
                border: 1px solid #aaaaaa !important;
                border-radius: 4px !important;
                font: 13px Arial, sans-serif !important;
            }
            #${MANAGER.menuId} .sdx-actions {
                display: flex !important;
                gap: 8px !important;
                margin-top: 10px !important;
                padding-top: 10px !important;
                border-top: 1px solid #dddddd !important;
            }
            #${MANAGER.menuId} button {
                padding: 4px 8px !important;
                border: 1px solid #aaaaaa !important;
                border-radius: 4px !important;
                background: #ffffff !important;
                color: #222222 !important;
                cursor: pointer !important;
                font: 12px Arial, sans-serif !important;
            }
            #${MANAGER.menuId} button:hover {
                background: #eeeeee !important;
            }
            #${MANAGER.menuId} .sdx-apply {
                margin-left: 8px !important;
                background: #0078d4 !important;
                border-color: #005a9e !important;
                color: #ffffff !important;
                font-weight: 700 !important;
            }
            #${MANAGER.menuId} .sdx-apply:hover {
                background: #106ebe !important;
            }
            .sdx-qol-hidden-column,
            .sdx-qol-hidden-orphan-cell {
                display: none !important;
                width: 0 !important;
                min-width: 0 !important;
                max-width: 0 !important;
                padding: 0 !important;
                margin: 0 !important;
                border: 0 !important;
                overflow: hidden !important;
            }
            .sdx-qol-row-overdue > td,
            .sdx-qol-row-overdue > [role="gridcell"],
            .sdx-qol-row-overdue > [role="cell"] {
                background-color: #fdecea !important;
            }
            .sdx-qol-row-low-completion > td,
            .sdx-qol-row-low-completion > [role="gridcell"],
            .sdx-qol-row-low-completion > [role="cell"] {
                background-color: #fff4e5 !important;
            }
            .sdx-qol-row-high-completion > td,
            .sdx-qol-row-high-completion > [role="gridcell"],
            .sdx-qol-row-high-completion > [role="cell"] {
                background-color: #e6f4ea !important;
            }
            #${SESSION_BUTTON_ID}.sdx-qol-session-expired svg {
                fill: #d13438 !important;
            }
            #${SESSION_BUTTON_ID}.sdx-qol-session-expired {
                position: relative !important;
            }
            #${SESSION_BUTTON_ID}.sdx-qol-session-expired::after {
                content: '' !important;
                position: absolute !important;
                top: 6px !important;
                right: 6px !important;
                width: 8px !important;
                height: 8px !important;
                border-radius: 50% !important;
                background: #d13438 !important;
                box-shadow: 0 0 0 2px #ffffff !important;
            }
            #${DL_BUTTON_ID} {
                margin-left: 8px !important;
                padding: 5px 12px !important;
                border: 1px solid #0e6b0e !important;
                border-radius: 4px !important;
                background: #107c10 !important;
                color: #ffffff !important;
                font: 13px Arial, sans-serif !important;
                font-weight: 600 !important;
                cursor: pointer !important;
                height: 30px !important;
                line-height: 18px !important;
                display: inline-flex !important;
                align-items: center !important;
                gap: 5px !important;
                vertical-align: middle !important;
                box-shadow: 0 1px 3px rgba(0,0,0,0.25) !important;
            }
            #${DL_BUTTON_ID}:hover {
                background: #0b5e0b !important;
                border-color: #094d09 !important;
            }
            .sdx-qol-dl-backdrop {
                position: fixed !important;
                inset: 0 !important;
                background: rgba(0,0,0,0.35) !important;
                z-index: 999996 !important;
            }
            .sdx-qol-dl-panel {
                position: fixed !important;
                top: 50% !important;
                left: 50% !important;
                transform: translate(-50%, -50%) !important;
                z-index: 999997 !important;
                width: 480px !important;
                max-width: 90vw !important;
                max-height: 80vh !important;
                display: flex !important;
                flex-direction: column !important;
                background: #ffffff !important;
                color: #222222 !important;
                border-radius: 6px !important;
                box-shadow: 0 6px 24px rgba(0,0,0,0.35) !important;
                padding: 14px !important;
                font: 13px Arial, sans-serif !important;
            }
            .sdx-qol-dl-list {
                overflow: auto !important;
                border: 1px solid #dddddd !important;
                border-radius: 4px !important;
                padding: 6px 8px !important;
                margin-bottom: 10px !important;
                max-height: 240px !important;
            }
            .sdx-qol-dl-list-item {
                padding: 2px 0 !important;
                border-bottom: 1px solid #f0f0f0 !important;
            }
            .sdx-qol-dl-list-item:last-child {
                border-bottom: none !important;
            }
            .sdx-qol-dl-options {
                display: flex !important;
                flex-direction: column !important;
                gap: 6px !important;
                margin-bottom: 6px !important;
            }
            .sdx-qol-dl-panel .sdx-actions {
                display: flex !important;
                flex-direction: row !important;
                gap: 8px !important;
            }
            .sdx-qol-dl-panel .sdx-actions button {
                flex: 0 0 auto !important;
            }
            .sdx-qol-pv-btn {
                display: inline-flex !important;
                align-items: center !important;
                justify-content: center !important;
                width: 18px !important;
                height: 18px !important;
                margin-left: 5px !important;
                vertical-align: middle !important;
                border-radius: 3px !important;
                cursor: pointer !important;
                color: #1a5fb4 !important;
                opacity: 0.75 !important;
            }
            .sdx-qol-pv-btn:hover {
                opacity: 1 !important;
                background: #dbe8fa !important;
            }
            .sdx-qol-pv-btn.sdx-qol-pv-active {
                background: #1a73e8 !important;
                color: #ffffff !important;
                opacity: 1 !important;
            }
            .sdx-qol-pv-btn svg {
                width: 14px !important;
                height: 14px !important;
                pointer-events: none !important;
            }
            .sdx-qol-pv-panel {
                position: fixed !important;
                top: 50% !important;
                left: 50% !important;
                transform: translate(-50%, -50%) !important;
                z-index: 999997 !important;
                width: 82vw !important;
                height: 90vh !important;
                display: flex !important;
                flex-direction: column !important;
                background: #ffffff !important;
                color: #222222 !important;
                border-radius: 6px !important;
                box-shadow: 0 6px 24px rgba(0,0,0,0.45) !important;
                font: 13px Arial, sans-serif !important;
                overflow: hidden !important;
            }
            .sdx-qol-pv-header {
                display: flex !important;
                align-items: center !important;
                gap: 8px !important;
                padding: 8px 12px !important;
                background: #f3f3f3 !important;
                border-bottom: 1px solid #d5d5d5 !important;
            }
            .sdx-qol-pv-title {
                flex: 1 1 auto !important;
                font-weight: bold !important;
                overflow: hidden !important;
                text-overflow: ellipsis !important;
                white-space: nowrap !important;
            }
            .sdx-qol-pv-header button {
                flex: 0 0 auto !important;
                padding: 4px 10px !important;
                border: 1px solid #aaaaaa !important;
                border-radius: 4px !important;
                background: #ffffff !important;
                cursor: pointer !important;
                font: 12px Arial, sans-serif !important;
            }
            .sdx-qol-pv-counter {
                flex: 0 0 auto !important;
                color: #666666 !important;
                font-size: 12px !important;
            }
            .sdx-qol-pv-nav {
                position: absolute !important;
                top: 50% !important;
                transform: translateY(-50%) !important;
                z-index: 3 !important;
                width: 38px !important;
                height: 64px !important;
                padding: 0 0 4px 0 !important;
                border: none !important;
                border-radius: 6px !important;
                background: rgba(30,30,30,0.55) !important;
                color: #ffffff !important;
                font: 34px/60px Arial, sans-serif !important;
                cursor: pointer !important;
            }
            .sdx-qol-pv-nav:hover:not(:disabled) {
                background: rgba(30,30,30,0.85) !important;
            }
            .sdx-qol-pv-nav:disabled {
                opacity: 0.2 !important;
                cursor: default !important;
            }
            .sdx-qol-pv-nav-prev { left: 10px !important; }
            .sdx-qol-pv-nav-next { right: 24px !important; }
            .sdx-qol-pv-scroll {
                position: absolute !important;
                inset: 0 !important;
                overflow: auto !important;
                padding: 12px 0 !important;
                box-sizing: border-box !important;
                background: #525659 !important;
            }
            .sdx-qol-pv-page {
                position: relative !important;
                margin: 0 auto 12px auto !important;
                background: #ffffff !important;
                box-shadow: 0 1px 6px rgba(0,0,0,0.5) !important;
            }
            .sdx-qol-pv-search {
                flex: 0 0 auto !important;
                display: flex;
                align-items: center !important;
                gap: 4px !important;
            }
            .sdx-qol-pv-search input {
                width: 150px !important;
                padding: 3px 6px !important;
                border: 1px solid #aaaaaa !important;
                border-radius: 4px !important;
                font: 12px Arial, sans-serif !important;
            }
            .sdx-qol-pv-text {
                position: absolute !important;
                inset: 0 !important;
                overflow: hidden !important;
                line-height: 1 !important;
                text-size-adjust: none !important;
                transform-origin: 0 0 !important;
            }
            .sdx-qol-pv-text span,
            .sdx-qol-pv-text br {
                color: transparent !important;
                position: absolute !important;
                white-space: pre !important;
                cursor: text !important;
                transform-origin: 0% 0% !important;
                margin: 0 !important;
                padding: 0 !important;
                border: 0 !important;
                letter-spacing: normal !important;
                word-spacing: normal !important;
                text-indent: 0 !important;
                text-transform: none !important;
            }
            /* PDF.js wraps text in "marked content" spans for tagged PDFs
               (common in CAD output). They must not offset their children. */
            .sdx-qol-pv-text .markedContent {
                top: 0 !important;
                height: 0 !important;
            }
            .sdx-qol-pv-text span[role="img"] {
                user-select: none !important;
                cursor: default !important;
            }
            .sdx-qol-pv-text ::selection {
                background: rgba(0, 100, 255, 0.35) !important;
            }
            .sdx-qol-pv-hl {
                position: absolute !important;
                inset: 0 !important;
                pointer-events: none !important;
                overflow: hidden !important;
            }
            .sdx-qol-pv-hl-box {
                position: absolute !important;
                background: rgba(255, 213, 0, 0.5) !important;
                mix-blend-mode: multiply !important;
                border-radius: 2px !important;
            }
            .sdx-qol-pv-hl-box.sdx-qol-pv-hl-current {
                background: rgba(255, 120, 0, 0.7) !important;
                outline: 1px solid rgba(200, 80, 0, 0.9) !important;
            }
            .sdx-qol-pv-header button.sdx-qol-pv-fit-active {
                background: #1a73e8 !important;
                border-color: #1a73e8 !important;
                color: #ffffff !important;
            }
            .sdx-qol-pv-body {
                position: relative !important;
                flex: 1 1 auto !important;
                min-height: 0 !important;
                background: #525659 !important;
            }
            .sdx-qol-pv-body iframe {
                width: 100% !important;
                height: 100% !important;
                border: 0 !important;
                background: #525659 !important;
            }
            .sdx-qol-pv-status {
                position: absolute !important;
                inset: 0 !important;
                display: flex !important;
                align-items: center !important;
                justify-content: center !important;
                text-align: center !important;
                padding: 20px !important;
                color: #ffffff !important;
                font: 14px Arial, sans-serif !important;
            }
            .sdx-qol-dl-name-input {
                width: 100% !important;
                margin-top: 4px !important;
                padding: 5px !important;
                border: 1px solid #aaaaaa !important;
                border-radius: 4px !important;
                font: 13px Arial, sans-serif !important;
                box-sizing: border-box !important;
            }
        `;
        document.head.appendChild(style);
    }
    //////////////////////////////////////////////////////////////////////
    // MODULE 3E
    // MANAGER BUTTON AND MENU
    //////////////////////////////////////////////////////////////////////
    function findActionBarAnchor() {
        const all = [...document.querySelectorAll('button, a, span, div')];
        const exportEl = all.find(el => {
            const text = normalizeText(el.innerText || el.textContent || '');
            return /^export all to excel$/i.test(text);
        });
        if (exportEl) {
            const buttonLike = exportEl.closest('button, a') || exportEl;
            const parent = buttonLike.parentElement;
            if (parent) {
                return {
                    parent,
                    after: buttonLike
                };
            }
        }
        const toolbar = document.querySelector(
            '[role="toolbar"], .toolbar, .command-bar, .mat-toolbar, .k-toolbar'
        );
        if (toolbar) {
            return {
                parent: toolbar,
                after: null
            };
        }
        return null;
    }
    function injectManagerButton() {
        if (!isTopFrame()) return;
        if (document.getElementById(MANAGER.buttonId)) return;
        const anchor = findActionBarAnchor();
        if (!anchor) return;
        const button = document.createElement('button');
        button.id = MANAGER.buttonId;
        button.type = 'button';
        button.textContent = '🧙 Columns / Rows ▾';
        button.title = 'Show or hide columns and control SDx rows per page for this list';
        button.addEventListener('click', function (e) {
            e.preventDefault();
            e.stopPropagation();
            toggleManagerMenu(button);
        }, true);
        if (anchor.after && anchor.after.parentElement === anchor.parent) {
            anchor.after.insertAdjacentElement('afterend', button);
        } else {
            anchor.parent.appendChild(button);
        }
    }
    function toggleManagerMenu(button) {
        const existing = document.getElementById(MANAGER.menuId);
        if (existing) {
            existing.remove();
            return;
        }
        showManagerMenu(button);
    }
    function closeManagerMenu() {
        const menu = document.getElementById(MANAGER.menuId);
        if (menu) menu.remove();
    }
    function showManagerMenu(button) {
        closeManagerMenu();
        const menu = document.createElement('div');
        menu.id = MANAGER.menuId;
        renderManagerMenu(menu, button);
        document.body.appendChild(menu);
        const rect = button.getBoundingClientRect();
        menu.style.top = `${window.scrollY + rect.bottom + 6}px`;
        menu.style.left = `${window.scrollX + rect.left}px`;
    }
    function renderManagerMenu(menu, button) {
        menu.innerHTML = '';
        const title = document.createElement('div');
        title.className = 'sdx-title';
        title.textContent = '🧙 Column & Row Manager';
        const subtitle = document.createElement('div');
        subtitle.className = 'sdx-subtitle';
        subtitle.textContent = 'Column settings are saved. Row/page-size changes only run when you click Apply.';
        menu.appendChild(title);
        menu.appendChild(subtitle);
        // The Highlights tab only ever applies to the To Do List, so it's
        // only shown there - on every other page this tab bar is unchanged.
        const isTodoList = getPageType() === 'todo-list';
        if (activeTab === 'highlights' && !isTodoList) {
            activeTab = 'columns';
        }
        const tabs = document.createElement('div');
        tabs.className = 'sdx-tabs';
        const columnsTab = document.createElement('button');
        columnsTab.type = 'button';
        columnsTab.className = `sdx-tab ${activeTab === 'columns' ? 'active' : ''}`;
        columnsTab.textContent = 'Columns';
        const rowsTab = document.createElement('button');
        rowsTab.type = 'button';
        rowsTab.className = `sdx-tab ${activeTab === 'rows' ? 'active' : ''}`;
        rowsTab.textContent = 'Rows';
        columnsTab.addEventListener('click', function () {
            activeTab = 'columns';
            renderManagerMenu(menu, button);
        });
        rowsTab.addEventListener('click', function () {
            activeTab = 'rows';
            renderManagerMenu(menu, button);
        });
        tabs.appendChild(columnsTab);
        tabs.appendChild(rowsTab);
        const viewerTab = document.createElement('button');
        viewerTab.type = 'button';
        viewerTab.className = `sdx-tab ${activeTab === 'viewer' ? 'active' : ''}`;
        viewerTab.textContent = 'PDF Viewer';
        viewerTab.addEventListener('click', function () {
            activeTab = 'viewer';
            renderManagerMenu(menu, button);
        });
        tabs.appendChild(viewerTab);
        if (isTodoList) {
            const highlightsTab = document.createElement('button');
            highlightsTab.type = 'button';
            highlightsTab.className = `sdx-tab ${activeTab === 'highlights' ? 'active' : ''}`;
            highlightsTab.textContent = 'To Do List';
            highlightsTab.addEventListener('click', function () {
                activeTab = 'highlights';
                renderManagerMenu(menu, button);
            });
            tabs.appendChild(highlightsTab);
        }
        menu.appendChild(tabs);
        if (activeTab === 'columns') {
            renderColumnsTab(menu);
        } else if (activeTab === 'rows') {
            renderRowsTab(menu);
        } else if (activeTab === 'viewer') {
            renderViewerTab(menu);
        } else {
            renderHighlightsTab(menu);
        }
        renderActions(menu, button);
    }
    function renderActions(menu, button) {
        const actions = document.createElement('div');
        actions.className = 'sdx-actions';
        const reset = document.createElement('button');
        reset.type = 'button';
        if (activeTab === 'columns') {
            reset.textContent = 'Reset Columns';
            reset.addEventListener('click', function () {
                const s = loadSettings();
                s.hiddenColumns = [];
                s.hideOrphanCells = false;
                saveSettings(s);
                applyHiddenColumns();
                renderManagerMenu(menu, button);
            });
        } else if (activeTab === 'rows') {
            reset.textContent = 'Reset Rows';
            reset.addEventListener('click', function () {
                const s = loadSettings();
                s.pageSize = 100;
                saveSettings(s);
                lastAppliedPageSize = null;
                const tempStatus = document.createElement('div');
                applySdxPageSize(100, tempStatus);
                renderManagerMenu(menu, button);
            });
        } else if (activeTab === 'viewer') {
            reset.textContent = 'Reset Viewer';
            reset.addEventListener('click', function () {
                saveViewerSettings(getDefaultViewerSettings());
                applyViewerEnabled(true);
                pvEnforceCacheLimit();
                renderManagerMenu(menu, button);
            });
        } else {
            reset.textContent = 'Reset To Do List Options';
            reset.addEventListener('click', function () {
                const s = loadSettings();
                s.rowHighlighting = getDefaultSettings().rowHighlighting;
                s.suppressStepDetailsPanel = false;
                saveSettings(s);
                applyRowHighlighting();
                renderManagerMenu(menu, button);
            });
        }
        const close = document.createElement('button');
        close.type = 'button';
        close.textContent = 'Close';
        close.addEventListener('click', closeManagerMenu);
        actions.appendChild(reset);
        actions.appendChild(close);
        menu.appendChild(actions);
    }
    function renderColumnsTab(menu) {
        const headers = getHeaderCells();
        const settings = loadSettings();
        const note = document.createElement('div');
        note.className = 'sdx-subtitle';
        note.textContent = 'Checked = visible. Unchecked = hidden.';
        menu.appendChild(note);
        if (headers.length === 0) {
            const empty = document.createElement('div');
            empty.textContent = 'No columns detected on this page.';
            menu.appendChild(empty);
        } else {
            headers.forEach(header => {
                const name = normalizeText(header.name);
                const isHidden = settings.hiddenColumns.includes(name);
                const label = document.createElement('label');
                label.className = 'sdx-item';
                const cb = document.createElement('input');
                cb.type = 'checkbox';
                cb.checked = header.isProtected ? true : !isHidden;
                cb.disabled = header.isProtected;
                const span = document.createElement('span');
                span.textContent = name;
                label.appendChild(cb);
                label.appendChild(span);
                if (header.isProtected) {
                    const protectedNote = document.createElement('span');
                    protectedNote.className = 'sdx-protected';
                    protectedNote.textContent = 'protected';
                    label.appendChild(protectedNote);
                }
                cb.addEventListener('change', function () {
                    if (header.isProtected) return;
                    const s = loadSettings();
                    if (cb.checked) {
                        s.hiddenColumns = s.hiddenColumns.filter(col => col !== name);
                    } else {
                        s.hiddenColumns.push(name);
                    }
                    saveSettings(s);
                    applyHiddenColumns();
                });
                menu.appendChild(label);
            });
        }
        const section = document.createElement('div');
        section.className = 'sdx-section';
        const orphanLabel = document.createElement('label');
        orphanLabel.className = 'sdx-item';
        const orphanCb = document.createElement('input');
        orphanCb.type = 'checkbox';
        orphanCb.checked = settings.hideOrphanCells;
        const orphanSpan = document.createElement('span');
        orphanSpan.textContent = 'Hide unlabeled/right-side extra cells';
        orphanCb.addEventListener('change', function () {
            const s = loadSettings();
            s.hideOrphanCells = orphanCb.checked;
            saveSettings(s);
            applyHiddenColumns();
        });
        orphanLabel.appendChild(orphanCb);
        orphanLabel.appendChild(orphanSpan);
        const orphanNote = document.createElement('div');
        orphanNote.className = 'sdx-note';
        orphanNote.textContent = 'Use only if SDx keeps showing stray cells after hiding columns.';
        section.appendChild(orphanLabel);
        section.appendChild(orphanNote);
        menu.appendChild(section);
    }
    function renderRowsTab(menu) {
        const settings = loadSettings();
        const pager = getLikelyMainPager();
        const info = parsePagerInfo(pager);
        const note = document.createElement('div');
        note.className = 'sdx-subtitle';
        note.textContent = 'Set SDx rows per page by targeting the Kendo grid data source. This does not hide rendered rows.';
        menu.appendChild(note);
        const control = document.createElement('div');
        control.className = 'sdx-row-control';
        const label = document.createElement('label');
        label.textContent = 'Rows per page';
        const input = document.createElement('input');
        input.type = 'number';
        input.min = '1';
        input.step = '1';
        input.value = String(settings.pageSize || info.currentPageSize || 100);
        const presetLine = document.createElement('div');
        presetLine.style.display = 'flex';
        presetLine.style.gap = '6px';
        presetLine.style.margin = '6px 0';
        [100, 250, 500, 1000].forEach(size => {
            const preset = document.createElement('button');
            preset.type = 'button';
            preset.textContent = String(size);
            preset.addEventListener('click', function () {
                input.value = String(size);
            });
            presetLine.appendChild(preset);
        });
        const apply = document.createElement('button');
        apply.type = 'button';
        apply.className = 'sdx-apply';
        apply.textContent = 'Apply';
        const status = document.createElement('div');
        status.className = 'sdx-note';
        status.textContent = lastAppliedPageSize
            ? `Last applied this session: ${lastAppliedPageSize}`
            : 'No page-size change applied this session.';
        apply.addEventListener('click', function () {
            const raw = Number(input.value || 100);
            const value = Math.max(1, Number.isFinite(raw) ? raw : 100);
            const s = loadSettings();
            s.pageSize = value;
            saveSettings(s);
            applySdxPageSize(value, status);
        });
        input.addEventListener('keydown', function (e) {
            if (e.key === 'Enter') {
                e.preventDefault();
                apply.click();
            }
        });
        const inputLine = document.createElement('div');
        inputLine.style.display = 'flex';
        inputLine.style.alignItems = 'center';
        inputLine.style.gap = '6px';
        inputLine.appendChild(input);
        inputLine.appendChild(apply);
        const detected = document.createElement('div');
        detected.className = 'sdx-note';
        detected.textContent = info.currentPageSize
            ? `Pager currently shows: ${info.currentPageSize} rows per page, ${info.total} total items.`
            : `Currently rendered rows detected: ${getDataRows().length}`;
        const caution = document.createElement('div');
        caution.className = 'sdx-note';
        caution.textContent = 'If SDx uses a locked Angular data source that is not exposed to the page, this may still be blocked by SDx.';
        control.appendChild(label);
        control.appendChild(presetLine);
        control.appendChild(inputLine);
        control.appendChild(detected);
        control.appendChild(status);
        control.appendChild(caution);
        menu.appendChild(control);
    }
    function formatBytes(bytes) {
        if (!bytes) return '0 MB';
        const mb = bytes / (1024 * 1024);
        return mb < 0.1 ? '<0.1 MB' : `${mb.toFixed(1)} MB`;
    }
    function renderViewerTab(menu) {
        const settings = loadViewerSettings();
        const note = document.createElement('div');
        note.className = 'sdx-subtitle';
        note.textContent = 'PDF preview (eye icon beside document names). Saves automatically.';
        menu.appendChild(note);
        // --- 1. On/off switch ---
        const enabledLabel = document.createElement('label');
        enabledLabel.className = 'sdx-item';
        const enabledCb = document.createElement('input');
        enabledCb.type = 'checkbox';
        enabledCb.checked = settings.enabled;
        const enabledSpan = document.createElement('span');
        enabledSpan.textContent = 'Enable PDF preview';
        enabledCb.addEventListener('change', function () {
            const s = loadViewerSettings();
            s.enabled = enabledCb.checked;
            saveViewerSettings(s);
            applyViewerEnabled(s.enabled);
            updateStats();
        });
        enabledLabel.appendChild(enabledCb);
        enabledLabel.appendChild(enabledSpan);
        menu.appendChild(enabledLabel);
        const enabledNote = document.createElement('div');
        enabledNote.className = 'sdx-note';
        enabledNote.textContent = 'Turn off to remove the eye icons and free any cached PDFs (e.g. if you run into a problem with the viewer).';
        menu.appendChild(enabledNote);
        // --- 2. Default page view ---
        const viewSection = document.createElement('div');
        viewSection.className = 'sdx-section';
        const viewLabel = document.createElement('label');
        viewLabel.textContent = 'Default page view ';
        const viewSelect = document.createElement('select');
        [['Fit', 'Fit to page'], ['FitH', 'Fit to width']].forEach(([value, text]) => {
            const opt = document.createElement('option');
            opt.value = value;
            opt.textContent = text;
            if (settings.view === value) opt.selected = true;
            viewSelect.appendChild(opt);
        });
        viewSelect.addEventListener('change', function () {
            const s = loadViewerSettings();
            s.view = viewSelect.value === 'FitH' ? 'FitH' : 'Fit';
            saveViewerSettings(s);
        });
        viewLabel.appendChild(viewSelect);
        const viewNote = document.createElement('div');
        viewNote.className = 'sdx-note';
        viewNote.textContent = 'Applies the next time a PDF opens in the viewer.';
        viewSection.appendChild(viewLabel);
        viewSection.appendChild(viewNote);
        menu.appendChild(viewSection);
        // --- Viewer engine ---
        const engineSection = document.createElement('div');
        engineSection.className = 'sdx-section';
        const engineLabel = document.createElement('label');
        engineLabel.textContent = 'Viewer ';
        const engineSelect = document.createElement('select');
        [['pdfjs', 'Enhanced (same in Chrome & Edge)'], ['native', 'Browser built-in']].forEach(([value, text]) => {
            const opt = document.createElement('option');
            opt.value = value;
            opt.textContent = text;
            if (settings.engine === value) opt.selected = true;
            engineSelect.appendChild(opt);
        });
        engineSelect.addEventListener('change', function () {
            const s = loadViewerSettings();
            s.engine = engineSelect.value === 'native' ? 'native' : 'pdfjs';
            saveViewerSettings(s);
        });
        engineLabel.appendChild(engineSelect);
        const engineNote = document.createElement('div');
        engineNote.className = 'sdx-note';
        engineNote.textContent = 'Enhanced always honors Fit page / Fit width and adds zoom controls. The browser built-in viewer has search, print and download but Edge ignores the fit setting. Applies to the next PDF opened.';
        engineSection.appendChild(engineLabel);
        engineSection.appendChild(engineNote);
        menu.appendChild(engineSection);
        // --- 3. Cache size + purge ---
        const cacheSection = document.createElement('div');
        cacheSection.className = 'sdx-section';
        const cacheLabel = document.createElement('div');
        cacheLabel.style.marginBottom = '4px';
        const slider = document.createElement('input');
        slider.type = 'range';
        slider.min = '0';
        slider.max = '100';
        slider.step = '1';
        slider.value = String(settings.cacheMax);
        slider.style.width = '100%';
        function updateCacheLabel() {
            cacheLabel.textContent = `PDFs kept in memory: ${slider.value}${slider.value === '0' ? ' (caching off)' : ''}`;
        }
        updateCacheLabel();
        const cacheNote = document.createElement('div');
        cacheNote.className = 'sdx-note';
        cacheNote.textContent = 'The higher the number, the more memory your browser uses. Cached PDFs reopen instantly; large drawings can be several MB each.';
        const stats = document.createElement('div');
        stats.className = 'sdx-note';
        function updateStats() {
            const st = pvGetCacheStats();
            stats.textContent = `Currently cached: ${st.count} PDF${st.count === 1 ? '' : 's'} (${formatBytes(st.bytes)})`;
        }
        updateStats();
        slider.addEventListener('input', updateCacheLabel);
        slider.addEventListener('change', function () {
            const s = loadViewerSettings();
            s.cacheMax = Number(slider.value);
            saveViewerSettings(s);
            pvEnforceCacheLimit();
            updateStats();
        });
        const purgeBtn = document.createElement('button');
        purgeBtn.type = 'button';
        purgeBtn.textContent = 'Purge all';
        purgeBtn.addEventListener('click', function () {
            pvPurgeCache();
            updateStats();
        });
        const purgeLine = document.createElement('div');
        purgeLine.style.marginTop = '6px';
        purgeLine.appendChild(purgeBtn);
        cacheSection.appendChild(cacheLabel);
        cacheSection.appendChild(slider);
        cacheSection.appendChild(cacheNote);
        cacheSection.appendChild(stats);
        cacheSection.appendChild(purgeLine);
        menu.appendChild(cacheSection);
    }
    function renderHighlightsTab(menu) {
        const settings = loadSettings();
        const hl = settings.rowHighlighting;
        const note = document.createElement('div');
        note.className = 'sdx-subtitle';
        note.textContent = 'Color rows on this To Do List. Saves automatically. If a row is both overdue and flagged by completion, overdue wins.';
        menu.appendChild(note);
        // --- Overdue rule ---
        const overdueLabel = document.createElement('label');
        overdueLabel.className = 'sdx-item';
        const overdueCb = document.createElement('input');
        overdueCb.type = 'checkbox';
        overdueCb.checked = hl.overdueEnabled;
        const overdueSpan = document.createElement('span');
        overdueSpan.textContent = 'Highlight overdue rows (light red) when Target Date has passed';
        overdueCb.addEventListener('change', function () {
            const s = loadSettings();
            s.rowHighlighting.overdueEnabled = overdueCb.checked;
            saveSettings(s);
            applyRowHighlighting();
        });
        overdueLabel.appendChild(overdueCb);
        overdueLabel.appendChild(overdueSpan);
        menu.appendChild(overdueLabel);
        // --- Completion rules (Consolidation rows only) ---
        const section = document.createElement('div');
        section.className = 'sdx-section';
        const sectionTitle = document.createElement('div');
        sectionTitle.className = 'sdx-subtitle';
        sectionTitle.style.marginBottom = '6px';
        sectionTitle.textContent = 'Completion % rules (only applied where RFR = Consolidation):';
        section.appendChild(sectionTitle);
        function buildThresholdRule(labelText, checked, thresholdValue, onChange) {
            const label = document.createElement('label');
            label.className = 'sdx-item';
            const cb = document.createElement('input');
            cb.type = 'checkbox';
            cb.checked = checked;
            const span = document.createElement('span');
            span.textContent = labelText;
            const input = document.createElement('input');
            input.type = 'number';
            input.min = '0';
            input.max = '100';
            input.step = '1';
            input.style.width = '55px';
            input.style.marginLeft = '6px';
            input.value = String(thresholdValue);
            const percentSpan = document.createElement('span');
            percentSpan.textContent = '%';
            percentSpan.style.marginLeft = '2px';
            function commit() {
                onChange(cb.checked, input.value);
            }
            cb.addEventListener('change', commit);
            input.addEventListener('change', commit);
            input.addEventListener('keydown', function (e) {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    commit();
                }
            });
            label.appendChild(cb);
            label.appendChild(span);
            label.appendChild(input);
            label.appendChild(percentSpan);
            return label;
        }
        const lowRule = buildThresholdRule(
            'Below (light orange)',
            hl.lowCompletionEnabled,
            hl.lowCompletionThreshold,
            function (enabled, value) {
                const s = loadSettings();
                s.rowHighlighting.lowCompletionEnabled = enabled;
                const raw = Number(value);
                s.rowHighlighting.lowCompletionThreshold = Number.isFinite(raw) ? Math.min(100, Math.max(0, raw)) : 25;
                saveSettings(s);
                applyRowHighlighting();
            }
        );
        const highRule = buildThresholdRule(
            'Above (light green)',
            hl.highCompletionEnabled,
            hl.highCompletionThreshold,
            function (enabled, value) {
                const s = loadSettings();
                s.rowHighlighting.highCompletionEnabled = enabled;
                const raw = Number(value);
                s.rowHighlighting.highCompletionThreshold = Number.isFinite(raw) ? Math.min(100, Math.max(0, raw)) : 75;
                saveSettings(s);
                applyRowHighlighting();
            }
        );
        section.appendChild(lowRule);
        section.appendChild(highRule);
        menu.appendChild(section);
        // --- Step details bottom panel ---
        const panelSection = document.createElement('div');
        panelSection.className = 'sdx-section';
        const panelLabel = document.createElement('label');
        panelLabel.className = 'sdx-item';
        const panelCb = document.createElement('input');
        panelCb.type = 'checkbox';
        panelCb.checked = settings.suppressStepDetailsPanel;
        const panelSpan = document.createElement('span');
        panelSpan.textContent = 'Auto-close the bottom step-details panel (Task / Document revision / Workflow) when it opens';
        panelCb.addEventListener('change', function () {
            const s = loadSettings();
            s.suppressStepDetailsPanel = panelCb.checked;
            saveSettings(s);
            maybeSuppressStepDetailsPanel();
        });
        panelLabel.appendChild(panelCb);
        panelLabel.appendChild(panelSpan);
        const panelNote = document.createElement('div');
        panelNote.className = 'sdx-note';
        panelNote.textContent = 'It may flash briefly before closing. The row action menu on the left (Reassign, Consolidate QA Reviews, etc.) is not affected.';
        panelSection.appendChild(panelLabel);
        panelSection.appendChild(panelNote);
        menu.appendChild(panelSection);
    }
    document.addEventListener('click', function (e) {
        const menu = document.getElementById(MANAGER.menuId);
        const button = document.getElementById(MANAGER.buttonId);
        if (!menu) return;
        if (menu.contains(e.target)) return;
        if (button && button.contains(e.target)) return;
        closeManagerMenu();
    }, true);
    //////////////////////////////////////////////////////////////////////
    // MODULE 3F
    // TOOLTIPS ON TRUNCATED CELLS
    //////////////////////////////////////////////////////////////////////
    // Read-only/cosmetic (just a title attribute), so unlike widths there's no
    // shared-state risk if a page happens to have more than one grid - safe to
    // apply document-wide.
    const CELL_SELECTOR = '[role="gridcell"], td, .k-table-td, .mat-mdc-cell, .mat-cell, .ag-cell';
    function applyTruncationTooltips() {
        document.querySelectorAll(CELL_SELECTOR).forEach(cell => {
            const isTruncated = cell.scrollWidth > cell.clientWidth + 1;
            const weSetIt = cell.dataset.sdxQolAutoTitle === '1';
            if (isTruncated) {
                const text = normalizeText(cell.innerText || cell.textContent || '');
                if (text && (weSetIt || !cell.getAttribute('title'))) {
                    if (cell.getAttribute('title') !== text) {
                        cell.setAttribute('title', text);
                    }
                    cell.dataset.sdxQolAutoTitle = '1';
                }
            } else if (weSetIt) {
                cell.removeAttribute('title');
                delete cell.dataset.sdxQolAutoTitle;
            }
        });
    }
    //////////////////////////////////////////////////////////////////////
    // MODULE 3G
    // SESSION STATUS INDICATOR (sidebar)
    //////////////////////////////////////////////////////////////////////
    // We don't have visibility into how SDx tracks its own token/session
    // expiry internally, so rather than guess with an idle timer (which could
    // easily be wrong about the real timeout window), this watches actual
    // network responses for the status codes apps commonly use to signal an
    // expired session (401 Unauthorized, 419/440 session-timeout variants)
    // and flips the sidebar icon the moment one is seen - the same signal
    // SDx's own code would be reacting to, just surfaced to you directly.
    const SESSION_BUTTON_ID = 'sdx-qol-session-status-btn';
    const SESSION_EXPIRED_STATUSES = new Set([401, 419, 440]);
    let sessionExpiredDetected = false;
    function markSessionExpired() {
        if (sessionExpiredDetected) return;
        sessionExpiredDetected = true;
        const btn = document.getElementById(SESSION_BUTTON_ID);
        if (btn) {
            btn.classList.add('sdx-qol-session-expired');
            btn.title = 'SDx session appears to have expired - save your work and refresh';
        }
        console.warn('SDx QoL: a request came back with an auth-expired status. Session may have timed out.');
    }
    function installSessionWatcher() {
        const originalFetch = window.fetch;
        if (originalFetch && !originalFetch.__sdxQolWrapped) {
            const wrappedFetch = function (...args) {
                return originalFetch.apply(this, args).then(function (response) {
                    if (response && SESSION_EXPIRED_STATUSES.has(response.status)) {
                        markSessionExpired();
                    }
                    return response;
                });
            };
            wrappedFetch.__sdxQolWrapped = true;
            window.fetch = wrappedFetch;
        }
        const originalOpen = XMLHttpRequest.prototype.open;
        if (!originalOpen.__sdxQolWrapped) {
            const wrappedOpen = function (...args) {
                this.addEventListener('load', function () {
                    if (SESSION_EXPIRED_STATUSES.has(this.status)) {
                        markSessionExpired();
                    }
                });
                return originalOpen.apply(this, args);
            };
            wrappedOpen.__sdxQolWrapped = true;
            XMLHttpRequest.prototype.open = wrappedOpen;
        }
    }
    function injectSessionButton() {
        if (document.getElementById(SESSION_BUTTON_ID)) return;
        const nav = document.querySelector('nav.side-bar');
        if (!nav) return;
        const groups = nav.querySelectorAll('.side-bar__group');
        const targetGroup = groups.length ? groups[groups.length - 1] : nav;
        const button = document.createElement('button');
        button.id = SESSION_BUTTON_ID;
        button.type = 'button';
        button.className = 'side-bar__button';
        button.title = 'Session status: OK';
        button.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="100%" height="100%" focusable="false">'
            + '<path d="M12,2A10,10,0,1,0,22,12,10,10,0,0,0,12,2Zm0,18a8,8,0,1,1,8-8A8,8,0,0,1,12,20Z"></path>'
            + '<path d="M12.5,7H11V13l5.25,3.15.75-1.23-4.5-2.67Z"></path>'
            + '</svg>';
        button.addEventListener('click', function (e) {
            e.preventDefault();
            e.stopPropagation();
            if (sessionExpiredDetected) {
                if (confirm('Your SDx session may have expired. Reload the page now?')) {
                    location.reload();
                }
            } else {
                alert('No session issues detected yet. This icon turns red automatically if a request comes back as expired.');
            }
        });
        if (sessionExpiredDetected) {
            button.classList.add('sdx-qol-session-expired');
            button.title = 'SDx session appears to have expired - save your work and refresh';
        }
        targetGroup.appendChild(button);
    }
    installSessionWatcher();
    //////////////////////////////////////////////////////////////////////
    // MODULE 3H
    // BULK FILE DOWNLOAD ("DL Files")
    //////////////////////////////////////////////////////////////////////
    // SDx's own download flow (checkbox-select rows -> Actions > Files >
    // Save PDF/CAD/Excel Files... / Save Target As...) opens a "Select files
    // to download" dialog that is silently capped at 100 files: confirmed via
    // live network capture that this is a fixed page size baked into the
    // listing call that populates that dialog ($top=100, always, regardless
    // of how many rows were actually selected) - not a backend limit. Nothing
    // downstream of that dialog has any such cap: RetrieveFileUris resolves
    // one selected row's own OBID directly to its actual attached file
    // (confirmed working identically for a PDF, an .nwd, and a .stp file with
    // no type-specific handling needed), and DownloadFile just zips whatever
    // file list it's handed. So rather than fighting SDx's own menu/dialog,
    // this adds a separate "DL Files" button next to Columns/Rows that talks
    // to those same two endpoints directly - no cap, no dependency on SDx's
    // own dialog ever opening.
    //
    // NEW - added but not yet confirmed working live. Test with a small
    // selection (2-3 files) first and check the console for warnings before
    // trusting it on a large batch.
    function stripBearerPrefix(token) {
        return String(token || '').replace(/^Bearer\s+/i, '').trim();
    }
    function looksLikeJwt(value) {
        return typeof value === 'string' && value.split('.').length === 3;
    }
    // Scans broadly (any sessionStorage key with "auth" in its name) rather
    // than a single hardcoded key, since this script is used by multiple
    // people and should not assume one exact key name from one browser/Okta
    // config. This is SDx's own frontend session token - no dependency on any
    // other userscript being installed.
    // Returns EVERY token found under an "auth" sessionStorage key (not just
    // the first), so getSdxAuthToken() can pick the freshest one.
    function getAllTokensFromSessionStorage() {
        const found = [];
        try {
            for (let i = 0; i < sessionStorage.length; i++) {
                const key = sessionStorage.key(i);
                if (!key || !/auth/i.test(key)) continue;
                const raw = sessionStorage.getItem(key);
                if (!raw) continue;
                try {
                    const parsed = JSON.parse(raw);
                    const candidate = parsed && (parsed.authorization || parsed.Authorization || parsed.accessToken || parsed.access_token || parsed.token);
                    if (typeof candidate === 'string') {
                        const stripped = stripBearerPrefix(candidate);
                        if (looksLikeJwt(stripped)) found.push(stripped);
                    }
                } catch (innerErr) {
                    const stripped = stripBearerPrefix(raw);
                    if (looksLikeJwt(stripped)) found.push(stripped);
                }
            }
        } catch (err) {
            console.warn('SDx QoL: getAllTokensFromSessionStorage failed', err);
        }
        return found;
    }
    // Expiry (ms since epoch) from a JWT's "exp" claim, or 0 if unreadable.
    function jwtExpiryMs(token) {
        try {
            const part = String(token).split('.')[1];
            const b64 = part.replace(/-/g, '+').replace(/_/g, '/');
            const json = atob(b64.padEnd(Math.ceil(b64.length / 4) * 4, '='));
            const exp = Number(JSON.parse(json).exp);
            return Number.isFinite(exp) ? exp * 1000 : 0;
        } catch (err) {
            return 0;
        }
    }
    // Defensive fallback only - some users also run a separate "SDx Add
    // Reviewer" userscript that caches its own auth headers here.
    function getTokenFromReviewerWizard() {
        try {
            const raw = localStorage.getItem('sdxbr_auth_headers_v07');
            if (!raw) return null;
            const parsed = JSON.parse(raw);
            const candidate = parsed && (parsed.authorization || parsed.Authorization);
            if (typeof candidate === 'string') {
                const stripped = stripBearerPrefix(candidate);
                if (looksLikeJwt(stripped)) return stripped;
            }
        } catch (err) {
            console.warn('SDx QoL: getTokenFromReviewerWizard failed', err);
        }
        return null;
    }
    // Picks the token with the LATEST expiry among every source we can see:
    // all sessionStorage auth entries, the most recent token SDx itself sent
    // on a request (captured by Module 0's passive header watcher), and the
    // Reviewer Wizard cache. SDx renews its token during a session; relying
    // on whichever source happened to come first meant a stale, expired token
    // could be used, which the server rejects with HTTP 401.
    function getSdxAuthToken() {
        const candidates = [
            ...getAllTokensFromSessionStorage(),
            capturedAuthToken,
            getTokenFromReviewerWizard()
        ].filter(Boolean);
        let best = null;
        let bestExp = -1;
        candidates.forEach(token => {
            const exp = jwtExpiryMs(token);
            if (exp > bestExp) {
                best = token;
                bestExp = exp;
            }
        });
        return best;
    }
    function getSdaApiBase() {
        return `${location.origin}/ENR01Server/api/v2/SDA`;
    }
    async function mapWithConcurrency(items, limit, fn) {
        const results = new Array(items.length);
        let nextIndex = 0;
        async function worker() {
            while (nextIndex < items.length) {
                const current = nextIndex++;
                try {
                    results[current] = { ok: true, value: await fn(items[current], current) };
                } catch (err) {
                    results[current] = { ok: false, error: err };
                }
            }
        }
        const workerCount = Math.max(1, Math.min(limit, items.length));
        await Promise.all(Array.from({ length: workerCount }, worker));
        return results;
    }
    // Resolves the Kendo grid widget from THIS checkbox's own closest .k-grid
    // ancestor, rather than grabbing whichever .k-grid happens to be first on
    // the page - a page can have more than one Kendo grid (filter panels,
    // sidebars, etc.), and calling dataItem() against the wrong widget
    // silently returns nothing.
    function getKendoGridWidgetForElement(el) {
        const gridEl = el && el.closest ? el.closest('.k-grid') : null;
        if (!gridEl) return null;
        return getKendoWidgetFromElement(gridEl, ['kendoGrid']);
    }
    // Resolves each checked checkbox back to its row's own data item so we can
    // read the row's OBID/Name - keyed by data-uid rather than DOM position,
    // and falls back to searching for a twin row sharing the same data-uid in
    // case this grid also splits locked/scroll columns into separate <tr>s
    // (confirmed to happen on at least one other SDx grid in this script).
    function getSelectedFileRowsForDownload() {
        const results = [];
        const seenUids = new Set();
        getVisibleCheckboxes().forEach(cb => {
            if (!cb.checked) return;
            const widget = getKendoGridWidgetForElement(cb);
            if (!widget || typeof widget.dataItem !== 'function') {
                console.warn('SDx QoL: DL Files - checked checkbox is not inside a recognizable Kendo grid', cb);
                return;
            }
            const row = cb.closest('tr, [role="row"], [role="none"]');
            if (!row) {
                console.warn('SDx QoL: DL Files - could not find a row element for a checked checkbox', cb);
                return;
            }
            const uid = row.getAttribute('data-uid');
            if (uid && seenUids.has(uid)) return;
            let item = null;
            try {
                item = widget.dataItem(row);
            } catch (err) {
                item = null;
            }
            if (!item && uid) {
                const gridEl = cb.closest('.k-grid');
                const twin = gridEl ? gridEl.querySelector(`[data-uid="${uid}"][role="row"]`) : null;
                if (twin) {
                    try {
                        item = widget.dataItem(twin);
                    } catch (err) {
                        item = null;
                    }
                }
            }
            if (!item) {
                console.warn('SDx QoL: DL Files - widget.dataItem() returned nothing for a checked row', row, 'data-uid:', uid);
                return;
            }
            // Different SDx grids expose the row's own short identifier under
            // different field names - the To Do List grid uses OBID, this
            // Results grid uses Id (confirmed live: both hold the same short
            // alphanumeric code format, e.g. "P8HV03YA").
            const obid = item.OBID || item.Id;
            if (!obid) {
                console.warn('SDx QoL: DL Files - resolved data item has no OBID/Id field', item);
                return;
            }
            if (uid) seenUids.add(uid);
            results.push({
                obid,
                name: normalizeText(item.Name || item.CI_Name || obid),
                config: item.Config || item.SPFConfigUID || null
            });
        });
        return results;
    }
    // Confirmed required via live network capture: a grid row's own OBID/Id
    // is a DOCUMENT-level identifier, not the file key RetrieveFileUris
    // expects - calling RetrieveFileUris directly with it 404s. SDx's own
    // native flow resolves each document to its actual attached file first,
    // via this exact query shape: Objects filtered by the document OBIDs,
    // $expand=SPFFileComposition_21(...) (the same "viewable or editable
    // business file" filter SDx's own JS uses), which returns each document
    // alongside a nested SPFDesignFile object - THAT object's own OBID is
    // the real file key. This same resolve query has its own hardcoded
    // $top=100, so it's sub-batched internally in groups of 100 regardless
    // of the caller's own chunk/zip size.
    async function resolveFileObidsForDocuments(rows, token) {
        const map = new Map();
        const groups = new Map();
        rows.forEach(row => {
            const key = row.config || '';
            if (!groups.has(key)) groups.set(key, []);
            groups.get(key).push(row);
        });
        const expandFilter = "Interfaces eq 'ISPFBusinessFile' and SPFViewInd eq 'true' or SPFEditInd eq 'true'";
        for (const [config, groupRows] of groups) {
            for (let i = 0; i < groupRows.length; i += 100) {
                const subBatch = groupRows.slice(i, i + 100);
                const filter = `(${subBatch.map(r => `OBID eq '${String(r.obid).replace(/'/g, "''")}'`).join(' or ')})`;
                const expand = `SPFFileComposition_21($filter=${expandFilter};$skip=0;$top=1;$count=true)`;
                const params = new URLSearchParams();
                params.set('$filter', filter);
                params.set('$select', 'Name,OBID');
                params.set('$expand', expand);
                params.set('$skip', '0');
                params.set('$top', '100');
                params.set('$count', 'true');
                const url = `${getSdaApiBase()}/Objects?${params.toString()}`;
                const headers = {
                    Accept: 'application/json, text/plain, */*',
                    Authorization: `Bearer ${token}`
                };
                if (config) headers.SPFConfigUID = config;
                const resp = await fetch(url, { method: 'GET', headers });
                if (!resp.ok) {
                    throw new Error(`Resolve step failed (HTTP ${resp.status}) for config ${config || '(none)'}`);
                }
                const data = await resp.json();
                (data.value || []).forEach(item => {
                    const comp = Array.isArray(item.SPFFileComposition_21) ? item.SPFFileComposition_21[0] : null;
                    if (item.OBID && comp && comp.OBID) {
                        map.set(item.OBID, comp.OBID);
                    }
                });
            }
        }
        return map;
    }
    async function retrieveFileUriForObid(obid, token) {
        const url = `${getSdaApiBase()}/Files('${encodeURIComponent(obid)}')/Intergraph.SPF.Server.API.Model.RetrieveFileUris`;
        const resp = await fetch(url, {
            method: 'POST',
            headers: {
                Accept: 'application/json, text/plain, */*',
                'Content-Type': 'application/json',
                Authorization: `Bearer ${token}`
            },
            body: JSON.stringify({ purposes: ['Primary'], downloadFile: true })
        });
        if (!resp.ok) {
            throw new Error(`RetrieveFileUris failed (HTTP ${resp.status})`);
        }
        const data = await resp.json();
        const info = data && Array.isArray(data.value) ? data.value[0] : null;
        if (!info || !info.Uri) {
            throw new Error('No file URI returned for this item');
        }
        return {
            FileOBID: info.FileId || obid,
            ParentFileOBID: info.ParentFileOBID || null,
            URL: info.Uri,
            ContentLength: Number(info.ContentLength) || 0
        };
    }
    // Uses XHR instead of fetch so we can report real bytes-received progress
    // via onprogress while the browser downloads the finished zip - the
    // server-side zip assembly itself (which is the slow part for large
    // batches) happens before any bytes are sent, so this only lights up
    // once the transfer actually starts, but it's real signal when it does.
    function downloadFileChunkWithProgress(urlListEntries, token, onProgress) {
        return new Promise((resolve, reject) => {
            const xhr = new XMLHttpRequest();
            xhr.open('POST', `${getSdaApiBase()}/DownloadFile`);
            xhr.responseType = 'blob';
            xhr.setRequestHeader('Accept', 'application/json, text/plain, */*');
            xhr.setRequestHeader('Content-Type', 'application/json');
            xhr.setRequestHeader('Authorization', `Bearer ${token}`);
            xhr.onprogress = function (event) {
                if (onProgress) onProgress(event.loaded, event.lengthComputable ? event.total : 0);
            };
            xhr.onload = function () {
                if (xhr.status >= 200 && xhr.status < 300) {
                    resolve(xhr.response);
                } else {
                    reject(new Error(`DownloadFile failed (HTTP ${xhr.status})`));
                }
            };
            xhr.onerror = function () {
                reject(new Error('DownloadFile failed (network error)'));
            };
            xhr.send(JSON.stringify({ URLList: urlListEntries }));
        });
    }
    function formatBytes(bytes) {
        if (!Number.isFinite(bytes) || bytes < 0) return 'unknown size';
        const units = ['B', 'KB', 'MB', 'GB', 'TB'];
        let value = bytes;
        let unitIndex = 0;
        while (value >= 1024 && unitIndex < units.length - 1) {
            value /= 1024;
            unitIndex++;
        }
        return `${value.toFixed(unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
    }
    function formatElapsed(ms) {
        const totalSeconds = Math.floor(ms / 1000);
        const m = Math.floor(totalSeconds / 60);
        const s = totalSeconds % 60;
        return m > 0 ? `${m}m ${s}s` : `${s}s`;
    }
    function getAutoZipBaseName() {
        const d = new Date();
        const pad = n => String(n).padStart(2, '0');
        return `SDx-Download_${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    }
    function sanitizeZipBaseName(name) {
        const cleaned = normalizeText(name).replace(/[\\/:*?"<>|]/g, '_');
        return cleaned || getAutoZipBaseName();
    }
    function triggerBlobDownload(blob, filename) {
        const blobUrl = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = blobUrl;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(blobUrl), 30000);
    }
    // Phase 1: resolve every selected row to its actual file (document->file
    // OBID mapping, then RetrieveFileUris for the URL + size) up front, once,
    // regardless of how the user later chooses to chunk the ZIPs. This gives
    // a real file count/size estimate before any zipping starts, and a real
    // X-of-Y progress readout since the total is known in advance.
    async function resolveAllRowsForModal(rows, statusEl, sizeEl, startButton) {
        startButton.disabled = true;
        const token = getSdxAuthToken();
        if (!token) {
            statusEl.textContent = 'Could not find an SDx auth token in this browser session. Make sure you are logged in to SDx in this tab and try again.';
            return null;
        }
        statusEl.textContent = `Resolving files: 0 of ${rows.length}...`;
        let fileObidMap;
        try {
            fileObidMap = await resolveFileObidsForDocuments(rows, token);
        } catch (err) {
            statusEl.textContent = `Could not resolve selected files: ${err.message}`;
            return null;
        }
        let done = 0;
        const results = await mapWithConcurrency(rows, 6, async row => {
            const fileObid = fileObidMap.get(row.obid);
            if (!fileObid) {
                throw new Error('No matching design file found for this document');
            }
            const entry = await retrieveFileUriForObid(fileObid, token);
            done++;
            statusEl.textContent = `Resolving files: ${done} of ${rows.length}...`;
            return { row, entry };
        });
        const resolvedEntries = [];
        const failedNames = [];
        let totalBytes = 0;
        results.forEach((r, idx) => {
            if (r.ok) {
                resolvedEntries.push(r.value);
                totalBytes += r.value.entry.ContentLength || 0;
            } else {
                console.warn('SDx QoL: DL Files - failed to resolve', rows[idx], r.error);
                failedNames.push(rows[idx].name);
            }
        });
        if (failedNames.length) {
            sizeEl.textContent = `${resolvedEntries.length} of ${rows.length} file(s) ready (~${formatBytes(totalBytes)}). ${failedNames.length} could not be resolved: ${failedNames.slice(0, 5).join(', ')}${failedNames.length > 5 ? '...' : ''}`;
        } else {
            sizeEl.textContent = `${resolvedEntries.length} file(s) ready - estimated total size ~${formatBytes(totalBytes)}.`;
        }
        statusEl.textContent = resolvedEntries.length ? 'Ready to download.' : 'Nothing could be resolved for download.';
        startButton.disabled = resolvedEntries.length === 0;
        return { resolvedEntries, totalBytes, token };
    }
    // Phase 2: chunk the already-resolved entries into ZIPs and download each
    // in turn. Shows an elapsed-time ticker while the server assembles each
    // ZIP (that's the slow part for large batches, with no progress signal
    // available), then switches to real bytes-received progress once the
    // browser starts actually receiving the finished ZIP.
    async function startBulkZipDownload(resolvedEntries, chunkSize, token, baseName, statusEl) {
        const safeChunkSize = Math.max(1, chunkSize || resolvedEntries.length);
        const chunks = [];
        for (let i = 0; i < resolvedEntries.length; i += safeChunkSize) {
            chunks.push(resolvedEntries.slice(i, i + safeChunkSize));
        }
        const failedOverall = [];
        for (let c = 0; c < chunks.length; c++) {
            const chunkItems = chunks[c];
            const urlListEntries = chunkItems.map((item, idx) => ({
                FileOBID: item.entry.FileOBID,
                ParentFileOBID: item.entry.ParentFileOBID,
                URL: item.entry.URL,
                Name: `File ${idx}`
            }));
            const chunkBytes = chunkItems.reduce((sum, item) => sum + (item.entry.ContentLength || 0), 0);
            const startTime = Date.now();
            const elapsedTimer = setInterval(function () {
                statusEl.textContent = `Zipping batch ${c + 1} of ${chunks.length} (${chunkItems.length} files, ~${formatBytes(chunkBytes)})... elapsed ${formatElapsed(Date.now() - startTime)}`;
            }, 1000);
            statusEl.textContent = `Zipping batch ${c + 1} of ${chunks.length} (${chunkItems.length} files, ~${formatBytes(chunkBytes)})...`;
            try {
                const blob = await downloadFileChunkWithProgress(urlListEntries, token, function (loaded, total) {
                    if (total) {
                        statusEl.textContent = `Downloading batch ${c + 1} of ${chunks.length}: ${formatBytes(loaded)} of ${formatBytes(total)}...`;
                    }
                });
                clearInterval(elapsedTimer);
                const filename = chunks.length > 1 ? `${baseName}_${c + 1}of${chunks.length}.zip` : `${baseName}.zip`;
                triggerBlobDownload(blob, filename);
            } catch (err) {
                clearInterval(elapsedTimer);
                console.warn('SDx QoL: DL Files - batch download failed', err);
                statusEl.textContent = `Batch ${c + 1} of ${chunks.length} failed: ${err.message}`;
                failedOverall.push(...chunkItems.map(item => item.row.name));
            }
        }
        if (failedOverall.length) {
            statusEl.textContent = `Done. ${failedOverall.length} file(s) could not be downloaded and were skipped: ${failedOverall.slice(0, 10).join(', ')}${failedOverall.length > 10 ? '...' : ''}`;
        } else {
            statusEl.textContent = 'Done - all files downloaded.';
        }
    }
    function closeDlFilesModal() {
        const modal = document.getElementById(DL_MODAL_ID);
        if (modal) modal.remove();
    }
    function renderDlFilesModal(modal, rows) {
        modal.innerHTML = '';
        const backdrop = document.createElement('div');
        backdrop.className = 'sdx-qol-dl-backdrop';
        backdrop.addEventListener('click', closeDlFilesModal);
        const panel = document.createElement('div');
        panel.className = 'sdx-qol-dl-panel';
        panel.addEventListener('click', e => e.stopPropagation());
        const title = document.createElement('div');
        title.className = 'sdx-title';
        title.textContent = `⬇ Download ${rows.length} Selected File${rows.length === 1 ? '' : 's'}`;
        const list = document.createElement('div');
        list.className = 'sdx-qol-dl-list';
        rows.forEach(r => {
            const line = document.createElement('div');
            line.className = 'sdx-qol-dl-list-item';
            line.textContent = r.name;
            list.appendChild(line);
        });
        const sizeEl = document.createElement('div');
        sizeEl.className = 'sdx-note';
        sizeEl.style.margin = '6px 0';
        sizeEl.textContent = 'Estimating total size...';
        const optionsRow = document.createElement('div');
        optionsRow.className = 'sdx-qol-dl-options';
        const singleLabel = document.createElement('label');
        singleLabel.className = 'sdx-item';
        const singleRadio = document.createElement('input');
        singleRadio.type = 'radio';
        singleRadio.name = 'sdx-qol-dl-mode';
        singleRadio.checked = rows.length <= 100;
        const singleSpan = document.createElement('span');
        singleSpan.textContent = 'Single ZIP (all files in one download)';
        singleLabel.appendChild(singleRadio);
        singleLabel.appendChild(singleSpan);
        const splitLabel = document.createElement('label');
        splitLabel.className = 'sdx-item';
        const splitRadio = document.createElement('input');
        splitRadio.type = 'radio';
        splitRadio.name = 'sdx-qol-dl-mode';
        splitRadio.checked = rows.length > 100;
        const splitSpan = document.createElement('span');
        splitSpan.textContent = 'Split into ZIPs of';
        const batchSizeInput = document.createElement('input');
        batchSizeInput.type = 'number';
        batchSizeInput.min = '1';
        batchSizeInput.value = '100';
        batchSizeInput.style.width = '55px';
        batchSizeInput.style.margin = '0 4px';
        const filesSpan = document.createElement('span');
        filesSpan.textContent = 'files each';
        splitLabel.appendChild(splitRadio);
        splitLabel.appendChild(splitSpan);
        splitLabel.appendChild(batchSizeInput);
        splitLabel.appendChild(filesSpan);
        optionsRow.appendChild(singleLabel);
        optionsRow.appendChild(splitLabel);
        const nameRow = document.createElement('div');
        nameRow.className = 'sdx-qol-dl-options';
        const autoLabel = document.createElement('label');
        autoLabel.className = 'sdx-item';
        const autoCheckbox = document.createElement('input');
        autoCheckbox.type = 'checkbox';
        autoCheckbox.checked = true;
        const autoSpan = document.createElement('span');
        autoSpan.textContent = 'Auto-name';
        autoLabel.appendChild(autoCheckbox);
        autoLabel.appendChild(autoSpan);
        const nameInput = document.createElement('input');
        nameInput.type = 'text';
        nameInput.placeholder = 'ZIP file name (without .zip)';
        nameInput.value = getAutoZipBaseName();
        nameInput.disabled = true;
        nameInput.className = 'sdx-qol-dl-name-input';
        autoCheckbox.addEventListener('change', function () {
            nameInput.disabled = autoCheckbox.checked;
            if (autoCheckbox.checked) nameInput.value = getAutoZipBaseName();
        });
        nameRow.appendChild(autoLabel);
        nameRow.appendChild(nameInput);
        const statusEl = document.createElement('div');
        statusEl.className = 'sdx-note';
        statusEl.style.margin = '8px 0';
        statusEl.textContent = 'Resolving files...';
        const actions = document.createElement('div');
        actions.className = 'sdx-actions';
        const startButton = document.createElement('button');
        startButton.type = 'button';
        startButton.className = 'sdx-apply';
        startButton.textContent = 'Start Download';
        startButton.disabled = true;
        const closeButton = document.createElement('button');
        closeButton.type = 'button';
        closeButton.textContent = 'Close';
        closeButton.addEventListener('click', closeDlFilesModal);
        actions.appendChild(startButton);
        actions.appendChild(closeButton);
        panel.appendChild(title);
        panel.appendChild(list);
        panel.appendChild(sizeEl);
        panel.appendChild(optionsRow);
        panel.appendChild(nameRow);
        panel.appendChild(statusEl);
        panel.appendChild(actions);
        modal.appendChild(backdrop);
        modal.appendChild(panel);
        resolveAllRowsForModal(rows, statusEl, sizeEl, startButton).then(function (resolution) {
            if (!resolution) return;
            startButton.addEventListener('click', function () {
                startButton.disabled = true;
                const chunkSize = singleRadio.checked ? resolution.resolvedEntries.length : Math.max(1, Number(batchSizeInput.value) || 100);
                const baseName = sanitizeZipBaseName(autoCheckbox.checked ? getAutoZipBaseName() : nameInput.value);
                startBulkZipDownload(resolution.resolvedEntries, chunkSize, resolution.token, baseName, statusEl).finally(function () {
                    startButton.disabled = false;
                });
            });
        });
    }
    function openDlFilesModal() {
        closeDlFilesModal();
        const rows = getSelectedFileRowsForDownload();
        if (rows.length === 0) {
            alert('SDx QoL: could not read any selected rows for download. Check the console for details, or try re-selecting the checkboxes.');
            return;
        }
        const modal = document.createElement('div');
        modal.id = DL_MODAL_ID;
        renderDlFilesModal(modal, rows);
        document.body.appendChild(modal);
    }
    function countCheckedCheckboxes() {
        return getVisibleCheckboxes().filter(cb => cb.checked).length;
    }
    function injectDlFilesButton() {
        if (!isTopFrame()) return;
        const columnsButton = document.getElementById(MANAGER.buttonId);
        if (!columnsButton || !columnsButton.parentElement) return;
        let button = document.getElementById(DL_BUTTON_ID);
        const checkedCount = countCheckedCheckboxes();
        if (checkedCount < 2) {
            if (button) button.remove();
            return;
        }
        if (!button) {
            button = document.createElement('button');
            button.id = DL_BUTTON_ID;
            button.type = 'button';
            button.addEventListener('click', function (e) {
                e.preventDefault();
                e.stopPropagation();
                openDlFilesModal();
            }, true);
            columnsButton.insertAdjacentElement('afterend', button);
        }
        button.textContent = `⬇ DL Files (${checkedCount})`;
        button.title = "Download all selected files as one or more ZIPs - bypasses SDx's own 100-file dialog limit";
    }
    document.addEventListener('change', function (e) {
        const checkbox = e.target.closest ? e.target.closest(CHECKBOX_SELECTOR) : null;
        if (!checkbox) return;
        injectDlFilesButton();
    }, true);
    document.addEventListener('click', function (e) {
        const checkbox = e.target.closest ? e.target.closest(CHECKBOX_SELECTOR) : null;
        if (!checkbox) return;
        setTimeout(injectDlFilesButton, 0);
    }, true);
    //////////////////////////////////////////////////////////////////////
    // MODULE 3K
    // PDF PREVIEW (small icon beside each document name)
    //////////////////////////////////////////////////////////////////////
    // Flow confirmed via live network capture of SDx's own "open file" click:
    //   1. GET  Objects('<docOBID>')/SPFFileComposition_21?$filter=SPFViewInd eq true&$top=1
    //        -> value[0].OBID is the viewable FILE's OBID
    //   2. POST Files('<fileOBID>')/...RetrieveFileUris
    //        body { purposes: ['Markup'], downloadFile: false }
    //        -> value[0].Uri is a same-origin /SPFViewDir/... PDF URL
    //   3. The PDF itself loads in the new tab with no Authorization header
    //      (session cookie), so we fetch it the same way and show it in an
    //      iframe via a blob: URL.
    // Nothing is fetched until the user clicks an icon, so this adds zero
    // background network load.
    const PV_BTN_CLASS = 'sdx-qol-pv-btn';
    const PV_MODAL_ID = 'sdx-qol-pv-modal';
    const PV_ACTIVE_CLASS = 'sdx-qol-pv-active';
    const VIEWER_SETTINGS_KEY = `${STORAGE_PREFIX}:viewer`;
    // Viewer settings are global (not per list): on/off switch, default PDF
    // zoom ('Fit' = fit to page, 'FitH' = fit to width), and how many PDFs to
    // keep in memory (0-100).
    // engine: 'pdfjs' = our own PDF.js-based viewer (identical in Chrome and
    // Edge; fit page/width always honored), 'native' = the browser's built-in
    // PDF viewer in an iframe (Edge's ignores the fit setting).
    function getDefaultViewerSettings() {
        return { enabled: true, view: 'Fit', cacheMax: 5, engine: 'pdfjs' };
    }
    function loadViewerSettings() {
        const defaults = getDefaultViewerSettings();
        try {
            const raw = localStorage.getItem(VIEWER_SETTINGS_KEY);
            if (!raw) return defaults;
            const parsed = JSON.parse(raw) || {};
            const cacheMax = Number(parsed.cacheMax);
            return {
                enabled: typeof parsed.enabled === 'boolean' ? parsed.enabled : defaults.enabled,
                view: parsed.view === 'FitH' ? 'FitH' : 'Fit',
                cacheMax: Number.isFinite(cacheMax) ? Math.min(100, Math.max(0, Math.round(cacheMax))) : defaults.cacheMax,
                engine: parsed.engine === 'native' ? 'native' : 'pdfjs'
            };
        } catch (err) {
            return defaults;
        }
    }
    function saveViewerSettings(settings) {
        try {
            localStorage.setItem(VIEWER_SETTINGS_KEY, JSON.stringify({
                enabled: Boolean(settings.enabled),
                view: settings.view === 'FitH' ? 'FitH' : 'Fit',
                cacheMax: Math.min(100, Math.max(0, Math.round(Number(settings.cacheMax) || 0))),
                engine: settings.engine === 'native' ? 'native' : 'pdfjs'
            }));
        } catch (err) {
            console.warn('SDx QoL: could not save viewer settings', err);
        }
    }
    const pvBlobCache = new Map(); // fileObid -> { blobUrl, fileName, size }
    let pvRequestCounter = 0;
    let pvCurrentObid = null;
    let pvLastObid = null; // last document opened - stays highlighted after the viewer closes
    let pvActiveUi = null; // UI handles of the currently open viewer
    let pvEscHandler = null;
    let pvActiveBlobUrl = null;
    const PV_ICON_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7S1 12 1 12z"/><circle cx="12" cy="12" r="3"/></svg>';
    // Blue-highlights the eye icon of the last-opened document so the user
    // can still find their place in the list after closing the viewer.
    function pvRefreshActiveHighlight() {
        document.querySelectorAll('.' + PV_BTN_CLASS).forEach(btn => {
            const active = pvLastObid !== null && btn.dataset.obid === pvLastObid;
            if (btn.classList.contains(PV_ACTIVE_CLASS) !== active) {
                btn.classList.toggle(PV_ACTIVE_CLASS, active);
            }
        });
    }
    // Removes every icon and processed-row marker (used when the feature is
    // switched off; switching it back on re-injects from scratch).
    function removeAllPreviewButtons() {
        document.querySelectorAll('.' + PV_BTN_CLASS).forEach(btn => btn.remove());
        document.querySelectorAll('[data-sdx-qol-pv]').forEach(row => row.removeAttribute('data-sdx-qol-pv'));
    }
    function injectPreviewButtons() {
        if (!isTopFrame()) return;
        if (getPageType() === 'todo-list') return;
        if (!loadViewerSettings().enabled) return;
        document.querySelectorAll('.k-grid').forEach(gridEl => {
            const widget = getKendoWidgetFromElement(gridEl, ['kendoGrid']);
            if (!widget || typeof widget.dataItem !== 'function') return;
            gridEl.querySelectorAll('tr[data-uid]').forEach(row => {
                if (row.getAttribute('data-sdx-qol-pv') === '1') return;
                let item = null;
                try { item = widget.dataItem(row); } catch (err) { item = null; }
                if (!item) return;
                const obid = item.OBID || item.Id;
                const name = normalizeText(item.Name || item.CI_Name || '');
                if (!obid || !name) return;
                // Mark every processed <tr> (even the half with no link) so
                // later refresh passes skip it cheaply.
                row.setAttribute('data-sdx-qol-pv', '1');
                // Locked/frozen columns split one data row into two <tr>s, so
                // only the half that actually holds the name link gets the icon.
                // Confirmed live: the name is rendered as
                // <span class="grid-object__name">, not an <a>. Anchors are
                // kept as a fallback for other grids.
                const link = [...row.querySelectorAll('.grid-object__name, td a')].find(a => normalizeText(a.textContent) === name);
                if (!link) return;
                if (link.parentElement && link.parentElement.querySelector('.' + PV_BTN_CLASS)) return;
                const btn = document.createElement('span');
                btn.className = PV_BTN_CLASS;
                btn.setAttribute('role', 'button');
                btn.title = 'Preview PDF';
                btn.innerHTML = PV_ICON_SVG;
                btn.dataset.obid = obid;
                btn.dataset.name = name;
                btn.dataset.config = item.Config || item.SPFConfigUID || '';
                link.insertAdjacentElement('afterend', btn);
            });
        });
        if (pvLastObid !== null) pvRefreshActiveHighlight();
    }
    const schedulePreviewInjection = debounce(injectPreviewButtons, 100);
    function closePreviewModal() {
        pvRequestCounter++; // invalidates any in-flight request
        const existing = document.getElementById(PV_MODAL_ID);
        if (existing) existing.remove();
        if (pvEscHandler) {
            document.removeEventListener('keydown', pvEscHandler, true);
            pvEscHandler = null;
        }
        pvActiveBlobUrl = null;
        if (pvActiveUi && pvActiveUi.viewer) {
            try { pvActiveUi.viewer.destroy(); } catch (err) { /* ignore */ }
        }
        pvActiveUi = null;
        // Nothing is on screen now, so anything over the cache limit (e.g.
        // the just-viewed PDF when the limit is 0) can be released.
        pvEnforceCacheLimit();
    }
    // Evicts the oldest cached PDFs beyond the user's limit, never touching
    // the one currently being displayed.
    function pvEnforceCacheLimit() {
        const max = loadViewerSettings().cacheMax;
        while (pvBlobCache.size > max) {
            let victimKey = null;
            for (const [key, entry] of pvBlobCache) {
                if (entry.blobUrl !== pvActiveBlobUrl) { victimKey = key; break; }
            }
            if (victimKey === null) break;
            const victim = pvBlobCache.get(victimKey);
            pvBlobCache.delete(victimKey);
            try { URL.revokeObjectURL(victim.blobUrl); } catch (err) { /* ignore */ }
        }
    }
    function pvRememberBlob(fileObid, blobUrl, fileName, size, blob) {
        if (pvBlobCache.has(fileObid)) pvBlobCache.delete(fileObid);
        pvBlobCache.set(fileObid, { blobUrl, fileName, size: size || 0, blob: blob || null });
        pvEnforceCacheLimit();
    }
    function pvGetCacheStats() {
        let bytes = 0;
        pvBlobCache.forEach(entry => { bytes += entry.size || 0; });
        return { count: pvBlobCache.size, bytes };
    }
    // Releases every cached PDF except the one currently on screen (if the
    // viewer is open). Returns how many were released.
    function pvPurgeCache() {
        let released = 0;
        for (const [key, entry] of [...pvBlobCache]) {
            if (entry.blobUrl === pvActiveBlobUrl) continue;
            pvBlobCache.delete(key);
            try { URL.revokeObjectURL(entry.blobUrl); } catch (err) { /* ignore */ }
            released++;
        }
        return released;
    }
    // Chrome/Edge's built-in PDF viewer reads "open parameters" from the URL
    // fragment. 'Fit' = fit to page, 'FitH' = fit to width. The view param
    // goes first, and the zoom alias is included as a harmless extra: a
    // non-numeric zoom is simply ignored by builds that don't understand it.
    function pvViewHash(mode) {
        const fitH = (mode || loadViewerSettings().view) === 'FitH';
        return fitH
            ? '#view=FitH&zoom=page-width&navpanes=0'
            : '#view=Fit&zoom=page-fit&navpanes=0';
    }
    // Applies a change to the on/off switch right away.
    function applyViewerEnabled(enabled) {
        if (enabled) {
            injectPreviewButtons();
        } else {
            closePreviewModal();
            removeAllPreviewButtons();
            pvPurgeCache();
        }
    }
    function buildPreviewModal(title) {
        closePreviewModal();
        const modal = document.createElement('div');
        modal.id = PV_MODAL_ID;
        const backdrop = document.createElement('div');
        backdrop.className = 'sdx-qol-dl-backdrop';
        backdrop.addEventListener('click', closePreviewModal);
        const panel = document.createElement('div');
        panel.className = 'sdx-qol-pv-panel';
        const header = document.createElement('div');
        header.className = 'sdx-qol-pv-header';
        const titleEl = document.createElement('div');
        titleEl.className = 'sdx-qol-pv-title';
        titleEl.textContent = title;
        const counterEl = document.createElement('div');
        counterEl.className = 'sdx-qol-pv-counter';
        const pageEl = document.createElement('div');
        pageEl.className = 'sdx-qol-pv-counter';
        pageEl.style.display = 'none';
        // Search box (Enhanced viewer only).
        const searchWrap = document.createElement('div');
        searchWrap.className = 'sdx-qol-pv-search';
        searchWrap.style.display = 'none';
        const searchInput = document.createElement('input');
        searchInput.type = 'text';
        searchInput.placeholder = 'Find in PDF (Enter)';
        const searchPrev = document.createElement('button');
        searchPrev.type = 'button';
        searchPrev.textContent = '↑';
        searchPrev.title = 'Previous match';
        const searchNext = document.createElement('button');
        searchNext.type = 'button';
        searchNext.textContent = '↓';
        searchNext.title = 'Next match';
        const searchCount = document.createElement('span');
        searchCount.className = 'sdx-qol-pv-counter';
        function runSearch(dir) {
            if (pvActiveUi && pvActiveUi.viewer) pvActiveUi.viewer.search(searchInput.value, dir);
        }
        searchInput.addEventListener('keydown', function (e) {
            if (e.key === 'Enter') {
                e.preventDefault();
                runSearch(e.shiftKey ? -1 : 1);
            }
        });
        searchPrev.addEventListener('click', function () { runSearch(-1); });
        searchNext.addEventListener('click', function () { runSearch(1); });
        searchWrap.appendChild(searchInput);
        searchWrap.appendChild(searchPrev);
        searchWrap.appendChild(searchNext);
        searchWrap.appendChild(searchCount);
        const downloadBtn = document.createElement('button');
        downloadBtn.type = 'button';
        downloadBtn.textContent = 'Download';
        downloadBtn.title = 'Save this PDF';
        downloadBtn.style.display = 'none';
        const printBtn = document.createElement('button');
        printBtn.type = 'button';
        printBtn.textContent = 'Print';
        printBtn.title = 'Print this PDF';
        printBtn.style.display = 'none';
        const zoomOutBtn = document.createElement('button');
        zoomOutBtn.type = 'button';
        zoomOutBtn.textContent = '−';
        zoomOutBtn.title = 'Zoom out';
        zoomOutBtn.style.display = 'none';
        zoomOutBtn.addEventListener('click', function () { pvZoom(1 / 1.25); });
        const zoomInBtn = document.createElement('button');
        zoomInBtn.type = 'button';
        zoomInBtn.textContent = '+';
        zoomInBtn.title = 'Zoom in';
        zoomInBtn.style.display = 'none';
        zoomInBtn.addEventListener('click', function () { pvZoom(1.25); });
        const fitPageBtn = document.createElement('button');
        fitPageBtn.type = 'button';
        fitPageBtn.textContent = 'Fit page';
        fitPageBtn.title = 'Show whole page';
        fitPageBtn.style.display = 'none';
        fitPageBtn.addEventListener('click', function () { pvSetFitMode('Fit'); });
        const fitWidthBtn = document.createElement('button');
        fitWidthBtn.type = 'button';
        fitWidthBtn.textContent = 'Fit width';
        fitWidthBtn.title = 'Fit page to viewer width';
        fitWidthBtn.style.display = 'none';
        fitWidthBtn.addEventListener('click', function () { pvSetFitMode('FitH'); });
        const openBtn = document.createElement('button');
        openBtn.type = 'button';
        openBtn.textContent = 'Open in new tab';
        openBtn.style.display = 'none';
        const closeBtn = document.createElement('button');
        closeBtn.type = 'button';
        closeBtn.textContent = 'Close';
        closeBtn.addEventListener('click', closePreviewModal);
        header.appendChild(titleEl);
        header.appendChild(counterEl);
        header.appendChild(pageEl);
        header.appendChild(searchWrap);
        header.appendChild(zoomOutBtn);
        header.appendChild(zoomInBtn);
        header.appendChild(fitPageBtn);
        header.appendChild(fitWidthBtn);
        header.appendChild(downloadBtn);
        header.appendChild(printBtn);
        header.appendChild(openBtn);
        header.appendChild(closeBtn);
        const body = document.createElement('div');
        body.className = 'sdx-qol-pv-body';
        const status = document.createElement('div');
        status.className = 'sdx-qol-pv-status';
        body.appendChild(status);
        // Previous / next document arrows (follow the list's current order).
        const prevBtn = document.createElement('button');
        prevBtn.type = 'button';
        prevBtn.className = 'sdx-qol-pv-nav sdx-qol-pv-nav-prev';
        prevBtn.title = 'Previous document in list (Left arrow)';
        prevBtn.textContent = '‹';
        prevBtn.addEventListener('click', function () { pvNavigate(-1); });
        const nextBtn = document.createElement('button');
        nextBtn.type = 'button';
        nextBtn.className = 'sdx-qol-pv-nav sdx-qol-pv-nav-next';
        nextBtn.title = 'Next document in list (Right arrow)';
        nextBtn.textContent = '›';
        nextBtn.addEventListener('click', function () { pvNavigate(1); });
        body.appendChild(prevBtn);
        body.appendChild(nextBtn);
        panel.appendChild(header);
        panel.appendChild(body);
        modal.appendChild(backdrop);
        modal.appendChild(panel);
        document.body.appendChild(modal);
        // Fires only when focus is in the SDx page itself (not inside the PDF
        // viewer iframe), so it never fights the viewer's own arrow-key paging.
        pvEscHandler = function (e) {
            if (e.key === 'Escape') {
                e.stopPropagation();
                closePreviewModal();
            } else if ((e.ctrlKey || e.metaKey) && (e.key === 'f' || e.key === 'F') && pvActiveUi && pvActiveUi.viewer) {
                // Ctrl+F searches inside the PDF while the Enhanced viewer is open.
                e.preventDefault();
                e.stopPropagation();
                pvActiveUi.searchInput.focus();
                pvActiveUi.searchInput.select();
            } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
                // Don't hijack arrow keys while typing in the search box.
                if (isTypingTarget(e.target)) return;
                e.preventDefault();
                pvNavigate(e.key === 'ArrowLeft' ? -1 : 1);
            }
        };
        document.addEventListener('keydown', pvEscHandler, true);
        const ui = { titleEl, counterEl, openBtn, body, status, prevBtn, nextBtn, fitPageBtn, fitWidthBtn, pageEl, zoomOutBtn, zoomInBtn, searchWrap, searchInput, searchCount, downloadBtn, printBtn, blobUrl: null, frame: null, viewer: null };
        pvActiveUi = ui;
        return ui;
    }
    // The ordered list of previewable documents = the eye icons currently in
    // the list, in on-screen order. Re-read on every navigation because SDx
    // may have re-rendered rows (new page, sort, filter) since last time.
    function pvGetOrderedButtons() {
        const seen = new Set();
        const out = [];
        document.querySelectorAll('.' + PV_BTN_CLASS).forEach(btn => {
            const id = btn.dataset.obid;
            if (!id || seen.has(id) || !btn.isConnected) return;
            seen.add(id);
            out.push(btn);
        });
        return out;
    }
    function pvUpdateNav(ui, obid) {
        const list = pvGetOrderedButtons();
        const idx = list.findIndex(b => b.dataset.obid === obid);
        ui.prevBtn.disabled = idx <= 0;
        ui.nextBtn.disabled = idx < 0 || idx >= list.length - 1;
        ui.counterEl.textContent = idx >= 0 ? `${idx + 1} of ${list.length}` : '';
    }
    function pvNavigate(delta) {
        const list = pvGetOrderedButtons();
        const idx = list.findIndex(b => b.dataset.obid === pvCurrentObid);
        if (idx < 0) return;
        const target = list[idx + delta];
        if (!target) return;
        // Keep the list scrolled so the row being previewed stays in view.
        try { target.scrollIntoView({ block: 'nearest' }); } catch (err) { /* ignore */ }
        openPdfPreview(target.dataset.obid, target.dataset.name, target.dataset.config || null);
    }
    function pvMarkFitButtons(ui, mode) {
        ui.fitPageBtn.classList.toggle('sdx-qol-pv-fit-active', mode !== 'FitH');
        ui.fitWidthBtn.classList.toggle('sdx-qol-pv-fit-active', mode === 'FitH');
    }
    // Browser built-in viewer (fallback engine). A brand-new iframe element
    // is used on every change because changing only the #fragment of an
    // already-loaded PDF would not make Chrome/Edge re-read open parameters.
    // Edge's built-in viewer ignores the fit parameters; Chrome's honors them.
    function pvLoadFrame(ui, mode) {
        if (!ui.blobUrl) return;
        if (ui.frame) ui.frame.remove();
        const src = ui.blobUrl + pvViewHash(mode);
        const frame = document.createElement('iframe');
        frame.src = src;
        ui.body.appendChild(frame);
        ui.frame = frame;
        pvMarkFitButtons(ui, mode);
    }
    function pvSetFitMode(mode) {
        const ui = pvActiveUi;
        if (!ui || !ui.blobUrl) return;
        // The last mode used becomes the new default, so the setting and the
        // viewer stay in agreement.
        const s = loadViewerSettings();
        s.view = mode === 'FitH' ? 'FitH' : 'Fit';
        saveViewerSettings(s);
        if (ui.viewer) {
            ui.viewer.setMode(s.view);
            pvMarkFitButtons(ui, s.view);
        } else {
            pvLoadFrame(ui, s.view);
        }
    }
    function pvZoom(factor) {
        if (pvActiveUi && pvActiveUi.viewer) pvActiveUi.viewer.zoomBy(factor);
    }
    //////////////////////////////////////////////////////////////////////
    // PDF.js viewer engine
    //////////////////////////////////////////////////////////////////////
    // PDF.js itself is loaded by the @require line in the script header (a
    // pinned cdnjs version). If it isn't available for any reason - blocked,
    // an AMD loader on the page swallowed it, etc. - everything silently
    // falls back to the browser's built-in viewer.
    const PV_PDFJS_BASE = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/';
    let pvWorkerReady = null;
    function pvPdfJsAvailable() {
        return typeof window.pdfjsLib !== 'undefined' && window.pdfjsLib && typeof window.pdfjsLib.getDocument === 'function';
    }
    // The PDF.js worker must be same-origin, so fetch it once and run it
    // from a blob: URL. If that fetch is blocked, point at the CDN URL and
    // let PDF.js fall back to its own main-thread mode.
    function pvEnsureWorker() {
        if (pvWorkerReady) return pvWorkerReady;
        pvWorkerReady = (async function () {
            const lib = window.pdfjsLib;
            if (lib.GlobalWorkerOptions.workerSrc) return;
            const workerUrl = PV_PDFJS_BASE + 'pdf.worker.min.js';
            try {
                const resp = await fetch(workerUrl);
                if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
                const text = await resp.text();
                lib.GlobalWorkerOptions.workerSrc = URL.createObjectURL(new Blob([text], { type: 'text/javascript' }));
            } catch (err) {
                console.warn('SDx QoL: could not load PDF.js worker as a blob, using CDN URL', err);
                lib.GlobalWorkerOptions.workerSrc = workerUrl;
            }
        })();
        return pvWorkerReady;
    }
    // Builds a scrollable, lazily-rendered viewer for one PDF inside
    // ui.body. Pages are drawn only when scrolled near, and re-drawn when
    // the fit mode, zoom, or window size changes.
    async function pvCreatePdfJsViewer(ui, blob, initialMode) {
        const lib = window.pdfjsLib;
        await pvEnsureWorker();
        const data = new Uint8Array(await blob.arrayBuffer());
        const doc = await lib.getDocument({
            data,
            cMapUrl: PV_PDFJS_BASE + 'cmaps/',
            cMapPacked: true,
            standardFontDataUrl: PV_PDFJS_BASE + 'standard_fonts/'
        }).promise;
        let destroyed = false;
        let gen = 0;
        let mode = initialMode === 'FitH' ? 'FitH' : 'Fit';
        let zoom = 1;
        let renderChain = Promise.resolve();
        let scroll = null;
        let io = null;
        let ro = null;
        try {
            const firstPage = await doc.getPage(1);
            const baseVp = firstPage.getViewport({ scale: 1 });
            scroll = document.createElement('div');
            scroll.className = 'sdx-qol-pv-scroll';
            const wrappers = [];
            for (let i = 1; i <= doc.numPages; i++) {
                const el = document.createElement('div');
                el.className = 'sdx-qol-pv-page';
                el.dataset.page = String(i);
                scroll.appendChild(el);
                wrappers.push({
                    el,
                    rendered: false,
                    task: null,
                    textTask: null,
                    textPromise: null,
                    textStrs: [],
                    textDivs: [],
                    ready: Promise.resolve(),
                    resolveReady: null
                });
            }
            // ---- search state / helpers ----
            let searchState = { query: '', hits: [], index: -1, token: 0 };
            // Highlights are drawn as separate overlay boxes sized to just the
            // matched characters (measured with a DOM Range over the text
            // layer), not by tinting the whole text run. CAD PDFs often store
            // a long run of text as one item, so tinting the run put the
            // highlight far from the word that actually matched.
            function getOverlay(entry) {
                let overlay = entry.el.querySelector('.sdx-qol-pv-hl');
                if (!overlay) {
                    overlay = document.createElement('div');
                    overlay.className = 'sdx-qol-pv-hl';
                    entry.el.appendChild(overlay);
                }
                return overlay;
            }
            function addMatchBoxes(entry, overlay, textDiv, query, isCurrent) {
                const node = textDiv.firstChild;
                if (!node || node.nodeType !== 3) return;
                const text = String(node.nodeValue).toLowerCase();
                const wrapRect = entry.el.getBoundingClientRect();
                let from = 0;
                let idx;
                while ((idx = text.indexOf(query, from)) !== -1) {
                    try {
                        const range = document.createRange();
                        range.setStart(node, idx);
                        range.setEnd(node, Math.min(node.nodeValue.length, idx + query.length));
                        for (const r of range.getClientRects()) {
                            if (r.width <= 0 || r.height <= 0) continue;
                            const box = document.createElement('div');
                            box.className = isCurrent ? 'sdx-qol-pv-hl-box sdx-qol-pv-hl-current' : 'sdx-qol-pv-hl-box';
                            box.style.left = `${r.left - wrapRect.left}px`;
                            box.style.top = `${r.top - wrapRect.top}px`;
                            box.style.width = `${r.width}px`;
                            box.style.height = `${r.height}px`;
                            overlay.appendChild(box);
                        }
                    } catch (err) { /* ignore a bad range */ }
                    from = idx + Math.max(1, query.length);
                }
            }
            // Redraws this page's highlight boxes. currentRun = index (within
            // textStrs) of the run holding the active match, or -1.
            function applyHighlights(entry, currentRun) {
                const overlay = getOverlay(entry);
                overlay.textContent = '';
                entry.currentRun = typeof currentRun === 'number' ? currentRun : -1;
                const q = searchState.query;
                if (!q) return;
                entry.textStrs.forEach((s, i) => {
                    const d = entry.textDivs[i];
                    if (!d || !String(s).toLowerCase().includes(q)) return;
                    addMatchBoxes(entry, overlay, d, q, i === entry.currentRun);
                });
            }
            function markCurrentHit() {
                // Drop the "current" colour from any other page first.
                wrappers.forEach(other => {
                    if (other.currentRun !== undefined && other.currentRun >= 0) applyHighlights(other, -1);
                });
                const hit = searchState.hits[searchState.index];
                if (!hit) return;
                const entry = wrappers[hit.page];
                let n = 0;
                for (let i = 0; i < entry.textStrs.length; i++) {
                    if (String(entry.textStrs[i]).toLowerCase().includes(searchState.query)) {
                        if (n === hit.k) {
                            applyHighlights(entry, i);
                            const box = entry.el.querySelector('.sdx-qol-pv-hl-current');
                            if (box) {
                                try { box.scrollIntoView({ block: 'center', inline: 'nearest' }); } catch (err) { /* ignore */ }
                            }
                            break;
                        }
                        n++;
                    }
                }
            }
            ui.body.appendChild(scroll);
            function scaleFor(w, h) {
                const cw = Math.max(50, scroll.clientWidth - 24);
                const ch = Math.max(50, scroll.clientHeight - 24);
                const fit = mode === 'FitH' ? cw / w : Math.min(cw / w, ch / h);
                return fit * zoom;
            }
            async function renderPage(entry, index, myGen) {
                const done = entry.resolveReady;
                try {
                    await renderPageInner(entry, index, myGen);
                } finally {
                    if (done) done();
                }
            }
            async function renderPageInner(entry, index, myGen) {
                if (destroyed || myGen !== gen || entry.rendered) return;
                const page = await doc.getPage(index + 1);
                if (destroyed || myGen !== gen) return;
                const base = page.getViewport({ scale: 1 });
                const vp = page.getViewport({ scale: scaleFor(base.width, base.height) });
                let outScale = window.devicePixelRatio || 1;
                // Cap canvas size so huge drawings at high zoom can't exhaust memory.
                if (vp.width * vp.height * outScale * outScale > 16e6) {
                    outScale = Math.max(0.5, Math.sqrt(16e6 / (vp.width * vp.height)));
                }
                const canvas = document.createElement('canvas');
                canvas.width = Math.max(1, Math.floor(vp.width * outScale));
                canvas.height = Math.max(1, Math.floor(vp.height * outScale));
                canvas.style.width = `${Math.floor(vp.width)}px`;
                canvas.style.height = `${Math.floor(vp.height)}px`;
                canvas.style.display = 'block';
                entry.el.style.width = canvas.style.width;
                entry.el.style.height = canvas.style.height;
                entry.rendered = true;
                const task = page.render({
                    canvasContext: canvas.getContext('2d'),
                    viewport: vp,
                    transform: outScale !== 1 ? [outScale, 0, 0, outScale, 0, 0] : null
                });
                entry.task = task;
                try {
                    await task.promise;
                    if (destroyed || myGen !== gen) return;
                    entry.el.appendChild(canvas);
                    // Selectable/searchable text on top of the canvas. Failure
                    // here only costs select/search for this page.
                    try {
                        const textDiv = document.createElement('div');
                        // 'textLayer' is the class PDF.js itself expects on this container.
                        textDiv.className = 'textLayer sdx-qol-pv-text';
                        textDiv.style.setProperty('--scale-factor', String(vp.scale));
                        entry.el.appendChild(textDiv);
                        entry.textStrs = [];
                        entry.textDivs = [];
                        const textTask = lib.renderTextLayer({
                            textContentSource: page.streamTextContent(),
                            container: textDiv,
                            viewport: vp,
                            textDivs: entry.textDivs,
                            textContentItemsStr: entry.textStrs
                        });
                        entry.textTask = textTask;
                        entry.textPromise = textTask.promise
                            .then(() => {
                                if (!destroyed && myGen === gen) applyHighlights(entry);
                            })
                            .catch(() => {});
                    } catch (textErr) {
                        console.warn('SDx QoL: PDF.js text layer failed for a page', textErr);
                    }
                } catch (err) {
                    if (!err || err.name !== 'RenderingCancelledException') {
                        console.warn('SDx QoL: PDF.js page render failed', err);
                    }
                } finally {
                    entry.task = null;
                }
            }
            io = new IntersectionObserver(function (items) {
                items.forEach(item => {
                    if (!item.isIntersecting) return;
                    const index = Number(item.target.dataset.page) - 1;
                    const entry = wrappers[index];
                    const myGen = gen;
                    renderChain = renderChain.then(() => renderPage(entry, index, myGen)).catch(() => {});
                });
            }, { root: scroll, rootMargin: '300px 0px' });
            function updatePageLabel() {
                if (destroyed) return;
                const sr = scroll.getBoundingClientRect();
                const mid = sr.top + sr.height / 2;
                let current = 1;
                for (let i = 0; i < wrappers.length; i++) {
                    if (wrappers[i].el.getBoundingClientRect().top <= mid) current = i + 1;
                    else break;
                }
                ui.pageEl.textContent = `Page ${current} / ${doc.numPages}`;
            }
            function layout() {
                gen++;
                const s = scaleFor(baseVp.width, baseVp.height);
                wrappers.forEach(entry => {
                    if (entry.task) {
                        try { entry.task.cancel(); } catch (err) { /* ignore */ }
                    }
                    if (entry.textTask) {
                        try { entry.textTask.cancel(); } catch (err) { /* ignore */ }
                    }
                    entry.rendered = false;
                    entry.textTask = null;
                    entry.textPromise = null;
                    entry.textStrs = [];
                    entry.textDivs = [];
                    entry.el.textContent = ''; // removes canvas + text layer
                    // Release anyone still waiting on the previous render.
                    if (entry.resolveReady) entry.resolveReady();
                    entry.ready = new Promise(resolve => { entry.resolveReady = resolve; });
                    entry.el.style.width = `${Math.floor(baseVp.width * s)}px`;
                    entry.el.style.height = `${Math.floor(baseVp.height * s)}px`;
                });
                io.disconnect();
                wrappers.forEach(entry => io.observe(entry.el));
                updatePageLabel();
            }
            let scrollQueued = false;
            scroll.addEventListener('scroll', function () {
                if (scrollQueued) return;
                scrollQueued = true;
                requestAnimationFrame(function () {
                    scrollQueued = false;
                    updatePageLabel();
                });
            });
            let lastW = 0;
            let lastH = 0;
            let resizeTimer = null;
            ro = new ResizeObserver(function () {
                if (destroyed) return;
                const w = scroll.clientWidth;
                const h = scroll.clientHeight;
                if (w === lastW && h === lastH) return;
                const first = lastW === 0 && lastH === 0;
                lastW = w;
                lastH = h;
                if (first) return;
                clearTimeout(resizeTimer);
                resizeTimer = setTimeout(layout, 150);
            });
            ro.observe(scroll);
            layout();
            return {
                setMode(newMode) {
                    mode = newMode === 'FitH' ? 'FitH' : 'Fit';
                    zoom = 1;
                    layout();
                    scroll.scrollTop = 0;
                },
                zoomBy(factor) {
                    zoom = Math.min(8, Math.max(0.25, zoom * factor));
                    layout();
                },
                // Find text. A new query jumps to the first match; repeating the
                // same query steps forward (dir = 1) or back (dir = -1).
                async search(rawQuery, dir) {
                    const q = String(rawQuery || '').trim().toLowerCase();
                    if (!q) {
                        searchState = { query: '', hits: [], index: -1, token: searchState.token + 1 };
                        wrappers.forEach(e => applyHighlights(e));
                        markCurrentHit();
                        ui.searchCount.textContent = '';
                        return;
                    }
                    let nextIndex;
                    if (q !== searchState.query) {
                        const token = searchState.token + 1;
                        searchState = { query: q, hits: [], index: -1, token };
                        wrappers.forEach(e => applyHighlights(e));
                        const hits = [];
                        for (let p = 0; p < doc.numPages; p++) {
                            if (destroyed || searchState.token !== token) return;
                            ui.searchCount.textContent = `Searching ${p + 1}/${doc.numPages}...`;
                            const page = await doc.getPage(p + 1);
                            const content = await page.getTextContent();
                            let k = 0;
                            content.items.forEach(item => {
                                if (typeof item.str === 'string' && item.str.toLowerCase().includes(q)) {
                                    hits.push({ page: p, k });
                                    k++;
                                }
                            });
                        }
                        if (destroyed || searchState.token !== token) return;
                        searchState.hits = hits;
                        if (hits.length === 0) {
                            ui.searchCount.textContent = 'No matches';
                            return;
                        }
                        nextIndex = 0;
                    } else {
                        const total = searchState.hits.length;
                        if (total === 0) return;
                        nextIndex = (searchState.index + (dir < 0 ? -1 : 1) + total) % total;
                    }
                    searchState.index = nextIndex;
                    const hit = searchState.hits[nextIndex];
                    const entry = wrappers[hit.page];
                    ui.searchCount.textContent = `${nextIndex + 1} of ${searchState.hits.length}`;
                    entry.el.scrollIntoView({ block: 'start' });
                    // The scroll makes the page render; wait for it and its text layer.
                    await entry.ready;
                    if (entry.textPromise) await entry.textPromise;
                    if (destroyed || searchState.index !== nextIndex) return;
                    applyHighlights(entry);
                    markCurrentHit();
                    // The text layer can settle a moment after render; redraw once more.
                    setTimeout(function () {
                        if (!destroyed && searchState.index === nextIndex) markCurrentHit();
                    }, 250);
                },
                destroy() {
                    if (destroyed) return;
                    destroyed = true;
                    gen++;
                    searchState.token++;
                    try { io.disconnect(); } catch (err) { /* ignore */ }
                    try { ro.disconnect(); } catch (err) { /* ignore */ }
                    wrappers.forEach(entry => {
                        if (entry.task) {
                            try { entry.task.cancel(); } catch (err) { /* ignore */ }
                        }
                    });
                    scroll.remove();
                    try { doc.destroy(); } catch (err) { /* ignore */ }
                }
            };
        } catch (err) {
            destroyed = true;
            if (scroll) scroll.remove();
            try { doc.destroy(); } catch (e2) { /* ignore */ }
            throw err;
        }
    }
    // Saves the already-downloaded PDF under its original file name.
    function pvDownload(blobUrl, fileName) {
        const a = document.createElement('a');
        a.href = blobUrl;
        a.download = /\.pdf$/i.test(fileName || '') ? fileName : `${fileName || 'document'}.pdf`;
        document.body.appendChild(a);
        a.click();
        a.remove();
    }
    // Prints through a tiny off-screen iframe holding the PDF so the browser's
    // own print dialog handles it. If the browser blocks that, the PDF opens
    // in a new tab instead (its built-in viewer has a print button).
    function pvPrint(blobUrl) {
        const frame = document.createElement('iframe');
        frame.style.cssText = 'position:fixed;right:0;bottom:0;width:1px;height:1px;opacity:0;border:0;pointer-events:none;';
        frame.src = blobUrl;
        frame.onload = function () {
            // Give the browser's PDF viewer a moment to finish loading.
            setTimeout(function () {
                try {
                    frame.contentWindow.focus();
                    frame.contentWindow.print();
                } catch (err) {
                    console.warn('SDx QoL: in-page print blocked, opening PDF in a new tab', err);
                    window.open(blobUrl, '_blank', 'noopener');
                }
                setTimeout(function () { frame.remove(); }, 120000);
            }, 600);
        };
        document.body.appendChild(frame);
    }
    async function pvShowViewer(ui, blobUrl, blob, fileName) {
        ui.blobUrl = blobUrl;
        ui.titleEl.textContent = fileName;
        ui.openBtn.style.display = '';
        ui.openBtn.onclick = function () {
            window.open(blobUrl, '_blank', 'noopener');
        };
        ui.fitPageBtn.style.display = '';
        ui.fitWidthBtn.style.display = '';
        ui.downloadBtn.style.display = '';
        ui.downloadBtn.onclick = function () { pvDownload(blobUrl, fileName); };
        ui.printBtn.style.display = '';
        ui.printBtn.onclick = function () { pvPrint(blobUrl); };
        const settings = loadViewerSettings();
        if (settings.engine === 'pdfjs' && pvPdfJsAvailable() && blob) {
            try {
                ui.status.textContent = 'Rendering PDF...';
                const viewer = await pvCreatePdfJsViewer(ui, blob, settings.view);
                if (pvActiveUi !== ui) {
                    viewer.destroy(); // viewer was closed/replaced while we were loading
                    return;
                }
                ui.viewer = viewer;
                ui.status.remove();
                ui.pageEl.style.display = '';
                ui.searchWrap.style.display = '';
                ui.zoomOutBtn.style.display = '';
                ui.zoomInBtn.style.display = '';
                pvMarkFitButtons(ui, settings.view);
                return;
            } catch (err) {
                console.warn('SDx QoL: PDF.js viewer failed - falling back to the browser viewer', err);
            }
        }
        if (pvActiveUi !== ui) return;
        ui.status.remove();
        pvLoadFrame(ui, settings.view);
    }
    async function pvFetchJson(url, token, config, options) {
        async function attempt(useToken) {
            const headers = Object.assign({
                Accept: 'application/json, text/plain, */*',
                Authorization: `Bearer ${useToken}`
            }, (options && options.headers) || {});
            if (config) headers.SPFConfigUID = config;
            return fetch(url, Object.assign({}, options || {}, { headers }));
        }
        let resp = await attempt(token);
        if (resp.status === 401) {
            // Token was rejected. Re-read the freshest one we can see and try once more.
            const fresh = getSdxAuthToken();
            if (fresh && fresh !== token) {
                resp = await attempt(fresh);
            }
        }
        if (resp.status === 401) {
            throw new Error('HTTP 401 - your SDx session may have expired; reload the page and try again');
        }
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        return resp.json();
    }
    async function openPdfPreview(obid, name, config) {
        const ui = buildPreviewModal(name);
        pvCurrentObid = obid;
        pvLastObid = obid;
        pvRefreshActiveHighlight();
        pvUpdateNav(ui, obid);
        const myRequest = pvRequestCounter;
        const stale = () => myRequest !== pvRequestCounter;
        const fail = msg => {
            if (stale()) return;
            ui.status.textContent = msg;
        };
        ui.status.textContent = 'Preparing preview...';
        const token = getSdxAuthToken();
        if (!token) {
            fail('Could not read your SDx session token. Try reloading the page.');
            return;
        }
        try {
            // Step 1: document -> viewable file OBID
            const compUrl = `${getSdaApiBase()}/Objects('${encodeURIComponent(obid)}')/SPFFileComposition_21?$filter=${encodeURIComponent('SPFViewInd eq true')}&$top=1&$count=true`;
            const comp = await pvFetchJson(compUrl, token, config, { method: 'GET' });
            if (stale()) return;
            const fileItem = comp && Array.isArray(comp.value) ? comp.value[0] : null;
            if (!fileItem || !fileItem.OBID) {
                fail('This item has no viewable file to preview.');
                return;
            }
            const fileObid = fileItem.OBID;
            const fileName = normalizeText(fileItem.Name || fileItem.CI_Name || name);
            if (!/\.pdf$/i.test(fileName)) {
                fail(`Preview supports PDF files only (this file is "${fileName}"). Use the filename link to open it normally.`);
                return;
            }
            // Cached from an earlier preview this session: instant.
            const cached = pvBlobCache.get(fileObid);
            if (cached) {
                pvActiveBlobUrl = cached.blobUrl;
                // Mark as most recently used.
                pvBlobCache.delete(fileObid);
                pvBlobCache.set(fileObid, cached);
                await pvShowViewer(ui, cached.blobUrl, cached.blob, cached.fileName);
                return;
            }
            // Step 2: file OBID -> PDF URI
            ui.status.textContent = 'Requesting file from SDx...';
            const uriUrl = `${getSdaApiBase()}/Files('${encodeURIComponent(fileObid)}')/Intergraph.SPF.Server.API.Model.RetrieveFileUris`;
            const uriData = await pvFetchJson(uriUrl, token, config, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ purposes: ['Markup'], downloadFile: false })
            });
            if (stale()) return;
            const info = uriData && Array.isArray(uriData.value) ? uriData.value[0] : null;
            if (!info || !info.Uri) {
                fail('SDx did not return a file location for this item.');
                return;
            }
            // Step 3: fetch the PDF (session cookie, same as the native new-tab
            // open) and show it from a blob: URL.
            ui.status.textContent = 'Loading PDF...';
            let resp = await fetch(info.Uri, { method: 'GET', credentials: 'include' });
            if (!resp.ok) {
                resp = await fetch(info.Uri, {
                    method: 'GET',
                    credentials: 'include',
                    headers: { Authorization: `Bearer ${token}` }
                });
            }
            if (stale()) return;
            if (!resp.ok) throw new Error(`HTTP ${resp.status} fetching PDF`);
            const raw = await resp.blob();
            if (stale()) return;
            const pdfBlob = new Blob([raw], { type: 'application/pdf' });
            const blobUrl = URL.createObjectURL(pdfBlob);
            // Mark as active BEFORE remembering so a cache limit of 0 can't
            // evict (and revoke) the PDF we're about to display.
            pvActiveBlobUrl = blobUrl;
            pvRememberBlob(fileObid, blobUrl, fileName, raw.size, pdfBlob);
            await pvShowViewer(ui, blobUrl, pdfBlob, fileName);
        } catch (err) {
            console.warn('SDx QoL: PDF preview failed', err);
            fail(`Preview failed (${err && err.message ? err.message : 'unknown error'}). Use the filename link to open the file normally.`);
        }
    }
    document.addEventListener('click', function (e) {
        const btn = e.target && e.target.closest ? e.target.closest('.' + PV_BTN_CLASS) : null;
        if (!btn) return;
        // Keep the click from selecting the row or following the neighbouring link.
        e.preventDefault();
        e.stopPropagation();
        openPdfPreview(btn.dataset.obid, btn.dataset.name, btn.dataset.config || null);
    }, true);
    //////////////////////////////////////////////////////////////////////
    // MODULE 4
    // PAGE REFRESH HANDLER
    //////////////////////////////////////////////////////////////////////
    // Restores this list's last-saved rows-per-page setting automatically.
    // Guarded by lastAppliedPageSize so it only ever runs once per navigation
    // (applySdxPageSize itself sets that on success) - if the grid/pager
    // isn't rendered yet, this simply no-ops and retries on the next refresh
    // cycle rather than erroring.
    function maybeAutoApplyPageSize() {
        if (lastAppliedPageSize !== null) return;
        const settings = loadSettings();
        const desired = Math.max(1, Number(settings.pageSize) || 100);
        const pagerEl = getLikelyMainPager();
        if (!pagerEl) return;
        // The early DataSource hook (Module 0) may already have created this
        // list at the right size - in that case there is nothing to re-apply
        // (and no second load). If it guessed wrong (e.g. the page title
        // wasn't settled yet), this corrects it, including back to 100.
        let currentSize = null;
        try {
            const gridWidget = findKendoGridFromPager(pagerEl);
            if (gridWidget && gridWidget.dataSource && typeof gridWidget.dataSource.pageSize === 'function') {
                currentSize = Number(gridWidget.dataSource.pageSize()) || null;
            }
        } catch (err) {
            currentSize = null;
        }
        if (currentSize === desired) {
            lastAppliedPageSize = desired;
            return;
        }
        if (currentSize === null && desired === 100) return; // can't tell; matches SDx default
        const throwawayStatus = document.createElement('div');
        applySdxPageSize(desired, throwawayStatus);
    }
    function applyGridCustomizations() {
        // Column hiding is allowed to auto-apply.
        applyHiddenColumns();
        applyTruncationTooltips();
        // No-ops on any page other than the To Do List.
        applyRowHighlighting();
        maybeSuppressStepDetailsPanel();
        injectDlFilesButton();
        // Icons are added only after the grid has been quiet for a moment, so
        // we never inject into intermediate renders that SDx is about to
        // throw away (and never add DOM churn mid-render).
        schedulePreviewInjection();
        maybeAutoApplyPageSize();
    }
    function refreshQoL() {
        injectStyles();
        injectManagerButton();
        injectSessionButton();
        applyGridCustomizations();
        if (location.href !== lastUrl) {
            lastUrl = location.href;
            closeManagerMenu();
            // Reset so maybeAutoApplyPageSize() restores this new list's own
            // saved page size (if any) once its grid/pager has rendered.
            lastAppliedPageSize = null;
            setTimeout(function () {
                injectManagerButton();
                injectSessionButton();
                applyGridCustomizations();
            }, 1200);
        }
    }
    setTimeout(refreshQoL, 1500);
    // Kept as a low-cost safety net; the MutationObserver below handles the
    // common case of "grid just re-rendered" far faster than a 3s poll would.
    setInterval(refreshQoL, 3000);
    const debouncedRefresh = debounce(refreshQoL, 150);
    // True if any mutation added table/grid row content (as opposed to, say,
    // a tooltip or our own button being inserted).
    function mutationsAddedGridRows(records) {
        for (const record of records) {
            for (const node of record.addedNodes) {
                if (node.nodeType !== 1) continue;
                const tag = node.tagName;
                if (tag === 'TR' || tag === 'TD' || tag === 'TBODY' || tag === 'TABLE') return true;
                if (node.querySelector && node.querySelector('tr')) return true;
            }
        }
        return false;
    }
    const gridChangeObserver = new MutationObserver(function (records) {
        // Hide configured columns IMMEDIATELY. MutationObserver callbacks run
        // before the browser paints, so freshly rendered rows never appear
        // with their hidden columns visible. This only toggles classes
        // (attribute changes), which this childList-only observer ignores,
        // so it cannot loop.
        if (mutationsAddedGridRows(records)) {
            try { applyHiddenColumns(); } catch (err) { /* fall through to debounced pass */ }
            // Preview icons go in right away too, so they appear with the
            // rows instead of trailing in afterwards. (The earlier 500ms
            // delay was meant to dodge mid-render churn, but that churn was
            // really the page-size double-load, which the early hook fixed.)
            // Rows that aren't data-bound yet are skipped and retried below.
            try { injectPreviewButtons(); } catch (err) { /* debounced pass will retry */ }
        }
        // Everything else (tooltips, highlighting, buttons, page size) stays debounced.
        debouncedRefresh();
    });
    function startGridChangeObserver() {
        if (!document.body) {
            setTimeout(startGridChangeObserver, 50);
            return;
        }
        gridChangeObserver.observe(document.body, { childList: true, subtree: true });
    }
    startGridChangeObserver();
})();
