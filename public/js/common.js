// Shared helpers for the rider/driver app and the admin page.
const store = {
  get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
  del(k) { try { localStorage.removeItem(k); } catch {} },
};

async function api(method, path, body, extraHeaders = {}) {
  const headers = { ...extraHeaders };
  const token = store.get('token');
  if (token) headers.authorization = 'Bearer ' + token;
  let payload;
  if (body instanceof FormData) payload = body;
  else if (body !== undefined) { headers['content-type'] = 'application/json'; payload = JSON.stringify(body); }
  const res = await fetch('/api' + path, { method, headers, body: payload });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || res.statusText);
    err.status = res.status;
    throw err;
  }
  return data;
}

let toastTimer;
function toast(msg, bad = false) {
  let el = document.querySelector('.toast');
  if (!el) { el = document.createElement('div'); el.className = 'toast'; document.body.appendChild(el); }
  el.textContent = msg;
  el.classList.toggle('bad', bad);
  el.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), bad ? 6000 : 3500);
}

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtTime = (t) => (t ? new Date(t).toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '–');
const fmtClock = (t) => (t ? new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '');
const statusLabel = (s) => String(s).replace('_', ' ');
const pill = (s) => `<span class="pill ${esc(s)}">${esc(statusLabel(s))}</span>`;
const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const money = (v) => (v == null ? '–' : '₹' + Number(v).toFixed(2));

// Wraps a button click so it is disabled while the request runs and errors show as toasts.
function busy(btn, fn) {
  return async (...args) => {
    if (btn) btn.disabled = true;
    try { await fn(...args); } catch (e) { toast(e.message, true); } finally { if (btn) btn.disabled = false; }
  };
}

function baseMap(el) {
  const map = L.map(el).setView([12.965, 79.15], 13);
  // Tiles come through our own server (src/tiles.js), which fetches and caches them.
  L.tileLayer('/tiles/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  }).addTo(map);
  return map;
}

function dotIcon(color, label = '', ink = '#fff') {
  return L.divIcon({
    className: '',
    html: `<div style="background:${color};color:${ink};width:26px;height:26px;border-radius:50%;border:2px solid #0b0b0c;box-shadow:0 0 0 2px rgba(255,255,255,.5);display:flex;align-items:center;justify-content:center;font:600 11px ui-monospace,monospace">${label}</div>`,
    iconSize: [26, 26], iconAnchor: [13, 13],
  });
}

async function drawZones(map, layer) {
  const zones = await api('GET', '/zones');
  layer.clearLayers();
  zones.forEach((z, i) => {
    const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim();
    const colors = [accent, '#7cb7ff', '#c4a7ff', '#5eead4', '#fb923c', '#f472b6'];
    L.geoJSON(z.boundary, { style: { color: colors[i % colors.length], weight: 1.5, fillOpacity: 0.07, dashArray: '4 4' } })
      .bindTooltip(`${esc(z.name)} · ${z.available}/${z.drivers} drivers free`, { sticky: true })
      .addTo(layer);
  });
  return zones;
}

// Theme picker in the header; the choice is remembered per browser.
(function setupTheme() {
  const sel = document.getElementById('themeSel');
  if (!sel) return;
  sel.value = document.documentElement.dataset.theme || 'asphalt';
  sel.addEventListener('change', () => {
    store.set('theme', sel.value);
    location.reload();
  });
})();
