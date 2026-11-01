import axios from 'axios';
import { createLogger } from '../utils.js';

const log = createLogger('PAY');

const apiKey = () => process.env.MELDAPAY_API_KEY || process.env.PAYMENT_API_KEY;
const baseUrl = () => process.env.MELDAPAY_BASE_URL || process.env.PAYMENT_BASE_URL || 'https://meldapay.com';

const client = () =>
  axios.create({
    baseURL: baseUrl(),
    timeout: 15000
  });

/**
 * Request creation of a new QRIS payment invoice via Meldapay.
 * @param {number|string} amount
 * @returns {Promise<{ trxid: string, amount: number, fee: number, total: number, qrisImage: string, paymentLink: string, expiredAt: string }>}
 */
export const createPayment = async (amount) => {
  const intAmount = Math.round(Number(amount));
  if (!Number.isInteger(intAmount) || intAmount <= 0) {
    throw new Error('amount harus berupa integer positif');
  }

  const { data } = await client().get('/api/invoice', {
    params: { apikey: apiKey(), amount: intAmount }
  }).catch((error) => {
    log.error('Permintaan ke payment gateway gagal', { Endpoint: '/api/invoice' }, error);
    throw new Error('Gagal membuat pembayaran');
  });

  if (!data?.success || !data?.invoice_id) {
    log.error('Payment gateway menolak pembuatan invoice', { Jumlah: intAmount });
    throw new Error('Gagal membuat pembayaran');
  }

  return {
    trxid: data.invoice_id,
    amount: data.amount,
    fee: data.fee ?? 0,
    total: data.total ?? data.amount,
    qrisImage: data.qris_image,
    paymentLink: data.payment_link,
    expiredAt: data.expired_at
  };
};

/**
 * Check current invoice status on Meldapay.
 * @param {string} trxid
 * @returns {Promise<{ trxid: string, amount: number, fee: number, total: number, status: string, rawStatus: string, qrisImage: string, paymentLink: string, expiredAt: string }>}
 */
export const checkPayment = async (trxid) => {
  if (!trxid) throw new Error('invoice_id wajib berupa string');

  const { data } = await client().get('/api/invoice/status', {
    params: { apikey: apiKey(), invoice_id: trxid }
  }).catch((error) => {
    log.error('Permintaan ke payment gateway gagal', { Endpoint: '/api/invoice/status' }, error);
    throw new Error('Gagal cek status pembayaran');
  });

  return {
    trxid: data?.invoice_id || trxid,
    amount: data?.amount,
    fee: data?.fee,
    total: data?.total,
    status: data?.status === 'cancelled' ? 'expired' : (data?.status ?? 'pending'),
    rawStatus: data?.status,
    qrisImage: data?.qris_image,
    paymentLink: data?.payment_link,
    expiredAt: data?.expired_at
  };
};

/**
 * Cancel a pending invoice on Meldapay.
 * @param {string} trxid
 * @returns {Promise<any>}
 */
export const cancelPayment = async (trxid) => {
  if (!trxid) return null;

  try {
    const { data } = await client().post('/api/invoice/cancel', null, {
      params: { apikey: apiKey(), invoice_id: trxid }
    });
    return data;
  } catch (error) {
    log.warn('Gagal membatalkan invoice di gateway', { TrxID: trxid }, error);
    return null;
  }
};
