// Rider and driver app. All state comes from the API; the socket only says "something changed".
const ACTIVE = ['requested', 'accepted', 'arrived', 'in_progress'];
const FLOW = ['requested', 'accepted', 'arrived', 'in_progress', 'completed'];

const S = {
  me: null, rides: [], regulars: [], zones: [], socket: null,
  map: null, zoneLayer: null, pointLayer: null, rideLayer: null, carMarker: null,
  pickup: null, drop: null, armed: 'pickup',
  selectedRideId: null, dismissed: new Set(), renderedKey: null, offerTimer: null,
};

// ---------------- auth ----------------
function showAuth() {
  $('#authView').classList.remove('hidden');
  $('#appView').classList.add('hidden');
  $('#who').classList.add('hidden');
  $('#logout').classList.add('hidden');
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
  $('#loginForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    try { onLoggedIn(await api('POST', '/auth/login', { email: f.get('email'), password: f.get('password') })); }
    catch (err) { toast(err.message, true); }
  });
  $$('[data-demo]').forEach((b) => b.addEventListener('click', async () => {
    try { onLoggedIn(await api('POST', '/auth/login', { email: b.dataset.demo, password: 'password' })); }
    catch (err) { toast(err.message, true); }
  }));
  $('#registerForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const body = Object.fromEntries(new FormData(e.target));
    try { onLoggedIn(await api('POST', '/auth/register', body)); toast('Account created'); }
    catch (err) { toast(err.message, true); }
  });
  $('#logout').addEventListener('click', () => { store.del('token'); location.reload(); });
}

function onLoggedIn({ token }) {
  store.set('token', token);
  start();
}

// ---------------- map ----------------
function setupMap() {
  if (S.map) return;
  S.map = baseMap('map');
  S.zoneLayer = L.layerGroup().addTo(S.map);
  S.pointLayer = L.layerGroup().addTo(S.map);
  S.rideLayer = L.layerGroup().addTo(S.map);
  S.map.on('click', (e) => (S.me.role === 'rider' ? riderMapClick(e.latlng) : driverMapClick(e.latlng)));
  setTimeout(() => S.map.invalidateSize(), 50);
}

function showRideOnMap(ride) {
  S.rideLayer.clearLayers();
  if (!ride) return;
  const p = [ride.pickup_lat, ride.pickup_lng];
  const d = [ride.drop_lat, ride.drop_lng];
  L.polyline([p, d], { color: '#e7e5e4', dashArray: '2 6', weight: 2.5 }).addTo(S.rideLayer);
  L.marker(p, { icon: dotIcon('#4ade80', 'P', '#04210f') }).bindTooltip('Pickup').addTo(S.rideLayer);
  L.marker(d, { icon: dotIcon('#ff6b5e', 'D', '#2a0703') }).bindTooltip('Drop').addTo(S.rideLayer);
}

// ---------------- socket ----------------
function connectSocket() {
  if (S.socket) S.socket.disconnect();
  S.socket = io({ auth: { token: store.get('token') } });
  S.socket.on('connect', () => $('#conn').classList.add('on'));
  S.socket.on('disconnect', () => $('#conn').classList.remove('on'));
  S.socket.on('ride:update', ({ ride, note }) => {
    if (note) toast(note);
    if (ride && ACTIVE.includes(ride.status)) S.selectedRideId = null;
    refresh();
  });
  S.socket.on('offer:new', (offer) => { showOffer(offer); refresh(); });
  S.socket.on('offer:gone', ({ ride_id }) => {
    if ($('#offerBox').dataset.ride === ride_id) { clearOffer(); toast('The offer was withdrawn or expired'); }
    refresh();
  });
  S.socket.on('chat:message', (m) => appendMessage(m));
}

