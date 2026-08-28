/**
 * ODYS - Basit Service Worker
 *
 * Amaç: Uygulama kabuğunu (HTML/CSS/JS/ikonlar) önbelleğe alarak
 * - Android'de "Ana Ekrana Ekle" istemini (PWA yüklenebilirlik şartı) sağlamak
 * - Sayfanın bir sonraki açılışta anında yüklenmesini sağlamak
 *
 * NOT: Sınav verisi (Apps Script API çağrıları) KASITLI olarak önbelleğe
 * alınmıyor — her zaman canlı sunucudan çekilir. Yani bu "offline sınav
 * çözme" sağlamaz, sadece uygulamanın kabuğunu hızlı ve kurulabilir yapar.
 */

const CACHE_NAME = "odys-shell-v1";
const SHELL_FILES = ["./index.html", "./style.css", "./app.js", "./manifest.json"];

self.addEventListener("install", function (event) {
  event.waitUntil(
    caches.open(CACHE_NAME).then(function (cache) { return cache.addAll(SHELL_FILES); })
  );
  self.skipWaiting();
});

self.addEventListener("activate", function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.filter(function (k) { return k !== CACHE_NAME; }).map(function (k) { return caches.delete(k); }));
    })
  );
  self.clients.claim();
});

self.addEventListener("fetch", function (event) {
  const url = new URL(event.request.url);

  // Sadece kendi statik dosyalarımızı önbellekle; Apps Script API isteklerine
  // ve dış CDN'lere (Chart.js, SheetJS, Google Fonts) dokunma - hep ağdan gitsin.
  const isOwnShellFile = url.origin === self.location.origin;
  if (!isOwnShellFile || event.request.method !== "GET") return;

  event.respondWith(
    caches.match(event.request).then(function (cached) {
      return cached || fetch(event.request);
    })
  );
});
