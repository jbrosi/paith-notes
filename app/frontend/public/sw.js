// Minimal service worker — enables PWA install prompt.
// No offline caching for now; the app requires network for API calls.

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
