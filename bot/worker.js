// Бот-«входящие» для трекера: принимает заметки в чате, раскладывает по кнопкам
// и отдаёт приложению через защищённый API. Работает как Cloudflare Worker + D1.
//
// Привязки (bindings): DB (D1)
// Секреты: BOT_TOKEN, WEBHOOK_SECRET
// Переменные: OWNER_ID, ALLOWED_ORIGIN, (необязательно) TG_API — только для тестов

const LABELS = {
  'Сегодня': 'today',
  'Завтра': 'tomorrow',
  'Скоро': 'short',
  'Долго': 'long',
  'Расходы': 'expense',
};
const BUCKET_NAME = { today: 'Сегодня', tomorrow: 'Завтра', short: 'Скоро', long: 'Долго' };

const KEYBOARD = {
  keyboard: [[{ text: 'Сегодня' }, { text: 'Завтра' }, { text: 'Скоро' }, { text: 'Долго' }, { text: 'Расходы' }]],
  resize_keyboard: true,
  is_persistent: true,
  input_field_placeholder: 'Заметка или «12 кофе»',
};

const HELP =
  'Пиши заметку и нажимай кнопку, куда её положить:\n' +
  '• «приготовить еду» → Сегодня / Завтра / Скоро / Долго\n' +
  '• «12 кофе» или «кофе 12,5» → Расходы\n\n' +
  'Записи появятся в приложении, когда ты его откроешь.\n' +
  '/clear — удалить заметки, которым ещё не нажали кнопку.';

/* ---------------- утилиты ---------------- */
const json = (obj, status = 200, extra = {}) =>
  new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json', ...extra } });

function safeEqual(a, b) {
  a = String(a); b = String(b);
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

const tgCall = (env, method, body) =>
  fetch(`${env.TG_API || 'https://api.telegram.org'}/bot${env.BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
const say = (env, chat, text, withKeyboard = true) =>
  tgCall(env, 'sendMessage', { chat_id: chat, text, ...(withKeyboard ? { reply_markup: KEYBOARD } : {}) });

/* ---------------- проверка подписи initData (Mini App) ---------------- */
async function hmac(keyBytes, dataBytes) {
  const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, dataBytes));
}
export async function verifyInitData(initData, botToken, maxAgeSec) {
  try {
    const enc = new TextEncoder();
    const params = new URLSearchParams(initData);
    const hash = params.get('hash');
    if (!hash) return null;
    params.delete('hash');
    const check = [...params.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${k}=${v}`)
      .join('\n');
    const secret = await hmac(enc.encode('WebAppData'), enc.encode(botToken));
    const sig = await hmac(secret, enc.encode(check));
    const hex = [...sig].map((b) => b.toString(16).padStart(2, '0')).join('');
    if (!safeEqual(hex, hash)) return null;
    const auth = Number(params.get('auth_date'));
    if (!auth || Date.now() / 1000 - auth > maxAgeSec) return null;
    return JSON.parse(params.get('user') || 'null');
  } catch (_) {
    return null;
  }
}

/* ---------------- разбор расхода ---------------- */
export function parseExpense(text) {
  const m = text.match(/\d{1,3}(?:[  ]\d{3})+(?:[.,]\d{1,2})?|\d+(?:[.,]\d{1,2})?/);
  if (!m) return null;
  const amount = parseFloat(m[0].replace(/[  ]/g, '').replace(',', '.'));
  if (!(amount > 0) || amount > 1e8) return null;
  const note = text
    .replace(m[0], ' ')
    .replace(/[€$£₴]|\b(?:eur|euro|usd|грн|руб|евро|долл\w*)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60);
  return { amount: Math.round(amount * 100) / 100, note };
}

