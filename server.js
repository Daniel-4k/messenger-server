// server.js
// Backend мессенджера «Связь»: регистрация по номеру телефона, поиск
// пользователей, обмен текстом/фото/аудио в реальном времени через
// WebSocket, и сигналинг для аудиозвонков через WebRTC.

const express = require("express");
const http = require("http");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const { WebSocketServer } = require("ws");
const { nanoid } = require("nanoid");
const { state, save, chatIdFor, groupChatId, UPLOADS_DIR, ready } = require("./db");

const PORT = process.env.PORT || 3000;

const app = express();
app.use(express.json({ limit: "12mb" })); // фото/аудио идут как base64, нужен запас

// Раздаём только сам клиент (index.html, script.js), а не всю папку
// проекта — иначе через браузер был бы виден исходный код server.js,
// db.js и содержимое package.json.
app.get("/", (req, res) => res.sendFile(path.join(__dirname, "index.html")));
app.get("/index.html", (req, res) => res.sendFile(path.join(__dirname, "index.html")));
app.get("/script.js", (req, res) => res.sendFile(path.join(__dirname, "script.js")));
app.use("/uploads", express.static(UPLOADS_DIR));

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });

const liveSockets = new Map();

function publicUser(u) {
  if (!u) return null;
  return {
    phone: u.phone,
    name: u.name,
    status: u.status || "",
    color: u.color || "#2DD4A8",
    avatarUrl: u.avatarUrl || null,
    online: liveSockets.has(u.phone)
  };
}

function publicGroup(g) {
  if (!g) return null;
  return {
    id: g.id,
    isGroup: true,
    name: g.name,
    color: g.color || "#6C8CFF",
    members: g.members,
    createdBy: g.createdBy
  };
}

function send(ws, type, payload) {
  if (ws && ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify({ type, payload }));
  }
}

function sendToPhone(phone, type, payload) {
  const ws = liveSockets.get(phone);
  if (ws) send(ws, type, payload);
}

function broadcastPresence(phone, online) {
  const partners = new Set();
  Object.keys(state.chats).forEach((chatId) => {
    if (chatId.startsWith("group:")) return;
    const [a, b] = chatId.split("|");
    if (a === phone) partners.add(b);
    if (b === phone) partners.add(a);
  });
  Object.values(state.groups).forEach((g) => {
    if (g.members.includes(phone)) {
      g.members.forEach((m) => { if (m !== phone) partners.add(m); });
    }
  });
  partners.forEach((p) => sendToPhone(p, "presence", { phone, online }));
}

app.post("/api/auth/request-code", (req, res) => {
  const { phone } = req.body;
  if (!phone || !/^\+\d{10,15}$/.test(phone)) {
    return res.status(400).json({ error: "Некорректный номер телефона" });
  }
  const code = "1234";
  state.verifyCodes[phone] = { code, expiresAt: Date.now() + 5 * 60 * 1000 };
  save();
  console.log(`[DEV] Код для ${phone}: ${code} (в реальном продукте уходит по SMS)`);
  res.json({ ok: true, devCode: code });
});

app.post("/api/auth/verify-code", (req, res) => {
  const { phone, code, name, color } = req.body;
  const entry = state.verifyCodes[phone];
  if (!entry || entry.code !== code || entry.expiresAt < Date.now()) {
    return res.status(400).json({ error: "Неверный или просроченный код" });
  }
  delete state.verifyCodes[phone];

  let user = state.users[phone];
  if (!user) {
    if (!name) return res.status(400).json({ error: "Укажите имя для регистрации" });
    user = {
      phone,
      name,
      status: "Привет! Я в мессенджере «Связь»",
      color: color || "#2DD4A8",
      avatarUrl: null,
      token: nanoid(24),
      createdAt: Date.now()
    };
    state.users[phone] = user;
  }
  if (!user.token) user.token = nanoid(24);
  save();
  res.json({ ok: true, token: user.token, user: publicUser(user) });
});

function authMiddleware(req, res, next) {
  const token = req.headers["x-auth-token"];
  const phone = req.headers["x-auth-phone"];
  const user = state.users[phone];
  if (!user || !token || user.token !== token) {
    return res.status(401).json({ error: "Не авторизован" });
  }
  req.user = user;
  next();
}

app.get("/api/me", authMiddleware, (req, res) => {
  res.json({ user: publicUser(req.user) });
});

