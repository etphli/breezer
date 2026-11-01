// Shared motion toolkit for the Breezer ads.
//
// Each ad page calls AD.setup({...}) and supplies frame(t). Every visual state
// is a pure function of t (seconds), so render.mjs can step through frames
// deterministically and the soundtrack can be scored from the same timeline.
// Open a page directly in a browser to preview it in real time; add ?t=12.5 to
// freeze a frame.

(() => {
  const W = 1920;
  const H = 1080;
  const ASSETS = "../../assets/branding/";
  const SHOTS = "../../site/shots/";

  const clamp = (x, a = 0, b = 1) => (x < a ? a : x > b ? b : x);
  const lerp = (a, b, p) => a + (b - a) * p;
  const prog = (t, a, b) => clamp((t - a) / (b - a));
  const ease = {
    linear: (x) => x,
    out: (x) => 1 - (1 - x) ** 3,
    in: (x) => x ** 3,
    inOut: (x) => (x < 0.5 ? 4 * x ** 3 : 1 - (-2 * x + 2) ** 3 / 2),
    expo: (x) => (x >= 1 ? 1 : 1 - 2 ** (-10 * x)),
    inExpo: (x) => (x <= 0 ? 0 : 2 ** (10 * x - 10)),
    quint: (x) => 1 - (1 - x) ** 5,
    back: (x) => {
      const c = 1.70158;
      return 1 + (c + 1) * (x - 1) ** 3 + c * (x - 1) ** 2;
    },
  };

  // Stable pseudo-random value in [0, 1) for any number.
  const hash = (n) => {
    const x = Math.sin(n * 127.1 + 311.7) * 43758.5453123;
    return x - Math.floor(x);
  };

  // Decaying envelope that peaks at each listed time.
  const pulse = (t, times, decay = 0.22) => {
    let v = 0;
    for (const at of times) if (t >= at) v = Math.max(v, Math.exp(-(t - at) / decay));
    return v;
  };

  // Distance travelled by a varying speed, integrated from zero.
  const travel = (speedAt, t, step = 1 / 120) => {
    let d = 0;
    for (let s = 0; s < t; s += step) d += speedAt(s) * Math.min(step, t - s);
    return d;
  };

  const el = (tag, cls, parent, html) => {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (html != null) node.innerHTML = html;
    if (parent) parent.appendChild(node);
    return node;
  };

  const set = (node, styles) => {
    for (const k in styles) node.style[k] = styles[k];
  };

  // Wind streaks, the recurring Breezer motif. `dist` is pixels travelled.
  function wind(ctx, dist, o = {}) {
    const {
      count = 90, seed = 1, alpha = 0.6, len = 260, width = 2.2,
      colors = ["#b9ffe6", "#8ff0d0", "#5cc4f2"], y0 = 0, y1 = H,
      wobble = 0, t = 0, spread = 1, dir = 1,
    } = o;
    const span = W + 1200;
    ctx.save();
    ctx.lineCap = "round";
    for (let i = 0; i < count; i++) {
      const h = (k) => hash(seed * 977 + i * 13.37 + k * 101.3);
      const y = lerp(y0, y1, h(1)) + Math.sin(t * (0.6 + h(2)) + i) * wobble;
      const v = 0.45 + h(3) * spread;
      let x = ((h(4) * span + dist * v) % span) - 600;
      if (dir < 0) x = W - x;
      const L = len * (0.4 + h(5));
      const a = alpha * (0.25 + 0.75 * h(6));
      const g = ctx.createLinearGradient(x - L * dir, y, x, y);
      const c = colors[i % colors.length];
      g.addColorStop(0, c + "00");
      g.addColorStop(1, c + Math.round(a * 255).toString(16).padStart(2, "0"));
      ctx.strokeStyle = g;
      ctx.lineWidth = width * (0.5 + h(7));
      ctx.beginPath();
      ctx.moveTo(x - L * dir, y);
      ctx.lineTo(x, y);
      ctx.stroke();
    }
    ctx.restore();
  }

  function canvas(parent, z = 1) {
    const c = el("canvas", "full", parent);
    c.width = W;
    c.height = H;
    c.style.zIndex = z;
    return c.getContext("2d");
  }

  // Browser window mock with Breezer's left tab column.
  function browserWindow(parent, { tabs = [], url = "", shot = null } = {}) {
    const win = el("div", "win", parent);
    const side = el("div", "win-side", win);
    el("div", "win-lights", side, "<i></i><i></i><i></i>");
    const urlBar = el("div", "win-url", side, url);
    const tabNodes = tabs.map(([letter, color, title], i) =>
      el("div", "tab" + (i === 0 ? " on" : ""), side, `<b style="background:${color}">${letter}</b>${title}`));
    const main = el("div", "win-main", win);
    let img = null;
    if (shot) {
      img = el("img", "shot", main);
      img.src = SHOTS + shot;
    }
    return { win, side, urlBar, tabNodes, main, img };
  }

  const AD = {
    W, H, fps: 30, duration: 30, ASSETS, SHOTS,
    clamp, lerp, prog, ease, hash, pulse, travel, el, set, wind, canvas, browserWindow,
    audio: { bpm: 120, progression: [], sections: [], sfx: [] },
    stage: null,
    frame: () => {},
  };

  AD.beat = (n) => (n * 60) / AD.audio.bpm;
  AD.sfx = (t, type, opts = {}) => AD.audio.sfx.push({ t, type, ...opts });

  // Shared closing card. Returns a frame function that takes the card's start.
  function mountEndCard(tagline) {
    const card = el("div", "", AD.stage);
    card.id = "endcard";
    card.innerHTML = `
      <div class="ec-glow"></div>
      <svg viewBox="0 0 1920 1080" width="1920" height="1080">
        <defs><linearGradient id="ec-rib" x1="0" x2="1"><stop offset="0" stop-color="#b9ffe6"/><stop offset=".5" stop-color="#8ff0d0"/><stop offset="1" stop-color="#5cc4f2"/></linearGradient></defs>
        <path class="ec-line" pathLength="1" fill="none" stroke="url(#ec-rib)" stroke-width="3" stroke-linecap="round"
          d="M-40 960 C 300 860, 520 1040, 820 950 S 1260 830, 1420 920 C 1520 990, 1440 1050, 1380 1020 C 1330 996, 1380 950, 1480 958 C 1640 970, 1780 930, 1980 900"/>
      </svg>
      <div class="ec-inner">
        <img class="ec-logo" src="${ASSETS}breezer-logo.png" alt="">
        <div class="ec-word">${[..."Breezer"].map((c) => `<span>${c}</span>`).join("")}</div>
        <div class="ec-tag">${tagline}</div>
        <div class="ec-pillars"><span>Fast</span><span>Bloat-free</span><span>Private</span></div>
        <div class="ec-cta">Free for Mac at <strong>breezer-browser.vercel.app</strong></div>
      </div>`;
    const line = card.querySelector(".ec-line");
    const logo = card.querySelector(".ec-logo");
    const letters = [...card.querySelectorAll(".ec-word span")];
    const tag = card.querySelector(".ec-tag");
    const pills = [...card.querySelectorAll(".ec-pillars span")];
    const cta = card.querySelector(".ec-cta");
    const glow = card.querySelector(".ec-glow");

    return (t, t0) => {
      const s = t - t0;
      card.style.opacity = s < 0 ? 0 : ease.out(prog(s, 0, 0.35));
      if (s < 0) return;
      const lineP = ease.inOut(prog(s, 0.05, 1.6));
      line.style.strokeDasharray = "1";
      line.style.strokeDashoffset = String(1 - lineP);
      line.style.opacity = String(0.55 * (1 - prog(s, 3.5, 5.5) * 0.5));
      const lp = prog(s, 0.15, 1.1);
      const ls = lerp(0.55, 1, ease.back(lp));
      set(logo, {
        transform: `scale(${ls}) rotate(${lerp(-14, 0, ease.out(lp))}deg)`,
        opacity: ease.out(prog(s, 0.15, 0.5)),
        filter: `blur(${lerp(14, 0, ease.out(lp))}px) drop-shadow(0 30px 60px rgb(0 0 0 / .5))`,
      });
      glow.style.opacity = String(ease.out(prog(s, 0.3, 1.6)) * (0.85 + 0.15 * Math.sin(s * 2.2)));
      glow.style.transform = `scale(${1 + 0.04 * Math.sin(s * 1.3)})`;
      letters.forEach((n, i) => {
        const p = ease.expo(prog(s, 0.55 + i * 0.045, 1.15 + i * 0.045));
        set(n, { transform: `translateY(${(1 - p) * 60}px)`, opacity: p, filter: `blur(${(1 - p) * 10}px)` });
      });
      const tp = ease.out(prog(s, 1.3, 2));
      set(tag, { opacity: tp, transform: `translateY(${(1 - tp) * 18}px)` });
      pills.forEach((n, i) => {
        const p = ease.back(prog(s, 2.0 + i * 0.12, 2.5 + i * 0.12));
        set(n, { opacity: clamp(p), transform: `scale(${lerp(0.7, 1, p)})` });
      });
      const cp = ease.out(prog(s, 2.8, 3.5));
      set(cta, { opacity: cp, transform: `translateY(${(1 - cp) * 12}px)` });
    };
  }
  AD.mountEndCard = mountEndCard;

  // Film grain: a fixed noise tile, re-offset every frame.
  function mountGrain() {
    const tile = document.createElement("canvas");
    tile.width = tile.height = 256;
    const tctx = tile.getContext("2d");
    const data = tctx.createImageData(256, 256);
    for (let i = 0; i < data.data.length; i += 4) {
      const v = Math.floor(hash(i * 0.731) * 255);
      data.data[i] = data.data[i + 1] = data.data[i + 2] = v;
      data.data[i + 3] = 255;
    }
    tctx.putImageData(data, 0, 0);
    const c = el("canvas", "", AD.stage);
    c.id = "grain";
    c.width = W;
    c.height = H;
    const ctx = c.getContext("2d");
    const pattern = ctx.createPattern(tile, "repeat");
    return (t) => {
      const f = Math.floor(t * AD.fps / 2);
      ctx.save();
      ctx.translate(-Math.floor(hash(f) * 256), -Math.floor(hash(f + 0.5) * 256));
      ctx.fillStyle = pattern;
      ctx.fillRect(0, 0, W + 256, H + 256);
      ctx.restore();
    };
  }

  AD.setup = async ({ bpm = 120, progression = ["Am", "F", "C", "G"], sections = [], frame }) => {
    AD.audio.bpm = bpm;
    AD.audio.progression = progression;
    AD.audio.sections = sections;
    AD.stage = document.getElementById("stage");
    const grain = mountGrain();
    el("div", "", AD.stage).id = "vignette";
    AD.flashNode = el("div", "", AD.stage);
    AD.flashNode.id = "flash";
    const userFrame = frame();
    AD.frame = (t) => {
      userFrame(t);
      grain(t);
    };
    await document.fonts.ready;
    await Promise.all([...document.images].map((img) => (img.complete ? null : img.decode().catch(() => null))));
    AD.ready = true;
    startPreview();
  };

  AD.flash = (v) => (AD.flashNode.style.opacity = String(clamp(v)));

  function startPreview() {
    const params = new URLSearchParams(location.search);
    if (params.has("render")) return;
    const fit = () => {
      const k = Math.min(innerWidth / W, innerHeight / H);
      AD.stage.style.transform = `scale(${k})`;
    };
    fit();
    addEventListener("resize", fit);
    if (params.has("t")) return AD.frame(Number(params.get("t")));
    const start = performance.now();
    const tick = () => {
      AD.frame(((performance.now() - start) / 1000) % AD.duration);
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  window.AD = AD;
})();
