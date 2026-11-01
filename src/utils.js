import { Markup } from 'telegraf';
import { getUserStatus, upsertUser } from './database.js';

// ============================================================================
// 1. Logger & ANSI Terminal Styling
// ============================================================================

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const SECRET_ENV = ['BOT_TOKEN', 'SUPABASE_KEY', 'PAYMENT_API_KEY'];
const TOKEN_PATTERN = /bot\d{6,}:[\w-]{20,}/g;

const useColor = !process.env.NO_COLOR && process.stdout.isTTY !== false;
const paint = (code, text) => (useColor ? `\u001b[${code}m${text}\u001b[0m` : text);

const style = {
  dim: (t) => paint('90', t),
  bold: (t) => paint('1', t),
  cyan: (t) => paint('36', t),
  green: (t) => paint('32', t),
  white: (t) => paint('97', t)
};

const ACTION_STYLE = {
  ERROR: (t) => paint('41;97;1', t),
  WARN: (t) => paint('43;97;1', t),
  PAYMENT: (t) => paint('42;97;1', t),
  STOCK: (t) => paint('43;97;1', t),
  BOT: (t) => paint('45;97;1', t),
  INFO: (t) => paint('44;97;1', t),
  DB: (t) => paint('46;97;1', t),
  RESTART: (t) => paint('41;97;1', t),
  DEBUG: (t) => paint('100;97;1', t)
};

const ACTION_ALIAS = {
  APP: 'INFO',
  PAY: 'PAYMENT',
  LAUNCH: 'INFO'
};

const MESSAGE_STYLE = {
  ERROR: (t) => paint('31', t),
  WARN: (t) => paint('33', t)
};

const minLevel = () => LEVELS[process.env.LOG_LEVEL?.toLowerCase()] ?? LEVELS.info;

export const redact = (value) => {
  let text = String(value ?? '');
  for (const name of SECRET_ENV) {
    const secret = process.env[name];
    if (secret && secret.length >= 8) text = text.split(secret).join('***');
  }
  return text.replace(TOKEN_PATTERN, 'bot***');
};

const clock = () => new Date().toTimeString().slice(0, 8);

const formatFields = (fields) =>
  Object.entries(fields ?? {})
    .filter(([, value]) => value !== undefined && value !== null && value !== '')
    .map(([key, value]) => ` ${style.dim('|')} ${key}: ${redact(value)}`)
    .join('');

const errorDetail = (error) => {
  if (!error) return '';
  const message = error.response?.data
    ? JSON.stringify(error.response.data)
    : error.message ?? String(error);
  return ` ${style.dim('|')} Penyebab: ${redact(message)}`;
};

const normalize = (name) => {
  const upper = String(name || 'INFO').toUpperCase();
  return ACTION_ALIAS[upper] ?? upper;
};

export const createLogger = (defaultAction = 'INFO') => {
  const currentAction = normalize(defaultAction);

  const write = (action, level, message, fields, error) => {
    if (LEVELS[level] < minLevel()) return;

    const paintAction = ACTION_STYLE[action] ?? style.dim;
    const badge = paintAction(` ${action} `);
    const outerPad = ' '.repeat(Math.max(1, 9 - action.length));
    const paintMessage = MESSAGE_STYLE[action] ?? ((t) => t);
    const line = `${style.dim(clock())} ${badge}${outerPad}${paintMessage(redact(message))}${formatFields(fields)}${errorDetail(error)}`;

    (level === 'error' || level === 'warn' ? console.error : console.log)(line);

    if (error?.stack && LEVELS.debug >= minLevel()) {
      console.error(style.dim(redact(error.stack)));
    }
  };

  return {
    debug: (message, fields) => write('DEBUG', 'debug', message, fields),
    info: (message, fields) => write(currentAction, 'info', message, fields),
    warn: (message, fields, error) => write('WARN', 'warn', message, fields, error),
    error: (message, fields, error) => write('ERROR', 'error', message, fields, error),
    payment: (message, fields) => write('PAYMENT', 'info', message, fields),
    stock: (message, fields) => write('STOCK', 'info', message, fields),
    bot: (message, fields) => write('BOT', 'info', message, fields),
    restart: (message, fields) => write('RESTART', 'warn', message, fields),
    db: (message, fields) => write('DB', 'info', message, fields),
    scope: (name) => createLogger(name)
  };
};

export const log = createLogger();

const visibleStringLength = (text) => [...text].length;

