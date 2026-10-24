// Administrator page: overview, proofs, reports, zones and a table browser.
const TABLES = ['users', 'riders', 'drivers', 'zones', 'driver_zones', 'regular_drivers', 'recurring_bookings',
  'recurring_booking_days', 'rides', 'ride_offers', 'ride_events', 'messages', 'ratings'];
let zoneMap, zoneLayer, draftLayer, corners = [];

const adminApi = (method, path, body) => api(method, '/admin' + path, body, { 'x-admin-key': store.get('adminKey') || '' });

function table(rows, cols, fmt = {}) {
  if (!rows.length) return '<div class="empty">No rows.</div>';
  cols = cols || Object.keys(rows[0]);
  return `<table class="dt"><thead><tr>${cols.map((c) => `<th>${esc(c)}</th>`).join('')}</tr></thead><tbody>
    ${rows.map((r) => `<tr>${cols.map((c) => `<td>${fmt[c] ? fmt[c](r[c], r) : esc(r[c] === null ? 'NULL' : typeof r[c] === 'object' ? JSON.stringify(r[c]) : r[c])}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
}

async function open() {
  await adminApi('GET', '/overview');
  $('#keyView').classList.add('hidden');
  $('#adminView').classList.remove('hidden');
  $('#logout').classList.remove('hidden');
  $('#adminTabs').classList.remove('hidden');
  $$('#adminTabs button').forEach((b) => b.addEventListener('click', () => {
    $$('#adminTabs button').forEach((x) => x.classList.toggle('active', x === b));
    $$('[data-pane]').forEach((p) => p.classList.toggle('hidden', p.dataset.pane !== b.dataset.tab));
    ({ overview: loadOverview, reports: loadReports, zones: loadZones, tables: loadTable })[b.dataset.tab]?.();
  }));
  loadOverview();
}

async function loadOverview() {
  const o = await adminApi('GET', '/overview');
  $('#tableStats').innerHTML = o.tables.map((t) => `<div><span class="label">${esc(t.name)}</span><b>${t.rows}</b></div>`).join('');
  $('#driverStats').innerHTML = o.drivers.map((d) => `${st(d.status)} <b>${d.n}</b>`).join(' &nbsp; ') || '<span class="muted">No drivers</span>';
  $('#liveRides').innerHTML = table(o.active, ['rider_name', 'driver_name', 'zone_name', 'booking_type', 'status', 'slot_start', 'slot_end'],
    { status: (v) => st(v), slot_start: fmtTime, slot_end: fmtClock });
}

// ---------- proofs ----------
function verifyHtml(results) {
  const passed = results.filter((r) => r.pass).length;
  return `<p><span class="st ${passed === results.length ? 'pass' : 'fail'}">${passed} / ${results.length} behaved as designed</span></p>
    ${results.map((r) => `<div class="proof">
      <div class="head"><span class="mono small red">${esc(r.id)}</span><b>${esc(r.title)}</b>${r.rule ? `<span class="st">${esc(r.rule)}</span>` : ''}<span class="st ${r.pass ? 'pass' : 'fail'}">${r.pass ? 'PASS' : 'FAIL'}</span></div>
      <pre class="code">${esc(r.sql.trim())}</pre>
      ${r.expected ? `<div class="small"><span class="muted">Expected:</span> ${esc(r.expected)}</div>` : ''}
      <div class="small"><span class="muted">Got:</span> <b>${esc(r.outcome)}</b></div>
      ${r.rows ? `<div style="margin-top:6px">${table(r.rows)}</div>` : ''}
    </div>`).join('')}`;
}

const countsHtml = (c) => Object.entries(c).map(([k, v]) => `<span class="st">${esc(k.replace(/_/g, ' '))}: ${v}</span>`).join(' ');

function run(btnSel, outSel, fn) {
  const btn = $(btnSel);
  btn.addEventListener('click', busy(btn, async () => {
    $(outSel).innerHTML = '<span class="muted">Running…</span>';
    try { $(outSel).innerHTML = await fn(); } catch (e) { $(outSel).innerHTML = ''; throw e; }
  }));
}

function setupProofs() {
  run('#runVerify', '#verifyOut', async () => verifyHtml(await adminApi('POST', '/proofs/verify')));
  run('#runDouble', '#doubleOut', async () => {
    const r = await adminApi('POST', '/proofs/double-booking', { n: Number($('#dbN').value) });
    return `<p><span class="st ${r.pass ? 'pass' : 'fail'}">${r.pass ? 'PASS' : 'FAIL'}</span> ${r.attempts} attempts in ${r.ms} ms</p>
      <p>${countsHtml(r.counts)}</p><p class="small">The driver ends up holding <b>${r.accepted_rides_for_driver}</b> accepted ride(s).</p>
      ${r.sample_error ? `<pre class="code">${esc(r.sample_error)}</pre>` : ''}`;
  });
  run('#runMatch', '#matchOut', async () => {
    const r = await adminApi('POST', '/proofs/matching', { riders: Number($('#mR').value), drivers: Number($('#mD').value) });
    return `<p><span class="st ${r.pass ? 'pass' : 'fail'}">${r.pass ? 'PASS' : 'FAIL'}</span> ${r.ms} ms</p>
      <p class="small">${r.matched} riders matched to <b>${r.distinct_drivers}</b> distinct drivers. ${r.told_to_retry} riders told to retry. ${r.errors} errors. No driver was assigned twice: ${r.matched === r.distinct_drivers ? 'yes' : 'NO'}.</p>`;
  });
  run('#runExplain', '#explainOut', async () => {
    const r = await adminApi('POST', '/proofs/explain', {});
    const max = Math.max(r.before.execution_ms, r.after.execution_ms);
    return `<p><span class="st ${r.pass ? 'pass' : 'fail'}">${r.pass ? 'PASS' : 'FAIL'}</span> ${r.drivers.toLocaleString()} drivers</p>
      <table class="dt"><tr><td>Without index</td><td style="width:50%"><div class="bar" style="width:${(r.before.execution_ms / max) * 100}%"></div></td><td><b>${r.before.execution_ms} ms</b></td></tr>
      <tr><td>With GiST index</td><td><div class="bar" style="width:${(r.after.execution_ms / max) * 100}%"></div></td><td><b>${r.after.execution_ms} ms</b></td></tr></table>
      <details><summary class="small muted">Plan without index</summary><pre class="code">${esc(r.before.plan)}</pre></details>
      <details><summary class="small muted">Plan with index</summary><pre class="code">${esc(r.after.plan)}</pre></details>`;
  });
  run('#runIso', '#isoOut', async () => {
    const rs = await adminApi('POST', '/proofs/isolation', { n: 50 });
    return table(rs.map((r) => ({ level: r.isolation, result: r.pass ? 'PASS' : 'FAIL', ...r.counts, ms: r.ms, rides_held: r.accepted_rides_for_driver })),
      null, { result: (v) => `<span class="st ${v === 'PASS' ? 'pass' : 'fail'}">${v}</span>` });
  });
}

// ---------- reports ----------
async function loadReports() {
  const r = await adminApi('GET', '/reports');
  $('#repCancel').innerHTML = table(r.cancellation, null, { cancellation_pct: (v) => `${v ?? 0}%` });
  $('#repUtil').innerHTML = table(r.utilisation, null, { status: (v) => st(v), earnings: money, utilisation_pct: (v) => `${v}%` });
  const max = Math.max(1, ...r.perZoneDay.map((x) => x.rides));
  $('#repZoneDay').innerHTML = table(r.perZoneDay, ['day', 'zone', 'rides', 'completed', 'cancelled'], {
    day: (v) => esc(String(v).slice(0, 10)),
    rides: (v) => `<div class="row" style="flex-wrap:nowrap"><div class="bar" style="width:${(v / max) * 120}px"></div>${v}</div>`,
  });
}

// ---------- zones ----------
async function loadZones() {
  if (!zoneMap) {
    zoneMap = baseMap('zoneMap');
    zoneLayer = L.layerGroup().addTo(zoneMap);
    draftLayer = L.layerGroup().addTo(zoneMap);
    zoneMap.on('click', (e) => { corners.push([e.latlng.lng, e.latlng.lat]); drawDraft(); });
    $('#clearZone').addEventListener('click', () => { corners = []; drawDraft(); });
    $('#saveZone').addEventListener('click', busy($('#saveZone'), async () => {
      if (corners.length < 3) throw new Error('Click at least 3 corners');
      await adminApi('POST', '/zones', { name: $('#zoneName').value, points: corners });
      corners = []; drawDraft(); $('#zoneName').value = '';
      toast('Zone saved');
      loadZones();
    }));
  }
  setTimeout(() => zoneMap.invalidateSize(), 50);
  const zones = await drawZones(zoneMap, zoneLayer);
  $('#zoneList').innerHTML = table(zones.filter((z) => !z.name.startsWith('proof-')), ['zone_id', 'name', 'drivers', 'available', ''], {
    '': (v, z) => `<button class="btn sm danger" data-delzone="${z.zone_id}">Delete</button>`,
  });
  $$('[data-delzone]').forEach((b) => b.addEventListener('click', busy(b, async () => {
    if (!confirm('Delete this zone?')) return;
    await adminApi('DELETE', `/zones/${b.dataset.delzone}`);
    loadZones();
  })));
}

function drawDraft() {
  draftLayer.clearLayers();
  const latlngs = corners.map(([lng, lat]) => [lat, lng]);
  if (latlngs.length) L.polygon(latlngs, { color: '#ff5a36', dashArray: '4 4' }).addTo(draftLayer);
  latlngs.forEach((p) => L.circleMarker(p, { radius: 4, color: '#ff5a36' }).addTo(draftLayer));
  $('#zoneCount').textContent = `${corners.length} corners`;
}

// ---------- tables ----------
async function loadTable() {
  const sel = $('#tableSel');
  if (!sel.options.length) {
    sel.innerHTML = TABLES.map((t) => `<option>${t}</option>`).join('');
    sel.value = 'rides';
    sel.addEventListener('change', loadTable);
  }
  const { columns, rows } = await adminApi('GET', `/tables/${sel.value}`);
  $('#tableOut').innerHTML = table(rows, columns);
}

$('#keyForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  store.set('adminKey', $('#adminKey').value);
  try { await open(); } catch (err) { toast(err.message, true); }
});
$('#logout').addEventListener('click', () => { store.del('adminKey'); location.reload(); });
$$('[data-clock]').forEach(startClock);
setupProofs();
if (store.get('adminKey')) open().catch(() => store.del('adminKey'));
