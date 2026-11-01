import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  getOrder,
  fulfillOrder,
  deleteOrderStocks,
  refreshProductCounters,
  reconcileSoldStocks,
  markDelivered,
  markReceiptSent,
  getStalePendingOrders,
  failOrder
} from '../database.js';
import { checkPayment } from './payment.js';
import { getGlobalSettings } from '../settings.js';
import {
  createLogger,
  HTML,
  formatDeliverySuccess,
  formatPaymentExpired,
  formatReceipt
} from '../utils.js';

const log = createLogger('PAY');

const POLL_MS = 3000;
const EXPIRY_MINUTES = 15;
const SWEEP_MS = 30 * 1000;
const RECONCILE_MS = 5 * 60 * 1000;

const polls = new Map();
const locks = new Set();
let fulfillmentQueue = Promise.resolve();
let workerTelegram = null;

const rupiah = (value) => `Rp ${(value ?? 0).toLocaleString('id-ID')}`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export const retry = async (fn, times = 3, delay = 800) => {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (error) {
      if (attempt >= times) throw error;
      await sleep(delay * attempt);
    }
  }
};

const canMessage = (messenger) => Boolean(messenger?.telegram && messenger?.chatId);

const notify = (messenger, text) =>
  canMessage(messenger)
    ? retry(() => messenger.telegram.sendMessage(messenger.chatId, text, HTML))
        .catch((error) => log.warn('Notifikasi gagal terkirim', { Chat: messenger.chatId }, error))
    : Promise.resolve();

export const stopPolling = (trxid) => {
  clearInterval(polls.get(trxid));
  polls.delete(trxid);
};

/** Serialise fulfilment so a card cannot be reserved while it still waits to be deleted. */
const runExclusive = (task) => {
  const result = fulfillmentQueue.then(task, task);
  fulfillmentQueue = result.then(() => undefined, () => undefined);
  return result;
};

const deliverCards = async (messenger, order, name, cards) => {
  if (messenger.messageId) {
    await retry(() => messenger.telegram.deleteMessage(messenger.chatId, messenger.messageId)).catch(() => {});
  }
  const text = formatDeliverySuccess(order.invoice, { name }, cards);
  await retry(() => messenger.telegram.sendMessage(messenger.chatId, text, HTML), 5);
};

/** Deliver once. A failure keeps the cards on the order so the web panel can resend them. */
const deliver = async (messenger, order, name, cards) => {
  if (order.deliveredAt || !cards.length || !canMessage(messenger)) return;

  try {
    await deliverCards(messenger, order, name, cards);
  } catch (error) {
    log.error('Pengiriman kartu gagal, data tersimpan di order', { Invoice: order.invoice, User: order.userId }, error);
    return;
  }

  try {
    await markDelivered(order.id);
    log.info('Kartu terkirim ke pembeli', { Invoice: order.invoice, Jumlah: `${cards.length} kartu` });
  } catch (error) {
    log.error('Kartu terkirim tetapi status pengiriman gagal disimpan', { Invoice: order.invoice }, error);
  }
};

const removeSoldStock = async (order, stockIds) => {
  const { deleted, remaining } = await deleteOrderStocks(stockIds);

  if (remaining.length) {
    log.error('Penghapusan stok tidak lengkap', {
      Invoice: order.invoice,
      Terhapus: `${deleted.length}/${stockIds.length}`,
      'ID tersisa': remaining.join(',')
    });
    return;
  }

  log.stock('Stok berhasil diperbarui', { Invoice: order.invoice, 'Stok terpakai': `${deleted.length} item` });
  log.debug('Stok dihapus', { Invoice: order.invoice, ID: stockIds.join(',') });
};

export const resolveReceiptImage = () => {
  const envVal = process.env.RECEIPT_IMAGE_PATH || process.env.RECEIPT_IMAGE;
  if (envVal) {
    if (envVal.startsWith('http://') || envVal.startsWith('https://')) {
      return envVal;
    }
    return path.resolve(process.cwd(), envVal);
  }

  return path.join(path.dirname(fileURLToPath(import.meta.url)), '../../assets/receipt.jpg');
};

const sendReceipt = async (messenger, order, name) => {
  const telegram = messenger?.telegram ?? workerTelegram;
  const settings = await getGlobalSettings();
  const channel = settings.channelInfo || process.env.LOG_CHANNEL;
  if (!channel || !telegram) return;

  const caption = formatReceipt(order, name);
  const imageTarget = resolveReceiptImage();

  try {
    if (typeof imageTarget === 'string' && (imageTarget.startsWith('http://') || imageTarget.startsWith('https://'))) {
      await retry(() => telegram.sendPhoto(channel, imageTarget, { caption, parse_mode: 'HTML' }));
    } else if (imageTarget && fs.existsSync(imageTarget)) {
      await retry(() => telegram.sendPhoto(channel, { source: imageTarget }, { caption, parse_mode: 'HTML' }));
    } else {
      await retry(() => telegram.sendMessage(channel, caption, HTML));
    }
    await markReceiptSent(order.id);
    log.info('Struk dikirim ke channel', { Invoice: order.invoice, Channel: channel });
  } catch (error) {
    try {
      await retry(() => telegram.sendMessage(channel, caption, HTML));
      await markReceiptSent(order.id);
      log.info('Struk dikirim ke channel (fallback text)', { Invoice: order.invoice, Channel: channel });
    } catch (fallbackError) {
      log.error('Struk gagal dikirim ke channel', { Invoice: order.invoice, Channel: channel }, fallbackError);
    }
  }
};

