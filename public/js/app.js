// Rider and driver app. All state comes from the API; the socket only says "something changed".
const ACTIVE = ['requested', 'accepted', 'arrived', 'in_progress'];
const RATES = { bike: [20, 6], auto: [30, 10], hatchback: [40, 12], sedan: [50, 14], suv: [60, 18] }; // mirrors fare_for()
const TABS = {
  rider: [['ride', 'Ride'], ['schedule', 'Schedule'], ['regulars', 'Regulars'], ['history', 'History']],
  driver: [['drive', 'Drive'], ['zones', 'Zones'], ['history', 'History']],
};

const S = {
  me: null, rides: [], regulars: [], zones: [], socket: null, tab: null,
  map: null, zoneLayer: null, drawLayer: null,
  pickup: null, drop: null, armed: null,
  selectedRideId: null, dismissed: new Set(), offer: null, offerTimer: null, chatRide: null,
};

// ---------------- auth ----------------
function showAuth() {
  $('#authView').classList.remove('hidden');
  $('#appView').classList.add('hidden');
  if (!S.authMap) {
    S.authMap = baseMap('authMap', { zoomControl: false });
    const layer = L.layerGroup().addTo(S.authMap);
    drawZones(S.authMap, layer).catch(() => {});
    LANDMARKS.slice(0, 7).forEach(([n, la, ln]) => placeMarker(layer, la, ln, { label: n }));
  }
}

function setupAuth() {
  $$('#authTabs button').forEach((b) => b.addEventListener('click', () => {
    $$('#authTabs button').forEach((x) => x.classList.toggle('active', x === b));
    $('#loginForm').classList.toggle('hidden', b.dataset.tab !== 'login');
    $('#registerForm').classList.toggle('hidden', b.dataset.tab !== 'register');
  }));
  const role = $('#registerForm [name=role]');
  role.addEventListener('change', () => {
    $('.driverOnly').classList.toggle('hidden', role.value !== 'driver');
    $('.riderOnly').classList.toggle('hidden', role.value !== 'rider');
  });
  const login = async (email, password) => {
    try { onLoggedIn(await api('POST', '/auth/login', { email, password })); } catch (err) { toast(err.message, true); }
  };
  $('#loginForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    login(f.get('email'), f.get('password'));
  });
  $$('[data-demo]').forEach((b) => b.addEventListener('click', () => login(b.dataset.demo, 'password')));
  $('#registerForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    try { onLoggedIn(await api('POST', '/auth/register', Object.fromEntries(new FormData(e.target)))); toast('Account created'); }
    catch (err) { toast(err.message, true); }
  });
  $('#logout').addEventListener('click', () => { store.del('token'); location.reload(); });
}

function onLoggedIn({ token }) { store.set('token', token); start(); }

// ---------------- navigation ----------------
function buildNav() {
  $('#nav').innerHTML = TABS[S.me.role].map(([id, label]) => `<button data-tab="${id}">${label}</button>`).join('');
  $$('#nav button').forEach((b) => b.addEventListener('click', () => go(b.dataset.tab)));
  document.addEventListener('click', (e) => {
    const t = e.target.closest('[data-goto]');
    if (t) go(t.dataset.goto);
  });
}

function go(tab) {
  S.tab = tab;
  $$('#nav button').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  $$('.pane').forEach((p) => p.classList.toggle('hidden', p.dataset.pane !== tab));
  if (tab !== 'ride' && tab !== 'drive') arm(null);
  renderAll();
}

// ---------------- map ----------------
function setupMap() {
  S.map = baseMap('map');
  S.zoneLayer = L.layerGroup().addTo(S.map);
  S.drawLayer = L.layerGroup().addTo(S.map);
  S.map.on('click', (e) => onMapClick(e.latlng));
  setTimeout(() => S.map.invalidateSize(), 60);
  window.addEventListener('resize', () => S.map.invalidateSize());
}

function arm(what) {
  S.armed = what;
  $$('[data-field]').forEach((f) => f.classList.toggle('armed', f.dataset.field === what));
  const hint = $('#mapHint');
  hint.classList.toggle('hidden', !what);
  hint.textContent = what ? `Click the map to set ${what === 'position' ? 'your position' : what}` : '';
}

