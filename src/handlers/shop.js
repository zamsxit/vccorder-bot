import { getProduct, getProducts, getUser, getOrdersByUser } from '../database.js';
import { getGlobalSettings } from '../settings.js';
import {
  requireAccess,
  isOwner,
  createLogger,
  html,
  showScreen,
  parseProductAction,
  parseSuffix,
  parsePage,
  formatProductList,
  formatProductDetail,
  formatCustomQtyPrompt,
  formatOrderSummary,
  formatMaintenance,
  formatRiwayat,
  productListKeyboard,
  productDetailKeyboard,
  customQtyCancelKeyboard,
  confirmKeyboard,
  maintenanceKeyboard,
  riwayatKeyboard,
  MAX_ORDER_QUANTITY
} from '../utils.js';

const log = createLogger('BOT');
const PAGE_SIZE = 5;

export const awaitingCustomQty = new Map();

// ============================================================================
// Catalog & Purchasing Handlers
// ============================================================================

const showProduct = async (ctx, product, quantity, displayBin) => {
  const maxAllowed = Math.min(MAX_ORDER_QUANTITY, product.stock);
  const safeQty = Math.max(1, Math.min(quantity, maxAllowed));
  return showScreen(
    ctx,
    formatProductDetail(product, displayBin),
    productDetailKeyboard(product.id, safeQty, product.stock)
  );
};

const checkMaintenance = async (ctx) => {
  const settings = await getGlobalSettings();
  if (settings.maintenanceMode && !isOwner(ctx.from?.id)) {
    await showScreen(ctx, formatMaintenance(settings.appName), maintenanceKeyboard());
    return false;
  }
  return true;
};

export const viewProductsAction = async (ctx) => {
  await ctx.answerCbQuery();
  awaitingCustomQty.delete(ctx.from?.id);
  if (!(await requireAccess(ctx))) return;
  if (!(await checkMaintenance(ctx))) return;

  const [products, settings] = await Promise.all([getProducts(), getGlobalSettings()]);
  await showScreen(ctx, formatProductList(products, settings.displayBin), productListKeyboard(products));
};

export const buyProductAction = async (ctx) => {
  await ctx.answerCbQuery();
  awaitingCustomQty.delete(ctx.from?.id);
  if (!(await requireAccess(ctx))) return;
  if (!(await checkMaintenance(ctx))) return;

  const [product, settings] = await Promise.all([
    getProduct(parseSuffix(ctx.callbackQuery.data, 'buy')),
    getGlobalSettings()
  ]);
  log.debug('Produk dibuka', { User: ctx.from.id, Produk: product?.id, Stok: product?.stock ?? 0 });

  if (!product) return ctx.reply('<b>Produk tidak ditemukan</b>', html());
  if (!product.stock) return ctx.reply('<b>Stok habis</b>', html());

  await showProduct(ctx, product, 1, settings.displayBin);
};

export const updateQuantityAction = async (ctx) => {
  await ctx.answerCbQuery();
  awaitingCustomQty.delete(ctx.from?.id);
  if (!(await requireAccess(ctx))) return;
  if (!(await checkMaintenance(ctx))) return;

  const action = parseProductAction(ctx.callbackQuery.data, 'qty');
  const [product, settings] = await Promise.all([
    action && getProduct(action.productId),
    getGlobalSettings()
  ]);
  if (!product) return ctx.reply('<b>Produk tidak ditemukan</b>', html());
  if (!product.stock) return ctx.reply('<b>Stok habis</b>', html());

  const maxAllowed = Math.min(MAX_ORDER_QUANTITY, product.stock);
  const targetQty = Math.max(1, Math.min(action.quantity ?? 1, maxAllowed));

  await showProduct(ctx, product, targetQty, settings.displayBin);
};

export const customQtyAction = async (ctx) => {
  await ctx.answerCbQuery();
  if (!(await requireAccess(ctx))) return;
  if (!(await checkMaintenance(ctx))) return;

  const productId = parseSuffix(ctx.callbackQuery.data, 'custom_qty');
  const product = productId ? await getProduct(productId) : null;

  if (!product || !product.stock) {
    awaitingCustomQty.delete(ctx.from.id);
    return ctx.reply('<b>Produk tidak tersedia atau stok habis</b>', html());
  }

  const maxAllowed = Math.min(MAX_ORDER_QUANTITY, product.stock);
  awaitingCustomQty.set(ctx.from.id, { productId: product.id, currentQty: 1 });

  await showScreen(
    ctx,
    formatCustomQtyPrompt(product, maxAllowed),
    customQtyCancelKeyboard(product.id, 1)
  );
};

