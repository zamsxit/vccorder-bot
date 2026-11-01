import { Telegraf } from 'telegraf';
import {
  createLogger,
  html,
  trackUser,
  isOwner,
  resolveChannelInfo,
  resolveChannelUrl,
  checkChannelMembership,
  formatRequiredChannel,
  requiredChannelKeyboard,
  showScreen
} from './utils.js';
import { getGlobalSettings } from './settings.js';
import {
  startCommand,
  startAction,
  infoCommand,
  tosCommand,
  ketentuanAction,
  requestAccessAction,
  cancelAccessAction,
  leaderboardAction,
  handleTextMessage,
  handleContactMessage
} from './handlers/start.js';
import {
  viewProductsAction,
  buyProductAction,
  updateQuantityAction,
  customQtyAction,
  confirmOrderAction,
  riwayatCommand,
  riwayatAction,
  riwayatPageAction,
  handleCustomQtyText
} from './handlers/shop.js';
import {
  processPaymentAction,
  checkPaymentAction,
  cancelPaymentAction
} from './handlers/payment.js';
import { broadcastCommand } from './handlers/admin.js';

const log = createLogger('BOT');

export const enforceChannelJoin = async (ctx, next) => {
  const userId = ctx.from?.id;
  if (!userId) return next();

  // Owner bypass to prevent administrative lockout
  if (isOwner(userId)) return next();

  const settings = await getGlobalSettings();
  const channel = settings.requiredChannel;
  if (!channel) return next();

  const info = resolveChannelInfo(channel);
  if (!info) return next();

  const isCheckJoin = ctx.callbackQuery?.data === 'check_join';
  const isMember = await checkChannelMembership(ctx.telegram, channel, userId);

  if (isMember) {
    if (isCheckJoin) {
      await ctx.answerCbQuery('✅ Terima kasih! Anda sudah bergabung ke channel.', { show_alert: false }).catch(() => {});
      return startAction(ctx);
    }
    return next();
  }

  // User is not a member of required channel
  const channelUrl = await resolveChannelUrl(ctx.telegram, channel);
  const text = formatRequiredChannel(info.username || info.raw);
  const keyboard = requiredChannelKeyboard(channelUrl);

  if (isCheckJoin) {
    await ctx.answerCbQuery('⚠️ Anda belum bergabung ke channel. Silakan gabung terlebih dahulu!', { show_alert: true }).catch(() => {});
    return showScreen(ctx, text, keyboard);
  }

  if (ctx.callbackQuery) {
    await ctx.answerCbQuery('⚠️ Wajib gabung channel terlebih dahulu!', { show_alert: true }).catch(() => {});
    return showScreen(ctx, text, keyboard);
  }

  return ctx.reply(text, html(keyboard));
};

export const createBot = () => {
  const bot = new Telegraf(process.env.BOT_TOKEN);

  // Global user activity tracking & auto-registration
  bot.use(trackUser);

  // Mandatory Channel Join Gatekeeper
  bot.use(enforceChannelJoin);

  // Bot Commands
  bot.command('start', startCommand);
  bot.command('info', infoCommand);
  bot.command('tos', tosCommand);
  bot.command('ketentuan', tosCommand);
  bot.command('riwayat', riwayatCommand);
  bot.command('broadcast', broadcastCommand);

  // Navigation & Static Actions
  bot.action('start', startAction);
  bot.action('view_products', viewProductsAction);
  bot.action('request_access', requestAccessAction);
  bot.action('cancel_access', cancelAccessAction);
  bot.action(/^(ketentuan|tos)/, ketentuanAction);
  bot.action('riwayat', riwayatAction);
  bot.action('leaderboard', leaderboardAction);

  // Catalog, Cart & Order Dynamic Actions
  bot.action(/^buy_/, buyProductAction);
  bot.action(/^qty_/, updateQuantityAction);
  bot.action(/^custom_qty_/, customQtyAction);
  bot.action(/^confirm_/, confirmOrderAction);
  bot.action(/^pay_/, processPaymentAction);
  bot.action(/^check_/, checkPaymentAction);
  bot.action(/^cancel_/, cancelPaymentAction);
  bot.action(/^mytrx_/, riwayatPageAction);

  // Text & Contact Input Listeners (e.g. Whitelist WhatsApp phone submission & Custom Qty)
  bot.on('contact', handleContactMessage);
  bot.on('text', handleCustomQtyText, handleTextMessage);

  // Callback query safety fallback
  bot.on('callback_query', (ctx) => ctx.answerCbQuery().catch(() => {}));

  // Centralized error handling
  bot.catch((error, ctx) => {
    log.error('Update gagal diproses', { User: ctx.from?.id, Tipe: ctx.updateType }, error);
    ctx.answerCbQuery().catch(() => {});
    ctx.reply('<b>Terjadi kesalahan</b>\n\n<i>Silakan coba lagi</i>', html()).catch(() => {});
  });

  return bot;
};