async function onMapClick({ lat, lng }) {
  lat = +lat.toFixed(6); lng = +lng.toFixed(6);
  if (S.me.role === 'driver') {
    if (S.armed !== 'position') return;
    try {
      await api('POST', '/driver/location', { lat, lng });
      S.me.lat = lat; S.me.lng = lng; arm(null); renderAll();
    } catch (e) { toast(e.message, true); }
    return;
  }
  if (S.tab !== 'ride' || riderBusy()) return;
  const which = S.armed || (!S.pickup ? 'pickup' : !S.drop ? 'drop' : null);
  if (!which) return;
  S[which] = { lat, lng };
  arm(which === 'pickup' && !S.drop ? 'drop' : null);
  renderAll();
}

function drawMap(points, { car, fitKey } = {}) {
  S.drawLayer.clearLayers();
  const [a, b] = points;
  // Frame a ride's route once when it first appears, without fighting the user's own panning after that.
  if (a && b && fitKey && S.fitted !== fitKey) {
    S.fitted = fitKey;
    S.map.fitBounds([[a.lat, a.lng], [b.lat, b.lng]], { padding: [120, 120], maxZoom: 15 });
  }
  if (a && b) routeLine(S.drawLayer, [a.lat, a.lng], [b.lat, b.lng]);
  if (a) placeMarker(S.drawLayer, a.lat, a.lng, { label: shortPlace(placeName(a.lat, a.lng)) });
  if (b) placeMarker(S.drawLayer, b.lat, b.lng, { filled: true, label: shortPlace(placeName(b.lat, b.lng)) });
  if (car) {
    L.circleMarker([car.lat, car.lng], { radius: 9, weight: 1.5, color: '#ff5a36', fillColor: '#ff5a36', fillOpacity: 0.18 }).addTo(S.drawLayer);
    L.circleMarker([car.lat, car.lng], { radius: 3, weight: 0, fillColor: '#ff5a36', fillOpacity: 1 })
      .bindTooltip('you', { permanent: true, direction: 'right', className: 'place', offset: [8, 0] }).addTo(S.drawLayer);
  }
}

// ---------------- socket ----------------
function connectSocket() {
  S.socket = io({ auth: { token: store.get('token') } });
  S.socket.on('connect', () => $('#conn').classList.add('on'));
  S.socket.on('disconnect', () => $('#conn').classList.remove('on'));
  S.socket.on('ride:update', ({ ride, note }) => {
    if (note) toast(note);
    if (ride && ACTIVE.includes(ride.status)) S.selectedRideId = null;
    refresh();
  });
  S.socket.on('offer:new', (offer) => { S.offer = offer; startOfferTimer(); refresh(); });
  S.socket.on('offer:gone', ({ ride_id }) => {
    if (S.offer?.ride.ride_id === ride_id) { S.offer = null; toast('The offer was withdrawn or expired'); }
    refresh();
  });
  S.socket.on('chat:message', (m) => appendMessage(m));
}

// ---------------- shared ride logic ----------------
function currentRide() {
  if (S.selectedRideId) return S.rides.find((r) => r.ride_id === S.selectedRideId);
  const soon = (r) => r.booking_type !== 'scheduled' || new Date(r.slot_start) - Date.now() < 60 * 60e3;
  const active = S.rides.filter((r) => ACTIVE.includes(r.status) && soon(r))
    .sort((a, b) => new Date(a.slot_start) - new Date(b.slot_start));
  if (active[0]) return active[0];
  // A ride that just ended stays up (for rating and chat) until closed or 30 minutes pass.
  return S.rides.find((r) => r.ended_at && Date.now() - new Date(r.ended_at) < 30 * 60e3 && !S.dismissed.has(r.ride_id));
}
const riderBusy = () => { const r = currentRide(); return !!r && ACTIVE.includes(r.status) && r.booking_type !== 'scheduled'; };
const chatOpen = (r) => r && r.driver_id && (['accepted', 'arrived', 'in_progress'].includes(r.status)
  || (r.ended_at && Date.now() - new Date(r.ended_at) < 30 * 60e3));
const ridePoints = (r) => [{ lat: r.pickup_lat, lng: r.pickup_lng }, { lat: r.drop_lat, lng: r.drop_lng }];
const routeText = (r) => `${shortPlace(placeName(r.pickup_lat, r.pickup_lng))} → ${shortPlace(placeName(r.drop_lat, r.drop_lng))}`;
const firstName = (n) => String(n || '').split(' ')[0].slice(0, 8);
const kmBetween = (a, b) => Math.hypot((a.lat - b.lat) * 111, (a.lng - b.lng) * 108.6);
const estimate = (km, vehicle = 'sedan') => { const [base, perKm] = RATES[vehicle] || RATES.sedan; return base + perKm * km; };
const bigMoney = (v) => { const [i, d] = Number(v).toFixed(2).split('.'); return `₹${i}<small>.${d}</small>`; };