app.put("/api/me", authMiddleware, (req, res) => {
  const { name, status, color, avatarUrl } = req.body;
  if (name !== undefined) req.user.name = name;
  if (status !== undefined) req.user.status = status;
  if (color !== undefined) req.user.color = color;
  if (avatarUrl !== undefined) req.user.avatarUrl = avatarUrl;
  save();
  res.json({ user: publicUser(req.user) });
});

app.post("/api/me/change-phone", authMiddleware, (req, res) => {
  const { newPhone, code } = req.body;
  const entry = state.verifyCodes[newPhone];
  if (!entry || entry.code !== code || entry.expiresAt < Date.now()) {
    return res.status(400).json({ error: "Неверный или просроченный код" });
  }
  if (state.users[newPhone]) {
    return res.status(400).json({ error: "Этот номер уже зарегистрирован" });
  }
  delete state.verifyCodes[newPhone];
  const oldPhone = req.user.phone;
  const user = req.user;
  user.phone = newPhone;
  delete state.users[oldPhone];
  state.users[newPhone] = user;

  Object.keys(state.chats).forEach((chatId) => {
    if (chatId.includes(oldPhone)) {
      const newChatId = chatId.replace(oldPhone, newPhone);
      state.chats[newChatId] = state.chats[chatId];
      delete state.chats[chatId];
    }
  });
  if (state.favorites[oldPhone]) {
    state.favorites[newPhone] = state.favorites[oldPhone];
    delete state.favorites[oldPhone];
  }
  if (liveSockets.has(oldPhone)) {
    const ws = liveSockets.get(oldPhone);
    liveSockets.delete(oldPhone);
    liveSockets.set(newPhone, ws);
    ws.phone = newPhone;
  }
  save();
  res.json({ ok: true, user: publicUser(user) });
});

app.get("/api/users/search", authMiddleware, (req, res) => {
  const phone = (req.query.phone || "").trim();
  const found = state.users[phone];
  if (!found || found.phone === req.user.phone) {
    return res.json({ user: null });
  }
  res.json({ user: publicUser(found) });
});

app.post("/api/groups", authMiddleware, (req, res) => {
  const { name, memberPhones } = req.body;
  if (!name || !name.trim()) {
    return res.status(400).json({ error: "Укажите название группы" });
  }
  const validMembers = (memberPhones || []).filter((p) => state.users[p]);
  const members = Array.from(new Set([req.user.phone, ...validMembers]));
  if (members.length < 2) {
    return res.status(400).json({ error: "Добавьте хотя бы одного участника" });
  }
  const id = nanoid(12);
  const group = {
    id,
    name: name.trim(),
    color: req.body.color || "#6C8CFF",
    members,
    createdBy: req.user.phone,
    createdAt: Date.now()
  };
  state.groups[id] = group;
  state.chats[groupChatId(id)] = { messages: [] };
  save();

  members.forEach((m) => {
    if (m !== req.user.phone) sendToPhone(m, "group:added", { group: publicGroup(group) });
  });

  res.json({ group: publicGroup(group) });
});

app.get("/api/groups/:id", authMiddleware, (req, res) => {
  const group = state.groups[req.params.id];
  if (!group || !group.members.includes(req.user.phone)) {
    return res.status(404).json({ error: "Группа не найдена" });
  }
  res.json({
    group: publicGroup(group),
    members: group.members.map((p) => publicUser(state.users[p])).filter(Boolean)
  });
});

app.post("/api/groups/:id/members", authMiddleware, (req, res) => {
  const group = state.groups[req.params.id];
  if (!group || !group.members.includes(req.user.phone)) {
    return res.status(404).json({ error: "Группа не найдена" });
  }
  const { phone } = req.body;
  if (!state.users[phone]) {
    return res.status(400).json({ error: "Пользователь с таким номером не найден" });
  }
  if (!group.members.includes(phone)) {
    group.members.push(phone);
    save();
    sendToPhone(phone, "group:added", { group: publicGroup(group) });
    group.members.forEach((m) => {
      if (m !== req.user.phone) {
        sendToPhone(m, "group:member-joined", { groupId: group.id, phone });
      }
    });
  }
  res.json({ group: publicGroup(group) });
});

