import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getUser, getUserOrderStats, getLeaderboard, requestAccess } from '../database.js';
import { getGlobalSettings } from '../settings.js';
import {
  getAccess,
  accessScreen,
  requireAccess,
  createLogger,
  html,
  showScreen,
  formatWelcome,
  formatKetentuan,
  formatRequestAccessPrompt,
  formatMyInfo,
  formatLeaderboard,
  startKeyboard,
  leaderboardKeyboard,
  ketentuanKeyboard,
  requestAccessCancelKeyboard
} from '../utils.js';

const log = createLogger('BOT');

const IMAGE_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../assets/thumbnail.jpg');

export const awaitingPhone = new Set();

const buildStart = async (userId) => {
  const [access, settings] = await Promise.all([getAccess(userId), getGlobalSettings()]);
  return access === 'granted'
    ? { text: formatWelcome(settings.appName), keyboard: startKeyboard() }
    : accessScreen(access);
};

export const startCommand = async (ctx) => {
  log.debug('Perintah /start', { User: ctx.from.id });
  const { text, keyboard } = await buildStart(ctx.from.id);
  try {
    await ctx.replyWithPhoto({ source: IMAGE_PATH }, { caption: text, ...html(keyboard) });
  } catch (error) {
    log.warn('Gambar menu gagal dikirim, memakai teks', { User: ctx.from.id }, error);
    await ctx.reply(text, html(keyboard));
  }
};

export const startAction = async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const { text, keyboard } = await buildStart(ctx.from.id);
  try {
    const edited = await ctx.editMessageMedia({
      type: 'photo',
      media: { source: IMAGE_PATH },
      caption: text,
      parse_mode: 'HTML'
    }, html(keyboard));
    if (edited) return;
  } catch {}
  await showScreen(ctx, text, keyboard);
};

export const infoCommand = async (ctx) => {
  log.debug('Perintah /info', { User: ctx.from.id });
  const { id, first_name: firstName, username } = ctx.from;
  const [user, stats] = await Promise.all([
    getUser(id).then((u) => u ?? { id, firstName, username, status: 'new' }),
    getUserOrderStats(id)
  ]);
  await ctx.reply(formatMyInfo(user, stats), html());
};

export const tosCommand = async (ctx) => {
  log.debug('Perintah /tos', { User: ctx.from.id });
  await ctx.reply(formatKetentuan(), html());
};

export const ketentuanAction = async (ctx) => {
  await ctx.answerCbQuery();
  await showScreen(ctx, formatKetentuan(), ketentuanKeyboard());
};

export const leaderboardAction = async (ctx) => {
  await ctx.answerCbQuery();
  if (!(await requireAccess(ctx))) return;

  const [leaders, settings] = await Promise.all([
    getLeaderboard(10),
    getGlobalSettings()
  ]);

  await showScreen(ctx, formatLeaderboard(leaders, settings.appName), leaderboardKeyboard());
};

export const requestAccessAction = async (ctx) => {
  await ctx.answerCbQuery();
  const user = await getUser(ctx.from.id);

  if (user?.status === 'whitelisted') {
    await ctx.reply('<blockquote>Kamu sudah memiliki akses aktif. Silakan mulai berbelanja via /start</blockquote>', html());
    return;
  }
  if (user?.status === 'pending') {
    const phoneInfo = user.phone ? ` (No. WA: <code>${user.phone}</code>)` : '';
    await ctx.reply(`<blockquote>Permintaan akses Anda${phoneInfo} sedang menunggu persetujuan admin.</blockquote>`, html());
    return;
  }

  awaitingPhone.add(ctx.from.id);
  await ctx.reply(formatRequestAccessPrompt(), html(requestAccessCancelKeyboard()));
};

export const cancelAccessAction = async (ctx) => {
  await ctx.answerCbQuery();
  awaitingPhone.delete(ctx.from.id);
  await ctx.reply('<blockquote>Permintaan akses dibatalkan.</blockquote>', html());
};

const normalizePhone = (raw) => {
  const digits = String(raw || '').replace(/[\s\-\(\)\+]/g, '');
  if (digits.startsWith('62')) return digits;
  if (digits.startsWith('0')) return `62${digits.slice(1)}`;
  return digits;
};

const isValidPhoneNumber = (phone) => /^[0-9]{9,15}$/.test(phone);

const submitAccessRequest = async (ctx, rawPhone) => {
  const userId = ctx.from.id;
  const phone = normalizePhone(rawPhone);

  if (!isValidPhoneNumber(phone)) {
    await ctx.reply(
      '⚠️ <b>Format Nomor WhatsApp Tidak Valid</b>\n\n' +
      'Mohon kirimkan nomor WhatsApp aktif berupa angka (contoh: <code>081234567890</code> atau <code>6281234567890</code>).\n\n' +
      '<i>Atau klik tombol Batal jika tidak ingin melanjutkan.</i>',
      html(requestAccessCancelKeyboard())
    );
    return false;
  }

  awaitingPhone.delete(userId);
  await requestAccess(userId, phone, {
    firstName: ctx.from.first_name,
    username: ctx.from.username
  });

  log.info('Permintaan akses dengan nomor WA', { User: userId, Phone: phone });

  await ctx.reply(
    '╭────────────✧\n' +
    '┊ ✅ <b>PERMINTAAN AKSES TERKIRIM</b>\n' +
    '╰────────────✧\n\n' +
    `📱 <b>Nomor WhatsApp:</b> <code>${phone}</code>\n` +
    `ℹ️ <b>Status:</b> <code>Menunggu Persetujuan Admin</code>\n\n` +
    `<blockquote>Terima kasih telah menyetujui ketentuan layanan. Admin akan memverifikasi permohonan Anda.</blockquote>\n\n` +
    `<i>Ketik /info untuk mengecek profil dan status akun Anda kapan saja.</i>`,
    html()
  );
  return true;
};

export const handleTextMessage = async (ctx, next) => {
  const userId = ctx.from?.id;
  if (!userId) return next();

  const text = ctx.message?.text?.trim() || '';
  if (text.startsWith('/')) {
    awaitingPhone.delete(userId);
    return next();
  }

  if (awaitingPhone.has(userId)) {
    const handled = await submitAccessRequest(ctx, text);
    if (handled) return;
  }

  return next();
};

export const handleContactMessage = async (ctx, next) => {
  const userId = ctx.from?.id;
  const contact = ctx.message?.contact;
  if (!userId || !contact) return next();

  if (awaitingPhone.has(userId)) {
    const handled = await submitAccessRequest(ctx, contact.phone_number);
    if (handled) return;
  }

  return next();
};
