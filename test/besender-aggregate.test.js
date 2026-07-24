'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const sourcePath = path.join(__dirname, '..', 'besender-aggregate.user.js');
const source = fs.readFileSync(sourcePath, 'utf8');

function loadHooks({
  response = null,
  responses = null,
  rootVue = null,
  pathname = '/bsd-warehouse/engineerRepair',
  apiHandler = null,
} = {}) {
  const apiStub = `  async function apiGet(path, params) {
    globalThis.__lastApiCall = { path, params };
    globalThis.__apiCalls = globalThis.__apiCalls || [];
    globalThis.__apiCalls.push({ path, params });
    if (globalThis.__apiHandler) return globalThis.__apiHandler(path, params);
    return globalThis.__apiResponses ? globalThis.__apiResponses.shift() : globalThis.__apiResponse;
  }

  // ── Floating action button`;

  let instrumented = source.replace(
    /  async function apiGet\(path, params\) \{[\s\S]*?\n  \}\n\n  \/\/ ── Floating action button/,
    apiStub,
  );
  assert.notEqual(instrumented, source, 'apiGet test seam must be installed');

  const bootMarker = '  // ── Boot ────────────────────────────────────────────────────────────────';
  instrumented = instrumented.replace(
    bootMarker,
    `  globalThis.__testHooks = {
    pageKind,
    isAggregablePage,
    fabLabelFor,
    localTodayStr,
    pageLocalTodayStr,
    afterSaleRepairStatsTZ,
    zonedDateRangeToChinaWindow,
    relabelDecoratedTimes,
    decorateTimestamps,
    textHasTimestamp,
    isVisibleTimestampParent,
    watchForTimestamps,
    readOrderDateRange,
    openOrderCountPanel,
    countOrders,
    countOrderStats,
    parseAfterSaleRepairCompanyIds,
    countAfterSaleRepairStats,
    readOrderPageQuery,
    readAfterSaleRepairPageQuery,
    renderOrderCount,
    renderAfterSaleRepairCount,
    runOrderCount,
  };
  return;

${bootMarker}`,
  );
  assert.ok(instrumented.includes('globalThis.__testHooks'), 'test hooks must be installed');

  const RealDate = Date;
  const fixedNow = RealDate.UTC(2026, 6, 22, 2, 0, 0);
  class FixedDate extends RealDate {
    constructor(...args) {
      super(...(args.length ? args : [fixedNow]));
    }
    static now() { return fixedNow; }
  }

  const RealDateTimeFormat = Intl.DateTimeFormat;
  function MockDateTimeFormat(locales, options) {
    const formatter = new RealDateTimeFormat(locales, options);
    if (!options || !options.timeZone) {
      const resolvedOptions = formatter.resolvedOptions.bind(formatter);
      formatter.resolvedOptions = () => ({
        ...resolvedOptions(),
        timeZone: 'America/Los_Angeles',
      });
    }
    return formatter;
  }
  MockDateTimeFormat.supportedLocalesOf = RealDateTimeFormat.supportedLocalesOf.bind(RealDateTimeFormat);

  const context = {
    URLSearchParams,
    console,
    Date: FixedDate,
    Intl: { DateTimeFormat: MockDateTimeFormat },
    __apiResponse: response,
    __apiResponses: responses ? responses.slice() : null,
    __apiHandler: apiHandler,
    document: {
      querySelector: (selector) => selector === '#app' && rootVue ? { __vue__: rootVue } : null,
    },
    location: { pathname, hash: '', search: '' },
    localStorage: {
      getItem: (key) => key === 'bsd-agg-tz' ? 'Asia/Shanghai' : null,
      removeItem() {},
      setItem() {},
    },
    setTimeout(callback) { callback(); return 1; },
  };
  vm.createContext(context);
  vm.runInContext(instrumented, context, { filename: sourcePath });
  return context;
}

function loadRouteHarness({ initialPath = '/bsd-warehouse/engineerDoa' } = {}) {
  const bootStub = `  function boot() {
    globalThis.__bootKinds.push(pageKind());
  }

  // Vue SPA:`;
  const instrumented = source.replace(
    /  function boot\(\) \{[\s\S]*?\n  \}\n\n  \/\/ Vue SPA:/,
    bootStub,
  );
  assert.notEqual(instrumented, source, 'boot test seam must be installed');

  const location = {
    pathname: initialPath,
    search: '',
    hash: '',
  };
  const updateLocation = (url) => {
    const parsed = new URL(url, 'https://bms.besender.com');
    location.pathname = parsed.pathname;
    location.search = parsed.search;
    location.hash = parsed.hash;
  };
  const history = {
    pushState(_state, _title, url) { updateLocation(url); },
    replaceState(_state, _title, url) { updateLocation(url); },
  };
  // Simulate a Vue Router build that retained History.pushState before the
  // userscript patched it; this bypasses the immediate hook in watchRoutes().
  const retainedRouterPush = history.pushState.bind(history);
  const timers = [];
  let pollRoute = null;
  const window = {
    addEventListener() {},
  };
  const context = {
    URL,
    URLSearchParams,
    console,
    Date,
    Intl,
    __bootKinds: [],
    clearTimeout(id) { timers[id - 1] = null; },
    document: { readyState: 'complete' },
    history,
    localStorage: {
      getItem: () => '',
      removeItem() {},
      setItem() {},
    },
    location,
    setInterval(callback) { pollRoute = callback; return 1; },
    setTimeout(callback) { timers.push(callback); return timers.length; },
    window,
  };
  vm.createContext(context);
  vm.runInContext(instrumented, context, { filename: sourcePath });
  return { context, pollRoute: () => pollRoute(), retainedRouterPush, timers };
}

test('after-sale repair stats default to Los Angeles independently of other panel timezones', () => {
  const context = loadHooks();

  // At this instant it is July 21 in Los Angeles and July 22 in Shanghai.
  assert.equal(context.__testHooks.localTodayStr(), '2026-07-22');
  assert.equal(context.__testHooks.pageLocalTodayStr(), '2026-07-21');
  assert.equal(context.__testHooks.afterSaleRepairStatsTZ(), 'America/Los_Angeles');
});

test('Los Angeles summer day converts to the matching China-time query window', () => {
  const context = loadHooks();

  const range = context.__testHooks.zonedDateRangeToChinaWindow(
    '2026-07-01', '2026-07-01', 'America/Los_Angeles',
  );

  assert.deepEqual({ ...range }, {
    label: '2026-07-01',
    timezone: 'America/Los_Angeles',
    localStart: '2026-07-01 00:00:00',
    localEnd: '2026-07-01 23:59:59',
    chinaStart: '2026-07-01 15:00:00',
    chinaEnd: '2026-07-02 14:59:59',
  });
});

