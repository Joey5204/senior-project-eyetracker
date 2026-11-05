// Eye Communicator front end.
// Pointer source: mouse (default) or gaze (server-sent events from the tracker).
// Selection: dwell on a target for dwell_ms. Click also selects instantly (for caregivers/testing).

(() => {
  "use strict";

  const $ = (s) => document.querySelector(s);

  const state = {
    vocab: null,
    lang: "en",
    screen: "categories", // or "words"
    catId: null,
    sentence: [],
    mode: "mouse", // or "gaze"
    pointer: { x: -1, y: -1 },
    dwellMs: 1000,
    dwell: { el: null, start: 0, lastOn: 0 },
    blockedPos: null, // grid position that must be left before it can fire again
    lockUntil: 0,
    lastGazeAt: 0,
    started: false,
  };

  let es = null; // EventSource for gaze
  let speechChain = Promise.resolve();

  // ---------- small helpers ----------
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* ignore */ } },
  };

  const label = (obj) => (obj && (obj[state.lang] || obj.en)) || "";
  const ui = (key) => label(state.vocab.ui[key]);

  function hasThai() {
    const v = state.vocab;
    const any = (o) => o && o.th && o.th.trim();
    return v.categories.some((c) => any(c.label) || c.words.some((w) => any(w.label)));
  }

  // ---------- rendering ----------
  function renderBar() {
    $("#btn-speak").textContent = ui("speak");
    $("#btn-clear").textContent = ui("clear");
    $("#start-text").textContent = ui("start");

    const box = $("#sentence");
    box.textContent = "";
    if (!state.sentence.length) {
      const p = document.createElement("span");
      p.className = "placeholder";
      p.textContent = ui("placeholder");
      box.appendChild(p);
      return;
    }
    for (const w of state.sentence) {
      const c = document.createElement("span");
      c.className = "chip";
      c.textContent = label(w.label);
      box.appendChild(c);
    }
  }

  function makeTile(pos, text, cls, act, hue) {
    const b = document.createElement("button");
    b.className = "target tile " + (cls || "");
    b.dataset.pos = String(pos);
    b.textContent = text;
    if (hue !== undefined) b.style.setProperty("--hue", hue);
    b._act = act;
    b.addEventListener("click", () => fire(b)); // instant select by click
    return b;
  }

  function renderGrid() {
    clearDwell();
    const grid = $("#grid");
    grid.textContent = "";
    const v = state.vocab;

    if (state.screen === "categories") {
      v.categories.forEach((c, i) => {
        const hue = Math.round((i * 360) / v.categories.length);
        grid.appendChild(makeTile(i, label(c.label), "cat", () => openCategory(c.id), hue));
      });
    } else {
      const cat = v.categories.find((c) => c.id === state.catId);
      cat.words.forEach((w, i) => {
        grid.appendChild(makeTile(i, label(w.label), "word", () => pickWord(w)));
      });
      grid.appendChild(makeTile(cat.words.length, "← " + ui("back"), "back", goHome));
    }
  }

  function renderAll() {
    renderBar();
    renderGrid();
    const btn = $("#btn-lang");
    btn.hidden = !hasThai();
    btn.textContent = state.lang === "en" ? "ไทย" : "English";
  }

  // ---------- actions ----------
  function openCategory(id) {
    state.screen = "words";
    state.catId = id;
    renderGrid();
  }

  function goHome() {
    state.screen = "categories";
    state.catId = null;
    renderGrid();
  }

  function pickWord(w) {
    state.sentence.push(w);
    renderBar();
    speak([w]);
    goHome();
  }

  function clearSentence() {
    state.sentence = [];
    renderBar();
  }

  function speakSentence() {
    if (state.sentence.length) speak(state.sentence.slice());
  }

  // ---------- speech: local audio clip first, browser TTS as fallback ----------
  function speak(items) {
    for (const it of items) {
      const snapshot = { id: it.id, text: label(it.label), lang: state.lang };
      speechChain = speechChain.then(() => playItem(snapshot)).catch(() => {});
    }
  }

  function playItem(it) {
    return new Promise((resolve) => {
      let finished = false;
      let fellBack = false;
      const finish = () => { if (!finished) { finished = true; resolve(); } };
      const fallback = () => {
        if (fellBack || finished) return;
        fellBack = true;
        speakTTS(it.text, it.lang).then(finish);
      };
      const a = new Audio(`/static/audio/${it.lang}/${it.id}.mp3`);
      a.onended = finish;
      a.onerror = fallback;
      const p = a.play();
      if (p && p.catch) p.catch(fallback);
      setTimeout(finish, 15000); // safety so the queue never hangs
    });
  }

  function speakTTS(text, lang) {
    return new Promise((resolve) => {
      if (!("speechSynthesis" in window) || !text) return resolve();
      const u = new SpeechSynthesisUtterance(text);
      u.lang = lang === "th" ? "th-TH" : "en-US";
      u.onend = resolve;
      u.onerror = resolve;
      window.speechSynthesis.speak(u);
      setTimeout(resolve, 8000);
    });
  }

  // ---------- dwell selection ----------
  function targetAt(x, y) {
    if (x < 0 || y < 0) return null;
    const el = document.elementFromPoint(x, y);
    return el ? el.closest(".target") : null;
  }

  function clearDwell() {
    const d = state.dwell;
    if (d.el && d.el.isConnected) {
      d.el.classList.remove("dwelling");
      d.el.style.setProperty("--p", 0);
    }
    d.el = null;
  }

  function fire(el) {
    if (!el._act) return;
    const pos = el.dataset.pos;
    clearDwell();
    el.classList.add("picked");
    setTimeout(() => el.classList.remove("picked"), 250);
    el._act();
    // After the action (and any re-render), the pointer may sit on a new tile.
    // Require the pointer to leave that spot before anything can fire again.
    const now = targetAt(state.pointer.x, state.pointer.y);
    state.blockedPos = now ? now.dataset.pos : pos;
    state.lockUntil = performance.now() + 700;
  }

  function loop(now) {
    const d = state.dwell;
    // In gaze mode, no fresh sample for 400 ms means the tracker lost the eye:
    // ignore the last position so a frozen dot can never select anything.
    const gazeStale = state.mode === "gaze" && now - state.lastGazeAt > 400;
    $("#gaze-dot").style.visibility = gazeStale ? "hidden" : "visible";
    const el = state.started && !gazeStale ? targetAt(state.pointer.x, state.pointer.y) : null;
    const pos = el ? el.dataset.pos : null;

    if (state.blockedPos !== null && pos !== state.blockedPos) state.blockedPos = null;

    if (el && pos !== state.blockedPos && now >= state.lockUntil) {
      if (d.el !== el) {
        clearDwell();
        d.el = el;
        d.start = now;
        el.classList.add("dwelling");
      }
      d.lastOn = now;
      const p = Math.min(1, (now - d.start) / state.dwellMs);
      el.style.setProperty("--p", p.toFixed(3));
      if (p >= 1) fire(el);
    } else if (d.el && now - d.lastOn > 200) {
      clearDwell(); // 200 ms grace so a small gaze jitter doesn't reset the timer
    }
    requestAnimationFrame(loop);
  }

  // ---------- pointer sources ----------
  window.addEventListener("mousemove", (e) => {
    if (state.mode !== "mouse") return;
    state.pointer.x = e.clientX;
    state.pointer.y = e.clientY;
  });

  function setMode(mode) {
    state.mode = mode;
    store.set("mode", mode);
    document.body.classList.toggle("gaze", mode === "gaze");
    $("#gaze-dot").hidden = mode !== "gaze";
    if (es) { es.close(); es = null; }
    if (mode === "gaze") {
      es = new EventSource("/api/stream");
      es.onmessage = (ev) => {
        let s;
        try { s = JSON.parse(ev.data); } catch (e) { return; }
        state.lastGazeAt = performance.now();
        state.pointer.x = s.x * window.innerWidth;
        state.pointer.y = s.y * window.innerHeight;
        const dot = $("#gaze-dot");
        dot.style.transform = `translate(${state.pointer.x}px, ${state.pointer.y}px)`;
      };
    } else {
      state.pointer.x = state.pointer.y = -1;
    }
    updateBadge();
  }

  function updateBadge() {
    const b = $("#mode-badge");
    b.className = "";
    if (state.mode === "mouse") {
      b.textContent = "Mouse mode";
    } else if (performance.now() - state.lastGazeAt < 1000) {
      b.textContent = "Gaze: live";
      b.className = "live";
    } else {
      b.textContent = "Gaze: no signal";
      b.className = "nosignal";
    }
  }

  // ---------- keyboard / start ----------
  function toggleLang() {
    if (!hasThai()) return;
    state.lang = state.lang === "en" ? "th" : "en";
    store.set("lang", state.lang);
    document.documentElement.lang = state.lang;
    renderAll();
  }

  function begin() {
    if (state.started) return;
    state.started = true;
    $("#start").classList.add("hidden");
    // Browsers only allow audio after a user gesture; this unlocks it.
    if ("speechSynthesis" in window) window.speechSynthesis.speak(new SpeechSynthesisUtterance(""));
  }

  window.addEventListener("keydown", (e) => {
    if (!state.started) { begin(); return; }
    const k = e.key.toLowerCase();
    if (k === "g") setMode(state.mode === "mouse" ? "gaze" : "mouse");
    else if (k === "l") toggleLang();
    else if (k === "f") {
      if (document.fullscreenElement) document.exitFullscreen();
      else document.documentElement.requestFullscreen().catch(() => {});
    }
  });
  $("#start").addEventListener("click", begin);
  $("#btn-lang").addEventListener("click", toggleLang);

  // ---------- boot ----------
  async function init() {
    const res = await fetch("/api/vocab");
    state.vocab = await res.json();

    const params = new URLSearchParams(location.search);
    state.dwellMs = Number(params.get("dwell")) || state.vocab.dwell_ms || 1000;
    state.lang = params.get("lang") || store.get("lang") || "en";
    if (!state.vocab.languages.includes(state.lang)) state.lang = "en";
    document.documentElement.lang = state.lang;

    $("#btn-speak")._act = speakSentence;
    $("#btn-clear")._act = clearSentence;
    for (const id of ["#btn-speak", "#btn-clear"]) {
      const b = $(id);
      b.addEventListener("click", () => fire(b));
    }

    renderAll();
    setMode(params.get("mode") || store.get("mode") || "mouse");
    if (params.get("nostart") === "1") begin();

    setInterval(updateBadge, 500);
    requestAnimationFrame(loop);
  }

  init();
})();