function flapText(r) {
  const n = firstName(r.driver_name);
  if (S.me.role === 'driver') {
    return { accepted: r.booking_type === 'scheduled' && new Date(r.slot_start) > Date.now() ? `PICKUP AT [${fmtClock(r.slot_start)}]` : 'HEAD TO [PICKUP]',
      arrived: 'WAITING FOR RIDER', in_progress: `ON TRIP [${Math.round(r.distance_km * 10) / 10}KM]`,
      completed: 'TRIP [COMPLETE]', cancelled: '[CANCELLED]', requested: 'REQUESTED' }[r.status];
  }
  return { requested: 'FINDING [DRIVER]',
    accepted: r.booking_type === 'scheduled' && new Date(r.slot_start) > Date.now() ? `${n} AT [${fmtClock(r.slot_start)}]` : `${n} EN [ROUTE]`,
    arrived: `${n} IS [HERE]`, in_progress: `ON TRIP [${Math.round(r.distance_km * 10) / 10}KM]`,
    completed: 'TRIP [COMPLETE]', cancelled: '[CANCELLED]' }[r.status];
}

// The board: live status on split-flap tiles, the fare as a big figure, and the actions.
function renderBoard(el, r) {
  const rider = S.me.role === 'rider';
  const fare = r.fare != null ? Number(r.fare) : estimate(Number(r.distance_km), r.vehicle_type || 'sedan');
  const myScore = rider ? r.driver_score : r.rider_score;
  const isRegular = S.regulars.some((g) => g.driver_id === r.driver_id && g.zone_id === r.zone_id);
  const acts = [];
  if (rider && ['requested', 'accepted', 'arrived'].includes(r.status)) acts.push('<button class="btn danger sm" data-status="cancelled">Cancel ride</button>');
  if (!rider) {
    if (r.status === 'accepted') acts.push('<button class="btn" data-status="arrived">I’ve arrived</button>', '<button class="btn danger sm" data-status="cancelled">Cancel</button>');
    if (r.status === 'arrived') acts.push('<button class="btn" data-status="in_progress">Start trip</button>', '<button class="btn danger sm" data-status="cancelled">Cancel</button>');
    if (r.status === 'in_progress') acts.push('<button class="btn" data-status="completed">Complete trip</button>');
  }
  if (r.status === 'completed' && myScore == null) {
    acts.push(`<span class="label">Rate ${rider ? 'driver' : 'rider'}</span><span class="stars">${[1, 2, 3, 4, 5].map((n) => `<button data-star="${n}">★</button>`).join('')}</span>`);
  }
  if (r.status === 'completed' && myScore != null) acts.push(`<span class="label">You rated ${myScore}/5</span>`);
  if (rider && r.status === 'completed' && !isRegular) acts.push(`<button class="link" data-regular>Keep ${esc(firstName(r.driver_name))} as your regular in ${esc(r.zone_name)}</button>`);
  if (['completed', 'cancelled'].includes(r.status) || S.selectedRideId) acts.push('<button class="link" data-dismiss>Close</button>');

  const who = rider
    ? (r.driver_name ? `<b>${esc(r.plate_number)}</b> · ${esc(r.vehicle_type)} · ${esc(r.driver_name)}` : 'waiting for a driver to accept')
    : `<b>${esc(r.rider_name)}</b> · ${esc(r.zone_name)}`;
  el.innerHTML = `
    <div class="lbl"><span>${S.selectedRideId ? 'Selected ride' : 'Now'}</span><span>Ride ${esc(r.ride_id.slice(0, 4).toUpperCase())} · ${esc(r.booking_type)} · ${fmtTime(r.slot_start)}</span></div>
    <div class="flap" data-flap></div>
    <div class="figure-row">
      <div class="big">${bigMoney(fare)}</div>
      <div class="meta">${who}<br>${r.distance_km} km · ${r.fare != null ? 'fare charged' : 'estimated fare'} · slot ${fmtClock(r.slot_start)}–${fmtClock(r.slot_end)}</div>
    </div>
    ${acts.length ? `<div class="act">${acts.join('')}</div>` : ''}
    <details data-events><summary>Status history · ride_events</summary><ol class="events"></ol></details>`;
  flap($('[data-flap]', el), flapText(r) || statusLabel(r.status));

  $$('[data-status]', el).forEach((b) => b.addEventListener('click', busy(b, async () => {
    if (b.dataset.status === 'cancelled' && !confirm('Cancel this ride?')) return;
    await api('PATCH', `/rides/${r.ride_id}/status`, { status: b.dataset.status });
    await refresh();
  })));
  $$('[data-star]', el).forEach((b) => {
    b.addEventListener('mouseenter', () => $$('[data-star]', el).forEach((x) => x.classList.toggle('on', +x.dataset.star <= +b.dataset.star)));
    b.addEventListener('click', busy(b, async () => {
      await api('POST', `/rides/${r.ride_id}/rating`, { score: Number(b.dataset.star) });
      toast('Thanks for rating');
      await refresh();
    }));
  });
  const reg = $('[data-regular]', el);
  if (reg) reg.addEventListener('click', busy(reg, async () => {
    await api('POST', '/me/regulars', { driver_id: r.driver_id, zone_id: r.zone_id });
    toast(`${r.driver_name} is now your regular in ${r.zone_name}`);
    await refresh();
  }));
  const dis = $('[data-dismiss]', el);
  if (dis) dis.addEventListener('click', () => { S.dismissed.add(r.ride_id); S.selectedRideId = null; renderAll(); });
  const ev = $('[data-events]', el);
  ev.addEventListener('toggle', async () => {
    if (!ev.open) return;
    const rows = await api('GET', `/rides/${r.ride_id}/events`);
    $('ol', ev).innerHTML = rows.map((e) => `<li><span>${fmtClock(e.event_time)}</span><span>${esc(e.from_status || 'null')} → <b>${esc(e.to_status)}</b></span><span>${esc(e.actor_name || 'system')}</span></li>`).join('');
  });
}

