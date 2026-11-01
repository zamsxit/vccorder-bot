import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createLogger, printBanner } from './src/utils.js';

const log = createLogger('APP');

try {
  process.loadEnvFile(fileURLToPath(new URL('./.env', import.meta.url)));
} catch {}

const REQUIRED_ENV = ['BOT_TOKEN', 'SUPABASE_URL', 'SUPABASE_KEY', 'PAYMENT_BASE_URL', 'PAYMENT_API_KEY'];
const missing = REQUIRED_ENV.filter((name) => !process.env[name]);
if (missing.length) {
  log.error('Konfigurasi .env belum lengkap', { Variabel: missing.join(', ') });
  process.exit(1);
}

process.on('unhandledRejection', (reason) => log.error('Unhandled rejection', {}, reason));
process.on('uncaughtException', (error) => {
  log.error('Uncaught exception', {}, error);
  process.exit(1);
});

const { version } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));
const { createBot } = await import('./src/bot.js');
const { startWorkers, WORKER_INTERVALS } = await import('./src/services/order.js');
const { getGlobalSettings } = await import('./src/settings.js');

const bot = createBot();

const shutdown = (signal) => {
  log.info('Menghentikan bot', { Sinyal: signal });
  try {
    bot.stop(signal);
  } catch {}
};
process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));

const onLaunch = async () => {
  const settings = await getGlobalSettings(true).catch(() => ({}));
  const appName = settings.appName || 'VCC ORDER BOT';
  const channel = settings.channelInfo || process.env.LOG_CHANNEL || 'belum diatur';

  printBanner({
    title: appName.toUpperCase(),
    status: 'ONLINE',
    rows: [
      ['Bot', `@${bot.botInfo.username}`],
      ['App Name', appName],
      ['Versi', `v${version}`],
      ['Owner', process.env.OWNER_ID || 'belum diatur'],
      ['Channel', channel],
      ['Runtime', `Node ${process.version} (${process.platform})`],
    ]
  });
  startWorkers(bot.telegram);
};

// launch() resolves only when polling stops, so the workers start from the callback.
bot.launch(onLaunch).catch((error) => {
  log.error('Bot gagal terhubung ke Telegram', {}, error);
  process.exit(1);
});