app.get("/api/chats", authMiddleware, (req, res) => {
  const me = req.user.phone;
  const result = [];
  Object.keys(state.chats).forEach((chatId) => {
    if (chatId.startsWith("group:")) {
      const groupId = chatId.slice("group:".length);
      const group = state.groups[groupId];
      if (!group || !group.members.includes(me)) return;
      const messages = state.chats[chatId].messages;
      result.push({
        contact: publicGroup(group),
        lastMessage: messages[messages.length - 1] || null
      });
      return;
    }
    const [a, b] = chatId.split("|");
    if (a !== me && b !== me) return;
    const otherPhone = a === me ? b : a;
    const otherUser = state.users[otherPhone];
    if (!otherUser) return;
    const messages = state.chats[chatId].messages;
    result.push({
      contact: publicUser(otherUser),
      lastMessage: messages[messages.length - 1] || null
    });
  });
  res.json({ chats: result });
});

app.get("/api/chats/:id/messages", authMiddleware, (req, res) => {
  const me = req.user.phone;
  const targetId = req.params.id;
  let chatId;
  if (targetId.startsWith("group:")) {
    const groupId = targetId.slice("group:".length);
    const group = state.groups[groupId];
    if (!group || !group.members.includes(me)) {
      return res.status(404).json({ error: "Группа не найдена" });
    }
    chatId = groupChatId(groupId);
  } else {
    chatId = chatIdFor(me, targetId);
  }
  const chat = state.chats[chatId];
  res.json({ messages: chat ? chat.messages : [] });
});

app.post("/api/upload", authMiddleware, (req, res) => {
  const { dataUrl, kind } = req.body;
  if (!dataUrl || !dataUrl.startsWith("data:")) {
    return res.status(400).json({ error: "Ожидался data URL" });
  }
  const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
  if (!match) return res.status(400).json({ error: "Некорректный формат данных" });
  const mime = match[1];
  const base64 = match[2];
  const ext = kind === "audio" ? "webm" : (mime.split("/")[1] || "jpg");
  const filename = `${nanoid(16)}.${ext}`;
  fs.writeFileSync(path.join(UPLOADS_DIR, filename), Buffer.from(base64, "base64"));
  res.json({ url: `/uploads/${filename}` });
});

app.get("/api/favorites", authMiddleware, (req, res) => {
  const fav = state.favorites[req.user.phone];
  res.json({ messages: fav ? fav.savedMessages : [] });
});

app.post("/api/favorites", authMiddleware, (req, res) => {
  if (!state.favorites[req.user.phone]) state.favorites[req.user.phone] = { savedMessages: [] };
  const msg = {
    id: nanoid(12),
    type: req.body.type,
    text: req.body.text || null,
    mediaUrl: req.body.mediaUrl || null,
    duration: req.body.duration || null,
    time: new Date().toISOString(),
    ts: Date.now()
  };
  state.favorites[req.user.phone].savedMessages.push(msg);
  save();
  res.json({ message: msg });
});

app.delete("/api/favorites/:id", authMiddleware, (req, res) => {
  const fav = state.favorites[req.user.phone];
  if (fav) {
    fav.savedMessages = fav.savedMessages.filter((m) => m.id !== req.params.id);
    save();
  }
  res.json({ ok: true });
});

app.get("/health", (req, res) => res.json({ ok: true, usersOnline: liveSockets.size }));

app.get("/api/stickers", authMiddleware, (req, res) => {
  res.json({ stickers: state.stickers[req.user.phone] || [] });
});

app.post("/api/stickers", authMiddleware, (req, res) => {
  const { dataUrl } = req.body;
  if (!dataUrl || !dataUrl.startsWith("data:image/")) {
    return res.status(400).json({ error: "Ожидалось изображение" });
  }
  const match = dataUrl.match(/^data:image\/([^;]+);base64,(.+)$/);
  if (!match) return res.status(400).json({ error: "Некорректный формат изображения" });
  const ext = match[1] === "jpeg" ? "jpg" : match[1];
  const filename = `sticker_${nanoid(16)}.${ext}`;
  fs.writeFileSync(path.join(UPLOADS_DIR, filename), Buffer.from(match[2], "base64"));

  if (!state.stickers[req.user.phone]) state.stickers[req.user.phone] = [];
  const sticker = { id: nanoid(10), url: `/uploads/${filename}`, createdAt: Date.now() };
  state.stickers[req.user.phone].unshift(sticker);
  save();
  res.json({ sticker });
});