export const handleCustomQtyText = async (ctx, next) => {
  const userId = ctx.from?.id;
  if (!userId || !awaitingCustomQty.has(userId)) return next();

  const text = ctx.message?.text?.trim() || '';
  if (text.startsWith('/')) {
    awaitingCustomQty.delete(userId);
    return next();
  }

  const state = awaitingCustomQty.get(userId);
  const qty = Number.parseInt(text, 10);
  const product = await getProduct(state.productId);

  if (!product || !product.stock) {
    awaitingCustomQty.delete(userId);
    return ctx.reply('<b>Produk tidak tersedia atau stok habis.</b>', html());
  }

  const maxAllowed = Math.min(MAX_ORDER_QUANTITY, product.stock);

  if (!Number.isInteger(qty) || qty < 1) {
    return ctx.reply(
      '⚠️ <b>Jumlah tidak valid.</b>\n\n' +
      `Silakan masukkan angka bulat positif antara 1 sampai ${maxAllowed} (contoh: <code>5</code>):`,
      html(customQtyCancelKeyboard(product.id, state.currentQty))
    );
  }

  if (qty > MAX_ORDER_QUANTITY) {
    return ctx.reply(
      `⚠️ <b>Maksimal pembelian adalah ${MAX_ORDER_QUANTITY} VCC per transaksi.</b>\n\n` +
      `Silakan masukkan angka antara 1 sampai ${maxAllowed}:`,
      html(customQtyCancelKeyboard(product.id, state.currentQty))
    );
  }

  if (qty > product.stock) {
    return ctx.reply(
      `⚠️ <b>Stok tidak mencukupi.</b>\n\n` +
      `Saat ini stok tersedia hanya <b>${product.stock} VCC</b>. Silakan masukkan angka 1 sampai ${maxAllowed}:`,
      html(customQtyCancelKeyboard(product.id, state.currentQty))
    );
  }

  awaitingCustomQty.delete(userId);
  const settings = await getGlobalSettings();

  await ctx.reply(
    formatProductDetail(product, settings.displayBin),
    html(productDetailKeyboard(product.id, qty, product.stock))
  );
};

export const confirmOrderAction = async (ctx) => {
  await ctx.answerCbQuery();
  awaitingCustomQty.delete(ctx.from?.id);
  if (!(await requireAccess(ctx))) return;
  if (!(await checkMaintenance(ctx))) return;

  const action = parseProductAction(ctx.callbackQuery.data, 'confirm');
  const product = action?.productId && (await getProduct(action.productId));
  if (!product) {
    return ctx.reply('<b>Produk tidak ditemukan</b>', html());
  }

  const qty = action.quantity;
  if (!qty || qty < 1 || qty > MAX_ORDER_QUANTITY) {
    return ctx.reply(
      `<b>Jumlah pesanan tidak valid (maksimal ${MAX_ORDER_QUANTITY} VCC per transaksi)</b>`,
      html()
    );
  }

  if (product.stock < qty) {
    return ctx.reply(`<b>Stok tidak mencukupi. Stok tersedia: ${product.stock}</b>`, html());
  }

  await showScreen(ctx, formatOrderSummary(product, qty), confirmKeyboard(product.id, qty));
};

// ============================================================================
// Order History Handlers
// ============================================================================

const buildHistoryScreen = async (userId, requestedPage) => {
  const [user, { orders, total, page, totalPages }] = await Promise.all([
    getUser(userId),
    getOrdersByUser(userId, { page: requestedPage, pageSize: PAGE_SIZE })
  ]);

  return {
    text: formatRiwayat(user ?? { id: userId, firstName: 'Customer' }, orders, total, page, totalPages, PAGE_SIZE),
    keyboard: riwayatKeyboard(page, totalPages)
  };
};

export const riwayatCommand = async (ctx) => {
  log.debug('Perintah /riwayat', { User: ctx.from.id });
  if (!(await requireAccess(ctx))) return;

  const { text, keyboard } = await buildHistoryScreen(ctx.from.id, 0);
  await ctx.reply(text, html(keyboard));
};

const openHistoryPage = async (ctx, page) => {
  await ctx.answerCbQuery();
  awaitingCustomQty.delete(ctx.from?.id);
  if (!(await requireAccess(ctx))) return;

  const { text, keyboard } = await buildHistoryScreen(ctx.from.id, page);
  await showScreen(ctx, text, keyboard);
};

export const riwayatAction = (ctx) => openHistoryPage(ctx, 0);

export const riwayatPageAction = (ctx) =>
  openHistoryPage(ctx, parsePage(parseSuffix(ctx.callbackQuery.data, 'mytrx')));