// ---------------- shared ride card ----------------
function currentRide() {
  if (S.selectedRideId) return S.rides.find((r) => r.ride_id === S.selectedRideId);
  const soon = (r) => r.booking_type !== 'scheduled' || new Date(r.slot_start) - Date.now() < 60 * 60e3;
  const active = S.rides.filter((r) => ACTIVE.includes(r.status) && soon(r))
    .sort((a, b) => new Date(a.slot_start) - new Date(b.slot_start));
  if (active[0]) return active[0];
  // A ride that just ended stays on screen (for rating and chat) until closed or 30 minutes pass.
  return S.rides.find((r) => r.ended_at && Date.now() - new Date(r.ended_at) < 30 * 60e3 && !S.dismissed.has(r.ride_id));
}

const chatOpen = (r) => ['accepted', 'arrived', 'in_progress'].includes(r.status)
  || (r.ended_at && Date.now() - new Date(r.ended_at) < 30 * 60e3);

function rideCardHtml(r) {
  const rider = S.me.role === 'rider';
  const idx = FLOW.indexOf(r.status);
  const steps = r.status === 'cancelled' ? '' : `<div class="steps">${FLOW.map((_, i) => `<span class="${i <= idx ? 'done' : ''}"></span>`).join('')}</div>`;
  const title = {
    requested: rider ? 'Finding you a driver…' : 'Ride requested',
    accepted: rider ? 'Driver on the way' : 'Head to the pickup',
    arrived: rider ? 'Your driver has arrived' : 'Waiting for the rider',
    in_progress: 'On the trip', completed: 'Trip completed', cancelled: 'Ride cancelled',
  }[r.status];
  const actions = [];
  if (rider && ['requested', 'accepted', 'arrived'].includes(r.status)) actions.push(['cancelled', 'Cancel ride', 'danger']);
  if (!rider) {
    if (r.status === 'accepted') actions.push(['arrived', "I've arrived", 'primary'], ['cancelled', 'Cancel', 'danger']);
    if (r.status === 'arrived') actions.push(['in_progress', 'Start trip', 'primary'], ['cancelled', 'Cancel', 'danger']);
    if (r.status === 'in_progress') actions.push(['completed', 'Complete trip', 'primary']);
  }
  const myScore = rider ? r.driver_score : r.rider_score;
  const isRegular = S.regulars.some((g) => g.driver_id === r.driver_id && g.zone_id === r.zone_id);
  return `
    <div class="card" data-ride="${r.ride_id}">
      <div class="row"><h2 class="grow" style="margin:0">${title}</h2>${pill(r.status)}</div>
      ${steps}
      <dl class="kv">
        ${rider ? `<dt>Driver</dt><dd>${r.driver_name ? `${esc(r.driver_name)} · ${esc(r.vehicle_type)} · <b>${esc(r.plate_number)}</b>` : '<span class="muted">not assigned yet</span>'}</dd>`
                : `<dt>Rider</dt><dd>${esc(r.rider_name)}</dd>`}
        <dt>Zone</dt><dd>${esc(r.zone_name)} · ${r.distance_km} km</dd>
        <dt>Type</dt><dd>${esc(r.booking_type)}${r.recurring_booking_id ? ' (weekly)' : ''}</dd>
        <dt>Slot</dt><dd>${fmtTime(r.slot_start)} – ${fmtClock(r.slot_end)}</dd>
        ${r.fare != null ? `<dt>Fare</dt><dd><b>${money(r.fare)}</b></dd>` : ''}
      </dl>
      ${actions.length ? `<div class="row" style="margin-top:12px">${actions.map(([s, l, c]) => `<button class="btn ${c} grow" data-status="${s}">${l}</button>`).join('')}</div>` : ''}
      ${r.status === 'completed' && myScore == null ? `
        <div style="margin-top:12px"><label>Rate your ${rider ? 'driver' : 'rider'}</label>
          <div class="stars">${[1, 2, 3, 4, 5].map((n) => `<button data-star="${n}">★</button>`).join('')}</div></div>` : ''}
      ${r.status === 'completed' && myScore != null ? `<p class="small muted">You rated this ride ${myScore}/5.</p>` : ''}
      ${rider && r.status === 'completed' && !isRegular ? `<button class="btn block" style="margin-top:8px" data-regular>Add ${esc(r.driver_name)} as my regular driver in ${esc(r.zone_name)}</button>` : ''}
      ${chatOpen(r) && r.driver_id ? `
        <div style="margin-top:12px"><label>Chat with ${rider ? esc(r.driver_name) : esc(r.rider_name)}</label>
          <div class="chat"><div class="msgs"></div>
            <form><input type="text" placeholder="Message…" maxlength="2000">
              <label class="file" title="Send an image"><svg class="icon" viewBox="0 0 24 24"><path d="M21 11.5l-8.6 8.6a5 5 0 01-7.1-7.1l8.6-8.6a3.3 3.3 0 014.7 4.7l-8.6 8.6a1.7 1.7 0 01-2.4-2.4l7.9-7.9"/></svg><input type="file" accept="image/*" hidden></label>
              <button class="btn primary sm">Send</button></form></div></div>` : ''}
      <details style="margin-top:10px" data-events><summary class="small muted">Status history (ride_events)</summary><ol class="events small"></ol></details>
      ${['completed', 'cancelled'].includes(r.status) || S.selectedRideId ? '<button class="btn sm" style="margin-top:8px" data-dismiss>Close</button>' : ''}
    </div>`;
}