// Lower right panel: the ride chat while it is open, otherwise the week's departures.
function renderLower(r) {
  const el = $('#lower');
  if (chatOpen(r)) {
    if (S.chatRide === r.ride_id && $('.chat', el)) return;
    S.chatRide = r.ride_id;
    const other = S.me.role === 'rider' ? r.driver_name : r.rider_name;
    el.innerHTML = `<div class="lbl"><span>Messages</span><span>with ${esc(other)} · ride ${esc(r.ride_id.slice(0, 4).toUpperCase())}</span></div>
      <div class="chat" data-ride="${r.ride_id}"><div class="msgs"></div>
        <form><input type="text" placeholder="Write a message…" maxlength="2000">
          <label class="file" title="Send an image"><svg class="icon" viewBox="0 0 24 24"><path d="M21 11.5l-8.6 8.6a5 5 0 01-7.1-7.1l8.6-8.6a3.3 3.3 0 014.7 4.7l-8.6 8.6a1.7 1.7 0 01-2.4-2.4l7.9-7.9"/></svg><input type="file" accept="image/*" hidden></label>
          <button class="btn sm">Send</button></form></div>`;
    setupChat($('.chat', el), r);
    return;
  }
  S.chatRide = null;
  const rider = S.me.role === 'rider';
  const upcoming = S.rides.filter((x) => new Date(x.slot_start) > Date.now() - 5 * 60e3 && ['accepted', 'requested', 'cancelled'].includes(x.status)
    && (x.booking_type === 'scheduled' || x.status !== 'cancelled'))
    .sort((a, b) => new Date(a.slot_start) - new Date(b.slot_start)).slice(0, 12);
  const label = (x) => (x.status === 'accepted' ? 'BOOKED' : x.status === 'cancelled' ? 'CLASH · REFUSED' : statusLabel(x.status).toUpperCase());
  el.innerHTML = `<div class="lbl"><span>Departures · next 7 days</span><span>${upcoming.length} booked</span></div>
    <div class="scroll">${upcoming.length ? `<table class="dt">${upcoming.map((x) => `<tr class="click" data-open="${x.ride_id}">
      <td class="t">${fmtDay(x.slot_start)} ${fmtClock(x.slot_start)}</td><td>${esc(routeText(x))}</td>
      <td class="muted">${esc(rider ? x.driver_name || '' : x.rider_name)}</td>
      <td class="s ${x.status === 'cancelled' ? 'cancelled' : ''}">${label(x)}</td></tr>`).join('')}</table>`
      : `<div class="empty">Nothing booked yet.${rider ? ' Plan a slot under Schedule.' : ''}</div>`}</div>`;
  bindOpen(el);
}

async function setupChat(chat, ride) {
  const msgs = await api('GET', `/rides/${ride.ride_id}/messages`).catch(() => []);
  $('.msgs', chat).innerHTML = '';
  msgs.forEach(appendMessage);
  if (!msgs.length) $('.msgs', chat).innerHTML = '<div class="empty" data-none>No messages yet.</div>';
  const form = $('form', chat);
  const file = $('input[type=file]', form);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = $('input[type=text]', form);
    const fd = new FormData();
    if (text.value.trim()) fd.append('content', text.value.trim());
    if (file.files[0]) fd.append('media', file.files[0]);
    if (!fd.has('content') && !fd.has('media')) return;
    try { await api('POST', `/rides/${ride.ride_id}/messages`, fd); text.value = ''; file.value = ''; }
    catch (err) { toast(err.message, true); }
  });
  file.addEventListener('change', () => file.files[0] && form.requestSubmit());
}

