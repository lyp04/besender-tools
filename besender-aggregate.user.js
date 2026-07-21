// ==UserScript==
// @name         BESENDER 良品/不良品聚合统计
// @namespace    https://bms.besender.com/
// @version      1.9.1
// @description  在型号列表页勾选多个型号汇总良品/不良品/总和，良品数可点 ▶ 展开 A/B/C 类等级明细；在型号详情页一键查看当日/区间统计；在头程入库列表页按公司+预计到达时间窗+机型/SKU 反查在途/入库中订单的物料，可展开查看每单 ETA 并跳转详情；在 DOA / 维修(RP) 管理页按日期统计「完成」订单数量(公司沿用页面筛选)，可勾选同时统计另一类型得到 DOA+RP 合计。中国时间自动换算为本地时区，悬停显示原始中国时间。切换站内小标签页时面板及查询结果保留在内存中，仅在手动关闭面板或刷新页面时清空。
// @author       YupengLai
// @match        *://bms.besender.com/bsd-warehouse/*
// @run-at       document-idle
// @grant        none
// @updateURL    https://raw.githubusercontent.com/lyp04/besender-tools/main/besender-aggregate.user.js
// @downloadURL  https://raw.githubusercontent.com/lyp04/besender-tools/main/besender-aggregate.user.js
// ==/UserScript==

// Co-authored by Claude (Anthropic) — AI-assisted development

