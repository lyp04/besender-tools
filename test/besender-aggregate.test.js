'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const sourcePath = path.join(__dirname, '..', 'besender-aggregate.user.js');
const source = fs.readFileSync(sourcePath, 'utf8');

function loadHooks({ response = null, responses = null, rootVue = null, pathname = '/bsd-warehouse/engineerRepair' } = {}) {
  const apiStub = `  async function apiGet(path, params) {
    globalThis.__lastApiCall = { path, params };
    globalThis.__apiCalls = globalThis.__apiCalls || [];
    globalThis.__apiCalls.push({ path, params });
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
    localTodayStr,
    pageLocalTodayStr,
    orderStatsTZ,
    zonedDateRangeToChinaWindow,
    orderWindowForKind,
    relabelDecoratedTimes,
    textHasTimestamp,
    isVisibleTimestampParent,
    watchForTimestamps,
    countOrders,
    countOrderStats,
    countRepairStats,
    readOrderPageQuery,
    renderOrderCount,
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

function loadRouteHarness() {
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
    pathname: '/bsd-warehouse/engineerDoa',
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

test('repair stats default to Los Angeles independently of the timezone saved by other panels', () => {
  const context = loadHooks();

  // At this instant it is July 21 in Los Angeles and July 22 in Shanghai.
  assert.equal(context.__testHooks.localTodayStr(), '2026-07-22');
  assert.equal(context.__testHooks.pageLocalTodayStr(), '2026-07-21');
  assert.equal(context.__testHooks.orderStatsTZ(), 'America/Los_Angeles');
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

test('cross-counts derive separate RP China and DOA page-local windows', () => {
  const context = loadHooks();
  const selectedDay = {
    timezone: 'America/Los_Angeles',
    localStart: '2026-07-01 00:00:00',
    localEnd: '2026-07-01 23:59:59',
    start: '2026-07-01 15:00:00',
    end: '2026-07-02 14:59:59',
  };

  assert.deepEqual({ ...context.__testHooks.orderWindowForKind(selectedDay, 'rp') }, {
    start: '2026-07-01 15:00:00',
    end: '2026-07-02 14:59:59',
  });
  assert.deepEqual({ ...context.__testHooks.orderWindowForKind(selectedDay, 'doa') }, {
    start: '2026-07-01 00:00:00',
    end: '2026-07-01 23:59:59',
  });

  const chinaDay = {
    timezone: 'Asia/Shanghai',
    localStart: '2026-07-01 00:00:00',
    localEnd: '2026-07-01 23:59:59',
  };
  assert.deepEqual({ ...context.__testHooks.orderWindowForKind(chinaDay, 'doa') }, {
    start: '2026-06-30 09:00:00',
    end: '2026-07-01 08:59:59',
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
  const context = loadHooks();
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

test('order counts use meta.total and remove RP-only filters from DOA', async () => {
  const context = loadHooks({ response: { code: 200, data: [{}], meta: { total: '42' } } });

  const total = await context.__testHooks.countOrders(
    'doa',
    {
      page: 9, limit: 10, type_arr: '1,2', is_child: 0, service_type: 'mail',
      user_id: 7, perfect_num: 1, un_perfect_num: 1,
    },
    {
      status: '2',
      timeType: '2',
      start: '2026-07-01 00:00:00',
      end: '2026-07-01 23:59:59',
      perfectNum: null,
    },
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
    {
      status: '2',
      timeType: '2',
      start: '2026-07-01 00:00:00',
      end: '2026-07-01 23:59:59',
      perfectNum: 0,
    },
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

test('repair stats query new, in-progress, completed, good, and bad orders with distinct scopes', async () => {
  const context = loadHooks({ responses: [
    { code: 200, data: [{}], meta: { total: 18 } },
    { code: 200, data: [{}], meta: { total: 5 } },
    { code: 200, data: [{}], meta: { total: 10 } },
    { code: 200, data: [{}], meta: { total: 7 } },
    { code: 200, data: [{}], meta: { total: 3 } },
  ] });
  const start = '2026-07-01 15:00:00';
  const end = '2026-07-02 14:59:59';

  const stats = await context.__testHooks.countRepairStats(
    {
      user_id: 119,
      keyword: 'phone',
      status: '9',
      time_type: '9',
      start: 'stale start',
      end: 'stale end',
      perfect_num: 1,
      un_perfect_num: 1,
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
  assert.equal(context.__apiCalls.length, 5);

  const calls = context.__apiCalls.map(call => call.params);
  assert.equal('status' in calls[0], false);
  assert.equal(calls[0].time_type, '1');
  assert.equal('perfect_num' in calls[0], false);

  assert.equal(calls[1].status, '1');
  assert.equal(calls[1].time_type, '1');
  assert.equal('perfect_num' in calls[1], false);

  assert.equal(calls[2].status, '2');
  assert.equal(calls[2].time_type, '2');
  assert.equal('perfect_num' in calls[2], false);

  assert.equal(calls[3].status, '2');
  assert.equal(calls[3].time_type, '2');
  assert.equal(calls[3].perfect_num, 1);

  assert.equal(calls[4].status, '2');
  assert.equal(calls[4].time_type, '2');
  assert.equal(calls[4].perfect_num, 0);

  for (const params of calls) {
    assert.equal(params.user_id, 119);
    assert.equal(params.keyword, 'phone');
    assert.equal(params.type_arr, '1,2');
    assert.equal(params.is_child, 0);
    assert.equal(params.start, start);
    assert.equal(params.end, end);
    assert.equal(params.page, 1);
    assert.equal(params.limit, 1);
    assert.equal('un_perfect_num' in params, false);
  }
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

test('RP repair stats render new, in-progress, completed, good, and bad metrics', () => {
  const context = loadHooks();
  const container = { innerHTML: '' };

  context.__testHooks.renderOrderCount(container, {
    kind: 'rp',
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
    counts: {
      doa: null,
      rp: { newOrders: 18, inProgress: 5, done: 10, positive: 7, negative: 3 },
    },
  });

  assert.match(container.innerHTML, /新订单[\s\S]*18/);
  assert.match(container.innerHTML, /进行中[\s\S]*5/);
  assert.match(container.innerHTML, /已完成[\s\S]*10/);
  assert.match(container.innerHTML, /良品/);
  assert.match(container.innerHTML, /不良品/);
  assert.match(container.innerHTML, /良品[\s\S]*?<td class="rate good">7<\/td>[\s\S]*?<td class="rate good">70\.0%<\/td>/);
  assert.match(container.innerHTML, /不良品[\s\S]*?<td class="rate bad">3<\/td>[\s\S]*?<td class="rate bad">30\.0%<\/td>/);
});

test('RP repair stats show unavailable good and bad rates when no orders completed', () => {
  const context = loadHooks();
  const container = { innerHTML: '' };

  context.__testHooks.renderOrderCount(container, {
    kind: 'rp',
    dr: {
      timezone: 'America/Los_Angeles',
      localStart: '2026-07-01 00:00:00',
      localEnd: '2026-07-01 23:59:59',
      start: '2026-07-01 15:00:00',
      end: '2026-07-02 14:59:59',
    },
    companyLabel: 'Nothing',
    counts: {
      doa: null,
      rp: { newOrders: 0, inProgress: 0, done: 0, positive: 0, negative: 0 },
    },
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
    'rp', query, {
      status: '2',
      timeType: '2',
      start: '2026-07-01 00:00:00',
      end: '2026-07-01 23:59:59',
      perfectNum: null,
    },
  );

  assert.equal(total, 3);
  assert.equal(query.user_id, 7);
  assert.equal(query.type_arr, '1,2');
  assert.equal('type' in query, false);
  assert.equal(context.__lastApiCall.params.user_id, 7);
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
      if (selector === '.tz-select') return { value: 'America/Los_Angeles' };
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
    context.__testHooks.countOrders('rp', {}, {
      status: '2',
      timeType: '2',
      start: '2026-07-01 00:00:00',
      end: '2026-07-01 23:59:59',
      perfectNum: null,
    }),
    /会话已失效/,
  );
});

test('order counts reject responses without pagination totals', async () => {
  const context = loadHooks({ response: { code: 200, data: [{}] } });

  await assert.rejects(
    context.__testHooks.countOrders('rp', {}, {
      status: '2',
      timeType: '2',
      start: '2026-07-01 00:00:00',
      end: '2026-07-01 23:59:59',
      perfectNum: null,
    }),
    /meta\.total/,
  );

  context.__apiResponse = { code: 200, data: [], meta: { total: null } };
  await assert.rejects(
    context.__testHooks.countOrders('rp', {}, {
      status: '2',
      timeType: '2',
      start: '2026-07-01 00:00:00',
      end: '2026-07-01 23:59:59',
      perfectNum: null,
    }),
    /meta\.total/,
  );
});