function renderCurrent(container) {
  const r = currentRide();
  const key = r ? [r.ride_id, r.status, r.driver_id, r.driver_score, r.rider_score, S.regulars.length].join('|') : 'none';
  if (key === S.renderedKey) return r;
  S.renderedKey = key;
  container.innerHTML = r ? rideCardHtml(r) : '';
  showRideOnMap(r);
  if (!r) return r;
  const card = container.firstElementChild;
  $$('[data-status]', card).forEach((b) => b.addEventListener('click', busy(b, async () => {
    if (b.dataset.status === 'cancelled' && !confirm('Cancel this ride?')) return;
    await api('PATCH', `/rides/${r.ride_id}/status`, { status: b.dataset.status });
    await refresh();
  })));
  $$('[data-star]', card).forEach((b) => b.addEventListener('click', busy(b, async () => {
    await api('POST', `/rides/${r.ride_id}/rating`, { score: Number(b.dataset.star) });
    toast('Thanks for rating');
    await refresh();
  })));
  const reg = $('[data-regular]', card);
  if (reg) reg.addEventListener('click', busy(reg, async () => {
    await api('POST', '/me/regulars', { driver_id: r.driver_id, zone_id: r.zone_id });
    toast(`${r.driver_name} is now your regular driver in ${r.zone_name}`);
    await refresh();
  }));
  const dis = $('[data-dismiss]', card);
  if (dis) dis.addEventListener('click', () => { S.dismissed.add(r.ride_id); S.selectedRideId = null; S.renderedKey = null; renderAll(); });
  const ev = $('[data-events]', card);
  ev.addEventListener('toggle', async () => {
    if (!ev.open) return;
    const rows = await api('GET', `/rides/${r.ride_id}/events`);
    $('ol', ev).innerHTML = rows.map((e) => `<li>${esc(e.from_status || 'NULL')} → <b>${esc(e.to_status)}</b> · ${fmtTime(e.event_time)} · ${esc(e.actor_name || 'system')}</li>`).join('');
  });
  const chat = $('.chat', card);
  if (chat) setupChat(chat, r);
  return r;
}

async function setupChat(chat, ride) {
  chat.dataset.ride = ride.ride_id;
  const msgs = await api('GET', `/rides/${ride.ride_id}/messages`).catch(() => []);
  $('.msgs', chat).innerHTML = '';
  msgs.forEach(appendMessage);
  const form = $('form', chat);
  const file = $('input[type=file]', form);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = $('input[type=text]', form);
    const fd = new FormData();
    if (text.value.trim()) fd.append('content', text.value.trim());
    if (file.files[0]) fd.append('media', file.files[0]);
    if (!fd.has('content') && !fd.has('media')) return;
    try {
      await api('POST', `/rides/${ride.ride_id}/messages`, fd);
      text.value = ''; file.value = '';
    } catch (err) { toast(err.message, true); }
  });
  file.addEventListener('change', () => file.files[0] && form.requestSubmit());
}

