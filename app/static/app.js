// Eye Communicator front end.
// Pointer source: mouse (default) or gaze (server-sent events from the tracker).
// Selection: each target has its own accumulated look time (see the dwell section). Click also selects instantly.

(() => {
  "use strict";

  const $ = (s) => document.querySelector(s);

  const state = {
    vocab: null,
    lang: "en",
    catId: null, // chosen category (stays chosen after a word is picked)
    page: 0,     // page of words shown for that category
    catPage: 0,  // page of categories shown on the left
    sentence: [],
    mode: "mouse", // or "gaze"
    pointer: { x: -1, y: -1 },
    dwellCfg: {}, // ms to select, per kind of target (from vocab.json "dwell")
    blockedPos: null, // grid position that must be left before it can fire again
    lockUntil: 0,
    lastGazeAt: 0,
    started: false,
  };

  let es = null; // EventSource for gaze
  let speechChain = Promise.resolve();

  // Calibration state. phase: "idle" | "aim" | "capture" | "review" | "done" (result showing).
  // `run` is bumped whenever a calibration is cancelled, so a stale run stops by itself.
  const cal = {
    active: false, phase: "idle", collecting: false, buffer: [], run: 0,
    asker: null, pending: null, captured: [], recent: [], live: null, liveVec: null,
    cur: 0, reviewCls: "", resultCls: "",
  };

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
    $("#btn-help").textContent = ui("help");
    $("#help-text").textContent = ui("help_banner");
    $("#help-cancel").textContent = ui("cancel");
    $("#start-text").textContent = ui("start");
    $("#v-prev").setAttribute("aria-label", ui("prev"));
    $("#v-play").setAttribute("aria-label", ui("play"));
    $("#v-next").setAttribute("aria-label", ui("next"));
    $("#v-vdown").textContent = "\u2212  " + ui("quieter");
    $("#v-vup").textContent = "+  " + ui("louder");
    renderVolume();

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

  // kind decides how long it takes to select: "word", "category", "nav", "speak", "clear", "help", "video"
  function makeTile(key, text, cls, kind, act, hue) {
    const b = document.createElement("button");
    b.className = "target tile " + (cls || "");
    b.dataset.pos = key; // unique key: used for progress memory and the post-select lock
    b.dataset.kind = kind;
    b.textContent = text;
    if (hue !== undefined) b.style.setProperty("--hue", hue);
    b._act = act;
    b.addEventListener("click", () => fire(b)); // instant select by click
    return b;
  }

  const wordsPerPage = () => state.vocab.dwell.words_per_page || 4;

  // categories_per_page (in vocab.json) limits how many categories show at once so the boxes stay big;
  // a "More" box then flips to the next group. 0 or missing = show them all.
  const catsPerPage = () => state.vocab.dwell.categories_per_page || 0;

  function renderCats() {
    const box = $("#cats");
    box.textContent = "";
    const v = state.vocab;
    const per = catsPerPage();
    const paged = per > 0 && v.categories.length > per;
    const pages = paged ? Math.ceil(v.categories.length / per) : 1;
    const page = state.catPage % pages;
    const first = paged ? page * per : 0;
    const shown = paged ? v.categories.slice(first, first + per) : v.categories;
    shown.forEach((c, k) => {
      const hue = Math.round(((first + k) * 360) / v.categories.length); // a category keeps its colour on any page
      const b = makeTile("cat:" + c.id, label(c.label), "cat", "category", () => openCategory(c.id), hue);
      if (c.id === state.catId) b.classList.add("current");
      box.appendChild(b);
    });
    if (paged) {
      for (let i = shown.length; i < per; i++) {
        const d = document.createElement("div");
        d.className = "slot";
        box.appendChild(d);
      }
      box.appendChild(makeTile("catmore", `${ui("more")}  ${page + 1}/${pages}  \u25B6`, "more", "nav", nextCatPage));
    }
  }

  // Words: a fixed number of slots, so the layout never jumps. The last slot is
  // "More" when the category has more words than fit, otherwise it is left empty.
  function renderWords() {
    const box = $("#words");
    box.textContent = "";
    const slot = () => { const d = document.createElement("div"); d.className = "slot"; return d; };
    const per = wordsPerPage();
    const cat = state.vocab.categories.find((c) => c.id === state.catId);
    if (!cat) {
      const h = document.createElement("div");
      h.className = "hint-col";
      h.textContent = ui("pick_category");
      box.appendChild(h);
      return;
    }
    const pages = Math.max(1, Math.ceil(cat.words.length / per));
    const page = state.page % pages;
    const shown = cat.words.slice(page * per, page * per + per);
    for (const w of shown) box.appendChild(makeTile("word:" + w.id, label(w.label), "word", "word", () => pickWord(w)));
    for (let i = shown.length; i < per; i++) box.appendChild(slot());
    if (pages > 1) {
      box.appendChild(makeTile("more", `${ui("more")}  ${page + 1}/${pages}  \u25B6`, "more", "nav", nextPage));
    } else {
      box.appendChild(slot());
    }
  }

  function renderGrid() {
    renderCats();
    renderWords();
  }

  function renderAll() {
    renderBar();
    renderGrid();
    const btn = $("#btn-lang");
    btn.hidden = !hasThai();
    btn.textContent = state.lang === "en" ? "\u0e44\u0e17\u0e22" : "English";
  }

  // ---------- actions ----------
  function openCategory(id) {
    state.catId = id;
    state.page = 0;
    renderGrid();
  }

  function nextPage() {
    state.page += 1; // wraps around in renderWords
    renderWords();
  }

  function nextCatPage() {
    state.catPage += 1; // wraps around in renderCats
    renderCats();
  }

  function pickWord(w) {
    state.sentence.push(w);
    renderBar();
    speak([w]);
    // the category stays open: people usually say several words from the same one
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
      duckVideo(true); // lower the video's sound while we talk
      speechChain = speechChain.then(() => playItem(snapshot)).catch(() => {}).then(() => duckVideo(false));
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
  // Every target keeps its own look time. Looking away pauses it (it is not lost); it is only
  // forgotten after `memory_ms` without being looked at. Selecting anything clears all progress,
  // so old glances cannot trigger a surprise selection later.
  const dw = { acc: new Map(), last: new Map(), prevT: 0 };

  function needMs(el) {
    return state.dwellCfg[el.dataset.kind] || 3000;
  }

  function targetAt(x, y) {
    if (x < 0 || y < 0) return null;
    const el = document.elementFromPoint(x, y);
    return el ? el.closest(".target") : null;
  }

  function resetProgress() {
    dw.acc.clear();
    dw.last.clear();
    for (const el of document.querySelectorAll(".target")) {
      el.classList.remove("dwelling", "kept");
      el.style.setProperty("--p", 0);
    }
  }

  function fire(el) {
    if (!el._act) return;
    const pos = el.dataset.pos;
    resetProgress();
    el.classList.add("picked");
    setTimeout(() => el.classList.remove("picked"), 250);
    el._act();
    // After the action (and any re-render), the pointer may sit on a new tile.
    // Require the pointer to leave that spot before anything can fire again.
    const now = targetAt(state.pointer.x, state.pointer.y);
    state.blockedPos = now ? now.dataset.pos : pos;
    state.lockUntil = performance.now() + 700;
  }

  // "Hold" buttons (volume): keep acting every volume_repeat_ms for as long as they are looked at.
  // Unlike fire(), this does not lock the pointer, so the next step comes without looking away.
  function repeatFire(el) {
    const pos = el.dataset.pos;
    for (const k of [...dw.acc.keys()]) {
      if (k !== pos) { dw.acc.delete(k); dw.last.delete(k); }
    }
    el._act();
    const again = state.dwellCfg.volume_repeat_ms || 600;
    dw.acc.set(pos, Math.max(0, needMs(el) - again));
  }

  // Show each target's progress: bright ring while looked at, dim ring while it is only remembered.
  function paintProgress(current) {
    for (const el of document.querySelectorAll(".target")) {
      const acc = dw.acc.get(el.dataset.pos) || 0;
      const p = Math.min(1, acc / needMs(el));
      el.style.setProperty("--p", p.toFixed(3));
      el.classList.toggle("dwelling", el === current);
      el.classList.toggle("kept", el !== current && p > 0);
    }
  }

  function loop(now) {
    const dt = dw.prevT ? Math.min(now - dw.prevT, 100) : 0; // a hidden tab must not add minutes at once
    dw.prevT = now;
    // In gaze mode, no fresh sample for 400 ms means the tracker lost the eye:
    // ignore the last position so a frozen dot can never select anything.
    const gazeStale = state.mode === "gaze" && now - state.lastGazeAt > 400;
    // While the calibration dots are showing, hide the cursor: it would only distract.
    const hideDot = gazeStale || (cal.active && cal.phase !== "done");
    if (cal.active) hudTick(now);
    $("#gaze-dot").style.visibility = hideDot ? "hidden" : "visible";
    const el = state.started && !gazeStale && !cal.active ? targetAt(state.pointer.x, state.pointer.y) : null;
    const pos = el ? el.dataset.pos : null;

    if (state.blockedPos !== null && pos !== state.blockedPos) state.blockedPos = null;

    let current = null;
    if (el && pos !== state.blockedPos && now >= state.lockUntil) {
      current = el;
      dw.acc.set(pos, (dw.acc.get(pos) || 0) + dt);
      dw.last.set(pos, now);
    }
    for (const [k, t] of dw.last) {
      if (now - t > state.dwellCfg.memory_ms) { dw.last.delete(k); dw.acc.delete(k); }
    }
    paintProgress(current);
    if (current && dw.acc.get(pos) >= needMs(current)) {
      if (current.dataset.repeat) repeatFire(current); else fire(current);
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
        if (cal.collecting && s.raw) cal.buffer.push(s.raw); // calibration reads the raw angles
        if (cal.active && s.raw) {
          cal.live = s.raw;
          cal.liveVec = s.vec || null;
          cal.recent.push([state.lastGazeAt, s.raw[0], s.raw[1]]);
          while (cal.recent.length && state.lastGazeAt - cal.recent[0][0] > 1500) cal.recent.shift();
        }
        if (typeof s.x !== "number" || typeof s.y !== "number") {
          state.pointer.x = state.pointer.y = -1; // raw-only sample and no calibration yet
          return;
        }
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
    if (e.target && e.target.tagName === "INPUT") {   // typing in a text box: no shortcuts
      if (e.key === "Enter") saveVideoSource();
      else if (e.key === "Escape") closeVideoSetup();
      return;
    }
    if (!state.started) { begin(); return; }
    const k = e.key.toLowerCase();
    if (!$("#video-setup").hidden) { if (k === "escape") closeVideoSetup(); return; }
    if (help.on && k === "escape") { cancelHelp(); return; }
    if (cal.active) {
      if (["shift", "control", "alt", "meta", "tab"].includes(k)) return;
      e.preventDefault(); // Space must not scroll or click a focused button
      if (e.repeat) return;
      if (k === "escape") cancelCalibration();
      else if (cal.asker) cal.asker.key(k);
      return;
    }
    if (k === "g") setMode(state.mode === "mouse" ? "gaze" : "mouse");
    else if (k === "c") runCalibration();
    else if (k === "v") openVideoSetup();
    else if (k === "l") toggleLang();
    else if (k === "f") {
      if (document.fullscreenElement) document.exitFullscreen();
      else document.documentElement.requestFullscreen().catch(() => {});
    }
  });
  $("#start").addEventListener("click", begin);
  $("#btn-lang").addEventListener("click", toggleLang);
  $("#btn-video").addEventListener("click", () => { if (state.started && !cal.active) openVideoSetup(); });
  $("#video-save").addEventListener("click", saveVideoSource);
  $("#video-reset").addEventListener("click", resetVideoSource);
  $("#video-close").addEventListener("click", closeVideoSetup);
  $("#btn-calib").addEventListener("click", () => { if (state.started && !cal.active) runCalibration(); });

  // ---------- calibration ----------
  // 9 dots, visited in a snake path so the eye never has to jump far. Outer dots sit
  // 10% in from the edges: people cannot hold a gaze on the very edge, and the tiles
  // you actually select have their centres inside that area anyway.
  // Each dot is a small conversation: aim -> press Capture -> look at what was measured
  // -> Accept or Redo. Nothing is timed except the 1.3 s of measuring itself.
  const CAL_POINTS = [
    [0.10, 0.12], [0.50, 0.12], [0.90, 0.12],
    [0.90, 0.50], [0.50, 0.50], [0.10, 0.50],
    [0.10, 0.88], [0.50, 0.88], [0.90, 0.88],
  ];
  const CAL_IGNORE_MS = 300;   // after pressing Capture: eye is still settling, samples ignored
  const CAL_COLLECT_MS = 1000; // samples kept
  const CAL_MIN_SAMPLES = 8;   // fewer than this = tracker lost the eye, only Redo is offered
  const RAD = 180 / Math.PI;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function median(a) {
    const s = a.slice().sort((p, q) => p - q);
    const m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  }

  // Robust spread: median absolute deviation scaled to match a standard deviation.
  function mad(a) {
    const m = median(a);
    return 1.4826 * median(a.map((v) => Math.abs(v - m)));
  }

  // Spread of a list of [yaw, pitch] samples, in degrees.
  function spreadDeg(samples) {
    return Math.hypot(mad(samples.map((r) => r[0])), mad(samples.map((r) => r[1]))) * RAD;
  }

  // steadiness (degrees) -> colour class
  const steadyClass = (d) => (d <= 1 ? "ok" : d <= 2.5 ? "warn" : "bad");

  function calMsg(text, cls) {
    const m = $("#calib-msg");
    m.textContent = text;
    m.className = cls || "";
  }

  function calDot(p, cls) {
    const d = $("#calib-dot");
    if (p) { d.style.left = p[0] * 100 + "%"; d.style.top = p[1] * 100 + "%"; }
    d.className = "";
    void d.offsetWidth; // restart the CSS animation
    d.className = cls || "";
  }

  // Show buttons and wait for one of them (or its key). options: [{name, label, keys, primary}].
  // `extraKey(k)` may map other keys to a name. Resolves null if the calibration is cancelled.
  function ask(myRun, options, extraKey) {
    const box = $("#calib-actions");
    box.textContent = "";
    return new Promise((resolve) => {
      const done = (name) => {
        if (cal.asker !== entry) return;
        cal.asker = null;
        box.textContent = "";
        resolve(name);
      };
      const entry = {
        done,
        key(k) {
          for (const o of options) if (o.keys && o.keys.includes(k)) return done(o.name);
          const x = extraKey && extraKey(k);
          if (x) done(x);
        },
      };
      if (cal.run !== myRun) return resolve(null);
      cal.asker = entry;
      for (const o of options) {
        const b = document.createElement("button");
        b.tabIndex = -1;
        b.textContent = o.label;
        if (o.primary) b.className = "primary";
        else if (o.secondary) b.className = "secondary";
        b.addEventListener("click", () => { b.blur(); done(o.name); });
        box.appendChild(b);
      }
    });
  }

  // Measure one dot: ignore the first moments, then keep the median of the raw angles.
  // Median, not mean, so a blink or one wild sample cannot drag the result.
  async function measure(i, myRun) {
    cal.pending = i;
    calDot(null, "collect");
    cal.collecting = false;
    await sleep(CAL_IGNORE_MS);
    if (cal.run !== myRun) return null;
    cal.buffer = [];
    cal.collecting = true;
    await sleep(CAL_COLLECT_MS);
    cal.collecting = false;
    cal.pending = null;
    if (cal.run !== myRun) return null;
    const buf = cal.buffer;
    cal.buffer = [];
    if (!buf.length) return { raw: null, n: 0, spread: null };
    return {
      raw: [median(buf.map((r) => r[0])), median(buf.map((r) => r[1]))],
      n: buf.length,
      spread: spreadDeg(buf),
    };
  }

  // Keys 1-9 jump straight to that dot; B goes one dot back; C starts over. Available at every step.
  const jumpKey = (k) => (/^[1-9]$/.test(k) ? "goto:" + (Number(k) - 1) : null);
  const navOptions = (i) => {
    const o = [];
    if (i > 0) o.push({ name: "back", label: "Back (B)", keys: ["b"], secondary: true });
    o.push({ name: "restart", label: "Restart (C)", keys: ["c"], secondary: true });
    return o;
  };

  // Turns a navigation answer into the object runCalibration understands.
  function navResult(a) {
    if (a === "back") return { back: true };
    if (a === "restart") return { restart: true };
    if (typeof a === "string" && a.startsWith("goto:")) return { goto: Number(a.slice(5)) };
    return null;
  }

  // The aim -> capture -> review loop for one dot.
  // Returns true (accepted), null (cancelled) or {back} / {restart} / {goto: n} when the user navigated away.
  async function captureDot(i, myRun) {
    const label = `Dot ${i + 1} of ${CAL_POINTS.length}`;
    cal.cur = i;
    for (;;) {
      calDot(CAL_POINTS[i], "");
      calMsg(`${label}: look at the dot, hold still, then press Capture. ` +
        "(Press 1-9 or click a circle to jump to another dot.)");
      drawMarks(false);
      setPhase("aim");
      let a = await ask(myRun, [{ name: "capture", label: "Capture (Space)", keys: [" ", "enter"], primary: true },
                                ...navOptions(i)], jumpKey);
      if (a === null) return null;
      if (a !== "capture") { const nav = navResult(a); if (nav.goto === i) continue; return nav; }

      setPhase("capture");
      calMsg(`${label}: measuring... keep looking at the dot.`);
      const m = await measure(i, myRun);
      if (!m || cal.run !== myRun) return null;

      setPhase("review");
      calDot(CAL_POINTS[i], "");
      const enough = m.n >= CAL_MIN_SAMPLES;
      const options = [];
      let cls;
      if (!enough) {
        cls = "bad";
        calMsg(`${label}: only ${m.n} samples. The tracker lost your eye. Check its yellow ellipse, then Redo.`, cls);
      } else {
        cls = steadyClass(m.spread);
        const how = cls === "ok" ? "Steady." : cls === "warn" ? "A bit shaky." : "Very shaky, Redo is recommended.";
        calMsg(`${label}: ${how} Gaze wobbled ${m.spread.toFixed(1)} degrees over ${m.n} samples. ` +
          "Accept it if you were looking at the dot.", cls);
        options.push({ name: "accept", label: "Accept (Space)", keys: [" ", "enter"], primary: cls !== "bad" });
      }
      cal.reviewCls = cls; // colours the frame around the whole page
      options.push({ name: "redo", label: "Redo (R)", keys: ["r"], primary: !enough });
      a = await ask(myRun, [...options, ...navOptions(i)], jumpKey);
      if (a === null) return null;
      if (a === "accept") {
        cal.captured[i] = { target: CAL_POINTS[i], raw: m.raw, n: m.n, spread: m.spread };
        return true;
      }
      if (a !== "redo") { const nav = navResult(a); if (nav.goto !== i) return nav; }
      // redo: loop and show the dot again
    }
  }

  function setPhase(p) {
    cal.phase = p;
    $("#calib").dataset.phase = p;
  }

  // Draw the numbered circles. Before the result they are the 9 dots (filled once captured) and can be
  // clicked to jump to that dot. With a result, they are coloured by how well each dot was predicted.
  function drawMarks(result) {
    const box = $("#calib-marks");
    box.textContent = "";
    CAL_POINTS.forEach((p, i) => {
      const m = document.createElement("div");
      m.className = "calib-mark";
      m.dataset.dot = String(i);
      if (result) {
        const e = result.per_point_loo_pct && result.per_point_loo_pct[i];
        if (typeof e === "number") m.classList.add(e <= 5 ? "ok" : e <= 10 ? "warn" : "bad");
        m.title = "Click to redo this dot";
      } else {
        if (cal.captured[i]) m.classList.add("taken");
        if (i === cal.cur) m.classList.add("current");
        m.title = cal.captured[i] ? "Captured. Click to redo this dot" : "Click to go to this dot";
      }
      m.addEventListener("click", () => cal.asker && cal.asker.done("goto:" + i));
      m.textContent = String(i + 1);
      m.style.left = p[0] * 100 + "%";
      m.style.top = p[1] * 100 + "%";
      box.appendChild(m);
    });
  }

  const nextMissing = (from) => {
    for (let k = 1; k <= CAL_POINTS.length; k++) {
      const j = (from + k) % CAL_POINTS.length;
      if (!cal.captured[j]) return j;
    }
    return -1;
  };

  async function runCalibration() {
    if (cal.active) return;
    const myRun = ++cal.run;
    cal.active = true;
    cal.phase = "aim";
    cal.collecting = false;
    cal.pending = null;
    cal.captured = CAL_POINTS.map(() => null);
    cal.cur = 0;
    cal.reviewCls = "";
    cal.resultCls = "";
    cal.recent = [];
    cal.live = null;
    cal.liveVec = null;
    if (state.mode !== "gaze") setMode("gaze"); // calibration needs the tracker's data
    resetProgress();
    $("#calib-marks").textContent = "";
    $("#calib-actions").textContent = "";
    $("#calib-dot").hidden = false;
    $("#calib").hidden = false;

    // One loop for everything: capture the current dot, then go where the user asked
    // (back, a chosen dot, start over) or to the next dot that is still missing.
    // When all 9 are captured it fits and shows the result, where any dot can be redone.
    let cur = 0;
    let editing = false; // true while one dot is redone from the result screen
    for (;;) {
      if (!editing && cal.captured.every(Boolean)) {
        const res = await fitNow(myRun);
        if (res === undefined) return; // cancelled
        const next = await showResult(res, myRun);
        if (next === null) return;
        if (next === "finish") return endCalibration();
        if (next === "all") { cal.captured = CAL_POINTS.map(() => null); cur = 0; $("#calib-dot").hidden = false; continue; }
        if (typeof next === "number") { cur = next; editing = true; $("#calib-dot").hidden = false; }
        continue;
      }
      const r = await captureDot(cur, myRun);
      if (r === null) return;
      if (r === true) {
        editing = false;
        const n = nextMissing(cur);
        if (n >= 0) cur = n;       // otherwise everything is captured: the top of the loop fits it
      } else if (r.restart) {
        cal.captured = CAL_POINTS.map(() => null);
        cur = 0;
        editing = false;
      } else if (r.back) {
        cur = Math.max(0, cur - 1);
      } else if (typeof r.goto === "number") {
        cur = r.goto;
      }
    }
  }

  // POST the points. Returns the result, {error} on a failed fit, or undefined if cancelled.
  async function fitNow(myRun) {
    $("#calib-dot").hidden = true;
    $("#calib-marks").textContent = "";
    calMsg("Calculating...");
    try {
      const r = await fetch("/api/calibration", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ points: cal.captured, screen: { w: window.innerWidth, h: window.innerHeight } }),
      });
      const body = await r.json();
      if (cal.run !== myRun) return undefined;
      return r.ok ? body : { error: body.error || "Calibration failed." };
    } catch (e) {
      return cal.run !== myRun ? undefined : { error: "Could not reach the server." };
    }
  }

  // Result screen. Returns "finish", "all", a dot index to redo, or null if cancelled.
  async function showResult(res, myRun) {
    setPhase("done"); // the blue gaze cursor comes back so the user can compare it to the circles
    cal.cur = -1;
    refreshCalibStatus();
    const keyDot = (k) => (/^[1-9]$/.test(k) ? "dot:" + (Number(k) - 1) : null);
    let a;
    if (res.error) {
      cal.resultCls = "bad";
      calMsg(`${res.error} Press C to start over.`, "bad");
      drawMarks(false);
      a = await ask(myRun, [
        { name: "all", label: "Start over (C)", keys: ["c"], primary: true },
        { name: "finish", label: "Close", keys: ["enter"] },
      ], keyDot);
    } else {
      const q = res.loo_mean_pct;
      const verdict = q <= 5 ? ["Good", "ok"] : q <= 10 ? ["Usable with large tiles", "warn"] : ["Poor", "bad"];
      const deg = typeof res.loo_mean_deg === "number" ? ` (about ${res.loo_mean_deg.toFixed(1)} degrees)` : "";
      cal.resultCls = verdict[1];
      calMsg(`${verdict[0]}. Estimated error ${q.toFixed(1)}% of the screen width${deg}. ` +
        "Click a circle (or press 1-9) to redo that dot. Blue cursor = where you look now.", verdict[1]);
      drawMarks(res);
      a = await ask(myRun, [
        { name: "finish", label: "Finish (Enter)", keys: ["enter", " "], primary: verdict[1] !== "bad" },
        { name: "all", label: "Redo all (C)", keys: ["c"] },
      ], keyDot);
    }
    const m = typeof a === "string" && a.match(/^(?:dot|goto):(\d)$/); // a key (1-9) or a click on a circle
    if (m) return Number(m[1]);
    return a;
  }

  function endCalibration() {
    cal.active = false;
    cal.phase = "idle";
    cal.collecting = false;
    cal.pending = null;
    if (cal.asker) cal.asker.done(null);
    cal.asker = null;
    $("#calib-actions").textContent = "";
    $("#calib").hidden = true;
    refreshCalibStatus();
  }

  function cancelCalibration() {
    cal.run++; // stops the running calibration loop
    endCalibration();
  }

  // ---------- live gaze panel (readout + plot), drawn every frame while calibrating ----------
  function hudTick(now) {
    const live = cal.live;
    const fresh = live && now - state.lastGazeAt < 400;
    const rec = cal.recent.filter((r) => now - r[0] <= 1500);
    const hz = rec.filter((r) => now - r[0] <= 1000).length;
    const f = (v, w) => (typeof v === "number" ? v.toFixed(3).padStart(w) : "  --  ");
    const v = cal.liveVec;
    const steady = rec.length >= 5 ? spreadDeg(rec.map((r) => [r[1], r[2]])) : null;
    const got = cal.captured.filter(Boolean);
    let span = "--";
    if (got.length >= 2) {
      const ys = got.map((p) => p.raw[0] * RAD), ps = got.map((p) => p.raw[1] * RAD);
      span = `${(Math.max(...ys) - Math.min(...ys)).toFixed(0)}x${(Math.max(...ps) - Math.min(...ps)).toFixed(0)} deg`;
    }
    const lines = [
      "GAZE VECTOR   " + (fresh ? "(live)" : "(no signal)"),
      `x ${f(v && v[0], 7)}  y ${f(v && v[1], 7)}  z ${f(v && v[2], 7)}`,
      `yaw ${fresh ? (live[0] * RAD).toFixed(1).padStart(6) : "  --  "} deg   pitch ${fresh ? (live[1] * RAD).toFixed(1).padStart(6) : "  --  "} deg`,
      `samples/s ${String(hz).padStart(3)}   steadiness ${steady === null ? " --" : steady.toFixed(1).padStart(4)} deg`,
      `dots ${got.length}/${CAL_POINTS.length}   span ${span}`,
    ];
    const ro = $("#calib-readout");
    ro.textContent = lines.join("\n");
    const liveCls = steady === null ? "" : steadyClass(steady);
    ro.dataset.steady = liveCls;
    // The border around the whole page: how steady the gaze is right now while aiming,
    // how steady the capture was while reviewing, and the overall quality on the result screen.
    const frameCls = cal.phase === "review" ? cal.reviewCls : cal.phase === "done" ? cal.resultCls : fresh ? liveCls : "";
    $("#calib").dataset.steady = frameCls;
    $("#calib-legend").textContent = cal.phase === "review" ? "Border: how steady that capture was"
      : cal.phase === "done" ? "Border: overall calibration quality"
      : "Border: how steady your gaze is right now (green = good moment to capture)";
    drawPlot(rec, fresh, got);
  }

  // Raw yaw (right) vs pitch (down) in degrees, same scale on both axes.
  function drawPlot(rec, fresh, got) {
    const cv = $("#calib-plot");
    const w = cv.clientWidth, h = cv.clientHeight;
    if (!w || !h) return;
    const dpr = window.devicePixelRatio || 1;
    if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) {
      cv.width = Math.round(w * dpr);
      cv.height = Math.round(h * dpr);
    }
    const c = cv.getContext("2d");
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.clearRect(0, 0, w, h);
    const pts = got.map((p) => [p.raw[0] * RAD, p.raw[1] * RAD]);
    if (fresh) pts.push([cal.live[0] * RAD, cal.live[1] * RAD]);
    let x0 = -3, x1 = 3, y0 = -3, y1 = 3;
    if (pts.length) {
      x0 = Math.min(...pts.map((p) => p[0])); x1 = Math.max(...pts.map((p) => p[0]));
      y0 = Math.min(...pts.map((p) => p[1])); y1 = Math.max(...pts.map((p) => p[1]));
    }
    const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
    const halfY = Math.max(3, (y1 - y0) / 2 + 1.5, ((x1 - x0) / 2 + 1.5) * h / w);
    const scale = 0.78 * h / 2 / halfY; // 22% margin; degrees -> pixels, same on both axes
    const px = (d) => w / 2 + (d - cx) * scale;
    const py = (d) => h / 2 + (d - cy) * scale;
    c.strokeStyle = "#2a3446"; c.lineWidth = 1;
    c.strokeRect(0.5, 0.5, w - 1, h - 1);
    c.fillStyle = "#7f8ba0"; c.font = "11px monospace";
    c.textAlign = "right"; c.fillText("raw yaw > pitch v", w - 6, 14); c.textAlign = "left";
    got.forEach((p) => {
      const i = CAL_POINTS.findIndex((q) => q === p.target);
      c.fillStyle = "#35d0ff";
      c.beginPath(); c.arc(px(p.raw[0] * RAD), py(p.raw[1] * RAD), 5, 0, 7); c.fill();
      c.fillStyle = "#e6edf7";
      c.fillText(String(i + 1), px(p.raw[0] * RAD) + 7, py(p.raw[1] * RAD) - 5);
    });
    if (rec.length) {
      c.strokeStyle = "rgba(255,255,255,0.35)"; c.lineWidth = 1.5;
      c.beginPath();
      rec.forEach((r, k) => { const X = px(r[1] * RAD), Y = py(r[2] * RAD); k ? c.lineTo(X, Y) : c.moveTo(X, Y); });
      c.stroke();
    }
    if (fresh) {
      c.strokeStyle = cal.pending !== null ? "#4ade80" : "#fbbf24"; c.lineWidth = 2;
      c.beginPath(); c.arc(px(cal.live[0] * RAD), py(cal.live[1] * RAD), 6, 0, 7); c.stroke();
    }
  }

  async function refreshCalibStatus() {
    const b = $("#calib-badge");
    try {
      const s = await (await fetch("/api/calibration")).json();
      if (s.calibrated) {
        b.textContent = `Calibrated (~${s.loo_mean_pct.toFixed(1)}% error)`;
        b.className = "live";
      } else {
        b.textContent = "Not calibrated";
        b.className = "nosignal";
      }
    } catch (e) {
      b.textContent = "";
    }
  }

  // ---------- video panel (YouTube, controlled by our own big buttons) ----------
  const vid = { src: null, player: null, ready: false, duck: 0, errors: 0,
                level: Math.min(100, Math.max(0, Number(store.get("volume") ?? 100))), muted: false };

  // ---- volume: our own level (0-100, steps of 10), kept in the browser so it survives a reload ----
  function renderVolume() {
    const m = $("#v-mute");
    m.classList.toggle("muted", vid.muted || vid.level === 0);
    $("#vol-label").textContent = vid.muted || vid.level === 0 ? ui("muted") : `${ui("volume")} ${vid.level}%`;
    $("#vol-bar i").style.width = (vid.muted ? 0 : vid.level) + "%";
    m.setAttribute("aria-label", $("#vol-label").textContent);
  }

  // At 0% or muted the player is MUTED and its volume is left alone: calling unMute() after
  // setVolume(0) lets YouTube bring the old volume back, which is why 0% used to stay audible.
  // The player is only told about a change (mute <-> unmute, new volume), not on every step.
  const silent = () => vid.muted || vid.level === 0;

  function applyVolume() {
    renderVolume();
    if (!vid.ready || vid.duck > 0) return; // while speaking, the lowered volume stays until speech ends
    try {
      if (silent()) {
        if (vid.pMuted !== true) { vid.player.mute(); vid.pMuted = true; }
      } else {
        if (vid.pMuted !== false) { vid.player.unMute(); vid.pMuted = false; } // first, then the volume
        vid.player.setVolume(vid.level);
      }
    } catch (e) { /* ignore */ }
  }

  function stepVolume(d) {
    vid.level = Math.min(100, Math.max(0, vid.level + d * 10));
    if (d > 0) vid.muted = false; // asking for louder means: I want to hear it
    store.set("volume", vid.level);
    applyVolume();
  }

  function toggleMute() {
    vid.muted = !vid.muted;
    applyVolume();
  }

  function videoMsg(text) {
    $("#video-msg").textContent = text || "";
    $("#video-msg").style.display = text ? "flex" : "none";
  }

  // Title comes from the player, so it follows the playlist by itself.
  function showVideoTitle() {
    let t = "";
    try { t = (vid.player && vid.player.getVideoData && vid.player.getVideoData().title) || ""; } catch (e) { /* ignore */ }
    if (!t && vid.src && !vid.src.configured) t = ui("video_hint");
    $("#video-title").textContent = t;
  }

  function loadYouTubeApi() {
    return new Promise((resolve, reject) => {
      if (window.YT && window.YT.Player) return resolve();
      window.onYouTubeIframeAPIReady = resolve;
      const sc = document.createElement("script");
      sc.src = "https://www.youtube.com/iframe_api";
      sc.onerror = () => reject(new Error("offline"));
      document.head.appendChild(sc);
      setTimeout(() => reject(new Error("timeout")), 8000);
    });
  }

  async function initVideo() {
    try { vid.src = await (await fetch("/api/video-source")).json(); } catch (e) { vid.src = null; }
    if (!vid.src) { videoMsg(ui("video_off")); return; }
    startPlayer();
  }

  // (Re)create the player for vid.src. Used at start-up and when a caregiver picks another playlist.
  async function startPlayer() {
    showVideoTitle();
    videoMsg(ui("loading"));
    try {
      await loadYouTubeApi();
    } catch (e) {
      videoMsg(ui("video_off")); // the rest of the app still works without internet
      return;
    }
    if (vid.player) { try { vid.player.destroy(); } catch (e) { /* ignore */ } }
    vid.player = null;
    vid.ready = false;
    vid.pMuted = undefined; // what the new player is doing with its sound is not known yet
    vid.errors = 0;
    if (!document.getElementById("yt")) {          // destroy() removes the placeholder
      const d = document.createElement("div");
      d.id = "yt";
      $("#video-box").prepend(d);
    }
    const vars = { controls: 0, rel: 0, modestbranding: 1, disablekb: 1, playsinline: 1,
                   iv_load_policy: 3, origin: location.origin };
    const cfg = { width: "100%", height: "100%", playerVars: vars, events: {
      onReady: () => {
        vid.ready = true; videoMsg("");
        applyVolume();
        if (vid.src.playlist) { try { vid.player.setLoop(true); } catch (e) { /* ignore */ } }
        showVideoTitle();
      },
      // Nothing in this app changes the playback speed, so if it ever changes (a YouTube shortcut,
      // press-and-hold on the video), put it back to normal.
      onPlaybackRateChange: () => {
        try { if (vid.player.getPlaybackRate() !== 1) vid.player.setPlaybackRate(1); } catch (e) { /* ignore */ }
      },
      onStateChange: (e) => { if (e.data === 1) { vid.errors = 0; videoMsg(""); } showVideoTitle(); },
      onError: (e) => {
        // YouTube's error numbers: 100 not found or private, 101/150 owner blocks embedding,
        // 153 the page was opened in a way YouTube does not accept, 2 bad playlist or video id
        videoMsg(`${ui("video_error")} (YouTube error ${e && e.data})`);
        let n = 1;
        try { n = (vid.player.getPlaylist() || []).length || 1; } catch (err) { /* ignore */ }
        if (vid.src.playlist && n > 1 && ++vid.errors < n) setTimeout(() => stepVideo(1), 2000);
      },
    } };
    // a playlist needs no videoId, and the key must not be present at all (not even undefined)
    if (vid.src.playlist) { vars.listType = "playlist"; vars.list = vid.src.playlist; }
    else cfg.videoId = vid.src.video;
    clearTimeout(vid.watch);
    vid.watch = setTimeout(() => { if (!vid.ready) videoMsg(ui("video_stuck")); },
                           Number(new URLSearchParams(location.search).get("videowait")) || 15000);
    vid.player = new window.YT.Player("yt", cfg);
  }

  function togglePlay() {
    if (!vid.ready) return;
    const st = vid.player.getPlayerState();
    if (st === 1 || st === 3) vid.player.pauseVideo(); else vid.player.playVideo();
  }

  // Next / previous follow the YouTube playlist. A single video just starts over.
  function stepVideo(d) {
    if (!vid.ready) return;
    videoMsg("");
    if (vid.src.playlist) {
      if (d > 0) vid.player.nextVideo(); else vid.player.previousVideo();
    } else {
      vid.player.seekTo(0, true);
      vid.player.playVideo();
    }
  }

  // ---------- caregiver: choose the videos ----------
  function openVideoSetup() {
    $("#video-setup").hidden = false;
    $("#video-setup-msg").textContent = "";
    $("#video-url").value = "";
    setTimeout(() => $("#video-url").focus(), 0);
  }

  function closeVideoSetup() {
    $("#video-setup").hidden = true;
    $("#video-url").blur();
  }

  async function saveVideoSource() {
    const msg = $("#video-setup-msg");
    msg.className = "";
    msg.textContent = "Saving...";
    try {
      const r = await fetch("/api/video-source", { method: "POST", headers: { "Content-Type": "application/json" },
                                                    body: JSON.stringify({ url: $("#video-url").value }) });
      const body = await r.json();
      if (!r.ok) { msg.className = "bad"; msg.textContent = body.error || "Could not save."; return; }
      vid.src = body;
      closeVideoSetup();      // no page reload: the sentence and the started state stay as they are
      startPlayer();
    } catch (e) {
      msg.className = "bad";
      msg.textContent = "Could not reach the server.";
    }
  }

  async function resetVideoSource() {
    try { vid.src = await (await fetch("/api/video-source", { method: "DELETE" })).json(); } catch (e) { return; }
    closeVideoSetup();
    startPlayer();
  }

  // Lower the video while the app speaks, restore it afterwards.
  function duckVideo(on) {
    vid.duck = Math.max(0, vid.duck + (on ? 1 : -1));
    if (!vid.ready) return;
    try {
      if (on && vid.duck === 1 && !silent()) vid.player.setVolume(Math.min(vid.level, 15));
      else if (!on && vid.duck === 0) applyVolume(); // back to the chosen level (or still silent)
    } catch (e) { /* ignore */ }
  }

  // ---------- "I need help": spoken alert that repeats until it is cancelled ----------
  const help = { on: false, timer: null };

  function sayHelp() {
    speak([{ id: "ui_help", label: state.vocab.ui.help_phrase }]);
  }

  function callHelp() {
    if (help.on) return;
    help.on = true;
    $("#help-alert").hidden = false;
    if (vid.ready) { try { vid.player.pauseVideo(); } catch (e) { /* ignore */ } }
    sayHelp();
    help.timer = setInterval(sayHelp, 9000);
  }

  function cancelHelp() {
    help.on = false;
    clearInterval(help.timer);
    $("#help-alert").hidden = true;
  }

  // ---------- boot ----------
  async function init() {
    const res = await fetch("/api/vocab");
    state.vocab = await res.json();

    const params = new URLSearchParams(location.search);
    state.dwellCfg = Object.assign({}, state.vocab.dwell);
    const over = Number(params.get("dwell")); // ?dwell=600 : every target selects after 600 ms (testing)
    if (over) for (const k of ["word", "category", "nav", "speak", "clear", "help", "video", "volume"]) state.dwellCfg[k] = over;
    if (Number(params.get("memory"))) state.dwellCfg.memory_ms = Number(params.get("memory"));
    if (Number(params.get("repeat"))) state.dwellCfg.volume_repeat_ms = Number(params.get("repeat"));
    state.lang = params.get("lang") || store.get("lang") || "en";
    if (!state.vocab.languages.includes(state.lang)) state.lang = "en";
    document.documentElement.lang = state.lang;

    $("#btn-speak")._act = speakSentence;
    $("#btn-clear")._act = clearSentence;
    $("#btn-help")._act = callHelp;
    $("#help-cancel")._act = cancelHelp;
    $("#v-prev")._act = () => stepVideo(-1);
    $("#v-play")._act = togglePlay;
    $("#v-next")._act = () => stepVideo(1);
    $("#v-vdown")._act = () => stepVolume(-1);
    $("#v-vup")._act = () => stepVolume(1);
    $("#v-mute")._act = toggleMute;
    for (const id of ["#btn-speak", "#btn-clear", "#btn-help", "#help-cancel", "#v-prev", "#v-play", "#v-next",
                      "#v-vdown", "#v-vup", "#v-mute"]) {
      const b = $(id);
      b.addEventListener("click", () => fire(b));
    }

    renderAll();
    setMode(params.get("mode") || store.get("mode") || "mouse");
    if (params.get("nostart") === "1") begin();

    refreshCalibStatus();
    initVideo();
    setInterval(updateBadge, 500);
    requestAnimationFrame(loop);
  }

  init();
})();