test('Los Angeles winter day converts to the matching China-time query window', () => {
  const context = loadHooks();

  const range = context.__testHooks.zonedDateRangeToChinaWindow(
    '2026-01-15', '2026-01-15', 'America/Los_Angeles',
  );

  assert.deepEqual({ ...range }, {
    label: '2026-01-15',
    timezone: 'America/Los_Angeles',
    localStart: '2026-01-15 00:00:00',
    localEnd: '2026-01-15 23:59:59',
    chinaStart: '2026-01-15 16:00:00',
    chinaEnd: '2026-01-16 15:59:59',
  });
});

test('Los Angeles spring DST day uses its 23-hour local-day boundary', () => {
  const context = loadHooks();

  const range = context.__testHooks.zonedDateRangeToChinaWindow(
    '2026-03-08', '2026-03-08', 'America/Los_Angeles',
  );

  assert.deepEqual({ ...range }, {
    label: '2026-03-08',
    timezone: 'America/Los_Angeles',
    localStart: '2026-03-08 00:00:00',
    localEnd: '2026-03-08 23:59:59',
    chinaStart: '2026-03-08 16:00:00',
    chinaEnd: '2026-03-09 14:59:59',
  });
});

test('Los Angeles fall DST day uses its 25-hour local-day boundary', () => {
  const context = loadHooks();

  const range = context.__testHooks.zonedDateRangeToChinaWindow(
    '2026-11-01', '2026-11-01', 'America/Los_Angeles',
  );

  assert.deepEqual({ ...range }, {
    label: '2026-11-01',
    timezone: 'America/Los_Angeles',
    localStart: '2026-11-01 00:00:00',
    localEnd: '2026-11-01 23:59:59',
    chinaStart: '2026-11-01 15:00:00',
    chinaEnd: '2026-11-02 15:59:59',
  });
});

test('timezone switching can use China wall time and normalizes reversed ranges', () => {
  const context = loadHooks();

  const range = context.__testHooks.zonedDateRangeToChinaWindow(
    '2026-07-03', '2026-07-01', 'Asia/Shanghai',
  );

  assert.deepEqual({ ...range }, {
    label: '2026-07-01 ~ 2026-07-03',
    timezone: 'Asia/Shanghai',
    localStart: '2026-07-01 00:00:00',
    localEnd: '2026-07-03 23:59:59',
    chinaStart: '2026-07-01 00:00:00',
    chinaEnd: '2026-07-03 23:59:59',
  });
});

test('engineer repair keeps the v1.9.4 page-local date window without timezone conversion', () => {
  const context = loadHooks();
  const panel = {
    dataset: { panelKind: 'rp', dateMode: 'single' },
    querySelector(selector) {
      if (selector === '.date-input') return { value: '2026-07-01' };
      if (selector === '.tz-select') assert.fail('engineer repair must not read a timezone selector');
      return null;
    },
  };

  const range = context.__testHooks.readOrderDateRange(panel);
  assert.equal(range.label, '2026-07-01');
  assert.deepEqual({ start: range.start, end: range.end }, {
    start: '2026-07-01 00:00:00',
    end: '2026-07-01 23:59:59',
  });
});

test('timezone relabeling stays within the current SPA page scope', () => {
  const context = loadHooks();
  const general = {
    dataset: { china: '2026-07-25 01:48:39', localTz: 'Asia/Shanghai', tzScope: 'general' },
    textContent: 'general-original',
  };
  const order = {
    dataset: { china: '2026-07-25 01:48:39', localTz: 'Asia/Shanghai', tzScope: 'order' },
    textContent: 'order-original',
  };
  context.document.querySelectorAll = () => [general, order];

  context.__testHooks.relabelDecoratedTimes('America/Los_Angeles', 'order');
  assert.equal(general.textContent, 'general-original');
  assert.equal(order.textContent, '2026-07-24 10:48:39');

  context.__testHooks.relabelDecoratedTimes('Asia/Shanghai', 'general');
  assert.equal(general.textContent, '2026-07-25 01:48:39');
  assert.equal(order.textContent, '2026-07-24 10:48:39');
});

test('timestamp discovery skips hidden keep-alive pages and resets its global regex', () => {
  const context = loadHooks();
  const visible = { nodeType: 1, getClientRects: () => [{}] };
  const hidden = { nodeType: 1, getClientRects: () => [] };

  assert.equal(context.__testHooks.isVisibleTimestampParent(visible), true);
  assert.equal(context.__testHooks.isVisibleTimestampParent(hidden), false);
  assert.equal(context.__testHooks.textHasTimestamp('开始 2026-07-25 01:48:39'), true);
  // A global RegExp would fail every other identical test if lastIndex leaked.
  assert.equal(context.__testHooks.textHasTimestamp('开始 2026-07-25 01:48:39'), true);
});

test('timestamp observer is singleton and debounces multiple mutation batches without dropping the last', () => {
  const context = loadHooks({ pathname: '/bsd-warehouse/single/rp' });
  let observerCallback = null;
  let observeCount = 0;
  let walkCount = 0;
  const timers = [];

  context.NodeFilter = { SHOW_TEXT: 4, FILTER_REJECT: 2, FILTER_ACCEPT: 1 };
  context.document.body = { nodeType: 1 };
  context.document.createTreeWalker = () => {
    walkCount += 1;
    return { nextNode: () => false };
  };
  context.MutationObserver = class {
    constructor(callback) { observerCallback = callback; }
    observe() { observeCount += 1; }
  };
  context.setTimeout = (callback) => { timers.push(callback); return timers.length; };
  context.clearTimeout = (id) => { timers[id - 1] = null; };

  context.__testHooks.watchForTimestamps();
  context.__testHooks.watchForTimestamps();
  assert.equal(observeCount, 1);
  assert.equal(walkCount, 2);

  observerCallback([]);
  observerCallback([]);
  assert.equal(timers[0], null);
  assert.equal(typeof timers[1], 'function');
  timers[1]();
  assert.equal(walkCount, 3);
});

test('engineer repair and after-sale repair have distinct routes and button labels', () => {
  const engineer = loadHooks({ pathname: '/bsd-warehouse/engineerRepair' });
  const afterSale = loadHooks({ pathname: '/bsd-warehouse/single/rp' });

  assert.equal(engineer.__testHooks.pageKind(), 'rp');
  assert.equal(engineer.__testHooks.isAggregablePage(), true);
  assert.equal(engineer.__testHooks.fabLabelFor('rp'), '📊 RP 完成统计');
  assert.equal(afterSale.__testHooks.pageKind(), 'afterSaleRepair');
  assert.equal(afterSale.__testHooks.isAggregablePage(), true);
  assert.match(afterSale.__testHooks.fabLabelFor('afterSaleRepair'), /维修.*统计/);
});

