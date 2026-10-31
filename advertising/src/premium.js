// Premium additions for the voiced ads: voice-over timeline, a WebGL layer,
// word-synced captions, a glass window and the closing card. Load after common.js.

(() => {
  const AD = window.AD;
  const { clamp, prog, ease, lerp, el, set } = AD;
  AD.subframes = 2;
  AD.audio.engine = "premium";

  // Splits the ElevenLabs timings into sentences and words, then places groups
  // of consecutive sentences at chosen times. groups: [[first, last, at], ...]
  AD.voice = (data, file, groups, duck = 0.55) => {
    const { text, starts, ends } = data;
    const phrases = [];
    const re = /.*?(\.\.\.|[.?!])(\s+|$)/g;
    let m;
    while ((m = re.exec(text)) && m[0].length) {
      const lead = m[0].length - m[0].trimStart().length;
      const seg = m[0].trim();
      const a = m.index + lead;
      const b = a + seg.length - 1;
      const words = [];
      const wre = /\S+/g;
      let w;
      while ((w = wre.exec(seg))) {
        const ia = a + w.index;
        const ib = ia + w[0].length - 1;
        words.push({ text: w[0], start: starts[ia], end: ends[ib] });
      }
      phrases.push({ text: seg, start: starts[a], end: ends[b], words });
    }
    const covered = groups.flatMap(([i0, i1]) => Array.from({ length: i1 - i0 + 1 }, (_, k) => i0 + k));
    if (covered.join() !== phrases.map((_, i) => i).join()) throw new Error(`voice groups must cover ${phrases.length} phrases in order`);

    const segments = [];
    const placed = [];
    for (const [i0, i1, at] of groups) {
      const first = phrases[i0];
      const last = phrases[i1];
      const prev = phrases[i0 - 1];
      const next = phrases[i1 + 1];
      const from = prev ? Math.max((prev.end + first.start) / 2, first.start - 0.18) : Math.max(0, first.start - 0.05);
      const to = next ? Math.min((last.end + next.start) / 2, last.end + 0.45) : last.end + 0.7;
      const shift = at - first.start;
      segments.push({ from, to, at: from + shift });
      for (let i = i0; i <= i1; i++) {
        const p = phrases[i];
        placed.push({ text: p.text, start: p.start + shift, end: p.end + shift, words: p.words.map((w) => ({ ...w, start: w.start + shift, end: w.end + shift })) });
      }
    }
    AD.audio.voice = { file, segments, duck };
    AD.vo = placed;
    return placed;
  };

  // The time a given word in a phrase is spoken.
  AD.wordAt = (phrase, needle) => {
    const w = phrase.words.find((x) => x.text.toLowerCase().replace(/[^a-z']/g, "").startsWith(needle));
    if (!w) throw new Error(`"${needle}" not in "${phrase.text}"`);
    return w.start;
  };

  // A caption whose words arrive as they are spoken.
  AD.caption = (parent, phrase, cls = "", { hold = 0.9, text } = {}) => {
    const node = el("div", "caption " + cls, parent);
    const words = (text ? text.split(" ") : phrase.words.map((w) => w.text));
    const spans = words.map((w) => el("span", "", node, w));
    const times = words.map((_, i) => phrase.words[Math.min(i, phrase.words.length - 1)].start);
    const out = phrase.end + hold;
    const update = (t, opts = {}) => {
      const until = opts.until ?? out;
      const fade = 1 - ease.inOut(prog(t, until, until + 0.5));
      node.style.opacity = t < times[0] - 0.2 || fade <= 0 ? 0 : 1;
      spans.forEach((s, i) => {
        const p = ease.out(prog(t, times[i] - 0.06, times[i] + 0.38));
        set(s, { opacity: p * fade, transform: `translateY(${(1 - p) * 0.28}em)`, filter: `blur(${(1 - p) * 8 + (1 - fade) * 6}px)` });
      });
    };
    update.node = node;
    return update;
  };

  // Full-frame WebGL2 fragment shader. Uniforms: t, res, and u0..u3 (vec4).
  AD.shader = (body, z = 1) => {
    const c = el("canvas", "full", AD.stage);
    c.width = AD.W;
    c.height = AD.H;
    c.style.zIndex = z;
    const gl = c.getContext("webgl2", { preserveDrawingBuffer: true, antialias: false });
    const vs = "#version 300 es\nin vec2 p;void main(){gl_Position=vec4(p,0.,1.);}";
    const fs = `#version 300 es
precision highp float;
uniform float t; uniform vec2 res; uniform vec4 u0, u1, u2, u3; out vec4 o;
float hash(vec2 p){ p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float noise(vec2 p){ vec2 i = floor(p), f = fract(p); f = f * f * (3. - 2. * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x), mix(hash(i + vec2(0, 1)), hash(i + 1.), f.x), f.y); }
float fbm(vec2 p){ float v = 0., a = .5; mat2 r = mat2(.8, .6, -.6, .8); for (int i = 0; i < 6; i++){ v += a * noise(p); p = r * p * 2.02; a *= .5; } return v; }
${body}`;
    const compile = (type, src) => {
      const s = gl.createShader(type);
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
      return s;
    };
    const prg = gl.createProgram();
    gl.attachShader(prg, compile(gl.VERTEX_SHADER, vs));
    gl.attachShader(prg, compile(gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(prg);
    gl.useProgram(prg);
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    const loc = Object.fromEntries(["t", "res", "u0", "u1", "u2", "u3"].map((k) => [k, gl.getUniformLocation(prg, k)]));
    gl.viewport(0, 0, c.width, c.height);
    return (t, u = {}) => {
      gl.uniform1f(loc.t, t);
      gl.uniform2f(loc.res, c.width, c.height);
      for (const k of ["u0", "u1", "u2", "u3"]) gl.uniform4fv(loc[k], u[k] || [0, 0, 0, 0]);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    };
  };

  // Glass browser window: Breezer's layout with a moving specular sweep.
  AD.glassWindow = (parent, opts) => {
    const w = AD.browserWindow(parent, opts);
    w.win.classList.add("glass");
    w.sheen = el("div", "sheen", w.win);
    w.light = (x) => (w.sheen.style.backgroundPosition = `${x * 100}% 0`);
    return w;
  };

  // Closing card. theme: "dark" or "light".
  AD.premiumEnd = (tagline, { theme = "dark", lines = null } = {}) => {
    const card = el("div", "pend " + theme, AD.stage);
    card.innerHTML = `
      <div class="pend-glow"></div>
      <div class="pend-inner">
        <img class="pend-logo" src="${AD.ASSETS}breezer-logo.png" alt="">
        <div class="pend-word">Breezer</div>
        <div class="pend-tag">${lines ? lines.map((l) => `<span>${l}</span>`).join(" ") : tagline}</div>
        <div class="pend-cta">Free for Mac. breezer-browser.vercel.app</div>
      </div>`;
    const logo = card.querySelector(".pend-logo");
    const word = card.querySelector(".pend-word");
    const tag = card.querySelector(".pend-tag");
    const tagParts = lines ? [...tag.children] : [tag];
    const cta = card.querySelector(".pend-cta");
    const glow = card.querySelector(".pend-glow");
    return (t, t0, { wordAt = t0 + 0.4, tagAt = [t0 + 1.3] } = {}) => {
      const s = t - t0;
      card.style.opacity = s < 0 ? 0 : ease.inOut(prog(s, 0, 0.8));
      if (s < 0) return;
      const lp = ease.out(prog(s, 0, 1.6));
      set(logo, { opacity: lp, transform: `translateY(${(1 - lp) * 30}px) scale(${lerp(0.86, 1, lp) + s * 0.004})`, filter: `blur(${(1 - lp) * 16}px)` });
      glow.style.opacity = String(ease.out(prog(s, 0.2, 2.5)) * (0.85 + 0.15 * Math.sin(s * 1.6)));
      const wp = ease.out(prog(t, wordAt - 0.05, wordAt + 0.7));
      set(word, { opacity: wp, transform: `translateY(${(1 - wp) * 24}px)`, filter: `blur(${(1 - wp) * 12}px)`, letterSpacing: `${lerp(0.02, -0.035, wp)}em` });
      tagParts.forEach((n, i) => {
        const at = tagAt[Math.min(i, tagAt.length - 1)];
        const p = ease.out(prog(t, at - 0.05, at + 0.6));
        set(n, { opacity: p, transform: `translateY(${(1 - p) * 16}px)`, filter: `blur(${(1 - p) * 8}px)`, display: "inline-block" });
      });
      const last = tagAt[tagAt.length - 1];
      const cp = ease.out(prog(t, last + 1.0, last + 1.8));
      set(cta, { opacity: cp * 0.75 });
    };
  };
})();
