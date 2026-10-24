const router = require('express').Router();
const { query } = require('../db');
const { wrap } = require('../http');

router.get('/', wrap(async (req, res) => {
  const { rows } = await query(
    `SELECT z.zone_id, z.name, ST_AsGeoJSON(z.boundary)::json AS boundary,
            count(dz.driver_id)::int AS drivers,
            count(*) FILTER (WHERE d.status = 'available')::int AS available
     FROM zones z
     LEFT JOIN driver_zones dz ON dz.zone_id = z.zone_id
     LEFT JOIN drivers d ON d.user_id = dz.driver_id
     GROUP BY z.zone_id ORDER BY z.zone_id`);
  res.json(rows);
}));

module.exports = router;
