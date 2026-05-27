// Background service worker — handles the actual GitHub fetch.
//
// MV3 content scripts sometimes hit CORS-flavoured failures even when
// host_permissions match. Doing the fetch from a service worker is the
// canonical robust pattern: background workers have unconditional fetch
// to any host listed in host_permissions, and they can talk to content
// scripts via chrome.runtime messages.

const PAT     = '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';
const API_URL = 'https://api.github.com/repos/lyp04/besender-tools/contents/besender-aggregate.user.js?ref=main';

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg && msg.type === 'bsd-fetch-script') {
    (async () => {
      try {
        const headers = {
          'Authorization': 'Bearer ' + PAT,
          'Accept':        'application/vnd.github.raw',
          'X-GitHub-Api-Version': '2022-11-28',
        };
        if (msg.etag) headers['If-None-Match'] = msg.etag;
        const r = await fetch(API_URL, { headers, cache: 'no-store' });
        if (r.status === 304) {
          sendResponse({ ok: true, notModified: true });
          return;
        }
        if (!r.ok) {
          const body = await r.text().catch(() => '');
          sendResponse({ ok: false, status: r.status, body });
          return;
        }
        const code = await r.text();
        sendResponse({ ok: true, code, etag: r.headers.get('etag') || '' });
      } catch (err) {
        sendResponse({ ok: false, err: (err && err.message) || String(err) });
      }
    })();
    return true; // keep the message channel open for the async sendResponse
  }
});
