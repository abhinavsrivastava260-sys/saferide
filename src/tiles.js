// Map tiles are fetched by the server and cached on disk. Browsers on forwarded hosts
// (such as Codespaces) get blocked by public tile servers, but a server request with a
// proper User-Agent is allowed. OpenStreetMap is tried first, then Esri as a fallback.
const fs = require('fs');
const path = require('path');
const router = require('express').Router();

const CACHE = path.join(__dirname, '..', '.tile-cache');
const UA = 'SafeRide-DBMS-student-project/1.0 (+https://github.com/abhinavsrivastava260-sys/saferide)';
const SOURCES = [
  (z, x, y) => `https://tile.openstreetmap.org/${z}/${x}/${y}.png`,
  (z, x, y) => `https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/${z}/${y}/${x}`,
];

router.get('/:z/:x/:y.png', async (req, res) => {
  const [z, x, y] = [req.params.z, req.params.x, req.params.y].map(Number);
  if (![z, x, y].every(Number.isInteger) || z < 0 || z > 19 || x < 0 || y < 0 || x >= 2 ** z || y >= 2 ** z) {
    return res.status(400).end();
  }
  const file = path.join(CACHE, `${z}`, `${x}`, `${y}.img`);
  res.set('Cache-Control', 'public, max-age=604800');
  if (fs.existsSync(file)) return res.type('png').sendFile(file);
  for (const source of SOURCES) {
    try {
      const r = await fetch(source(z, x, y), { headers: { 'User-Agent': UA, Referer: 'https://github.com/abhinavsrivastava260-sys/saferide' } });
      if (!r.ok || !/^image\//.test(r.headers.get('content-type') || '')) continue;
      const buf = Buffer.from(await r.arrayBuffer());
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFile(file, buf, () => {});
      return res.type(r.headers.get('content-type')).send(buf);
    } catch {
      // try the next source
    }
  }
  res.status(502).end();
});

module.exports = router;
