try { process.loadEnvFile(); } catch {}
import { spawn } from 'node:child_process';
import { createLogger } from './src/utils.js';
import { getGlobalSettings } from './src/settings.js';

const log = createLogger('LAUNCH');
const RESTART_DELAY_MS = 3000;
const STABLE_UPTIME_S = 60;

let child = null;
let restarts = 0;
let shuttingDown = false;

const start = async () => {
  const startedAt = Date.now();
  const settings = await getGlobalSettings().catch(() => ({ appName: 'VCC Order Bot' }));
  const appName = settings.appName || 'VCC Order Bot';

  child = spawn(process.execPath, ['--watch', 'index.js'], { stdio: 'inherit' });
  log.info(`Proses ${appName} dijalankan (watch mode)`, { PID: child.pid, Restart: restarts });

  child.on('exit', (code, signal) => {
    const uptime = Math.round((Date.now() - startedAt) / 1000);
    if (shuttingDown) {
      log.info(`Proses ${appName} dihentikan`, { Uptime: `${uptime}s` });
      process.exit(0);
    }

    restarts = uptime >= STABLE_UPTIME_S ? 1 : restarts + 1;
    log.restart(`Proses ${appName} berhenti, memulai ulang`, {
      Kode: code ?? '-',
      Sinyal: signal ?? '-',
      Uptime: `${uptime}s`,
      Jeda: `${RESTART_DELAY_MS / 1000}s`
    });
    setTimeout(start, RESTART_DELAY_MS);
  });
};

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    shuttingDown = true;
    child?.kill(signal);
  });
}

start();
