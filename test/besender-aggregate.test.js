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
    countOrders,
    countOrderStats,
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
      getItem: () => 'Asia/Shanghai',
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

test('DOA/RP default date ignores the timezone saved by other panels', () => {
  const context = loadHooks();

  // At this instant it is July 21 in Los Angeles and July 22 in Shanghai.
  assert.equal(context.__testHooks.localTodayStr(), '2026-07-22');
  assert.equal(context.__testHooks.pageLocalTodayStr(), '2026-07-21');
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

test('order stats render positive and negative counts, percentages, and totals', () => {
  const context = loadHooks();
  const container = { innerHTML: '' };

  context.__testHooks.renderOrderCount(container, {
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

test('order stats show an em dash percentage when completed count is zero', () => {
  const context = loadHooks();
  const container = { innerHTML: '' };

  context.__testHooks.renderOrderCount(container, {
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
    context.__testHooks.countOrders('rp', {}, '2', '2026-07-01 00:00:00', '2026-07-01 23:59:59'),
    /会话已失效/,
  );
});

test('order counts reject responses without pagination totals', async () => {
  const context = loadHooks({ response: { code: 200, data: [{}] } });

  await assert.rejects(
    context.__testHooks.countOrders('rp', {}, '2', '2026-07-01 00:00:00', '2026-07-01 23:59:59'),
    /meta\.total/,
  );

  context.__apiResponse = { code: 200, data: [], meta: { total: null } };
  await assert.rejects(
    context.__testHooks.countOrders('rp', {}, '2', '2026-07-01 00:00:00', '2026-07-01 23:59:59'),
    /meta\.total/,
  );
});
