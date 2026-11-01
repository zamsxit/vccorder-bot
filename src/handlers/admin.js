import { getAllUsers } from '../database.js';
import { isOwner, createLogger, html } from '../utils.js';

const log = createLogger('BOT');
const SEND_DELAY_MS = 50;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Build a send function for the replied message, or for plain text. */
const buildSender = (replied, text) => {
  if (replied?.photo) {
    const fileId = replied.photo.at(-1).file_id;
    const caption = replied.caption || text || undefined;
    return (telegram, chatId) => telegram.sendPhoto(chatId, fileId, { caption });
  }
  if (replied?.video) {
    const caption = replied.caption || text || undefined;
    return (telegram, chatId) => telegram.sendVideo(chatId, replied.video.file_id, { caption });
  }
  if (replied?.document) {
    const caption = replied.caption || text || undefined;
    return (telegram, chatId) => telegram.sendDocument(chatId, replied.document.file_id, { caption });
  }
  const content = replied?.text || text;
  return content ? (telegram, chatId) => telegram.sendMessage(chatId, content) : null;
};

export const broadcastCommand = async (ctx) => {
  if (!isOwner(ctx.from.id)) return ctx.reply('<b>Akses ditolak</b>', html());

  const replied = ctx.message.reply_to_message;
  const text = ctx.message.text.split(/\s+/).slice(1).join(' ').trim();

  if (!replied && !text) {
    return ctx.reply(
      '<b>Cara pakai:</b>\n<code>/broadcast [pesan]</code>\n\n<i>Atau reply pesan/gambar lalu /broadcast</i>',
      html()
    );
  }

  const send = buildSender(replied, text);
  if (!send) return ctx.reply('<b>Jenis pesan tidak didukung</b>', html());

  const users = await getAllUsers();
  if (!users.length) return ctx.reply('<b>Tidak ada pengguna terdaftar</b>', html());

  log.info('Broadcast dimulai', { Owner: ctx.from.id, Penerima: users.length });
  await ctx.reply(`<b>🔊 Memulai broadcast ke ${users.length} pengguna...</b>`, html());

  let success = 0;
  let failed = 0;

  for (const user of users) {
    try {
      await send(ctx.telegram, user.id);
      success += 1;
    } catch {
      failed += 1;
    }
    await sleep(SEND_DELAY_MS);
  }

  log.info('Broadcast selesai', { Berhasil: success, Gagal: failed, Total: users.length });

  await ctx.reply(
    `<b>✅ Broadcast Selesai</b>\n━━━\n\n` +
    `<b>Berhasil:</b> <code>${success}</code> dari <code>${users.length}</code>\n` +
    `<b>Gagal:</b> <code>${failed}</code>`,
    html()
  );
};