function appendMessage(m) {
  const chat = document.querySelector(`.chat[data-ride="${m.ride_id}"]`);
  if (!chat) { if (m.sender_id !== S.me.user_id) toast(`${m.sender_name}: ${m.content || 'sent an image'}`); return; }
  const box = $('.msgs', chat);
  if ($(`[data-mid="${m.message_id}"]`, box)) return;
  const div = document.createElement('div');
  div.className = 'msg' + (m.sender_id === S.me.user_id ? ' me' : '');
  div.dataset.mid = m.message_id;
  div.innerHTML = `${m.media_url ? `<img src="${esc(m.media_url)}" alt="image">` : ''}${m.content ? esc(m.content) : ''}<div class="t">${fmtClock(m.created_at)}</div>`;
  box.appendChild(div);
  box.scrollTop = box.scrollHeight;
}

function historyTable(rides, role) {
  if (!rides.length) return '<div class="empty">No rides yet.</div>';
  return `<table class="t"><thead><tr><th>When</th><th>${role === 'rider' ? 'Driver' : 'Rider'}</th><th>Zone</th><th>Status</th><th>Fare</th><th>★</th></tr></thead><tbody>
    ${rides.map((r) => `<tr class="click" data-open="${r.ride_id}"><td>${fmtTime(r.slot_start)}</td>
      <td>${esc(role === 'rider' ? r.driver_name || '–' : r.rider_name)}</td><td>${esc(r.zone_name)}</td><td>${pill(r.status)}</td>
      <td>${money(r.fare)}</td><td>${(role === 'rider' ? r.driver_score : r.rider_score) ?? ''}</td></tr>`).join('')}</tbody></table>`;
}

function bindHistory(container, tabsSel, paneTab) {
  $$('[data-open]', container).forEach((tr) => tr.addEventListener('click', () => {
    S.selectedRideId = tr.dataset.open;
    S.renderedKey = null;
    switchTab(tabsSel, paneTab);
    renderAll();
  }));
}

function setupTabs(sel) {
  $$(`${sel} button`).forEach((b) => b.addEventListener('click', () => switchTab(sel, b.dataset.tab)));
}
function switchTab(sel, tab) {
  const tabs = $(sel);
  $$('button', tabs).forEach((x) => x.classList.toggle('active', x.dataset.tab === tab));
  $$('[data-pane]', tabs.parentElement).forEach((p) => p.classList.toggle('hidden', p.dataset.pane !== tab));
}

// ---------------- rider ----------------
function setupRider() {
  setupTabs('#riderTabs');
  $$('[data-point]').forEach((el) => el.addEventListener('click', () => armPoint(el.dataset.point)));
  $('#requestBtn').addEventListener('click', busy($('#requestBtn'), async () => {
    if (!S.pickup || !S.drop) throw new Error('Set both pickup and drop on the map');
    const res = await api('POST', '/rides', { pickup: S.pickup, drop: S.drop });
    S.selectedRideId = null;
    toast(res.matched ? 'Request sent to a driver' : 'No driver free right now, still searching…');
    await refresh();
  }));
  $('#recDays').innerHTML = DAYS.map((d, i) => `<label><input type="checkbox" value="${i + 1}" ${i < 5 ? 'checked' : ''}>${d}</label>`).join('');
  const t = new Date(Date.now() + 24 * 3600e3); t.setHours(9, 0, 0, 0);
  $('#schedStart').value = new Date(t - t.getTimezoneOffset() * 60e3).toISOString().slice(0, 16);
  $('#schedBtn').addEventListener('click', busy($('#schedBtn'), async () => {
    if (!S.pickup || !S.drop) throw new Error('Set pickup and drop on the Ride tab first');
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
    if (!S.pickup || !S.drop) throw new Error('Set pickup and drop on the Ride tab first');
    const driver = $('#recDriver').value;
    if (!driver) throw new Error('You need a regular driver first');
    const [driver_id, zone_id] = driver.split('|');
    const res = await api('POST', '/me/recurring', {
      driver_id, zone_id: Number(zone_id), pickup: S.pickup, drop: S.drop,
      time_of_day: $('#recTime').value, duration_minutes: Number($('#recMinutes').value),
      weekdays: $$('#recDays input:checked').map((i) => Number(i.value)),
    });
    toast(`Weekly booking created, ${res.rides_created} ride(s) booked for the next 7 days`);
    await refresh();
  }));
}

