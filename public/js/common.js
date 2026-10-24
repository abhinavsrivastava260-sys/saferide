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
const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const pad = (n) => String(n).padStart(2, '0');
const fmtClock = (t) => { if (!t) return '—'; const d = new Date(t); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const fmtDay = (t) => { const d = new Date(t); return `${DAYS[(d.getDay() + 6) % 7].toUpperCase()} ${d.getDate()}`; };
const fmtTime = (t) => (t ? `${fmtDay(t)} · ${fmtClock(t)}` : '—');
const statusLabel = (s) => String(s).replace('_', ' ');
const st = (s) => `<span class="st ${esc(s)}">${esc(statusLabel(s))}</span>`;
const money = (v) => (v == null ? '—' : '₹' + Number(v).toFixed(2));
const coord = (lat, lng) => `${Number(lat).toFixed(3)} N ${Number(lng).toFixed(3)} E`;

// Wraps a click handler so the button is disabled while it runs and errors show as toasts.
function busy(btn, fn) {
  return async (...args) => {
    if (btn) btn.disabled = true;
    try { await fn(...args); } catch (e) { toast(e.message, true); } finally { if (btn) btn.disabled = false; }
  };
}

// A few Vellore landmarks (approximate positions) so points read as places, not just numbers.
const LANDMARKS = [
  ['Katpadi Junction', 12.9717, 79.1376],
  ['VIT Main Gate', 12.9692, 79.1559],
  ['Chittoor Bus Stand', 12.9745, 79.1430],
  ['Gandhi Nagar', 12.9580, 79.1380],
  ['Bagayam', 12.8960, 79.1350],
  ['CMC Hospital', 12.9246, 79.1356],
  ['Vellore Fort', 12.9206, 79.1290],
  ['New Bus Stand', 12.9345, 79.1365],
  ['Sathuvachari', 12.9395, 79.1625],
  ['Brahmapuram', 12.9880, 79.1650],
  ['Sevur', 12.9900, 79.1900],
  ['Thiruvalam Road', 12.9800, 79.1200],
];
function placeName(lat, lng) {
  let best = null; let bestKm = Infinity;
  for (const [name, la, ln] of LANDMARKS) {
    const km = Math.hypot((la - lat) * 111, (ln - lng) * 108.6);
    if (km < bestKm) { bestKm = km; best = name; }
  }
  if (bestKm < 0.35) return best;
  if (bestKm < 2) return `near ${best}`;
  return 'Dropped pin';
}
const shortPlace = (name) => name.replace(/^near /, '').replace(' Junction', ' Jn').replace(' Main Gate', '');

// ---------- map ----------
function baseMap(el, opts = {}) {
  const map = L.map(el, { zoomControl: opts.zoomControl !== false, attributionControl: true }).setView([12.962, 79.155], 13);
  L.tileLayer('/tiles/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
  }).addTo(map);
  return map;
}

function placeMarker(layer, lat, lng, { filled = false, label = '' } = {}) {
  const m = L.circleMarker([lat, lng], {
    radius: 6, weight: 2, color: filled ? '#ff5a36' : '#eee8dc',
    fillColor: filled ? '#ff5a36' : '#151412', fillOpacity: 1,
  }).addTo(layer);
  if (label) m.bindTooltip(esc(label), { permanent: true, direction: 'right', className: 'place', offset: [6, 0] });
  return m;
}

function routeLine(layer, a, b) {
  // A gentle curve between the two points, like a pen line on a printed map.
  const [la1, ln1] = a; const [la2, ln2] = b;
  const mid = [(la1 + la2) / 2 + (ln2 - ln1) * 0.18, (ln1 + ln2) / 2 - (la2 - la1) * 0.18];
  const pts = [];
  for (let t = 0; t <= 1.0001; t += 0.05) {
    pts.push([(1 - t) ** 2 * la1 + 2 * (1 - t) * t * mid[0] + t * t * la2, (1 - t) ** 2 * ln1 + 2 * (1 - t) * t * mid[1] + t * t * ln2]);
  }
  return L.polyline(pts, { color: '#ff5a36', weight: 1.8, interactive: false }).addTo(layer);
}

async function drawZones(map, layer) {
  const zones = await api('GET', '/zones');
  layer.clearLayers();
  zones.filter((z) => !z.name.startsWith('proof-')).forEach((z) => {
    L.geoJSON(z.boundary, { style: { color: '#8c867a', weight: 1, opacity: 0.6, fillOpacity: 0, dashArray: '2 5' } })
      .bindTooltip(`${esc(z.name).toUpperCase()} · ${z.available}/${z.drivers} FREE`, { sticky: true, className: 'zone' })
      .addTo(layer);
  });
  return zones;
}

function zoneAt(zones, lat, lng) {
  // Ray casting over the zone polygon (the server makes the real decision with ST_Covers).
  return zones.find((z) => {
    const ring = z.boundary.coordinates[0];
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i]; const [xj, yj] = ring[j];
      if ((yi > lat) !== (yj > lat) && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  });
}

// ---------- departure-board tiles ----------
// Renders text as split-flap tiles. Characters inside [brackets] are drawn in red.
function flap(el, text, maxLen = 18) {
  const prev = el.dataset.text || '';
  el.dataset.text = text;
  let hl = false; const chars = [];
  for (const ch of text.toUpperCase()) {
    if (ch === '[') { hl = true; continue; }
    if (ch === ']') { hl = false; continue; }
    chars.push([ch, hl]);
  }
  const prevChars = prev.replace(/[[\]]/g, '').toUpperCase();
  el.innerHTML = chars.slice(0, maxLen).map(([ch, h], i) => (ch === ' ' ? '<span class="sp"></span>'
    : `<span class="${h ? 'hl' : ''}${prevChars[i] !== ch ? ' flip' : ''}">${esc(ch)}</span>`)).join('');
}

function startClock(el) {
  const tick = () => { const d = new Date(); el.textContent = `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
  tick();
  setInterval(tick, 10000);
}

function greeting() {
  const h = new Date().getHours();
  return h < 5 ? 'Late night' : h < 12 ? 'Morning' : h < 17 ? 'Afternoon' : 'Evening';
}
