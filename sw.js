// 更新したらこのバージョン番号を上げる（接頭辞 mine- の古いキャッシュだけを消す）
const VERSION = 'mine-v1';
const FILES = ['./', './index.html', './core.js', './db.js', './manifest.webmanifest', './icon-192.png', './icon-512.png', './apple-touch-icon.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(FILES)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k.startsWith('mine-') && k !== VERSION).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});
// ネットが使えるときは最新を取り、使えないときはキャッシュで開く
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  e.respondWith(
    fetch(req).then(res => {
      const copy = res.clone();
      caches.open(VERSION).then(c => c.put(req, copy));
      return res;
    }).catch(() => caches.match(req).then(r => r || caches.match('./index.html')))
  );
});
