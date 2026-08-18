'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const sourcePath = path.join(__dirname, '..', 'besender-aggregate.user.js');
const source = fs.readFileSync(sourcePath, 'utf8');

class FakeClassList {
  constructor() { this.values = new Set(); }
  add(...values) { values.forEach(value => this.values.add(value)); }
  remove(...values) { values.forEach(value => this.values.delete(value)); }
  toggle(value, force) {
    if (force === true) this.values.add(value);
    else if (force === false) this.values.delete(value);
    else if (this.values.has(value)) this.values.delete(value);
    else this.values.add(value);
    return this.values.has(value);
  }
  contains(value) { return this.values.has(value); }
}

class FakeElement {
  constructor(tagName = 'div') {
    this.tagName = String(tagName).toUpperCase();
    this.children = [];
    this.parentElement = null;
    this.attributes = new Map();
    this.listeners = new Map();
    this.classList = new FakeClassList();
    this.className = '';
    this.id = '';
    this.textContent = '';
    this.iconFragments = new Set();
  }
  appendChild(child) {
    child.parentElement = this;
    this.children.push(child);
    return child;
  }
  insertBefore(child, before) {
    child.parentElement = this;
    const index = this.children.indexOf(before);
    if (index < 0) this.children.push(child);
    else this.children.splice(index, 0, child);
    return child;
  }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.has(name) ? this.attributes.get(name) : null; }
  hasAttribute(name) { return this.attributes.has(name); }
  removeAttribute(name) { this.attributes.delete(name); }
  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(listener);
  }
  querySelector(selector) {
    for (const fragment of this.iconFragments) {
      if (selector.includes(fragment)) return { className: fragment };
    }
    return null;
  }
}

class FakeDocument {
  constructor() {
    this.writes = [];
    this.cookies = new Map();
    this.documentElement = new FakeElement('html');
    this.head = new FakeElement('head');
    this.body = new FakeElement('body');
    this.documentElement.appendChild(this.head);
    this.documentElement.appendChild(this.body);
    this.readyState = 'complete';
    this.menuItems = [];
  }
  seedCookie(name, value) { this.cookies.set(name, encodeURIComponent(value)); }
  get cookie() {
    return Array.from(this.cookies, ([name, value]) => `${name}=${value}`).join('; ');
  }
  set cookie(line) {
    this.writes.push(line);
    const first = String(line).split(';', 1)[0];
    const separator = first.indexOf('=');
    if (separator < 1) return;
    this.cookies.set(first.slice(0, separator), first.slice(separator + 1));
  }
  createElement(tagName) { return new FakeElement(tagName); }
  createElementNS(_namespace, tagName) { return new FakeElement(tagName); }
  addEventListener() {}
  querySelectorAll(selector) {
    if (selector === 'ul.ivu-dropdown-menu li.ivu-dropdown-item') return this.menuItems;
    return [];
  }
  getElementById(id) {
    const visit = (node) => {
      if (!node) return null;
      if (node.id === id) return node;
      for (const child of node.children || []) {
        const found = visit(child);
        if (found) return found;
      }
      return null;
    };
    return visit(this.documentElement);
  }
}

class FakeWindow {
  constructor() {
    this.listeners = new Map();
    this.top = this;
    this.opener = null;
  }
  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(listener);
  }
  removeEventListener(type, listener) {
    if (this.listeners.has(type)) this.listeners.get(type).delete(listener);
  }
  dispatchEvent(event) {
    for (const listener of this.listeners.get(event.type) || []) listener.call(this, event);
    return true;
  }
  emit(type, event) {
    for (const listener of Array.from(this.listeners.get(type) || [])) listener.call(this, event);
  }
  listenerCount(type) { return (this.listeners.get(type) || new Set()).size; }
}

class FakeCustomEvent {
  constructor(type, options = {}) {
    this.type = type;
    this.detail = options.detail;
  }
}