test('engineer repair keeps the v1.9.4 completed-only panel without a timezone selector', () => {
  const context = loadHooks({ pathname: '/bsd-warehouse/engineerRepair' });
  const eventTarget = { addEventListener() {} };
  const single = { style: {} };
  const range = { style: {} };
  const panel = {
    dataset: {},
    innerHTML: '',
    isConnected: true,
    remove() {},
    querySelector(selector) {
      if (selector === '.close' || selector === '.run') return eventTarget;
      if (selector === '.date-fields.single') return single;
      if (selector === '.date-fields.range') return range;
      if (selector === '.tz-select') assert.fail('engineer repair panel must not query .tz-select');
      return null;
    },
    querySelectorAll(selector) {
      return selector === '.mode-tab' ? [] : [];
    },
  };
  context.document.createElement = () => panel;
  context.document.body = { appendChild() {} };

  context.__testHooks.openOrderCountPanel('rp');

  assert.match(panel.innerHTML, /RP（维修） 完成统计/);
  assert.doesNotMatch(panel.innerHTML, /tz-select|时区|新订单|进行中/);
  assert.match(panel.innerHTML, /同时统计 RP（维修）|同时统计 DOA/);
});

test('engineer repair timestamps remain page-local and are not decorated', () => {
  const context = loadHooks({ pathname: '/bsd-warehouse/engineerRepair' });
  let walkerCalls = 0;
  context.NodeFilter = { SHOW_TEXT: 4, FILTER_REJECT: 2, FILTER_ACCEPT: 1 };
  context.document.createTreeWalker = () => {
    walkerCalls += 1;
    return { nextNode: () => false };
  };

  context.__testHooks.decorateTimestamps({ nodeType: 1 });

  assert.equal(walkerCalls, 0);
});

test('route polling catches inner-tab switches that bypass patched History methods', () => {
  const harness = loadRouteHarness();
  assert.deepEqual(Array.from(harness.context.__bootKinds), ['doa']);

  harness.retainedRouterPush(null, '', '/bsd-warehouse/engineerRepair');
  assert.equal(harness.timers.length, 0);

  harness.pollRoute();
  assert.equal(harness.timers.length, 1);
  harness.timers[0]();
  assert.deepEqual(Array.from(harness.context.__bootKinds), ['doa', 'rp']);
});

test('route polling recognizes after-sale repair without replacing engineer repair kind', () => {
  const harness = loadRouteHarness({ initialPath: '/bsd-warehouse/engineerRepair' });
  assert.deepEqual(Array.from(harness.context.__bootKinds), ['rp']);

  harness.retainedRouterPush(null, '', '/bsd-warehouse/single/rp');
  harness.pollRoute();
  assert.equal(harness.timers.length, 1);
  harness.timers[0]();

  assert.deepEqual(Array.from(harness.context.__bootKinds), ['rp', 'afterSaleRepair']);
});

test('order counts use meta.total and remove RP-only filters from DOA', async () => {
  const context = loadHooks({ response: { code: 200, data: [{}], meta: { total: '42' } } });

  const total = await context.__testHooks.countOrders(
    'doa',
    {
      page: 9, limit: 10, type_arr: '1,2', is_child: 0, service_type: 'mail',
      user_id: 7, perfect_num: 1, un_perfect_num: 1,
    },
    '2',
    '2026-07-01 00:00:00',
    '2026-07-01 23:59:59',
  );

  assert.equal(total, 42);
  assert.equal(context.__lastApiCall.path, '/engineer/afterSale/orderList');
  assert.equal(context.__lastApiCall.params.type, '15');
  assert.equal(context.__lastApiCall.params.status, '2');
  assert.equal(context.__lastApiCall.params.time_type, '2');
  assert.equal(context.__lastApiCall.params.limit, 1);
  assert.equal(context.__lastApiCall.params.user_id, 7);
  assert.equal('type_arr' in context.__lastApiCall.params, false);
  assert.equal('is_child' in context.__lastApiCall.params, false);
  assert.equal('service_type' in context.__lastApiCall.params, false);
  assert.equal('perfect_num' in context.__lastApiCall.params, false);
  assert.equal('un_perfect_num' in context.__lastApiCall.params, false);
});

test('order result counts preserve perfect_num zero and all page filters', async () => {
  const context = loadHooks({ response: { code: 200, data: [{}], meta: { total: 3 } } });

  const total = await context.__testHooks.countOrders(
    'rp',
    { user_id: 119, keyword: 'phone', perfect_num: 1 },
    '2',
    '2026-07-01 00:00:00',
    '2026-07-01 23:59:59',
    0,
  );

  assert.equal(total, 3);
  assert.equal(context.__lastApiCall.params.perfect_num, 0);
  assert.equal(context.__lastApiCall.params.user_id, 119);
  assert.equal(context.__lastApiCall.params.keyword, 'phone');
  assert.equal(context.__lastApiCall.params.type_arr, '1,2');
  assert.equal(context.__lastApiCall.params.status, '2');
});

test('order stats combine completed, positive, and negative totals', async () => {
  const context = loadHooks({ responses: [
    { code: 200, data: [{}], meta: { total: 10 } },
    { code: 200, data: [{}], meta: { total: 7 } },
    { code: 200, data: [{}], meta: { total: 3 } },
  ] });

  const stats = await context.__testHooks.countOrderStats(
    'rp', { user_id: 119 }, '2', '2026-07-01 00:00:00', '2026-07-01 23:59:59',
  );

  assert.deepEqual({ ...stats }, { done: 10, positive: 7, negative: 3 });
  assert.equal(context.__apiCalls.length, 3);
  assert.equal('perfect_num' in context.__apiCalls[0].params, false);
  assert.equal(context.__apiCalls[1].params.perfect_num, 1);
  assert.equal(context.__apiCalls[2].params.perfect_num, 0);
});

test('order stats reject classification totals larger than completed orders', async () => {
  const context = loadHooks({ responses: [
    { code: 200, data: [{}], meta: { total: 10 } },
    { code: 200, data: [{}], meta: { total: 10 } },
    { code: 200, data: [{}], meta: { total: 10 } },
  ] });

  await assert.rejects(
    context.__testHooks.countOrderStats(
      'rp', {}, '2', '2026-07-01 00:00:00', '2026-07-01 23:59:59',
    ),
    /分类数量不一致/,
  );
});

