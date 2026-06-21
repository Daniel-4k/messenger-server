// db.js
// Простое файловое хранилище в JSON. Для реального продакшена с тысячами
// пользователей это надо заменить на PostgreSQL/MySQL, но для личного
// мессенджера на компанию друзей — более чем достаточно и не требует
// установки/настройки отдельной базы данных.

const fs = require("fs");
const path = require("path");

const DATA_DIR = path.join(__dirname, "data");
const DB_FILE = path.join(DATA_DIR, "db.json");
const UPLOADS_DIR = path.join(DATA_DIR, "uploads");

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

function defaultState() {
  return {
    users: {},      // phone -> { phone, name, status, color, avatarUrl, createdAt }
    chats: {},      // chatId ("phoneA|phoneB" sorted) -> { messages: [] }
    favorites: {},  // phone -> { savedMessages: [] }  (личное "Избранное" каждого пользователя)
    verifyCodes: {} // phone -> { code, expiresAt }  (демо-коды подтверждения)
  };
}

let state = defaultState();

function load() {
  try {
    if (fs.existsSync(DB_FILE)) {
      const raw = fs.readFileSync(DB_FILE, "utf8");
      state = Object.assign(defaultState(), JSON.parse(raw));
    }
  } catch (e) {
    console.error("Не удалось прочитать базу данных, создаю новую:", e.message);
    state = defaultState();
  }
}

let saveTimer = null;
function save() {
  // Дебаунс записи на диск, чтобы не писать файл при каждом чихе.
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    fs.writeFileSync(DB_FILE, JSON.stringify(state, null, 2));
  }, 150);
}

function chatIdFor(phoneA, phoneB) {
  return [phoneA, phoneB].sort().join("|");
}

load();

module.exports = {
  state,
  save,
  chatIdFor,
  UPLOADS_DIR
};