(function () {
  'use strict';

  // ── Constants ───────────────────────────────────────────────────────────

  const STYLE_ID  = 'bsd-agg-style';
  const FAB_ID    = 'bsd-agg-fab';
  const PANEL_ID  = 'bsd-agg-panel';
  const TIP_ID    = 'bsd-agg-tooltip';
  const TIME_CLS  = 'bsd-agg-time';   // marker class on rewritten time spans
  const TIME_RE   = /(\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2})/g;

  const SERVER_TZ = 'Asia/Shanghai';  // server stores timestamps in this timezone

  // Page-2 row `status` field (workflow):
  //   1 待审核 / 2 可用 / 3 作废 / 4 待确认 / 5 已审核
  // Rows with status === 3 are admin-voided data entries (data-entry retractions)
  // and are excluded from the totals — they aren't a production outcome.
  const STATUS_VOID = 3;
  // 良品/不良品 classification doesn't use any top-level `result` field — it
  // walks the row for any value shaped like {sku, name, num} (template-defined
  // dynamic key) and decides by whether sku is empty. See isDefective().

  // Endpoint paths (under the same origin)
  const API = {
    manageList:        '/retreadOptimized/getRetreadManageList',
    retreadAll:        '/retreadOptimized/retreadDataListNoPage',
    inboundList:       '/warehouse/warehouse/inboundOrderList',
    inboundDetail:     '/warehouse/warehouse/getInboundOrder',
    orderList:         '/engineer/afterSale/orderList',  // DOA + 维修(RP) 共用
  };

  // ── Page routing ────────────────────────────────────────────────────────

  function pageKind() {
    const p = location.pathname + location.hash;
    if (/\/single\/refurbish(\b|$)/.test(p))           return 'list';
    if (/\/single\/retreadDetail(\b|$)/.test(p))       return 'detail';
    // head_entry_detail is intentionally not aggregable — the panel only opens on the list page.
    if (/\/in_order\/head_entry_detail(\b|$)/.test(p)) return 'other';
    if (/\/in_order\/head_entry(\b|$)/.test(p))        return 'inbound';
    if (/\/engineerDoa(\b|$)/.test(p))                 return 'doa';
    if (/\/engineerRepair(\b|$)/.test(p))              return 'rp';
    return 'other';
  }

  // Identity under which a panel is retained across SPA inner-tab switches.
  // Same key ⇒ the same panel (with its results) is restored when the user
  // returns. Detail pages get a finer key so each model keeps its own panel.
  function panelKey() {
    const k = pageKind();
    if (k === 'detail') {
      const p = new URLSearchParams(location.search);
      return 'detail:' + (p.get('warehouse_id') || '') + ':' + (p.get('manage_id') || '');
    }
    return k;
  }

  // ── Time helpers ────────────────────────────────────────────────────────

  // Parse a "YYYY-MM-DD HH:mm:ss" string interpreted in Asia/Shanghai → Date (UTC instant).
  // The server uses China time without offset, so we compute the corresponding UTC instant manually.
  function parseServerTime(str) {
    const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/.exec(String(str || '').trim());
    if (!m) return null;
    const [_, Y, Mo, D, h, mi, s] = m.map(Number);
    // Asia/Shanghai is fixed UTC+8 (no DST). UTC instant = local time minus 8 hours.
    return new Date(Date.UTC(Y, Mo - 1, D, h - 8, mi, s));
  }

  // Format a Date instant in a given IANA timezone as "YYYY-MM-DD HH:mm:ss".
  function fmtInTZ(date, tz) {
    if (!(date instanceof Date) || isNaN(date)) return '';
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      hour12: false,
    }).formatToParts(date);
    const get = (t) => (parts.find(p => p.type === t) || {}).value || '';
    let hour = get('hour'); if (hour === '24') hour = '00';
    return `${get('year')}-${get('month')}-${get('day')} ${hour}:${get('minute')}:${get('second')}`;
  }

  function systemTZ() {
    try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; }
    catch (_) { return 'UTC'; }
  }

  // Timezone the user is viewing the data in. Persisted across page loads.
  const TZ_STORAGE_KEY = 'bsd-agg-tz';
  const TZ_OPTIONS = [
    ['美东',     'America/New_York'],
    ['美中',     'America/Chicago'],
    ['美西',     'America/Los_Angeles'],
    ['德国',     'Europe/Berlin'],
    ['澳大利亚', 'Australia/Sydney'],
    ['中国',     'Asia/Shanghai'],
  ];
  let userTZ = (() => {
    try { return localStorage.getItem(TZ_STORAGE_KEY) || ''; }
    catch (_) { return ''; }
  })();
  function localTZ() { return userTZ || systemTZ(); }
  function setUserTZ(tz) {
    userTZ = tz || '';
    try {
      if (userTZ) localStorage.setItem(TZ_STORAGE_KEY, userTZ);
      else        localStorage.removeItem(TZ_STORAGE_KEY);
    } catch (_) {}
  }
  function buildTzOptionsHtml() {
    const sys = systemTZ();
    const list = TZ_OPTIONS.map(([label, tz]) => ({ label, tz }));
    if (!list.find(o => o.tz === sys)) {
      list.unshift({ label: `系统 (${sys})`, tz: sys });
    }
    const selected = localTZ();
    return list.map(o =>
      `<option value="${escapeHtml(o.tz)}"${o.tz === selected ? ' selected' : ''}>${escapeHtml(o.label)}</option>`
    ).join('');
  }
  // Re-render every already-decorated <span class="bsd-agg-time"> when the
  // active timezone changes.
  function relabelDecoratedTimes() {
    const tz = localTZ();
    document.querySelectorAll('.' + TIME_CLS).forEach(el => {
      const china = el.dataset.china;
      if (!china) return;
      const utc = parseServerTime(china);
      el.textContent = utc ? fmtInTZ(utc, tz) : china;
      el.dataset.localTz = tz;
    });
  }

  // For a local-calendar date "YYYY-MM-DD" return [chinaStartStr, chinaEndStr] covering that
  // 24-hour window. Returned strings are in server format "YYYY-MM-DD HH:mm:ss" (Asia/Shanghai).
  function localDateToChinaRange(localDateStr) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(localDateStr).trim());
    if (!m) return null;
    const [, Y, Mo, D] = m.map(Number);
    // Build the local-day UTC bounds.
    const tz = localTZ();
    // Strategy: compute the UTC instant of local midnight by trial: use Date and TZ offset at that day.
    // We construct a "naive" date at midnight in the local TZ via Intl reverse-lookup.
    const localStartUTC = localWallToUTC(Y, Mo, D, 0, 0, 0, tz);
    const localEndUTC   = new Date(localStartUTC.getTime() + 24 * 3600 * 1000 - 1000); // -1s to stay within the day
    return [fmtInTZ(localStartUTC, SERVER_TZ), fmtInTZ(localEndUTC, SERVER_TZ)];
  }

  // Given wall-clock components in an IANA timezone, return the corresponding UTC Date.
  // Robust to DST.
  function localWallToUTC(Y, Mo, D, h, mi, s, tz) {
    // First guess: assume the wall-clock equals UTC, then correct by the offset of that guess.
    const guess = new Date(Date.UTC(Y, Mo - 1, D, h, mi, s));
    const offsetMin = getTZOffsetMinutes(guess, tz);
    const corrected = new Date(guess.getTime() - offsetMin * 60 * 1000);
    // One more pass in case the guess crossed a DST boundary.
    const offsetMin2 = getTZOffsetMinutes(corrected, tz);
    if (offsetMin2 !== offsetMin) {
      return new Date(guess.getTime() - offsetMin2 * 60 * 1000);
    }
    return corrected;
  }

  // Get offset (in minutes, positive = ahead of UTC) of an instant in a given timezone.
  function getTZOffsetMinutes(instant, tz) {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      hour12: false,
    }).formatToParts(instant);
    const get = (t) => Number((parts.find(p => p.type === t) || {}).value || 0);
    let hour = get('hour'); if (hour === 24) hour = 0;
    const wall = Date.UTC(get('year'), get('month') - 1, get('day'), hour, get('minute'), get('second'));
    return Math.round((wall - instant.getTime()) / 60000);
  }

  function localTodayStr() {
    const tz = localTZ();
    const now = new Date();
    return fmtInTZ(now, tz).slice(0, 10);
  }

  // DOA/RP pages already display and filter timestamps in the browser's local
  // timezone. Their default date must therefore ignore the timezone persisted
  // by the other (China-time) statistics panels. Otherwise, a user who selected
  // Asia/Shanghai there can open DOA/RP in America and default to tomorrow.
  function pageLocalTodayStr() {
    return fmtInTZ(new Date(), systemTZ()).slice(0, 10);
  }

  // Shift a local-calendar date "YYYY-MM-DD" by `days` and return the new
  // local-calendar date string, in the user's active timezone.
  function localDateOffset(localDateStr, days) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(localDateStr || '').trim());
    if (!m) return localDateStr;
    const tz   = localTZ();
    const utc  = localWallToUTC(+m[1], +m[2], +m[3], 0, 0, 0, tz);
    const next = new Date(utc.getTime() + days * 24 * 3600 * 1000);
    return fmtInTZ(next, tz).slice(0, 10);
  }

  // ── Styles ──────────────────────────────────────────────────────────────

  function injectStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const css = `
      #${FAB_ID} {
        position: fixed;
        right: 18px;
        bottom: 18px;
        z-index: 99998;
        background: #2d8cf0;
        color: #fff;
        font-size: 13px;
        font-weight: 600;
        padding: 10px 16px;
        border-radius: 24px;
        box-shadow: 0 4px 16px rgba(45,140,240,0.35);
        cursor: pointer;
        user-select: none;
        transition: transform .15s ease, box-shadow .2s ease;
      }
      #${FAB_ID}:hover { transform: translateY(-1px); box-shadow: 0 6px 22px rgba(45,140,240,0.45); }

      #${PANEL_ID} {
        position: fixed;
        right: 18px;
        bottom: 70px;
        z-index: 99999;
        width: 480px;
        max-width: calc(100vw - 36px);
        max-height: calc(100vh - 100px);
        background: #fff;
        border-radius: 12px;
        box-shadow: 0 12px 36px rgba(0,0,0,0.25);
        display: flex;
        flex-direction: column;
        overflow: hidden;
        font-size: 13px;
        color: #2c3e50;
      }
      #${PANEL_ID} header {
        display: flex; align-items: center; gap: 8px;
        padding: 12px 14px; border-bottom: 1px solid #eee; background: #fafafa;
      }
      #${PANEL_ID} header .title { font-weight: 700; font-size: 14px; flex: 1; }
      #${PANEL_ID} header .close {
        cursor: pointer; padding: 2px 8px; border-radius: 4px; color: #888;
      }
      #${PANEL_ID} header .close:hover { background: #eee; color: #333; }

      #${PANEL_ID} .body { flex: 1; overflow-y: auto; padding: 12px 14px; }
      #${PANEL_ID} .body::-webkit-scrollbar { width: 6px; }
      #${PANEL_ID} .body::-webkit-scrollbar-thumb { background: #ddd; border-radius: 3px; }

      #${PANEL_ID} footer {
        display: flex; flex-direction: column; align-items: stretch; gap: 10px;
        padding: 10px 14px; border-top: 1px solid #eee; background: #fafafa;
      }
      #${PANEL_ID} .date-controls {
        display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
      }
      #${PANEL_ID} .date-fields {
        display: flex; align-items: center; gap: 6px;
      }
      #${PANEL_ID} .mode-tabs {
        display: inline-flex; border: 1px solid #d0d4dc; border-radius: 4px; overflow: hidden;
      }
      #${PANEL_ID} .mode-tab {
        padding: 4px 10px; font-size: 12px; color: #666; background: #fff;
        border: none; cursor: pointer; outline: none;
      }
      #${PANEL_ID} .mode-tab + .mode-tab { border-left: 1px solid #d0d4dc; }
      #${PANEL_ID} .mode-tab.active { background: #2d8cf0; color: #fff; }
      #${PANEL_ID} .footer-actions {
        display: flex; align-items: center; gap: 8px; justify-content: flex-end;
      }
      #${PANEL_ID} footer label.date-label { font-size: 12px; color: #666; }
      #${PANEL_ID} input[type="date"], #${PANEL_ID} .tz-select {
        padding: 5px 8px; border: 1px solid #ddd; border-radius: 4px;
        font-size: 13px; color: #333; background: #fff;
      }
      #${PANEL_ID} .btn {
        padding: 6px 14px; border-radius: 4px; border: 1px solid #2d8cf0;
        background: #2d8cf0; color: #fff; font-weight: 600; cursor: pointer;
        font-size: 13px;
      }
      #${PANEL_ID} .btn.ghost { background: #fff; color: #2d8cf0; }
      #${PANEL_ID} .btn:disabled { opacity: 0.5; cursor: not-allowed; }

      #${PANEL_ID} .model-row {
        display: flex; align-items: center; gap: 8px;
        padding: 5px 4px; border-bottom: 1px dashed #f0f0f0;
      }
      #${PANEL_ID} .model-row:last-child { border-bottom: none; }
      #${PANEL_ID} .model-row .sku  { color: #2d8cf0; min-width: 150px; font-family: ui-monospace, monospace; font-size: 12px; }
      #${PANEL_ID} .model-row .name { flex: 1; }
      #${PANEL_ID} .model-row .audit { color: #888; font-size: 12px; }

      #${PANEL_ID} table.summary {
        width: 100%; border-collapse: collapse; margin-top: 8px; font-size: 12.5px;
      }
      #${PANEL_ID} table.summary th, #${PANEL_ID} table.summary td {
        padding: 6px 8px; border-bottom: 1px solid #eee; text-align: left;
      }
      #${PANEL_ID} table.summary th { background: #f5f7fa; font-weight: 600; }
      #${PANEL_ID} table.summary tr.total td { background: #fff7e6; font-weight: 700; }
      #${PANEL_ID} table.summary tr.err-row td { background: #fff7ed; }
      #${PANEL_ID} table.summary td.good  { color: #19be6b; font-weight: 600; }
      #${PANEL_ID} table.summary td.bad   { color: #ed4014; font-weight: 600; }
      #${PANEL_ID} table.summary td.rate  { color: #515a6e; font-weight: 600; text-align: right; }
      #${PANEL_ID} .err-tag { color: #ed4014; cursor: help; margin-left: 4px; }

      #${PANEL_ID} .empty    { color: #999;    padding: 12px; text-align: center; }
      #${PANEL_ID} .loading  { color: #2d8cf0; padding: 12px; text-align: center; }
      #${PANEL_ID} .progress { color: #2d8cf0; padding: 10px; text-align: center; font-size: 12.5px; }
      #${PANEL_ID} .error    { color: #ed4014; padding: 8px 12px; background: #fff1f0; border-radius: 4px; }
      #${PANEL_ID} .hint     { color: #888;    font-size: 11.5px; margin-top: 6px; }

      #${PANEL_ID} .search-form {
        display: flex; flex-direction: column; gap: 8px;
        margin: 10px 0; padding: 10px 12px;
        background: #f7f9fc; border: 1px solid #eef1f6; border-radius: 6px;
      }
      #${PANEL_ID} .form-row { display: flex; align-items: center; gap: 8px; }
      #${PANEL_ID} .form-row label {
        min-width: 76px; font-size: 12px; color: #515a6e; font-weight: 600;
      }
      #${PANEL_ID} .form-row input[type="text"] {
        flex: 1; padding: 5px 8px; border: 1px solid #dcdee2; border-radius: 4px;
        font-size: 13px; color: #2c3e50; background: #fff;
      }
      #${PANEL_ID} .form-row.form-hint span {
        color: #999; font-size: 11.5px;
      }

      #${PANEL_ID} .expand-btn {
        background: transparent; border: 1px solid #d0d4dc; padding: 2px 8px;
        border-radius: 4px; cursor: pointer; font-size: 12px; color: #515a6e;
        line-height: 1.4;
      }
      #${PANEL_ID} .expand-btn:hover {
        background: #f0f7ff; color: #2d8cf0; border-color: #2d8cf0;
      }
      #${PANEL_ID} td.good .expand-btn {
        color: #19be6b; font-weight: 600;
      }
      #${PANEL_ID} td.good .expand-btn:hover {
        background: #f0fff5; color: #19be6b; border-color: #19be6b;
      }
      #${PANEL_ID} .expand-btn .caret {
        margin-left: 4px; color: #888; font-size: 10px;
      }
      #${PANEL_ID} tr.detail-row > td {
        padding: 6px 12px 8px; background: #fafbfd;
      }
      #${PANEL_ID} table.sub-table {
        width: 100%; border-collapse: collapse; font-size: 12px;
      }
      #${PANEL_ID} table.sub-table th, #${PANEL_ID} table.sub-table td {
        padding: 4px 8px; border-bottom: 1px solid #eef1f6; text-align: left;
      }
      #${PANEL_ID} table.sub-table th {
        color: #888; font-weight: 600; background: transparent;
      }
      #${PANEL_ID} .order-link {
        background: transparent; border: none; padding: 0; cursor: pointer;
        color: #2d8cf0; font-family: ui-monospace, monospace; font-size: 12px;
        text-decoration: underline;
      }
      #${PANEL_ID} .order-link:hover { color: #1573d9; }

      .${TIME_CLS} {
        border-bottom: 1px dotted #2d8cf0;
        cursor: help;
      }

      #${TIP_ID} {
        position: fixed; z-index: 999999;
        background: rgba(34,34,34,0.95); color: #fff;
        padding: 6px 10px; border-radius: 4px;
        font-size: 12px; line-height: 1.5;
        pointer-events: none;
        max-width: 280px;
        box-shadow: 0 4px 14px rgba(0,0,0,0.3);
        white-space: nowrap;
      }
      #${TIP_ID} .row { display: flex; gap: 8px; }
      #${TIP_ID} .label { color: #aaa; }
    `;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = css;
    document.head.appendChild(style);
  }

  // ── Hook into the page's axios instance ─────────────────────────────────

  function findVueApi() {
    // Vue 2 exposes the root component instance on the mount element.
    // Every component inherits Vue.prototype.$axios and Vue.prototype.api.
    const root = document.querySelector('#app');
    if (!root) return null;
    const vue = root.__vue__;
    if (!vue) return null;
    if (vue.$axios) return { axios: vue.$axios, api: vue.api || null };
    return null;
  }

  // Walk the Vue 2 component tree looking for the page-1 list component, which
  // owns a `query` object holding the user's current search-form filters.
  function findVueComponent(predicate) {
    const root = document.querySelector('#app');
    const start = root && root.__vue__;
    if (!start) return null;
    const queue = [start];
    const seen  = new WeakSet();
    while (queue.length) {
      const c = queue.shift();
      if (!c || seen.has(c)) continue;
      seen.add(c);
      try { if (predicate(c)) return c; } catch (_) {}
      if (c.$children && c.$children.length) queue.push(...c.$children);
    }
    return null;
  }

  function readPage1Query() {
    // Strong predicate: the component must be the one that actually fetches the
    // manage list — i.e. its `getData` (or similar) method references
    // `templateListPage`, OR its currently-loaded rows look like manage rows.
    const comp = findVueComponent(c => {
      if (!c || !c.query || typeof c.query !== 'object') return false;
      // 1) Best: method source mentions templateListPage
      for (const m of ['getData', 'getList', 'getRetreadManageList', 'getTableData']) {
        if (typeof c[m] === 'function' && /templateListPage|getRetreadManageList/.test(String(c[m]))) {
          return true;
        }
      }
      // 2) Fallback: rendered rows look like manage rows
      const rows = c.Data && c.Data.data;
      if (Array.isArray(rows) && rows.length) {
        const r0 = rows[0] || {};
        if ('auditable_quantity' in r0 || 'data_list_count' in r0
            || (r0.product_info && 'sku_name' in r0.product_info)) {
          return true;
        }
      }
      return false;
    });
    if (!comp) return null;
    // Deep-clone primitive/array fields so we can safely mutate later.
    const out = {};
    for (const k of Object.keys(comp.query)) {
      const v = comp.query[k];
      if (v === undefined || v === null || v === '') continue;
      if (Array.isArray(v))           out[k] = v.slice();
      else if (typeof v === 'object') continue;  // skip nested objects, ill-defined
      else                            out[k] = v;
    }
    return out;
  }

  // Mutate params: drop empty values, join array values into comma strings —
  // mirroring the page's own getRetreadDataList logic.
  function flattenParams(params) {
    for (const k of Object.keys(params)) {
      const v = params[k];
      if (v === undefined || v === null || v === '') { delete params[k]; continue; }
      if (Array.isArray(v)) {
        if (v.length === 0) delete params[k];
        else params[k] = v.join(',');
      }
    }
  }

  async function apiGet(path, params) {
    const handle = findVueApi();
    if (handle && handle.axios) {
      const r = await handle.axios.request({ url: path, method: 'get', params });
      // axios returns {data:{data,meta,...}, status}
      return r && r.data ? r.data : null;
    }
    // Fallback: relative fetch with cookies (auth via cookie if available).
    const qs = new URLSearchParams(params || {}).toString();
    const r = await fetch(path + (qs ? '?' + qs : ''), { credentials: 'include' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r.json();
  }

  // ── Floating action button ──────────────────────────────────────────────

  function fabLabelFor(kind) {
    if (kind === 'inbound') return '🔍 物料/机型搜索';
    if (kind === 'doa')     return '📊 DOA 完成统计';
    if (kind === 'rp')      return '📊 RP 完成统计';
    return '📊 良品/不良品聚合';
  }

  function ensureFab() {
    const kind  = pageKind();
    const label = fabLabelFor(kind);
    const existing = document.getElementById(FAB_ID);
    if (existing) {
      if (existing.textContent !== label) existing.textContent = label;
      return;
    }
    const fab = document.createElement('div');
    fab.id = FAB_ID;
    fab.textContent = label;
    fab.addEventListener('click', togglePanel);
    document.body.appendChild(fab);
  }

  // ── Panel persistence ─────────────────────────────────────────────────────
  //
  // Panels are kept alive in memory across SPA inner-tab switches so their query
  // results survive navigation. A panel is discarded only when the user closes it
  // (✕) or the browser reloads the page (in-memory state is wiped on refresh).
  // At most one panel is attached to the DOM at a time — the one matching the
  // current page — so the shared #bsd-agg-panel id (and all its CSS) stays valid;
  // the rest are detached but retained. Detaching/re-attaching a node preserves
  // both its rendered content and its event listeners.
  const livePanels = Object.create(null);

  function registerPanel(panel) {
    livePanels[panelKey()] = panel;
  }

  function destroyPanel(panel) {
    for (const k of Object.keys(livePanels)) {
      if (livePanels[k] === panel) delete livePanels[k];
    }
    panel.remove();
  }

  // Attach the panel belonging to the current page (if one was opened earlier)
  // and detach all others, keeping their references so returning restores them.
  function syncPanelAttachment() {
    const key = isAggregablePage() ? panelKey() : null;
    for (const k of Object.keys(livePanels)) {
      const el = livePanels[k];
      if (!el) { delete livePanels[k]; continue; }
      if (k === key) {
        if (!el.isConnected) document.body.appendChild(el);
      } else if (el.isConnected) {
        el.remove();
      }
    }
  }

  function togglePanel() {
    if (!isAggregablePage()) return;
    const key = panelKey();
    const el  = livePanels[key];
    if (el && el.isConnected) { destroyPanel(el); return; }  // visible → manual close
    if (el) { document.body.appendChild(el); return; }       // alive but detached → restore
    openPanel();                                             // none → build fresh
  }

  function openPanel() {
    const kind = pageKind();
    if (kind === 'inbound') { openInboundPanel(); return; }
    if (kind === 'doa' || kind === 'rp') { openOrderCountPanel(kind); return; }
    const today = localTodayStr();
    const panel = document.createElement('div');
    panel.id = PANEL_ID;
    panel.dataset.panelKind = kind;
    panel.innerHTML = `
      <header>
        <span class="title">${kind === 'list' ? '勾选型号汇总' : (kind === 'detail' ? '当前型号统计' : 'BESENDER 聚合')}</span>
        <span class="close" title="关闭">✕</span>
      </header>
      <div class="body"><div class="loading">加载中…</div></div>
      <footer>
        <div class="date-controls">
          <div class="mode-tabs" role="tablist">
            <button class="mode-tab active" data-mode="single" role="tab">单日</button>
            <button class="mode-tab"        data-mode="range"  role="tab">区间</button>
          </div>
          <div class="date-fields single">
            <label class="date-label">本地日期</label>
            <input type="date" class="date-input" value="${today}">
          </div>
          <div class="date-fields range" style="display:none">
            <label class="date-label">从</label>
            <input type="date" class="date-start" value="${today}">
            <label class="date-label">到</label>
            <input type="date" class="date-end"   value="${today}">
          </div>
          <label class="date-label tz-label">时区</label>
          <select class="tz-select">${buildTzOptionsHtml()}</select>
        </div>
        <div class="footer-actions">
          ${kind === 'list' ? '<button class="btn ghost select-all">全选</button>' : ''}
          <button class="btn run">查询</button>
        </div>
      </footer>
    `;
    panel.querySelector('.close').addEventListener('click', () => destroyPanel(panel));

    // Timezone switcher — affects date interpretation + all decorated timestamps.
    const tzSelect = panel.querySelector('.tz-select');
    tzSelect.addEventListener('change', () => {
      setUserTZ(tzSelect.value);
      relabelDecoratedTimes();
      // Detail panel re-queries automatically (date interpretation changed).
      // List panel keeps the previously-rendered summary until the user clicks 查询 again.
      if (panel.dataset.panelKind === 'detail') {
        panel.querySelector('.run')?.click();
      }
    });

    // Wire mode tabs
    const tabs   = panel.querySelectorAll('.mode-tab');
    const single = panel.querySelector('.date-fields.single');
    const range  = panel.querySelector('.date-fields.range');
    tabs.forEach(t => t.addEventListener('click', () => {
      tabs.forEach(x => x.classList.toggle('active', x === t));
      const m = t.dataset.mode;
      single.style.display = m === 'single' ? '' : 'none';
      range .style.display = m === 'range'  ? '' : 'none';
      panel.dataset.dateMode = m;
    }));
    panel.dataset.dateMode = 'single';

    document.body.appendChild(panel);
    registerPanel(panel);

    if (kind === 'list')        initListPanel(panel);
    else if (kind === 'detail') initDetailPanel(panel);
    else {
      panel.querySelector('.body').innerHTML =
        '<div class="empty">请在「翻新数据管理」(refurbish) 列表页 或 详情页 (retreadDetail) 使用本插件。</div>';
      panel.querySelector('.run').disabled = true;
    }
  }

  // Read the current date selection out of the panel. Returns {label, chinaStart, chinaEnd}
  // where chinaStart/chinaEnd are server-time strings ("YYYY-MM-DD HH:mm:ss").
  function readPanelDateRange(panel) {
    const mode = panel.dataset.dateMode || 'single';
    if (mode === 'single') {
      const d = panel.querySelector('.date-input').value || localTodayStr();
      const r = localDateToChinaRange(d);
      return r ? { label: d, chinaStart: r[0], chinaEnd: r[1] } : null;
    }
    const a = panel.querySelector('.date-start').value;
    const b = panel.querySelector('.date-end').value;
    if (!a || !b) return null;
    const [start] = a <= b ? [a] : [b];
    const [end]   = a <= b ? [b] : [a];
    const r1 = localDateToChinaRange(start);
    const r2 = localDateToChinaRange(end);
    if (!r1 || !r2) return null;
    return { label: `${start} ~ ${end}`, chinaStart: r1[0], chinaEnd: r2[1] };
  }

  // ── List page (page 1) panel ────────────────────────────────────────────

  async function initListPanel(panel) {
    const body  = panel.querySelector('.body');
    const dateI = panel.querySelector('.date-input');
    const run   = panel.querySelector('.run');
    const allBn = panel.querySelector('.select-all');

    let models = [];
    try {
      const liveQuery = readPage1Query();   // mirror the user's current filters
      const baseParams = Object.assign({ status: 1 }, liveQuery || {});
      flattenParams(baseParams);
      delete baseParams.page; delete baseParams.limit;
      // Paginate through results when the filtered total exceeds one page.
      const PAGE_SIZE = 200;
      const first = await apiGet(API.manageList, Object.assign({}, baseParams, { page: 1, limit: PAGE_SIZE }));
      if (first && first.code && first.code !== 200) {
        body.innerHTML = `<div class="error">获取型号列表失败：${escapeHtml(first.cn_message || first.message || ('code ' + first.code))}</div>`;
        return;
      }
      let rows = (first && first.data) || [];
      const total = Number(first && first.meta && first.meta.total) || rows.length;
      const pages = Math.ceil(total / PAGE_SIZE);
      if (pages > 1) {
        const tasks = [];
        for (let p = 2; p <= pages; p++) {
          tasks.push(apiGet(API.manageList, Object.assign({}, baseParams, { page: p, limit: PAGE_SIZE })));
        }
        const more = await Promise.all(tasks);
        more.forEach(r => {
          if (r && r.code && r.code !== 200) {
            console.warn('[BESENDER 聚合] 分页拉取失败', r);
            return;
          }
          if (r && r.data) rows = rows.concat(r.data);
        });
      }
      models = rows.map(r => {
        const p = r.product_info || {};
        return {
          manage_id:    r.id ?? r.manage_id,           // manage list row id IS the manage_id
          warehouse_id: r.warehouse_id,
          sku:          r.sku || p.sku || '',
          // Display label for the 型号 column — prefer the model code (e.g. "S1-White")
          // over the full product name (e.g. "Skyrover S1 White").
          model:        p.model || r.model || '',
          productName:  p.sku_name || p.en_sku_name || p.cn_sku_name || '',
          auditable:    r.auditable_quantity ?? r.data_list_count ?? '',
        };
      }).filter(m => m.manage_id && m.warehouse_id);
    } catch (err) {
      console.error('[BESENDER 聚合] 获取型号列表失败', err);
      body.innerHTML = `<div class="error">获取型号列表失败：${err.message || err}</div>`;
      return;
    }

    if (!models.length) {
      body.innerHTML = '<div class="empty">未找到任何型号</div>';
      return;
    }

    body.innerHTML = `
      <div class="hint">勾选要汇总的型号，然后选择日期并点「查询」。</div>
      <div class="models"></div>
      <div class="result"></div>
    `;
    const list = body.querySelector('.models');
    models.forEach((m, i) => {
      const row = document.createElement('label');
      row.className = 'model-row';
      row.innerHTML = `
        <input type="checkbox" data-i="${i}">
        <span class="sku">${escapeHtml(m.sku)}</span>
        <span class="name" title="${escapeHtml(m.productName || '')}">${escapeHtml(m.model || m.productName || m.sku)}</span>
        <span class="audit">可审核 ${m.auditable}</span>
      `;
      list.appendChild(row);
    });

    allBn.addEventListener('click', () => {
      const boxes = list.querySelectorAll('input[type=checkbox]');
      const allOn = Array.from(boxes).every(b => b.checked);
      boxes.forEach(b => { b.checked = !allOn; });
    });

    run.addEventListener('click', async () => {
      const chosen = Array.from(list.querySelectorAll('input[type=checkbox]:checked'))
        .map(b => models[Number(b.dataset.i)]);
      if (!chosen.length) {
        flash(body, '请至少勾选一个型号');
        return;
      }
      const range = readPanelDateRange(panel);
      if (!range) {
        flash(body, '日期格式错误');
        return;
      }
      await runAggregate(panel, chosen, range);
    });
  }

  function flash(container, msg) {
    let bar = container.querySelector('.flash');
    if (!bar) {
      bar = document.createElement('div');
      bar.className = 'flash error';
      container.appendChild(bar);
    }
    bar.textContent = msg;
    setTimeout(() => { if (bar) bar.remove(); }, 2400);
  }

  async function runAggregate(panel, models, range) {
    const { label, chinaStart, chinaEnd } = range;
    const result = panel.querySelector('.result') || panel.querySelector('.body');
    result.innerHTML = `<div class="loading">查询 ${models.length} 个型号 (${escapeHtml(label)}) …</div>`;

    const totals = { good: 0, bad: 0, all: 0, grades: newGradeTally() };
    const rows = [];
    for (const m of models) {
      try {
        const resp = await apiGet(API.retreadAll, {
          warehouse_id: m.warehouse_id,
          manage_id:    m.manage_id,
          start:        chinaStart,
          end:          chinaEnd,
        });
        // Success responses are {code: 200, message: "Success", data: [...]};
        // errors are e.g. {code: 30006, message: "...", cn_message: "..."} with
        // no `data`. Anything with code != 200 is a failure for that row only.
        if (resp && resp.code && resp.code !== 200) {
          rows.push({ model: m, good: 0, bad: 0, all: 0, grades: newGradeTally(),
                      error: resp.cn_message || resp.message || ('code ' + resp.code) });
          continue;
        }
        const data = (resp && resp.data) || [];
        const c = classify(data);
        rows.push({ model: m, ...c });
        totals.good += c.good;
        totals.bad  += c.bad;
        totals.all  += c.all;
        addGrades(totals.grades, c.grades);
      } catch (err) {
        console.error('[BESENDER 聚合] 查询失败', m, err);
        rows.push({ model: m, good: 0, bad: 0, all: 0, grades: newGradeTally(),
                    error: err.message || String(err) });
      }
    }

    renderSummary(result, rows, label, chinaStart, chinaEnd, totals);
  }

  // The 翻新结果 field is a template-defined dynamic key shaped like
  // {sku, name, num}. First matching object in the row decides — shared by
  // the 良品/不良品 judgement and the A/B/C grade bucketing.
  function resultObjectOf(row) {
    if (!row || typeof row !== 'object') return null;
    for (const k of Object.keys(row)) {
      const v = row[k];
      if (v && typeof v === 'object' && !Array.isArray(v)
          && 'sku' in v && 'name' in v && 'num' in v) {
        return v;
      }
    }
    return null;
  }

  // A row is 不良品 iff its 翻新结果 object has an empty `sku`.
  function isDefective(row) {
    const v = resultObjectOf(row);
    if (v) {
      if (!v.sku) return true;
      if (typeof v.name === 'string' && /defective/i.test(v.name)) return true;
      return false;
    }
    // Fallback: scan the row JSON for the literal "Defective item" string.
    try { return /\bDefective item\b/.test(JSON.stringify(row)); }
    catch (_) { return false; }
  }

  // 良品等级：翻新结果名称形如 "T2351黑色A类-九五成" / "…-B类-九成" / "…-C类-五成"。
  // 捕获等级字母及其成色后缀（若有），如 {grade:'B', label:'B类-九成'}。
  const GRADE_KEYS = ['A', 'B', 'C'];
  const GRADE_RE = /([ABCabc])\s*类(?:\s*[-－—]?\s*([一-龥]{1,4}成))?/;
  function gradeOf(row) {
    const v = resultObjectOf(row);
    if (!v || typeof v.name !== 'string') return null;
    const m = GRADE_RE.exec(v.name);
    if (!m) return null;
    const grade = m[1].toUpperCase();
    return { grade, label: grade + '类' + (m[2] ? '-' + m[2] : '') };
  }

  function newGradeTally() {
    // labels: 每个等级第一次见到的完整标签（含成色后缀），用于展示。
    return { A: 0, B: 0, C: 0, other: 0, labels: {} };
  }
  function addGrades(into, from) {
    for (const g of GRADE_KEYS) into[g] += from[g];
    into.other += from.other;
    for (const g of Object.keys(from.labels)) {
      if (!into.labels[g]) into.labels[g] = from.labels[g];
    }
  }

  function classify(rows) {
    // 不良品 IS the scrap output in the user's mental model. Workflow-voided
    // entries (status === 3) are data-entry retractions / admin noise — excluded
    // from production totals entirely.
    let good = 0, bad = 0;
    const grades = newGradeTally();
    for (const r of rows) {
      if (r.status === STATUS_VOID) continue;
      if (isDefective(r)) { bad++; continue; }
      good++;
      const g = gradeOf(r);
      if (g) {
        grades[g.grade]++;
        if (!grades.labels[g.grade]) grades.labels[g.grade] = g.label;
      } else {
        grades.other++;
      }
    }
    return { good, bad, all: good + bad, grades };
  }

  function fmtRate(n, d) {
    if (!d) return '—';
    return (n / d * 100).toFixed(1) + '%';
  }

  // 良品数字 + 下拉小箭头（good = 0 时不给箭头，展开也没内容可看）。
  // idx 与下方 gradeDetailRowHtml 的 data-parent-idx 配对，复用 onResultClick
  // 的展开/收起逻辑。
  function gradeToggleHtml(idx, good) {
    if (!(good > 0)) return String(good);
    return `<button type="button" class="expand-btn" data-idx="${idx}" title="展开查看 A/B/C 类明细">${good} <span class="caret">▶</span></button>`;
  }

  // 展开后显示的 A/B/C 类明细行。A/B/C 恒显示（含 0，便于确认没有产出）；
  // 名称里无等级标记的良品记为「未标注等级」，仅在 >0 时显示。
  function gradeDetailRowHtml(idx, grades, good, colspan) {
    const g = grades || newGradeTally();
    const line = (lab, n) =>
      `<tr><td>${escapeHtml(lab)}</td><td class="good">${n}</td><td class="rate">${fmtRate(n, good)}</td></tr>`;
    const lines = GRADE_KEYS.map(k => line(g.labels[k] || (k + '类'), g[k])).join('')
      + (g.other > 0 ? line('未标注等级', g.other) : '');
    return `
      <tr class="detail-row" data-parent-idx="${idx}" style="display:none">
        <td colspan="${colspan}">
          <table class="sub-table">
            <thead><tr><th>良品等级</th><th>数量</th><th>占良品</th></tr></thead>
            <tbody>${lines}</tbody>
          </table>
        </td>
      </tr>`;
  }

  function renderSummary(container, rows, label, chinaStart, chinaEnd, totals) {
    const tz = localTZ();
    // Hide rows with zero production. Always keep error rows visible so the
    // user knows a query failed. Single-row contexts (detail page) skip the
    // filter — useful to confirm "查到 0" rather than show an empty table.
    const isSingleRow = rows.length <= 1;
    const visibleRows = isSingleRow ? rows : rows.filter(r => r.error || r.all > 0);
    const hiddenCount = rows.length - visibleRows.length;
    const errorRows   = visibleRows.filter(r => r.error);

    if (!visibleRows.length) {
      container.innerHTML = `
        <div class="hint">
          本地 <b>${escapeHtml(label)}</b> (${escapeHtml(tz)}) 对应中国时间窗口：
          <b>${escapeHtml(chinaStart)}</b> ~ <b>${escapeHtml(chinaEnd)}</b>
        </div>
        <div class="empty">所选 ${rows.length} 个型号在该时段均无产出</div>
      `;
      return;
    }

    container.innerHTML = `
      <div class="hint">
        本地 <b>${escapeHtml(label)}</b> (${escapeHtml(tz)}) 对应中国时间窗口：
        <b>${escapeHtml(chinaStart)}</b> ~ <b>${escapeHtml(chinaEnd)}</b><br>
        点「良品」数字旁的 ▶ 展开 A/B/C 类明细。
      </div>
      <table class="summary">
        <thead>
          <tr>
            <th>SKU</th><th>型号</th>
            <th title="翻新结果可用，非 Defective。点数字展开 A/B/C 类明细">良品</th>
            <th title="翻新结果为 Defective item — 即报废件">不良品</th>
            <th title="良品 + 不良品（不含工作流作废的录入）">总和</th>
            <th title="不良品 / 总和">报废率</th>
          </tr>
        </thead>
        <tbody>
          ${visibleRows.map((r, i) => `
            <tr${r.error ? ' class="err-row"' : ''}>
              <td>${escapeHtml(r.model.sku)}</td>
              <td title="${escapeHtml(r.model.productName || '')}">${escapeHtml(r.model.model || r.model.productName || r.model.sku)}</td>
              <td class="good">${gradeToggleHtml(i, r.good)}</td>
              <td class="bad">${r.bad}</td>
              <td>${r.all}${r.error ? ' <span class="err-tag" title="' + escapeHtml(r.error) + '">⚠</span>' : ''}</td>
              <td class="rate">${fmtRate(r.bad, r.all)}</td>
            </tr>
            ${r.good > 0 ? gradeDetailRowHtml(i, r.grades, r.good, 6) : ''}
          `).join('')}
          <tr class="total">
            <td colspan="2">合计 (${hiddenCount > 0 ? `${visibleRows.length} 有产出 / 共 ${rows.length}` : `${visibleRows.length} 个型号`})</td>
            <td class="good">${gradeToggleHtml('total', totals.good)}</td>
            <td class="bad">${totals.bad}</td>
            <td>${totals.all}</td>
            <td class="rate">${fmtRate(totals.bad, totals.all)}</td>
          </tr>
          ${totals.good > 0 ? gradeDetailRowHtml('total', totals.grades, totals.good, 6) : ''}
        </tbody>
      </table>
      ${errorRows.length ? `<div class="error" style="margin-top:8px">${errorRows.length} 个型号查询失败（鼠标放在 ⚠ 上看原因）</div>` : ''}
    `;

    // 展开/收起用与头程入库面板相同的 onResultClick（具名函数，重复
    // addEventListener 会被 DOM 去重，不会叠加触发）。
    container.addEventListener('click', onResultClick);
  }

  // ── Detail page (page 2) panel ──────────────────────────────────────────

  async function initDetailPanel(panel) {
    const body  = panel.querySelector('.body');
    const run   = panel.querySelector('.run');

    const params = new URLSearchParams(location.search);
    const warehouse_id = params.get('warehouse_id');
    const manage_id    = params.get('manage_id');
    const sku          = params.get('sku') || '';
    const modelCode    = params.get('model') || '';
    const productName  = params.get('name') || '';

    if (!warehouse_id || !manage_id) {
      body.innerHTML = '<div class="error">URL 缺少 warehouse_id 或 manage_id 参数，无法查询。</div>';
      run.disabled = true;
      return;
    }

    const model = { sku, model: modelCode, productName, manage_id, warehouse_id, auditable: '' };

    async function refresh() {
      const range = readPanelDateRange(panel);
      if (!range) { body.innerHTML = '<div class="error">日期格式错误</div>'; return; }
      body.innerHTML = `<div class="loading">查询 ${escapeHtml(sku || manage_id)} (${escapeHtml(range.label)}) …</div>`;
      try {
        const resp = await apiGet(API.retreadAll, {
          warehouse_id, manage_id,
          start: range.chinaStart,
          end:   range.chinaEnd,
        });
        if (resp && resp.code && resp.code !== 200) {
          body.innerHTML = `<div class="error">${escapeHtml(resp.cn_message || resp.message || ('code ' + resp.code))}</div>`;
          return;
        }
        const data = (resp && resp.data) || [];
        const c = classify(data);
        renderSummary(body, [{ model, ...c }], range.label, range.chinaStart, range.chinaEnd, c);
      } catch (err) {
        console.error('[BESENDER 聚合] 查询失败', err);
        body.innerHTML = `<div class="error">查询失败：${escapeHtml(err.message || String(err))}</div>`;
      }
    }

    run.addEventListener('click', refresh);
    panel.querySelectorAll('.date-input, .date-start, .date-end, .mode-tab')
      .forEach(el => el.addEventListener('change', refresh));
    refresh();
  }

  // ── Inbound page (头程入库) material/model lookup ───────────────────────

  function openInboundPanel() {
    const today  = localTodayStr();
    const inOneWeek = localDateOffset(today, 7);
    const panel = document.createElement('div');
    panel.id = PANEL_ID;
    panel.dataset.panelKind = 'inbound';
    panel.innerHTML = `
      <header>
        <span class="title">头程入库 - 物料/机型搜索</span>
        <span class="close" title="关闭">✕</span>
      </header>
      <div class="body">
        <div class="hint">
          选择<b>公司</b>，再输入<b>机型</b>（2080 / 2280 / 2351 / 2353，2352 物料计入 2353）<i>或</i> <b>SKU/产品名</b>，
          脚本会拉取该公司<b>在途 + 入库中</b>的头程入库订单详情并聚合命中物料。
        </div>
        <div class="search-form">
          <div class="form-row">
            <label>公司</label>
            <select class="company-select">${buildCompanyOptionsHtml()}</select>
          </div>
          <div class="form-row">
            <label>预计到达</label>
            <input type="date" class="eta-start" value="${today}">
            <span style="color:#888">~</span>
            <input type="date" class="eta-end"   value="${inOneWeek}">
            <button type="button" class="btn ghost eta-clear" style="padding:4px 8px;font-size:12px">不限</button>
          </div>
          <div class="form-row">
            <label>机型</label>
            <input type="text" class="model-input" placeholder="如 2353" autocomplete="off">
          </div>
          <div class="form-row">
            <label>SKU/产品名</label>
            <input type="text" class="sku-input" placeholder="如 T2353_雷达盖-售后 / MR_20002003205（支持部分匹配）" autocomplete="off">
          </div>
          <div class="form-row form-hint">
            <span>机型与 SKU 两项至少填一项。预计到达默认<b>一周内</b>；订单无「预计入库时间」时按「创建时间 + 40 天」估算。「不限」清空时间窗口。</span>
          </div>
        </div>
        <div class="result"></div>
      </div>
      <footer>
        <div class="footer-actions">
          <button class="btn search-btn">搜索</button>
        </div>
      </footer>
    `;
    panel.querySelector('.close').addEventListener('click', () => destroyPanel(panel));
    panel.querySelector('.eta-clear').addEventListener('click', () => {
      panel.querySelector('.eta-start').value = '';
      panel.querySelector('.eta-end').value   = '';
    });
    document.body.appendChild(panel);
    registerPanel(panel);
    initInboundPanel(panel);
  }

  // Pull the cached company list out of the page's Vuex store. Falls back to []
  // if the store shape changes; the panel still renders, just without options.
  function getCompanyList() {
    try {
      const root = document.querySelector('#app');
      const vue  = root && root.__vue__;
      const list = vue && vue.$store && vue.$store.state
                && vue.$store.state.user && vue.$store.state.user.companyList;
      return Array.isArray(list) ? list : [];
    } catch (_) { return []; }
  }

  function buildCompanyOptionsHtml() {
    const list = getCompanyList();
    if (!list.length) {
      // No companyList means user filter won't work — fall back to all orders.
      return '<option value="">（公司列表未加载，搜索全部）</option>';
    }
    const sorted = list.slice().sort((a, b) =>
      String(a.company || a.cn_company || '').localeCompare(String(b.company || b.cn_company || '')));
    return sorted.map(c => {
      const id = c.id;
      const label = c.company || c.cn_company || ('公司 ' + id);
      const isAnker = /^anker$/i.test(c.company || '');
      return `<option value="${id}"${isAnker ? ' selected' : ''}>${escapeHtml(label)}</option>`;
    }).join('');
  }

  function initInboundPanel(panel) {
    const body          = panel.querySelector('.body');
    const result        = panel.querySelector('.result');
    const companySelect = panel.querySelector('.company-select');
    const etaStartInput = panel.querySelector('.eta-start');
    const etaEndInput   = panel.querySelector('.eta-end');
    const modelInput    = panel.querySelector('.model-input');
    const skuInput      = panel.querySelector('.sku-input');
    const runBtn        = panel.querySelector('.search-btn');

    result.innerHTML = '<div class="empty">请选择公司并输入机型或 SKU 后点击「搜索」</div>';

    async function run() {
      const model = modelInput.value.trim();
      const sku   = skuInput.value.trim();
      if (!model && !sku) { flash(body, '请输入机型或 SKU'); return; }

      const companyId    = companySelect.value;
      const companyLabel =
        (companySelect.options[companySelect.selectedIndex] || {}).textContent || '所选公司';
      const etaStart = etaStartInput.value || '';
      const etaEnd   = etaEndInput.value   || '';
      const { startMs, endMs } = etaWindow(etaStart, etaEnd);
      const etaActive = startMs != null || endMs != null;

      runBtn.disabled = true;
      try {
        result.innerHTML = '<div class="loading">读取订单列表…</div>';
        // Mirror the page's own list filters (keyword, …) and then force the
        // two filters this feature requires:
        //   - user_id: the selected company
        //   - status:  in-transit (2) + in-storage (3); finished/cancelled
        //              orders carry no live inventory so we exclude them.
        // The API rejects array `status` (returns 500) — must be CSV string.
        // ETA filtering is done client-side (the API has no expect_in_time
        // filter, and we need the +40d fallback for orders without ETA).
        const liveQuery = readInboundPageQuery() || {};
        if (companyId) liveQuery.user_id = Number(companyId);
        else           delete liveQuery.user_id;
        liveQuery.status = '2,3';
        // Drop any page-mirrored date filter — our ETA filter replaces it.
        delete liveQuery.start; delete liveQuery.end; delete liveQuery.time_type;

        let allOrders;
        try {
          allOrders = await fetchAllInboundOrders(liveQuery);
        } catch (err) {
          console.error('[BESENDER 物料搜索] 列表失败', err);
          result.innerHTML = `<div class="error">获取订单列表失败：${escapeHtml(err.message || String(err))}</div>`;
          return;
        }
        if (!allOrders.length) {
          result.innerHTML = `<div class="empty">${escapeHtml(companyLabel)} 名下没有在途/入库中订单</div>`;
          return;
        }

        // Apply ETA window filter (if any).
        let orders = allOrders;
        if (etaActive) {
          orders = allOrders.filter(o => {
            const ts = expectedArrivalTs(o);
            if (ts == null) return false;
            if (startMs != null && ts < startMs) return false;
            if (endMs   != null && ts > endMs)   return false;
            return true;
          });
        }
        if (!orders.length) {
          const windowLabel = etaActive
            ? `预计到达 ${escapeHtml(etaStart || '不限')} ~ ${escapeHtml(etaEnd || '不限')}`
            : '当前条件';
          result.innerHTML = `<div class="empty">${escapeHtml(companyLabel)} 共 ${allOrders.length} 个在途/入库中订单，${windowLabel} 内为 0 单</div>`;
          return;
        }

        result.innerHTML = `<div class="progress">查询 ${escapeHtml(companyLabel)} 订单详情 0/${orders.length}…</div>`;
        const matches = [];
        const failed  = [];
        let processed = 0;
        const CONCURRENCY = 5;
        const queue = orders.slice();
        const fetchOne = async (ord) => {
          try {
            const resp = await apiGet(API.inboundDetail, { id: ord.id });
            if (resp && resp.code && resp.code !== 200) {
              failed.push({ ord, reason: resp.cn_message || resp.message || ('code ' + resp.code) });
              return;
            }
            const detail = (resp && resp.data) || resp || {};
            const items  = extractInboundItems(detail);
            for (const it of items) {
              const matched = model ? itemMatchesModel(it, model)
                                    : itemMatchesSku(it, sku);
              if (matched) matches.push({ order: ord, item: it });
            }
          } catch (err) {
            console.error('[BESENDER 物料搜索] 详情失败', ord.order_no, err);
            failed.push({ ord, reason: err.message || String(err) });
          } finally {
            processed++;
            const prog = result.querySelector('.progress');
            if (prog) prog.textContent = `查询 ${companyLabel} 订单详情 ${processed}/${orders.length}…`;
          }
        };
        const workers = [];
        for (let i = 0; i < CONCURRENCY; i++) {
          workers.push((async function worker() {
            while (queue.length) {
              const ord = queue.shift();
              await fetchOne(ord);
            }
          })());
        }
        await Promise.all(workers);
        renderInboundMatches(result, matches, {
          model, sku,
          company:     companyLabel,
          totalOrders: orders.length,
          totalBefore: allOrders.length,
          etaActive,  etaStart, etaEnd,
          failedCount: failed.length,
        });
      } finally {
        runBtn.disabled = false;
      }
    }

    runBtn.addEventListener('click', run);
    [modelInput, skuInput].forEach(el => el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); run(); }
    }));
  }

  // Mirror the page's own list filters (date range, status, keyword …) so the
  // search runs against the same set of orders the user is currently viewing.
  function readInboundPageQuery() {
    const comp = findVueComponent(c => {
      if (!c || !c.query || typeof c.query !== 'object') return false;
      // Strong: a fetch method that references the inbound list endpoint.
      for (const m of ['getData', 'getList', 'getOrderList', 'getTableData', 'init']) {
        if (typeof c[m] === 'function' && /inboundOrderList/.test(String(c[m]))) {
          return true;
        }
      }
      // Fallback: rendered rows look like inbound orders.
      const rows = c.Data && c.Data.data;
      if (Array.isArray(rows) && rows.length) {
        const r0 = rows[0] || {};
        if ('order_no' in r0 && /^IB/.test(String(r0.order_no || ''))) return true;
        if ('done_boxes' in r0 || 'total_boxes' in r0 || 'express_no' in r0) return true;
      }
      return false;
    });
    if (!comp) return null;
    const out = {};
    for (const k of Object.keys(comp.query)) {
      const v = comp.query[k];
      if (v === undefined || v === null || v === '') continue;
      if (Array.isArray(v))           out[k] = v.slice();
      else if (typeof v === 'object') continue;
      else                            out[k] = v;
    }
    return out;
  }

  async function fetchAllInboundOrders(baseQuery) {
    const params = Object.assign({}, baseQuery || {});
    flattenParams(params);
    delete params.page; delete params.limit;
    const PAGE_SIZE = 200;
    const first = await apiGet(API.inboundList, Object.assign({}, params, { page: 1, limit: PAGE_SIZE }));
    if (first && first.code && first.code !== 200) {
      throw new Error(first.cn_message || first.message || ('code ' + first.code));
    }
    let rows = (first && first.data) || [];
    const total = Number(first && first.meta && first.meta.total) || rows.length;
    const pages = Math.ceil(total / PAGE_SIZE);
    if (pages > 1) {
      const tasks = [];
      for (let p = 2; p <= pages; p++) {
        tasks.push(apiGet(API.inboundList, Object.assign({}, params, { page: p, limit: PAGE_SIZE })));
      }
      const more = await Promise.all(tasks);
      more.forEach(r => {
        if (r && r.code && r.code !== 200) {
          console.warn('[BESENDER 物料搜索] 分页拉取失败', r);
          return;
        }
        if (r && r.data) rows = rows.concat(r.data);
      });
    }
    return rows;
  }

  // Expected arrival time for an inbound order, in milliseconds since epoch.
  // Priority: explicit expect_in_time (date-only string like "2026-04-15", or a
  // full datetime) — fallback to created_at + 40 days when the user hasn't set
  // one. Returns null if neither field is parseable (such orders won't pass
  // any ETA window filter).
  const ETA_FALLBACK_DAYS = 40;
  function expectedArrivalTs(order) {
    const raw = order && order.expect_in_time;
    if (raw) {
      const s = String(raw).trim();
      const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
      const norm = dateOnly ? `${dateOnly[1]}-${dateOnly[2]}-${dateOnly[3]} 12:00:00` : s;
      const t = parseServerTime(norm);
      if (t) return t.getTime();
    }
    if (order && order.created_at) {
      const c = parseServerTime(order.created_at);
      if (c) return c.getTime() + ETA_FALLBACK_DAYS * 24 * 3600 * 1000;
    }
    return null;
  }

  // Build a [startMs, endMs] window from two local-calendar dates ("YYYY-MM-DD"),
  // interpreted as [start 00:00:00, end 23:59:59] in the user's active TZ.
  // Either side may be empty — that side becomes unbounded.
  function etaWindow(startStr, endStr) {
    const tz = localTZ();
    let startMs = null, endMs = null;
    if (startStr) {
      const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(startStr);
      if (m) startMs = localWallToUTC(+m[1], +m[2], +m[3], 0, 0, 0, tz).getTime();
    }
    if (endStr) {
      const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(endStr);
      if (m) endMs = localWallToUTC(+m[1], +m[2], +m[3], 23, 59, 59, tz).getTime();
    }
    return { startMs, endMs };
  }

  // The detail response nests items inside packages[].items[]; each item also
  // carries a nested `sku_info` that mirrors `sku`/`sku_name` (for the product
  // catalog row). A naive walker would collect both — leading to double counts.
  // We only accept nodes that carry a real quantity field, which uniquely
  // identifies the item row and excludes the catalog mirror.
  function extractInboundItems(detail) {
    const QTY_KEYS = ['quantity', 'request_num', 'confirm_num', 'receive_quantity'];
    const out  = [];
    const seen = new WeakSet();
    function walk(node) {
      if (!node || typeof node !== 'object' || seen.has(node)) return;
      seen.add(node);
      if (Array.isArray(node)) { node.forEach(walk); return; }
      const hasSku = 'sku' in node && node.sku != null && node.sku !== '';
      const hasQty = QTY_KEYS.some(k => k in node && node[k] != null);
      if (hasSku && hasQty) out.push(node);
      for (const k of Object.keys(node)) {
        const v = node[k];
        if (v && typeof v === 'object') walk(v);
      }
    }
    walk(detail);
    return out;
  }

  function productNameOf(item) {
    const info = item.sku_info || {};
    // Real items expose sku_name directly; sku_info carries the catalog mirror
    // (cn_sku_name / en_sku_name) — prefer the cn/en variants when present
    // so the displayed name matches the page UI.
    return info.cn_sku_name || info.en_sku_name
        || item.cn_sku_name || item.en_sku_name
        || item.sku_name    || item.product_name || '';
  }

  // Match by 4-digit machine model code embedded in the product name or SKU.
  // The convention in this catalog is `T<model>` (e.g. T2353_雷达盖-售后).
  // Special case requested by user: 2353 also matches 2352 物料.
  function itemMatchesModel(item, model) {
    const hay = (productNameOf(item) + ' ' + (item.sku || '')).toLowerCase();
    const m = String(model).trim();
    if (!m) return false;
    const patterns = m === '2353' ? ['2353', '2352'] : [m];
    return patterns.some(p => hay.includes('t' + p));
  }

  function itemMatchesSku(item, query) {
    const q = String(query).trim().toLowerCase();
    if (!q) return false;
    const sku  = String(item.sku || '').toLowerCase();
    const name = productNameOf(item).toLowerCase();
    return sku.includes(q) || name.includes(q);
  }

  function quantityRequest(item) {
    const v = item.request_num != null ? item.request_num
            : item.quantity    != null ? item.quantity
            : 0;
    return Number(v) || 0;
  }
  function quantityConfirm(item) {
    const v = item.confirm_num      != null ? item.confirm_num
            : item.receive_quantity != null ? item.receive_quantity
            : 0;
    return Number(v) || 0;
  }

  function renderInboundMatches(container, matches, ctx) {
    const { model, sku, company, totalOrders, totalBefore,
            etaActive, etaStart, etaEnd, failedCount } = ctx;
    const queryLabel = model
      ? `机型 <b>${escapeHtml(model)}</b>${model === '2353' ? '（含 2352）' : ''}`
      : `SKU/产品名 <b>${escapeHtml(sku)}</b>`;
    const companyTag = company ? `<b>${escapeHtml(company)}</b>` : '所选公司';
    const etaTag = etaActive
      ? `预计到达 <b>${escapeHtml(etaStart || '不限')} ~ ${escapeHtml(etaEnd || '不限')}</b>`
      : `预计到达 <b>不限</b>`;
    const scopeTag = etaActive && totalBefore !== totalOrders
      ? `${totalOrders} 单（${etaTag}，从 ${totalBefore} 单筛得）`
      : `${totalOrders} 个在途/入库中订单（${etaTag}）`;

    if (!matches.length) {
      container.innerHTML = `
        <div class="hint">${queryLabel}：在 ${companyTag} 的 ${scopeTag} 中未找到匹配物料。</div>
        ${failedCount ? `<div class="error" style="margin-top:8px">${failedCount} 个订单查询失败（详见 console）</div>` : ''}
      `;
      return;
    }

    // Aggregate by SKU; keep the underlying per-order rows so the user can
    // expand each SKU to see which order it's coming from + ETA.
    const bySku = new Map();
    for (const { order, item } of matches) {
      const key = item.sku || productNameOf(item) || 'unknown';
      let e = bySku.get(key);
      if (!e) {
        e = { sku: item.sku || '', name: productNameOf(item),
              req: 0, conf: 0, orders: new Set(), entries: [] };
        bySku.set(key, e);
      }
      const req  = quantityRequest(item);
      const conf = quantityConfirm(item);
      e.req  += req;
      e.conf += conf;
      e.orders.add(order.order_no || order.id);
      e.entries.push({
        orderId:    order.id,
        orderNo:    order.order_no || String(order.id),
        statusCode: order.status,
        etaMs:      expectedArrivalTs(order),
        expectIn:   order.expect_in_time || null,
        createdAt:  order.created_at || null,
        req, conf,
      });
    }
    const rows  = Array.from(bySku.values()).sort((a, b) => b.req - a.req);
    rows.forEach(r => r.entries.sort((a, b) => (a.etaMs || 0) - (b.etaMs || 0)));
    const total = { req: 0, conf: 0, orders: new Set() };
    rows.forEach(r => {
      total.req  += r.req;
      total.conf += r.conf;
      r.orders.forEach(o => total.orders.add(o));
    });

    const statusLabel = (s) => s === 2 ? '在途' : s === 3 ? '入库中' : '';
    const fmtEntryEta = (e) => {
      if (e.expectIn) {
        // expect_in_time can be date-only ("2026-04-15") or full datetime.
        const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(e.expectIn).trim());
        if (dateOnly) return `${dateOnly[1]}-${dateOnly[2]}-${dateOnly[3]} (预计)`;
        const t = parseServerTime(e.expectIn);
        return t ? `${fmtInTZ(t, localTZ()).slice(0, 10)} (预计)` : `${escapeHtml(e.expectIn)} (预计)`;
      }
      if (e.etaMs != null) {
        return `${fmtInTZ(new Date(e.etaMs), localTZ()).slice(0, 10)} (估)`;
      }
      return '—';
    };

    container.innerHTML = `
      <div class="hint">${queryLabel}：在 ${companyTag} 的 ${scopeTag} 中，命中 ${total.orders.size} 个订单 / ${rows.length} 个 SKU。<br>点击「订单数」列展开查看每单的预计到达时间，订单号可点击跳转详情。</div>
      <table class="summary">
        <thead>
          <tr><th>SKU</th><th>产品名称</th><th>申请总数</th><th>确认总数</th><th>订单数</th></tr>
        </thead>
        <tbody>
          ${rows.map((r, i) => `
            <tr class="sku-row" data-idx="${i}">
              <td>${escapeHtml(r.sku)}</td>
              <td title="${escapeHtml(r.name)}">${escapeHtml(r.name)}</td>
              <td class="good">${r.req}</td>
              <td>${r.conf}</td>
              <td><button type="button" class="expand-btn" data-idx="${i}">${r.orders.size} <span class="caret">▶</span></button></td>
            </tr>
            <tr class="detail-row" data-parent-idx="${i}" style="display:none">
              <td colspan="5">
                <table class="sub-table">
                  <thead><tr><th>订单号</th><th>状态</th><th>预计到达</th><th>申请</th><th>确认</th></tr></thead>
                  <tbody>
                    ${r.entries.map(e => `
                      <tr>
                        <td><button type="button" class="order-link" data-order-id="${e.orderId}" title="跳转到该订单详情">${escapeHtml(e.orderNo)}</button></td>
                        <td>${escapeHtml(statusLabel(e.statusCode))}</td>
                        <td>${fmtEntryEta(e)}</td>
                        <td>${e.req}</td>
                        <td>${e.conf}</td>
                      </tr>
                    `).join('')}
                  </tbody>
                </table>
              </td>
            </tr>
          `).join('')}
          <tr class="total">
            <td colspan="2">合计 (${rows.length} 个 SKU)</td>
            <td class="good">${total.req}</td>
            <td>${total.conf}</td>
            <td>${total.orders.size}</td>
          </tr>
        </tbody>
      </table>
      ${failedCount ? `<div class="error" style="margin-top:8px">${failedCount} 个订单查询失败（详见 console）</div>` : ''}
    `;

    // Event delegation: expand toggle + order-detail jump.
    container.addEventListener('click', onResultClick);
  }

  function onResultClick(e) {
    const expandBtn = e.target.closest('.expand-btn');
    if (expandBtn) {
      const idx    = expandBtn.dataset.idx;
      const detail = expandBtn.closest('table')
        .querySelector(`tr.detail-row[data-parent-idx="${idx}"]`);
      if (!detail) return;
      const opening = detail.style.display === 'none';
      detail.style.display = opening ? '' : 'none';
      const caret = expandBtn.querySelector('.caret');
      if (caret) caret.textContent = opening ? '▼' : '▶';
      return;
    }
    const orderBtn = e.target.closest('.order-link');
    if (orderBtn) {
      const oid = orderBtn.dataset.orderId;
      if (!oid) return;
      // Mirror the page's own row-click handler: stash the id in sessionStorage
      // and let Vue Router transition to the detail route.
      try { sessionStorage.setItem('headInboundDetailId', oid); } catch (_) {}
      try {
        const v = document.querySelector('#app').__vue__;
        if (v && v.$router) { v.$router.push({ path: 'head_entry_detail' }); return; }
      } catch (_) {}
      location.href = '/bsd-warehouse/in_order/head_entry_detail';
    }
  }

  // ── Page-2 timestamp decoration (China time → local + hover tooltip) ────

  function decorateTimestamps(scope) {
    // DOA / 维修(RP) 页面展示的时间本身就是本地时间，不能再按中国时间换算装饰；
    // 这里直接跳过(兼顾从其它页面 SPA 跳转过来后仍在运行的旧 observer)。
    const pk = pageKind();
    if (pk === 'doa' || pk === 'rp') return;
    // Walk text nodes inside scope; wrap any "YYYY-MM-DD HH:mm:ss" in a span.
    // We mark each rewritten parent with data-bsd-decorated so we don't reprocess it.
    const root = scope || document.body;
    if (!root || root.nodeType !== 1) return;

    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (!node.nodeValue || !TIME_RE.test(node.nodeValue)) {
          TIME_RE.lastIndex = 0;
          return NodeFilter.FILTER_REJECT;
        }
        TIME_RE.lastIndex = 0;
        const p = node.parentNode;
        if (!p || p.nodeType !== 1) return NodeFilter.FILTER_REJECT;
        if (p.closest && p.closest(`#${PANEL_ID}, #${FAB_ID}, #${TIP_ID}`)) {
          return NodeFilter.FILTER_REJECT;
        }
        const tn = p.tagName;
        if (tn === 'SCRIPT' || tn === 'STYLE' || tn === 'TEXTAREA' || tn === 'INPUT') {
          return NodeFilter.FILTER_REJECT;
        }
        if (p.classList && p.classList.contains(TIME_CLS)) return NodeFilter.FILTER_REJECT;
        if (p.dataset && p.dataset.bsdDecorated === '1') return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    });

    const targets = [];
    while (walker.nextNode()) targets.push(walker.currentNode);

    const tz = localTZ();
    for (const node of targets) {
      const text = node.nodeValue;
      const frag = document.createDocumentFragment();
      let last = 0;
      let any  = false;
      text.replace(TIME_RE, (match, _g, idx) => {
        if (idx > last) frag.appendChild(document.createTextNode(text.slice(last, idx)));
        const utc   = parseServerTime(match);
        const local = utc ? fmtInTZ(utc, tz) : match;
        const span  = document.createElement('span');
        span.className   = TIME_CLS;
        span.dataset.china = match;
        span.dataset.localTz = tz;
        span.textContent = local;
        frag.appendChild(span);
        last = idx + match.length;
        any  = true;
      });
      TIME_RE.lastIndex = 0;
      if (!any) continue;
      if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
      const p = node.parentNode;
      if (p) {
        p.replaceChild(frag, node);
        if (p.dataset) p.dataset.bsdDecorated = '1';
      }
    }
  }

  function attachTimeTooltip() {
    if (document.getElementById(TIP_ID)) return;
    const tip = document.createElement('div');
    tip.id = TIP_ID;
    tip.style.display = 'none';
    document.body.appendChild(tip);

    function show(el, ev) {
      const china = el.dataset.china || '';
      const tz    = el.dataset.localTz || localTZ();
      tip.innerHTML = `
        <div class="row"><span class="label">中国时间</span><span>${escapeHtml(china)}</span></div>
        <div class="row"><span class="label">本地 (${escapeHtml(tz)})</span><span>${escapeHtml(el.textContent)}</span></div>
      `;
      tip.style.display = 'block';
      move(ev);
    }
    function move(ev) {
      const pad = 14;
      let x = ev.clientX + pad;
      let y = ev.clientY + pad;
      const r = tip.getBoundingClientRect();
      if (x + r.width  > window.innerWidth)  x = ev.clientX - r.width  - pad;
      if (y + r.height > window.innerHeight) y = ev.clientY - r.height - pad;
      tip.style.left = x + 'px';
      tip.style.top  = y + 'px';
    }
    function hide() { tip.style.display = 'none'; }

    document.addEventListener('mouseover', (ev) => {
      const el = ev.target && ev.target.closest && ev.target.closest('.' + TIME_CLS);
      if (el) show(el, ev);
    });
    document.addEventListener('mousemove', (ev) => {
      if (tip.style.display === 'block') move(ev);
    });
    document.addEventListener('mouseout', (ev) => {
      const el = ev.target && ev.target.closest && ev.target.closest('.' + TIME_CLS);
      if (el && (!ev.relatedTarget || !ev.relatedTarget.closest('.' + TIME_CLS))) hide();
    });
  }

  function watchForTimestamps() {
    decorateTimestamps(document.body);
    let pending = null;
    const observer = new MutationObserver((mutations) => {
      if (pending) return;
      pending = setTimeout(() => {
        pending = null;
        for (const mu of mutations) {
          if (mu.type === 'childList') {
            mu.addedNodes.forEach(n => {
              if (n.nodeType === 1) decorateTimestamps(n);
              else if (n.nodeType === 3) {
                if (TIME_RE.test(n.nodeValue || '')) decorateTimestamps(n.parentNode || document.body);
                TIME_RE.lastIndex = 0;
              }
            });
          } else if (mu.type === 'characterData') {
            const t = mu.target;
            if (t && TIME_RE.test(t.nodeValue || '')) decorateTimestamps(t.parentNode || document.body);
            TIME_RE.lastIndex = 0;
          }
        }
      }, 120);
    });
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
  }

  // ── Misc helpers ────────────────────────────────────────────────────────

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  // ── DOA / 维修(RP) 完成订单统计 ─────────────────────────────────────────
  //
  // engineerDoa 与 engineerRepair 列表页共用 /engineer/afterSale/orderList。
  // 面板按页面本地日期（单日/区间）直接构造查询窗口，统计「完成」状态订单数量；
  // 公司及关键字等条件沿用页面顶部自带的搜索筛选（读取其 query）。
  // DOA 页可勾选「同时统计 RP」、RP 页可勾选「同时统计 DOA」，给出 DOA+RP 合计。

  // 订单工作流状态：'1' 进行中 / '2' 完成。本功能始终统计「完成」。
  const OC_STATUS_DONE = '2';
  // time_type：'2' 完成时间(本功能固定按完成时间统计)。
  const OC_TIME_COMPLETION = '2';
  // 各页订单类型筛选(取自各自页面 query 对象)。
  const OC_TYPE = {
    doa: { type: '15' },
    rp:  { type_arr: '1,2', is_child: 0 },
  };
  const OC_LABEL = { doa: 'DOA', rp: 'RP（维修）' };

  // DOA/RP 的时间是本地时间、与页面自带筛选口径一致，所以日期直接构造
  // [00:00:00, 23:59:59] 窗口，不做任何时区换算。返回 {label, start, end}。
  function readOrderDateRange(panel) {
    const mode = panel.dataset.dateMode || 'single';
    if (mode === 'single') {
      const d = panel.querySelector('.date-input').value;
      if (!d) return null;
      return { label: d, start: d + ' 00:00:00', end: d + ' 23:59:59' };
    }
    const a = panel.querySelector('.date-start').value;
    const b = panel.querySelector('.date-end').value;
    if (!a || !b) return null;
    const s = a <= b ? a : b;
    const e = a <= b ? b : a;
    return { label: `${s} ~ ${e}`, start: s + ' 00:00:00', end: e + ' 23:59:59' };
  }

  function openOrderCountPanel(kind) {
    const today = pageLocalTodayStr();
    const other = kind === 'doa' ? 'rp' : 'doa';
    const panel = document.createElement('div');
    panel.id = PANEL_ID;
    panel.dataset.panelKind = kind;
    panel.dataset.dateMode  = 'single';
    panel.innerHTML = `
      <header>
        <span class="title">${OC_LABEL[kind]} 完成统计</span>
        <span class="close" title="关闭">✕</span>
      </header>
      <div class="body"><div class="empty">选择日期后点「查询」。公司及其余条件沿用页面顶部筛选，状态固定为「完成」。</div></div>
      <footer>
        <div class="date-controls">
          <div class="mode-tabs" role="tablist">
            <button class="mode-tab active" data-mode="single" role="tab">单日</button>
            <button class="mode-tab"        data-mode="range"  role="tab">区间</button>
          </div>
          <div class="date-fields single">
            <label class="date-label">日期</label>
            <input type="date" class="date-input" value="${today}">
          </div>
          <div class="date-fields range" style="display:none">
            <label class="date-label">从</label>
            <input type="date" class="date-start" value="${today}">
            <label class="date-label">到</label>
            <input type="date" class="date-end"   value="${today}">
          </div>
        </div>
        <div class="footer-actions">
          <label class="date-label" style="display:flex;align-items:center;gap:4px;cursor:pointer">
            <input type="checkbox" class="cross-cb"> 同时统计 ${OC_LABEL[other]}
          </label>
          <span style="flex:1"></span>
          <button class="btn run">查询</button>
        </div>
      </footer>
    `;
    panel.querySelector('.close').addEventListener('click', () => destroyPanel(panel));

    // 单日 / 区间 切换。
    const tabs   = panel.querySelectorAll('.mode-tab');
    const single = panel.querySelector('.date-fields.single');
    const range  = panel.querySelector('.date-fields.range');
    tabs.forEach(t => t.addEventListener('click', () => {
      tabs.forEach(x => x.classList.toggle('active', x === t));
      const m = t.dataset.mode;
      single.style.display = m === 'single' ? '' : 'none';
      range .style.display = m === 'range'  ? '' : 'none';
      panel.dataset.dateMode = m;
    }));

    panel.querySelector('.run').addEventListener('click', () => runOrderCount(panel, kind));
    document.body.appendChild(panel);
    registerPanel(panel);
  }

  // 读取当前 engineerDoa / engineerRepair 列表组件的 query(含页面顶部 公司=user_id
  // 及关键字等用户已设的筛选)。返回浅拷贝；找不到则返回 null。
  function readOrderPageQuery() {
    const comp = findVueComponent(c => {
      if (!c || !c.query || typeof c.query !== 'object') return false;
      for (const m of ['getData', 'getList', 'getTableData']) {
        if (typeof c[m] === 'function' && /orderList/.test(String(c[m]))) return true;
      }
      const q = c.query;
      return ('user_id' in q) && ('status' in q) && (('type' in q) || ('type_arr' in q));
    });
    if (!comp) return null;
    const out = {};
    for (const k of Object.keys(comp.query)) {
      const v = comp.query[k];
      if (v === undefined || v === null || v === '') continue;
      if (Array.isArray(v))           out[k] = v.slice();
      else if (typeof v === 'object') continue;
      else                            out[k] = v;
    }
    return out;
  }

  function companyNameById(id) {
    if (id === '' || id == null) return '全部公司';
    const found = getCompanyList().find(c => String(c.id) === String(id));
    return found ? (found.company || found.cn_company || ('公司 ' + id)) : ('公司 ' + id);
  }

  // 统计某一类型在页面本地时间窗口内的「完成」订单数：沿用页面筛选，强制覆盖
  // { status:完成, time_type, start, end, 类型字段 }，page/limit 仅取 meta.total。
  async function countOrders(kind, baseQuery, timeType, winStart, winEnd) {
    const params = Object.assign({}, baseQuery);
    delete params.type; delete params.type_arr; delete params.is_child; // 类型按 kind 重设
    // service_type is an RP-only filter. Carrying it into a cross-page DOA
    // request can silently filter every DOA order out.
    if (kind === 'doa') delete params.service_type;
    delete params.page; delete params.limit;
    Object.assign(params, OC_TYPE[kind], {
      status:    OC_STATUS_DONE,
      time_type: timeType,
      start:     winStart,
      end:       winEnd,
      page:      1,
      limit:     1,
    });
    const resp = await apiGet(API.orderList, params);
    if (!resp || typeof resp !== 'object') {
      throw new Error('统计接口返回为空');
    }
    if (resp.code != null && Number(resp.code) !== 200) {
      throw new Error(resp.cn_message || resp.message || ('统计接口错误（code ' + resp.code + '）'));
    }
    const rawTotal = resp.meta && resp.meta.total;
    const total = Number(rawTotal);
    if (rawTotal !== undefined && rawTotal !== null && rawTotal !== ''
        && Number.isFinite(total) && total >= 0) return total;
    // This request deliberately uses limit=1, so data.length cannot represent
    // the total when pagination metadata is missing. Fail visibly instead of
    // reporting a plausible but incorrect 0 or 1.
    throw new Error('统计接口缺少有效的 meta.total');
  }

  async function runOrderCount(panel, kind) {
    const body    = panel.querySelector('.body');
    const run     = panel.querySelector('.run');
    const crossCb = panel.querySelector('.cross-cb');

    const dr = readOrderDateRange(panel);   // 日期直接用，不做时区换算
    if (!dr) { flash(body, '请选择有效日期'); return; }

    const base = readOrderPageQuery();
    if (!base) {
      flash(body, '未找到页面筛选条件，请等列表加载完成后重试');
      return;
    }
    flattenParams(base);
    const companyId    = base.user_id != null ? base.user_id : '';
    const companyLabel = companyNameById(companyId);
    const timeType  = OC_TIME_COMPLETION;   // 口径固定为完成时间
    const alsoOther = !!(crossCb && crossCb.checked);
    const other     = kind === 'doa' ? 'rp' : 'doa';

    run.disabled = true;
    body.innerHTML = '<div class="loading">查询中…</div>';
    try {
      const counts = { doa: null, rp: null };
      counts[kind] = await countOrders(kind, base, timeType, dr.start, dr.end);
      if (alsoOther) {
        counts[other] = await countOrders(other, base, timeType, dr.start, dr.end);
      }
      renderOrderCount(body, { dr, companyLabel, timeType, counts });
    } catch (err) {
      console.error('[BESENDER 完成统计] 查询失败', err);
      body.innerHTML = `<div class="error">查询失败：${escapeHtml(err.message || String(err))}</div>`;
    } finally {
      run.disabled = false;
    }
  }

  function renderOrderCount(container, o) {
    const rows = [];
    if (o.counts.doa != null) rows.push(['DOA', o.counts.doa]);
    if (o.counts.rp  != null) rows.push(['RP（维修）', o.counts.rp]);
    const showTotal = o.counts.doa != null && o.counts.rp != null;
    const total = (o.counts.doa || 0) + (o.counts.rp || 0);
    container.innerHTML = `
      <div class="hint">
        日期 <b>${escapeHtml(o.dr.start)}</b> ~ <b>${escapeHtml(o.dr.end)}</b>（按页面本地时间，不换算）<br>
        公司：<b>${escapeHtml(o.companyLabel)}</b>（沿用页面筛选）｜ 状态：<b>完成</b> ｜ 口径：<b>完成时间</b>
      </div>
      <table class="summary">
        <thead><tr><th>类型</th><th style="text-align:right">完成数量</th></tr></thead>
        <tbody>
          ${rows.map(r => `<tr><td>${escapeHtml(r[0])}</td><td class="rate">${r[1]}</td></tr>`).join('')}
          ${showTotal ? `<tr class="total"><td>合计 (DOA+RP)</td><td class="rate">${total}</td></tr>` : ''}
        </tbody>
      </table>
    `;
  }

  // ── Boot ────────────────────────────────────────────────────────────────

  function isAggregablePage() {
    const k = pageKind();
    return k === 'list' || k === 'detail' || k === 'inbound' || k === 'doa' || k === 'rp';
  }

  function boot() {
    injectStyle();
    if (isAggregablePage()) {
      const k = pageKind();
      ensureFab();
      // 时间换算装饰只用于「中国时间」页面；DOA/RP 的时间已是本地时间，跳过。
      if (k !== 'doa' && k !== 'rp') {
        attachTimeTooltip();
        watchForTimestamps();
      }
    } else {
      // Remove FAB if user navigated away inside the SPA.
      const f = document.getElementById(FAB_ID); if (f) f.remove();
    }
    // Show this page's panel (if one was opened earlier) and hide the rest.
    // Panels are retained in memory, so switching SPA tabs no longer drops
    // results — a panel clears only on manual ✕ close or a full page reload.
    syncPanelAttachment();
  }

  // Vue SPA: route changes don't reload. Some production router builds retain
  // History methods before this userscript patches them, so History hooks alone
  // miss inner-tab switches (for example DOA → RP). Keep the hooks for immediate
  // updates and add a cheap location watcher as a reliable fallback.
  ;(function watchRoutes(){
    if (window.__bsdAggPatched) return;
    window.__bsdAggPatched = true;
    let lastRoute = location.pathname + location.search + location.hash;
    let pending = null;

    function scheduleBootIfChanged() {
      const nextRoute = location.pathname + location.search + location.hash;
      if (nextRoute === lastRoute) return;
      lastRoute = nextRoute;
      if (pending) clearTimeout(pending);
      pending = setTimeout(() => {
        pending = null;
        boot();
      }, 150);
    }

    for (const k of ['pushState', 'replaceState']) {
      const orig = history[k];
      history[k] = function () {
        const r = orig.apply(this, arguments);
        scheduleBootIfChanged();
        return r;
      };
    }
    window.addEventListener('popstate', scheduleBootIfChanged);
    window.addEventListener('hashchange', scheduleBootIfChanged);
    setInterval(scheduleBootIfChanged, 250);
  })();

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
