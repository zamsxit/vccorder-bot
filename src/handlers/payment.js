import { getProduct, getOrder, createOrder, failOrder } from '../database.js';
import { createPayment, checkPayment, cancelPayment } from '../services/payment.js';
import { finalizePayment, expireOrder, startPolling, stopPolling, retry } from '../services/order.js';
import { getGlobalSettings } from '../settings.js';
import {
  requireAccess,
  isOwner,
  createLogger,
  html,
  showScreen,
  parseProductAction,
  parseSuffix,
  formatMaintenance,
  maintenanceKeyboard,
  formatPaymentInfo,
  paymentKeyboard,
  formatPaymentCancelled,
  cancelledKeyboard
} from '../utils.js';

const log = createLogger('PAY');
const checkoutLocks = new Set();

const buildMessenger = (ctx) => {
  const message = ctx.callbackQuery?.message;
  return {
    telegram: ctx.telegram,
    chatId: message?.chat?.id ?? ctx.chat?.id,
    messageId: message?.message_id,
    userId: ctx.from?.id,
    username: ctx.from?.username
  };
};

/** Show the invoice with the gateway QRIS image, falling back if unavailable. */
const showInvoice = async (ctx, messenger, text, keyboard, qrisImage) => {
  const extra = html(keyboard);

  if (qrisImage) {
    try {
      const edited = await ctx.editMessageMedia({
        type: 'photo',
        media: qrisImage,
        caption: text,
        parse_mode: 'HTML'
      }, extra);
      if (edited) {
        messenger.messageId = edited.message_id ?? ctx.callbackQuery?.message?.message_id;
        return;
      }
    } catch (error) {
      log.debug('Gagal editMessageMedia QRIS, mencoba kirim photo baru', { Error: error.message });
    }

    try {
      await ctx.deleteMessage().catch(() => {});
      const sent = await ctx.replyWithPhoto(qrisImage, { caption: text, ...extra });
      if (sent) {
        messenger.messageId = sent.message_id;
        return;
      }
    } catch (photoError) {
      log.warn('Gagal memuat gambar QRIS, fallback ke caption', { URL: qrisImage }, photoError);
    }
  }

  const edited = await ctx.editMessageCaption(text, extra)
    .catch(() => ctx.editMessageText(text, extra))
    .then(() => true, () => false);
  if (edited) return;

  const sent = await ctx.reply(text, extra).catch(() => null);
  if (sent) messenger.messageId = sent.message_id;
};

export const processPaymentAction = async (ctx) => {
  const userId = ctx.from.id;
  if (checkoutLocks.has(userId)) {
    return ctx.answerCbQuery('⏳ Sedang memproses transaksi sebelumnya, mohon tunggu...').catch(() => {});
  }
  checkoutLocks.add(userId);

  try {
    await ctx.answerCbQuery('Membuat invoice...');
    if (!(await requireAccess(ctx))) return;

    // Strict fresh check from database to prevent order creation during maintenance
    const settings = await getGlobalSettings(true);
    if (settings.maintenanceMode && !isOwner(userId)) {
      log.warn('Order ditolak, sistem sedang dalam mode maintenance', {
        User: userId,
        Toko: settings.appName
      });
      return showScreen(ctx, formatMaintenance(settings.appName), maintenanceKeyboard());
    }

    const action = parseProductAction(ctx.callbackQuery.data, 'pay');
    const quantity = action?.quantity;

    if (!quantity || quantity < 1 || quantity > 20) {
      log.warn('Order ditolak, jumlah tidak valid', { User: userId, Jumlah: quantity });
      return ctx.reply('<b>Jumlah pesanan tidak valid (maksimal 20 VCC per transaksi)</b>', html());
    }

    const product = action?.productId ? await getProduct(action.productId) : null;

    if (!product || product.stock < quantity) {
      log.warn('Order ditolak, stok tidak mencukupi', {
        User: userId,
        Produk: action?.productId,
        Jumlah: quantity,
        Stok: product?.stock ?? 0
      });
      return ctx.reply('<b>Stok tidak mencukupi</b>', html());
    }

    const invoice = `INV-${Date.now()}`;

    try {
      const payment = await createPayment(product.price * quantity);

      await createOrder({
        invoice,
        trxid: payment.trxid,
        userId: ctx.from.id,
        userName: ctx.from.first_name,
        username: ctx.from.username,
        productId: product.id,
        productName: product.name,
        quantity,
        total: payment.total
      });

      log.info('Invoice dibuat', {
        Invoice: invoice,
        TrxID: payment.trxid,
        User: ctx.from.id,
        Produk: product.name,
        Jumlah: quantity,
        Total: `Rp ${(payment.total ?? 0).toLocaleString('id-ID')}`
      });

      const messenger = buildMessenger(ctx);
      await showInvoice(
        ctx,
        messenger,
        formatPaymentInfo(payment, invoice),
        paymentKeyboard(payment.qrisImage, payment.trxid),
        payment.qrisImage
      );
      startPolling(messenger, { trxid: payment.trxid, productName: product.name });
    } catch (error) {
      log.error('Pembuatan pembayaran gagal', { Invoice: invoice, User: ctx.from.id }, error);
      await ctx.reply('<b>Gagal membuat pembayaran</b>\n\n<i>Silakan coba lagi nanti</i>', html());
    }
  } finally {
    checkoutLocks.delete(userId);
  }
};

