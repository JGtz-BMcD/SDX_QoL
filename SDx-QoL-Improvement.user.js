// ==UserScript==
// @name         SDx QoL Improvement
// @namespace    https://burnsmcd.com
// @version      1.8
// @description  SDx quality-of-life improvements: shift-select, keyboard shortcuts, truncated-cell tooltips, column manager, per-list remembered page size (applied before the first load), To Do List row highlighting, optional auto-close of the To Do List step-details panel, bulk file download (bypasses SDx's 100-file dialog limit), in-page PDF preview with next/previous, search, zoom, fit, print and download, work package indexing that turns document numbers on sheets into clickable links, and a typed smart filter for any list.
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
    console.log(`${SCRIPT_NAME} v1.8 loaded`);
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
    // Remembers the last few OData list reads (URL + headers) SDx itself made, so the smart filter can ask
    // the server for the matching total and keep the pager's "of N items" correct.
    const recentReads = [];
    function noteRead(url, headers) {
        try {
            const u = String(url || '');
            if (!/[?&](?:\$|%24)top=/i.test(u) || !/\/api\/v2\//i.test(u)) return;
            recentReads.push({ url: u, headers: headers || {}, t: Date.now() });
            if (recentReads.length > 20) recentReads.shift();
        } catch (err) { /* ignore */ }
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
                    try {
                        const url = typeof input === 'string' ? input : (input && input.url);
                        const method = String((init && init.method) || (input && input.method) || 'GET').toUpperCase();
                        const hdrs = {};
                        const src = (init && init.headers) || (input && typeof input === 'object' ? input.headers : null);
                        if (src && typeof src.forEach === 'function') src.forEach((v, k) => { hdrs[k] = v; });
                        else if (src && typeof src === 'object') Object.keys(src).forEach(k => { hdrs[k] = src[k]; });
                        if (method === 'GET') noteRead(url, hdrs);
                    } catch (err) { /* ignore */ }
                    return originalFetch.apply(this, arguments);
                };
            }
            const originalOpen = XMLHttpRequest.prototype.open;
            XMLHttpRequest.prototype.open = function (method, url) {
                try { this.__sdxQolReq = { method: String(method).toUpperCase(), url: String(url), headers: {} }; } catch (err) { /* ignore */ }
                return originalOpen.apply(this, arguments);
            };
            const originalSend = XMLHttpRequest.prototype.send;
            XMLHttpRequest.prototype.send = function () {
                try {
                    const r = this.__sdxQolReq;
                    if (r && r.method === 'GET') noteRead(r.url, r.headers);
                } catch (err) { /* ignore */ }
                return originalSend.apply(this, arguments);
            };
            const originalSetRequestHeader = XMLHttpRequest.prototype.setRequestHeader;
            XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
                try {
                    if (String(name).toLowerCase() === 'authorization') rememberAuthToken(value);
                    if (this.__sdxQolReq) this.__sdxQolReq.headers[name] = value;
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
            #${SF_WRAP_ID} {
                display: inline-flex !important;
                align-items: center !important;
                gap: 4px !important;
                margin-right: 10px !important;
                vertical-align: middle !important;
            }
            #${SF_WRAP_ID} input {
                height: 32px !important;
                width: 300px !important;
                box-sizing: border-box !important;
                padding: 0 12px !important;
                border: 2px solid #0078d4 !important;
                border-radius: 6px !important;
                font: 13px Arial, sans-serif !important;
                background: #eaf4fd !important;
                color: #003a6c !important;
                box-shadow: 0 0 0 3px rgba(0,120,212,0.20), 0 1px 3px rgba(0,0,0,0.20) !important;
            }
            #${SF_WRAP_ID} input::placeholder { color: #3a7fb8 !important; opacity: 1 !important; }
            #${SF_WRAP_ID} input:focus { background: #ffffff !important; outline: none !important; box-shadow: 0 0 0 4px rgba(0,120,212,0.40), 0 1px 3px rgba(0,0,0,0.25) !important; }
            #${SF_WRAP_ID} .sdx-qol-sf-badge {
                height: 24px; padding: 0 8px; border: 0; border-radius: 12px;
                background: #0078d4; color: #fff; font: 600 12px Arial, sans-serif; cursor: pointer;
            }
            #${SF_WRAP_ID} .sdx-qol-sf-clear {
                height: 32px; padding: 0 12px; border: 1px solid #a4262c; border-radius: 6px; background: #d13438;
                color: #ffffff; font: 600 12px Arial, sans-serif; cursor: pointer;
            }
            #${SF_WRAP_ID} .sdx-qol-sf-clear:hover { background: #a4262c; }
            #${SF_WRAP_ID} .sdx-qol-sf-apply {
                height: 32px; padding: 0 14px; border: 1px solid #005a9e; border-radius: 6px; background: #0078d4;
                color: #ffffff; font: 600 12px Arial, sans-serif; cursor: pointer;
            }
            #${SF_WRAP_ID} .sdx-qol-sf-apply:hover { background: #106ebe; }
            #${SF_PANEL_ID} {
                position: fixed; z-index: 2147483000; width: 440px; max-width: calc(100vw - 16px);
                background: #fff; color: #201f1e; border: 1px solid #c8c6c4; border-radius: 6px;
                box-shadow: 0 6px 20px rgba(0,0,0,0.25); padding: 10px; font: 13px Arial, sans-serif;
            }
            #${SF_PANEL_ID} .sdx-qol-sf-title { font-weight: 600; margin-bottom: 8px; }
            #${SF_PANEL_ID} .sdx-qol-sf-chip { display: flex; align-items: center; gap: 6px; padding: 4px 0; border-top: 1px solid #edebe9; }
            #${SF_PANEL_ID} .sdx-qol-sf-chip-label { flex: 1; min-width: 0; overflow-wrap: anywhere; }
            #${SF_PANEL_ID} select { max-width: 130px; height: 26px; font: 12px Arial, sans-serif; }
            #${SF_PANEL_ID} button { cursor: pointer; border: 1px solid #c8c6c4; background: #f3f2f1; border-radius: 4px; padding: 2px 8px; }
            #${SF_PANEL_ID} .sdx-qol-sf-foot { margin-top: 8px; text-align: right; }
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
            #${WP_BTN_ID} {
                margin-left: 8px !important;
                padding: 5px 12px !important;
                border: 1px solid #0b5cad !important;
                border-radius: 4px !important;
                background: #1a73e8 !important;
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
            #${WP_BTN_ID}:hover:not(:disabled) {
                background: #0b5cad !important;
            }
            #${WP_BTN_ID}:disabled {
                opacity: 0.7 !important;
                cursor: progress !important;
            }
            .sdx-qol-pv-links {
                position: absolute !important;
                inset: 0 !important;
                pointer-events: none !important;
                overflow: hidden !important;
            }
            .sdx-qol-pv-link {
                position: absolute !important;
                pointer-events: auto !important;
                cursor: pointer !important;
                box-sizing: border-box !important;
                background: rgba(0, 190, 210, 0.15) !important;
                border: 1px solid rgba(0, 160, 185, 0.9) !important;
                border-radius: 2px !important;
            }
            .sdx-qol-pv-link:hover {
                background: rgba(0, 190, 210, 0.38) !important;
            }
            .sdx-qol-pv-link-range {
                border-style: dashed !important;
            }
            .sdx-qol-pv-rangemenu {
                position: fixed !important;
                z-index: 1000001 !important;
                min-width: 260px !important;
                max-width: 480px !important;
                max-height: 320px !important;
                overflow: auto !important;
                background: #ffffff !important;
                color: #222222 !important;
                border: 1px solid #999999 !important;
                border-radius: 4px !important;
                box-shadow: 0 4px 16px rgba(0,0,0,0.35) !important;
                font: 12px Arial, sans-serif !important;
            }
            .sdx-qol-pv-rangemenu-item {
                padding: 5px 10px !important;
                cursor: pointer !important;
                border-bottom: 1px solid #eeeeee !important;
            }
            .sdx-qol-pv-rangemenu-item:hover {
                background: #dbe8fa !important;
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
    function formatCacheSize(bytes) {
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
        // --- Document-number links + work package indexes ---
        const linksSection = document.createElement('div');
        linksSection.className = 'sdx-section';
        const linksLabel = document.createElement('label');
        linksLabel.className = 'sdx-item';
        const linksCb = document.createElement('input');
        linksCb.type = 'checkbox';
        linksCb.checked = settings.docLinks;
        const linksSpan = document.createElement('span');
        linksSpan.textContent = 'Link document numbers to other sheets in the same indexed work package';
        linksCb.addEventListener('change', function () {
            const s = loadViewerSettings();
            s.docLinks = linksCb.checked;
            saveViewerSettings(s);
        });
        linksLabel.appendChild(linksCb);
        linksLabel.appendChild(linksSpan);
        linksSection.appendChild(linksLabel);
        const linksNote = document.createElement('div');
        linksNote.className = 'sdx-note';
        linksNote.textContent = 'Enhanced viewer only. Open a work package\'s documents list and click "WP Index" to index it; applies the next time a sheet is opened.';
        linksSection.appendChild(linksNote);
        const wpIndex = loadWpIndex();
        const wpNames = Object.keys(wpIndex).sort();
        const wpList = document.createElement('div');
        wpList.style.marginTop = '6px';
        if (!wpNames.length) {
            const none = document.createElement('div');
            none.className = 'sdx-note';
            none.textContent = 'No work packages indexed yet.';
            wpList.appendChild(none);
        } else {
            wpNames.forEach(name => {
                const snap = wpIndex[name];
                const row = document.createElement('div');
                row.style.cssText = 'display:flex;align-items:center;gap:6px;margin:2px 0;font-size:12px;';
                const text = document.createElement('span');
                text.style.flex = '1 1 auto';
                text.textContent = `${name} - ${(snap.docs || []).length} docs, ${new Date(snap.savedAt || 0).toLocaleDateString()}`;
                const remove = document.createElement('button');
                remove.type = 'button';
                remove.textContent = 'Remove';
                remove.addEventListener('click', function () {
                    const current = loadWpIndex();
                    delete current[name];
                    saveWpIndex(current);
                    row.remove();
                    injectWpIndexButton();
                });
                row.appendChild(text);
                row.appendChild(remove);
                wpList.appendChild(row);
            });
        }
        linksSection.appendChild(wpList);
        menu.appendChild(linksSection);
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
            stats.textContent = `Currently cached: ${st.count} PDF${st.count === 1 ? '' : 's'} (${formatCacheSize(st.bytes)})`;
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
    // MODULE 3H
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
        return { enabled: true, view: 'Fit', cacheMax: 5, engine: 'pdfjs', docLinks: true };
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
                engine: parsed.engine === 'native' ? 'native' : 'pdfjs',
                docLinks: typeof parsed.docLinks === 'boolean' ? parsed.docLinks : defaults.docLinks
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
                engine: settings.engine === 'native' ? 'native' : 'pdfjs',
                docLinks: settings.docLinks !== false
            }));
        } catch (err) {
            console.warn('SDx QoL: could not save viewer settings', err);
        }
    }
    const pvBlobCache = new Map(); // fileObid -> { blobUrl, fileName, size }
    let pvRequestCounter = 0;
    let pvCurrentObid = null;
    let pvCurrentMeta = null; // { obid, name, config } of the document on screen
    const pvHistory = []; // documents we followed a link away from (for Back)
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
    // Closing the viewer for good also forgets the "Back" trail from
    // link-to-link navigation.
    function closePreviewModal() {
        pvHistory.length = 0;
        pvTeardownModal();
    }
    function pvTeardownModal() {
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
        // Tear down the previous viewer WITHOUT clearing the Back trail.
        pvTeardownModal();
        const modal = document.createElement('div');
        modal.id = PV_MODAL_ID;
        const backdrop = document.createElement('div');
        backdrop.className = 'sdx-qol-dl-backdrop';
        backdrop.addEventListener('click', closePreviewModal);
        const panel = document.createElement('div');
        panel.className = 'sdx-qol-pv-panel';
        const header = document.createElement('div');
        header.className = 'sdx-qol-pv-header';
        const backBtn = document.createElement('button');
        backBtn.type = 'button';
        backBtn.textContent = '← Back';
        backBtn.title = 'Return to the sheet you followed a link from';
        backBtn.style.display = 'none';
        backBtn.addEventListener('click', function () {
            const previous = pvHistory.pop();
            if (previous) openPdfPreview(previous.obid, previous.name, previous.config);
        });
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
        header.appendChild(backBtn);
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
        const ui = { titleEl, counterEl, openBtn, body, status, prevBtn, nextBtn, fitPageBtn, fitWidthBtn, pageEl, zoomOutBtn, zoomInBtn, searchWrap, searchInput, searchCount, downloadBtn, printBtn, backBtn, blobUrl: null, frame: null, viewer: null, linkCtx: null };
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
                                if (destroyed || myGen !== gen) return;
                                applyHighlights(entry);
                                // Clickable links to other sheets in the same indexed work package.
                                if (ui.linkCtx) {
                                    try { pvDrawDocLinks(entry, ui.linkCtx); } catch (linkErr) {
                                        console.warn('SDx QoL: document link overlay failed', linkErr);
                                    }
                                }
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
        pvCurrentMeta = { obid, name, config };
        pvLastObid = obid;
        ui.backBtn.style.display = pvHistory.length ? '' : 'none';
        // Document-number links (only for documents in an indexed work package).
        ui.linkCtx = pvGetLinkContext(obid, name);
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
    // MODULE 3I
    // WORK PACKAGE INDEX + DOCUMENT-NUMBER LINKS (sheet to sheet)
    //////////////////////////////////////////////////////////////////////
    // A work package's documents list is recognisable from the page URL
    // (entityType BMcD_SubContractor_Docs filtered by field WP). "WP Index"
    // saves a snapshot of that package's document numbers (one request; the
    // PDFs themselves are not opened). While viewing a sheet that belongs to a
    // snapshot in the Enhanced viewer, any COMPLETE document number found in
    // the sheet's text that is also in the same snapshot becomes a clickable
    // link. Only whole numbers are matched (short forms like "SP-300-01"
    // are NOT used - they matched the wrong sheet in testing), with an
    // optional "-NN" sheet suffix after the number, and "A THROUGH B" ranges.
    const WP_BTN_ID = 'sdx-qol-wp-index-btn';
    const WP_INDEX_KEY = `${STORAGE_PREFIX}:wpIndex`;
    let wpIndexBusy = false;
    let wpLookupCache = null; // { byId: Map, byName: Map }
    const wpLinkCtxCache = new Map(); // wpName -> context
    // Returns { wp, config, entityType } when the current page is a work
    // package's documents list, else null.
    function getWorkPackageContext() {
        try {
            const match = /queryFilter=([^;]+)/.exec(location.hash || '');
            if (!match) return null;
            const qf = JSON.parse(decodeURIComponent(match[1]));
            if (!qf || !qf.entityType) return null; // any list filtered on a WP field is treated as a work package's documents
            let wp = null;
            (function walk(node) {
                if (!node || wp) return;
                if (Array.isArray(node)) { node.forEach(walk); return; }
                if (typeof node !== 'object') return;
                if (node.field === 'WP' && node.operator === 'eq' && typeof node.value === 'string') {
                    wp = node.value;
                    return;
                }
                Object.values(node).forEach(walk);
            })(qf.filters);
            if (!wp) return null;
            return { wp, config: qf.config && qf.config.key ? qf.config.key : null, entityType: qf.entityType };
        } catch (err) {
            return null;
        }
    }
    function loadWpIndex() {
        try {
            return JSON.parse(localStorage.getItem(WP_INDEX_KEY)) || {};
        } catch (err) {
            return {};
        }
    }
    function saveWpIndex(index) {
        wpLookupCache = null;
        wpLinkCtxCache.clear();
        try {
            localStorage.setItem(WP_INDEX_KEY, JSON.stringify(index));
            return true;
        } catch (err) {
            console.warn('SDx QoL: could not save work package index', err);
            return false;
        }
    }
    function wpNameKey(name) {
        return String(name || '').replace(/^\d+_/, '').trim().toUpperCase();
    }
    function getWpLookup() {
        if (wpLookupCache) return wpLookupCache;
        const byId = new Map();
        const byName = new Map();
        const index = loadWpIndex();
        Object.keys(index).forEach(wp => {
            (index[wp].docs || []).forEach(d => {
                if (d.i && !byId.has(d.i)) byId.set(d.i, wp);
                [d.n, d.a].forEach(nm => {
                    const key = wpNameKey(nm);
                    if (key && !byName.has(key)) byName.set(key, wp);
                });
            });
        });
        wpLookupCache = { byId, byName };
        return wpLookupCache;
    }
    // "PRS-R00-SB-213" -> { prefix: "PRS-R00-SB", num: 213 }; ignores a
    // trailing 2-digit sheet suffix such as "-01". null if there's no number.
    function parseDocNumber(term) {
        const segs = String(term || '').split(/[-_. ]+/).filter(Boolean);
        let k = segs.length - 1;
        if (k >= 1 && /^\d+$/.test(segs[k]) && /^\d+$/.test(segs[k - 1])) k--;
        if (k < 0 || !/^\d+$/.test(segs[k])) return null;
        return { prefix: segs.slice(0, k).join('-').toUpperCase(), num: parseInt(segs[k], 10) };
    }
    // Builds (and caches) the matcher set for one work package.
    function buildWpLinkContext(wpName) {
        if (wpLinkCtxCache.has(wpName)) return wpLinkCtxCache.get(wpName);
        const snap = loadWpIndex()[wpName];
        if (!snap) return null;
        const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const matchers = [];
        const docs = [];
        const seenTerms = new Set();
        (snap.docs || []).forEach(d => {
            if (!d.i) return; // no id = nothing to open
            docs.push(d);
            const terms = new Set();
            [d.a, d.n].forEach(raw => {
                const t = String(raw || '').replace(/^\d+_/, '').trim();
                if (t.length >= 6) terms.add(t);
            });
            terms.forEach(term => {
                const key = term.toUpperCase();
                if (seenTerms.has(key)) return;
                seenTerms.add(key);
                const segs = term.split(/[-_. ]+/).filter(Boolean);
                if (segs.length < 2) return;
                matchers.push({
                    doc: d,
                    term,
                    lastSeg: segs[segs.length - 1].toUpperCase(),
                    parsed: parseDocNumber(term),
                    re: new RegExp('(?<![A-Z0-9])' + segs.map(esc).join('[-_. ]?') + '(?:[-_. ]\\d{2})?(?![A-Z0-9])', 'gi')
                });
            });
        });
        const ctx = { wp: wpName, config: snap.config || null, docs, matchers };
        wpLinkCtxCache.set(wpName, ctx);
        return ctx;
    }
    // Link context for the document being viewed, or null when it isn't in an
    // indexed work package (or links are switched off).
    function pvGetLinkContext(docId, docName) {
        try {
            if (!loadViewerSettings().docLinks) return null;
            const lookup = getWpLookup();
            const wp = (docId && lookup.byId.get(docId)) || lookup.byName.get(wpNameKey(docName));
            if (!wp) return null;
            const ctx = buildWpLinkContext(wp);
            return ctx && ctx.matchers.length ? { ctx, selfId: docId, selfName: wpNameKey(docName) } : null;
        } catch (err) {
            console.warn('SDx QoL: link context failed', err);
            return null;
        }
    }
    // Finds document numbers in one page's text. Returns [{start,end,doc}]
    // plus [{start,end,docs}] for "A THROUGH B" ranges.
    function pvFindDocMatches(text, linkCtx) {
        const { ctx, selfId, selfName } = linkCtx;
        const upper = text.toUpperCase();
        const raw = [];
        ctx.matchers.forEach(m => {
            if (m.doc.i === selfId) return;
            if (selfName && (wpNameKey(m.doc.n) === selfName || wpNameKey(m.doc.a) === selfName)) return;
            if (!upper.includes(m.lastSeg)) return; // cheap pre-check
            m.re.lastIndex = 0;
            let hit;
            while ((hit = m.re.exec(text)) !== null) {
                raw.push({ start: hit.index, end: hit.index + hit[0].length, doc: m.doc, parsed: m.parsed });
                if (hit[0].length === 0) m.re.lastIndex++;
            }
        });
        // Earliest first; for the same start prefer the longest. Drop overlaps.
        raw.sort((a, b) => a.start - b.start || (b.end - b.start) - (a.end - a.start));
        const matches = [];
        let lastEnd = -1;
        raw.forEach(m => {
            if (m.start >= lastEnd) {
                matches.push(m);
                lastEnd = m.end;
            }
        });
        // "PRS-COM-SB-001-01 THROUGH PRS-COM-SB-016-01"
        const ranges = [];
        for (let i = 0; i + 1 < matches.length; i++) {
            const a = matches[i];
            const b = matches[i + 1];
            if (!a.parsed || !b.parsed || a.parsed.prefix !== b.parsed.prefix) continue;
            if (!/^\s*(?:THROUGH|THRU|TO)\s*$/i.test(text.slice(a.end, b.start))) continue;
            const lo = Math.min(a.parsed.num, b.parsed.num);
            const hi = Math.max(a.parsed.num, b.parsed.num);
            const members = [];
            ctx.matchers.forEach(m => {
                if (m.parsed && m.parsed.prefix === a.parsed.prefix && m.parsed.num >= lo && m.parsed.num <= hi) {
                    if (!members.some(x => x.i === m.doc.i)) members.push(m.doc);
                }
            });
            members.sort((x, y) => (parseDocNumber(x.a || x.n).num || 0) - (parseDocNumber(y.a || y.n).num || 0));
            if (members.length > 2) ranges.push({ start: a.end, end: b.start, docs: members });
        }
        return { matches, ranges };
    }
    // Draws clickable boxes over every found document number on one rendered
    // PDF.js page. Positions come from measuring the real text-layer glyphs.
    function pvDrawDocLinks(entry, linkCtx) {
        const oldLayer = entry.el.querySelector('.sdx-qol-pv-links');
        if (oldLayer) oldLayer.remove();
        if (!entry.textStrs.length) return;
        // Concatenate the page text, remembering which text-layer element each part came from.
        let text = '';
        const parts = [];
        entry.textStrs.forEach((s, i) => {
            if (i > 0) text += ' ';
            const start = text.length;
            text += String(s);
            parts.push({ start, end: text.length, div: entry.textDivs[i] });
        });
        const found = pvFindDocMatches(text, linkCtx);
        if (!found.matches.length && !found.ranges.length) return;
        const layer = document.createElement('div');
        layer.className = 'sdx-qol-pv-links';
        entry.el.appendChild(layer);
        const wrapRect = entry.el.getBoundingClientRect();
        function addBoxes(start, end, onClick, tip, extraClass) {
            parts.forEach(part => {
                if (part.end <= start || part.start >= end || !part.div) return;
                const node = part.div.firstChild;
                if (!node || node.nodeType !== 3) return;
                const from = Math.max(start, part.start) - part.start;
                const to = Math.min(end, part.end) - part.start;
                if (to <= from) return;
                try {
                    const range = document.createRange();
                    range.setStart(node, from);
                    range.setEnd(node, Math.min(node.nodeValue.length, to));
                    for (const r of range.getClientRects()) {
                        if (r.width <= 0 || r.height <= 0) continue;
                        const box = document.createElement('div');
                        box.className = 'sdx-qol-pv-link' + (extraClass ? ' ' + extraClass : '');
                        box.style.left = `${r.left - wrapRect.left}px`;
                        box.style.top = `${r.top - wrapRect.top}px`;
                        box.style.width = `${r.width}px`;
                        box.style.height = `${r.height}px`;
                        box.title = tip;
                        box.addEventListener('click', function (e) {
                            e.preventDefault();
                            e.stopPropagation();
                            onClick(e);
                        });
                        layer.appendChild(box);
                    }
                } catch (err) { /* ignore a bad range */ }
            });
        }
        found.matches.forEach(m => {
            const label = m.doc.a || m.doc.n;
            addBoxes(m.start, m.end, function () {
                pvFollowDocLink(m.doc, linkCtx.ctx.config);
            }, `Open ${label}${m.doc.t ? ' - ' + m.doc.t : ''}`);
        });
        found.ranges.forEach(rg => {
            addBoxes(rg.start, rg.end, function (e) {
                pvShowRangeMenu(e, rg.docs, linkCtx.ctx.config);
            }, `${rg.docs.length} sheets in this range - click to choose`, 'sdx-qol-pv-link-range');
        });
    }
    // Opens a linked sheet in the viewer, remembering where we came from.
    function pvFollowDocLink(doc, config) {
        closeRangeMenu();
        if (pvCurrentMeta) pvHistory.push(pvCurrentMeta);
        openPdfPreview(doc.i, doc.n || doc.a, config);
    }
    function closeRangeMenu() {
        const existing = document.getElementById('sdx-qol-pv-range-menu');
        if (existing) existing.remove();
    }
    function pvShowRangeMenu(event, docs, config) {
        closeRangeMenu();
        const menu = document.createElement('div');
        menu.id = 'sdx-qol-pv-range-menu';
        menu.className = 'sdx-qol-pv-rangemenu';
        docs.forEach(d => {
            const item = document.createElement('div');
            item.className = 'sdx-qol-pv-rangemenu-item';
            item.textContent = `${d.a || d.n}${d.t ? ' - ' + d.t : ''}`;
            item.addEventListener('click', function (e) {
                e.stopPropagation();
                pvFollowDocLink(d, config);
            });
            menu.appendChild(item);
        });
        document.body.appendChild(menu);
        const maxLeft = Math.max(8, window.innerWidth - menu.offsetWidth - 12);
        const maxTop = Math.max(8, window.innerHeight - menu.offsetHeight - 12);
        menu.style.left = `${Math.min(event.clientX, maxLeft)}px`;
        menu.style.top = `${Math.min(event.clientY, maxTop)}px`;
        setTimeout(function () {
            document.addEventListener('click', closeRangeMenu, { once: true });
        }, 0);
    }
    // ---- "WP Index" button + snapshot ----
    function injectWpIndexButton() {
        if (!isTopFrame()) return;
        const ctx = getWorkPackageContext();
        const columnsButton = document.getElementById(MANAGER.buttonId);
        let btn = document.getElementById(WP_BTN_ID);
        if (!ctx || !columnsButton || !columnsButton.parentElement) {
            if (btn) btn.remove();
            return;
        }
        if (!btn) {
            btn = document.createElement('button');
            btn.id = WP_BTN_ID;
            btn.type = 'button';
            btn.addEventListener('click', function (e) {
                e.preventDefault();
                e.stopPropagation();
                runWpIndex();
            }, true);
            columnsButton.insertAdjacentElement('afterend', btn);
        }
        if (wpIndexBusy) return;
        const snap = loadWpIndex()[ctx.wp];
        if (snap) {
            const when = new Date(snap.savedAt || 0).toLocaleDateString();
            btn.textContent = `🔗 WP Index ✓ (${(snap.docs || []).length})`;
            btn.title = `${ctx.wp}: indexed ${when}. Click to refresh. Sheets in this work package get clickable document-number links in the PDF preview viewer.`;
        } else {
            btn.textContent = '🔗 WP Index';
            btn.title = `Index "${ctx.wp}" so document numbers on its sheets become clickable links in the PDF preview viewer.`;
        }
    }
    async function runWpIndex() {
        const ctx = getWorkPackageContext();
        const btn = document.getElementById(WP_BTN_ID);
        if (!ctx || !btn || wpIndexBusy) return;
        const token = getSdxAuthToken();
        if (!token) {
            btn.textContent = '🔗 WP Index - no session token';
            return;
        }
        wpIndexBusy = true;
        btn.disabled = true;
        try {
            const pageSize = 500;
            const rows = [];
            let skip = 0;
            let total = null;
            const filter = `WP eq '${ctx.wp.replace(/'/g, "''")}'`;
            for (;;) {
                btn.textContent = `🔗 Indexing... ${rows.length}${total ? ' / ' + total : ''}`;
                const url = `${getSdaApiBase()}/${ctx.entityType}?$format=json&$top=${pageSize}&$skip=${skip}&$filter=${encodeURIComponent(filter)}&$count=true`;
                const data = await pvFetchJson(url, token, ctx.config, { method: 'GET' });
                const batch = Array.isArray(data.value) ? data.value : [];
                if (total === null) total = Number(data['@odata.count']) || null;
                if (rows.length === 0 && batch[0]) {
                }
                rows.push(...batch);
                if (batch.length === 0) break;
                skip += batch.length;
                if (total !== null && rows.length >= total) break;
                if (total === null && batch.length < pageSize) break;
                if (skip > 5000) break;
            }
            const seen = new Set();
            const docs = [];
            rows.forEach(r => {
                const id = r.Id || r.OBID || r.id || null;
                const key = id || r.Name;
                if (!key || seen.has(key)) return;
                seen.add(key);
                docs.push({
                    i: id,
                    n: r.Name || '',
                    a: r.Alt_Doc_Name || '',
                    t: String(r.Title || '').slice(0, 90)
                });
            });
            if (!docs.length) throw new Error('no documents returned');
            if (!docs.some(d => d.i)) throw new Error('rows had no document Id field (see console)');
            const index = loadWpIndex();
            index[ctx.wp] = { config: ctx.config, savedAt: Date.now(), docs };
            if (!saveWpIndex(index)) throw new Error('could not save (browser storage full?)');
            console.log(`SDx QoL: indexed work package "${ctx.wp}" - ${docs.length} documents`);
        } catch (err) {
            console.warn('SDx QoL: WP Index failed', err);
            btn.textContent = '🔗 WP Index failed';
            btn.title = `Indexing failed: ${err && err.message ? err.message : err}`;
            wpIndexBusy = false;
            btn.disabled = false;
            return;
        }
        wpIndexBusy = false;
        btn.disabled = false;
        injectWpIndexButton();
    }
    //////////////////////////////////////////////////////////////////////
    // MODULE 3J
    // SMART FILTER (type a request, get column filters)
    //////////////////////////////////////////////////////////////////////
    // Typing e.g. "8220 civil after sept 20" works out which columns the
    // words belong to and sets ordinary Kendo data-source filters - the same
    // thing SDx's own column filter menus do (confirmed via network capture:
    // contains(To_Contract,'8250'), Issue_Date gt 2026-09-14T..., Disc eq 'MX').
    // They run on the server, so they cover the whole list, not just the rows
    // on screen. Existing filters (SDx's own search, the work-package filter,
    // anything set from the column menus) are kept; only the filters this tool
    // added are ever replaced or removed. Every interpretation is shown as an
    // editable chip so a wrong guess is a one-click fix.
    const SF_WRAP_ID = 'sdx-qol-smart-filter';
    const SF_PANEL_ID = 'sdx-qol-smart-filter-panel';
    const SF_MONTH = '(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
    const SF_DATE = '(?:\\d{4}-\\d{1,2}-\\d{1,2}|\\d{1,2}[\\/.\\-]\\d{1,2}(?:[\\/.\\-]\\d{2,4})?|' + SF_MONTH + '\\.?\\s+\\d{1,2}(?:st|nd|rd|th)?(?:,?\\s+\\d{4})?|\\d{1,2}(?:st|nd|rd|th)?\\s+' + SF_MONTH + '\\.?(?:,?\\s+\\d{4})?)';
    const SF_BARE_DATE = '(?:\\d{4}-\\d{1,2}-\\d{1,2}|\\d{1,2}[\\/\\-]\\d{1,2}[\\/\\-]\\d{2,4}|' + SF_MONTH + '\\.?\\s+\\d{1,2}(?:st|nd|rd|th)?(?:,?\\s+\\d{4})?)';
    const SF_STOPWORDS = new Set(['the', 'a', 'an', 'of', 'for', 'and', 'in', 'on', 'with', 'doc', 'docs', 'document', 'documents', 'show', 'me', 'only', 'all', 'at', 'to', 'by', 'engineering', 'management', 'discipline', 'disc', 'or', 'plus', 'contract', 'contracts', 'from', 'supplier', 'vendor']);
    const SF_STATUS_WORDS = new Set(['approved', 'hold', 'void', 'redline', 'superseded', 'obsolete']);
    const SF_IP_WORDS = new Set(['ifc', 'ifb', 'ifpc', 'ifa', 'ecn']);
    // Discipline codes (from the company discipline list) and the words people type for them.
    const SF_DISC_NAMES = {
        AA: 'project management and engineering', BA: 'construction', BC: 'commissioning', CB: 'architectural engineering',
        CG: 'geotechnical engineering', CI: 'infrastructure engineering', CS: 'structural engineering', CX: 'civil engineering',
        EA: 'electrical engineering', FA: 'cost and planning management', HE: 'environmental', HH: 'health', HP: 'security',
        HS: 'safety', HX: 'health, safety, environmental and security', IN: 'instrumentation engineering',
        JA: 'information management', KA: 'information technology', LA: 'pipeline engineering',
        MH: 'heating, ventilating, and air conditioning', MP: 'piping engineering', MR: 'mechanical rotating engineering',
        MS: 'mechanical static engineering', MX: 'mechanical engineering', NA: 'maintenance management',
        OA: 'operations management', PX: 'process engineering', QA: 'quality management', RA: 'materials engineering',
        SA: 'logistics management', TA: 'telecommunications', UA: 'subsea engineering',
        VA: 'contracting and procurement management', WA: 'ocean engineering'
    };
    const SF_DISC_PREFIX_BLOCK = new Set(['plan', 'pla', 'for', 'new', 'old', 'pro', 'con', 'sec', 'sta', 'sub', 'ins', 'mat', 'ope', 'inf', 'pip']);
    const SF_DISC_WORDS = {
        'mechanical rotating': 'MR', 'rotating': 'MR', 'mechanical static': 'MS', 'static': 'MS',
        'project management': 'AA', 'construction': 'BA', 'commissioning': 'BC', 'architectural': 'CB', 'architecture': 'CB',
        'geotechnical': 'CG', 'geotech': 'CG', 'infrastructure': 'CI', 'structural': 'CS', 'structure': 'CS', 'civil': 'CX',
        'electrical': 'EA', 'electric': 'EA', 'cost': 'FA', 'planning': 'FA', 'environmental': 'HE', 'health': 'HH',
        'security': 'HP', 'safety': 'HS', 'instrumentation': 'IN', 'instrument': 'IN', 'information management': 'JA',
        'information technology': 'KA', 'pipeline': 'LA', 'hvac': 'MH', 'heating': 'MH', 'ventilation': 'MH',
        'piping': 'MP', 'pipe': 'MP', 'mechanical': 'MX', 'maintenance': 'NA', 'operations': 'OA', 'process': 'PX',
        'quality': 'QA', 'materials': 'RA', 'logistics': 'SA', 'telecommunications': 'TA', 'telecom': 'TA',
        'subsea': 'UA', 'contracting': 'VA', 'procurement': 'VA', 'ocean': 'WA'
    };
    const SF_ORG_KEY = `${STORAGE_PREFIX}:sfOrgs`;
    const SF_ORG_GENERIC = new Set(['north', 'south', 'east', 'west', 'america', 'americas', 'inc', 'llc', 'ltd', 'corp', 'corporation', 'company', 'group', 'systems', 'services', 'engineering', 'power', 'industries', 'international', 'global', 'the', 'and', 'usa', 'energy', 'technologies', 'solutions']);
    const SF_EXAMPLES = [
        { text: '8220 civil after sept 20', need: ['To_Contract', 'Disc'] },
        { text: 'from 8250 to 8220 ifc', need: ['From_Contract', 'To_Contract'] },
        { text: 'str, arch, civil last 30 days', need: ['Disc'] },
        { text: 'approved IFC rev 01', need: ['Status', 'IP'] },
        { text: 'mechanical updated since 9/1', need: ['Disc', 'Last_Updated'] },
        { text: 'piping before 10/1', need: ['Issue_Date'] },
        { text: 'supplier wartsila', need: ['Originating_Org'] },
        { text: '5.8220 review after 10/10', need: ['Item', 'Task'] },
        { text: 'floor plan MX', need: ['Type'] }
    ];
    const SF_ENUM_FIELDS = ['IP', 'Latest_IP', 'Status', 'Disc', 'Disc_Description', 'Type', 'Doc_Rev', 'Originating_Org', 'State'];
    const smartFilter = { ever: new Set(), total: null, needles: [], lastCols: null, widget: null, text: '', chips: [], applied: [] };
    function sfMonthIndex(name) {
        const idx = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'].indexOf(String(name).slice(0, 3).toLowerCase());
        return idx;
    }
    function sfDay(y, m, d) {
        const dt = new Date(y, m, d);
        return dt.getMonth() === m && dt.getDate() === d ? dt : null; // rejects 2/31 etc.
    }
    function sfAddDays(date, n) {
        return new Date(date.getFullYear(), date.getMonth(), date.getDate() + n);
    }
    // Parses one date expression to a local-midnight Date. A missing year means
    // the current year, or last year if that would land well in the future.
    function sfParseDate(raw, now) {
        const s = String(raw).trim().toLowerCase().replace(/,/g, ' ').replace(/\s+/g, ' ');
        const fixYear = (y, m, d, explicit) => {
            const year = explicit ? (y < 100 ? 2000 + y : y) : now.getFullYear();
            let dt = sfDay(year, m, d);
            if (dt && !explicit && dt.getTime() > now.getTime() + 14 * 86400000) dt = sfDay(year - 1, m, d);
            return dt;
        };
        let m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s);
        if (m) return sfDay(+m[1], +m[2] - 1, +m[3]);
        m = /^(\d{1,2})[\/.\-](\d{1,2})(?:[\/.\-](\d{2,4}))?$/.exec(s);
        if (m) return fixYear(m[3] ? +m[3] : 0, +m[1] - 1, +m[2], Boolean(m[3]));
        m = /^([a-z]{3,9})\.? (\d{1,2})(?:st|nd|rd|th)?(?: (\d{4}))?$/.exec(s);
        if (m && sfMonthIndex(m[1]) >= 0) return fixYear(m[3] ? +m[3] : 0, sfMonthIndex(m[1]), +m[2], Boolean(m[3]));
        m = /^(\d{1,2})(?:st|nd|rd|th)? ([a-z]{3,9})\.?(?: (\d{4}))?$/.exec(s);
        if (m && sfMonthIndex(m[2]) >= 0) return fixYear(m[3] ? +m[3] : 0, sfMonthIndex(m[2]), +m[1], Boolean(m[3]));
        return null;
    }
    // Builds the vocabulary of real column values from the rows currently
    // loaded in the grid (lowercase -> canonical value, per field).
    function sfBuildVocab(widget, cols) {
        const vocab = {};
        try {
            const rows = Array.from(widget.dataSource.view()).map(r => (r && r.toJSON ? r.toJSON() : r));
            // Words found in short text columns such as To Do List "Task" / "RFR" (e.g. review, consolidation).
            const words = new Map();
            (cols || []).filter(c => /^(task|rfr)$/i.test(c.title)).forEach(c => {
                rows.forEach(r => String((r && r[c.field]) || '').toLowerCase().split(/[^a-z0-9]+/).forEach(w => {
                    if (w.length >= 4 && !words.has(w)) words.set(w, c.field);
                }));
            });
            vocab.words = words;
            // Originating org (supplier) names: remember what has been seen so a supplier name works even
            // when none of their documents are on the current page.
            const orgCol = (cols || []).find(c => c.field === 'Originating_Org') || (cols || []).find(c => /^originating org/i.test(c.title));
            let orgs = [];
            try { orgs = JSON.parse(localStorage.getItem(SF_ORG_KEY) || '[]'); } catch (err) { orgs = []; }
            if (orgCol) {
                const seen = new Set(orgs);
                rows.forEach(r => { const v = r && r[orgCol.field]; if (typeof v === 'string' && v.trim()) seen.add(v.trim()); });
                orgs = Array.from(seen).slice(-300);
                try { localStorage.setItem(SF_ORG_KEY, JSON.stringify(orgs)); } catch (err) { /* optional */ }
            }
            const orgWords = new Map();
            if (orgCol) orgs.forEach(o => o.toLowerCase().split(/[^a-z0-9]+/).forEach(w => {
                if (w.length >= 4 && !SF_ORG_GENERIC.has(w) && !orgWords.has(w)) orgWords.set(w, orgCol.field);
            }));
            vocab.orgWords = orgWords;
            SF_ENUM_FIELDS.forEach(field => {
                const map = new Map();
                rows.forEach(r => {
                    const v = r && r[field];
                    if (typeof v === 'string' && v.trim()) map.set(v.trim().toLowerCase(), v.trim());
                });
                if (map.size) vocab[field] = map;
            });
        } catch (err) { /* vocabulary is optional */ }
        return vocab;
    }
    const SF_DATE_FIELDS = new Set(['Issue_Date', 'Last_Updated']);
    function sfGetColumns(widget) {
        const model = (widget.dataSource.options.schema && widget.dataSource.options.schema.model && widget.dataSource.options.schema.model.fields) || {};
        const out = new Map();
        const add = (field, title) => {
            if (!field || typeof field !== 'string' || out.has(field)) return;
            const type = (model[field] || {}).type || (SF_DATE_FIELDS.has(field) || /date|updated/i.test(title || field) ? 'date' : 'string');
            out.set(field, { field, title: normalizeText(title || field.replace(/_/g, ' ')), type });
        };
        (widget.columns || []).forEach(c => add(c.field, c.title));
        try {
            const el = widget.element && widget.element[0];
            if (el) el.querySelectorAll('th[data-field]').forEach(th => add(th.getAttribute('data-field'), th.getAttribute('data-title') || th.textContent));
        } catch (err) { /* optional */ }
        try {
            const first = Array.from(widget.dataSource.view())[0];
            const row = first && first.toJSON ? first.toJSON() : first;
            if (row) Object.keys(row).forEach(k => { if (/^[A-Za-z][A-Za-z0-9_]*$/.test(k) && typeof row[k] !== 'object') add(k); });
        } catch (err) { /* optional */ }
        const cols = Array.from(out.values());
        if (cols.length) smartFilter.lastCols = cols; // an empty result page has no rows to read keys from
        return cols.length > 3 ? cols : (smartFilter.lastCols || cols);
    }
    // Turns typed text into editable chips: { fields, op, value, kind }.
    function sfParse(input, cols, vocab, now) {
        const chips = [];
        const norm = v => String(v || '').toLowerCase().replace(/[^a-z0-9]/g, '');
        const resolve = f => (cols.find(c => c.field === f) || cols.find(c => norm(c.field) === norm(f)) || cols.find(c => norm(c.title) === norm(f)) || {}).field || null;
        const has = f => Boolean(resolve(f));
        const firstOf = list => list.find(has) || null;
        // 2-letter discipline codes are only taken from the original text when typed in capitals (MX, CX...) or after "disc".
        const upperCodes = new Set((String(input || '').match(/\b[A-Z]{2}\b/g) || []).filter(c => SF_DISC_NAMES[c]));
        let text = ' ' + String(input || '').toLowerCase().replace(/[“”]/g, '"') + ' ';
        // ---------- dates ----------
        const L = '(?<![\\w\\-\\/.])';
        const R = '(?![\\w\\-\\/])';
        const DC = L + '(' + SF_DATE + ')' + R;
        const PFX = '(?:\\b(updated|modified|changed|issued)\\s+)?';
        function dateField(prefix) {
            const wanted = /^(updated|modified|changed)$/.test(prefix || '') ? 'Last_Updated' : 'Issue_Date';
            if (has(wanted)) return wanted;
            const anyDate = cols.find(c => c.type === 'date');
            return anyDate ? anyDate.field : null; // e.g. Target Date on the To Do List
        }
        function addDate(prefix, op, date) {
            const field = dateField(prefix);
            if (!field) return false;
            chips.push({ fields: [field], op, value: date, kind: 'date' });
            return true;
        }
        function take(re, handler) {
            text = text.replace(new RegExp(re, 'g'), function () {
                const m = Array.prototype.slice.call(arguments);
                return handler(m) ? ' ' : m[0];
            });
        }
        const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        take(PFX + 'between\\s+' + DC + '\\s+and\\s+' + DC, m => {
            const a = sfParseDate(m[2], now);
            const b = sfParseDate(m[3], now);
            if (!a || !b) return false;
            return addDate(m[1], 'gte', a) && addDate(m[1], 'lt', sfAddDays(b, 1));
        });
        take(PFX + '\\bfrom\\s+' + DC + '\\s+(?:to|through|thru|until|-)\\s+' + DC, m => {
            const a = sfParseDate(m[2], now);
            const b = sfParseDate(m[3], now);
            if (!a || !b) return false;
            return addDate(m[1], 'gte', a) && addDate(m[1], 'lt', sfAddDays(b, 1));
        });
        take(PFX + '(?:in the |within the |over the )?(?:last|past)\\s+(\\d+)\\s*(day|week|month|year)s?\\b', m => {
            const n = +m[2];
            const from = m[3] === 'day' ? sfAddDays(today, -n)
                : m[3] === 'week' ? sfAddDays(today, -7 * n)
                    : m[3] === 'month' ? new Date(today.getFullYear(), today.getMonth() - n, today.getDate())
                        : new Date(today.getFullYear() - n, today.getMonth(), today.getDate());
            return addDate(m[1], 'gte', from);
        });
        take(PFX + '\\b(today|yesterday|this week|last week|this month|last month)\\b', m => {
            const w = m[2];
            const weekStart = sfAddDays(today, -today.getDay());
            if (w === 'today') return addDate(m[1], 'gte', today);
            if (w === 'yesterday') return addDate(m[1], 'gte', sfAddDays(today, -1)) && addDate(m[1], 'lt', today);
            if (w === 'this week') return addDate(m[1], 'gte', weekStart);
            if (w === 'last week') return addDate(m[1], 'gte', sfAddDays(weekStart, -7)) && addDate(m[1], 'lt', weekStart);
            const monthStart = new Date(today.getFullYear(), today.getMonth(), 1);
            if (w === 'this month') return addDate(m[1], 'gte', monthStart);
            return addDate(m[1], 'gte', new Date(today.getFullYear(), today.getMonth() - 1, 1)) && addDate(m[1], 'lt', monthStart);
        });
        take(PFX + '\\b(after|later than|newer than|since|from|on or after)\\s+' + DC, m => {
            const d = sfParseDate(m[3], now);
            if (!d) return false;
            // "after Sept 20" means later than that day; "since Sept 20" includes it.
            return /^(after|later than|newer than)$/.test(m[2]) ? addDate(m[1], 'gte', sfAddDays(d, 1)) : addDate(m[1], 'gte', d);
        });
        take(PFX + '\\b(before|prior to|earlier than|older than|until|up to|through|thru)\\s+' + DC, m => {
            const d = sfParseDate(m[3], now);
            if (!d) return false;
            return /^(until|up to|through|thru)$/.test(m[2]) ? addDate(m[1], 'lt', sfAddDays(d, 1)) : addDate(m[1], 'lt', d);
        });
        take(PFX + '\\bon\\s+' + DC, m => {
            const d = sfParseDate(m[2], now);
            return Boolean(d) && addDate(m[1], 'gte', d) && addDate(m[1], 'lt', sfAddDays(d, 1));
        });
        take(PFX + L + '(' + SF_BARE_DATE + ')' + R, m => {
            const d = sfParseDate(m[2], now);
            return Boolean(d) && addDate(m[1], 'gte', d) && addDate(m[1], 'lt', sfAddDays(d, 1));
        });
        // "from 8220" / "to 8250": explicit From Contract / To Contract
        take('\\b(from|to)\\s+((?:\\d{6}-)?(?:\\d\\.)?\\d{4})(?![\\w.\\-])', m => {
            const field = m[1] === 'from' ? firstOf(['From_Contract']) : firstOf(['To_Contract', 'Item']);
            if (!field) return false;
            chips.push({ fields: [field], op: 'contains', value: field === 'Item' && /^\\d{4}$/.test(m[2]) ? '.' + m[2] : m[2], kind: 'text', note: field === 'Item' ? 'contract' : undefined });
            return true;
        });
        // "supplier wartsila" / "vendor "acme corp"": Originating Org
        take('\\b(?:supplier|vendor|originator|org|organization)\\s+(?:"([^"]+)"|([a-z0-9&.\\-]+))', m => {
            const field = firstOf(['Originating_Org']);
            if (!field) return false;
            chips.push({ fields: [field], op: 'contains', value: (m[1] || m[2]).trim(), kind: 'text' });
            return true;
        });
        // ---------- words ----------
        text = text.replace(/[,;]+/g, ' ');
        const tokens = [];
        text.replace(/"([^"]+)"|(\S+)/g, (all, quoted, plain) => {
            tokens.push((quoted || plain).trim());
            return all;
        });
        const typeVocab = vocab.Type || new Map();
        const ipVocab = vocab.IP || new Map();
        let i = 0;
        while (i < tokens.length) {
            const tok = tokens[i].replace(/^[,;:.]+|[,;:.]+$/g, '');
            if (!tok) { i++; continue; }
            // multi-word values (e.g. "floor plan") taken from real Type values
            let consumed = 0;
            for (let n = Math.min(4, tokens.length - i); n >= 2 && !consumed; n--) {
                const phrase = tokens.slice(i, i + n).join(' ');
                if (has('Type') && typeVocab.has(phrase)) {
                    chips.push({ fields: ['Type'], op: 'eq', value: typeVocab.get(phrase), kind: 'text' });
                    consumed = n;
                }
            }
            if (consumed) { i += consumed; continue; }
            if (SF_STOPWORDS.has(tok)) { i++; continue; }
            if (has('Disc')) {
                let hit = 0;
                for (let n = Math.min(2, tokens.length - i); n >= 1 && !hit; n--) {
                    const code = SF_DISC_WORDS[tokens.slice(i, i + n).join(' ').replace(/[,;:.]+$/g, '')];
                    if (code) { chips.push({ fields: ['Disc'], op: 'eq', value: code, kind: 'text', note: SF_DISC_NAMES[code] }); hit = n; }
                }
                if (!hit && tok.length >= 3 && !typeVocab.has(tok) && !SF_DISC_PREFIX_BLOCK.has(tok)) {
                    // abbreviations such as "str", "civ", "elec", "mech" - only when they point at one discipline
                    const codes = new Set(Object.keys(SF_DISC_WORDS).filter(w => w.indexOf(' ') < 0 && w.length > tok.length && w.startsWith(tok)).map(w => SF_DISC_WORDS[w]));
                    if (codes.size === 1) {
                        const code = Array.from(codes)[0];
                        chips.push({ fields: ['Disc'], op: 'eq', value: code, kind: 'text', note: SF_DISC_NAMES[code] });
                        hit = 1;
                    }
                }
                if (!hit && /^disc(?:ipline)?$/.test(tok) && tokens[i + 1] && SF_DISC_NAMES[tokens[i + 1].toUpperCase()]) {
                    const code = tokens[i + 1].toUpperCase();
                    chips.push({ fields: ['Disc'], op: 'eq', value: code, kind: 'text', note: SF_DISC_NAMES[code] });
                    hit = 2;
                }
                if (!hit && upperCodes.has(tok.toUpperCase()) && tok.length === 2) {
                    const code = tok.toUpperCase();
                    chips.push({ fields: ['Disc'], op: 'eq', value: code, kind: 'text', note: SF_DISC_NAMES[code] });
                    hit = 1;
                }
                if (hit) { i += hit; continue; }
            }
            // "rev 01" / "rev01"
            let m = /^rev(?:ision)?(\d{1,2})$/.exec(tok);
            if (!m && /^rev(?:ision)?$/.test(tok) && /^\d{1,2}$/.test(tokens[i + 1] || '') && has('Doc_Rev')) {
                m = [null, tokens[i + 1]];
                i++;
            }
            if (m && has('Doc_Rev')) {
                chips.push({ fields: ['Doc_Rev'], op: 'eq', value: String(m[1]).padStart(2, '0'), kind: 'text' });
                i++;
                continue;
            }
            // contract numbers: any 4-digit number, 5.8220, 186688-5.8220.
            // Lists without a To Contract column (To Do List) carry the contract inside "Item" (186688-5.8220-0311).
            if (/^(?:\d{6}-)?(?:\d\.)?\d{4}$/.test(tok) && (has('To_Contract') || has('Item'))) {
                if (has('To_Contract')) chips.push({ fields: ['To_Contract'], op: 'contains', value: tok, kind: 'text' });
                else chips.push({ fields: ['Item'], op: 'contains', value: /^\d{4}$/.test(tok) ? '.' + tok : tok, kind: 'text', note: 'contract' });
                i++;
                continue;
            }
            // document numbers: prs-com-cp-111, cp-111-01
            if (/^[a-z0-9]+(?:-[a-z0-9]+){2,}$/.test(tok) && /\d/.test(tok)) {
                const fields = ['Alt_Doc_Name', 'Name'].filter(has);
                if (fields.length) {
                    chips.push({ fields, op: 'contains', value: tok, kind: 'text' });
                    i++;
                    continue;
                }
            }
            if (has('Status') && SF_STATUS_WORDS.has(tok)) {
                chips.push({ fields: ['Status'], op: 'contains', value: tok, kind: 'text' });
                i++;
                continue;
            }
            if (has('IP') && (SF_IP_WORDS.has(tok) || ipVocab.has(tok))) {
                chips.push({ fields: ['IP'], op: 'eq', value: (ipVocab.get(tok) || tok.toUpperCase()), kind: 'text' });
                i++;
                continue;
            }
            if (has('Type') && typeVocab.has(tok)) {
                chips.push({ fields: ['Type'], op: 'eq', value: typeVocab.get(tok), kind: 'text' });
                i++;
                continue;
            }
            if (vocab.words && vocab.words.has(tok)) {
                chips.push({ fields: [vocab.words.get(tok)], op: 'contains', value: tok, kind: 'text' });
                i++;
                continue;
            }
            if (vocab.orgWords && vocab.orgWords.has(tok)) {
                chips.push({ fields: [vocab.orgWords.get(tok)], op: 'contains', value: tok, kind: 'text' });
                i++;
                continue;
            }
            // anything else: a free-text word. Search it across the text columns at once (like SDx's own
            // search box) so supplier names, titles and document names are all covered.
            let free = ['Title', 'Name', 'Alt_Doc_Name', 'Originating_Org'].filter(has);
            if (!has('Name')) free = free.concat(['Item'].filter(has));
            if (!free.length) free = [(cols.find(c => c.type === 'string') || {}).field].filter(Boolean);
            if (free.length) chips.push({ fields: free, op: 'contains', value: tok, kind: 'text' });
            i++;
        }
        // Resolve canonical names to the list's real field names, merge repeated discipline words into one OR chip.
        const disc = chips.filter(c => c.fields.length === 1 && c.fields[0] === 'Disc' && c.op === 'eq');
        let out = chips;
        if (disc.length > 1) {
            const merged = { fields: ['Disc'], op: 'eq', value: disc[0].value, values: Array.from(new Set(disc.map(c => c.value))), kind: 'text', note: Array.from(new Set(disc.map(c => c.note))).join(', ') };
            out = chips.filter(c => !disc.includes(c));
            out.push(merged);
        }
        out.forEach(c => { c.fields = c.fields.map(f => resolve(f) || f); });
        return out;
    }
    function sfFormatDate(d) {
        return `${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()}`;
    }
    function sfChipLabel(chip, cols) {
        const title = f => (cols.find(c => c.field === f) || {}).title || f;
        const where = chip.fields.map(title).join(' / ');
        if (chip.kind === 'date') {
            return `${where} ${chip.op === 'lt' ? 'before' : 'on or after'} ${sfFormatDate(chip.value)}`;
        }
        if (chip.values && chip.values.length > 1) return `${where} is ${chip.values.join(' or ')}${chip.note ? ' (' + chip.note + ')' : ''}`;
        return `${where} ${chip.op === 'eq' ? 'is' : 'contains'} "${chip.value}"${chip.note ? ' (' + chip.note + ')' : ''}`;
    }
    function sfMark(obj) {
        try { Object.defineProperty(obj, '__sdxQolSF', { value: true, enumerable: false }); } catch (err) { /* ignore */ }
        return obj;
    }
    function sfToKendo(chip) {
        return sfMark(sfToKendoRaw(chip));
    }
    function sfIsOurs(f) {
        return Boolean(f && (f.__sdxQolSF || smartFilter.ever.has(sfSig(f))));
    }
    function sfToKendoRaw(chip) {
        const one = field => ({ field, operator: chip.op, value: chip.value });
        if (chip.values && chip.values.length > 1) {
            return { logic: 'or', filters: chip.values.map(v => ({ field: chip.fields[0], operator: chip.op, value: v })) };
        }
        return chip.fields.length === 1 ? one(chip.fields[0]) : { logic: 'or', filters: chip.fields.map(one) };
    }
    // Signature of a filter item that ignores the "logic" key Kendo adds.
    function sfSig(f) {
        if (!f) return '';
        if (Array.isArray(f.filters)) return `G${f.logic || 'and'}[${f.filters.map(sfSig).join(',')}]`;
        const v = f.value instanceof Date ? f.value.toISOString() : f.value;
        return `${f.field}|${f.operator}|${v}`;
    }
    function sfTopFilter(ds) {
        const cur = ds.filter();
        if (!cur) return { logic: 'and', filters: [] };
        if (Array.isArray(cur.filters)) return { logic: cur.logic || 'and', filters: cur.filters.slice() };
        return { logic: 'and', filters: [cur] };
    }
    // Replaces ONLY the filters this tool previously added with the current chips.
    function sfApplyToGrid(widget) {
        const ds = widget.dataSource;
        const top = sfTopFilter(ds);
        const previousNeedles = smartFilter.needles;
        let kept = top.filters.filter(f => !sfIsOurs(f));
        if (top.logic === 'or') kept = [{ logic: 'or', filters: kept }]; // keep an OR group intact
        const added = smartFilter.chips.map(sfToKendo);
        smartFilter.applied = added.map(sfSig);
        smartFilter.applied.forEach(sig => smartFilter.ever.add(sig));
        smartFilter.needles = smartFilter.chips.filter(c => c.kind === 'text').reduce((acc, c) => acc.concat(c.values || [c.value]), []).map(v => String(v).toLowerCase());
        smartFilter.total = null;
        const merged = kept.concat(added);
        ds.filter(merged.length ? { logic: 'and', filters: merged } : null);
        sfBindTotalKeeper(widget);
        sfRefreshCountSoon(widget, smartFilter.needles, smartFilter.needles.length ? [] : previousNeedles);
    }
    // Pushes a new total into the grid's pager. Tries the widgets first, then (if the footer text is still
    // the old number) rewrites the footer text itself.
    function sfShowTotal(widget, total) {
        const ds = widget.dataSource;
        ds._total = total;
        const pagerEls = [...document.querySelectorAll('.k-pager, .k-grid-pager, .k-pager-wrap, [data-role="pager"]')];
        const widgets = new Set();
        if (widget.pager) widgets.add(widget.pager);
        pagerEls.forEach(el => { const w = getKendoWidgetFromElement(el, ['kendoPager']); if (w) widgets.add(w); });
        widgets.forEach(w => { try { if (typeof w.refresh === 'function') w.refresh(); } catch (err) { /* cosmetic */ } });
        setTimeout(function () {
            const pageSize = (typeof ds.pageSize === 'function' && ds.pageSize()) || 0;
            const pagerEl = getLikelyMainPager();
            if (!pagerEl) return;
            const info = pagerEl.querySelector('.k-pager-info') || pagerEl;
            const shown = parsePagerInfo(pagerEl);
            if (shown.total === total) return;
            // The widgets did not update the footer: rewrite it.
            const first = total ? 1 : 0;
            const last = pageSize ? Math.min(pageSize, total) : total;
            const walker = document.createTreeWalker(info, NodeFilter.SHOW_TEXT);
            let node;
            while ((node = walker.nextNode())) {
                if (/\d+\s*-\s*\d+\s*of\s*\d+/i.test(node.nodeValue)) {
                    node.nodeValue = node.nodeValue.replace(/\d+\s*-\s*\d+(\s*of\s*)\d+/i, `${first} - ${last}$1${total}`);
                }
            }
            const pages = pageSize ? Math.max(1, Math.ceil(total / pageSize)) : 1;
            const pw = document.createTreeWalker(pagerEl, NodeFilter.SHOW_TEXT);
            while ((node = pw.nextNode())) {
                if (/^\s*of\s+\d+\s*$/i.test(node.nodeValue)) node.nodeValue = node.nodeValue.replace(/\d+/, String(pages));
            }
            // Page boxes/buttons: go back to page 1 and disable paging when everything fits.
            const input = pagerEl.querySelector('input');
            if (input && !/^\d+$/.test(String(input.value || '').trim())) input.value = '1';
        }, 150);
    }
    // Paging inside a filtered list makes SDx's own code write its old total back; put ours back after any change.
    function sfBindTotalKeeper(widget) {
        const ds = widget.dataSource;
        if (ds.__sdxQolSFBound || typeof ds.bind !== 'function') return;
        ds.__sdxQolSFBound = true;
        ds.bind('change', function () {
            if (smartFilter.total === null || !smartFilter.chips.length || smartFilter.widget !== widget) return;
            setTimeout(function () {
                if (smartFilter.total !== null && ds.total() !== smartFilter.total) sfShowTotal(widget, smartFilter.total);
            }, 40);
        });
    }
    // SDx loads rows with $count=false and fetches the total separately, but only when one of ITS filter
    // menus is used. After we change the filter ourselves, ask for the matching total the same way and
    // push it into the data source and pager so "1 - 250 of N items" is right.
    let sfCountSeq = 0;
    function sfRefreshCountSoon(widget, needles, avoid) {
        const seq = ++sfCountSeq;
        const startedAt = Date.now();
        let tries = 0;
        const poll = function () {
            if (seq !== sfCountSeq) return;
            // SDx writes OData options percent-encoded (%24top, %24count), so accept both spellings.
            const reTop0 = /[?&](?:\$|%24)top=0(?!\d)/i;
            const reCountTrue = /[?&](?:\$|%24)count=true/i;
            const reCountFalse = /[?&](?:\$|%24)count=false/i;
            let fresh = recentReads.filter(r => r.t >= startedAt - 50);
            // Fallback: the browser's own resource list, in case the page's requests bypass our wrappers.
            try {
                const origin = performance.timeOrigin || 0;
                performance.getEntriesByType('resource').forEach(e => {
                    if ((e.initiatorType === 'xmlhttprequest' || e.initiatorType === 'fetch') && origin + e.startTime >= startedAt - 50 && /\/api\/v2\//i.test(e.name) && /(?:\$|%24)top=/i.test(e.name)) {
                        fresh.push({ url: e.name, headers: {}, t: origin + e.startTime });
                    }
                });
            } catch (err) { /* optional */ }
            fresh = fresh.sort((x, y) => x.t - y.t);
            // SDx made its own count call: nothing to do.
            if (fresh.some(r => reCountTrue.test(r.url) && reTop0.test(r.url))) return;
            // Only trust a list request that really carries this filter (not an older or unfiltered one).
            const decoded = r => { try { return decodeURIComponent(r.url).toLowerCase(); } catch (err) { return r.url.toLowerCase(); } };
            const rows = fresh.filter(r => reCountFalse.test(r.url))
                .filter(r => (needles || []).every(n => decoded(r).includes(n)))
                .filter(r => !(avoid || []).some(n => decoded(r).includes(n)))
                .pop();
            if (!rows) {
                if (++tries < 50) setTimeout(poll, 250);
                else console.warn('SDx QoL smart filter: no list request seen after applying the filter; item count not refreshed');
                return;
            }
            const url = rows.url
                .replace(/([?&](?:\$|%24)top=)\d+/i, '$10')
                .replace(/([?&])(?:\$|%24)skip=\d+&?/i, '$1')
                .replace(/(?:\$|%24)count=false/i, '$count=true')
                .replace(/[?&]$/, '');
            const headers = Object.assign({ Accept: 'application/json' }, rows.headers);
            if (!readHeaderCaseInsensitive(headers, 'authorization')) {
                const token = getSdxAuthToken();
                if (token) headers.Authorization = `Bearer ${token}`;
            }
            fetch(url, { headers, credentials: 'include' })
                .then(r => (r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status))))
                .then(j => {
                    if (seq !== sfCountSeq) return;
                    const n = [j['@odata.count'], j['odata.count'], j.count, j.Count].find(v => Number.isFinite(Number(v)) && v !== null && v !== undefined);
                    if (n === undefined) return;
                    widget.dataSource._total = Number(n);
                    smartFilter.total = smartFilter.chips.length ? Number(n) : null;
                    sfShowTotal(widget, Number(n));
                })
                .catch(err => console.warn('SDx QoL smart filter: could not refresh the item count', err));
        };
        setTimeout(poll, 120);
    }
    function sfGetWidget() {
        // Keep the grid we already know while it is on the page, even with zero rows showing.
        const known = smartFilter.widget;
        if (known && known.element && known.element[0] && known.element[0].isConnected) return known;
        let best = null;
        let bestScore = -1;
        document.querySelectorAll('.k-grid').forEach(gridEl => {
            const widget = getKendoWidgetFromElement(gridEl, ['kendoGrid']);
            if (!widget || !widget.dataSource || typeof widget.dataSource.filter !== 'function') return;
            const score = (gridEl.querySelector('tr[data-uid]') ? 1000 : 0) + (widget.columns || []).length;
            if (score > bestScore) { best = widget; bestScore = score; }
        });
        return best;
    }
    function sfRunText(text) {
        const widget = sfGetWidget();
        if (!widget) return;
        smartFilter.widget = widget;
        smartFilter.text = text;
        const cols = sfGetColumns(widget);
        smartFilter.chips = sfParse(text, cols, sfBuildVocab(widget, cols), new Date());
        console.log('SDx QoL smart filter:', text, '->', smartFilter.chips.map(c => `${c.fields.join('/')} ${c.op} ${c.values ? c.values.join('|') : (c.value instanceof Date ? c.value.toISOString() : c.value)}`));
        sfApplyToGrid(widget);
        sfRenderPanel(true);
    }
    function sfClearAll() {
        const widget = smartFilter.widget || sfGetWidget();
        smartFilter.chips = [];
        if (widget) sfApplyToGrid(widget);
        smartFilter.applied = [];
        smartFilter.total = null;
        smartFilter.text = '';
        const input = document.querySelector('#' + SF_WRAP_ID + ' input');
        if (input) input.value = '';
        sfRenderPanel(false);
        sfUpdateBadge();
    }
    function sfReapply() {
        const widget = smartFilter.widget || sfGetWidget();
        if (!widget) return;
        sfApplyToGrid(widget);
        sfRenderPanel(true);
    }
    function sfCloseOnOutsideClick(e) {
        const panel = document.getElementById(SF_PANEL_ID);
        const wrap = document.getElementById(SF_WRAP_ID);
        if (!panel) return;
        if (panel.contains(e.target) || (wrap && wrap.contains(e.target))) return;
        panel.remove();
    }
    function sfUpdateBadge() {
        const badge = document.querySelector('#' + SF_WRAP_ID + ' .sdx-qol-sf-badge');
        if (!badge) return;
        const n = smartFilter.chips.length;
        badge.textContent = n ? `${n} filter${n === 1 ? '' : 's'}` : '';
        badge.style.display = n ? '' : 'none';
        const clear = document.querySelector('#' + SF_WRAP_ID + ' .sdx-qol-sf-clear');
        const input = document.querySelector('#' + SF_WRAP_ID + ' input');
        if (clear) clear.style.display = (n || (input && input.value)) ? '' : 'none';
    }
    // Shows the chips (editable) under the input.
    function sfRenderPanel(show) {
        sfUpdateBadge();
        let panel = document.getElementById(SF_PANEL_ID);
        if (!show) {
            if (panel) panel.remove();
            return;
        }
        const wrap = document.getElementById(SF_WRAP_ID);
        const widget = smartFilter.widget;
        if (!wrap || !widget) return;
        if (!panel) {
            panel = document.createElement('div');
            panel.id = SF_PANEL_ID;
            document.body.appendChild(panel);
            setTimeout(function () { document.addEventListener('click', sfCloseOnOutsideClick); }, 0);
        }
        const rect = wrap.getBoundingClientRect();
        panel.style.top = `${rect.bottom + 4}px`;
        panel.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - 460))}px`;
        panel.textContent = '';
        const cols = sfGetColumns(widget);
        const title = document.createElement('div');
        title.className = 'sdx-qol-sf-title';
        title.textContent = smartFilter.chips.length ? 'Filters applied (change a column or remove one to adjust)' : 'Nothing recognised - try e.g. "8220 civil after sept 20"';
        panel.appendChild(title);
        smartFilter.chips.forEach((chip, idx) => {
            const row = document.createElement('div');
            row.className = 'sdx-qol-sf-chip';
            const label = document.createElement('span');
            label.className = 'sdx-qol-sf-chip-label';
            label.textContent = sfChipLabel(chip, cols);
            row.appendChild(label);
            // Column picker: only columns of a compatible type.
            const select = document.createElement('select');
            const compatible = cols.filter(c => (chip.kind === 'date' ? c.type === 'date' : c.type !== 'date'));
            compatible.forEach(c => {
                const opt = document.createElement('option');
                opt.value = c.field;
                opt.textContent = c.title;
                if (chip.fields.length === 1 && chip.fields[0] === c.field) opt.selected = true;
                select.appendChild(opt);
            });
            if (chip.fields.length > 1) {
                const first = document.createElement('option');
                first.value = '';
                first.textContent = '(several columns)';
                first.selected = true;
                select.insertBefore(first, select.firstChild);
            }
            select.title = 'Search a different column';
            select.addEventListener('change', function () {
                if (!select.value) return;
                chip.fields = [select.value];
                sfReapply();
            });
            row.appendChild(select);
            const remove = document.createElement('button');
            remove.type = 'button';
            remove.textContent = '×';
            remove.title = 'Remove this filter';
            remove.addEventListener('click', function () {
                smartFilter.chips.splice(idx, 1);
                sfReapply();
            });
            row.appendChild(remove);
            panel.appendChild(row);
        });
        const foot = document.createElement('div');
        foot.className = 'sdx-qol-sf-foot';
        const clearBtn = document.createElement('button');
        clearBtn.type = 'button';
        clearBtn.textContent = 'Clear all';
        clearBtn.addEventListener('click', sfClearAll);
        foot.appendChild(clearBtn);
        panel.appendChild(foot);
    }
    function injectSmartFilter() {
        if (!isTopFrame()) return;
        const columnsButton = document.getElementById(MANAGER.buttonId);
        let wrap = document.getElementById(SF_WRAP_ID);
        const widget = sfGetWidget();
        if (!columnsButton || !columnsButton.parentElement || !widget) {
            if (wrap) wrap.remove();
            return;
        }
        // A different grid means a different list: forget this tool's state.
        if (smartFilter.widget && smartFilter.widget !== widget) {
            smartFilter.chips = [];
            smartFilter.applied = [];
            smartFilter.text = '';
            smartFilter.widget = null;
            sfRenderPanel(false);
            const input = wrap && wrap.querySelector('input');
            if (input) input.value = '';
        }
        // If SDx replaced the filters (e.g. a new search), drop chips that are no longer applied.
        if (smartFilter.chips.length && smartFilter.widget === widget) {
            if (!sfTopFilter(widget.dataSource).filters.some(sfIsOurs)) {
                smartFilter.chips = [];
                smartFilter.applied = [];
                smartFilter.total = null;
                sfRenderPanel(false);
            }
        }
        if (!wrap) {
            wrap = document.createElement('div');
            wrap.id = SF_WRAP_ID;
            const input = document.createElement('input');
            input.type = 'text';
            input.placeholder = 'Smart filter: 8220 civil after sept 20';
            input.title = 'Type what you want to see, then press Enter or click Apply. Words are matched to columns (contract numbers, discipline, status, dates, titles...).';
            input.addEventListener('keydown', function (e) {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    e.stopPropagation();
                    try { sfRunText(input.value); } catch (err) { console.error('SDx QoL smart filter failed:', err); }
                } else if (e.key === 'Escape') {
                    input.blur();
                }
            });
            // keep the page's keyboard shortcuts from reacting while typing
            input.addEventListener('keyup', function (e) { e.stopPropagation(); });
            const badge = document.createElement('button');
            badge.type = 'button';
            badge.className = 'sdx-qol-sf-badge';
            badge.style.display = 'none';
            badge.title = 'Show / edit the filters this tool applied';
            badge.addEventListener('click', function (e) {
                e.stopPropagation();
                const open = document.getElementById(SF_PANEL_ID);
                if (open) open.remove(); else sfRenderPanel(true);
            });
            input.addEventListener('input', sfUpdateBadge);
            const apply = document.createElement('button');
            apply.type = 'button';
            apply.className = 'sdx-qol-sf-apply';
            apply.textContent = 'Apply';
            apply.title = 'Apply the smart filter (same as pressing Enter)';
            apply.addEventListener('click', function () {
                try { sfRunText(input.value); } catch (err) { console.error('SDx QoL smart filter failed:', err); }
            });
            const clear = document.createElement('button');
            clear.type = 'button';
            clear.className = 'sdx-qol-sf-clear';
            clear.textContent = 'Clear';
            clear.title = 'Clear the smart filter text and the filters it applied';
            clear.style.display = 'none';
            clear.addEventListener('click', sfClearAll);
            wrap.appendChild(input);
            wrap.appendChild(apply);
            wrap.appendChild(badge);
            wrap.appendChild(clear);
        }
        if (!wrap.isConnected) {
            const parent = columnsButton.parentElement;
            parent.insertBefore(wrap, parent.firstChild);
        }
        if (smartFilter.text && !wrap.querySelector('input').value) wrap.querySelector('input').value = smartFilter.text;
        sfUpdateBadge();
        sfStartExampleRotation();
    }
    // Cycles example phrases through the (empty) input's placeholder so new users see what it understands.
    let sfExampleTimer = null;
    let sfExampleIndex = 0;
    function sfTickExample() {
        const input = document.querySelector('#' + SF_WRAP_ID + ' input');
        if (!input) return;
        if (input.value || document.activeElement === input) return;
        const widget = smartFilter.widget || sfGetWidget();
        const cols = widget ? sfGetColumns(widget) : [];
        const norm = v => String(v || '').toLowerCase().replace(/[^a-z0-9]/g, '');
        const hasCol = f => cols.some(c => norm(c.field) === norm(f) || norm(c.title) === norm(f));
        const usable = SF_EXAMPLES.filter(ex => ex.need.every(hasCol));
        const list = usable.length ? usable : SF_EXAMPLES.slice(0, 1);
        sfExampleIndex = (sfExampleIndex + 1) % list.length;
        input.placeholder = 'Smart filter - try: ' + list[sfExampleIndex].text;
    }
    function sfStartExampleRotation() {
        if (sfExampleTimer) return;
        sfExampleTimer = setInterval(sfTickExample, 4000);
    }
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
        injectWpIndexButton();
        injectSmartFilter();
        // Icons are added only after the grid has been quiet for a moment, so
        // we never inject into intermediate renders that SDx is about to
        // throw away (and never add DOM churn mid-render).
        schedulePreviewInjection();
        maybeAutoApplyPageSize();
    }
    function refreshQoL() {
        injectStyles();
        injectManagerButton();
        applyGridCustomizations();
        if (location.href !== lastUrl) {
            lastUrl = location.href;
            closeManagerMenu();
            // Reset so maybeAutoApplyPageSize() restores this new list's own
            // saved page size (if any) once its grid/pager has rendered.
            lastAppliedPageSize = null;
            setTimeout(function () {
                injectManagerButton();
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
