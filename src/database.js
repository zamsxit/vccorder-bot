import crypto from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import ws from 'ws';

try {
  process.loadEnvFile();
} catch {}

/**
 * Supabase client instance.
 * Configured for persistent session-less server operation with websocket transport for realtime.
 */
export const supabase = createClient(
  process.env.SUPABASE_URL || 'https://placeholder.supabase.co',
  process.env.SUPABASE_KEY || 'placeholder',
  {
    auth: { persistSession: false },
    realtime: { transport: ws }
  }
);

const fail = (error, action) => {
  throw new Error(`[db] ${action}: ${error.message}`);
};

// ============================================================================
// Entity Mappers
// ============================================================================

const mapProduct = (row, stock) => ({
  id: row.id,
  name: row.name,
  description: row.description,
  price: row.price,
  bin: row.bin,
  sold: row.sold ?? 0,
  stock
});

const mapOrder = (row) => ({
  id: row.id,
  invoice: row.invoice,
  trxid: row.trxid,
  userId: row.user_id,
  userName: row.user_name,
  username: row.username,
  productId: row.product_id,
  productName: row.product_name,
  quantity: row.quantity,
  total: row.total,
  status: row.status,
  createdAt: row.created_at,
  completedAt: row.completed_at,
  deliveredStocks: row.delivered_stocks ?? [],
  deliveredData: row.delivered_data ?? [],
  deliveredAt: row.delivered_at,
  receiptSent: row.receipt_sent
});

const mapUser = (row) => ({
  id: row.id,
  firstName: row.first_name,
  username: row.username,
  phone: row.phone,
  status: row.status,
  addedAt: row.added_at,
  requestedAt: row.requested_at,
  approvedAt: row.approved_at
});

// ============================================================================
// Products & Stock Queries
// ============================================================================

const countStock = async (productId) => {
  const { count, error } = await supabase
    .from('stocks')
    .select('*', { count: 'exact', head: true })
    .eq('product_id', productId);
  if (error) fail(error, 'countStock');
  return count ?? 0;
};

export const getProducts = async () => {
  const { data, error } = await supabase
    .from('products')
    .select('*')
    .order('created_at', { ascending: false });
  if (error) fail(error, 'getProducts');

  return Promise.all((data ?? []).map(async (row) => mapProduct(row, await countStock(row.id))));
};

export const getProduct = async (id) => {
  const { data, error } = await supabase
    .from('products')
    .select('*')
    .eq('id', id)
    .maybeSingle();
  if (error) fail(error, 'getProduct');
  return data ? mapProduct(data, await countStock(id)) : null;
};

// ============================================================================
// Orders & Fulfillment Queries
// ============================================================================

export const createOrder = async (order) => {
  const row = {
    id: crypto.randomUUID(),
    invoice: order.invoice,
    trxid: order.trxid,
    user_id: order.userId,
    user_name: order.userName,
    username: order.username,
    product_id: order.productId,
    product_name: order.productName,
    quantity: order.quantity,
    total: order.total,
    status: 'pending',
    delivered_stocks: [],
    delivered_data: []
  };

  const { data, error } = await supabase
    .from('orders')
    .insert(row)
    .select()
    .single();
  if (error) fail(error, 'createOrder');
  return mapOrder(data);
};

export const getOrder = async (key) => {
  const byTrxid = await supabase.from('orders').select('*').eq('trxid', key).maybeSingle();
  if (byTrxid.error) fail(byTrxid.error, 'getOrder');
  if (byTrxid.data) return mapOrder(byTrxid.data);

  const byInvoice = await supabase.from('orders').select('*').eq('invoice', key).maybeSingle();
  if (byInvoice.error) fail(byInvoice.error, 'getOrder');
  return byInvoice.data ? mapOrder(byInvoice.data) : null;
};

export const getOrdersByUser = async (userId, { page = 0, pageSize = 5 } = {}) => {
  const counted = await supabase.from('orders').select('*', { count: 'exact', head: true }).eq('user_id', userId);
  if (counted.error) fail(counted.error, 'getOrdersByUser.count');

  const total = counted.count ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const safePage = Math.min(Math.max(page, 0), totalPages - 1);
  if (!total) return { orders: [], total, page: safePage, totalPages };

  const from = safePage * pageSize;
  const { data, error } = await supabase
    .from('orders')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .range(from, from + pageSize - 1);
  if (error) fail(error, 'getOrdersByUser');

  return { orders: data.map(mapOrder), total, page: safePage, totalPages };
};

