import { createApp } from "vue";
import { Quasar, Dark, Notify } from "quasar";
import "@quasar/extras/material-icons/material-icons.css";
import "quasar/src/css/index.sass";
import App from "./App.vue";

const app = createApp(App);
// Notify is needed for the non-interrupting task_notification toast (see
// App.vue) — every other plugin stays off, same as before.
app.use(Quasar, { plugins: { Notify } });
Dark.set(true);
app.mount("#app");

// Registers the offline/installable-app service worker (webapp/public/sw.js
// — see WEBAPP.md's "Installable, offline-capable PWA" section). Wrapped in
// a feature check and try/catch rather than assumed present: this must never
// block or break a normal page load on a browser without SW support.
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => {});
  });
}
