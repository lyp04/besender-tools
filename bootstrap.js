// BESENDER Tools — bootstrap content script.
//
// Fetches the latest `besender-aggregate.user.js` from the private GitHub repo
// and injects it into the page's main world via a Blob-URL <script> tag.
// ETag conditional requests make subsequent loads ~50 ms (HTTP 304).
//
// The PAT below is a read-only fine-grained token scoped to this single repo.
// It is not a credential to any production system — it can only read this
// extension's source code. The repo owner has accepted the trade-off.

(async () => {
  const PAT        = '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';
  // Use the GitHub Contents API rather than raw.githubusercontent.com — the API
  // sends CORS headers for authenticated cross-origin fetches; the raw host
  // doesn't, which causes a "Failed to fetch" in this extension context.
  const API_URL    = 'https://api.github.com/repos/lyp04/besender-tools/contents/besender-aggregate.user.js?ref=main';
  const CACHE_KEY  = 'scriptCache';
  const LOG_PREFIX = '[BESENDER Tools]';

  const { [CACHE_KEY]: cached = null } = await chrome.storage.local.get(CACHE_KEY);

  let code    = null;
  let version = null;
  try {
    const headers = {
      'Authorization': 'Bearer ' + PAT,
      'Accept':        'application/vnd.github.raw',
    };
    if (cached && cached.etag) headers['If-None-Match'] = cached.etag;
    const r = await fetch(API_URL, { headers, cache: 'no-store' });

    if (r.status === 304 && cached) {
      code    = cached.code;
      version = cached.version;
    } else if (r.ok) {
      code    = await r.text();
      version = (code.match(/@version\s+(\S+)/) || [])[1] || null;
      await chrome.storage.local.set({
        [CACHE_KEY]: { code, etag: r.headers.get('ETag') || '', ts: Date.now(), version },
      });
    } else {
      throw new Error('HTTP ' + r.status);
    }
  } catch (err) {
    if (cached && cached.code) {
      console.warn(LOG_PREFIX, '拉取失败，使用缓存：', err && err.message);
      code    = cached.code;
      version = cached.version;
    } else {
      console.error(LOG_PREFIX, '拉取失败且无缓存：', err);
      return;
    }
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
