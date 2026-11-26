-- Заметки из чата, которые ещё ждут нажатия кнопки
CREATE TABLE IF NOT EXISTS pending (
  id   INTEGER PRIMARY KEY AUTOINCREMENT,
  text TEXT NOT NULL,
  ts   INTEGER NOT NULL
);

-- Готовые записи, которые приложение ещё не забрало
CREATE TABLE IF NOT EXISTS inbox (
  id     INTEGER PRIMARY KEY AUTOINCREMENT,
  kind   TEXT NOT NULL,      -- 'task' | 'expense'
  text   TEXT,
  amount REAL,
  bucket TEXT,               -- today | tomorrow | short | long (для задач)
  ts     INTEGER NOT NULL
);

-- Служебное: последний обработанный update_id (защита от повторной доставки)
CREATE TABLE IF NOT EXISTS meta (
  k TEXT PRIMARY KEY,
  v INTEGER NOT NULL
);