export const getUserOrderStats = async (userId) => {
  const { data, error } = await supabase.from('orders').select('status, total').eq('user_id', userId);
  if (error) fail(error, 'getUserOrderStats');

  const orders = data ?? [];
  const completed = orders.filter((o) => o.status === 'completed');

  return {
    count: orders.length,
    completed: completed.length,
    total: completed.reduce((sum, o) => sum + (o.total ?? 0), 0)
  };
};

export const fulfillOrder = async ({ key, amount }) => {
  const order = await getOrder(key);
  if (!order) return { success: false, reason: 'not_found' };

  if (order.status === 'completed') {
    return {
      success: true,
      alreadyCompleted: true,
      order,
      stockIds: order.deliveredStocks,
      cardData: order.deliveredData
    };
  }
  if (order.status !== 'pending') return { success: false, reason: 'closed', order };

  const qty = order.quantity || 1;
  const stocks = await supabase
    .from('stocks')
    .select('id, data')
    .eq('product_id', order.productId)
    .order('added_at', { ascending: true })
    .limit(qty);
  if (stocks.error) fail(stocks.error, 'fulfillOrder.stocks');

  if (!stocks.data || stocks.data.length < qty) {
    await failOrder(order.id);
    return { success: false, reason: 'insufficient_stock', order };
  }

  const stockIds = stocks.data.map((s) => String(s.id));
  const cardData = stocks.data.map((s) => String(s.data));
  const now = new Date().toISOString();

  const { data: updated, error: updateError } = await supabase
    .from('orders')
    .update({
      status: 'completed',
      total: amount ?? order.total,
      delivered_stocks: stockIds,
      delivered_data: cardData,
      completed_at: now,
      updated_at: now
    })
    .eq('id', order.id)
    .eq('status', 'pending')
    .select()
    .maybeSingle();
  if (updateError) fail(updateError, 'fulfillOrder.update');
  if (!updated) return { success: false, reason: 'race_condition' };

  if (!(await isRecorded(order.id, qty))) {
    return { success: false, reason: 'record_failed', order: mapOrder(updated) };
  }

  return { success: true, order: mapOrder(updated), stockIds, cardData };
};

const isRecorded = async (orderId, expectedCount) => {
  const { data, error } = await supabase
    .from('orders')
    .select('delivered_stocks, delivered_data')
    .eq('id', orderId)
    .maybeSingle();
  if (error) fail(error, 'isRecorded');

  const stocks = data?.delivered_stocks?.length ?? 0;
  const cards = data?.delivered_data?.length ?? 0;
  return stocks === expectedCount && cards === expectedCount;
};

const chunk = (items, size = 100) => {
  const batches = [];
  for (let i = 0; i < items.length; i += size) batches.push(items.slice(i, i + size));
  return batches;
};

const deleteStocks = async (stockIds) => {
  if (!stockIds?.length) return [];
  const deleted = [];
  for (const batch of chunk(stockIds)) {
    const { data, error } = await supabase.from('stocks').delete().in('id', batch).select('id');
    if (error) fail(error, 'deleteStocks');
    deleted.push(...(data ?? []).map((row) => String(row.id)));
  }
  return deleted;
};

const findRemainingStocks = async (stockIds) => {
  if (!stockIds?.length) return [];
  const remaining = [];
  for (const batch of chunk(stockIds)) {
    const { data, error } = await supabase.from('stocks').select('id').in('id', batch);
    if (error) fail(error, 'findRemainingStocks');
    remaining.push(...(data ?? []).map((row) => String(row.id)));
  }
  return remaining;
};

export const deleteOrderStocks = async (stockIds, { attempts = 3 } = {}) => {
  let remaining = [...(stockIds ?? [])];
  for (let attempt = 1; attempt <= attempts && remaining.length > 0; attempt++) {
    await deleteStocks(remaining);
    remaining = await findRemainingStocks(remaining);
  }
  return { deleted: (stockIds ?? []).filter((id) => !remaining.includes(id)), remaining };
};

export const reconcileSoldStocks = async ({ sinceHours = 24 } = {}) => {
  const since = new Date(Date.now() - sinceHours * 3600 * 1000).toISOString();
  const { data, error } = await supabase
    .from('orders')
    .select('id, invoice, product_id, delivered_stocks')
    .eq('status', 'completed')
    .gte('completed_at', since);
  if (error) fail(error, 'reconcileSoldStocks.orders');

  const sold = (data ?? []).flatMap((order) =>
    (order.delivered_stocks ?? []).map((stockId) => ({ stockId: String(stockId), order }))
  );
  if (!sold.length) return { orders: 0, deleted: 0, products: [] };

  const alive = await findRemainingStocks(sold.map((entry) => entry.stockId));
  if (!alive.length) return { orders: 0, deleted: 0, products: [] };

  const { deleted } = await deleteOrderStocks(alive);
  const products = [...new Set(
    sold.filter((entry) => alive.includes(entry.stockId)).map((entry) => entry.order.product_id)
  )];

  for (const productId of products) {
    await refreshProductCounters(productId);
  }

  return { orders: sold.filter((e) => alive.includes(e.stockId)).length, deleted: deleted.length, products };
};

