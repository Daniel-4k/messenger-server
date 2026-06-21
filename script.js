(function(){
  "use strict";

  /* ============================================================
     КОНФИГ
     Сервер раздаёт этот же файл, поэтому просто берём текущий адрес.
     Если откроете файл отдельно (не через сервер), впишите вручную
     адрес сервера в SERVER_BASE, например "http://192.168.1.10:3000".
  ============================================================ */
  const SERVER_BASE = window.location.origin;
  const WS_BASE = SERVER_BASE.replace(/^http/, "ws");

  const AVATAR_COLORS = ["#2DD4A8","#E8A34D","#6C8CFF","#E8625C","#B07CE8","#4DC4E8"];
  const SAVED_PHONE = "saved";

  /* ============ ЛОКАЛЬНАЯ СЕССИЯ (только токен авторизации) ============ */
  // Само содержимое переписки больше не хранится в браузере — оно живёт на
  // сервере. В браузере остаётся только токен, чтобы не вводить код заново
  // при каждом открытии, плюс кэш текущего экрана для плавности интерфейса.
  const SESSION_KEY = "svyaz_session_v2";
  let session = { phone: null, token: null };
  function loadSession(){
    try{
      const raw = localStorage.getItem(SESSION_KEY);
      if(raw) session = JSON.parse(raw);
    }catch(e){}
  }
  function saveSession(){
    localStorage.setItem(SESSION_KEY, JSON.stringify(session));
  }
  function clearSession(){
    session = { phone:null, token:null };
    localStorage.removeItem(SESSION_KEY);
  }

  /* ============ ЛОКАЛЬНЫЙ КЭШ ДЛЯ ОТРИСОВКИ ============ */
  let me = null;              // публичные данные своего профиля
  let chatsCache = [];         // [{contact, lastMessage}]
  let messagesCache = {};      // phone -> [messages]
  let contactsCache = {};      // phone -> contact info (для аватаров/имён)
  let favoritesCache = [];     // личные заметки в "Избранном"
  let pendingPhone = null;     // номер, ожидающий подтверждения кода (вход/регистрация)
  let pendingNewPhone = null;  // номер при смене телефона в профиле

  /* ============ СЕТЕВЫЕ ХЕЛПЕРЫ ============ */
  async function api(method, urlPath, body){
    const headers = { "Content-Type": "application/json" };
    if(session.token){
      headers["X-Auth-Token"] = session.token;
      headers["X-Auth-Phone"] = session.phone;
    }
    const res = await fetch(SERVER_BASE + urlPath, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined
    });
    let data = null;
    try{ data = await res.json(); }catch(e){}
    if(!res.ok){
      const err = new Error((data && data.error) || "Ошибка сервера");
      err.status = res.status;
      throw err;
    }
    return data;
  }

  function normalizePhoneDigits(raw){ return raw.replace(/\D/g,""); }
  function formatRuPhone(digitsAfterSeven){
    const d = digitsAfterSeven;
    let out = "";
    if(d.length>0) out += d.substring(0,3);
    if(d.length>3) out += " " + d.substring(3,6);
    if(d.length>6) out += "-" + d.substring(6,8);
    if(d.length>8) out += "-" + d.substring(8,10);
    return out;
  }
  function fullPhoneFromInput(inputValue){
    let digits = normalizePhoneDigits(inputValue);
    if(digits.startsWith("7")) digits = digits.substring(1);
    if(digits.startsWith("8")) digits = digits.substring(1);
    digits = digits.substring(0,10);
    return { digits, full: digits.length===10 ? "+7"+digits : null };
  }
  function initials(name){
    if(!name) return "?";
    const parts = name.trim().split(/\s+/).filter(Boolean);
    if(parts.length===0) return "?";
    if(parts.length===1) return parts[0][0].toUpperCase();
    return (parts[0][0]+parts[1][0]).toUpperCase();
  }
  function escapeHtml(str){
    const d = document.createElement("div");
    d.textContent = str == null ? "" : str;
    return d.innerHTML;
  }
  function previewTextFor(msg){
    if(!msg) return "";
    if(msg.type==="image") return "📷 Фото";
    if(msg.type==="audio") return "🎤 Голосовое сообщение";
    return msg.text || "";
  }
  function formatClock(tsOrIso){
    const d = new Date(tsOrIso);
    return d.getHours().toString().padStart(2,"0")+":"+d.getMinutes().toString().padStart(2,"0");
  }
  function truncate(str,n){
    if(!str) return "";
    return str.length>n ? str.substring(0,n-1)+"…" : str;
  }

  function toast(msg){
    const t = document.getElementById("toast");
    t.textContent = msg;
    t.classList.add("show");
    clearTimeout(t._timer);
    t._timer = setTimeout(()=> t.classList.remove("show"), 2400);
  }

  /* ============ НАВИГАЦИЯ МЕЖДУ ЭКРАНАМИ ============ */
  const screens = {};
  document.querySelectorAll(".screen").forEach(s=>{ screens[s.dataset.screen] = s; });
  let screenStack = ["welcome"];

  function showScreen(name){
    Object.values(screens).forEach(s=>s.classList.add("hidden"));
    screens[name].classList.remove("hidden");
    screenStack.push(name);
  }
  function goBack(fallback){
    screenStack.pop();
    const target = screenStack[screenStack.length-1] || fallback || "home";
    Object.values(screens).forEach(s=>s.classList.add("hidden"));
    screens[target].classList.remove("hidden");
  }
  document.querySelectorAll("[data-back]").forEach(btn=>{
    btn.addEventListener("click", ()=> goBack(btn.dataset.back));
  });

  /* ============ АВАТАРКИ ============ */
  function avatarEl(contact, sizeClass, withOnlineDot){
    const div = document.createElement("div");
    div.className = "avatar " + (sizeClass||"");
    if(contact && contact.avatarUrl){
      div.style.background = "var(--panel-2)";
      const img = document.createElement("img");
      img.src = contact.avatarUrl;
      img.style.width="100%"; img.style.height="100%"; img.style.objectFit="cover"; img.style.borderRadius="50%";
      div.appendChild(img);
    } else {
      div.style.background = (contact && contact.color) || "#2DD4A8";
      div.textContent = initials(contact && contact.name);
    }
    if(withOnlineDot!==undefined){
      const dot = document.createElement("div");
      dot.className = "online-dot" + (withOnlineDot ? " pulse":"");
      if(!withOnlineDot) dot.style.background = "#565B66";
      div.style.position="relative";
      div.appendChild(dot);
    }
    return div;
  }
  function savedIconEl(){
    const div = document.createElement("div");
    div.className = "avatar saved-icon";
    div.innerHTML = `<svg viewBox="0 0 24 24" fill="none"><path d="M12 3l2.6 5.6 6.1.6-4.6 4.1 1.3 6-5.4-3.2-5.4 3.2 1.3-6-4.6-4.1 6.1-.6L12 3z" fill="#0B1410"/></svg>`;
    return div;
  }

  /* ============================================================
     АВТОРИЗАЦИЯ: ввод номера → код подтверждения → (создание профиля)
  ============================================================ */
  document.getElementById("goToPhone").addEventListener("click", ()=> showScreen("phone"));

  const phoneInput = document.getElementById("phoneInput");
  phoneInput.addEventListener("input", ()=>{
    const {digits} = fullPhoneFromInput(phoneInput.value);
    phoneInput.value = formatRuPhone(digits);
    document.getElementById("phoneError").classList.remove("show");
  });

  document.getElementById("sendCodeBtn").addEventListener("click", async ()=>{
    const {full} = fullPhoneFromInput(phoneInput.value);
    if(!full){ document.getElementById("phoneError").classList.add("show"); return; }
    const btn = document.getElementById("sendCodeBtn");
    btn.disabled = true;
    try{
      const data = await api("POST","/api/auth/request-code", { phone: full });
      pendingPhone = full;
      document.getElementById("codeTargetPhone").textContent = full;
      resetCodeInput("codeHiddenInput","codeRow");
      showScreen("code");
      if(data && data.devCode){
        toast(`Демо-режим: код ${data.devCode}`);
      }
    }catch(e){
      toast(e.message || "Не удалось связаться с сервером");
    }finally{
      btn.disabled = false;
    }
  });

  function setupCodeEntry(hiddenId, rowId, onComplete){
    const hidden = document.getElementById(hiddenId);
    const row = document.getElementById(rowId);
    const cells = row.querySelectorAll(".code-cell");
    function render(){
      const val = hidden.value;
      cells.forEach((c,i)=>{
        c.textContent = val[i] || "";
        c.classList.toggle("filled", !!val[i]);
      });
    }
    hidden.addEventListener("input", ()=>{
      hidden.value = hidden.value.replace(/\D/g,"").substring(0,4);
      render();
      if(hidden.value.length===4) onComplete(hidden.value);
    });
    row.addEventListener("click", ()=> hidden.focus());
    return { focus: ()=>hidden.focus(), render };
  }
  function resetCodeInput(hiddenId, rowId){
    const hidden = document.getElementById(hiddenId);
    hidden.value = "";
    document.getElementById(rowId).querySelectorAll(".code-cell").forEach(c=>{
      c.textContent=""; c.classList.remove("filled");
    });
    setTimeout(()=>hidden.focus(), 350);
  }

  setupCodeEntry("codeHiddenInput","codeRow", async (code)=>{
    document.getElementById("codeError").classList.remove("show");
    try{
      // Сперва пробуем войти без имени — если пользователь уже существует,
      // сервер вернёт токен сразу. Если нет — попросит имя на экране setup.
      const data = await api("POST","/api/auth/verify-code", { phone: pendingPhone, code });
      session = { phone: pendingPhone, token: data.token };
      saveSession();
      me = data.user;
      await loadFavorites();
      await enterApp();
    }catch(e){
      if(e.status===400 && /имя/i.test(e.message)){
        showScreen("setup");
      } else {
        document.getElementById("codeError").classList.add("show");
      }
    }
  });

  document.getElementById("resendCodeBtn").addEventListener("click", async ()=>{
    try{
      const data = await api("POST","/api/auth/request-code", { phone: pendingPhone });
      toast(data.devCode ? `Код отправлен повторно: ${data.devCode}` : "Код отправлен повторно");
      resetCodeInput("codeHiddenInput","codeRow");
    }catch(e){ toast(e.message); }
  });
  document.getElementById("changeNumberBtn").addEventListener("click", ()=> goBack("phone"));

  /* ============ НАСТРОЙКА ПРОФИЛЯ ПРИ РЕГИСТРАЦИИ ============ */
  let setupColor = AVATAR_COLORS[0];
  let setupAvatarDataUrl = null;
  const setupSwatchesEl = document.getElementById("setupSwatches");
  AVATAR_COLORS.forEach(c=>{
    const sw = document.createElement("div");
    sw.className = "swatch" + (c===setupColor ? " active":"");
    sw.style.background = c;
    sw.addEventListener("click", ()=>{
      setupColor = c;
      setupSwatchesEl.querySelectorAll(".swatch").forEach(s=>s.classList.remove("active"));
      sw.classList.add("active");
      if(!setupAvatarDataUrl){
        document.getElementById("setupAvatarCircle").style.background = c;
        document.getElementById("setupAvatarCircle").style.borderColor = c;
      }
    });
    setupSwatchesEl.appendChild(sw);
  });

  function readImageFileAsDataUrl(file, maxSize, callback){
    if(!file || !file.type.startsWith("image/")){ toast("Выберите файл изображения"); return; }
    const reader = new FileReader();
    reader.onload = function(e){
      const img = new Image();
      img.onload = function(){
        const canvas = document.createElement("canvas");
        let w = img.width, h = img.height;
        const max = maxSize || 800;
        if(w>h && w>max){ h = Math.round(h*(max/w)); w = max; }
        else if(h>=w && h>max){ w = Math.round(w*(max/h)); h = max; }
        canvas.width = w; canvas.height = h;
        canvas.getContext("2d").drawImage(img,0,0,w,h);
        callback(canvas.toDataURL("image/jpeg", 0.85));
      };
      img.src = e.target.result;
    };
    reader.readAsDataURL(file);
  }

  function renderSetupAvatarPreview(){
    const circle = document.getElementById("setupAvatarCircle");
    const span = document.getElementById("setupAvatarInitial");
    let img = circle.querySelector("img");
    if(setupAvatarDataUrl){
      if(!img){
        img = document.createElement("img");
        img.style.width="100%"; img.style.height="100%"; img.style.objectFit="cover"; img.style.borderRadius="50%";
        circle.insertBefore(img, circle.firstChild);
      }
      img.src = setupAvatarDataUrl;
      span.style.display = "none";
    } else if(img){
      img.remove();
      span.style.display = "";
    }
  }
  document.getElementById("setupAvatarCircle").addEventListener("click", ()=> document.getElementById("setupAvatarFileInput").click());
  document.getElementById("setupChoosePhotoBtn").addEventListener("click", ()=> document.getElementById("setupAvatarFileInput").click());
  document.getElementById("setupAvatarFileInput").addEventListener("change", (e)=>{
    const file = e.target.files[0];
    if(!file) return;
    readImageFileAsDataUrl(file, 500, (dataUrl)=>{
      setupAvatarDataUrl = dataUrl;
      renderSetupAvatarPreview();
      toast("Фото выбрано");
    });
    e.target.value = "";
  });

  const setupNameInput = document.getElementById("setupName");
  setupNameInput.addEventListener("input", ()=>{
    const v = setupNameInput.value.trim();
    document.getElementById("setupAvatarInitial").textContent = initials(v);
    document.getElementById("finishSetupBtn").disabled = v.length===0;
  });

  document.getElementById("finishSetupBtn").addEventListener("click", async ()=>{
    const name = setupNameInput.value.trim();
    if(!name) return;
    const btn = document.getElementById("finishSetupBtn");
    btn.disabled = true;
    try{
      // Код уже был "использован" в попытке выше и протух на сервере как
      // одноразовый — поэтому запрашиваем новый перед финальной регистрацией.
      const reissue = await api("POST","/api/auth/request-code", { phone: pendingPhone });
      const code = reissue.devCode || "1234";
      let avatarUrl = null;
      if(setupAvatarDataUrl){
        // Грузим фото уже после получения токена ниже; пока просто помним data URL.
      }
      const data = await api("POST","/api/auth/verify-code", {
        phone: pendingPhone, code, name, color: setupColor
      });
      session = { phone: pendingPhone, token: data.token };
      saveSession();
      me = data.user;
      if(setupAvatarDataUrl){
        const up = await api("POST","/api/upload", { dataUrl: setupAvatarDataUrl, kind:"image" });
        const updated = await api("PUT","/api/me", { avatarUrl: up.url });
        me = updated.user;
      }
      await loadFavorites();
      toast("Аккаунт создан");
      await enterApp();
    }catch(e){
      toast(e.message || "Не удалось завершить регистрацию");
      btn.disabled = false;
    }
  });

  /* ============================================================
     WEBSOCKET: реалтайм-сообщения + presence + сигналинг звонков
  ============================================================ */
  let ws = null;
  let wsReconnectTimer = null;

  function connectWebSocket(){
    if(ws) { try{ ws.close(); }catch(e){} }
    ws = new WebSocket(`${WS_BASE}/ws?phone=${encodeURIComponent(session.phone)}&token=${encodeURIComponent(session.token)}`);

    ws.onopen = ()=>{ console.log("WS подключён"); };
    ws.onclose = ()=>{
      clearTimeout(wsReconnectTimer);
      wsReconnectTimer = setTimeout(connectWebSocket, 2000); // авто-переподключение
    };
    ws.onerror = ()=>{};
    ws.onmessage = (event)=>{
      let msg;
      try{ msg = JSON.parse(event.data); }catch(e){ return; }
      handleWsMessage(msg.type, msg.payload);
    };
  }

  function wsSend(type, payload){
    if(ws && ws.readyState===WebSocket.OPEN){
      ws.send(JSON.stringify({ type, payload }));
    }
  }

  function handleWsMessage(type, payload){
    if(type==="chat:new"){
      const phone = payload.fromPhone;
      if(!messagesCache[phone]) messagesCache[phone] = [];
      messagesCache[phone].push(payload.message);
      if(currentThreadPhone===phone){ renderMessages(); }
      else { toast(`Новое сообщение от ${contactsCache[phone] ? contactsCache[phone].name : phone}`); }
      refreshChatList();
      return;
    }
    if(type==="chat:ack"){
      // подтверждение собственного отправленного сообщения (на случай нескольких вкладок)
      return;
    }
    if(type==="presence"){
      if(contactsCache[payload.phone]) contactsCache[payload.phone].online = payload.online;
      if(currentThreadPhone===payload.phone) updateThreadStatusLine(contactsCache[payload.phone]);
      refreshChatList();
      return;
    }
    if(type==="call:incoming"){ handleIncomingCall(payload); return; }
    if(type==="call:accepted"){ handleCallAccepted(payload); return; }
    if(type==="call:declined"){ handleCallDeclined(payload); return; }
    if(type==="call:cancelled"){ handleCallCancelled(payload); return; }
    if(type==="call:hangup"){ handleRemoteHangup(payload); return; }
    if(type==="call:sdp"){ handleRemoteSdp(payload); return; }
    if(type==="call:ice"){ handleRemoteIce(payload); return; }
    if(type==="call:unavailable"){ handleCallUnavailable(payload); return; }
  }

  /* ============================================================
     ВХОД В ПРИЛОЖЕНИЕ / ЗАГРУЗКА ДАННЫХ
  ============================================================ */
  async function enterApp(){
    screenStack = ["home"];
    Object.values(screens).forEach(s=>s.classList.add("hidden"));
    screens.home.classList.remove("hidden");
    connectWebSocket();
    renderProfileScreen();
    await refreshChatList();
  }

  async function refreshChatList(){
    try{
      const data = await api("GET","/api/chats");
      chatsCache = data.chats;
      chatsCache.forEach(c=> contactsCache[c.contact.phone] = c.contact);
      renderChatList();
    }catch(e){
      if(e.status===401){ return logoutToWelcome(); }
      console.error(e);
    }
  }

  function renderChatList(){
    const wrap = document.getElementById("chatListScroll");
    wrap.innerHTML = "";

    // "Избранное" закреплено первым всегда.
    const savedLast = favoritesCache[favoritesCache.length-1];
    const savedRow = document.createElement("div");
    savedRow.className = "chat-row pinned";
    savedRow.appendChild(savedIconEl());
    const savedMeta = document.createElement("div");
    savedMeta.className = "chat-meta";
    savedMeta.innerHTML = `
      <div class="chat-top-line">
        <div class="chat-name">Избранное</div>
        <div class="chat-time">${savedLast ? formatClock(savedLast.ts) : ""}</div>
      </div>
      <div class="chat-preview">${savedLast ? escapeHtml(previewTextFor(savedLast)) : "Заметки для себя"}</div>
    `;
    savedRow.appendChild(savedMeta);
    savedRow.addEventListener("click", ()=> openSavedThread());
    wrap.appendChild(savedRow);

    if(chatsCache.length===0){
      const hint = document.createElement("div");
      hint.className = "empty-state";
      hint.innerHTML = `
        <div class="e-icon">💬</div>
        <div class="e-title">Других чатов пока нет</div>
        <div class="e-sub">Нажмите «Найти», чтобы отыскать собеседника по номеру телефона и начать переписку.</div>
      `;
      wrap.appendChild(hint);
      return;
    }

    const sorted = [...chatsCache].sort((a,b)=>{
      const ta = a.lastMessage ? a.lastMessage.ts : 0;
      const tb = b.lastMessage ? b.lastMessage.ts : 0;
      return tb-ta;
    });

    sorted.forEach(({contact, lastMessage})=>{
      const row = document.createElement("div");
      row.className = "chat-row";
      row.appendChild(avatarEl(contact, "", contact.online));
      const meta = document.createElement("div");
      meta.className = "chat-meta";
      meta.innerHTML = `
        <div class="chat-top-line">
          <div class="chat-name">${escapeHtml(contact.name)}</div>
          <div class="chat-time">${lastMessage ? formatClock(lastMessage.ts) : ""}</div>
        </div>
        <div class="chat-preview">${lastMessage ? ((lastMessage.from===me.phone ? "Вы: " : "")+escapeHtml(previewTextFor(lastMessage))) : "Нет сообщений"}</div>
      `;
      row.appendChild(meta);
      row.addEventListener("click", ()=> openThread(contact.phone));
      wrap.appendChild(row);
    });
  }

  /* ============ НИЖНЯЯ НАВИГАЦИЯ ============ */
  document.querySelectorAll("[data-nav]").forEach(btn=>{
    btn.addEventListener("click", ()=>{
      const target = btn.dataset.nav;
      screenStack = [target];
      Object.values(screens).forEach(s=>s.classList.add("hidden"));
      screens[target].classList.remove("hidden");
      if(target==="home") refreshChatList();
      if(target==="profile") renderProfileScreen();
      if(target==="search"){
        document.getElementById("searchPhoneInput").value="";
        renderSearchEmpty();
      }
    });
  });
  document.getElementById("openSearchBtn").addEventListener("click", ()=>{
    showScreen("search");
    document.getElementById("searchPhoneInput").focus();
  });

  /* ============ ПОИСК ПО НОМЕРУ ============ */
  const searchInput = document.getElementById("searchPhoneInput");
  function renderSearchEmpty(){
    document.getElementById("searchResultArea").innerHTML = `<div class="empty-state">
      <div class="e-icon">🔎</div>
      <div class="e-title">Введите номер телефона</div>
      <div class="e-sub">Найдите собеседника по номеру и начните переписку — без обмена логинами.</div>
    </div>`;
  }
  let searchDebounce = null;
  searchInput.addEventListener("input", ()=>{
    const {digits} = fullPhoneFromInput(searchInput.value);
    searchInput.value = "+7 " + formatRuPhone(digits);
    if(searchInput.value.trim()==="+7") searchInput.value="";
    clearTimeout(searchDebounce);
    searchDebounce = setTimeout(doSearch, 250);
  });

  async function doSearch(){
    const area = document.getElementById("searchResultArea");
    const {full} = fullPhoneFromInput(searchInput.value);
    if(!full){ renderSearchEmpty(); return; }
    if(full===me.phone){
      area.innerHTML = `<div class="empty-state">
        <div class="e-icon">🙂</div>
        <div class="e-title">Это ваш номер</div>
        <div class="e-sub">Вы не можете написать самому себе здесь — для заметок себе используйте «Избранное».</div>
      </div>`;
      return;
    }
    try{
      const data = await api("GET", "/api/users/search?phone="+encodeURIComponent(full));
      if(!data.user){
        area.innerHTML = `<div class="empty-state">
          <div class="e-icon">🚫</div>
          <div class="e-title">Пользователь не найден</div>
          <div class="e-sub">Никто не зарегистрирован с номером ${escapeHtml(full)}. Попросите собеседника зарегистрироваться в «Связь» с этим номером.</div>
        </div>`;
        return;
      }
      const contact = data.user;
      contactsCache[contact.phone] = contact;
      const alreadyChat = chatsCache.some(c=>c.contact.phone===contact.phone);
      area.innerHTML = "";
      const card = document.createElement("div");
      card.className = "search-result-card";
      card.appendChild(avatarEl(contact, "", contact.online));
      const info = document.createElement("div");
      info.className = "search-result-info";
      info.innerHTML = `<div class="search-result-name">${escapeHtml(contact.name)}</div>
        <div class="search-result-phone mono">${escapeHtml(contact.phone)}</div>`;
      card.appendChild(info);
      const btn = document.createElement("button");
      btn.className = "btn-pill" + (alreadyChat ? " added":"");
      btn.textContent = alreadyChat ? "Открыть чат" : "Написать";
      btn.addEventListener("click", ()=> openThread(contact.phone));
      card.appendChild(btn);
      area.appendChild(card);
    }catch(e){
      toast(e.message || "Ошибка поиска");
    }
  }

  /* ============================================================
     ЧАТ: загрузка истории, отправка текста/фото/аудио
  ============================================================ */
  let currentThreadPhone = null;
  let currentThreadIsSaved = false;
  let pendingImageDataUrl = null;

  async function openThread(phone){
    currentThreadPhone = phone;
    currentThreadIsSaved = false;
    const contact = contactsCache[phone];

    const threadAvatarWrap = document.getElementById("threadAvatar");
    threadAvatarWrap.innerHTML = "";
    threadAvatarWrap.appendChild(avatarEl(contact, "sm"));
    document.getElementById("threadName").textContent = contact.name;
    updateThreadStatusLine(contact);
    document.getElementById("threadFavBtn").classList.add("vis-hidden");
    document.getElementById("threadCallBtn").classList.remove("vis-hidden");

    showScreen("thread");
    document.getElementById("msgInput").value="";
    cancelImagePreview();
    closeAttachMenu();
    updateSendBtn();

    document.getElementById("messagesArea").innerHTML = `<div class="empty-state" style="flex:1;"><div class="e-icon">⏳</div><div class="e-title">Загрузка переписки…</div></div>`;
    try{
      const data = await api("GET", `/api/chats/${encodeURIComponent(phone)}/messages`);
      messagesCache[phone] = data.messages;
      renderMessages();
    }catch(e){
      toast(e.message || "Не удалось загрузить сообщения");
    }
  }

  function openSavedThread(){
    currentThreadPhone = SAVED_PHONE;
    currentThreadIsSaved = true;
    const threadAvatarWrap = document.getElementById("threadAvatar");
    threadAvatarWrap.innerHTML = "";
    const icon = savedIconEl();
    icon.classList.add("sm");
    threadAvatarWrap.appendChild(icon);
    document.getElementById("threadName").textContent = "Избранное";
    const statusEl = document.getElementById("threadStatus");
    statusEl.textContent = "заметки только для вас";
    statusEl.classList.remove("online");
    document.getElementById("threadFavBtn").classList.add("vis-hidden");
    document.getElementById("threadCallBtn").classList.add("vis-hidden");

    showScreen("thread");
    document.getElementById("msgInput").value="";
    cancelImagePreview();
    closeAttachMenu();
    updateSendBtn();
    renderMessages();
  }

  function updateThreadStatusLine(contact){
    const statusEl = document.getElementById("threadStatus");
    if(contact && contact.online){
      statusEl.textContent = "онлайн";
      statusEl.classList.add("online");
    } else {
      statusEl.textContent = (contact && contact.status) || "не в сети";
      statusEl.classList.remove("online");
    }
  }

  function renderWaveBars(container, count, played){
    container.innerHTML = "";
    for(let i=0;i<count;i++){
      const bar = document.createElement("span");
      const h = 5 + Math.round(Math.sin(i*0.7)*4 + Math.random()*5) + 3;
      bar.style.height = Math.max(4,Math.min(20,h))+"px";
      if(played!==undefined && i<played) bar.classList.add("played");
      container.appendChild(bar);
    }
  }

  function buildBubbleInner(m){
    const time = formatClock(m.ts);
    if(m.type==="image"){
      return `<img class="bubble-image" src="${m.mediaUrl}" alt="Изображение"><div class="b-time">${time}</div>`;
    }
    if(m.type==="audio"){
      const dur = m.duration||0;
      const mins = Math.floor(dur/60), secs = (dur%60).toString().padStart(2,"0");
      return `<div class="audio-msg">
          <div class="audio-play-btn" data-audio-toggle="${m.id}">
            <svg viewBox="0 0 24 24" fill="none" width="15" height="15"><path d="M5 3l16 9-16 9V3z" fill="currentColor"/></svg>
          </div>
          <div class="audio-wave-track" id="wave-${m.id}"></div>
          <div class="audio-duration">${mins}:${secs}</div>
        </div><div class="b-time" style="text-align:right;margin-top:2px;">${time}</div>`;
    }
    return `${escapeHtml(m.text)}<div class="b-time">${time}</div>`;
  }

  function renderMessages(){
    const area = document.getElementById("messagesArea");
    area.innerHTML = "";
    const list = currentThreadIsSaved ? favoritesCache : (messagesCache[currentThreadPhone] || []);

    if(list.length===0){
      area.innerHTML = currentThreadIsSaved
        ? `<div class="empty-state" style="flex:1;">
            <div class="e-icon">⭐</div>
            <div class="e-title">Здесь пока пусто</div>
            <div class="e-sub">Пишите себе текст, сохраняйте фото или голосовые заметки — это личное место, видно только вам.</div>
          </div>`
        : `<div class="empty-state" style="flex:1;">
            <div class="e-icon">👋</div>
            <div class="e-title">Начните переписку</div>
            <div class="e-sub">Отправьте текст, фото или голосовое сообщение.</div>
          </div>`;
      return;
    }

    list.forEach(m=>{
      const isMine = currentThreadIsSaved ? true : (m.from===me.phone);
      const row = document.createElement("div");
      row.className = "msg-row" + (isMine ? " mine":"");
      const bubble = document.createElement("div");
      bubble.className = "bubble " + (isMine ? "mine":"theirs") + (m.type==="image" ? " has-image":"");
      bubble.innerHTML = buildBubbleInner(m);

      if(!currentThreadIsSaved){
        attachLongPress(bubble, ()=> openMsgContext(m));
      }
      if(m.type==="audio"){
        bubble.querySelector("[data-audio-toggle]").addEventListener("click",(e)=>{
          e.stopPropagation();
          toggleAudioPlayback(m);
        });
        renderWaveBars(bubble.querySelector(".audio-wave-track"), 22);
      }
      row.appendChild(bubble);
      area.appendChild(row);
    });
    area.scrollTop = area.scrollHeight;
  }

  function attachLongPress(el, callback){
    let timer = null, moved=false;
    const start = ()=>{ moved=false; timer=setTimeout(()=>{ if(!moved) callback(); },480); };
    const cancel = ()=> clearTimeout(timer);
    el.addEventListener("touchstart", start, {passive:true});
    el.addEventListener("touchend", cancel);
    el.addEventListener("touchmove", ()=>{ moved=true; cancel(); }, {passive:true});
    el.addEventListener("mousedown", start);
    el.addEventListener("mouseup", cancel);
    el.addEventListener("mouseleave", cancel);
  }

  let activeAudioEl = null, activeAudioMsgId = null;
  function toggleAudioPlayback(m){
    const waveEl = document.getElementById("wave-"+m.id);
    if(activeAudioMsgId===m.id){
      if(activeAudioEl) activeAudioEl.pause();
      activeAudioMsgId = null;
      return;
    }
    if(activeAudioEl) activeAudioEl.pause();
    if(!m.mediaUrl){ toast("Запись недоступна"); return; }
    const audio = new Audio(m.mediaUrl);
    activeAudioEl = audio; activeAudioMsgId = m.id;
    audio.addEventListener("timeupdate", ()=>{
      if(!waveEl) return;
      const ratio = audio.duration ? audio.currentTime/audio.duration : 0;
      renderWaveBars(waveEl, 22, Math.round(ratio*22));
    });
    audio.addEventListener("ended", ()=>{ activeAudioMsgId=null; if(waveEl) renderWaveBars(waveEl,22); });
    audio.play().catch(()=>{ toast("Не удалось воспроизвести запись"); activeAudioMsgId=null; });
  }

  /* ---- контекстное меню сообщения: избранное / копировать / удалить ---- */
  let contextMsgRef = null;
  function openMsgContext(m){
    contextMsgRef = m;
    const preview = document.getElementById("msgContextPreview");
    preview.innerHTML = "";
    const bubble = document.createElement("div");
    bubble.className = "bubble " + (m.from===me.phone ? "mine":"theirs") + (m.type==="image" ? " has-image":"");
    bubble.innerHTML = buildBubbleInner(m);
    preview.appendChild(bubble);
    if(m.type==="audio") renderWaveBars(bubble.querySelector(".audio-wave-track"), 22);
    document.getElementById("ctxToggleFavLabel").textContent = "В избранное";
    document.getElementById("ctxCopyBtn").style.display = m.type==="text" ? "" : "none";
    document.getElementById("ctxDeleteBtn").style.display = (m.from===me.phone) ? "" : "none";
    document.getElementById("msgContextOverlay").classList.add("show");
  }
  function closeMsgContext(){
    document.getElementById("msgContextOverlay").classList.remove("show");
    contextMsgRef = null;
  }
  document.getElementById("msgContextOverlay").addEventListener("click", (e)=>{
    if(e.target.id==="msgContextOverlay") closeMsgContext();
  });
  document.getElementById("ctxToggleFavBtn").addEventListener("click", async ()=>{
    if(!contextMsgRef) return;
    try{
      await api("POST","/api/favorites", {
        type: contextMsgRef.type,
        text: contextMsgRef.text,
        mediaUrl: contextMsgRef.mediaUrl,
        duration: contextMsgRef.duration
      });
      await loadFavorites();
      toast("Добавлено в избранное");
    }catch(e){ toast(e.message); }
    closeMsgContext();
  });
  document.getElementById("ctxCopyBtn").addEventListener("click", ()=>{
    if(!contextMsgRef) return;
    const text = contextMsgRef.text || "";
    if(navigator.clipboard && navigator.clipboard.writeText){
      navigator.clipboard.writeText(text).then(()=>toast("Текст скопирован")).catch(()=>toast("Не удалось скопировать"));
    } else { toast("Копирование недоступно в этом браузере"); }
    closeMsgContext();
  });
  document.getElementById("ctxDeleteBtn").addEventListener("click", ()=>{
    // Удаление чужих сообщений с сервера не поддерживается намеренно —
    // только локальная пометка/просмотр; здесь убираем только из своего вида.
    toast("Удаление сообщений на сервере недоступно в этой демо-версии");
    closeMsgContext();
  });

  /* ---- ввод текста и отправка ---- */
  const msgInput = document.getElementById("msgInput");
  msgInput.addEventListener("input", ()=>{
    msgInput.style.height="auto";
    msgInput.style.height = Math.min(msgInput.scrollHeight,100)+"px";
    updateSendBtn();
  });
  function updateSendBtn(){
    const hasText = msgInput.value.trim().length>0;
    const hasImage = !!pendingImageDataUrl;
    document.getElementById("sendMsgBtn").disabled = !(hasText||hasImage);
    document.getElementById("sendMsgBtn").classList.toggle("vis-hidden", !(hasText||hasImage) && !isRecording);
    document.getElementById("micBtn").classList.toggle("vis-hidden", (hasText||hasImage) || isRecording);
  }
  document.getElementById("sendMsgBtn").addEventListener("click", sendMessage);
  msgInput.addEventListener("keydown", (e)=>{
    if(e.key==="Enter" && !e.shiftKey){ e.preventDefault(); sendMessage(); }
  });

  async function sendMessage(){
    const text = msgInput.value.trim();
    let imageToSend = pendingImageDataUrl;
    cancelImagePreview();

    if(imageToSend){
      try{
        const up = await api("POST","/api/upload", { dataUrl: imageToSend, kind:"image" });
        await dispatchOutgoing({ type:"image", mediaUrl: up.url });
      }catch(e){ toast(e.message || "Не удалось отправить фото"); }
    }
    if(text){
      msgInput.value=""; msgInput.style.height="auto";
      await dispatchOutgoing({ type:"text", text });
    }
    updateSendBtn();
  }

  async function dispatchOutgoing(messagePart){
    if(currentThreadIsSaved){
      try{
        const data = await api("POST","/api/favorites", messagePart);
        favoritesCache.push(data.message);
        renderMessages();
        renderChatList();
      }catch(e){ toast(e.message); }
      return;
    }
    const tempId = "tmp"+Date.now()+Math.random();
    const optimistic = Object.assign({ id: tempId, from: me.phone, ts: Date.now() }, messagePart);
    if(!messagesCache[currentThreadPhone]) messagesCache[currentThreadPhone] = [];
    messagesCache[currentThreadPhone].push(optimistic);
    renderMessages();
    wsSend("chat:send", { toPhone: currentThreadPhone, message: Object.assign({ tempId }, messagePart) });
    renderChatListSoon();
  }

  let chatListSoonTimer = null;
  function renderChatListSoon(){
    clearTimeout(chatListSoonTimer);
    chatListSoonTimer = setTimeout(refreshChatList, 400);
  }

  document.getElementById("threadNameBlock").addEventListener("click", ()=>{
    if(!currentThreadIsSaved) toast(`${contactsCache[currentThreadPhone].name} · ${currentThreadPhone}`);
  });
  document.getElementById("threadFavBtn").addEventListener("click", ()=>{}); // зарезервировано

  /* ---- меню вложений (фото / аудио) ---- */
  const attachMenu = document.getElementById("attachMenu");
  function closeAttachMenu(){ attachMenu.classList.remove("open"); }
  document.getElementById("attachToggleBtn").addEventListener("click", (e)=>{
    e.stopPropagation();
    attachMenu.classList.toggle("open");
  });
  document.addEventListener("click", (e)=>{
    if(!attachMenu.contains(e.target) && e.target.id!=="attachToggleBtn") closeAttachMenu();
  });

  const photoFileInput = document.getElementById("photoFileInput");
  document.getElementById("attachPhotoBtn").addEventListener("click", ()=>{
    closeAttachMenu();
    photoFileInput.click();
  });
  photoFileInput.addEventListener("change", (e)=>{
    const file = e.target.files[0];
    if(!file) return;
    readImageFileAsDataUrl(file, 1000, (dataUrl)=>{
      pendingImageDataUrl = dataUrl;
      document.getElementById("imagePreviewThumb").src = dataUrl;
      document.getElementById("imagePreviewBar").classList.add("active");
      updateSendBtn();
      msgInput.focus();
    });
    e.target.value = "";
  });
  function cancelImagePreview(){
    pendingImageDataUrl = null;
    document.getElementById("imagePreviewBar").classList.remove("active");
    document.getElementById("imagePreviewThumb").src = "";
    updateSendBtn();
  }
  document.getElementById("cancelImagePreview").addEventListener("click", cancelImagePreview);

  /* ---- запись голосовых сообщений ---- */
  let mediaRecorder = null, recordedChunks = [], recordingStartTs = 0, recordingTimerInterval = null;
  let isRecording = false, recordingCancelled = false;

  document.getElementById("attachAudioBtn").addEventListener("click", ()=>{ closeAttachMenu(); startRecording(); });
  document.getElementById("micBtn").addEventListener("click", ()=>{
    if(isRecording) stopRecording(false); else startRecording();
  });

  function startRecording(){
    if(!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia){
      toast("Запись звука не поддерживается этим браузером");
      return;
    }
    navigator.mediaDevices.getUserMedia({ audio:true }).then(stream=>{
      recordedChunks = []; recordingCancelled = false;
      try{ mediaRecorder = new MediaRecorder(stream); }
      catch(err){ toast("Не удалось начать запись"); stream.getTracks().forEach(t=>t.stop()); return; }
      mediaRecorder.ondataavailable = (e)=>{ if(e.data.size>0) recordedChunks.push(e.data); };
      mediaRecorder.onstop = ()=>{ stream.getTracks().forEach(t=>t.stop()); finishRecording(); };
      mediaRecorder.start();
      isRecording = true;
      recordingStartTs = Date.now();
      enterRecordingUI();
      recordingTimerInterval = setInterval(updateRecTimer, 200);
    }).catch(()=> toast("Нет доступа к микрофону — проверьте разрешения браузера"));
  }
  function enterRecordingUI(){
    document.getElementById("recordingRow").classList.add("active");
    msgInput.classList.add("vis-hidden");
    document.getElementById("attachToggleBtn").classList.add("vis-hidden");
    document.getElementById("sendMsgBtn").classList.add("vis-hidden");
    document.getElementById("micBtn").classList.remove("vis-hidden");
    document.getElementById("micBtn").style.background = "var(--danger)";
    renderWaveBars(document.getElementById("recWave"), 28);
  }
  function exitRecordingUI(){
    document.getElementById("recordingRow").classList.remove("active");
    msgInput.classList.remove("vis-hidden");
    document.getElementById("attachToggleBtn").classList.remove("vis-hidden");
    document.getElementById("micBtn").style.background = "var(--accent)";
    updateSendBtn();
  }
  function updateRecTimer(){
    const secs = Math.floor((Date.now()-recordingStartTs)/1000);
    const m = Math.floor(secs/60), s=(secs%60).toString().padStart(2,"0");
    document.getElementById("recTime").textContent = m+":"+s;
    renderWaveBars(document.getElementById("recWave"), 28);
    if(secs>=120) stopRecording(false);
  }
  function stopRecording(cancelled){
    if(!isRecording || !mediaRecorder) return;
    recordingCancelled = !!cancelled;
    isRecording = false;
    clearInterval(recordingTimerInterval);
    mediaRecorder.stop();
  }
  function finishRecording(){
    exitRecordingUI();
    if(recordingCancelled){ recordedChunks=[]; return; }
    const durationSec = Math.max(1, Math.round((Date.now()-recordingStartTs)/1000));
    const blob = new Blob(recordedChunks, { type: mediaRecorder.mimeType || "audio/webm" });
    const reader = new FileReader();
    reader.onload = async ()=>{
      try{
        const up = await api("POST","/api/upload", { dataUrl: reader.result, kind:"audio" });
        await dispatchOutgoing({ type:"audio", mediaUrl: up.url, duration: durationSec });
      }catch(e){ toast(e.message || "Не удалось отправить запись"); }
    };
    reader.readAsDataURL(blob);
  }
  document.querySelector(".rec-cancel-label").addEventListener("click", ()=>{ if(isRecording) stopRecording(true); });

  /* ============================================================
     ИЗБРАННОЕ (личные заметки себе — отдельный чат)
  ============================================================ */
  async function loadFavorites(){
    try{
      const data = await api("GET","/api/favorites");
      favoritesCache = data.messages;
    }catch(e){ /* тихо игнорируем, не критично для остального интерфейса */ }
  }

  /* ============================================================
     ПРОФИЛЬ
  ============================================================ */
  function renderProfileScreen(){
    if(!me) return;
    document.getElementById("profileAvatarLg").innerHTML="";
    document.getElementById("profileAvatarLg").appendChild(avatarEl(me, "lg"));
    document.getElementById("profileNameDisplay").textContent = me.name;
    document.getElementById("profilePhoneDisplay").textContent = me.phone;
    document.getElementById("rowNameValue").textContent = me.name;
    document.getElementById("rowStatusValue").textContent = truncate(me.status,18);
    document.getElementById("rowPhoneValue").textContent = me.phone;
  }

  let editFieldMode = null;
  function openEditField(mode){
    editFieldMode = mode;
    const title = document.getElementById("editFieldTitle");
    const label = document.getElementById("editFieldLabel");
    const input = document.getElementById("editFieldInput");
    const textarea = document.getElementById("editFieldTextarea");
    const charCount = document.getElementById("editFieldCharCount");
    document.getElementById("editFieldError").classList.remove("show");
    if(mode==="name"){
      title.textContent="Имя"; label.textContent="Имя";
      input.classList.remove("vis-hidden"); textarea.classList.add("vis-hidden"); charCount.classList.add("vis-hidden");
      input.value = me.name;
      setTimeout(()=>input.focus(),300);
    } else {
      title.textContent="О себе"; label.textContent="Статус";
      input.classList.add("vis-hidden"); textarea.classList.remove("vis-hidden"); charCount.classList.remove("vis-hidden");
      textarea.value = me.status;
      charCount.textContent = textarea.value.length+" / 140";
      setTimeout(()=>textarea.focus(),300);
    }
    showScreen("editField");
  }
  document.getElementById("editNameRow").addEventListener("click", ()=>openEditField("name"));
  document.getElementById("editStatusRow").addEventListener("click", ()=>openEditField("status"));
  document.getElementById("editFieldTextarea").addEventListener("input",(e)=>{
    document.getElementById("editFieldCharCount").textContent = e.target.value.length+" / 140";
  });
  document.getElementById("saveFieldBtn").addEventListener("click", async ()=>{
    try{
      if(editFieldMode==="name"){
        const v = document.getElementById("editFieldInput").value.trim();
        if(!v){ document.getElementById("editFieldError").classList.add("show"); return; }
        const data = await api("PUT","/api/me", { name: v });
        me = data.user;
      } else {
        const v = document.getElementById("editFieldTextarea").value.trim();
        const data = await api("PUT","/api/me", { status: v || "Привет! Я в мессенджере «Связь»" });
        me = data.user;
      }
      renderProfileScreen();
      toast("Сохранено");
      goBack("profile");
    }catch(e){ toast(e.message); }
  });

  /* ---- смена номера телефона ---- */
  const editPhoneInput = document.getElementById("editPhoneInput");
  document.getElementById("editPhoneRow").addEventListener("click", ()=>{
    editPhoneInput.value="";
    document.getElementById("editPhoneError").classList.remove("show");
    showScreen("editPhone");
    setTimeout(()=>editPhoneInput.focus(),300);
  });
  editPhoneInput.addEventListener("input", ()=>{
    const {digits} = fullPhoneFromInput(editPhoneInput.value);
    editPhoneInput.value = formatRuPhone(digits);
    document.getElementById("editPhoneError").classList.remove("show");
  });
  document.getElementById("savePhoneBtn").addEventListener("click", async ()=>{
    const {full} = fullPhoneFromInput(editPhoneInput.value);
    if(!full){ document.getElementById("editPhoneError").classList.add("show"); return; }
    if(full===me.phone){ toast("Это уже ваш текущий номер"); return; }
    try{
      const data = await api("POST","/api/auth/request-code", { phone: full });
      pendingNewPhone = full;
      document.getElementById("editPhoneCodeTarget").textContent = full;
      resetCodeInput("editCodeHiddenInput","editCodeRow");
      showScreen("editPhoneCode");
      if(data.devCode) toast(`Демо-режим: код ${data.devCode}`);
    }catch(e){ toast(e.message); }
  });
  setupCodeEntry("editCodeHiddenInput","editCodeRow", async (code)=>{
    try{
      const data = await api("POST","/api/me/change-phone", { newPhone: pendingNewPhone, code });
      me = data.user;
      session.phone = me.phone;
      saveSession();
      connectWebSocket(); // переподключаемся под новым номером
      renderProfileScreen();
      toast("Номер телефона обновлён");
      screenStack = screenStack.filter(s=>!["editPhone","editPhoneCode"].includes(s));
      goBack("profile");
    }catch(e){ toast(e.message || "Не удалось подтвердить код"); }
  });

  /* ---- фото и цвет профиля ---- */
  let editColorChoice = null;
  let editAvatarDataUrl = null; // новое фото, если выбрано
  let editAvatarRemoved = false;

  function renderEditAvatarPreview(){
    const circle = document.getElementById("colorPreviewCircle");
    const span = document.getElementById("colorPreviewInitial");
    let img = circle.querySelector("img");
    if(editAvatarDataUrl || (me.avatarUrl && !editAvatarRemoved)){
      const src = editAvatarDataUrl || me.avatarUrl;
      if(!img){
        img = document.createElement("img");
        img.style.width="100%"; img.style.height="100%"; img.style.objectFit="cover"; img.style.borderRadius="50%";
        circle.insertBefore(img, circle.firstChild);
      }
      img.src = src;
      span.style.display = "none";
    } else {
      if(img) img.remove();
      span.style.display = "";
      circle.style.background = editColorChoice;
      circle.style.borderColor = editColorChoice;
    }
  }
  document.getElementById("editColorRow").addEventListener("click", ()=>{
    editColorChoice = me.color;
    editAvatarDataUrl = null;
    editAvatarRemoved = false;
    renderEditSwatches();
    document.getElementById("colorPreviewCircle").style.borderStyle = "solid";
    document.getElementById("colorPreviewInitial").textContent = initials(me.name);
    renderEditAvatarPreview();
    showScreen("editColor");
  });
  function renderEditSwatches(){
    const wrap = document.getElementById("editSwatches");
    wrap.innerHTML = "";
    AVATAR_COLORS.forEach(c=>{
      const sw = document.createElement("div");
      sw.className = "swatch" + (c===editColorChoice ? " active":"");
      sw.style.background = c;
      sw.addEventListener("click", ()=>{
        editColorChoice = c;
        editAvatarDataUrl = null;
        editAvatarRemoved = true;
        wrap.querySelectorAll(".swatch").forEach(s=>s.classList.remove("active"));
        sw.classList.add("active");
        renderEditAvatarPreview();
      });
      wrap.appendChild(sw);
    });
  }
  document.getElementById("colorPreviewCircle").addEventListener("click", ()=> document.getElementById("editAvatarFileInput").click());
  document.getElementById("editChoosePhotoBtn").addEventListener("click", ()=> document.getElementById("editAvatarFileInput").click());
  document.getElementById("editAvatarFileInput").addEventListener("change", (e)=>{
    const file = e.target.files[0];
    if(!file) return;
    readImageFileAsDataUrl(file, 500, (dataUrl)=>{
      editAvatarDataUrl = dataUrl;
      editAvatarRemoved = false;
      renderEditAvatarPreview();
      toast("Фото выбрано");
    });
    e.target.value = "";
  });
  document.getElementById("editRemovePhotoBtn").addEventListener("click", ()=>{
    editAvatarDataUrl = null;
    editAvatarRemoved = true;
    renderEditAvatarPreview();
  });
  document.getElementById("saveColorBtn").addEventListener("click", async ()=>{
    try{
      let avatarUrl = me.avatarUrl;
      if(editAvatarDataUrl){
        const up = await api("POST","/api/upload", { dataUrl: editAvatarDataUrl, kind:"image" });
        avatarUrl = up.url;
      } else if(editAvatarRemoved){
        avatarUrl = null;
      }
      const data = await api("PUT","/api/me", { color: editColorChoice, avatarUrl });
      me = data.user;
      renderProfileScreen();
      toast("Профиль обновлён");
      goBack("profile");
    }catch(e){ toast(e.message); }
  });

  /* ---- выход из аккаунта ---- */
  function logoutToWelcome(){
    clearSession();
    if(ws) try{ ws.close(); }catch(e){}
    screenStack = ["welcome"];
    Object.values(screens).forEach(s=>s.classList.add("hidden"));
    screens.welcome.classList.remove("hidden");
    phoneInput.value="";
  }
  document.getElementById("logoutRow").addEventListener("click", ()=>{
    if(confirm("Выйти из аккаунта на этом устройстве?")) logoutToWelcome();
  });

  /* ============================================================
     АУДИОЗВОНКИ ЧЕРЕЗ WEBRTC
     Сервер тут выступает только "почтальоном" для служебных сообщений
     (кто звонит, SDP-предложение/ответ, ICE-кандидаты) — сам звуковой
     поток после соединения идёт напрямую между браузерами (peer-to-peer),
     поэтому качество звука не зависит от мощности сервера.
  ============================================================ */
  const ICE_SERVERS = [{ urls: "stun:stun.l.google.com:19302" }];
  // ^ публичный STUN-сервер Google — помогает двум браузерам найти друг
  // друга через NAT. Для звонков между сетями, где STUN не справляется
  // (строгие корпоративные/мобильные NAT), в реальном продукте дополнительно
  // нужен TURN-сервер (например, через coturn или платный сервис).

  let rtcConn = null;
  let localStream = null;
  let currentCallId = null;
  let currentCallPhone = null;
  let currentCallRole = null; // "caller" | "callee"
  let callTimerInterval = null;
  let callStartTs = null;
  let isMuted = false;

  function genCallId(){ return "call_"+Date.now()+"_"+Math.random().toString(36).slice(2,8); }

  function showCallScreen(){ document.getElementById("callScreen").classList.add("show"); }
  function hideCallScreen(){
    document.getElementById("callScreen").classList.remove("show");
    document.getElementById("callAvatarRing").classList.remove("ringing");
    clearInterval(callTimerInterval);
  }

  function setCallUiForContact(phone, name, color, avatarUrl){
    const slot = document.getElementById("callAvatarSlot");
    slot.innerHTML = "";
    slot.appendChild(avatarEl({ name, color, avatarUrl }, ""));
    document.getElementById("callName").textContent = name;
  }

  document.getElementById("threadCallBtn").addEventListener("click", startOutgoingCall);

  async function startOutgoingCall(){
    if(currentCallId){ toast("Звонок уже идёт"); return; }
    const contact = contactsCache[currentThreadPhone];
    if(!contact){ return; }
    if(!contact.online){ toast(`${contact.name} сейчас не в сети`); return; }

    try{
      localStream = await navigator.mediaDevices.getUserMedia({ audio:true });
    }catch(e){
      toast("Нет доступа к микрофону — проверьте разрешения браузера");
      return;
    }

    currentCallId = genCallId();
    currentCallPhone = currentThreadPhone;
    currentCallRole = "caller";

    setCallUiForContact(contact.phone, contact.name, contact.color, contact.avatarUrl);
    document.getElementById("callStatus").textContent = "вызов...";
    document.getElementById("callStatus").classList.remove("live");
    document.getElementById("callAvatarRing").classList.add("ringing");
    document.getElementById("callControlsActive").classList.remove("vis-hidden");
    document.getElementById("callControlsIncoming").classList.add("vis-hidden");
    showCallScreen();

    wsSend("call:invite", { toPhone: contact.phone, callId: currentCallId });
  }

  function handleCallUnavailable(payload){
    if(payload.toPhone!==currentCallPhone) return;
    toast("Собеседник недоступен для звонка");
    teardownCall();
  }

  function handleIncomingCall(payload){
    if(currentCallId){
      // Уже в звонке — автоматически отклоняем новый встречный вызов.
      wsSend("call:decline", { toPhone: payload.fromPhone, callId: payload.callId });
      return;
    }
    currentCallId = payload.callId;
    currentCallPhone = payload.fromPhone;
    currentCallRole = "callee";

    const contact = contactsCache[payload.fromPhone] || { phone: payload.fromPhone, name: payload.fromName, color: payload.fromColor };
    setCallUiForContact(contact.phone, payload.fromName, payload.fromColor, contact.avatarUrl);
    document.getElementById("callStatus").textContent = "входящий звонок";
    document.getElementById("callStatus").classList.remove("live");
    document.getElementById("callAvatarRing").classList.add("ringing");
    document.getElementById("callControlsActive").classList.add("vis-hidden");
    document.getElementById("callControlsIncoming").classList.remove("vis-hidden");
    showCallScreen();
  }

  document.getElementById("callAcceptBtn").addEventListener("click", async ()=>{
    try{
      localStream = await navigator.mediaDevices.getUserMedia({ audio:true });
    }catch(e){
      toast("Нет доступа к микрофону");
      wsSend("call:decline", { toPhone: currentCallPhone, callId: currentCallId });
      teardownCall();
      return;
    }
    document.getElementById("callControlsIncoming").classList.add("vis-hidden");
    document.getElementById("callControlsActive").classList.remove("vis-hidden");
    document.getElementById("callAvatarRing").classList.remove("ringing");
    document.getElementById("callStatus").textContent = "соединение...";
    wsSend("call:accept", { toPhone: currentCallPhone, callId: currentCallId });
    await setupPeerConnection();
    // У принимающей стороны соединение создаётся, но именно звонящий
    // первым формирует SDP-предложение (см. handleCallAccepted).
  });

  document.getElementById("callDeclineBtn").addEventListener("click", ()=>{
    wsSend("call:decline", { toPhone: currentCallPhone, callId: currentCallId });
    teardownCall();
  });

  async function handleCallAccepted(payload){
    if(payload.callId!==currentCallId || currentCallRole!=="caller") return;
    document.getElementById("callAvatarRing").classList.remove("ringing");
    document.getElementById("callStatus").textContent = "соединение...";
    await setupPeerConnection();
    const offer = await rtcConn.createOffer();
    await rtcConn.setLocalDescription(offer);
    wsSend("call:sdp", { toPhone: currentCallPhone, callId: currentCallId, sdp: offer });
  }

  function handleCallDeclined(payload){
    if(payload.callId!==currentCallId) return;
    toast("Звонок отклонён");
    teardownCall();
  }
  function handleCallCancelled(payload){
    if(payload.callId!==currentCallId) return;
    toast("Звонок отменён");
    teardownCall();
  }
  function handleRemoteHangup(payload){
    if(payload.callId!==currentCallId) return;
    toast("Собеседник завершил звонок");
    teardownCall();
  }

  async function setupPeerConnection(){
    rtcConn = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    localStream.getTracks().forEach(track=> rtcConn.addTrack(track, localStream));

    rtcConn.ontrack = (event)=>{
      const audioEl = document.getElementById("remoteAudioEl");
      audioEl.srcObject = event.streams[0];
      document.getElementById("callStatus").textContent = "00:00";
      document.getElementById("callStatus").classList.add("live");
      callStartTs = Date.now();
      clearInterval(callTimerInterval);
      callTimerInterval = setInterval(()=>{
        const s = Math.floor((Date.now()-callStartTs)/1000);
        const mm = Math.floor(s/60).toString().padStart(2,"0");
        const ss = (s%60).toString().padStart(2,"0");
        document.getElementById("callStatus").textContent = `${mm}:${ss}`;
      }, 1000);
    };
    rtcConn.onicecandidate = (event)=>{
      if(event.candidate){
        wsSend("call:ice", { toPhone: currentCallPhone, callId: currentCallId, candidate: event.candidate });
      }
    };
    rtcConn.onconnectionstatechange = ()=>{
      if(["failed","disconnected","closed"].includes(rtcConn.connectionState)){
        if(currentCallId) { toast("Соединение прервано"); teardownCall(); }
      }
    };
  }

  async function handleRemoteSdp(payload){
    if(payload.callId!==currentCallId) return;
    if(!rtcConn) await setupPeerConnection();
    await rtcConn.setRemoteDescription(new RTCSessionDescription(payload.sdp));
    if(payload.sdp.type==="offer"){
      const answer = await rtcConn.createAnswer();
      await rtcConn.setLocalDescription(answer);
      wsSend("call:sdp", { toPhone: payload.fromPhone, callId: currentCallId, sdp: answer });
    }
  }
  async function handleRemoteIce(payload){
    if(payload.callId!==currentCallId || !rtcConn) return;
    try{ await rtcConn.addIceCandidate(new RTCIceCandidate(payload.candidate)); }catch(e){}
  }

  document.getElementById("callHangupBtn").addEventListener("click", ()=>{
    if(currentCallPhone){
      wsSend(currentCallRole==="caller" && document.getElementById("callStatus").textContent==="вызов..." ? "call:cancel" : "call:hangup",
        { toPhone: currentCallPhone, callId: currentCallId });
    }
    teardownCall();
  });

  document.getElementById("callMuteBtn").addEventListener("click", ()=>{
    if(!localStream) return;
    isMuted = !isMuted;
    localStream.getAudioTracks().forEach(t=> t.enabled = !isMuted);
    document.getElementById("callMuteBtn").classList.toggle("active", isMuted);
  });
  document.getElementById("callSpeakerBtn").addEventListener("click", (e)=>{
    // Переключение "громкой связи" зависит от устройства/браузера и не
    // всегда программно управляемо через web-API — оставляем как
    // визуальный тоггл совместимости с системным выводом звука.
    e.currentTarget.classList.toggle("active");
  });

  function teardownCall(){
    if(rtcConn){ try{ rtcConn.close(); }catch(e){} rtcConn=null; }
    if(localStream){ localStream.getTracks().forEach(t=>t.stop()); localStream=null; }
    document.getElementById("remoteAudioEl").srcObject = null;
    currentCallId = null;
    currentCallPhone = null;
    currentCallRole = null;
    isMuted = false;
    document.getElementById("callMuteBtn").classList.remove("active");
    hideCallScreen();
  }

  /* ============================================================
     СТАРТ ПРИЛОЖЕНИЯ
  ============================================================ */
  loadSession();
  if(session.phone && session.token){
    api("GET","/api/me").then(async (data)=>{
      me = data.user;
      await loadFavorites();
      await enterApp();
    }).catch(()=>{
      clearSession();
      screens.welcome.classList.remove("hidden");
    });
  } else {
    screens.welcome.classList.remove("hidden");
  }

})();