function instrumentBridgeHooks() {
  const bootMarker = '  // ── Boot ────────────────────────────────────────────────────────────────';
  const instrumented = source.replace(
    bootMarker,
    `  globalThis.__bridgeHooks = {
    DASHBOARD_ORIGIN,
    BMS_ORIGIN,
    BMS_READY_MESSAGE,
    BMS_TRANSFER_MESSAGE,
    BMS_RESULT_MESSAGE,
    DASHBOARD_PROBE_EVENT,
    DASHBOARD_PROBE_READY_EVENT,
    validBridgeId,
    randomBridgeId,
    normalizeBmsBearerToken,
    rawAccessToken,
    bmsAuthTarget,
    cookieValue,
    writeBmsAuthCookie,
    bridgeResultMessage,
    installDashboardBridgeProbe,
    installBmsSessionReceiver,
    activeBmsRawAccessToken,
    copyActiveBmsToken,
    normalizedMenuText,
    findLogoutMenuItems,
    findLogoutMenuItem,
    findCommonToolsMenuItem,
    copyTokenFeedbackMessage,
    ensureCopyTokenStyle,
    createCopyTokenMenuItem,
    injectCopyTokenMenuItems,
  };
  return;

${bootMarker}`,
  );
  assert.notEqual(instrumented, source, 'bridge test seam must be installed');
  return instrumented;
}

function loadBridgeHarness({ pathname = '/test-harness', now = 1_000 } = {}) {
  const document = new FakeDocument();
  const window = new FakeWindow();
  const location = {
    pathname,
    search: '',
    hash: '',
    replacedWith: null,
    replace(url) { this.replacedWith = url; },
  };
  const timers = new Map();
  let nextTimerId = 1;
  let clock = now;
  const NativeDate = Date;
  class ClockDate extends NativeDate {
    static now() { return clock; }
  }
  const storageWrites = [];
  const context = {
    URL,
    URLSearchParams,
    CustomEvent: FakeCustomEvent,
    Date: ClockDate,
    Intl,
    console: {
      log() {}, info() {}, warn() {}, error() {},
    },
    crypto: {
      randomUUID: () => 'popup_nonce_1234567890abcdef',
    },
    document,
    location,
    localStorage: {
      getItem: () => '',
      removeItem(key) { storageWrites.push(['remove', key]); },
      setItem(key, value) { storageWrites.push(['set', key, value]); },
    },
    navigator: {},
    clearTimeout(id) { timers.delete(id); },
    setTimeout(callback) {
      const id = nextTimerId++;
      timers.set(id, callback);
      return id;
    },
    window,
  };
  vm.createContext(context);
  vm.runInContext(instrumentBridgeHooks(), context, { filename: sourcePath });
  return {
    context,
    document,
    window,
    location,
    hooks: context.__bridgeHooks,
    storageWrites,
    setNow(value) { clock = value; },
    runTimers() {
      const pending = Array.from(timers.values());
      timers.clear();
      pending.forEach(callback => callback());
    },
    timerCount: () => timers.size,
  };
}

function menuItem(text, iconFragment = '') {
  const item = new FakeElement('li');
  item.className = 'ivu-dropdown-item';
  item.textContent = text;
  if (iconFragment) item.iconFragments.add(iconFragment);
  return item;
}

test('userscript metadata is narrowly scoped and runs before BMS application code', () => {
  assert.match(source, /@match\s+https:\/\/bms\.besender\.com\/bsd-warehouse\/\*/);
  assert.match(source, /@match\s+https:\/\/bms\.besender\.com\/bsdAdmin\/\*/);
  assert.match(source, /@match\s+https:\/\/dashboard\.besender\.lyp04\.com\/\*/);
  assert.match(source, /@run-at\s+document-start/);
  assert.match(source, /@noframes/);
});

test('token normalization produces exactly one Bearer prefix and rejects malformed values', () => {
  const { hooks } = loadBridgeHarness();
  const raw = 'abcDEF1234567890.xyz_ABCDEFGHIJK';

  assert.equal(hooks.normalizeBmsBearerToken(raw), `Bearer ${raw}`);
  assert.equal(hooks.normalizeBmsBearerToken(`Bearer ${raw}`), `Bearer ${raw}`);
  assert.equal(hooks.normalizeBmsBearerToken(`bearer ${raw}`), `Bearer ${raw}`);
  assert.equal(hooks.rawAccessToken(`Bearer ${raw}`), raw);
  assert.equal(hooks.normalizeBmsBearerToken(`Bearer Bearer ${raw}`), '');
  assert.equal(hooks.normalizeBmsBearerToken('short'), '');
  assert.equal(hooks.normalizeBmsBearerToken(`${raw}\nother`), '');
});