test('engineer repair keeps the v1.9.4 three completed-result requests in page-local time', async () => {
  const visibleEl = { nodeType: 1, isConnected: true, getClientRects: () => [{}] };
  const rootVue = {
    $children: [{
      query: { type_arr: '1,2', is_child: 0, status: '1', user_id: 7 },
      getData() { return this._loadOrders(); },
      $el: visibleEl,
    }],
  };
  const context = loadHooks({
    pathname: '/bsd-warehouse/engineerRepair',
    rootVue,
    responses: [
      { code: 200, data: [{}], meta: { total: 10 } },
      { code: 200, data: [{}], meta: { total: 7 } },
      { code: 200, data: [{}], meta: { total: 3 } },
    ],
  });
  const body = { innerHTML: '' };
  const run = { disabled: false };
  const panel = {
    dataset: { panelKind: 'rp', dateMode: 'single' },
    querySelector(selector) {
      if (selector === '.body') return body;
      if (selector === '.run') return run;
      if (selector === '.cross-cb') return { checked: false };
      if (selector === '.date-input') return { value: '2026-07-01' };
      if (selector === '.tz-select') assert.fail('engineer repair must not use a timezone selector');
      return null;
    },
  };

  await context.__testHooks.runOrderCount(panel, 'rp');

  assert.equal(context.__apiCalls.length, 3);
  assert.deepEqual(Array.from(context.__apiCalls, call => call.params.perfect_num), [undefined, 1, 0]);
  for (const call of context.__apiCalls) {
    assert.equal(call.path, '/engineer/afterSale/orderList');
    assert.equal(call.params.type_arr, '1,2');
    assert.equal(call.params.is_child, 0);
    assert.equal(call.params.user_id, 7);
    assert.equal(call.params.status, '2');
    assert.equal(call.params.time_type, '2');
    assert.equal(call.params.start, '2026-07-01 00:00:00');
    assert.equal(call.params.end, '2026-07-01 23:59:59');
  }
  assert.doesNotMatch(body.innerHTML, /新订单|进行中|时区/);
  assert.match(body.innerHTML, /完成数量/);
});

test('after-sale repair parses selected company ids from arrays and comma strings', () => {
  const context = loadHooks({ pathname: '/bsd-warehouse/single/rp' });

  assert.deepEqual(
    Array.from(context.__testHooks.parseAfterSaleRepairCompanyIds([7, '119', 7, ' 119 '])),
    ['7', '119'],
  );
  assert.deepEqual(
    Array.from(context.__testHooks.parseAfterSaleRepairCompanyIds('7, 119, 7')),
    ['7', '119'],
  );
  assert.deepEqual(
    Array.from(context.__testHooks.parseAfterSaleRepairCompanyIds(7)),
    ['7'],
  );
  assert.deepEqual(
    Array.from(context.__testHooks.parseAfterSaleRepairCompanyIds([7, '007'])),
    ['7'],
  );
});

test('after-sale repair stats query five event-time metrics without current-status filters', async () => {
  const context = loadHooks({
    pathname: '/bsd-warehouse/single/rp',
    responses: [
    { code: 200, data: [{}], meta: { total: 18 } },
    { code: 200, data: [{}], meta: { total: 5 } },
    { code: 200, data: [{}], meta: { total: 10 } },
    { code: 200, data: [{}], meta: { total: 7 } },
    { code: 200, data: [{}], meta: { total: 3 } },
    ],
  });
  const start = '2026-07-01 15:00:00';
  const end = '2026-07-02 14:59:59';

  const stats = await context.__testHooks.countAfterSaleRepairStats(
    {
      user_id: [119],
      type_arr: '1,2',
      keyword: 'phone',
      status: '9',
      time_type: '9',
      start: 'stale start',
      end: 'stale end',
      is_perfect: 1,
      perfect_num: 1,
      page: 9,
      limit: 10,
    },
    start,
    end,
  );

  assert.deepEqual({ ...stats }, {
    newOrders: 18,
    inProgress: 5,
    done: 10,
    positive: 7,
    negative: 3,
  });
  assert.equal('companyDetails' in stats, false);
  assert.equal(context.__apiCalls.length, 5);

  const calls = context.__apiCalls.map(call => call.params);
  assert.equal(calls[0].time_type, '3');
  assert.equal('is_perfect' in calls[0], false);

  assert.equal(calls[1].time_type, '1');
  assert.equal('is_perfect' in calls[1], false);

  assert.equal(calls[2].time_type, '2');
  assert.equal('is_perfect' in calls[2], false);

  assert.equal(calls[3].time_type, '2');
  assert.equal(calls[3].is_perfect, 1);

  assert.equal(calls[4].time_type, '2');
  assert.equal(calls[4].is_perfect, 0);

  context.__apiCalls.forEach(({ path, params }) => {
    assert.equal(path, '/warehouse/afterSale/orderList');
    assert.equal('status' in params, false);
    assert.equal(String(params.user_id), '119');
    assert.equal(params.keyword, 'phone');
    assert.equal(params.type_arr, '1,2');
    assert.equal(params.start, start);
    assert.equal(params.end, end);
    assert.equal(params.page, 1);
    assert.equal(params.limit, 1);
    assert.equal('perfect_num' in params, false);
  });
});

test('after-sale repair removes a stale current status so later-shipped orders remain eligible', async () => {
  const totals = {
    '3/all': 4,
    '1/all': 2,
    '2/all': 3,
    '2/1': 2,
    '2/0': 1,
  };
  const context = loadHooks({
    pathname: '/bsd-warehouse/single/rp',
    apiHandler(_path, params) {
      // A later-shipped order would be excluded if the stale page status leaked
      // into any of these historical event-time requests.
      if ('status' in params) return { code: 200, data: [], meta: { total: 0 } };
      const signature = `${params.time_type}/${params.is_perfect == null ? 'all' : params.is_perfect}`;
      return { code: 200, data: [], meta: { total: totals[signature] } };
    },
  });

  const stats = await context.__testHooks.countAfterSaleRepairStats(
    { user_id: 119, type_arr: '1,2', status: '4' },
    '2026-07-01 15:00:00',
    '2026-07-02 14:59:59',
  );

  assert.deepEqual({ ...stats }, {
    newOrders: 4,
    inProgress: 2,
    done: 3,
    positive: 2,
    negative: 1,
  });
  assert.equal(context.__apiCalls.length, 5);
  assert.deepEqual(
    Array.from(context.__apiCalls, ({ params }) =>
      `${params.time_type}/${params.is_perfect == null ? 'all' : params.is_perfect}`),
    ['3/all', '1/all', '2/all', '2/1', '2/0'],
  );
  context.__apiCalls.forEach(({ params }) => assert.equal('status' in params, false));
});