export const printBanner = ({ title, status, rows }) => {
  const labelWidth = Math.max(...rows.map(([label]) => label.length));
  const body = rows.map(([label, value]) => `${label.padEnd(labelWidth)}  ${value ?? '-'}`);
  const head = `${title}  ·  ${status}`;
  const width = Math.max(visibleStringLength(head), ...body.map(visibleStringLength)) + 4;
  const rule = '─'.repeat(width);
  const pad = (text) => text + ' '.repeat(width - 2 - visibleStringLength(text));

  const lines = [
    style.cyan(`╭${rule}╮`),
    `${style.cyan('│')}  ${style.bold(style.white(pad(head)))}${style.cyan('│')}`,
    style.cyan(`├${rule}┤`),
    ...rows.map(([label, value], index) => {
      const plain = body[index];
      const rendered = `${style.dim(label.padEnd(labelWidth))}  ${style.white(String(value ?? '-'))}`;
      return `${style.cyan('│')}  ${rendered}${' '.repeat(width - 2 - visibleStringLength(plain))}${style.cyan('│')}`;
    }),
    style.cyan(`╰${rule}╯`)
  ];
  console.log(`\n${lines.join('\n')}\n`);
};

// ============================================================================
// 2. Input Parsing & Validation
// ============================================================================

export const MAX_ORDER_QUANTITY = 20;

export const parseQuantity = (raw) => {
  const quantity = Number.parseInt(raw, 10);
  return Number.isInteger(quantity) && quantity >= 1 && quantity <= MAX_ORDER_QUANTITY ? quantity : null;
};

export const parseProductAction = (data, prefix) => {
  const match = new RegExp(`^${prefix}_(.+)_(\\d+)$`).exec(data ?? '');
  return match ? { productId: match[1], quantity: parseQuantity(match[2]) } : null;
};

export const parseSuffix = (data, prefix) =>
  data?.startsWith(`${prefix}_`) ? data.slice(prefix.length + 1) : '';

export const parsePage = (raw) => {
  const page = Number.parseInt(raw, 10);
  return Number.isInteger(page) && page >= 0 ? page : 0;
};

// ============================================================================
// 3. User Middleware & Access Control
// ============================================================================

const knownUsers = new Set();

export const isOwner = (userId) => userId === Number(process.env.OWNER_ID);

export const trackUser = async (ctx, next) => {
  const user = ctx.from;
  if (user && !isOwner(user.id) && !knownUsers.has(user.id)) {
    try {
      await upsertUser({ id: user.id, firstName: user.first_name, username: user.username });
      knownUsers.add(user.id);
    } catch (error) {
      log.error('Gagal mencatat pengguna', { User: user.id }, error);
    }
  }
  return next();
};

export const getAccess = async (userId) => {
  if (isOwner(userId)) return 'granted';
  const status = await getUserStatus(userId);
  return status === 'whitelisted' ? 'granted' : status;
};

export const accessScreen = (status) => {
  const screens = {
    pending: [formatAccessPending, emptyKeyboard],
    blocked: [formatAccessBlocked, accessKeyboard]
  };
  const [format, keyboard] = screens[status] ?? [formatAccessDenied, accessKeyboard];
  return { text: format(), keyboard: keyboard() };
};

export const requireAccess = async (ctx) => {
  const access = await getAccess(ctx.from.id);
  if (access === 'granted') return true;

  const { text, keyboard } = accessScreen(access);
  await ctx.reply(text, html(keyboard));
  return false;
};