function armPoint(which) {
  S.armed = which;
  $$('[data-point]').forEach((el) => el.classList.toggle('armed', el.dataset.point === which));
}

function riderMapClick({ lat, lng }) {
  const which = S.armed;
  S[which] = { lat: +lat.toFixed(6), lng: +lng.toFixed(6) };
  $(`#${which}Txt`).textContent = `${S[which].lat.toFixed(4)}, ${S[which].lng.toFixed(4)}`;
  drawPoints();
  if (which === 'pickup') armPoint('drop');
}

function drawPoints() {
  S.pointLayer.clearLayers();
  if (S.pickup) L.marker([S.pickup.lat, S.pickup.lng], { icon: dotIcon('#4ade80', 'P', '#04210f') }).addTo(S.pointLayer);
  if (S.drop) L.marker([S.drop.lat, S.drop.lng], { icon: dotIcon('#ff6b5e', 'D', '#2a0703') }).addTo(S.pointLayer);
}

async function renderRider() {
  const r = renderCurrent($('#riderCurrent'));
  const busyRide = r && ACTIVE.includes(r.status) && r.booking_type !== 'scheduled';
  $('#bookCard').classList.toggle('hidden', !!busyRide);
  S.pointLayer.eachLayer((l) => l.setOpacity(r ? 0.35 : 1));

  const opts = S.regulars.map((g) => `<option value="${g.driver_id}|${g.zone_id}">${esc(g.driver_name)} · ${esc(g.zone_name)} (${esc(g.vehicle_type)})</option>`).join('');
  $('#schedDriver').innerHTML = opts || '<option value="">No regular drivers yet</option>';
  $('#recDriver').innerHTML = opts || '<option value="">No regular drivers yet</option>';

  $('#regularList').innerHTML = S.regulars.length ? `<table class="t"><thead><tr><th>Driver</th><th>Zone</th><th>Rating</th><th>Since</th><th></th></tr></thead><tbody>
    ${S.regulars.map((g) => `<tr><td><b>${esc(g.driver_name)}</b><div class="small muted">${esc(g.vehicle_type)} · ${esc(g.plate_number)}</div></td>
      <td>${esc(g.zone_name)}</td><td>${g.avg_rating ?? '–'}</td><td>${fmtTime(g.added_at)}</td>
      <td><button class="btn sm danger" data-unreg="${g.driver_id}|${g.zone_id}">Remove</button></td></tr>`).join('')}</tbody></table>`
    : '<div class="empty">None yet. Finish a ride and tap “Add as my regular driver”.</div>';
  $$('[data-unreg]').forEach((b) => b.addEventListener('click', busy(b, async () => {
    if (!confirm('Remove this regular driver? Weekly bookings with him in that zone are removed too.')) return;
    const [d, z] = b.dataset.unreg.split('|');
    await api('DELETE', `/me/regulars/${d}/${z}`);
    await refresh();
  })));

  const recs = await api('GET', '/me/recurring');
  $('#recList').innerHTML = recs.length ? `<h3 style="margin-top:6px">Your weekly bookings</h3><table class="t"><tbody>
    ${recs.map((b) => `<tr><td><b>${esc(b.time_of_day)}</b> · ${b.weekdays.map((d) => DAYS[d - 1]).join(', ')}<div class="small muted">${esc(b.driver_name)} · ${esc(b.zone_name)} · ${b.duration_minutes} min · ${b.upcoming} upcoming</div></td>
      <td><button class="btn sm" data-rec="${b.booking_id}" data-active="${b.is_active}">${b.is_active ? 'Pause' : 'Resume'}</button></td></tr>`).join('')}</tbody></table>` : '';
  $$('[data-rec]').forEach((b) => b.addEventListener('click', busy(b, async () => {
    await api('PATCH', `/me/recurring/${b.dataset.rec}`, { is_active: b.dataset.active !== 'true' });
    await refresh();
  })));

  const upcoming = S.rides.filter((x) => x.status === 'accepted' && new Date(x.slot_start) > Date.now()).sort((a, b) => new Date(a.slot_start) - new Date(b.slot_start));
  $('#upcomingList').innerHTML = upcoming.length ? `<table class="t"><tbody>${upcoming.map((x) => `<tr class="click" data-open="${x.ride_id}"><td>${fmtTime(x.slot_start)}–${fmtClock(x.slot_end)}</td><td>${esc(x.driver_name)}</td><td>${x.recurring_booking_id ? 'weekly' : 'one-off'}</td></tr>`).join('')}</tbody></table>` : '<div class="empty">Nothing booked.</div>';
  bindHistory($('#upcomingList'), '#riderTabs', 'book');

  $('#riderHistory').innerHTML = historyTable(S.rides, 'rider');
  bindHistory($('#riderHistory'), '#riderTabs', 'book');
}