test('multi-company after-sale repair makes only five requests per company and sums their totals', async () => {
  const totals = (newOrders, inProgress, done, positive, negative) => [
    newOrders, inProgress, done, positive, negative,
  ].map(total => ({ code: 200, data: [{}], meta: { total } }));
  const context = loadHooks({
    pathname: '/bsd-warehouse/single/rp',
    responses: [
      ...totals(12, 4, 8, 6, 2),
      ...totals(18, 5, 13, 9, 4),
    ],
  });
  const start = '2026-07-01 15:00:00';
  const end = '2026-07-02 14:59:59';

  const stats = await context.__testHooks.countAfterSaleRepairStats(
    { user_id: [7, 119], type_arr: '1,2', keyword: 'phone' },
    start,
    end,
  );

  assert.equal(context.__apiCalls.length, 10);
  assert.deepEqual({
    newOrders: stats.newOrders,
    inProgress: stats.inProgress,
    done: stats.done,
    positive: stats.positive,
    negative: stats.negative,
  }, { newOrders: 30, inProgress: 9, done: 21, positive: 15, negative: 6 });
  assert.deepEqual(Array.from(stats.companyDetails, detail => ({
    userId: String(detail.userId),
    companyLabel: detail.companyLabel,
    stats: { ...detail.stats },
  })), [
    {
      userId: '7',
      companyLabel: '公司 7',
      stats: { newOrders: 12, inProgress: 4, done: 8, positive: 6, negative: 2 },
    },
    {
      userId: '119',
      companyLabel: '公司 119',
      stats: { newOrders: 18, inProgress: 5, done: 13, positive: 9, negative: 4 },
    },
  ]);

  const calls = Array.from(context.__apiCalls, call => call.params);
  assert.equal(calls.filter(params => String(params.user_id) === '7').length, 5);
  assert.equal(calls.filter(params => String(params.user_id) === '119').length, 5);
  for (const params of calls) {
    assert.equal(Array.isArray(params.user_id), false);
    assert.doesNotMatch(String(params.user_id), /,/);
    assert.equal('status' in params, false);
  }

  const expectedSignatures = ['3/all', '1/all', '2/all', '2/1', '2/0'];
  for (let offset = 0; offset < calls.length; offset += 5) {
    const signatures = calls.slice(offset, offset + 5).map(params =>
      `${params.time_type}/${params.is_perfect == null ? 'all' : params.is_perfect}`
    );
    assert.deepEqual(signatures, expectedSignatures);
  }
});

test('comma-separated after-sale repair company ids also expand into per-company requests', async () => {
  const context = loadHooks({
    pathname: '/bsd-warehouse/single/rp',
    responses: Array.from({ length: 10 }, () => ({
      code: 200, data: [], meta: { total: 0 },
    })),
  });

  const stats = await context.__testHooks.countAfterSaleRepairStats(
    { user_id: '7,119,7', type_arr: '1,2' },
    '2026-07-01 15:00:00',
    '2026-07-02 14:59:59',
  );

  assert.equal(context.__apiCalls.length, 10);
  assert.equal(stats.companyDetails.length, 2);
  const detailIds = Array.from(context.__apiCalls, call => String(call.params.user_id));
  assert.equal(detailIds.filter(id => id === '7').length, 5);
  assert.equal(detailIds.filter(id => id === '119').length, 5);
});

test('invalid after-sale repair company tokens fail closed before any API request', async () => {
  const context = loadHooks({ pathname: '/bsd-warehouse/single/rp' });

  await assert.rejects(
    context.__testHooks.countAfterSaleRepairStats(
      { user_id: '7,not-a-company,119', type_arr: '1,2' },
      '2026-07-01 15:00:00',
      '2026-07-02 14:59:59',
    ),
    /公司.*(无效|格式|选择)|user_id/i,
  );
  assert.equal(context.__apiCalls, undefined);
});

test('nonempty after-sale repair CSV with an empty token fails closed', async () => {
  const context = loadHooks({ pathname: '/bsd-warehouse/single/rp' });

  await assert.rejects(
    context.__testHooks.countAfterSaleRepairStats(
      { user_id: '7,,119', type_arr: '1,2' },
      '2026-07-01 15:00:00',
      '2026-07-02 14:59:59',
    ),
    /公司.*(无效|格式|选择)|user_id/i,
  );
  assert.equal(context.__apiCalls, undefined);
});

test('zero-valued after-sale repair company ids fail closed before any API request', async () => {
  for (const userId of [0, '000']) {
    const context = loadHooks({ pathname: '/bsd-warehouse/single/rp' });
    await assert.rejects(
      context.__testHooks.countAfterSaleRepairStats(
        { user_id: userId, type_arr: '1,2' },
        '2026-07-01 15:00:00',
        '2026-07-02 14:59:59',
      ),
      /公司.*(无效|格式|选择)|user_id/i,
    );
    assert.equal(context.__apiCalls, undefined);
  }
});

test('explicitly empty after-sale repair user_id keeps the five-request all-company path', async () => {
  const totals = [8, 3, 5, 4, 1];
  const context = loadHooks({
    pathname: '/bsd-warehouse/single/rp',
    responses: totals.map(total => ({ code: 200, data: [], meta: { total } })),
  });

  const stats = await context.__testHooks.countAfterSaleRepairStats(
    { user_id: '', type_arr: '1,2', status: 'stale' },
    '2026-07-01 15:00:00',
    '2026-07-02 14:59:59',
  );

  assert.deepEqual({ ...stats }, {
    newOrders: 8,
    inProgress: 3,
    done: 5,
    positive: 4,
    negative: 1,
  });
  assert.equal(context.__apiCalls.length, 5);
  context.__apiCalls.forEach(({ params }) => {
    assert.equal('user_id' in params, false);
    assert.equal('status' in params, false);
  });
});

test('after-sale repair limits per-company statistics to two companies at a time', async () => {
  const pendingByCompany = new Map();
  const context = loadHooks({
    pathname: '/bsd-warehouse/single/rp',
    apiHandler(_path, params) {
      const id = String(params.user_id);
      return new Promise(resolve => {
        const pending = pendingByCompany.get(id) || [];
        pending.push(() => resolve({
          code: 200,
          data: [],
          meta: { total: params.time_type === '2' && params.is_perfect == null ? 2 : 1 },
        }));
        pendingByCompany.set(id, pending);
      });
    },
  });
  const flush = () => new Promise(resolve => setImmediate(resolve));
  const resolveCompany = (id) => {
    const pending = pendingByCompany.get(String(id)) || [];
    assert.equal(pending.length, 5);
    pending.forEach(resolve => resolve());
  };

  const statsPromise = context.__testHooks.countAfterSaleRepairStats(
    { user_id: [1, 2, 3, 4], type_arr: '1,2' },
    '2026-07-01 15:00:00',
    '2026-07-02 14:59:59',
  );
  await flush();
  assert.deepEqual(Array.from(pendingByCompany.keys()), ['1', '2']);
  assert.equal(context.__apiCalls.length, 10);

  resolveCompany(1);
  await flush();
  assert.deepEqual(Array.from(pendingByCompany.keys()), ['1', '2', '3']);
  assert.equal(pendingByCompany.has('4'), false);

  resolveCompany(2);
  await flush();
  assert.deepEqual(Array.from(pendingByCompany.keys()), ['1', '2', '3', '4']);

  resolveCompany(3);
  resolveCompany(4);
  const stats = await statsPromise;
  assert.equal(stats.companyDetails.length, 4);
  assert.deepEqual({
    newOrders: stats.newOrders,
    inProgress: stats.inProgress,
    done: stats.done,
    positive: stats.positive,
    negative: stats.negative,
  }, { newOrders: 4, inProgress: 4, done: 8, positive: 4, negative: 4 });
});