test('auth cookie writes are role-allowlisted, session-only, and host-path constrained', () => {
  const { hooks, document } = loadBridgeHarness();
  const raw = 'warehouse_token_1234567890.abcdef';

  const warehouse = hooks.writeBmsAuthCookie(raw, 3);
  assert.equal(warehouse.ok, true);
  assert.equal(warehouse.cookieName, 'warehouseToken');
  assert.equal(warehouse.destination, 'warehouse');
  assert.match(document.writes[0], /^warehouseToken=Bearer%20warehouse_token_/);
  assert.match(document.writes[0], /; Path=\/; Secure; SameSite=Lax$/);
  assert.doesNotMatch(document.writes[0], /Max-Age|Expires/i);
  assert.equal(document.cookies.has('adminToken'), false);

  const admin = hooks.writeBmsAuthCookie(`Bearer ${raw}`, '6');
  assert.equal(admin.ok, true);
  assert.equal(admin.cookieName, 'adminToken');
  assert.equal(admin.destination, 'admin');
  assert.equal(hooks.cookieValue('adminToken'), `Bearer ${raw}`);

  const writesBeforeUnsupportedRole = document.writes.length;
  for (const unsupported of [2, 4, 7, 8, 11, null]) {
    assert.equal(hooks.writeBmsAuthCookie(raw, unsupported).code, 'unsupported_user_type');
  }
  assert.equal(document.writes.length, writesBeforeUnsupportedRole);
});

test('BMS receiver accepts one nonce-bound transfer only from the exact Dashboard opener', () => {
  const harness = loadBridgeHarness({ pathname: '/bsd-warehouse/home' });
  const { hooks, window, document, location } = harness;
  const sent = [];
  const dashboardWindow = {
    postMessage(message, targetOrigin) { sent.push({ message, targetOrigin }); },
  };
  window.opener = dashboardWindow;

  const receiver = hooks.installBmsSessionReceiver();
  assert.ok(receiver);
  assert.equal(receiver.popupNonce, 'popup_nonce_1234567890abcdef');
  assert.equal(window.listenerCount('message'), 1);
  assert.equal(sent.length, 1);
  assert.deepEqual({ ...sent[0].message }, {
    type: 'besender-tools:bms-ready',
    protocol: 1,
    popupNonce: 'popup_nonce_1234567890abcdef',
    expiresInMs: 30000,
  });
  assert.equal(sent[0].targetOrigin, 'https://dashboard.besender.lyp04.com');

  const raw = 'warehouse_token_1234567890.abcdef';
  const transfer = {
    type: 'besender-tools:token-transfer',
    protocol: 1,
    requestId: 'request_1234567890abcdef',
    popupNonce: receiver.popupNonce,
    token: raw,
    userType: 3,
  };
  window.emit('message', {
    origin: 'https://evil.example', source: dashboardWindow, data: transfer,
  });
  window.emit('message', {
    origin: 'https://dashboard.besender.lyp04.com', source: {}, data: transfer,
  });
  window.emit('message', {
    origin: 'https://dashboard.besender.lyp04.com', source: dashboardWindow,
    data: { ...transfer, popupNonce: 'wrong_nonce_1234567890' },
  });
  assert.equal(document.writes.length, 0);
  assert.equal(sent.length, 1);

  window.emit('message', {
    origin: 'https://dashboard.besender.lyp04.com', source: dashboardWindow, data: transfer,
  });
  assert.equal(document.writes.length, 1);
  assert.equal(window.listenerCount('message'), 0);
  assert.equal(window.opener, null);
  assert.equal(sent.length, 2);
  assert.deepEqual({ ...sent[1].message }, {
    type: 'besender-tools:handoff-result',
    protocol: 1,
    requestId: 'request_1234567890abcdef',
    popupNonce: 'popup_nonce_1234567890abcdef',
    ok: true,
    code: 'ok',
    error: null,
    destination: 'warehouse',
  });
  assert.equal(sent[1].targetOrigin, 'https://dashboard.besender.lyp04.com');
  assert.doesNotMatch(JSON.stringify(sent), new RegExp(raw));

  // The listener is gone, so replaying the structured message cannot write again.
  window.emit('message', {
    origin: 'https://dashboard.besender.lyp04.com', source: dashboardWindow, data: transfer,
  });
  assert.equal(document.writes.length, 1);
  assert.equal(sent.length, 2);
  assert.equal(harness.timerCount(), 1, 'only the post-success navigation timer remains');
  harness.runTimers();
  assert.equal(location.replacedWith, 'https://bms.besender.com/bsd-warehouse/home');
  assert.equal(harness.storageWrites.length, 0);
});