// ---------------- driver ----------------
function setupDriver() {
  setupTabs('#driverTabs');
  $('#goOnline').addEventListener('click', busy($('#goOnline'), async () => { await api('POST', '/driver/status', { online: true }); await refresh(); }));
  $('#goOffline').addEventListener('click', busy($('#goOffline'), async () => { await api('POST', '/driver/status', { online: false }); await refresh(); }));
  $('#saveZones').addEventListener('click', busy($('#saveZones'), async () => {
    await api('PUT', '/driver/zones', { zones: $$('#zoneChecks input:checked').map((i) => Number(i.value)) });
    toast('Zones saved');
    await refresh();
  }));
}

async function driverMapClick({ lat, lng }) {
  try {
    await api('POST', '/driver/location', { lat, lng });
    S.me.lat = lat; S.me.lng = lng;
    drawCar();
  } catch (e) { toast(e.message, true); }
}

function drawCar() {
  if (S.me.lat == null) return;
  if (!S.carMarker) S.carMarker = L.marker([S.me.lat, S.me.lng], { icon: dotIcon('#f5f5f4', '', '#111') }).bindTooltip('You').addTo(S.map);
  else S.carMarker.setLatLng([S.me.lat, S.me.lng]);
}

function showOffer({ ride, expires_at, via_regular }) {
  const box = $('#offerBox');
  box.dataset.ride = ride.ride_id;
  box.innerHTML = `<div class="card offer">
    <div class="row"><h2 class="grow" style="margin:0">New ride offer</h2><span class="countdown" id="cd">30</span></div>
    ${via_regular ? '<p class="small" style="margin:4px 0"><span class="pill available">You are this rider\'s regular driver</span></p>' : ''}
    <dl class="kv"><dt>Rider</dt><dd>${esc(ride.rider_name)}</dd><dt>Zone</dt><dd>${esc(ride.zone_name)}</dd>
      <dt>Trip</dt><dd>${ride.distance_km} km</dd><dt>Slot</dt><dd>${fmtClock(ride.slot_start)} – ${fmtClock(ride.slot_end)}</dd></dl>
    <div class="row" style="margin-top:12px"><button class="btn primary grow" id="acceptBtn">Accept</button><button class="btn grow" id="declineBtn">Decline</button></div></div>`;
  showRideOnMap(ride);
  clearInterval(S.offerTimer);
  const tick = () => {
    const left = Math.max(0, Math.round((new Date(expires_at) - Date.now()) / 1000));
    const cd = $('#cd'); if (cd) cd.textContent = left;
    if (left <= 0) clearOffer();
  };
  tick();
  S.offerTimer = setInterval(tick, 500);
  $('#acceptBtn').addEventListener('click', busy($('#acceptBtn'), async () => {
    try { await api('POST', `/driver/offers/${ride.ride_id}/accept`); toast('Ride accepted'); }
    finally { clearOffer(); await refresh(); }
  }));
  $('#declineBtn').addEventListener('click', busy($('#declineBtn'), async () => {
    try { await api('POST', `/driver/offers/${ride.ride_id}/decline`); }
    finally { clearOffer(); await refresh(); }
  }));
}

