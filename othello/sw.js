/* Othello service worker — offline-first app shell with network-first
   freshness for same-origin GETs. Cache version: bump to force update. */
'use strict';

var CACHE = 'othello-v1';
var ASSETS = [
  './',
  './index.html',
  './style.css',
  './game.js',
  './ui.js',
  './manifest.webmanifest',
  './icon.svg',
  './icon-192.png',
  './icon-512.png',
  './apple-touch-icon.png'
];

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(CACHE).then(function (cache) {
      return cache.addAll(ASSETS);
    }).then(function () {
      return self.skipWaiting();
    }).catch(function () { /* storage may be unavailable */ })
  );
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.filter(function (k) {
        return k !== CACHE;
      }).map(function (k) {
        return caches.delete(k);
      }));
    }).then(function () {
      return self.clients.claim();
    })
  );
});

self.addEventListener('fetch', function (event) {
  if (event.request.method !== 'GET') return;
  var url = new URL(event.request.url);
  if (url.origin !== location.origin) return;
  event.respondWith(
    fetch(event.request).then(function (res) {
      var copy = res.clone();
      caches.open(CACHE).then(function (cache) {
        cache.put(event.request, copy);
      }).catch(function () {});
      return res;
    }).catch(function () {
      return caches.match(event.request).then(function (hit) {
        if (hit) return hit;
        if (event.request.mode === 'navigate') {
          return caches.match('./index.html');
        }
        throw new Error('offline and not cached');
      });
    })
  );
});