function appendMessage(m) {
  const chat = document.querySelector(`.chat[data-ride="${m.ride_id}"]`);
  if (!chat) { if (m.sender_id !== S.me.user_id) toast(`${m.sender_name}: ${m.content || 'sent an image'}`); return; }
  const box = $('.msgs', chat);
  $('[data-none]', box)?.remove();
  if ($(`[data-mid="${m.message_id}"]`, box)) return;
  const div = document.createElement('div');
  div.className = 'msg' + (m.sender_id === S.me.user_id ? ' me' : '');
  div.dataset.mid = m.message_id;
  div.innerHTML = `${m.media_url ? `<img src="${esc(m.media_url)}" alt="image">` : ''}${m.content ? esc(m.content) : ''}<span class="t">${esc(m.sender_id === S.me.user_id ? 'you' : m.sender_name)} · ${fmtClock(m.created_at)}</span>`;
  box.appendChild(div);
  box.scrollTop = box.scrollHeight;
}

function bindOpen(root) {
  $$('[data-open]', root).forEach((tr) => tr.addEventListener('click', () => {
    S.selectedRideId = tr.dataset.open;
    go(S.me.role === 'rider' ? 'ride' : 'drive');
  }));
}

function renderHistory() {
  const rider = S.me.role === 'rider';
  const rows = S.rides;
  $('#historyList').innerHTML = rows.length ? `<table class="dt"><tr><th>When</th><th>Route</th><th>${rider ? 'Driver' : 'Rider'}</th><th>Fare</th><th>★</th><th></th></tr>
    ${rows.map((r) => `<tr class="click" data-open="${r.ride_id}"><td class="t">${fmtTime(r.slot_start)}</td><td>${esc(routeText(r))}</td>
      <td>${esc(rider ? r.driver_name || '—' : r.rider_name)}</td><td>${money(r.fare)}</td>
      <td>${(rider ? r.driver_score : r.rider_score) ?? ''}</td><td class="s ${esc(r.status)}">${esc(statusLabel(r.status))}</td></tr>`).join('')}</table>`
    : '<div class="empty">No rides yet.</div>';
  bindOpen($('#historyList'));
}

// ---------------- rider ----------------
function setupRider() {
  $$('[data-arm]').forEach((b) => b.addEventListener('click', () => arm(S.armed === b.dataset.arm ? null : b.dataset.arm)));
  $('#requestBtn').addEventListener('click', busy($('#requestBtn'), async () => {
    if (!S.pickup || !S.drop) throw new Error('Set a pickup and a drop on the map first');
    const res = await api('POST', '/rides', { pickup: S.pickup, drop: S.drop });
    S.selectedRideId = null;
    toast(res.matched ? 'Request sent to a driver' : 'No driver free right now, still looking');
    await refresh();
  }));
  $('#recDays').innerHTML = DAYS.map((d, i) => `<label><input type="checkbox" value="${i + 1}" ${i < 5 ? 'checked' : ''}>${d[0]}</label>`).join('');
  const t = new Date(Date.now() + 24 * 3600e3); t.setHours(9, 0, 0, 0);
  $('#schedStart').value = new Date(t - t.getTimezoneOffset() * 60e3).toISOString().slice(0, 16);
  $('#schedBtn').addEventListener('click', busy($('#schedBtn'), async () => {
    if (!S.pickup || !S.drop) throw new Error('Set the pickup and drop on the Ride page first');
    const driver = $('#schedDriver').value;
    if (!driver) throw new Error('You need a regular driver first');
    await api('POST', '/rides/scheduled', {
      driver_id: driver.split('|')[0], pickup: S.pickup, drop: S.drop,
      start: new Date($('#schedStart').value).toISOString(), minutes: Number($('#schedMinutes').value),
    });
    toast('Slot booked');
    await refresh();
  }));
  $('#recBtn').addEventListener('click', busy($('#recBtn'), async () => {
    if (!S.pickup || !S.drop) throw new Error('Set the pickup and drop on the Ride page first');
    const driver = $('#recDriver').value;
    if (!driver) throw new Error('You need a regular driver first');
    const [driver_id, zone_id] = driver.split('|');
    const res = await api('POST', '/me/recurring', {
      driver_id, zone_id: Number(zone_id), pickup: S.pickup, drop: S.drop,
      time_of_day: $('#recTime').value, duration_minutes: Number($('#recMinutes').value),
      weekdays: $$('#recDays input:checked').map((i) => Number(i.value)),
    });
    toast(`Weekly booking made: ${res.rides_created} ride(s) in the next 7 days`);
    await refresh();
  }));
}

