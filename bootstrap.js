// BESENDER Tools — bootstrap content script.
//
// Asks the background service worker to fetch the latest
// besender-aggregate.user.js, then injects it into the page's main world via
// a Blob-URL <script> tag. Caches code + ETag in chrome.storage.local so
// subsequent loads use If-None-Match conditional requests (HTTP 304).

(async () => {
  const CACHE_KEY  = 'scriptCache';
  const LOG_PREFIX = '[BESENDER Tools]';

  const { [CACHE_KEY]: cached = null } = await chrome.storage.local.get(CACHE_KEY);

  let code    = null;
  let version = null;

  const response = await new Promise((resolve) => {
    chrome.runtime.sendMessage(
      { type: 'bsd-fetch-script', etag: cached && cached.etag },
      (resp) => {
        if (chrome.runtime.lastError) {
          resolve({ ok: false, err: chrome.runtime.lastError.message });
        } else {
          resolve(resp || { ok: false, err: 'empty response' });
        }
      }
    );
  });

  if (response.ok && response.notModified && cached) {
    code    = cached.code;
    version = cached.version;
  } else if (response.ok && response.code) {
    code    = response.code;
    version = (code.match(/@version\s+(\S+)/) || [])[1] || null;
    await chrome.storage.local.set({
      [CACHE_KEY]: { code, etag: response.etag || '', ts: Date.now(), version },
    });
  } else if (cached && cached.code) {
    console.warn(LOG_PREFIX, '拉取失败，使用缓存：', response.err || ('HTTP ' + response.status), response.body || '');
    code    = cached.code;
    version = cached.version;
  } else {
    console.error(LOG_PREFIX, '拉取失败且无缓存：', response.err || ('HTTP ' + response.status), response.body || '');
    return;
  }

  if (!code) return;

  const blob = new Blob([code], { type: 'application/javascript' });
  const url  = URL.createObjectURL(blob);
  const s    = document.createElement('script');
  s.src = url;
  s.dataset.bsdInjected = '1';
  if (version) s.dataset.bsdVersion = version;
  s.onload  = () => { URL.revokeObjectURL(url); s.remove(); };
  s.onerror = (e) => { URL.revokeObjectURL(url); console.error(LOG_PREFIX, 'script load error', e); };
  (document.head || document.documentElement).appendChild(s);

  if (version) console.log(LOG_PREFIX, '已注入 v' + version);
})();
