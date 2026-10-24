const { validationResult } = require('express-validator');
const { describePgError } = require('./db');

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

// Wraps async route handlers so thrown errors reach the error middleware.
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function validate(req, res, next) {
  const errors = validationResult(req);
  if (errors.isEmpty()) return next();
  const e = errors.array()[0];
  res.status(400).json({ error: `${e.path}: ${e.msg}` });
}

function errorHandler(err, req, res, next) {
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
  const pg = describePgError(err);
  if (pg) return res.status(pg.status).json({ error: pg.message, code: err.code });
  console.error(err);
  res.status(500).json({ error: 'Something went wrong' });
}

module.exports = { HttpError, wrap, validate, errorHandler };