const updateRows = async (table, values, match, action) => {
  let query = supabase.from(table).update({ ...values, updated_at: new Date().toISOString() });
  for (const [column, value] of Object.entries(match)) query = query.eq(column, value);
  const { error } = await query;
  if (error) fail(error, action);
};

export const refreshProductCounters = async (productId) => {
  const orders = await supabase
    .from('orders')
    .select('quantity')
    .eq('product_id', productId)
    .eq('status', 'completed');
  if (orders.error) fail(orders.error, 'refreshProductCounters.orders');

  const sold = (orders.data ?? []).reduce((sum, o) => sum + (o.quantity ?? 0), 0);
  await updateRows('products', { stock: await countStock(productId), sold }, { id: productId }, 'refreshProductCounters');
};

export const markDelivered = (orderId) =>
  updateRows('orders', { delivered_at: new Date().toISOString() }, { id: orderId }, 'markDelivered');

export const markReceiptSent = (orderId) =>
  updateRows('orders', { receipt_sent: new Date().toISOString() }, { id: orderId }, 'markReceiptSent');

export const getStalePendingOrders = async (maxAgeMinutes = 15) => {
  const cutoff = new Date(Date.now() - maxAgeMinutes * 60 * 1000).toISOString();
  const { data, error } = await supabase
    .from('orders')
    .select('*')
    .eq('status', 'pending')
    .lte('created_at', cutoff);
  if (error) fail(error, 'getStalePendingOrders');
  return (data ?? []).map(mapOrder);
};

export const failOrder = (orderId) =>
  updateRows('orders', { status: 'failed' }, { id: orderId, status: 'pending' }, 'failOrder');

// ============================================================================
// User & Access Control Queries
// ============================================================================

export const getUser = async (id) => {
  const { data, error } = await supabase.from('users').select('*').eq('id', id).maybeSingle();
  if (error) fail(error, 'getUser');
  return data ? mapUser(data) : null;
};

export const getUserStatus = async (id) => (await getUser(id))?.status ?? 'new';

export const getAllUsers = async () => {
  const { data, error } = await supabase.from('users').select('id');
  if (error) fail(error, 'getAllUsers');
  return data ?? [];
};

export const upsertUser = async ({ id, firstName, username }) => {
  const { error } = await supabase.from('users').upsert(
    { id, first_name: firstName, username, status: 'new', added_at: new Date().toISOString() },
    { onConflict: 'id', ignoreDuplicates: true }
  );
  if (error) fail(error, 'upsertUser');
};

export const requestAccess = async (id, phone = null, extra = {}) => {
  const user = await getUser(id);
  if (user?.status === 'whitelisted') return 'whitelisted';
  if (user?.status === 'pending') return 'pending';

  const now = new Date().toISOString();
  const payload = {
    id,
    status: 'pending',
    requested_at: now,
    updated_at: now,
    ...(phone ? { phone } : {}),
    ...(extra.firstName ? { first_name: extra.firstName } : {}),
    ...(extra.username ? { username: extra.username } : {})
  };

  const { error } = await supabase
    .from('users')
    .upsert(payload, { onConflict: 'id' });
  if (error) fail(error, 'requestAccess');

  return 'requested';
};

// ============================================================================
// Settings & Analytics Queries
// ============================================================================

export const getSettings = async () => {
  const { data, error } = await supabase.from('settings').select('key, value');
  if (error) fail(error, 'getSettings');

  const settings = {};
  for (const row of data ?? []) settings[row.key] = row.value;
  return settings;
};

export const getLeaderboard = async (limit = 10) => {
  const { data, error } = await supabase
    .from('orders')
    .select('user_id, username, user_name')
    .eq('status', 'completed');
  if (error) fail(error, 'getLeaderboard');

  const userMap = new Map();
  for (const row of data ?? []) {
    const key = String(row.user_id);
    const existing = userMap.get(key) || {
      userId: row.user_id,
      username: row.username,
      name: row.user_name,
      orderCount: 0
    };
    existing.orderCount += 1;
    if (!existing.username && row.username) existing.username = row.username;
    userMap.set(key, existing);
  }

  return Array.from(userMap.values())
    .sort((a, b) => b.orderCount - a.orderCount)
    .slice(0, limit);
};