test('after-sale repair reports the company when one company detail request fails', async () => {
  const ok = total => ({ code: 200, data: [], meta: { total } });
  const context = loadHooks({
    pathname: '/bsd-warehouse/single/rp',
    responses: [
      ok(12), ok(4), ok(8), ok(6), ok(2),
      { code: 30006, cn_message: '会话已失效' }, ok(5), ok(13), ok(9), ok(4),
    ],
  });

  await assert.rejects(
    context.__testHooks.countAfterSaleRepairStats(
      { user_id: [7, 119], type_arr: '1,2' },
      '2026-07-01 15:00:00',
      '2026-07-02 14:59:59',
    ),
    /公司.*119.*(失败|会话已失效)/,
  );
  assert.equal(context.__apiCalls.length, 10);
});

test('order stats render positive and negative counts, percentages, and totals', () => {
  const context = loadHooks();
  const container = { innerHTML: '' };

  context.__testHooks.renderOrderCount(container, {
    kind: 'doa',
    dr: { start: '2026-07-01 00:00:00', end: '2026-07-01 23:59:59' },
    companyLabel: 'Nothing',
    counts: {
      doa: { done: 10, positive: 7, negative: 3 },
      rp: { done: 20, positive: 10, negative: 10 },
    },
  });

  assert.match(container.innerHTML, /通过（良品）/);
  assert.match(container.innerHTML, /不通过（不良品）/);
  assert.match(container.innerHTML, /7（70\.0%）/);
  assert.match(container.innerHTML, /3（30\.0%）/);
  assert.match(container.innerHTML, /17（56\.7%）/);
  assert.match(container.innerHTML, /13（43\.3%）/);
  assert.match(container.innerHTML, /合计 \(DOA\+RP\)/);
});

test('after-sale repair renders new, in-progress, completed, good, and bad metrics', () => {
  const context = loadHooks({ pathname: '/bsd-warehouse/single/rp' });
  const container = { innerHTML: '' };

  context.__testHooks.renderAfterSaleRepairCount(container, {
    dr: {
      label: '2026-07-01',
      timezone: 'America/Los_Angeles',
      localStart: '2026-07-01 00:00:00',
      localEnd: '2026-07-01 23:59:59',
      start: '2026-07-01 15:00:00',
      end: '2026-07-02 14:59:59',
      chinaStart: '2026-07-01 15:00:00',
      chinaEnd: '2026-07-02 14:59:59',
    },
    companyLabel: 'Nothing',
    stats: { newOrders: 18, inProgress: 5, done: 10, positive: 7, negative: 3 },
  });

  assert.match(container.innerHTML, /新订单[\s\S]*18/);
  assert.match(container.innerHTML, /进行中[\s\S]*5/);
  assert.match(container.innerHTML, /已完成[\s\S]*10/);
  assert.match(container.innerHTML, /新订单[^<]*创建时间|新订单[\s\S]*创建时间/);
  assert.match(container.innerHTML, /进行中[^<]*开始时间|进行中[\s\S]*开始时间/);
  assert.match(container.innerHTML, /已完成[^<]*完成时间|已完成[\s\S]*完成时间/);
  assert.match(container.innerHTML, /良品/);
  assert.match(container.innerHTML, /不良品/);
  assert.match(container.innerHTML, /良品[\s\S]*?<td class="rate good">7<\/td>[\s\S]*?<td class="rate good">70\.0%<\/td>/);
  assert.match(container.innerHTML, /不良品[\s\S]*?<td class="rate bad">3<\/td>[\s\S]*?<td class="rate bad">30\.0%<\/td>/);
  assert.doesNotMatch(container.innerHTML, /company-detail|公司明细/);
});

test('after-sale repair renders metric-first company hierarchy with completed quality details', () => {
  const context = loadHooks({ pathname: '/bsd-warehouse/single/rp' });
  const container = { innerHTML: '' };

  context.__testHooks.renderAfterSaleRepairCount(container, {
    dr: {
      timezone: 'America/Los_Angeles',
      localStart: '2026-07-01 00:00:00',
      localEnd: '2026-07-01 23:59:59',
      chinaStart: '2026-07-01 15:00:00',
      chinaEnd: '2026-07-02 14:59:59',
    },
    companyLabel: 'Anker、Nothing',
    stats: {
      newOrders: 30,
      inProgress: 9,
      done: 21,
      positive: 15,
      negative: 6,
      companyDetails: [
        {
          userId: '7',
          companyLabel: 'Anker',
          stats: { newOrders: 12, inProgress: 4, done: 8, positive: 6, negative: 2 },
        },
        {
          userId: '119',
          companyLabel: 'Nothing',
          stats: { newOrders: 18, inProgress: 5, done: 13, positive: 9, negative: 4 },
        },
      ],
    },
  });

  const html = container.innerHTML;
  const groupMetrics = Array.from(
    html.matchAll(/<tbody class="company-metric-group" data-metric="(new|progress|done)">/g),
    match => match[1],
  );
  assert.deepEqual(groupMetrics, ['new', 'progress', 'done']);

  const groupHtml = (metric) => {
    const match = html.match(new RegExp(
      `<tbody class="company-metric-group" data-metric="${metric}">([\\s\\S]*?)<\\/tbody>`,
    ));
    assert.ok(match, `missing ${metric} metric group`);
    return match[1];
  };
  const hierarchyRows = (group) => Array.from(
    group.matchAll(/<tr class="([^"]*(?:company-metric-row|company-quality-row)[^"]*)">([\s\S]*?)<\/tr>/g),
    match => ({
      classes: match[1].split(/\s+/),
      text: match[2].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(),
    }),
  );

  const newGroup = groupHtml('new');
  const progressGroup = groupHtml('progress');
  const doneGroup = groupHtml('done');
  assert.match(newGroup, /新订单[\s\S]*30/);
  assert.match(progressGroup, /进行中[\s\S]*9/);
  assert.match(doneGroup, /已完成[\s\S]*21/);

  const newRows = hierarchyRows(newGroup);
  assert.deepEqual(newRows.map(row => row.classes), [
    ['company-metric-row'],
    ['company-metric-row'],
  ]);
  assert.match(newRows[0].text, /Anker.*12/);
  assert.match(newRows[1].text, /Nothing.*18/);

  const progressRows = hierarchyRows(progressGroup);
  assert.deepEqual(progressRows.map(row => row.classes), [
    ['company-metric-row'],
    ['company-metric-row'],
  ]);
  assert.match(progressRows[0].text, /Anker.*4/);
  assert.match(progressRows[1].text, /Nothing.*5/);

  const doneRows = hierarchyRows(doneGroup);
  assert.deepEqual(doneRows.map(row => row.classes), [
    ['company-metric-row'],
    ['company-quality-row', 'good'],
    ['company-quality-row', 'bad'],
    ['company-metric-row'],
    ['company-quality-row', 'good'],
    ['company-quality-row', 'bad'],
  ]);
  assert.match(doneRows[0].text, /Anker.*8/);
  assert.match(doneRows[1].text, /良品.*6.*75\.0%/);
  assert.match(doneRows[2].text, /不良品.*2.*25\.0%/);
  assert.match(doneRows[3].text, /Nothing.*13/);
  assert.match(doneRows[4].text, /良品.*9.*69\.2%/);
  assert.match(doneRows[5].text, /不良品.*4.*30\.8%/);

  assert.doesNotMatch(html, /class="company-detail(?:"|\s)/);
});