function pointHtml(p) {
  if (!p) return '<span class="ph">tap the map</span>';
  return `${esc(placeName(p.lat, p.lng))}<small>${coord(p.lat, p.lng)}</small>`;
}

async function renderRider() {
  const r = currentRide();
  const name = esc(firstName(S.me.name));
  const active = r && ACTIVE.includes(r.status) && r.booking_type !== 'scheduled';
  const zone = r ? S.zones.find((z) => z.zone_id === r.zone_id) : S.pickup ? zoneAt(S.zones, S.pickup.lat, S.pickup.lng) : null;
  const today = new Date().toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
  $('#rKicker').textContent = [today, zone ? `${zone.name} zone` : 'Vellore', zone ? `${zone.available} drivers free` : `${S.zones.reduce((a, z) => a + z.available, 0)} drivers free`].join(' · ');

  const titles = {
    requested: 'Finding<br><i>your driver.</i>', accepted: `On the way,<br><i>${esc(firstName(r?.driver_name))}.</i>`,
    arrived: 'Your ride<br><i>is here.</i>', in_progress: 'Sit back,<br><i>you’re moving.</i>',
  };
  $('#rTitle').innerHTML = active ? titles[r.status] : `Where to,<br><i>${name}?</i>`;

  const pts = active ? ridePoints(r) : [S.pickup, S.drop];
  $('#pickupTxt').innerHTML = pointHtml(pts[0]);
  $('#dropTxt').innerHTML = pointHtml(pts[1]);
  $$('[data-mirror]').forEach((el) => { el.innerHTML = pointHtml(el.dataset.mirror === 'pickup' ? S.pickup : S.drop); });
  $$('#appView [data-arm]').forEach((b) => b.classList.toggle('hidden', !!active));
  $('#bookAct').classList.toggle('hidden', !!active);

  const reg = zone && S.regulars.find((g) => g.zone_id === zone.zone_id);
  $('#withTxt').innerHTML = active && r.driver_name ? `${esc(r.driver_name)} · <i>${esc(r.vehicle_type)}</i>`
    : reg ? `${esc(reg.driver_name)}, your regular · <i>${esc(reg.vehicle_type)}</i>` : '<i>the nearest free driver</i>';

  const board = $('#rBoard');
  if (r) renderBoard(board, r);
  else {
    const km = S.pickup && S.drop ? kmBetween(S.pickup, S.drop) : null;
    const veh = reg ? reg.vehicle_type : 'sedan';
    board.innerHTML = `<div class="lbl"><span>Now</span><span>${S.rides.filter((x) => x.status === 'completed').length} rides on record</span></div>
      <div class="flap" data-flap></div>
      <div class="figure-row"><div class="big">${km ? bigMoney(estimate(km, veh)) : '₹—'}</div>
        <div class="meta">${km ? `${km.toFixed(1)} km · estimate for a ${veh}<br>charged on arrival` : 'Set a pickup and a drop<br>to see the fare'}</div></div>`;
    flap($('[data-flap]', board), km ? `READY · [${km.toFixed(1)}KM]` : 'READY WHEN YOU ARE');
  }

  drawMap(r ? ridePoints(r) : [S.pickup, S.drop].filter(Boolean).length ? [S.pickup, S.drop] : [], { fitKey: r?.ride_id });
  $('#figText').textContent = r ? `Route through the ${r.zone_name} zone` : zone ? `Your route through the ${zone.name} zone` : 'Service zones · tap to set your pickup';
  $('#figRight').textContent = r ? `${r.distance_km} KM` : '';
  renderLower(r);

  // schedule pane
  const opts = S.regulars.map((g) => `<option value="${g.driver_id}|${g.zone_id}">${esc(g.driver_name)} · ${esc(g.zone_name)}</option>`).join('');
  for (const id of ['#schedDriver', '#recDriver']) {
    const sel = $(id); const keep = sel.value;
    sel.innerHTML = opts || '<option value="">no regular drivers yet</option>';
    if (keep) sel.value = keep;
  }
  const recs = await api('GET', '/me/recurring');
  $('#recList').innerHTML = recs.length ? `<div class="label" style="margin-bottom:6px">Your weekly bookings</div><table class="dt">
    ${recs.map((b) => `<tr><td class="t">${esc(b.time_of_day)}</td><td>${b.weekdays.map((d) => DAYS[d - 1].toUpperCase()).join(' ')}</td>
      <td class="muted">${esc(b.driver_name)} · ${esc(b.zone_name)} · ${b.upcoming} upcoming</td>
      <td class="s"><button class="link" data-rec="${b.booking_id}" data-active="${b.is_active}">${b.is_active ? 'pause' : 'resume'}</button></td></tr>`).join('')}</table>` : '';
  $$('[data-rec]').forEach((b) => b.addEventListener('click', busy(b, async () => {
    await api('PATCH', `/me/recurring/${b.dataset.rec}`, { is_active: b.dataset.active !== 'true' });
    await refresh();
  })));

  // regulars pane
  $('#regularList').innerHTML = S.regulars.length ? `<table class="dt"><tr><th>Driver</th><th>Zone</th><th>Vehicle</th><th>Rating</th><th>Since</th><th></th></tr>
    ${S.regulars.map((g) => `<tr><td class="serif">${esc(g.driver_name)}</td><td>${esc(g.zone_name)}</td><td>${esc(g.vehicle_type)} · ${esc(g.plate_number)}</td>
      <td>${g.avg_rating ?? '—'}</td><td class="muted">${fmtDay(g.added_at)}</td>
      <td class="s"><button class="link" data-unreg="${g.driver_id}|${g.zone_id}">remove</button></td></tr>`).join('')}</table>`
    : '<div class="empty">None yet. Finish a ride, then keep the driver from the ride board.</div>';
  $$('[data-unreg]').forEach((b) => b.addEventListener('click', busy(b, async () => {
    if (!confirm('Remove this regular driver? Weekly bookings with them in that zone go too.')) return;
    const [d, z] = b.dataset.unreg.split('|');
    await api('DELETE', `/me/regulars/${d}/${z}`);
    await refresh();
  })));
}