app.delete("/api/stickers/:id", authMiddleware, (req, res) => {
  const list = state.stickers[req.user.phone];
  if (list) {
    state.stickers[req.user.phone] = list.filter((s) => s.id !== req.params.id);
    save();
  }
  res.json({ ok: true });
});

wss.on("connection", (ws, req) => {
  const url = new URL(req.url, "http://localhost");
  const phone = url.searchParams.get("phone");
  const token = url.searchParams.get("token");
  const user = state.users[phone];

  if (!user || !token || user.token !== token) {
    ws.close(4001, "unauthorized");
    return;
  }

  ws.phone = phone;
  liveSockets.set(phone, ws);
  broadcastPresence(phone, true);
  console.log(`[ws] ${user.name} (${phone}) подключился. Сейчас онлайн: ${liveSockets.size}`);

  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch (e) { return; }
    const { type, payload } = msg;

    if (type === "chat:send") {
      const { toPhone, toGroup, message } = payload;

      if (toGroup) {
        const group = state.groups[toGroup];
        if (!group || !group.members.includes(phone)) return;
        const chatId = groupChatId(toGroup);
        if (!state.chats[chatId]) state.chats[chatId] = { messages: [] };
        const fullMessage = {
          id: nanoid(12),
          from: phone,
          type: message.type,
          text: message.text || null,
          mediaUrl: message.mediaUrl || null,
          duration: message.duration || null,
          time: new Date().toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" }),
          ts: Date.now()
        };
        state.chats[chatId].messages.push(fullMessage);
        save();
        send(ws, "chat:ack", { tempId: message.tempId, message: fullMessage });
        group.members.forEach((m) => {
          if (m !== phone) sendToPhone(m, "chat:new", { fromGroup: toGroup, fromPhone: phone, message: fullMessage });
        });
        return;
      }

      const chatId = chatIdFor(phone, toPhone);
      if (!state.chats[chatId]) state.chats[chatId] = { messages: [] };
      const fullMessage = {
        id: nanoid(12),
        from: phone,
        type: message.type,
        text: message.text || null,
        mediaUrl: message.mediaUrl || null,
        duration: message.duration || null,
        time: new Date().toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" }),
        ts: Date.now()
      };
      state.chats[chatId].messages.push(fullMessage);
      save();
      send(ws, "chat:ack", { tempId: message.tempId, message: fullMessage });
      sendToPhone(toPhone, "chat:new", { fromPhone: phone, message: fullMessage });
      return;
    }

    if (type === "call:invite") {
      const { toPhone } = payload;
      const callee = state.users[toPhone];
      if (!callee || !liveSockets.has(toPhone)) {
        send(ws, "call:unavailable", { toPhone });
        return;
      }
      sendToPhone(toPhone, "call:incoming", {
        fromPhone: phone,
        fromName: user.name,
        fromColor: user.color,
        callId: payload.callId
      });
      return;
    }
    if (type === "call:accept") {
      sendToPhone(payload.toPhone, "call:accepted", { fromPhone: phone, callId: payload.callId });
      return;
    }
    if (type === "call:decline") {
      sendToPhone(payload.toPhone, "call:declined", { fromPhone: phone, callId: payload.callId });
      return;
    }
    if (type === "call:cancel") {
      sendToPhone(payload.toPhone, "call:cancelled", { fromPhone: phone, callId: payload.callId });
      return;
    }
    if (type === "call:hangup") {
      sendToPhone(payload.toPhone, "call:hangup", { fromPhone: phone, callId: payload.callId });
      return;
    }
    if (type === "call:sdp") {
      sendToPhone(payload.toPhone, "call:sdp", { fromPhone: phone, sdp: payload.sdp, callId: payload.callId });
      return;
    }
    if (type === "call:ice") {
      sendToPhone(payload.toPhone, "call:ice", { fromPhone: phone, candidate: payload.candidate, callId: payload.callId });
      return;
    }
  });

  ws.on("close", () => {
    liveSockets.delete(phone);
    broadcastPresence(phone, false);
    console.log(`[ws] ${phone} отключился. Сейчас онлайн: ${liveSockets.size}`);
  });
});

ready().then(() => {
  server.listen(PORT, () => {
    console.log(`Сервер «Связь» запущен: http://localhost:${PORT}`);
    console.log(`Откройте этот адрес в браузере на разных устройствах в одной сети,`);
    console.log(`или разверните на хостинге, чтобы дать ссылку друзьям.`);
  });
});