test('BMS receiver rejects unsupported roles without writing a cookie or leaking the token', () => {
  const harness = loadBridgeHarness({ pathname: '/bsd-warehouse/home' });
  const { hooks, window, document } = harness;
  const sent = [];
  const dashboardWindow = {
    postMessage(message, targetOrigin) { sent.push({ message, targetOrigin }); },
  };
  window.opener = dashboardWindow;
  const receiver = hooks.installBmsSessionReceiver();
  const raw = 'partner_token_1234567890.abcdef';

  window.emit('message', {
    origin: 'https://dashboard.besender.lyp04.com',
    source: dashboardWindow,
    data: {
      type: 'besender-tools:token-transfer',
      protocol: 1,
      requestId: 'request_unsupported_123456',
      popupNonce: receiver.popupNonce,
      token: raw,
      userType: 7,
    },
  });

  assert.equal(document.writes.length, 0);
  assert.equal(sent.at(-1).message.code, 'unsupported_user_type');
  assert.equal(sent.at(-1).message.error, 'unsupported_user_type');
  assert.equal(sent.at(-1).message.ok, false);
  assert.doesNotMatch(JSON.stringify(sent), new RegExp(raw));
  assert.equal(window.listenerCount('message'), 0);
});

test('BMS receiver removes its message listener after the 30-second TTL', () => {
  const harness = loadBridgeHarness({ pathname: '/bsd-warehouse/home' });
  const { hooks, window, document } = harness;
  const dashboardWindow = { postMessage() {} };
  window.opener = dashboardWindow;
  hooks.installBmsSessionReceiver();

  assert.equal(window.listenerCount('message'), 1);
  harness.runTimers();
  assert.equal(window.listenerCount('message'), 0);
  assert.equal(document.writes.length, 0);
});

test('Dashboard CustomEvent probe returns capabilities but never reflects token data', () => {
  const { hooks, window } = loadBridgeHarness();
  const readyEvents = [];
  const legacyReadyEvents = [];
  window.addEventListener('besender-tools:ready', event => readyEvents.push(event));
  window.addEventListener('besender-dashboard:bms-bridge-ready', event => legacyReadyEvents.push(event));
  hooks.installDashboardBridgeProbe();

  const secret = 'must_not_be_reflected_1234567890';
  window.dispatchEvent(new FakeCustomEvent('besender-dashboard:probe', {
    detail: {
      protocol: 1,
      requestId: 'request_probe_1234567890',
      token: secret,
    },
  }));

  assert.equal(readyEvents.length, 1);
  assert.equal(legacyReadyEvents.length, 1);
  assert.equal(readyEvents[0].detail.protocol, 1);
  assert.equal(readyEvents[0].detail.requestId, 'request_probe_1234567890');
  assert.deepEqual(Array.from(readyEvents[0].detail.capabilities), [
    'popup-token-transfer-v1', 'copy-token',
  ]);
  assert.doesNotMatch(JSON.stringify(readyEvents[0].detail), new RegExp(secret));
  assert.equal(Object.hasOwn(readyEvents[0].detail, 'token'), false);

  window.dispatchEvent(new FakeCustomEvent('besender-dashboard:probe', {
    detail: { protocol: 99, requestId: 'request_probe_1234567890' },
  }));
  assert.equal(readyEvents.length, 1, 'incompatible probe protocol is ignored');
});

