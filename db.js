// db.js
// Хранилище данных мессенджера с двумя режимами работы:
//
// 1) Если задана переменная окружения DATABASE_URL (Render Postgres
//    выставляет её автоматически после подключения бесплатной базы
//    данных к веб-сервису) — все данные хранятся в PostgreSQL в виде
//    одной строки с JSON-содержимым. Это решает главную проблему
//    бесплатного тарифа Render: файловая система веб-сервиса временная
//    и стирается при каждом обновлении кода, а база данных — нет.
//
// 2) Если DATABASE_URL не задана (например, при локальной разработке
//    или в GitHub Codespaces без подключённой базы) — данные хранятся
//    в обычном JSON-файле на диске, как и раньше. Это удобно для
//    тестирования без необходимости поднимать настоящую базу.

const fs = require("fs");
const path = require("path");

const DATA_DIR = path.join(__dirname, "data");
const DB_FILE = path.join(DATA_DIR, "db.json");
const UPLOADS_DIR = path.join(DATA_DIR, "uploads");

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

function defaultState() {
  return {
    users: {},
    chats: {},
    favorites: {},
    verifyCodes: {},
    groups: {},
    stickers: {}
  };
}

let state = defaultState();

function replaceStateContents(newData) {
  Object.keys(state).forEach((k) => delete state[k]);
  Object.assign(state, defaultState(), newData);
}

const USE_POSTGRES = !!process.env.DATABASE_URL;
let pgPool = null;

async function pgInit() {
  const { Pool } = require("pg");
  pgPool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
  });
  await pgPool.query(`
    CREATE TABLE IF NOT EXISTS app_state (
      id INTEGER PRIMARY KEY DEFAULT 1,
      data JSONB NOT NULL,
      updated_at TIMESTAMPTZ DEFAULT now()
    )
  `);
  const res = await pgPool.query("SELECT data FROM app_state WHERE id = 1");
  if (res.rows.length > 0) {
    replaceStateContents(res.rows[0].data);
    console.log("[db] Состояние загружено из PostgreSQL");
  } else {
    await pgPool.query("INSERT INTO app_state (id, data) VALUES (1, $1)", [state]);
    console.log("[db] Новая база создана в PostgreSQL");
  }
}

let pgSaveTimer = null;
function pgSave() {
  clearTimeout(pgSaveTimer);
  pgSaveTimer = setTimeout(async () => {
    try {
      await pgPool.query(
        "UPDATE app_state SET data = $1, updated_at = now() WHERE id = 1",
        [state]
      );
    } catch (e) {
      console.error("[db] Не удалось сохранить состояние в PostgreSQL:", e.message);
    }
  }, 150);
}

function fileLoad() {
  try {
    if (fs.existsSync(DB_FILE)) {
      const raw = fs.readFileSync(DB_FILE, "utf8");
      replaceStateContents(JSON.parse(raw));
      console.log("[db] Состояние загружено из локального файла data/db.json");
    } else {
      console.log("[db] Файл базы не найден, начинаем с пустого состояния");
    }
  } catch (e) {
    console.error("[db] Не удалось прочитать базу данных, создаю новую:", e.message);
    replaceStateContents(defaultState());
  }
}

let fileSaveTimer = null;
function fileSave() {
  clearTimeout(fileSaveTimer);
  fileSaveTimer = setTimeout(() => {
    fs.writeFileSync(DB_FILE, JSON.stringify(state, null, 2));
  }, 150);
}

function save() {
  if (USE_POSTGRES) pgSave();
  else fileSave();
}

function chatIdFor(phoneA, phoneB) {
  return [phoneA, phoneB].sort().join("|");
}
function groupChatId(groupId) {
  return "group:" + groupId;
}

let readyPromise;
if (USE_POSTGRES) {
  console.log("[db] Обнаружена DATABASE_URL — использую PostgreSQL (данные переживут обновления кода)");
  readyPromise = pgInit().catch((e) => {
    console.error("[db] Ошибка подключения к PostgreSQL, переключаюсь на локальный файл:", e.message);
    fileLoad();
  });
} else {
  console.log("[db] DATABASE_URL не задана — использую локальный файл data/db.json (данные НЕ переживут пересборку на бесплатном Render)");
  fileLoad();
  readyPromise = Promise.resolve();
}

module.exports = {
  state,
  save,
  chatIdFor,
  groupChatId,
  UPLOADS_DIR,
  ready: () => readyPromise
};
