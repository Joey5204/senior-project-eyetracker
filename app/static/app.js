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

  // Calibration state. phase: "idle" | "aim" | "capture" | "review" | "done" (result showing).
  // `run` is bumped whenever a calibration is cancelled, so a stale run stops by itself.
  const cal = {
    active: false, phase: "idle", collecting: false, buffer: [], run: 0,
    asker: null, pending: null, captured: [], recent: [], live: null, liveVec: null,
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
    // While the calibration dots are showing, hide the cursor: it would only distract.
    const hideDot = gazeStale || (cal.active && cal.phase !== "done");
    if (cal.active) hudTick(now);
    $("#gaze-dot").style.visibility = hideDot ? "hidden" : "visible";
    const el = state.started && !gazeStale && !cal.active ? targetAt(state.pointer.x, state.pointer.y) : null;
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
    if (!state.started) { begin(); return; }
    const k = e.key.toLowerCase();
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
    else if (k === "l") toggleLang();
    else if (k === "f") {
      if (document.fullscreenElement) document.exitFullscreen();
      else document.documentElement.requestFullscreen().catch(() => {});
    }
  });
  $("#start").addEventListener("click", begin);
  $("#btn-lang").addEventListener("click", toggleLang);
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

  // The full aim -> capture -> review loop for one dot. Returns false if cancelled.
  async function captureDot(i, myRun, total) {
    const label = `Dot ${i + 1} of ${CAL_POINTS.length}`;
    for (;;) {
      calDot(CAL_POINTS[i], "");
      calMsg(`${label}: look at the dot, hold still, then press Capture.`);
      $("#calib-marks").textContent = "";
      drawMarks(false);
      cal.phase = "aim";
      $("#calib").dataset.phase = "aim";
      if ((await ask(myRun, [{ name: "capture", label: "Capture (Space)", keys: [" ", "enter"], primary: true }])) === null) return false;

      cal.phase = "capture";
      $("#calib").dataset.phase = "capture";
      calMsg(`${label}: measuring... keep looking at the dot.`);
      const m = await measure(i, myRun);
      if (!m || cal.run !== myRun) return false;

      cal.phase = "review";
      $("#calib").dataset.phase = "review";
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
      options.push({ name: "redo", label: "Redo (R)", keys: ["r"], primary: !enough });
      const a = await ask(myRun, options);
      if (a === null) return false;
      if (a === "accept") {
        cal.captured[i] = { target: CAL_POINTS[i], raw: m.raw, n: m.n, spread: m.spread };
        return true;
      }
      // redo: loop and show the dot again
    }
  }

  // Draw the numbered circles. With a result, colour them by how well each dot was predicted.
  function drawMarks(result) {
    const box = $("#calib-marks");
    box.textContent = "";
    CAL_POINTS.forEach((p, i) => {
      if (!result && !cal.captured[i]) return;
      const m = document.createElement("div");
      m.className = "calib-mark";
      if (result) {
        const e = result.per_point_loo_pct && result.per_point_loo_pct[i];
        if (typeof e === "number") m.classList.add(e <= 5 ? "ok" : e <= 10 ? "warn" : "bad");
        m.title = "Click to redo this dot";
        m.dataset.dot = String(i);
        m.addEventListener("click", () => cal.asker && cal.asker.done("dot:" + i));
      } else {
        m.classList.add("taken");
      }
      m.textContent = String(i + 1);
      m.style.left = p[0] * 100 + "%";
      m.style.top = p[1] * 100 + "%";
      box.appendChild(m);
    });
  }

  async function runCalibration() {
    if (cal.active) return;
    const myRun = ++cal.run;
    cal.active = true;
    cal.phase = "aim";
    cal.collecting = false;
    cal.pending = null;
    cal.captured = CAL_POINTS.map(() => null);
    cal.recent = [];
    cal.live = null;
    cal.liveVec = null;
    if (state.mode !== "gaze") setMode("gaze"); // calibration needs the tracker's data
    clearDwell();
    $("#calib-marks").textContent = "";
    $("#calib-actions").textContent = "";
    $("#calib-dot").hidden = false;
    $("#calib").hidden = false;

    for (let i = 0; i < CAL_POINTS.length; i++) {
      if (!(await captureDot(i, myRun))) return;
    }
    // All nine accepted: fit, then let the user redo any single dot.
    for (;;) {
      const res = await fitNow(myRun);
      if (res === undefined) return; // cancelled
      const next = await showResult(res, myRun);
      if (next === null) return;
      if (next === "all") return restartCalibration();
      if (next === "finish") return endCalibration();
      if (typeof next === "number") {
        $("#calib-dot").hidden = false;
        cal.phase = "aim";
        if (!(await captureDot(next, myRun))) return;
      }
    }
  }

  function restartCalibration() {
    endCalibration();
    runCalibration();
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
    cal.phase = "done"; // the blue gaze cursor comes back so the user can compare it to the circles
    $("#calib").dataset.phase = "done";
    refreshCalibStatus();
    const keyDot = (k) => (/^[1-9]$/.test(k) ? "dot:" + (Number(k) - 1) : null);
    let a;
    if (res.error) {
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
      calMsg(`${verdict[0]}. Estimated error ${q.toFixed(1)}% of the screen width${deg}. ` +
        "Click a circle (or press 1-9) to redo that dot. Blue cursor = where you look now.", verdict[1]);
      drawMarks(res);
      a = await ask(myRun, [
        { name: "finish", label: "Finish (Enter)", keys: ["enter", " "], primary: verdict[1] !== "bad" },
        { name: "all", label: "Redo all (C)", keys: ["c"] },
      ], keyDot);
    }
    if (a && a.startsWith("dot:")) return Number(a.slice(4));
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
    ro.dataset.steady = steady === null ? "" : steadyClass(steady);
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

    refreshCalibStatus();
    setInterval(updateBadge, 500);
    requestAnimationFrame(loop);
  }

  init();
})();
