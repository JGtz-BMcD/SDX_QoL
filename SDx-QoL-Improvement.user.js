// ==UserScript==
// @name         SDx QoL Improvement
// @namespace    https://burnsmcd.com
// @version      1.4
// @description  SDx quality-of-life improvements: shift-select, keyboard shortcuts, truncated-cell tooltips, session-expiry indicator, column manager (kept out of embedded frames), SDx Kendo page-size control (now remembered per list), To Do List row highlighting, optional auto-close of the To Do List step-details panel, and bulk file download (bypasses SDx's 100-file dialog limit).
// @match        https://*.intergraphsmartcloud.com/*
// @grant        none
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
    function selectCheckboxRange(startCb, endCb, desiredState) {
        const boxes = getVisibleCheckboxes();
        const startIndex = boxes.indexOf(startCb);
        const endIndex = boxes.indexOf(endCb);
        if (startIndex < 0 || endIndex < 0) return;
        const minIndex = Math.min(startIndex, endIndex);
        const maxIndex = Math.max(startIndex, endIndex);
        for (let i = minIndex; i <= maxIndex; i++) {
            setCheckboxState(boxes[i], desiredState);
        }
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
    function clearHiddenColumns() {
        document
            .querySelectorAll('.sdx-qol-hidden-column, .sdx-qol-hidden-orphan-cell')
            .forEach(el => {
                el.classList.remove('sdx-qol-hidden-column');
                el.classList.remove('sdx-qol-hidden-orphan-cell');
            });
    }
    function applyHiddenColumns() {
        clearHiddenColumns();
        const settings = loadSettings();
        const hiddenColumns = settings.hiddenColumns || [];
        const hideOrphanCells = Boolean(settings.hideOrphanCells);
        const headers = getHeaderCells();
        if (headers.length === 0) return;
        const indexesToHide = new Set();
        headers.forEach(header => {
            if (header.isProtected) return;
            const name = normalizeText(header.name);
            if (hiddenColumns.includes(name)) {
                indexesToHide.add(header.index);
                header.el.classList.add('sdx-qol-hidden-column');
            }
        });
        const headerCount = headers.length;
        getGridRows().forEach(row => {
            if (isHeaderRow(row)) return;
            const cells = getDirectCellsForRow(row);
            cells.forEach((cell, index) => {
                const header = headers[index];
                if (header && header.isProtected) return;
                if (indexesToHide.has(index)) {
                    cell.classList.add('sdx-qol-hidden-column');
                }
                if (hideOrphanCells && index >= headerCount) {
                    cell.classList.add('sdx-qol-hidden-orphan-cell');
                }
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
                if (typeof gridWidget.refresh === 'function') {
                    gridWidget.refresh();
                }
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
                if (typeof pagerWidget.refresh === 'function') {
                    pagerWidget.refresh();
                }
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
    function getTokenFromNativeSessionStorage() {
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
                        if (looksLikeJwt(stripped)) return stripped;
                    }
                } catch (innerErr) {
                    const stripped = stripBearerPrefix(raw);
                    if (looksLikeJwt(stripped)) return stripped;
                }
            }
        } catch (err) {
            console.warn('SDx QoL: getTokenFromNativeSessionStorage failed', err);
        }
        return null;
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
    function getSdxAuthToken() {
        return getTokenFromNativeSessionStorage() || getTokenFromReviewerWizard() || null;
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
        if (desired === 100) return; // matches SDx's own default - nothing to restore
        const pagerEl = getLikelyMainPager();
        if (!pagerEl) return;
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
    const gridChangeObserver = new MutationObserver(function () {
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
    //////////////////////////////////////////////////////////////////////
    // MODULE 5
    // FUTURE QUALITY-OF-LIFE ENHANCEMENTS
    //////////////////////////////////////////////////////////////////////
})();
