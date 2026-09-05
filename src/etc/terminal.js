import { getDevice } from '../db/index.js';
import { openSshShell } from './ssh.js';
import { socketAuthorized } from './auth.js';

export function setupTerminal(io) {
  const nsp = io.of('/terminal');
  nsp.use((socket, next) => socketAuthorized(socket) ? next() : next(new Error('Unauthorized')));

  nsp.on('connection', socket => {
    let active = null;

    socket.on('open', async ({ deviceId, cols = 120, rows = 32 }) => {
      try {
        if (active) {
          active.conn.end();
          active = null;
        }
        const device = getDevice(Number(deviceId), true);
        if (!device) return socket.emit('terminal-error', 'Device not found');
        active = await openSshShell(device, cols, rows);
        active.stream.on('data', chunk => socket.emit('data', chunk.toString('utf8')));
        active.stream.stderr?.on('data', chunk => socket.emit('data', chunk.toString('utf8')));
        active.stream.on('close', () => {
          socket.emit('closed');
          active?.conn.end();
          active = null;
        });
        socket.emit('opened');
      } catch (e) {
        socket.emit('terminal-error', e.message);
      }
    });

    socket.on('data', data => active?.stream.write(String(data)));
    socket.on('resize', ({ cols, rows }) => active?.stream.setWindow(rows || 32, cols || 120, 0, 0));
    socket.on('disconnect', () => active?.conn.end());
  });
}
