// ==UserScript==
// @name         BESENDER 良品/不良品聚合统计
// @namespace    https://bms.besender.com/
// @version      1.7.0
// @description  在型号列表页勾选多个型号汇总良品/不良品/总和；在型号详情页一键查看当日/区间统计；在头程入库列表页按机型/SKU 反查 Anker 头程订单中的物料。中国时间自动换算为本地时区，悬停显示原始中国时间。
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
  };

  // ── Page routing ────────────────────────────────────────────────────────

  function pageKind() {
    const p = location.pathname + location.hash;
    if (/\/single\/refurbish(\b|$)/.test(p))           return 'list';
    if (/\/single\/retreadDetail(\b|$)/.test(p))       return 'detail';
    // head_entry_detail is intentionally not aggregable — the panel only opens on the list page.
    if (/\/in_order\/head_entry_detail(\b|$)/.test(p)) return 'other';
    if (/\/in_order\/head_entry(\b|$)/.test(p))        return 'inbound';
    return 'other';
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

  function togglePanel() {
    const existing = document.getElementById(PANEL_ID);
    if (existing) {
      existing.remove();
      return;
    }
    openPanel();
  }

  function openPanel() {
    const kind = pageKind();
    if (kind === 'inbound') { openInboundPanel(); return; }
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
    panel.querySelector('.close').addEventListener('click', () => panel.remove());

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

    const totals = { good: 0, bad: 0, all: 0 };
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
          rows.push({ model: m, good: 0, bad: 0, all: 0,
                      error: resp.cn_message || resp.message || ('code ' + resp.code) });
          continue;
        }
        const data = (resp && resp.data) || [];
        const c = classify(data);
        rows.push({ model: m, ...c });
        totals.good += c.good;
        totals.bad  += c.bad;
        totals.all  += c.all;
      } catch (err) {
        console.error('[BESENDER 聚合] 查询失败', m, err);
        rows.push({ model: m, good: 0, bad: 0, all: 0, error: err.message || String(err) });
      }
    }

    renderSummary(result, rows, label, chinaStart, chinaEnd, totals);
  }

  // A row is 不良品 iff its 翻新结果 field — a template-defined dynamic key
  // shaped like {sku, name, num} — has an empty `sku`.
  function isDefective(row) {
    if (!row || typeof row !== 'object') return false;
    for (const k of Object.keys(row)) {
      const v = row[k];
      if (v && typeof v === 'object' && !Array.isArray(v)
          && 'sku' in v && 'name' in v && 'num' in v) {
        // First matching result object decides.
        if (!v.sku) return true;
        if (typeof v.name === 'string' && /defective/i.test(v.name)) return true;
        return false;
      }
    }
    // Fallback: scan the row JSON for the literal "Defective item" string.
    try { return /\bDefective item\b/.test(JSON.stringify(row)); }
    catch (_) { return false; }
  }

  function classify(rows) {
    // 不良品 IS the scrap output in the user's mental model. Workflow-voided
    // entries (status === 3) are data-entry retractions / admin noise — excluded
    // from production totals entirely.
    let good = 0, bad = 0;
    for (const r of rows) {
      if (r.status === STATUS_VOID) continue;
      if (isDefective(r)) bad++; else good++;
    }
    return { good, bad, all: good + bad };
  }

  function fmtRate(n, d) {
    if (!d) return '—';
    return (n / d * 100).toFixed(1) + '%';
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
        <b>${escapeHtml(chinaStart)}</b> ~ <b>${escapeHtml(chinaEnd)}</b>
      </div>
      <table class="summary">
        <thead>
          <tr>
            <th>SKU</th><th>型号</th>
            <th title="翻新结果可用，非 Defective">良品</th>
            <th title="翻新结果为 Defective item — 即报废件">不良品</th>
            <th title="良品 + 不良品（不含工作流作废的录入）">总和</th>
            <th title="不良品 / 总和">报废率</th>
          </tr>
        </thead>
        <tbody>
          ${visibleRows.map(r => `
            <tr${r.error ? ' class="err-row"' : ''}>
              <td>${escapeHtml(r.model.sku)}</td>
              <td title="${escapeHtml(r.model.productName || '')}">${escapeHtml(r.model.model || r.model.productName || r.model.sku)}</td>
              <td class="good">${r.good}</td>
              <td class="bad">${r.bad}</td>
              <td>${r.all}${r.error ? ' <span class="err-tag" title="' + escapeHtml(r.error) + '">⚠</span>' : ''}</td>
              <td class="rate">${fmtRate(r.bad, r.all)}</td>
            </tr>
          `).join('')}
          <tr class="total">
            <td colspan="2">合计 (${hiddenCount > 0 ? `${visibleRows.length} 有产出 / 共 ${rows.length}` : `${visibleRows.length} 个型号`})</td>
            <td class="good">${totals.good}</td>
            <td class="bad">${totals.bad}</td>
            <td>${totals.all}</td>
            <td class="rate">${fmtRate(totals.bad, totals.all)}</td>
          </tr>
        </tbody>
      </table>
      ${errorRows.length ? `<div class="error" style="margin-top:8px">${errorRows.length} 个型号查询失败（鼠标放在 ⚠ 上看原因）</div>` : ''}
    `;
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
          输入<b>机型</b>（2080 / 2280 / 2351 / 2353，2352 物料计入 2353）<i>或</i> <b>SKU/产品名</b>，
          脚本会拉取当前筛选下所有 <b>Anker</b> 头程入库订单的详情并聚合命中物料。
        </div>
        <div class="search-form">
          <div class="form-row">
            <label>机型</label>
            <input type="text" class="model-input" placeholder="如 2353" autocomplete="off">
          </div>
          <div class="form-row">
            <label>SKU/产品名</label>
            <input type="text" class="sku-input" placeholder="如 T2353_雷达盖-售后 / MR_20002003205（支持部分匹配）" autocomplete="off">
          </div>
          <div class="form-row form-hint">
            <span>两项至少填一项。同时填写时以「机型」优先。</span>
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
    panel.querySelector('.close').addEventListener('click', () => panel.remove());
    document.body.appendChild(panel);
    initInboundPanel(panel);
  }

  function initInboundPanel(panel) {
    const body       = panel.querySelector('.body');
    const result     = panel.querySelector('.result');
    const modelInput = panel.querySelector('.model-input');
    const skuInput   = panel.querySelector('.sku-input');
    const runBtn     = panel.querySelector('.search-btn');

    result.innerHTML = '<div class="empty">请输入机型或 SKU 后点击「搜索」</div>';

    async function run() {
      const model = modelInput.value.trim();
      const sku   = skuInput.value.trim();
      if (!model && !sku) { flash(body, '请输入机型或 SKU'); return; }

      runBtn.disabled = true;
      try {
        result.innerHTML = '<div class="loading">读取订单列表…</div>';
        const liveQuery = readInboundPageQuery() || {};
        let orders;
        try {
          orders = await fetchAllInboundOrders(liveQuery);
        } catch (err) {
          console.error('[BESENDER 物料搜索] 列表失败', err);
          result.innerHTML = `<div class="error">获取订单列表失败：${escapeHtml(err.message || String(err))}</div>`;
          return;
        }
        const ankerOrders = orders.filter(isAnkerOrder);
        if (!ankerOrders.length) {
          result.innerHTML = `<div class="empty">当前筛选条件下共 ${orders.length} 个订单，未筛出 Anker 订单</div>`;
          return;
        }

        result.innerHTML = `<div class="progress">查询订单详情 0/${ankerOrders.length}…</div>`;
        const matches = [];
        const failed  = [];
        let processed = 0;
        const CONCURRENCY = 5;
        const queue = ankerOrders.slice();
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
            if (prog) prog.textContent = `查询订单详情 ${processed}/${ankerOrders.length}…`;
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
          totalOrders: ankerOrders.length,
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

  function isAnkerOrder(o) {
    const company =
      (o && o.user_info && o.user_info.company) ||
      o.company ||
      o.company_name ||
      '';
    return /anker/i.test(String(company));
  }

  // The detail response nests items inside packages / boxes (shape varies).
  // Walk the tree and collect any object that has both a `sku` and looks
  // item-shaped (has a quantity field or sku_info / sku_name companion).
  function extractInboundItems(detail) {
    const out  = [];
    const seen = new WeakSet();
    function walk(node) {
      if (!node || typeof node !== 'object' || seen.has(node)) return;
      seen.add(node);
      if (Array.isArray(node)) { node.forEach(walk); return; }
      const hasSku  = 'sku' in node && node.sku != null && node.sku !== '';
      const hasMeta = node.sku_info || node.sku_name || node.cn_sku_name || node.en_sku_name
                     || 'quantity' in node || 'request_num' in node
                     || 'confirm_num' in node || 'receive_quantity' in node;
      if (hasSku && hasMeta) out.push(node);
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
    return info.cn_sku_name || info.en_sku_name
        || item.sku_name || item.product_name || item.cn_sku_name || item.en_sku_name || '';
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
    const { model, sku, totalOrders, failedCount } = ctx;
    const queryLabel = model
      ? `机型 <b>${escapeHtml(model)}</b>${model === '2353' ? '（含 2352）' : ''}`
      : `SKU/产品名 <b>${escapeHtml(sku)}</b>`;

    if (!matches.length) {
      container.innerHTML = `
        <div class="hint">${queryLabel}：在 ${totalOrders} 个 Anker 订单中未找到匹配物料。</div>
        ${failedCount ? `<div class="error" style="margin-top:8px">${failedCount} 个订单查询失败（详见 console）</div>` : ''}
      `;
      return;
    }

    // Aggregate by SKU.
    const bySku = new Map();
    for (const { order, item } of matches) {
      const key = item.sku || productNameOf(item) || 'unknown';
      let e = bySku.get(key);
      if (!e) {
        e = { sku: item.sku || '', name: productNameOf(item),
              req: 0, conf: 0, orders: new Set(), orderNos: [] };
        bySku.set(key, e);
      }
      e.req  += quantityRequest(item);
      e.conf += quantityConfirm(item);
      const tag = order.order_no || order.id;
      if (!e.orders.has(tag)) { e.orders.add(tag); e.orderNos.push(tag); }
    }
    const rows  = Array.from(bySku.values()).sort((a, b) => b.req - a.req);
    const total = { req: 0, conf: 0, orders: new Set() };
    rows.forEach(r => {
      total.req  += r.req;
      total.conf += r.conf;
      r.orders.forEach(o => total.orders.add(o));
    });

    container.innerHTML = `
      <div class="hint">${queryLabel}：在 ${totalOrders} 个 Anker 订单中，命中 ${total.orders.size} 个订单 / ${rows.length} 个 SKU</div>
      <table class="summary">
        <thead>
          <tr><th>SKU</th><th>产品名称</th><th>申请总数</th><th>确认总数</th><th>订单数</th></tr>
        </thead>
        <tbody>
          ${rows.map(r => `
            <tr>
              <td>${escapeHtml(r.sku)}</td>
              <td title="${escapeHtml(r.name)}">${escapeHtml(r.name)}</td>
              <td class="good">${r.req}</td>
              <td>${r.conf}</td>
              <td title="${escapeHtml(r.orderNos.join(', '))}">${r.orders.size}</td>
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
  }

  // ── Page-2 timestamp decoration (China time → local + hover tooltip) ────

  function decorateTimestamps(scope) {
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

  // ── Boot ────────────────────────────────────────────────────────────────

  function isAggregablePage() {
    const k = pageKind();
    return k === 'list' || k === 'detail' || k === 'inbound';
  }

  function boot() {
    injectStyle();
    if (isAggregablePage()) {
      ensureFab();
      attachTimeTooltip();
      watchForTimestamps();
      // Close a stale panel if the user moved between page kinds (e.g. retread → inbound).
      const open = document.getElementById(PANEL_ID);
      if (open && open.dataset.panelKind && open.dataset.panelKind !== pageKind()) {
        open.remove();
      }
    } else {
      // Remove FAB if user navigated away inside the SPA.
      const f = document.getElementById(FAB_ID); if (f) f.remove();
      const p = document.getElementById(PANEL_ID); if (p) p.remove();
    }
  }

  // Vue SPA: route changes don't reload — listen for both popstate and pushState.
  ;(function patchHistory(){
    if (window.__bsdAggPatched) return;
    window.__bsdAggPatched = true;
    for (const k of ['pushState', 'replaceState']) {
      const orig = history[k];
      history[k] = function () {
        const r = orig.apply(this, arguments);
        window.dispatchEvent(new Event('bsd-route'));
        return r;
      };
    }
    window.addEventListener('popstate', () => window.dispatchEvent(new Event('bsd-route')));
  })();

  window.addEventListener('bsd-route', () => setTimeout(boot, 300));
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