export const resolveChannelInfo = (channelRaw) => {
  if (!channelRaw) return null;
  const raw = String(channelRaw).trim();
  if (!raw) return null;

  let username = '';
  let url = '';
  let chatId = raw;

  if (raw.startsWith('https://t.me/') || raw.startsWith('http://t.me/')) {
    url = raw;
    const path = raw.replace(/^https?:\/\/t\.me\//i, '').replace(/^\+/, '');
    if (!raw.includes('/+') && !raw.includes('/joinchat/')) {
      username = `@${path.split('/')[0]}`;
      chatId = username;
    }
  } else if (raw.startsWith('@')) {
    username = raw;
    url = `https://t.me/${raw.slice(1)}`;
    chatId = raw;
  } else if (/^-?\d+$/.test(raw)) {
    chatId = raw;
    url = `https://t.me/c/${raw.replace(/^-100/, '')}`;
  } else {
    username = `@${raw}`;
    url = `https://t.me/${raw}`;
    chatId = username;
  }

  return { raw, username, url, chatId };
};

export const resolveChannelUrl = async (telegram, channelTarget) => {
  const info = resolveChannelInfo(channelTarget);
  if (!info) return '';
  if (info.url && !info.url.includes('/c/')) return info.url;

  try {
    const chat = await telegram.getChat(info.chatId);
    if (chat?.username) return `https://t.me/${chat.username}`;
    if (chat?.invite_link) return chat.invite_link;
    const link = await telegram.exportChatInviteLink(info.chatId);
    return link || info.url;
  } catch {
    return info.url;
  }
};

export const checkChannelMembership = async (telegram, channelTarget, userId) => {
  if (!channelTarget || !userId) return true;
  const info = resolveChannelInfo(channelTarget);
  if (!info || !info.chatId) return true;

  try {
    const member = await telegram.getChatMember(info.chatId, userId);
    const validStatuses = new Set(['creator', 'administrator', 'member', 'restricted']);
    return validStatuses.has(member?.status);
  } catch (error) {
    const msg = error?.description || error?.message || '';
    if (/user not found|PARTICIPANT_ID_INVALID/i.test(msg)) {
      return false;
    }
    log.warn('Pemeriksaan membership channel gagal (pastikan bot sudah admin di channel)', {
      Channel: info.chatId,
      User: userId,
      Penyebab: msg
    });
    return false;
  }
};

// ============================================================================
// 4. Telegram Screen & Presentation Helpers
// ============================================================================

export const HTML = { parse_mode: 'HTML' };

export const html = (extra) => ({ ...HTML, ...extra });

const isNotModified = (error) =>
  /message is not modified/i.test(error?.description ?? error?.message ?? '');

export const showScreen = async (ctx, text, keyboard) => {
  const message = ctx.callbackQuery?.message;
  const extra = html(keyboard);
  if (!message) return ctx.reply(text, extra);

  const isPhoto = Boolean(message.photo);

  try {
    return isPhoto
      ? await ctx.editMessageCaption(text, extra)
      : await ctx.editMessageText(text, extra);
  } catch (error) {
    if (isNotModified(error)) return undefined;
    log.warn('Gagal mengubah pesan, mengirim pesan baru', { User: ctx.from?.id, Update: ctx.updateType }, error);
    return ctx.reply(text, extra);
  }
};

export const escapeHtml = (value = '') =>
  String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const ALLOWED_BUTTON_STYLES = new Set(['primary', 'danger', 'success']);
const styled = (button, style) =>
  ALLOWED_BUTTON_STYLES.has(style) ? { ...button, style } : button;
const idr = (value) => (value || 0).toLocaleString('id-ID');
const rp = (value) => `Rp ${idr(value)}`;
const code = (value) => `<code>${escapeHtml(value)}</code>`;
const HEADER_RULE = '╭────────────✧';
const FOOTER_RULE = '╰────────────✧';
const header = (title) => `${HEADER_RULE}\n┊ ${title}\n${FOOTER_RULE}\n\n`;

export const formatVcc = (data) => String(data || '').trim();

// ============================================================================
// 5. Text Formatters & Templating
// ============================================================================

export const formatWelcome = (appName = 'VCC Store Premium') =>
  `Selamat datang di <b>${escapeHtml(appName)}</b> — Layanan penyedia Virtual Credit Card otomatis, instan & terpercaya.\n\n` +
  `✦ <b>Keunggulan Layanan:</b>\n` +
  `• ⚡ <i>Proses Instan & Otomatis 24/7</i>\n` +
  `• 💳 <i>Hanya Digunakan Untuk Free Trial</i>\n` +
  `• 🪙 <i>Tersedia Banyak Varian Card</i>\n\n` +
  `<blockquote>Silakan pilih menu di bawah untuk mulai berbelanja atau melihat riwayat transaksi Anda.</blockquote>`;

export const formatMaintenance = (appName = 'VCC Store') =>
  header('🛠 𝗠𝗔𝗜𝗡𝗧𝗘𝗡𝗔𝗡𝗖𝗘 𝗠𝗢𝗗𝗘') +
  `<blockquote>Mohon maaf, sistem <b>${escapeHtml(appName)}</b> sedang dalam pemeliharaan berkala.</blockquote>\n\n` +
  `Saat ini pemesanan dinonaktifkan sementara untuk pengguna umum demi menjaga keamanan dan stabilitas sistem.\n\n` +
  `<i>Silakan coba beberapa saat lagi jika ada kendala.</i>`;

export const formatAccessDenied = () =>
  header('🔒 𝗔𝗞𝗦𝗘𝗦 𝗗𝗜𝗕𝗔𝗧𝗔𝗦𝗜') +
  `<blockquote>Kamu belum memiliki akses untuk berbelanja</blockquote>\n\n` +
  `<i>Klik tombol di bawah untuk meminta akses</i>`;

export const formatAccessPending = () =>
  header('⏳ 𝗣𝗘𝗥𝗠𝗜𝗡𝗧𝗔𝗔𝗡 𝗔𝗞𝗦𝗘𝗦') +
  `<blockquote>Permintaan akses kamu sedang diproses</blockquote>\n` +
  `<i>Mohon tunggu admin menyetujui</i>`;

export const formatAccessBlocked = () =>
  header('🚫 𝗔𝗞𝗦𝗘𝗦 𝗗𝗜𝗕𝗟𝗢𝗞𝗜𝗥') +
  `<blockquote>Akses kamu telah dihapus oleh admin</blockquote>`;

export const formatAccessRequested = () =>
  header('✅ 𝗣𝗘𝗥𝗠𝗜𝗡𝗧𝗔𝗔𝗡 𝗧𝗘𝗥𝗞𝗜𝗥𝗜𝗠') +
  `<blockquote>Permintaan akses terkirim</blockquote>\n` +
  `<i>Mohon tunggu admin menyetujui</i>`;

export const formatRequiredChannel = (channelDisplay = 'Channel Resmi') =>
  header('📢 𝗪𝗔𝗝𝗜𝗕 𝗚𝗔𝗕𝗨𝗡𝗚 𝗖𝗛𝗔𝗡𝗡𝗘𝗟') +
  `<blockquote>Untuk mengakses dan menggunakan layanan bot ini, Anda <b>wajib bergabung</b> ke channel resmi kami terlebih dahulu.</blockquote>\n\n` +
  `📌 <b>Channel:</b> <code>${escapeHtml(channelDisplay)}</code>\n\n` +
  `<i>Silakan klik tombol di bawah untuk bergabung, lalu klik <b>Saya Sudah Join</b>.</i>`;

export const formatKetentuan = () =>
  header('📜 𝗞𝗘𝗧𝗘𝗡𝗧𝗨𝗔𝗡 𝗟𝗔𝗬𝗔𝗡𝗔𝗡') +
  `Harap baca dan patuhi seluruh syarat & ketentuan penggunaan Virtual Credit Card (VCC):\n\n` +
  `<b>1. Batasan Penggunaan (Free Trial Only)</b>\n` +
  `VCC yang dibeli hanya diperbolehkan untuk aplikasi/cloud/platform yang mengadakan program <b>FREE TRIAL</b>.\n\n` +
  `<b>2. Larangan Menyedot Saldo</b>\n` +
  `VCC yang dibeli <b>TIDAK DIPERBOLEHKAN</b> untuk pembayaran/transaksi yang menyedot saldo.\n\n` +
  `<b>3. Kewajiban Ganti Rugi</b>\n` +
  `Jika saldo terdeteksi tersedot menggunakan VCC yang Anda beli, maka Anda <b>WAJIB mengganti rugi</b> saldo yang telah tersedot.\n\n` +
  `<b>4. Sanksi Pelanggaran</b>\n` +
  `Jika tidak ada itikad baik untuk mengganti rugi, maka dari pihak kami akan <b>memviralkan toko / identitas Anda</b> dan Anda akan menerima akibatnya.\n\n` +
  `<blockquote>⚠️ Dengan menggunakan layanan ini, Anda menyatakan setuju dan tunduk pada seluruh ketentuan di atas.</blockquote>`;

export const formatRequestAccessPrompt = () =>
  header('📜 𝗞𝗘𝗧𝗘𝗡𝗧𝗨𝗔𝗡 & 𝗠𝗜𝗡𝗧𝗔 𝗔𝗞𝗦𝗘𝗦') +
  `Sebelum meminta akses, Anda wajib membaca dan mematuhi ketentuan berikut:\n\n` +
  `1. <b>Free Trial Only:</b> VCC yang dibeli hanya diperbolehkan untuk aplikasi/cloud/platform yang mengadakan <b>FREE TRIAL</b>.\n` +
  `2. <b>Dilarang Menyedot Saldo:</b> VCC yang dibeli <b>TIDAK DIPERBOLEHKAN</b> untuk payment yang menyedot saldo.\n` +
  `3. <b>Kewajiban Ganti Rugi:</b> Jika saldo terdeteksi tersedot menggunakan VCC yang Anda beli, Anda <b>WAJIB mengganti rugi</b> saldo yang telah tersedot.\n` +
  `4. <b>Sanksi:</b> Jika tidak ada itikad baik, dari pihak kami akan <b>memviralkan toko Anda</b> dan akan menerima akibatnya.\n\n` +
  `<blockquote>⚠️ Dengan mengirimkan nomor WhatsApp, Anda menyatakan setuju pada seluruh ketentuan di atas.</blockquote>\n\n` +
  `📱 <b>Silakan kirim Nomor WhatsApp aktif Anda sekarang:</b>\n` +
  `<i>Ketik langsung nomor WhatsApp Anda pada chat ini (contoh: <code>081234567890</code> atau <code>6281234567890</code>).</i>`;

export const formatProductList = (products, displayBin = true) => {
  if (!products?.length) return '<blockquote>Tidak ada produk tersedia</blockquote>';

  const entries = products.map((product, index) => {
    let entry = `┊ 〔 ${index + 1} 〕<b>${escapeHtml(product.name)}</b>\n`;
    if (product.description) entry += `┊ 📝 <b>Deskripsi:</b> <i>${escapeHtml(product.description)}</i>\n`;
    entry += `┊ 💶 <b>Harga:</b> ${code(idr(product.price))}\n`;
    entry += `┊ 📦 <b>Stok:</b> ${code(product.stock || 0)}\n`;
    if (displayBin && product.bin) entry += `┊ 💳 <b>Bin:</b> ${code(product.bin)}\n`;
    return entry;
  });

  return `${header('🛍 𝗗𝗔𝗙𝗧𝗔𝗥 𝗣𝗥𝗢𝗗𝗨𝗞')}${HEADER_RULE}\n${entries.join('┊\n')}${FOOTER_RULE}`;
};

export const formatProductDetail = (product, displayBin = true) => {
  let text = `${HEADER_RULE}\n┊ <b>${escapeHtml(product.name)}</b>\n${FOOTER_RULE}\n\n`;
  if (product.description) text += `📝 <b>Deskripsi:</b> <i>${escapeHtml(product.description)}</i>\n`;
  text += `💶 <b>Harga:</b> ${code(rp(product.price))}\n`;
  if (displayBin && product.bin) text += `💳 <b>BIN:</b> ${code(product.bin)}\n`;
  text += `📦 <b>Stok:</b> ${code(product.stock)}\n\n`;
  text += `<blockquote>Pilih jumlah yang ingin dibeli (Maksimal 20 VCC per order)</blockquote>`;
  return text;
};

export const formatCustomQtyPrompt = (product, maxAllowed) =>
  header('🔢 𝗜𝗡𝗣𝗨𝗧 𝗝𝗨𝗠𝗟𝗔𝗛 𝗠𝗔𝗡𝗨𝗔𝗟') +
  `📦 <b>Produk:</b> ${escapeHtml(product.name)}\n` +
  `💶 <b>Harga Satuan:</b> ${code(rp(product.price))}\n` +
  `📦 <b>Stok Tersedia:</b> ${code(product.stock)}\n` +
  `🎯 <b>Maksimal Order:</b> ${code(`${maxAllowed} VCC`)}\n\n` +
  `<blockquote>Ketik jumlah VCC yang ingin Anda beli pada chat ini (1 - ${maxAllowed}):</blockquote>\n\n` +
  `<i>Maksimal 20 VCC per transaksi dan sesuai ketersediaan stok.</i>`;

export const formatOrderSummary = (product, quantity) =>
  header('🧾 𝗥𝗜𝗡𝗚𝗞𝗔𝗦𝗔𝗡 𝗣𝗘𝗦𝗔𝗡𝗔𝗡') +
  `📦 <b>Produk:</b> ${code(product.name)}\n` +
  `🛒 <b>Jumlah:</b> ${code(quantity)}\n` +
  `💰 <b>Harga Satuan:</b> ${code(idr(product.price))}\n` +
  `💶 <b>Total:</b> <b>${code(idr(product.price * quantity))}</b>\n\n` +
  `<blockquote>Konfirmasi untuk lanjut pembayaran</blockquote>`;

export const formatPaymentInfo = (payment, invoice) =>
  header('💰 𝗣𝗘𝗠𝗕𝗔𝗬𝗔𝗥𝗔𝗡') +
  `🧾 <b>Invoice:</b> ${code(invoice)}\n` +
  `🆔 <b>TrxID:</b> ${code(payment.trxid)}\n` +
  `🛒 <b>Jumlah:</b> ${code(rp(payment.amount))}\n` +
  `💸 <b>Biaya:</b> ${code(rp(payment.fee))}\n` +
  `💰 <b>Total:</b> <b>${code(rp(payment.total))}</b>\n` +
  `⏰ <b>Expired:</b> ${code(payment.expiredAt ?? '-')}\n\n` +
  `<blockquote>Scan QRIS untuk membayar</blockquote>`;

export const formatPaymentExpired = (trxid) =>
  header('⚠️ 𝗣𝗘𝗠𝗕𝗔𝗬𝗔𝗥𝗔𝗡 𝗞𝗔𝗗𝗔𝗟𝗨𝗔𝗥𝗦𝗔') +
  `🆔 <b>TrxID:</b> ${code(trxid)}\n\n` +
  `<blockquote>Invoice sudah kadaluarsa. Silakan buat pesanan baru.</blockquote>`;

export const formatDeliverySuccess = (invoice, product, cards) => {
  let text = header('✅ 𝗣𝗘𝗠𝗕𝗔𝗬𝗔𝗥𝗔𝗡 𝗦𝗨𝗞𝗦𝗘𝗦');
  text += `🧾 <b>Invoice:</b> ${code(invoice)}\n`;
  text += `📦 <b>Produk:</b> ${escapeHtml(product?.name || '-')}\n`;
  text += `🔢 <b>Jumlah:</b> ${code(`${cards.length} VCC`)}\n\n`;
  text += `💳 <b>Data VCC Anda:</b>\n`;
  cards.forEach((card, i) => {
    text += `   ${i + 1}. ${code(formatVcc(card))}\n`;
  });
  text += `\n<blockquote>🔒 Simpan data VCC Anda dengan aman dan jangan bagikan kepada siapa pun.</blockquote>\n\n`;
  text += `<i>Terima kasih atas pembelian Anda!</i>`;
  return text;
};

export const formatPaymentCancelled = (invoice, trxid) =>
  header('❌ 𝗣𝗘𝗠𝗕𝗔𝗬𝗔𝗥𝗔𝗡 𝗗𝗜𝗕𝗔𝗧𝗔𝗟𝗞𝗔𝗡') +
  `🧾 <b>Invoice:</b> ${code(invoice ?? '-')}\n` +
  `🆔 <b>TrxID:</b> ${code(trxid ?? '-')}\n\n` +
  `<blockquote>Pesanan telah dibatalkan atas permintaan Anda.</blockquote>`;

export const formatLeaderboard = (leaders = [], appName = 'VCC Store') => {
  let text = header('🏆 𝗧𝗢𝗣 𝟭𝟬 𝗟𝗘𝗔𝗗𝗘𝗥𝗕𝗢𝗔𝗥𝗗');
  text += `Peringkat pengguna dengan order terbanyak di <b>${escapeHtml(appName)}</b>:\n\n`;

  if (!leaders.length) {
    text += `<blockquote>Belum ada data transaksi yang tercatat.</blockquote>`;
    return text;
  }

  const medals = ['🥇', '🥈', '🥉'];
  leaders.forEach((u, i) => {
    const badge = medals[i] || `<b>${i + 1}.</b>`;
    const userTag = u.username
      ? `@${escapeHtml(u.username.replace(/^@/, ''))}`
      : escapeHtml(u.name || `User ${u.userId}`);
    text += `${badge} ${userTag} — <code>${u.orderCount} Order</code>\n`;
  });

  text += `\n<blockquote>Terima kasih kepada seluruh pelanggan setia atas kepercayaannya!</blockquote>`;
  return text;
};

export const formatReceipt = (order, productName) => {
  const cleanUser = order.username ? String(order.username).replace(/^@/, '').trim() : '';
  const userTag = cleanUser ? `@${escapeHtml(cleanUser)}` : '-';
  const prod = productName || order.productName || 'VCC';

  let text = header('🧾 𝗧𝗥𝗔𝗡𝗦𝗔𝗞𝗦𝗜 𝗕𝗘𝗥𝗛𝗔𝗦𝗜𝗟');
  text += `🧾 <b>Invoice:</b> ${code(order.invoice ?? '-')}\n`;
  text += `👤 <b>Username:</b> ${userTag}\n`;
  text += `📦 <b>Produk:</b> ${prod}\n`;
  text += `🔢 <b>Jumlah:</b> ${order.quantity ?? 1}\n`;
  text += `💰 <b>Total:</b> ${rp(order.total)}\n`;
  text += `🕐 <b>Waktu:</b> ${order.completedAt ?? '-'}\n\n`;
  text += `<blockquote>✨ Transaksi sukses! Terima kasih atas kepercayaannya.</blockquote>`;
  return text;
};

const STATUS_LABEL = {
  new: 'Belum request',
  pending: 'Menunggu persetujuan',
  whitelisted: 'Aktif',
  blocked: 'Diblokir'
};

export const formatMyInfo = (user, stats) => {
  let text = header('👤 𝗜𝗡𝗙𝗢 𝗔𝗞𝗨𝗡 𝗔𝗡𝗗𝗔');
  text += `${HEADER_RULE}\n`;
  text += `┊ 🆔 <b>ID Pengguna:</b> ${code(user.id)}\n`;
  text += `┊ 👤 <b>Nama:</b> ${code(user.firstName ?? '-')}\n`;
  if (user.username) text += `┊ 🔖 <b>Username:</b> ${code(`@${user.username}`)}\n`;
  if (user.phone) text += `┊ 📱 <b>WhatsApp:</b> ${code(user.phone)}\n`;
  text += `┊ ℹ️ <b>Status Akun:</b> ${code(user.status ?? 'new')} (${escapeHtml(STATUS_LABEL[user.status] ?? user.status)})\n`;
  if (user.addedAt) text += `┊ 🕐 <b>Terdaftar:</b> ${code(user.addedAt)}\n`;
  text += `┊\n`;
  text += `┊ 📊 <b>Statistik Transaksi:</b>\n`;
  text += `┊ 🧾 <b>Total Order:</b> ${code(stats.count)}\n`;
  text += `┊ ✅ <b>Order Sukses:</b> ${code(stats.completed)}\n`;
  text += `┊ 💰 <b>Total Belanja:</b> ${code(rp(stats.total))}\n`;
  text += `${FOOTER_RULE}`;
  return text;
};

export const formatRiwayat = (user, orders, totalOrders, page, totalPages, pageSize) => {
  let text = header('🧾 𝗥𝗜𝗪𝗔𝗬𝗔𝗧 𝗧𝗥𝗔𝗡𝗦𝗔𝗞𝗦𝗜 𝗨𝗦𝗘𝗥');
  text += `👤 <b>User:</b> ${code(user.firstName ?? '-')} (${code(user.id)})\n`;
  text += `🧾 <b>Total Transaksi:</b> ${code(totalOrders)}\n\n`;

  if (!orders.length) return `${text}<blockquote>Tidak ada transaksi</blockquote>`;

  orders.forEach((order, index) => {
    text += `〔 ${page * pageSize + index + 1} 〕<b>${escapeHtml(order.productName ?? '-')}</b>\n`;
    text += `   🧾 Invoice: ${code(order.invoice ?? '-')}\n`;
    text += `   🆔 TrxID: ${code(order.trxid ?? '-')}\n`;
    text += `   🔢 Qty: ${code(order.quantity)} • 💰 ${code(rp(order.total))}\n`;
    text += `   ℹ️ Status: ${code(order.status ?? '-')}\n`;
    text += `   🕐 ${code(order.createdAt ?? '-')}\n\n`;
  });

  return `${text}Halaman ${code(`${page + 1}/${totalPages}`)}`;
};

// ============================================================================
// 6. Inline Keyboards
// ============================================================================

export const startKeyboard = () => Markup.inlineKeyboard([
  [
    styled(Markup.button.callback('🛍️ Beli Produk', 'view_products'), 'primary'),
    styled(Markup.button.callback('📜 Riwayat Transaksi', 'riwayat'), 'primary')
  ],
  [
    styled(Markup.button.callback('📜 Ketentuan Layanan', 'ketentuan'), 'danger')
  ],
  [
    styled(Markup.button.callback('🏆 Leaderboard', 'leaderboard'), 'success')
  ]
]);

export const requiredChannelKeyboard = (channelUrl) => Markup.inlineKeyboard([
  [Markup.button.url('📢 Gabung Channel', channelUrl || 'https://t.me')],
  [styled(Markup.button.callback('🔄 Saya Sudah Join', 'check_join'), 'primary')]
]);

export const accessKeyboard = () => Markup.inlineKeyboard([
  [styled(Markup.button.callback('🚪 Minta Akses', 'request_access'), 'primary')],
  [Markup.button.callback('📜 Ketentuan Layanan', 'ketentuan')]
]);

export const emptyKeyboard = () => Markup.inlineKeyboard([]);

export const maintenanceKeyboard = () => Markup.inlineKeyboard([
  [styled(Markup.button.callback('🔙 Kembali ke Menu Utama', 'start'), 'primary')]
]);

export const ketentuanKeyboard = () => Markup.inlineKeyboard([
  [styled(Markup.button.callback('« Kembali ke Menu Utama', 'start'), 'primary')]
]);

export const requestAccessCancelKeyboard = () => Markup.inlineKeyboard([
  [Markup.button.callback('❌ Batal', 'cancel_access')]
]);

export const productListKeyboard = (products) => {
  const rows = [];
  for (let i = 0; i < products.length; i += 4) {
    rows.push(
      products.slice(i, i + 4).map((product, j) =>
        styled(Markup.button.callback(String(i + j + 1), `buy_${product.id}`), 'primary')
      )
    );
  }
  rows.push([Markup.button.callback('« Kembali', 'start')]);
  return Markup.inlineKeyboard(rows);
};

export const customQtyCancelKeyboard = (productId, currentQty = 1) => Markup.inlineKeyboard([
  [Markup.button.callback('❌ Batal', `qty_${productId}_${currentQty}`)]
]);

export const productDetailKeyboard = (productId, qty, stock = 1) => {
  const maxAllowed = Math.min(MAX_ORDER_QUANTITY, Math.max(1, stock));
  const currentQty = Math.max(1, Math.min(qty, maxAllowed));

  return Markup.inlineKeyboard([
    [
      Markup.button.callback('–', `qty_${productId}_${Math.max(1, currentQty - 1)}`),
      Markup.button.callback(`${currentQty} Pcs`, `custom_qty_${productId}`),
      Markup.button.callback('+', `qty_${productId}_${Math.min(maxAllowed, currentQty + 1)}`)
    ],
    [
      Markup.button.callback('✏️ Custom Pcs', `custom_qty_${productId}`)
    ],
    [
      styled(Markup.button.callback(`🛒 Beli ${currentQty} Pcs`, `confirm_${productId}_${currentQty}`), 'primary')
    ],
    [
      Markup.button.callback('« Kembali ke Katalog', 'view_products')
    ]
  ]);
};

export const confirmKeyboard = (productId, qty) => Markup.inlineKeyboard([
  [styled(Markup.button.callback('✅ Lanjut Bayar', `pay_${productId}_${qty}`), 'success')],
  [Markup.button.callback('« Kembali', 'view_products')]
]);

export const paymentKeyboard = (qrisUrl, trxid) => Markup.inlineKeyboard([
  [Markup.button.url('📱 Lihat QRIS', qrisUrl)],
  [
    styled(Markup.button.callback('⟳ Cek Status', `check_${trxid}`), 'primary'),
    styled(Markup.button.callback('« Batal', `cancel_${trxid}`), 'danger')
  ]
]);

export const cancelledKeyboard = () => Markup.inlineKeyboard([
  [styled(Markup.button.callback('🛍️ Beli Produk Lain', 'view_products'), 'primary')],
  [Markup.button.callback('« Menu Utama', 'start')]
]);

export const leaderboardKeyboard = () => Markup.inlineKeyboard([
  [styled(Markup.button.callback('« Kembali ke Menu Utama', 'start'), 'primary')]
]);

export const riwayatKeyboard = (page, totalPages) => {
  const nav = [];
  if (page > 0) nav.push(Markup.button.callback('« Prev', `mytrx_${page - 1}`));
  if (page < totalPages - 1) nav.push(Markup.button.callback('Next »', `mytrx_${page + 1}`));

  const rows = nav.length ? [nav] : [];
  rows.push([Markup.button.callback('« Kembali', 'start')]);
  return Markup.inlineKeyboard(rows);
};
