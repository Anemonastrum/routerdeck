import { Client } from 'ssh2';

function connectionOptions(device, timeoutMs) {
  const c = device.credentials || {};
  return {
    host: device.host,
    port: Number(c.sshPort || 22),
    username: c.sshUsername || c.username || 'root',
    password: c.sshPassword || c.password,
    privateKey: c.privateKey || undefined,
    readyTimeout: timeoutMs,
    keepaliveInterval: 5000,
    keepaliveCountMax: 2,
  };
}

function execOnConnection(conn, command, timeoutMs) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error('SSH command timeout'));
    }, timeoutMs);

    conn.exec(command, (err, stream) => {
      if (err) {
        clearTimeout(timer);
        settled = true;
        return reject(err);
      }

      let out = '';
      let stderr = '';
      stream.on('data', d => { out += d.toString(); });
      stream.stderr.on('data', d => { stderr += d.toString(); });
      stream.on('close', code => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (code && !out) return reject(new Error(stderr.trim() || `SSH exited ${code}`));
        resolve(out);
      });
    });
  });
}

export function sshExec(device, command, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const conn = new Client();
    conn.on('ready', async () => {
      try { resolve(await execOnConnection(conn, command, timeoutMs)); }
      catch (err) { reject(err); }
      finally { conn.end(); }
    }).on('error', reject).connect(connectionOptions(device, timeoutMs));
  });
}

// Run several read-only commands through a single SSH connection. This avoids
// repeatedly reconnecting to small OpenWrt devices during every metrics poll.
export function sshExecMany(device, commands, timeoutMs = 12000) {
  return new Promise((resolve, reject) => {
    const conn = new Client();
    conn.on('ready', async () => {
      try {
        const results = [];
        for (const command of commands) results.push(await execOnConnection(conn, command, timeoutMs));
        resolve(results);
      } catch (err) {
        reject(err);
      } finally {
        conn.end();
      }
    }).on('error', reject).connect(connectionOptions(device, timeoutMs));
  });
}

export function openSshShell(device, cols = 120, rows = 32) {
  const c = device.credentials || {};
  return new Promise((resolve, reject) => {
    const conn = new Client();
    conn.on('ready', () => {
      conn.shell({ term: 'xterm-256color', cols, rows }, (err, stream) => {
        if (err) {
          conn.end();
          return reject(err);
        }
        resolve({ conn, stream });
      });
    }).on('error', reject).connect({
      host: device.host,
      port: Number(c.sshPort || 22),
      username: c.sshUsername || c.username || 'root',
      password: c.sshPassword || c.password,
      privateKey: c.privateKey || undefined,
      readyTimeout: 12000,
      keepaliveInterval: 5000,
      keepaliveCountMax: 3,
    });
  });
}
