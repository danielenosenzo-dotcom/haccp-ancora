importScripts('https://www.gstatic.com/firebasejs/9.23.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/9.23.0/firebase-messaging-compat.js');

firebase.initializeApp({
  apiKey: "AIzaSyCiq4s0XNvXWe90VU1cYIZ8KyXLJpD3OXM",
  authDomain: "lancora-haccp.firebaseapp.com",
  projectId: "lancora-haccp",
  storageBucket: "lancora-haccp.firebasestorage.app",
  messagingSenderId: "263121790360",
  appId: "1:263121790360:web:18fbd1a9c0dff6809eb7ed"
});

const messaging = firebase.messaging();

messaging.onBackgroundMessage((payload) => {
  const title = payload.notification?.title || '🚨 Allarme Cella HACCP';
  const options = {
    body: payload.notification?.body || 'Una cella è fuori soglia',
    vibrate: [200, 100, 200, 100, 200],
    requireInteraction: true,
    tag: 'haccp-cella-alert',
  };
  self.registration.showNotification(title, options);
});