test('after-sale repair shows unavailable good and bad rates when no orders completed', () => {
  const context = loadHooks({ pathname: '/bsd-warehouse/single/rp' });
  const container = { innerHTML: '' };

  context.__testHooks.renderAfterSaleRepairCount(container, {
    dr: {
      timezone: 'America/Los_Angeles',
      localStart: '2026-07-01 00:00:00',
      localEnd: '2026-07-01 23:59:59',
      start: '2026-07-01 15:00:00',
      end: '2026-07-02 14:59:59',
    },
    companyLabel: 'Nothing',
    stats: { newOrders: 0, inProgress: 0, done: 0, positive: 0, negative: 0 },
  });

  assert.match(container.innerHTML, /良品[\s\S]*?<td class="rate good">0<\/td>[\s\S]*?<td class="rate good">—<\/td>/);
  assert.match(container.innerHTML, /不良品[\s\S]*?<td class="rate bad">0<\/td>[\s\S]*?<td class="rate bad">—<\/td>/);
});

test('order stats use page-native labels and add parenthetical labels only for cross-counts', () => {
  const context = loadHooks();
  const stats = { done: 10, positive: 7, negative: 3 };
  const base = {
    dr: { start: '2026-07-01 00:00:00', end: '2026-07-01 23:59:59' },
    companyLabel: 'Nothing',
  };
  const rpOnly = { innerHTML: '' };
  const doaOnly = { innerHTML: '' };
  const rpCross = { innerHTML: '' };

  context.__testHooks.renderOrderCount(rpOnly, {
    ...base, kind: 'rp', counts: { doa: null, rp: stats },
  });
  context.__testHooks.renderOrderCount(doaOnly, {
    ...base, kind: 'doa', counts: { doa: stats, rp: null },
  });
  context.__testHooks.renderOrderCount(rpCross, {
    ...base, kind: 'rp', counts: { doa: stats, rp: stats },
  });

  assert.match(rpOnly.innerHTML, /<th[^>]*>良品<\/th>/);
  assert.match(rpOnly.innerHTML, /<th[^>]*>不良品<\/th>/);
  assert.doesNotMatch(rpOnly.innerHTML, /良品（通过）|不良品（不通过）/);
  assert.match(doaOnly.innerHTML, /<th[^>]*>通过<\/th>/);
  assert.match(doaOnly.innerHTML, /<th[^>]*>不通过<\/th>/);
  assert.doesNotMatch(doaOnly.innerHTML, /通过（良品）|不通过（不良品）/);
  assert.match(rpCross.innerHTML, /良品（通过）/);
  assert.match(rpCross.innerHTML, /不良品（不通过）/);
});

test('order stats show an em dash percentage when completed count is zero', () => {
  const context = loadHooks();
  const container = { innerHTML: '' };

  context.__testHooks.renderOrderCount(container, {
    kind: 'rp',
    dr: { start: '2026-07-01 00:00:00', end: '2026-07-01 23:59:59' },
    companyLabel: 'Nothing',
    counts: { doa: null, rp: { done: 0, positive: 0, negative: 0 } },
  });

  assert.equal((container.innerHTML.match(/0（—）/g) || []).length, 2);
});

test('RP order count inherits the company from the visible RP filter component', async () => {
  const hiddenEl = { nodeType: 1, isConnected: true, getClientRects: () => [] };
  const visibleEl = { nodeType: 1, isConnected: true, getClientRects: () => [{}] };
  const rootVue = {
    $children: [
      {
        query: { type: '15', status: '1', user_id: '' },
        getData() { return '/engineer/afterSale/orderList'; },
        $el: hiddenEl,
      },
      {
        query: { type_arr: '1,2', is_child: 0, status: '1', user_id: '' },
        getData() { return '/engineer/afterSale/orderList'; },
        $el: hiddenEl,
      },
      {
        query: { type_arr: '1,2', is_child: 0, status: '1', user_id: 7 },
        // Production Vue/Babel wrappers often do not retain the endpoint name
        // in Function#toString(); component matching must not depend on it.
        getData() { return this._loadOrders(); },
        $el: visibleEl,
      },
    ],
  };
  const context = loadHooks({
    rootVue,
    response: { code: 200, data: [], meta: { total: 3 } },
  });

  const query = context.__testHooks.readOrderPageQuery('rp');
  const total = await context.__testHooks.countOrders(
    'rp', query, '2', '2026-07-01 00:00:00', '2026-07-01 23:59:59',
  );

  assert.equal(total, 3);
  assert.equal(query.user_id, 7);
  assert.equal(query.type_arr, '1,2');
  assert.equal('type' in query, false);
  assert.equal(context.__lastApiCall.params.user_id, 7);
});

