// Live delivery only. Ride state is never kept here; it always lives in PostgreSQL.
const { Server } = require('socket.io');
const { verify } = require('./auth');
const { query } = require('./db');

let io;
const sockets = new Map(); // user_id -> Set of socket ids

function init(server) {
  io = new Server(server);
  io.use((socket, next) => {
    try {
      socket.user = verify(socket.handshake.auth.token);
      next();
    } catch {
      next(new Error('unauthorized'));
    }
  });
  io.on('connection', async (socket) => {
    const id = socket.user.id;
    if (!sockets.has(id)) sockets.set(id, new Set());
    sockets.get(id).add(socket.id);
    await query('UPDATE users SET is_online = true, last_seen_at = now() WHERE user_id = $1', [id]).catch(() => {});
    socket.on('disconnect', async () => {
      const set = sockets.get(id);
      set?.delete(socket.id);
      if (set && set.size === 0) {
        sockets.delete(id);
        await query('UPDATE users SET is_online = false, last_seen_at = now() WHERE user_id = $1', [id]).catch(() => {});
      }
    });
  });
}

function emitTo(userId, event, payload) {
  if (!io || !userId) return;
  for (const sid of sockets.get(userId) || []) io.to(sid).emit(event, payload);
}

module.exports = { init, emitTo };
