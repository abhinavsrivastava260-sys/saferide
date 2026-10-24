const path = require('path');
const http = require('http');
const express = require('express');
const config = require('./config');
const { requireAuth } = require('./auth');
const { errorHandler } = require('./http');
const socket = require('./socket');
const jobs = require('./jobs');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));
app.use('/vendor/leaflet', express.static(path.join(__dirname, '..', 'node_modules', 'leaflet', 'dist')));
app.use('/tiles', require('./tiles'));
app.use('/uploads', express.static(path.join(__dirname, '..', 'uploads')));

app.use('/api/auth', require('./routes/auth'));
app.use('/api/zones', require('./routes/zones'));
app.use('/api/admin', require('./routes/admin'));
app.use('/api/driver', requireAuth, require('./routes/driver'));
app.use('/api/rides', requireAuth, require('./routes/rides'));
app.use('/api/me', requireAuth, require('./routes/regulars'));
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));
app.use(errorHandler);

const server = http.createServer(app);
socket.init(server);
server.listen(config.port, () => {
  console.log(`Ride booking app on http://localhost:${config.port}`);
  jobs.start();
});