/* ---------------- обработка сообщений из чата ---------------- */
async function onMessage(env, m) {
  const chat = m.chat.id;
  const from = m.from && m.from.id;
  if (m.chat.type !== 'private') return;

  if (!env.OWNER_ID) {
    await say(env, chat, `Твой Telegram ID: ${from}\nВпиши его в OWNER_ID (wrangler.toml) и задеплой заново.`, false);
    return;
  }
  if (String(from) !== String(env.OWNER_ID)) return; // чужим не отвечаем

  const text = (m.text || '').trim();
  if (!text) return void (await say(env, chat, 'Пока понимаю только текст.'));

  if (text === '/start' || text === '/help') return void (await say(env, chat, HELP));
  if (text === '/clear') {
    await env.DB.prepare('DELETE FROM pending').run();
    return void (await say(env, chat, 'Очищено: неразобранных заметок нет.'));
  }
  if (text.startsWith('/')) return void (await say(env, chat, HELP));

  const target = LABELS[text];
  if (!target) {
    await env.DB.prepare('INSERT INTO pending(text, ts) VALUES(?, ?)')
      .bind(text.slice(0, 200), Date.now())
      .run();
    return; // подтверждаем после нажатия кнопки, чтобы не засорять чат
  }

  const row = await env.DB.prepare('SELECT id, text, ts FROM pending ORDER BY id LIMIT 1').first();
  if (!row) return void (await say(env, chat, 'Сначала напиши заметку, потом нажми кнопку.'));
  const left = ((await env.DB.prepare('SELECT COUNT(*) AS c FROM pending').first()) || { c: 1 }).c - 1;
  const tail = left > 0 ? `\nЕщё не разобрано: ${left}` : '';

  if (target === 'expense') {
    const p = parseExpense(row.text);
    if (!p) {
      await env.DB.prepare('DELETE FROM pending WHERE id = ?').bind(row.id).run();
      return void (await say(env, chat, `Не нашёл сумму в «${row.text}». Напиши ещё раз, например: 12 кофе${tail}`));
    }
    await env.DB.batch([
      env.DB.prepare("INSERT INTO inbox(kind, text, amount, ts) VALUES('expense', ?, ?, ?)").bind(p.note, p.amount, row.ts),
      env.DB.prepare('DELETE FROM pending WHERE id = ?').bind(row.id),
    ]);
    const amt = String(p.amount).replace('.', ',');
    return void (await say(env, chat, `✅ ${amt} · ${p.note || 'без заметки'} → Расходы${tail}`));
  }

  await env.DB.batch([
    env.DB.prepare("INSERT INTO inbox(kind, text, bucket, ts) VALUES('task', ?, ?, ?)").bind(row.text, target, row.ts),
    env.DB.prepare('DELETE FROM pending WHERE id = ?').bind(row.id),
  ]);
  await say(env, chat, `✅ «${row.text}» → ${BUCKET_NAME[target]}${tail}`);
}

async function onWebhook(request, env) {
  if (!env.WEBHOOK_SECRET || !safeEqual(request.headers.get('X-Telegram-Bot-Api-Secret-Token') || '', env.WEBHOOK_SECRET)) {
    return new Response('forbidden', { status: 403 });
  }
  try {
    const update = await request.json();
    const last = await env.DB.prepare("SELECT v FROM meta WHERE k = 'last'").first();
    if (last && update.update_id <= last.v) return new Response('ok'); // повторная доставка
    await env.DB.prepare("INSERT INTO meta(k, v) VALUES('last', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v")
      .bind(update.update_id)
      .run();
    if (update.message) await onMessage(env, update.message);
  } catch (e) {
    console.log('webhook error', String(e && e.stack ? e.stack : e));
  }
  return new Response('ok'); // всегда 200, чтобы Telegram не слал повторы
}

/* ---------------- API для приложения ---------------- */
function corsHeaders(request, env) {
  const allowed = env.ALLOWED_ORIGIN || '';
  const origin = request.headers.get('Origin') || '';
  return {
    'Access-Control-Allow-Origin': allowed === '*' ? '*' : origin === allowed ? origin : allowed,
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

async function onApi(request, env, url) {
  const cors = corsHeaders(request, env);
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  const auth = request.headers.get('Authorization') || '';
  if (!auth.startsWith('tma ')) return json({ error: 'unauthorized' }, 401, cors);
  const user = await verifyInitData(auth.slice(4), env.BOT_TOKEN, 7 * 86400);
  if (!user || !env.OWNER_ID || String(user.id) !== String(env.OWNER_ID)) return json({ error: 'forbidden' }, 403, cors);

  if (url.pathname === '/api/inbox' && request.method === 'GET') {
    const { results } = await env.DB.prepare(
      'SELECT id, kind, text, amount, bucket, ts FROM inbox ORDER BY id LIMIT 200'
    ).all();
    return json({ items: results }, 200, cors);
  }
  if (url.pathname === '/api/ack' && request.method === 'POST') {
    let body = {};
    try { body = await request.json(); } catch (_) {}
    const upTo = Number(body.upTo);
    if (!Number.isFinite(upTo)) return json({ error: 'bad request' }, 400, cors);
    await env.DB.prepare('DELETE FROM inbox WHERE id <= ?').bind(upTo).run();
    return json({ ok: true }, 200, cors);
  }
  return json({ error: 'not found' }, 404, cors);
}

/* ---------------- маршруты ---------------- */
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/webhook' && request.method === 'POST') return onWebhook(request, env);
    if (url.pathname.startsWith('/api/')) return onApi(request, env, url);
    if (url.pathname === '/setup' && request.method === 'GET') {
      // Однократная настройка: открой /setup?key=<WEBHOOK_SECRET> в браузере
      if (!env.WEBHOOK_SECRET || !safeEqual(url.searchParams.get('key') || '', env.WEBHOOK_SECRET)) {
        return new Response('forbidden', { status: 403 });
      }
      const r = await tgCall(env, 'setWebhook', {
        url: `${url.origin}/webhook`,
        secret_token: env.WEBHOOK_SECRET,
        allowed_updates: ['message'],
        drop_pending_updates: true,
      });
      return json({ webhook: await r.json() });
    }
    return new Response('tracker-bot is running');
  },
};
