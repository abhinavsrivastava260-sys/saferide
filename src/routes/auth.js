const router = require('express').Router();
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');
const { body } = require('express-validator');
const { tx, query } = require('../db');
const { sign, requireAuth } = require('../auth');
const { wrap, validate, HttpError } = require('../http');

const loginLimiter = rateLimit({ windowMs: 15 * 60e3, limit: 30, message: { error: 'Too many attempts, try again later' } });

router.post('/register', loginLimiter,
  body('name').trim().isLength({ min: 2, max: 80 }),
  body('email').isEmail().normalizeEmail(),
  body('password').isLength({ min: 6 }),
  body('role').isIn(['rider', 'driver']),
  body('phone').optional({ values: 'falsy' }).isLength({ min: 7, max: 15 }),
  body('license_number').if(body('role').equals('driver')).trim().notEmpty(),
  body('vehicle_type').if(body('role').equals('driver')).isIn(['bike', 'auto', 'hatchback', 'sedan', 'suv']),
  body('plate_number').if(body('role').equals('driver')).trim().notEmpty(),
  validate,
  wrap(async (req, res) => {
    const b = req.body;
    const hash = await bcrypt.hash(b.password, 10);
    const user = await tx(null, async (c) => {
      const { rows } = await c.query(
        `INSERT INTO users (name, email, phone, password_hash, role) VALUES ($1,$2,$3,$4,$5)
         RETURNING user_id, name, email, role`,
        [b.name, b.email, b.phone || null, hash, b.role]);
      const u = rows[0];
      if (b.role === 'rider') {
        await c.query('INSERT INTO riders (user_id, preferred_payment) VALUES ($1, $2)', [u.user_id, b.preferred_payment || 'cash']);
      } else {
        await c.query(
          'INSERT INTO drivers (user_id, license_number, vehicle_type, plate_number) VALUES ($1,$2,$3,$4)',
          [u.user_id, b.license_number.toUpperCase(), b.vehicle_type, b.plate_number.toUpperCase()]);
      }
      return u;
    });
    res.status(201).json({ token: sign(user), user });
  }));

router.post('/login', loginLimiter, body('email').isEmail().normalizeEmail(), body('password').notEmpty(), validate,
  wrap(async (req, res) => {
    const { rows } = await query('SELECT * FROM users WHERE email = $1', [req.body.email]);
    const u = rows[0];
    if (!u || !(await bcrypt.compare(req.body.password, u.password_hash))) throw new HttpError(401, 'Wrong email or password');
    res.json({ token: sign(u), user: { user_id: u.user_id, name: u.name, email: u.email, role: u.role } });
  }));

router.get('/me', requireAuth, wrap(async (req, res) => {
  const { rows } = await query(
    `SELECT u.user_id, u.name, u.email, u.phone, u.role, r.preferred_payment,
            d.license_number, d.vehicle_type, d.plate_number, d.status,
            ST_Y(d.location::geometry) AS lat, ST_X(d.location::geometry) AS lng,
            dr.avg_rating, dr.rating_count
     FROM users u
     LEFT JOIN riders r  ON r.user_id = u.user_id
     LEFT JOIN drivers d ON d.user_id = u.user_id
     LEFT JOIN driver_ratings dr ON dr.driver_id = u.user_id
     WHERE u.user_id = $1`, [req.user.id]);
  if (!rows[0]) throw new HttpError(401, 'Please log in again');
  const zones = await query('SELECT zone_id FROM driver_zones WHERE driver_id = $1', [req.user.id]);
  res.json({ ...rows[0], zones: zones.rows.map((z) => z.zone_id) });
}));

module.exports = router;
