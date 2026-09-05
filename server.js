import express from 'express';
import cookieParser from 'cookie-parser';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Server as SocketIOServer } from 'socket.io';
import { loadEnvironment } from './src/configs/environment.js';
import { closeDatabase } from './src/db/index.js';
import { login, logout, requireAuth, socketAuthorized } from './src/etc/auth.js';
import { startMonitoring } from './src/etc/monitor.js';
import { setupTerminal } from './src/etc/terminal.js';
import { createPublicRouter } from './src/routes/public.js';
import { createNetworkRouter } from './src/routes/network.js';
import { createDevicesRouter } from './src/routes/devices.js';
import { createServicesRouter } from './src/routes/services.js';
import { createSettingsRouter } from './src/routes/settings.js';
import { createRefreshRouter } from './src/routes/refresh.js';
import { createTopologyRouter } from './src/routes/topology.js';

const config = loadEnvironment();
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, 'public');
const indexFile = path.join(publicDir, 'index.html');

const app = express();
const server = http.createServer(app);
const io = new SocketIOServer(server, { cors: false });

app.disable('x-powered-by');
app.use(express.json({ limit: '2mb' }));
app.use(cookieParser());
app.use('/vendor/xterm', express.static(path.join(__dirname, 'node_modules/@xterm/xterm')));
app.use('/vendor/xterm-fit', express.static(path.join(__dirname, 'node_modules/@xterm/addon-fit')));
app.use(express.static(publicDir));

// Public pages and endpoints must be registered before the authenticated API gate.
app.use(createPublicRouter({ indexFile }));
app.post('/api/login', login);
app.post('/api/logout', logout);
app.get('/api/me', requireAuth, (_req, res) => res.json({ authenticated: true }));

// Everything below /api from this point on requires an authenticated session.
app.use('/api', requireAuth);
app.use('/api', createNetworkRouter());
app.use('/api', createDevicesRouter());
app.use('/api', createServicesRouter());
app.use('/api', createSettingsRouter());
app.use('/api', createTopologyRouter());

io.use((socket, next) => socketAuthorized(socket) ? next() : next(new Error('Unauthorized')));
setupTerminal(io);
const monitoring = startMonitoring(io);
app.use('/api', createRefreshRouter(monitoring));

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[shutdown] ${signal} received; stopping RouterDeck cleanly`);

  monitoring.stop();
  io.close();

  await new Promise(resolve => server.close(() => resolve()));
  const drained = await monitoring.waitForIdle(5000);
  if (!drained) console.warn('[shutdown] Some monitoring jobs were still active; closing database anyway');
  closeDatabase();
}

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.once(signal, () => {
    shutdown(signal)
      .then(() => process.exit(0))
      .catch(error => {
        console.error('[shutdown] Failed:', error);
        closeDatabase();
        process.exit(1);
      });
  });
}

server.listen(config.port, '0.0.0.0', () => {
  console.log(`RouterDeck listening on http://0.0.0.0:${config.port}`);
  console.log(`Public status page: http://0.0.0.0:${config.port}/status`);
});