function clearOffer() {
  clearInterval(S.offerTimer);
  const box = $('#offerBox');
  box.innerHTML = ''; delete box.dataset.ride;
  S.renderedKey = null;
}

async function renderDriver() {
  const m = S.me;
  $('#drvName').textContent = m.name;
  $('#drvVehicle').textContent = `${m.vehicle_type} · ${m.plate_number} · ★ ${m.avg_rating ?? '–'} (${m.rating_count})`;
  $('#drvStatus').innerHTML = pill(m.status);
  $('#goOnline').disabled = m.status !== 'offline';
  $('#goOffline').disabled = m.status === 'offline';
  drawCar();
  $('#zoneChecks').innerHTML = S.zones.map((z) => `<label class="row" style="color:var(--ink);font-weight:500;margin:6px 0"><input type="checkbox" style="width:auto" value="${z.zone_id}" ${m.zones.includes(z.zone_id) ? 'checked' : ''}> ${esc(z.name)}</label>`).join('');
  if (!$('#offerBox').dataset.ride) {
    const offers = await api('GET', '/driver/offers');
    if (offers[0]) showOffer(offers[0]);
  }
  if (!$('#offerBox').dataset.ride) renderCurrent($('#driverCurrent'));
  else { $('#driverCurrent').innerHTML = ''; S.renderedKey = null; }
  const cur = currentRide();
  const upcoming = S.rides.filter((x) => x.status === 'accepted' && new Date(x.slot_start) > Date.now() && x.ride_id !== cur?.ride_id)
    .sort((a, b) => new Date(a.slot_start) - new Date(b.slot_start));
  $('#drvUpcoming').innerHTML = upcoming.length ? `<table class="t"><tbody>${upcoming.map((x) => `<tr class="click" data-open="${x.ride_id}"><td>${fmtTime(x.slot_start)}–${fmtClock(x.slot_end)}</td><td>${esc(x.rider_name)}</td><td>${x.recurring_booking_id ? 'weekly' : 'one-off'}</td></tr>`).join('')}</tbody></table>` : '<div class="empty">No booked slots.</div>';
  bindHistory($('#drvUpcoming'), '#driverTabs', 'drive');
  $('#driverHistory').innerHTML = historyTable(S.rides, 'driver');
  bindHistory($('#driverHistory'), '#driverTabs', 'drive');
}

// ---------------- boot ----------------
async function refresh() {
  try {
    const [me, rides] = await Promise.all([api('GET', '/auth/me'), api('GET', '/rides')]);
    S.me = me; S.rides = rides;
    if (me.role === 'rider') S.regulars = await api('GET', '/me/regulars');
    await renderAll();
  } catch (e) {
    if (e.status === 401) { store.del('token'); showAuth(); } else toast(e.message, true);
  }
}

async function renderAll() {
  if (S.me.role === 'rider') await renderRider(); else await renderDriver();
}

async function start() {
  try { S.me = await api('GET', '/auth/me'); } catch { store.del('token'); return showAuth(); }
  $('#authView').classList.add('hidden');
  $('#appView').classList.remove('hidden');
  $('#who').classList.remove('hidden');
  $('#logout').classList.remove('hidden');
  $('#whoName').textContent = `${S.me.name} · ${S.me.role}`;
  $(`#${S.me.role}Panel`).classList.remove('hidden');
  setupMap();
  S.zones = await drawZones(S.map, S.zoneLayer);
  if (S.me.role === 'rider') setupRider(); else setupDriver();
  connectSocket();
  await refresh();
  setInterval(refresh, 15000);
}

setupAuth();
if (store.get('token')) start(); else showAuth();