export const checkPaymentAction = async (ctx) => {
  const respond = (text) => ctx.answerCbQuery(text).catch(() => {});
  if (!(await requireAccess(ctx))) return respond();

  const trxid = parseSuffix(ctx.callbackQuery.data, 'check');
  const order = trxid ? await getOrder(trxid) : null;

  if (!order || order.userId !== ctx.from.id) {
    log.warn('Cek status ditolak, order bukan milik pengguna', { User: ctx.from.id, TrxID: trxid });
    return respond('Transaksi tidak ditemukan');
  }

  let status;
  try {
    status = await retry(() => checkPayment(trxid));
  } catch {
    return respond('⚠️ Gagal cek status, coba lagi');
  }

  log.debug('Cek status manual', { User: ctx.from.id, TrxID: trxid, Status: status.status });

  if (status.status === 'paid') {
    const payment = { trxid, amount: status.amount, productName: order.productName };
    if (await finalizePayment(buildMessenger(ctx), payment)) stopPolling(trxid);
    return respond('✅ Pembayaran diterima');
  }

  const settings = await getGlobalSettings();
  if (settings.maintenanceMode && !isOwner(ctx.from.id)) {
    return respond('⚠️ Toko sedang maintenance. Transaksi dipending.');
  }

  if (status.status === 'expired') {
    await respond();
    return expireOrder(trxid, buildMessenger(ctx));
  }
  return respond('⏳ Masih menunggu pembayaran');
};

export const cancelPaymentAction = async (ctx) => {
  const respond = (text) => ctx.answerCbQuery(text).catch(() => {});
  if (!(await requireAccess(ctx))) return respond();

  const trxid = parseSuffix(ctx.callbackQuery.data, 'cancel');
  const order = trxid ? await getOrder(trxid) : null;

  if (!order || order.userId !== ctx.from.id) {
    log.warn('Pembatalan ditolak, order bukan milik pengguna', { User: ctx.from.id, TrxID: trxid });
    return respond('Transaksi tidak ditemukan');
  }

  if (order.status !== 'pending') {
    return respond('Order sudah tidak dalam status pending');
  }

  stopPolling(trxid);
  await failOrder(order.id);
  await cancelPayment(trxid).catch(() => {});

  log.warn('Pembayaran dibatalkan oleh pengguna', {
    Invoice: order.invoice,
    TrxID: trxid,
    User: ctx.from.id
  });

  await respond('❌ Pembayaran dibatalkan');
  await showScreen(ctx, formatPaymentCancelled(order.invoice, trxid), cancelledKeyboard());
};