// ---------------- driver ----------------
function setupDriver() {
  $$('[data-arm]').forEach((b) => b.addEventListener('click', () => arm(S.armed === b.dataset.arm ? null : b.dataset.arm)));
  $('#toggleOnline').addEventListener('click', busy($('#toggleOnline'), async () => {
    await api('POST', '/driver/status', { online: S.me.status === 'offline' });
    await refresh();
  }));
  $('#saveZones').addEventListener('click', busy($('#saveZones'), async () => {
    await api('PUT', '/driver/zones', { zones: $$('#zoneChecks input:checked').map((i) => Number(i.value)) });
    toast('Zones saved');
    await refresh();
  }));
}

function startOfferTimer() {
  clearInterval(S.offerTimer);
  S.offerTimer = setInterval(() => {
    if (!S.offer) return clearInterval(S.offerTimer);
    const left = Math.max(0, Math.round((new Date(S.offer.expires_at) - Date.now()) / 1000));
    const el = $('#dBoard [data-flap]');
    if (el && S.tab === 'drive') flap(el, `NEW OFFER [${pad(left)}S]`);
    if (left <= 0) { S.offer = null; renderAll(); }
  }, 500);
}

function renderOffer(el, { ride, expires_at, via_regular }) {
  const left = Math.max(0, Math.round((new Date(expires_at) - Date.now()) / 1000));
  el.innerHTML = `<div class="lbl"><span>Incoming</span><span>${via_regular ? 'you are their regular' : 'nearest free driver'}</span></div>
    <div class="flap" data-flap></div>
    <div class="figure-row"><div class="big">${bigMoney(estimate(Number(ride.distance_km), S.me.vehicle_type))}</div>
      <div class="meta"><b>${esc(ride.rider_name)}</b> · ${esc(ride.zone_name)}<br>${esc(routeText(ride))} · ${ride.distance_km} km</div></div>
    <div class="act"><button class="btn" id="acceptBtn">Accept</button><button class="btn ghost" id="declineBtn">Decline</button></div>`;
  flap($('[data-flap]', el), `NEW OFFER [${pad(left)}S]`);
  const done = async () => { S.offer = null; await refresh(); };
  $('#acceptBtn').addEventListener('click', busy($('#acceptBtn'), async () => {
    try { await api('POST', `/driver/offers/${ride.ride_id}/accept`); toast('Ride accepted'); } finally { await done(); }
  }));
  $('#declineBtn').addEventListener('click', busy($('#declineBtn'), async () => {
    try { await api('POST', `/driver/offers/${ride.ride_id}/decline`); } finally { await done(); }
  }));
}