const handleUnfulfilled = async (messenger, trxid, { reason, order }) => {
  const fields = { Invoice: order?.invoice, TrxID: trxid };

  if (reason === 'insufficient_stock') {
    stopPolling(trxid);
    log.warn('Stok tidak mencukupi, order dibatalkan', { ...fields, Jumlah: order?.quantity });
    await notify(messenger, '<b>⚠️ Stok tidak mencukupi. Transaksi dibatalkan.</b>');
    return true;
  }

  if (reason === 'closed' || reason === 'not_found') {
    stopPolling(trxid);
    log.warn('Order sudah ditutup, pemrosesan dihentikan', { ...fields, Alasan: reason });
    return true;
  }

  log.warn('Pemenuhan order akan dicoba ulang', { ...fields, Alasan: reason });
  return false;
};

const completePaidOrder = async (messenger, { trxid, amount, productName }) => {
  const result = await fulfillOrder({ key: trxid, amount });
  if (!result.success) return handleUnfulfilled(messenger, trxid, result);

  const { order, stockIds, cardData } = result;
  const name = productName || order.productName;

  if (!result.alreadyCompleted) {
    log.info('Pembayaran diterima', {
      Invoice: order.invoice,
      TrxID: order.trxid,
      User: order.username ? `${order.userId} (@${order.username})` : order.userId,
      Produk: name,
      Jumlah: order.quantity,
      Total: rupiah(order.total)
    });
  }

  await deliver(messenger, order, name, cardData);
  await removeSoldStock(order, stockIds);

  await refreshProductCounters(order.productId).catch((error) =>
    log.warn('Counter produk gagal diperbarui', { Produk: order.productId }, error)
  );

  if (!order.receiptSent) await sendReceipt(messenger, order, name);
  return true;
};

/** Fulfil a paid order once. Resolves true when polling for it can stop. */
export const finalizePayment = (messenger, payment) => {
  if (locks.has(payment.trxid)) return Promise.resolve(false);
  locks.add(payment.trxid);

  return runExclusive(() => completePaidOrder(messenger, payment))
    .catch((error) => {
      log.error('Pemenuhan order gagal', { TrxID: payment.trxid }, error);
      return false;
    })
    .finally(() => locks.delete(payment.trxid));
};

/** Mark a pending order as failed and tell the buyer. Completed orders are never touched. */
export const expireOrder = async (trxid, messenger) => {
  stopPolling(trxid);
  const order = await getOrder(trxid).catch(() => null);
  if (order?.status === 'pending') await failOrder(order.id);

  log.warn('Pembayaran kedaluwarsa', { Invoice: order?.invoice, TrxID: trxid, User: order?.userId });
  await notify(messenger, formatPaymentExpired(trxid));
};

export const startPolling = (messenger, { trxid, productName }) => {
  if (polls.has(trxid)) return;

  const deadline = Date.now() + (EXPIRY_MINUTES + 1) * 60 * 1000;
  let busy = false;

  const tick = async () => {
    if (busy) return;
    busy = true;

    try {
      if (Date.now() > deadline) return stopPolling(trxid);

      const status = await retry(() => checkPayment(trxid), 3, 1000);
      if (status.status === 'paid') {
        if (await finalizePayment(messenger, { trxid, amount: status.amount, productName })) stopPolling(trxid);
      } else if (status.status === 'expired') {
        await expireOrder(trxid, messenger);
      }
    } catch (error) {
      log.debug('Pengecekan pembayaran ditunda', { TrxID: trxid, Penyebab: error.message });
    } finally {
      busy = false;
    }
  };

  const timer = setInterval(tick, POLL_MS);
  timer.unref?.();
  polls.set(trxid, timer);
  tick();
};

/**
 * Expire pending orders older than the limit. The gateway is asked first so a
 * last-second payment is fulfilled; when it is unreachable the order is left
 * pending and retried on the next sweep instead of being failed blindly.
 */
const sweepStaleOrders = async () => {
  const stale = await getStalePendingOrders(EXPIRY_MINUTES);

  for (const order of stale) {
    if (locks.has(order.trxid)) continue;

    let status;
    try {
      status = await checkPayment(order.trxid);
    } catch {
      continue;
    }

    const messenger = { telegram: workerTelegram, chatId: order.userId, userId: order.userId, username: order.username };
    if (status.status === 'paid') {
      log.info('Pembayaran terlambat dipulihkan', { Invoice: order.invoice, TrxID: order.trxid });
      await finalizePayment(messenger, { trxid: order.trxid, amount: status.amount, productName: order.productName });
    } else {
      await expireOrder(order.trxid, messenger);
    }
  }
};

const reconcileStock = async () => {
  const result = await reconcileSoldStocks();
  if (result.deleted > 0) {
    log.warn('Stok terjual yang tertinggal dibersihkan', {
      Kartu: result.deleted,
      Order: result.orders,
      Produk: result.products.join(',')
    });
  }
};

const every = (label, intervalMs, job) => {
  const run = () => job().catch((error) => log.error(`${label} gagal`, {}, error));
  const timer = setInterval(run, intervalMs);
  timer.unref?.();
  run();
  return timer;
};

export const startWorkers = (telegram) => {
  workerTelegram = telegram;
  return [
    every('Penyapu order kedaluwarsa', SWEEP_MS, sweepStaleOrders),
    every('Rekonsiliasi stok', RECONCILE_MS, reconcileStock)
  ];
};

export const WORKER_INTERVALS = { sweep: `${SWEEP_MS / 1000}s`, reconcile: `${RECONCILE_MS / 60000}m` };
