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

  let me = null;
  let chatsCache = [];
  let messagesCache = {};
  let contactsCache = {};
  let groupsCache = {};
  let favoritesCache = [];
  let stickersCache = [];
  let groupMemberSelection = [];
  let pendingPhone = null;
  let pendingNewPhone = null;

  const EMOJI_SET = [
    "😀","😁","😂","🤣","😊","😍","🥰","😘","😎","🤩","🥳","😇",
    "🙂","🙃","😉","😋","😜","🤪","😏","😒","😞","😢","😭","😡",
    "🤔","🤨","😴","🥱","😱","😳","🤯","🥶","🤗","🤭","🤫","🫡",
    "👍","👎","👏","🙌","🙏","💪","👋","🤝","✌️","🤞","👌","✋",
    "❤️","🧡","💛","💚","💙","💜","🖤","🤍","💔","💯","🔥","✨",
    "🎉","🎊","🎁","🎂","🌹","🌸","☀️","🌙","⭐","⚡","🌈","☕",
    "🍕","🍔","🍎","🍓","🍿","🥳","🚀","🚗","✈️","🏠","📞","⏰",
    "📷","🎵","🎮","⚽","🏆","💰","💡","🔑","🔒","✅","❌","❓"
  ];

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
    if(msg.type==="sticker") return "🙂 Стикер";
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

  function avatarEl(contact, sizeClass, withOnlineDot){
    const div = document.createElement("div");
    div.className = "avatar " + (sizeClass||"");
    if(contact && contact.isGroup){
      div.classList.add("group-icon");
      div.style.background = contact.color || "#6C8CFF";
      div.innerHTML = `<svg viewBox="0 0 24 24" fill="none" width="55%" height="55%"><circle cx="9" cy="8" r="3" stroke="#fff" stroke-width="2"/><circle cx="17" cy="9" r="2.5" stroke="#fff" stroke-width="2"/><path d="M3 19c0-3 2.7-5 6-5s6 2 6 5M15 14.5c2.5.3 4 1.7 4 4.5" stroke="#fff" stroke-width="2" stroke-linecap="round"/></svg>`;
      return div;
    }
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
      const data = await api("POST","/api/auth/verify-code", { phone: pendingPhone, code });
      session = { phone: pendingPhone, token: data.token };
      saveSession();
      me = data.user;
      await loadFavorites();
      await loadStickers();
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
      const reissue = await api("POST","/api/auth/request-code", { phone: pendingPhone });
      const code = reissue.devCode || "1234";
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
      await loadStickers();
      toast("Аккаунт создан");
      await enterApp();
    }catch(e){
      toast(e.message || "Не удалось завершить регистрацию");
      btn.disabled = false;
    }
  });

  let ws = null;
  let wsReconnectTimer = null;

  function connectWebSocket(){
    if(ws) { try{ ws.close(); }catch(e){} }
    ws = new WebSocket(`${WS_BASE}/ws?phone=${encodeURIComponent(session.phone)}&token=${encodeURIComponent(session.token)}`);

    ws.onopen = ()=>{ console.log("WS подключён"); };
    ws.onclose = ()=>{
      clearTimeout(wsReconnectTimer);
      wsReconnectTimer = setTimeout(connectWebSocket, 2000);
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
      if(payload.fromGroup){
        const key = "group:"+payload.fromGroup;
        if(!messagesCache[key]) messagesCache[key] = [];
        messagesCache[key].push(payload.message);
        if(currentThreadGroupId===payload.fromGroup){ renderMessages(); }
        else {
          const g = groupsCache[payload.fromGroup];
          toast(`Новое сообщение в группе «${g ? g.name : "группа"}»`);
        }
        refreshChatList();
        return;
      }
      const phone = payload.fromPhone;
      if(!messagesCache[phone]) messagesCache[phone] = [];
      messagesCache[phone].push(payload.message);
      if(currentThreadPhone===phone && !currentThreadGroupId){ renderMessages(); }
      else { toast(`Новое сообщение от ${contactsCache[phone] ? contactsCache[phone].name : phone}`); }
      refreshChatList();
      return;
    }
    if(type==="chat:ack"){
      return;
    }
    if(type==="presence"){
      if(contactsCache[payload.phone]) contactsCache[payload.phone].online = payload.online;
      if(currentThreadPhone===payload.phone) updateThreadStatusLine(contactsCache[payload.phone]);
      refreshChatList();
      return;
    }
    if(type==="group:added"){
      groupsCache[payload.group.id] = payload.group;
      toast(`Вас добавили в группу «${payload.group.name}»`);
      refreshChatList();
      return;
    }
    if(type==="group:member-joined"){
      const g = groupsCache[payload.groupId];
      if(g && !g.members.includes(payload.phone)) g.members.push(payload.phone);
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
      row.appendChild(avatarEl(contact, "", contact.isGroup ? undefined : contact.online));
      const meta = document.createElement("div");
      meta.className = "chat-meta";
      meta.innerHTML = `
        <div class="chat-top-line">
          <div class="chat-name">${escapeHtml(contact.name)}</div>
          <div class="chat-time">${lastMessage ? formatClock(lastMessage.ts) : ""}</div>
        </div>
        <div class="chat-preview">${lastMessage ? ((lastMessage.from===me.phone ? "Вы: " : (contact.isGroup ? escapeHtml(nameForSender(lastMessage.from))+": " : ""))+escapeHtml(previewTextFor(lastMessage))) : "Нет сообщений"}</div>
      `;
      row.appendChild(meta);
      if(contact.isGroup){
        groupsCache[contact.id] = contact;
        row.addEventListener("click", ()=> openGroupThread(contact.id));
      } else {
        row.addEventListener("click", ()=> openThread(contact.phone));
      }
      wrap.appendChild(row);
    });
  }

  function nameForSender(phone){
    if(phone===me.phone) return "Вы";
    return (contactsCache[phone] && contactsCache[phone].name) || "Участник";
  }

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
  let currentThreadPhone = null;
  let currentThreadIsSaved = false;
  let currentThreadGroupId = null;
  let pendingImageDataUrl = null;

  async function openThread(phone){
    currentThreadPhone = phone;
    currentThreadIsSaved = false;
    currentThreadGroupId = null;
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
    closeComposerPanel();
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

  async function openGroupThread(groupId){
    currentThreadPhone = null;
    currentThreadIsSaved = false;
    currentThreadGroupId = groupId;
    const group = groupsCache[groupId];
    if(!group) return;

    const threadAvatarWrap = document.getElementById("threadAvatar");
    threadAvatarWrap.innerHTML = "";
    threadAvatarWrap.appendChild(avatarEl(group, "sm"));
    document.getElementById("threadName").textContent = group.name;
    const statusEl = document.getElementById("threadStatus");
    statusEl.textContent = `${group.members.length} участник${group.members.length===1?"":(group.members.length<5?"а":"ов")}`;
    statusEl.classList.remove("online");
    document.getElementById("threadFavBtn").classList.add("vis-hidden");
    document.getElementById("threadCallBtn").classList.add("vis-hidden");

    showScreen("thread");
    document.getElementById("msgInput").value="";
    cancelImagePreview();
    closeAttachMenu();
    closeComposerPanel();
    updateSendBtn();

    const key = "group:"+groupId;
    document.getElementById("messagesArea").innerHTML = `<div class="empty-state" style="flex:1;"><div class="e-icon">⏳</div><div class="e-title">Загрузка переписки…</div></div>`;
    try{
      const data = await api("GET", `/api/chats/${encodeURIComponent(key)}/messages`);
      messagesCache[key] = data.messages;
      renderMessages();
    }catch(e){
      toast(e.message || "Не удалось загрузить сообщения");
    }
  }

  function openSavedThread(){
    currentThreadPhone = SAVED_PHONE;
    currentThreadIsSaved = true;
    currentThreadGroupId = null;
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
    if(m.type==="sticker"){
      return `<img class="sticker-image" src="${m.mediaUrl}" alt="Стикер">`;
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
    const list = currentThreadIsSaved
      ? favoritesCache
      : (currentThreadGroupId ? (messagesCache["group:"+currentThreadGroupId] || []) : (messagesCache[currentThreadPhone] || []));

    if(list.length===0){
      area.innerHTML = currentThreadIsSaved
        ? `<div class="empty-state" style="flex:1;">
            <div class="e-icon">⭐</div>
            <div class="e-title">Здесь пока пусто</div>
            <div class="e-sub">Пишите себе текст, сохраняйте фото или голосовые заметки — это личное место, видно только вам.</div>
          </div>`
        : `<div class="empty-state" style="flex:1;">
            <div class="e-icon">👋</div>
            <div class="e-title">${currentThreadGroupId ? "Начните общение в группе" : "Начните переписку"}</div>
            <div class="e-sub">Отправьте текст, фото, стикер или голосовое сообщение.</div>
          </div>`;
      return;
    }

    list.forEach(m=>{
      const isMine = currentThreadIsSaved ? true : (m.from===me.phone);
      const row = document.createElement("div");
      row.className = "msg-row" + (isMine ? " mine":"");

      if(currentThreadGroupId && !isMine){
        const label = document.createElement("div");
        label.className = "msg-sender-label";
        label.textContent = nameForSender(m.from);
        label.style.color = (contactsCache[m.from] && contactsCache[m.from].color) || "var(--accent)";
        const col = document.createElement("div");
        col.style.display = "flex";
        col.style.flexDirection = "column";
        col.style.maxWidth = "75%";
        col.appendChild(label);
        const bubble = buildBubbleEl(m, isMine);
        col.appendChild(bubble);
        row.appendChild(col);
      } else {
        const bubble = buildBubbleEl(m, isMine);
        row.appendChild(bubble);
      }
      area.appendChild(row);
    });
    area.scrollTop = area.scrollHeight;
  }

  function buildBubbleEl(m, isMine){
    const bubble = document.createElement("div");
    bubble.className = "bubble " + (isMine ? "mine":"theirs") +
      (m.type==="image" ? " has-image":"") + (m.type==="sticker" ? " has-sticker":"");
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
    return bubble;
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
    toast("Удаление сообщений на сервере недоступно в этой демо-версии");
    closeMsgContext();
  });

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
    const cacheKey = currentThreadGroupId ? "group:"+currentThreadGroupId : currentThreadPhone;
    if(!messagesCache[cacheKey]) messagesCache[cacheKey] = [];
    messagesCache[cacheKey].push(optimistic);
    renderMessages();
    if(currentThreadGroupId){
      wsSend("chat:send", { toGroup: currentThreadGroupId, message: Object.assign({ tempId }, messagePart) });
    } else {
      wsSend("chat:send", { toPhone: currentThreadPhone, message: Object.assign({ tempId }, messagePart) });
    }
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
  document.getElementById("threadFavBtn").addEventListener("click", ()=>{});

  const attachMenu = document.getElementById("attachMenu");
  function closeAttachMenu(){ attachMenu.classList.remove("open"); }
  document.getElementById("attachToggleBtn").addEventListener("click", (e)=>{
    e.stopPropagation();
    closeComposerPanel();
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

  const composerPanel = document.getElementById("composerPanel");
  function closeComposerPanel(){ composerPanel.classList.remove("open"); }
  function toggleComposerPanel(){
    closeAttachMenu();
    composerPanel.classList.toggle("open");
    if(composerPanel.classList.contains("open")) renderStickerGrid();
  }
  document.getElementById("emojiToggleBtn").addEventListener("click", (e)=>{
    e.stopPropagation();
    toggleComposerPanel();
  });
  document.addEventListener("click", (e)=>{
    if(!composerPanel.contains(e.target) && e.target.id!=="emojiToggleBtn"){
      closeComposerPanel();
    }
  });

  const emojiGrid = document.getElementById("emojiGrid");
  EMOJI_SET.forEach(em=>{
    const btn = document.createElement("button");
    btn.className = "emoji-cell";
    btn.textContent = em;
    btn.addEventListener("click", ()=>{
      msgInput.value += em;
      msgInput.dispatchEvent(new Event("input"));
      msgInput.focus();
    });
    emojiGrid.appendChild(btn);
  });

  document.getElementById("emojiTabBtn").addEventListener("click", ()=> switchComposerTab("emoji"));
  document.getElementById("stickerTabBtn").addEventListener("click", ()=> switchComposerTab("sticker"));
  function switchComposerTab(tab){
    document.getElementById("emojiTabBtn").classList.toggle("active", tab==="emoji");
    document.getElementById("stickerTabBtn").classList.toggle("active", tab==="sticker");
    document.getElementById("emojiPanelBody").classList.toggle("vis-hidden", tab!=="emoji");
    document.getElementById("stickerPanelBody").classList.toggle("vis-hidden", tab!=="sticker");
    if(tab==="sticker") renderStickerGrid();
  }

  function renderStickerGrid(){
    const grid = document.getElementById("stickerGrid");
    grid.innerHTML = "";
    const addCell = document.createElement("button");
    addCell.className = "sticker-add-cell";
    addCell.textContent = "+";
    addCell.title = "Создать стикер из фото";
    addCell.addEventListener("click", ()=> document.getElementById("stickerFileInput").click());
    grid.appendChild(addCell);

    if(stickersCache.length===0){
      const hint = document.createElement("div");
      hint.className = "sticker-empty-hint";
      hint.style.gridColumn = "span 3";
      hint.textContent = "Нажмите «+», чтобы сделать свой первый стикер из фото";
      grid.appendChild(hint);
      return;
    }
    stickersCache.forEach(s=>{
      const cell = document.createElement("button");
      cell.className = "sticker-cell";
      cell.innerHTML = `<img src="${s.url}" alt="Стикер">`;
      cell.addEventListener("click", ()=>{
        closeComposerPanel();
        dispatchOutgoing({ type:"sticker", mediaUrl: s.url });
      });
      attachLongPress(cell, ()=>{
        if(confirm("Удалить этот стикер из вашего набора?")) deleteSticker(s.id);
      });
      grid.appendChild(cell);
    });
  }

  async function loadStickers(){
    try{
      const data = await api("GET","/api/stickers");
      stickersCache = data.stickers;
    }catch(e){ }
  }
  async function deleteSticker(id){
    try{
      await api("DELETE", "/api/stickers/"+encodeURIComponent(id));
      stickersCache = stickersCache.filter(s=>s.id!==id);
      renderStickerGrid();
      toast("Стикер удалён");
    }catch(e){ toast(e.message); }
  }

  let stickerSourceImg = null;
  let stickerZoom = 1;
  let stickerOffsetX = 0, stickerOffsetY = 0;
  let stickerDragState = null;

  document.getElementById("stickerFileInput").addEventListener("change", (e)=>{
    const file = e.target.files[0];
    if(!file) return;
    const reader = new FileReader();
    reader.onload = (ev)=>{
      const img = new Image();
      img.onload = ()=>{
        stickerSourceImg = img;
        stickerZoom = 1; stickerOffsetX = 0; stickerOffsetY = 0;
        document.getElementById("stickerZoomRange").value = 100;
        const previewImg = document.getElementById("stickerMakerImg");
        previewImg.src = ev.target.result;
        layoutStickerMakerImage();
        document.getElementById("stickerMakerOverlay").classList.add("show");
      };
      img.src = ev.target.result;
    };
    reader.readAsDataURL(file);
    e.target.value = "";
  });

  function layoutStickerMakerImage(){
    const stage = document.getElementById("stickerMakerStage");
    const img = document.getElementById("stickerMakerImg");
    const stageSize = stage.clientWidth || 300;
    const natW = stickerSourceImg.width, natH = stickerSourceImg.height;
    const baseScale = Math.max(stageSize/natW, stageSize/natH);
    const scale = baseScale * stickerZoom;
    img.style.width = (natW*scale)+"px";
    img.style.height = (natH*scale)+"px";
    img.style.left = ((stageSize - natW*scale)/2 + stickerOffsetX)+"px";
    img.style.top = ((stageSize - natH*scale)/2 + stickerOffsetY)+"px";
  }

  document.getElementById("stickerZoomRange").addEventListener("input", (e)=>{
    stickerZoom = e.target.value/100;
    layoutStickerMakerImage();
  });

  (function setupStickerDrag(){
    const stage = document.getElementById("stickerMakerStage");
    const start = (x,y)=>{ stickerDragState = { x, y, ox:stickerOffsetX, oy:stickerOffsetY }; };
    const move = (x,y)=>{
      if(!stickerDragState) return;
      stickerOffsetX = stickerDragState.ox + (x-stickerDragState.x);
      stickerOffsetY = stickerDragState.oy + (y-stickerDragState.y);
      layoutStickerMakerImage();
    };
    const end = ()=>{ stickerDragState = null; };
    stage.addEventListener("mousedown", (e)=> start(e.clientX,e.clientY));
    window.addEventListener("mousemove", (e)=> move(e.clientX,e.clientY));
    window.addEventListener("mouseup", end);
    stage.addEventListener("touchstart", (e)=>{ const t=e.touches[0]; start(t.clientX,t.clientY); }, {passive:true});
    stage.addEventListener("touchmove", (e)=>{ const t=e.touches[0]; move(t.clientX,t.clientY); }, {passive:true});
    stage.addEventListener("touchend", end);
  })();

  document.getElementById("cancelStickerMakerBtn").addEventListener("click", ()=>{
    document.getElementById("stickerMakerOverlay").classList.remove("show");
    stickerSourceImg = null;
  });

  document.getElementById("saveStickerBtn").addEventListener("click", async ()=>{
    if(!stickerSourceImg) return;
    const OUT = 360;
    const stage = document.getElementById("stickerMakerStage");
    const stageSize = stage.clientWidth || 300;
    const natW = stickerSourceImg.width, natH = stickerSourceImg.height;
    const baseScale = Math.max(stageSize/natW, stageSize/natH);
    const scale = baseScale * stickerZoom;
    const drawW = natW*scale, drawH = natH*scale;
    const drawLeft = (stageSize - drawW)/2 + stickerOffsetX;
    const drawTop = (stageSize - drawH)/2 + stickerOffsetY;

    const canvas = document.createElement("canvas");
    canvas.width = OUT; canvas.height = OUT;
    const ctx = canvas.getContext("2d");
    ctx.save();
    ctx.beginPath();
    ctx.arc(OUT/2, OUT/2, OUT/2, 0, Math.PI*2);
    ctx.closePath();
    ctx.clip();
    const outScale = OUT/stageSize;
    ctx.drawImage(stickerSourceImg, drawLeft*outScale, drawTop*outScale, drawW*outScale, drawH*outScale);
    ctx.restore();

    const dataUrl = canvas.toDataURL("image/png");
    try{
      const data = await api("POST","/api/stickers", { dataUrl });
      stickersCache.unshift(data.sticker);
      document.getElementById("stickerMakerOverlay").classList.remove("show");
      stickerSourceImg = null;
      toast("Стикер сохранён");
      renderStickerGrid();
      switchComposerTab("sticker");
    }catch(e){ toast(e.message || "Не удалось сохранить стикер"); }
  });

  const newChatSheetOverlay = document.getElementById("newChatSheetOverlay");
  document.getElementById("openNewChatBtn").addEventListener("click", ()=>{
    newChatSheetOverlay.classList.add("show");
  });
  document.getElementById("newChatSheetCancel").addEventListener("click", ()=>{
    newChatSheetOverlay.classList.remove("show");
  });
  newChatSheetOverlay.addEventListener("click", (e)=>{
    if(e.target===newChatSheetOverlay) newChatSheetOverlay.classList.remove("show");
  });
  document.getElementById("newChatDmOption").addEventListener("click", ()=>{
    newChatSheetOverlay.classList.remove("show");
    showScreen("search");
    document.getElementById("searchPhoneInput").focus();
  });
  document.getElementById("newChatGroupOption").addEventListener("click", ()=>{
    newChatSheetOverlay.classList.remove("show");
    openCreateGroupScreen();
  });

  function openCreateGroupScreen(){
    groupMemberSelection = [];
    document.getElementById("groupNameInput").value = "";
    document.getElementById("groupMemberSearchInput").value = "";
    document.getElementById("groupMemberSearchResult").innerHTML = "";
    renderSelectedMembersRow();
    renderGroupQuickPickList();
    updateCreateGroupBtn();
    showScreen("createGroup");
  }

  document.getElementById("groupNameInput").addEventListener("input", updateCreateGroupBtn);
  function updateCreateGroupBtn(){
    const name = document.getElementById("groupNameInput").value.trim();
    document.getElementById("createGroupBtn").disabled = !(name.length>0 && groupMemberSelection.length>0);
  }

  function renderSelectedMembersRow(){
    const row = document.getElementById("selectedMembersRow");
    row.innerHTML = "";
    groupMemberSelection.forEach(phone=>{
      const contact = contactsCache[phone];
      const chip = document.createElement("div");
      chip.className = "selected-member-chip";
      chip.innerHTML = `<span>${escapeHtml(contact ? contact.name : phone)}</span><span class="chip-x">✕</span>`;
      chip.querySelector(".chip-x").addEventListener("click", ()=>{
        groupMemberSelection = groupMemberSelection.filter(p=>p!==phone);
        renderSelectedMembersRow();
        renderGroupQuickPickList();
        updateCreateGroupBtn();
      });
      row.appendChild(chip);
    });
  }

  function renderGroupQuickPickList(){
    const wrap = document.getElementById("groupQuickPickList");
    wrap.innerHTML = "";
    const knownPhones = chatsCache.map(c=>c.contact).filter(c=>!c.isGroup).map(c=>c.phone);
    if(knownPhones.length===0){
      wrap.innerHTML = `<div class="sticker-empty-hint">Пока нет ни одного контакта — найдите человека по номеру выше.</div>`;
      return;
    }
    knownPhones.forEach(phone=>{
      const contact = contactsCache[phone];
      const row = document.createElement("div");
      row.className = "member-pick-row" + (groupMemberSelection.includes(phone) ? " checked":"");
      row.appendChild(avatarEl(contact, "sm"));
      const text = document.createElement("div");
      text.style.flex="1";
      text.innerHTML = `<div style="font-weight:600;font-size:14.5px;">${escapeHtml(contact.name)}</div>`;
      row.appendChild(text);
      const check = document.createElement("div");
      check.className = "mp-check";
      check.textContent = groupMemberSelection.includes(phone) ? "✓" : "";
      row.appendChild(check);
      row.addEventListener("click", ()=> toggleGroupMember(phone));
      wrap.appendChild(row);
    });
  }

  function toggleGroupMember(phone){
    if(groupMemberSelection.includes(phone)){
      groupMemberSelection = groupMemberSelection.filter(p=>p!==phone);
    } else {
      groupMemberSelection.push(phone);
    }
    renderSelectedMembersRow();
    renderGroupQuickPickList();
    updateCreateGroupBtn();
  }

  const groupMemberSearchInput = document.getElementById("groupMemberSearchInput");
  let groupSearchDebounce = null;
  groupMemberSearchInput.addEventListener("input", ()=>{
    const {digits} = fullPhoneFromInput(groupMemberSearchInput.value);
    groupMemberSearchInput.value = "+7 " + formatRuPhone(digits);
    if(groupMemberSearchInput.value.trim()==="+7") groupMemberSearchInput.value="";
    clearTimeout(groupSearchDebounce);
    groupSearchDebounce = setTimeout(doGroupMemberSearch, 250);
  });
  async function doGroupMemberSearch(){
    const area = document.getElementById("groupMemberSearchResult");
    const {full} = fullPhoneFromInput(groupMemberSearchInput.value);
    if(!full){ area.innerHTML=""; return; }
    if(full===me.phone){ area.innerHTML = `<div class="sticker-empty-hint">Это ваш номер</div>`; return; }
    try{
      const data = await api("GET", "/api/users/search?phone="+encodeURIComponent(full));
      if(!data.user){ area.innerHTML = `<div class="sticker-empty-hint">Пользователь не найден</div>`; return; }
      contactsCache[data.user.phone] = data.user;
      area.innerHTML = "";
      const row = document.createElement("div");
      row.className = "member-pick-row" + (groupMemberSelection.includes(data.user.phone) ? " checked":"");
      row.appendChild(avatarEl(data.user, "sm"));
      const text = document.createElement("div");
      text.style.flex="1";
      text.innerHTML = `<div style="font-weight:600;font-size:14.5px;">${escapeHtml(data.user.name)}</div>`;
      row.appendChild(text);
      const check = document.createElement("div");
      check.className = "mp-check";
      check.textContent = groupMemberSelection.includes(data.user.phone) ? "✓" : "";
      row.appendChild(check);
      row.addEventListener("click", ()=>{ toggleGroupMember(data.user.phone); doGroupMemberSearch(); });
      area.appendChild(row);
    }catch(e){ toast(e.message); }
  }

  document.getElementById("createGroupBtn").addEventListener("click", async ()=>{
    const name = document.getElementById("groupNameInput").value.trim();
    if(!name || groupMemberSelection.length===0) return;
    const btn = document.getElementById("createGroupBtn");
    btn.disabled = true;
    try{
      const data = await api("POST","/api/groups", { name, memberPhones: groupMemberSelection });
      groupsCache[data.group.id] = data.group;
      toast("Группа создана");
      await refreshChatList();
      screenStack = screenStack.filter(s=>s!=="createGroup");
      openGroupThread(data.group.id);
    }catch(e){
      toast(e.message || "Не удалось создать группу");
      btn.disabled = false;
    }
  });

  async function loadFavorites(){
    try{
      const data = await api("GET","/api/favorites");
      favoritesCache = data.messages;
    }catch(e){ }
  }

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
      connectWebSocket();
      renderProfileScreen();
      toast("Номер телефона обновлён");
      screenStack = screenStack.filter(s=>!["editPhone","editPhoneCode"].includes(s));
      goBack("profile");
    }catch(e){ toast(e.message || "Не удалось подтвердить код"); }
  });

  let editColorChoice = null;
  let editAvatarDataUrl = null;
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

  const ICE_SERVERS = [{ urls: "stun:stun.l.google.com:19302" }];

  let rtcConn = null;
  let localStream = null;
  let currentCallId = null;
  let currentCallPhone = null;
  let currentCallRole = null;
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

  loadSession();
  if(session.phone && session.token){
    api("GET","/api/me").then(async (data)=>{
      me = data.user;
      await loadFavorites();
      await loadStickers();
      await enterApp();
    }).catch((e)=>{
      // Сессия недействительна (например, сервер пересобрался и базу
      // очистил) — НЕ удаляем номер телефона из памяти браузера, чтобы
      // человек мог просто заново подтвердить код и не терять историю
      // переписки с этим же номером в будущем, если база восстановится.
      const savedPhone = session.phone;
      clearSession();
      screens.welcome.classList.remove("hidden");
      if(savedPhone){
        toast("Сессия истекла — войдите снова по своему номеру");
      }
    });
  } else {
    screens.welcome.classList.remove("hidden");
  }

})();
