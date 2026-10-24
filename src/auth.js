const jwt = require('jsonwebtoken');
const config = require('./config');

const sign = (user) => jwt.sign({ id: user.user_id, role: user.role, name: user.name }, config.jwtSecret, { expiresIn: '7d' });

function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  try {
    req.user = jwt.verify(token, config.jwtSecret);
    next();
  } catch {
    res.status(401).json({ error: 'Please log in again' });
  }
}

const requireRole = (role) => (req, res, next) =>
  req.user.role === role ? next() : res.status(403).json({ error: `Only a ${role} can do this` });

function requireAdmin(req, res, next) {
  if (req.headers['x-admin-key'] === config.adminKey) return next();
  res.status(401).json({ error: 'Wrong admin key' });
}

module.exports = { sign, requireAuth, requireRole, requireAdmin, verify: (t) => jwt.verify(t, config.jwtSecret) };