test('after-sale repair inherits the selected company from its visible page component', () => {
  const hiddenEl = { nodeType: 1, isConnected: true, getClientRects: () => [] };
  const visibleEl = { nodeType: 1, isConnected: true, getClientRects: () => [{}] };
  const rootVue = {
    $children: [
      {
        query: { type_arr: '1,2', is_child: 0, status: '1', user_id: 88 },
        getData() { return '/engineer/afterSale/orderList'; },
        $el: visibleEl,
      },
      {
        query: {
          user_id: '', type_arr: '1,2', status: '', is_perfect: '', time_type: '',
        },
        $options: { name: 'order_rp' },
        getData() { return '/warehouse/afterSale/orderList'; },
        $el: hiddenEl,
      },
      {
        query: {
          user_id: 119, type_arr: '1,2', status: '2', is_perfect: 0, time_type: '1',
          keyword: 'phone',
        },
        $options: { name: 'order_rp' },
        // Production wrappers need not retain the endpoint in Function#toString().
        getData() { return this._loadOrders(); },
        $el: visibleEl,
      },
    ],
  };
  const context = loadHooks({
    pathname: '/bsd-warehouse/single/rp',
    rootVue,
  });

  const query = context.__testHooks.readAfterSaleRepairPageQuery();

  assert.deepEqual({ ...query }, {
    user_id: 119,
    type_arr: '1,2',
    status: '2',
    is_perfect: 0,
    time_type: '1',
    keyword: 'phone',
  });
});

test('after-sale repair query fails closed when company state is missing, hidden, or ambiguous', () => {
  const visibleEl = { nodeType: 1, isConnected: true, getClientRects: () => [{}] };
  const hiddenEl = { nodeType: 1, isConnected: true, getClientRects: () => [] };
  const makeComponent = (userId, el = visibleEl, includeUser = true) => {
    const query = { type_arr: '1,2', status: '1', is_perfect: '', time_type: '3' };
    if (includeUser) query.user_id = userId;
    return {
      query,
      $options: { name: 'order_rp' },
      getData() { return this._loadOrders(); },
      $el: el,
    };
  };

  const missingCompany = loadHooks({
    pathname: '/bsd-warehouse/single/rp',
    rootVue: { $children: [makeComponent(null, visibleEl, false)] },
  });
  assert.equal(missingCompany.__testHooks.readAfterSaleRepairPageQuery(), null);

  const hiddenOnly = loadHooks({
    pathname: '/bsd-warehouse/single/rp',
    rootVue: { $children: [makeComponent(119, hiddenEl)] },
  });
  assert.equal(hiddenOnly.__testHooks.readAfterSaleRepairPageQuery(), null);

  const ambiguous = loadHooks({
    pathname: '/bsd-warehouse/single/rp',
    rootVue: { $children: [makeComponent(119), makeComponent(120)] },
  });
  assert.equal(ambiguous.__testHooks.readAfterSaleRepairPageQuery(), null);
});

test('order query refuses to silently count all companies when user_id cannot be read', () => {
  const rootVue = {
    $children: [{
      query: { type_arr: '1,2', is_child: 0, status: '1' },
      getData() { return '/engineer/afterSale/orderList'; },
      $el: { nodeType: 1, isConnected: true, getClientRects: () => [{}] },
    }],
  };
  const context = loadHooks({ rootVue });

  assert.equal(context.__testHooks.readOrderPageQuery('rp'), null);
  assert.equal(context.__lastApiCall, undefined);
});

test('hidden cached order query cannot fall back to an all-company request', async () => {
  const rootVue = {
    $children: [{
      query: { type_arr: '1,2', is_child: 0, status: '1', user_id: '' },
      getData() { return '/engineer/afterSale/orderList'; },
      $el: { nodeType: 1, isConnected: true, getClientRects: () => [] },
    }],
  };
  const context = loadHooks({
    rootVue,
    response: { code: 200, data: [], meta: { total: 99 } },
  });
  const flashBar = { textContent: '', remove() {} };
  const body = { querySelector: () => flashBar };
  const panel = {
    dataset: { dateMode: 'single' },
    querySelector(selector) {
      if (selector === '.body') return body;
      if (selector === '.run') return { disabled: false };
      if (selector === '.cross-cb') return { checked: false };
      if (selector === '.date-input') return { value: '2026-07-01' };
      return null;
    },
  };

  await context.__testHooks.runOrderCount(panel, 'rp');

  assert.match(flashBar.textContent, /未找到页面筛选条件/);
  assert.equal(context.__lastApiCall, undefined);
});

test('ambiguous visible order components are rejected instead of using tree order', () => {
  const visibleEl = { nodeType: 1, isConnected: true, getClientRects: () => [{}] };
  const makeComponent = (userId) => ({
    query: { type_arr: '1,2', is_child: 0, status: '1', user_id: userId },
    getData() { return '/engineer/afterSale/orderList'; },
    $el: visibleEl,
  });
  const context = loadHooks({
    rootVue: { $children: [makeComponent(''), makeComponent(7)] },
  });

  assert.equal(context.__testHooks.readOrderPageQuery('rp'), null);
  assert.equal(context.__lastApiCall, undefined);
});

test('order counts surface business errors instead of reporting zero', async () => {
  const context = loadHooks({ response: { code: 30006, cn_message: '会话已失效' } });

  await assert.rejects(
    context.__testHooks.countOrders(
      'rp', {}, '2', '2026-07-01 00:00:00', '2026-07-01 23:59:59',
    ),
    /会话已失效/,
  );
});

test('order counts reject responses without pagination totals', async () => {
  const context = loadHooks({ response: { code: 200, data: [{}] } });

  await assert.rejects(
    context.__testHooks.countOrders(
      'rp', {}, '2', '2026-07-01 00:00:00', '2026-07-01 23:59:59',
    ),
    /meta\.total/,
  );

  context.__apiResponse = { code: 200, data: [], meta: { total: null } };
  await assert.rejects(
    context.__testHooks.countOrders(
      'rp', {}, '2', '2026-07-01 00:00:00', '2026-07-01 23:59:59',
    ),
    /meta\.total/,
  );
});

test('after-sale repair stats surface business errors from the warehouse endpoint', async () => {
  const context = loadHooks({
    pathname: '/bsd-warehouse/single/rp',
    response: { code: 30006, cn_message: '会话已失效' },
  });

  await assert.rejects(
    context.__testHooks.countAfterSaleRepairStats(
      { user_id: 119, type_arr: '1,2' },
      '2026-07-01 15:00:00',
      '2026-07-02 14:59:59',
    ),
    /会话已失效/,
  );
  assert.ok(context.__apiCalls.length > 0);
  assert.ok(context.__apiCalls.every(call => call.path === '/warehouse/afterSale/orderList'));
});

test('after-sale repair stats require meta.total instead of trusting the first page length', async () => {
  const context = loadHooks({
    pathname: '/bsd-warehouse/single/rp',
    response: { code: 200, data: [{}] },
  });

  await assert.rejects(
    context.__testHooks.countAfterSaleRepairStats(
      { user_id: 119, type_arr: '1,2' },
      '2026-07-01 15:00:00',
      '2026-07-02 14:59:59',
    ),
    /meta\.total/,
  );
});