test('Copy Token chooses the cookie for the current BMS application and copies raw access_token', async () => {
  const harness = loadBridgeHarness({ pathname: '/bsd-warehouse/home' });
  const { hooks, document, location } = harness;
  const warehouseRaw = 'warehouse_token_1234567890.abcdef';
  const adminRaw = 'admin_token_1234567890.uvwxyz';
  document.seedCookie('warehouseToken', `Bearer ${warehouseRaw}`);
  document.seedCookie('adminToken', `Bearer ${adminRaw}`);
  const copied = [];
  const clipboard = { async writeText(value) { copied.push(value); } };

  assert.equal(hooks.activeBmsRawAccessToken(), warehouseRaw);
  assert.deepEqual({ ...(await hooks.copyActiveBmsToken(clipboard)) }, { ok: true, code: 'copied' });
  assert.deepEqual(copied, [warehouseRaw]);
  assert.doesNotMatch(copied[0], /^Bearer\s/i);

  location.pathname = '/bsdAdmin/home';
  assert.equal(hooks.activeBmsRawAccessToken(), adminRaw);
  await hooks.copyActiveBmsToken(clipboard);
  assert.deepEqual(copied, [warehouseRaw, adminRaw]);

  location.pathname = '/bsd-warehouse/home';
  document.cookies.delete('warehouseToken');
  assert.equal(hooks.activeBmsRawAccessToken(), '', 'a stale admin cookie is not used in warehouse');
  assert.deepEqual({ ...(await hooks.copyActiveBmsToken(clipboard)) }, {
    ok: false, code: 'missing_token',
  });
});

test('Copy Token reports clipboard denial without a DOM/token fallback', async () => {
  const { hooks, document } = loadBridgeHarness({ pathname: '/bsd-warehouse/home' });
  const raw = 'warehouse_token_1234567890.abcdef';
  document.seedCookie('warehouseToken', `Bearer ${raw}`);
  const denied = await hooks.copyActiveBmsToken({
    async writeText() { throw new Error('permission denied'); },
  });

  assert.deepEqual({ ...denied }, { ok: false, code: 'clipboard_denied' });
  assert.match(hooks.copyTokenFeedbackMessage(denied, 'zh'), /复制失败/);
  assert.doesNotMatch(hooks.copyTokenFeedbackMessage(denied, 'zh'), new RegExp(raw));
});

test('avatar dropdown locator prefers stable icons and falls back to localized exact text', () => {
  const { hooks } = loadBridgeHarness();
  const textOnlyLogout = menuItem('退出登录');
  const common = menuItem('Anything', 'md-reorder');
  const iconLogout = menuItem('Anything else', 'ios-log-out');
  const root = {
    querySelectorAll: () => [textOnlyLogout, common, iconLogout],
  };

  assert.equal(hooks.findLogoutMenuItem(root), iconLogout);
  assert.equal(hooks.findCommonToolsMenuItem(root), common);

  const spanishLogout = menuItem('  Cerrar   sesión  ');
  const spanishTools = menuItem('Herramientas comunes');
  const localizedRoot = { querySelectorAll: () => [spanishTools, spanishLogout] };
  assert.equal(hooks.findLogoutMenuItem(localizedRoot), spanishLogout);
  assert.equal(hooks.findCommonToolsMenuItem(localizedRoot), spanishTools);
  assert.equal(hooks.normalizedMenuText('  Cerrar   SESIÓN '), 'cerrar sesión');
});

test('Copy Token is inserted between Common Tools and Logout with keyboard semantics', () => {
  const { hooks, document } = loadBridgeHarness({ pathname: '/bsd-warehouse/home' });
  const menu = new FakeElement('ul');
  const common = menuItem('常用工具', 'md-reorder');
  const existingItem = menuItem('个人设置');
  const logout = menuItem('退出登录', 'ios-log-out');
  menu.appendChild(common);
  menu.appendChild(existingItem);
  menu.appendChild(logout);
  document.menuItems = [common, existingItem, logout];

  assert.equal(hooks.injectCopyTokenMenuItems(document), 1);
  assert.equal(menu.children.length, 4);
  const copyItem = menu.children[1];
  assert.equal(menu.children[0], common);
  assert.equal(menu.children[2], existingItem);
  assert.equal(menu.children[3], logout);
  assert.equal(copyItem.hasAttribute('data-besender-copy-token'), true);
  assert.equal(copyItem.getAttribute('role'), 'menuitem');
  assert.equal(copyItem.getAttribute('tabindex'), '0');
  assert.equal(copyItem.getAttribute('aria-label'), '复制 Token');
  assert.equal(copyItem.listeners.has('click'), true);
  assert.equal(copyItem.listeners.has('keydown'), true);
  assert.equal(hooks.injectCopyTokenMenuItems(document), 0, 'injection is idempotent');

  hooks.ensureCopyTokenStyle();
  const style = document.getElementById('besender-copy-token-style');
  assert.ok(style);
  assert.match(style.textContent, /min-height:\s*44px/);
  assert.match(style.textContent, /:focus-visible/);
  assert.match(style.textContent, /prefers-reduced-motion/);
});
