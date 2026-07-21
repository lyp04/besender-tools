'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const sourcePath = path.join(__dirname, '..', 'besender-aggregate.user.js');
const source = fs.readFileSync(sourcePath, 'utf8');

function loadHooks({ response = null } = {}) {
  const apiStub = `  async function apiGet(path, params) {
    globalThis.__lastApiCall = { path, params };
    return globalThis.__apiResponse;
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
    localStorage: {
      getItem: () => 'Asia/Shanghai',
      removeItem() {},
      setItem() {},
    },
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
    { page: 9, limit: 10, type_arr: '1,2', is_child: 0, service_type: 'mail', user_id: 7 },
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
