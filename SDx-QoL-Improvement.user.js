// ==UserScript==
// @name         SDx QoL Improvement
// @namespace    https://burnsmcd.com
// @version      1.1
// @description  SDx quality-of-life improvements: shift-select, keyboard shortcuts, truncated-cell tooltips, session-expiry indicator, column manager (kept out of embedded frames), SDx Kendo page-size control, To Do List row highlighting, and optional auto-close of the To Do List step-details panel.
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
    const SCRIPT_NAME = 'SDx QoL Improvement v1.1';
    const STORAGE_PREFIX = 'sdxQoLSettingsV10';
    const CHECKBOX_SELECTOR = 'input[type="checkbox"].mdc-checkbox__native-control';
    let lastCheckbox = null;
    let lastUrl = location.href;
    let activeTab = 'columns';
    // Row/page-size control is click-only.
    // It does not hide rows and does not run automatically on page load.
    let lastAppliedPageSize = null;
    const MANAGER = {
        buttonId: 'sdx-qol-manager-button',
        menuId: 'sdx-qol-manager-menu',
        styleId: 'sdx-qol-manager-style'
    };
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
    // MODULE 4
    // PAGE REFRESH HANDLER
    //////////////////////////////////////////////////////////////////////
    function applyGridCustomizations() {
        // Column hiding is allowed to auto-apply.
        applyHiddenColumns();
        applyTruncationTooltips();
        // No-ops on any page other than the To Do List.
        applyRowHighlighting();
        maybeSuppressStepDetailsPanel();
    }
    function refreshQoL() {
        injectStyles();
        injectManagerButton();
        injectSessionButton();
        applyGridCustomizations();
        if (location.href !== lastUrl) {
            lastUrl = location.href;
            closeManagerMenu();
            // Do not auto-apply page size on navigation.
            // User applies row/page-size manually from the Rows tab.
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