async function renderDriver() {
  const m = S.me;
  $('#dKicker').textContent = `${m.vehicle_type} · ${m.plate_number} · ★ ${m.avg_rating ?? '—'} from ${m.rating_count} ratings`;
  $('#drvName').innerHTML = `${greeting()},<br><i>${esc(firstName(m.name))}.</i>`;
  $('#drvStatus').innerHTML = { offline: 'Off duty', available: 'Available for rides', busy: 'On a job' }[m.status] || esc(m.status);
  $('#toggleOnline').textContent = m.status === 'offline' ? 'Go online' : 'Go offline';
  $('#toggleOnline').disabled = m.status === 'busy';
  $('#drvPos').innerHTML = m.lat != null ? pointHtml({ lat: m.lat, lng: m.lng }) : '<span class="ph">not set, tap Set</span>';
  $('#drvZones').innerHTML = S.zones.filter((z) => m.zones.includes(z.zone_id)).map((z) => esc(z.name)).join(', ') || '<span class="ph">none</span>';
  $('#zoneChecks').innerHTML = S.zones.filter((z) => !z.name.startsWith('proof-')).map((z) => `<label><input type="checkbox" value="${z.zone_id}" ${m.zones.includes(z.zone_id) ? 'checked' : ''}>${esc(z.name)}</label>`).join('');

  if (!S.offer) {
    const offers = await api('GET', '/driver/offers');
    if (offers[0]) { S.offer = offers[0]; startOfferTimer(); }
  }
  const r = currentRide();
  const board = $('#dBoard');
  if (S.offer) renderOffer(board, S.offer);
  else if (r) renderBoard(board, r);
  else {
    const today = S.rides.filter((x) => x.status === 'completed' && new Date(x.ended_at).toDateString() === new Date().toDateString());
    const earned = today.reduce((a, x) => a + Number(x.fare), 0);
    board.innerHTML = `<div class="lbl"><span>Now</span><span>${m.status === 'available' ? 'offers last 30 seconds' : 'go online to get offers'}</span></div>
      <div class="flap" data-flap></div>
      <div class="figure-row"><div class="big">${bigMoney(earned)}</div><div class="meta">earned today<br>${today.length} trip${today.length === 1 ? '' : 's'} completed</div></div>`;
    flap($('[data-flap]', board), m.status === 'offline' ? '[OFF] DUTY' : m.status === 'busy' ? 'ON A [JOB]' : 'WAITING FOR [RIDES]');
  }
  const offerRide = S.offer?.ride;
  drawMap(offerRide ? ridePoints(offerRide) : r ? ridePoints(r) : [], { car: m.lat != null ? { lat: m.lat, lng: m.lng } : null, fitKey: (offerRide || r)?.ride_id });
  $('#figText').textContent = offerRide ? `Offer from ${offerRide.rider_name}, ${offerRide.zone_name}` : r ? `Trip through the ${r.zone_name} zone` : 'Your position and service zones';
  $('#figRight').textContent = m.status.toUpperCase();
  renderLower(S.offer ? null : r);
  if (m.lat == null && S.tab === 'drive' && !S.armed) arm('position');
}

// ---------------- boot ----------------
async function refresh() {
  try {
    const [me, rides] = await Promise.all([api('GET', '/auth/me'), api('GET', '/rides')]);
    S.me = me; S.rides = rides;
    if (me.role === 'rider') S.regulars = await api('GET', '/me/regulars');
    S.zones = (await api('GET', '/zones')).filter((z) => !z.name.startsWith('proof-'));
    await renderAll();
  } catch (e) {
    if (e.status === 401) { store.del('token'); location.reload(); } else toast(e.message, true);
  }
}

async function renderAll() {
  if (!S.me) return;
  if (S.tab === 'history') renderHistory();
  if (S.me.role === 'rider') await renderRider(); else await renderDriver();
}

async function start() {
  try { S.me = await api('GET', '/auth/me'); } catch { store.del('token'); return showAuth(); }
  $('#authView').classList.add('hidden');
  $('#appView').classList.remove('hidden');
  $('#whoName').textContent = `${S.me.name} · ${S.me.role}`;
  setupMap();
  S.zones = await drawZones(S.map, S.zoneLayer);
  buildNav();
  if (S.me.role === 'rider') { setupRider(); arm('pickup'); } else setupDriver();
  connectSocket();
  go(S.me.role === 'rider' ? 'ride' : 'drive');
  await refresh();
  setInterval(refresh, 15000);
}

$$('[data-clock]').forEach(startClock);
setupAuth();
if (store.get('token')) start(); else showAuth();
