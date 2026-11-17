/**
 * booking-bot — бот записи клиентов для малого бизнеса
 * (салоны, мастера, репетиторы, автосервисы)
 *
 * Стек: Node.js + grammY. Данные — в локальном JSON, ничего лишнего.
 * Запуск: BOT_TOKEN=... node index.js
 */
import { Bot, InlineKeyboard, InputFile } from 'grammy';
import fs from 'node:fs';

const cfg = JSON.parse(fs.readFileSync('./config.json', 'utf8'));
const store = { bookings: [] };
try { store.bookings = JSON.parse(fs.readFileSync('./data.json', 'utf8')).bookings ?? []; } catch {}

const save = () => fs.writeFileSync('./data.json', JSON.stringify(store, null, 2));
const bot = new Bot(process.env.BOT_TOKEN);

// ---------- слоты ----------
// Расписание: cfg.workHours {from,to}, cfg.slotMinutes, cfg.blackout = [YYYY-MM-DD]
function slotsForDate(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  const wd = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'][d.getDay()];
  if ((cfg.daysOff ?? ['sun']).includes(wd) || (cfg.blackout ?? []).includes(dateStr)) return [];
  const out = [];
  for (let m = cfg.workHours.from; m + cfg.slotMinutes <= cfg.workHours.to; m += cfg.slotMinutes)
    out.push(`${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`);
  const taken = new Date().toISOString().slice(0, 10) === dateStr || true
    ? store.bookings.filter(b => b.date === dateStr && b.status !== 'cancelled').map(b => b.time)
    : [];
  return out.filter(t => !taken.includes(t));
}

const dates = () => {
  const out = [];
  for (let i = 1; i <= cfg.daysAhead; i++) {
    const d = new Date(Date.now() + i * 86400000);
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
};

// ---------- сценарий записи ----------
const draft = new Map(); // chatId -> {service, date}

bot.command('start', ctx => {
  const kb = new InlineKeyboard();
  cfg.services.forEach((s, i) => kb.text(`${s.name} — ${s.price}₽`, `svc:${i}`).row());
  kb.text('ℹ️ О нас', 'about');
  ctx.reply(cfg.greeting, { reply_markup: kb });
});

bot.callbackQuery(/^svc:(\d+)$/, async ctx => {
  const i = +ctx.match[1];
  draft.set(ctx.chatId, { service: i });
  const kb = new InlineKeyboard();
  dates().forEach(d => kb.text(d, `date:${d}`).row());
  await ctx.editMessageText('Выбери дату:', { reply_markup: kb });
});

bot.callbackQuery(/^date:(.+)$/, async ctx => {
  const d = ctx.match[1];
  const dr = draft.get(ctx.chatId); if (!dr) return;
  dr.date = d;
  const slots = slotsForDate(d);
  if (!slots.length) return ctx.answerCallbackQuery('На эту дату всё занято 😕');
  const kb = new InlineKeyboard();
  slots.forEach(t => kb.text(t, `time:${t}`));
  await ctx.editMessageText('Выбери время:', { reply_markup: kb });
});

bot.callbackQuery(/^time:(.+)$/, async ctx => {
  const dr = draft.get(ctx.chatId); if (!dr) return;
  dr.time = ctx.match[1];
  await ctx.editMessageText('Напиши своё имя и телефон одной строкой,\nнапример: Анна +79001234567');
});

bot.on('message:text', async ctx => {
  const dr = draft.get(ctx.chatId);
  if (!dr?.time) return;
  const m = ctx.msg.text.match(/(\+?\d[\d\s\-()]{8,})/);
  if (!m) return ctx.reply('Не понял телефон. Пример: Анна +79001234567');
  const svc = cfg.services[dr.service];
  const booking = {
    id: Date.now(), date: dr.date, time: dr.time, service: svc.name, price: svc.price,
    client: ctx.msg.text.trim(), tg: `@${ctx.from.username ?? ctx.from.id}`,
    status: 'new'
  };
  store.bookings.push(booking); save(); draft.delete(ctx.chatId);
  await ctx.reply(`✅ Записал: ${svc.name}, ${dr.date} ${dr.time}. До встречи!`);
  await ctx.api.sendMessage(cfg.adminId,
    `🔔 Новая запись #${booking.id}\n${svc.name} | ${dr.date} ${dr.time}\n${booking.client} (${booking.tg})`);
});

bot.callbackQuery('about', ctx => ctx.editMessageText(cfg.about ?? cfg.greeting));

// ---------- админ ----------
bot.command('export', async ctx => {
  if (ctx.from.id !== cfg.adminId) return;
  const head = 'id,date,time,service,price,client,tg,status';
  const rows = store.bookings.map(b => [b.id, b.date, b.time, b.service, b.price, `"${b.client}"`, b.tg, b.status].join(','));
  await ctx.replyDocument(new InputFile(Buffer.from([head, ...rows].join('\n')), 'bookings.csv'));
});
bot.command('cancel', ctx => {
  if (ctx.from.id !== cfg.adminId) return;
  const id = +ctx.msg.text.split(' ')[1]; if (!id) return ctx.reply('/cancel <id>');
  const b = store.bookings.find(x => x.id === id);
  if (b) { b.status = 'cancelled'; save(); ctx.reply(`❌ Отменено #${id}`); }
});

bot.start();
