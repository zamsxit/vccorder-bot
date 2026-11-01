import { getSettings as fetchRawSettings } from './database.js';

export const cleanStringSetting = (val, fallback = '') => {
  if (val === null || val === undefined) return fallback;
  let s = String(val).trim();
  while ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    s = s.slice(1, -1).trim();
  }
  return s || fallback;
};

export const cleanBoolSetting = (val, fallback = false) => {
  if (typeof val === 'boolean') return val;
  if (val === null || val === undefined) return fallback;
  const s = String(val).trim().toLowerCase().replace(/^["']|["']$/g, '');
  if (s === 'true' || s === '1') return true;
  if (s === 'false' || s === '0') return false;
  return fallback;
};

export const parseSettings = (raw = {}) => {
  const req = raw.requiredChannel ?? raw.mustJoinChannel;
  const requiredChannel = req !== undefined
    ? (cleanStringSetting(req, '') === 'none' || cleanStringSetting(req, '') === 'off' ? '' : cleanStringSetting(req, ''))
    : cleanStringSetting(raw.channelInfo, process.env.REQUIRED_CHANNEL || process.env.LOG_CHANNEL || '');

  return {
    appName: cleanStringSetting(raw.appName, 'VCC Order Bot'),
    channelInfo: cleanStringSetting(raw.channelInfo, process.env.LOG_CHANNEL || ''),
    requiredChannel,
    displayBin: cleanBoolSetting(raw.displayBin, false),
    maintenanceMode: cleanBoolSetting(raw.maintenanceMode, false),
    raw
  };
};

let cachedSettings = parseSettings({});
let lastFetch = 0;
const CACHE_TTL_MS = 10000;

export const getGlobalSettings = async (forceRefresh = false) => {
  const now = Date.now();
  if (!forceRefresh && (now - lastFetch < CACHE_TTL_MS)) {
    return cachedSettings;
  }
  try {
    const raw = await fetchRawSettings();
    cachedSettings = parseSettings(raw);
    lastFetch = now;
  } catch (error) {
    // If DB query fails, fall back to current cached settings
  }
  return cachedSettings;
};
