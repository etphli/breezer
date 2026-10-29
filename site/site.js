// Breezer website motion: a wind field behind the page, word-by-word heading
// reveals, scroll-linked scenes, a velocity-aware marquee and pointer effects.
// With reduced motion only the content reveals remain (and appear instantly).

const reduce = matchMedia('(prefers-reduced-motion: reduce)');
const clamp = (v, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, v));

// ---------------------------------------------------------------- reveals

for (const heading of document.querySelectorAll('.split')) {
  let i = 0;
  const words = (node) => {
    for (const child of [...node.childNodes]) {
      if (child.nodeType === Node.TEXT_NODE) {
        const frag = document.createDocumentFragment();
        for (const part of child.textContent.split(/(\s+)/)) {
          if (!part) continue;
          if (/^\s+$/.test(part)) { frag.append(part); continue; }
          const w = document.createElement('span');
          w.className = 'w';
          w.style.setProperty('--i', i++);
          w.textContent = part;
          frag.append(w);
        }
        child.replaceWith(frag);
      } else if (child.nodeType === Node.ELEMENT_NODE) {
        words(child);
      }
    }
  };
  heading.setAttribute('aria-label', heading.textContent.replace(/\s+/g, ' ').trim());
  words(heading);
  for (const w of heading.querySelectorAll('.w')) w.setAttribute('aria-hidden', 'true');
}

// Siblings that reveal together get a small stagger.
for (const group of document.querySelectorAll('.hero-copy, .install-steps, .duo, .finale')) {
  [...group.querySelectorAll('.reveal')].forEach((el, n) => el.style.setProperty('--d', `${n * 110}ms`));
}

const io = new IntersectionObserver((entries) => {
  for (const entry of entries) {
    if (entry.isIntersecting) { entry.target.classList.add('in'); io.unobserve(entry.target); }
  }
}, { rootMargin: '0px 0px -12% 0px' });
for (const el of document.querySelectorAll('.split, .reveal, .install-step')) io.observe(el);

// --------------------------------------------------------- scroll scenes

const hero = document.querySelector('.hero .stage');
const story = document.querySelector('.story');
const swap = story?.querySelector('.swap');
const steps = story ? [...story.querySelectorAll('.step')] : [];
const sidebar = document.querySelector('.sidebar-stage');
const assistant = document.querySelector('.assistant');
const fan = assistant?.querySelector('.fan');
const track = document.querySelector('.marquee-track');

// 0 when the element's top enters the bottom of the viewport, 1 at `end` of it.
const entering = (el, end = 0.3) => {
  const top = el.getBoundingClientRect().top;
  const vh = innerHeight;
  return clamp((vh - top) / (vh * (1 - end)));
};

let lastY = scrollY;
let velocity = 0;
let offset = 0;

function frame() {
  const y = scrollY;
  velocity = velocity * 0.9 + (y - lastY) * 0.1;
  lastY = y;

  if (!reduce.matches) {
    if (hero) hero.style.setProperty('--p', entering(hero, 0.45).toFixed(4));
    if (sidebar) sidebar.style.setProperty('--p', entering(sidebar, 0.5).toFixed(4));
    if (fan) assistant.style.setProperty('--p', entering(fan, 0.55).toFixed(4));

    if (story && getComputedStyle(story).position !== 'static' && story.offsetHeight > innerHeight * 1.5) {
      const r = story.getBoundingClientRect();
      const p = clamp(-r.top / (r.height - innerHeight));
      story.style.setProperty('--p', p.toFixed(4));
      swap.style.setProperty('--wipe', clamp((p - 0.64) / 0.26).toFixed(4));
      const active = Math.min(2, Math.floor(p * 3));
      if (story.dataset.active !== String(active)) {
        story.dataset.active = active;
        steps.forEach((s, n) => s.classList.toggle('active', n === active));
      }
    }

    if (track) {
      offset -= 0.6 + Math.abs(velocity) * 0.35;
      const half = track.scrollWidth / 2;
      if (-offset > half) offset += half;
      track.style.transform = `translate3d(${offset}px,0,0)`;
    }
  }
  requestAnimationFrame(frame);
}

if (story) { steps.forEach((s, n) => s.classList.toggle('active', n === 0)); story.dataset.active = 0; }
requestAnimationFrame(frame);

// -------------------------------------------------------- pointer effects

const fine = matchMedia('(pointer: fine)');

for (const el of document.querySelectorAll('.magnetic')) {
  el.addEventListener('pointermove', (e) => {
    if (reduce.matches || !fine.matches) return;
    const r = el.getBoundingClientRect();
    el.style.setProperty('--mx', `${(e.clientX - r.left - r.width / 2) * 0.28}px`);
    el.style.setProperty('--my', `${(e.clientY - r.top - r.height / 2) * 0.4}px`);
  });
  el.addEventListener('pointerleave', () => { el.style.setProperty('--mx', '0px'); el.style.setProperty('--my', '0px'); });
}

for (const el of document.querySelectorAll('.tilt')) {
  const target = el.firstElementChild;
  el.addEventListener('pointermove', (e) => {
    if (reduce.matches || !fine.matches) return;
    const r = el.getBoundingClientRect();
    const x = (e.clientX - r.left) / r.width - 0.5;
    const y = (e.clientY - r.top) / r.height - 0.5;
    target.style.transform = `perspective(900px) rotateY(${x * 14}deg) rotateX(${-y * 12}deg) translateZ(10px)`;
  });
  el.addEventListener('pointerleave', () => { target.style.transform = ''; });
}

// -------------------------------------------------------------- the wind

const canvas = document.querySelector('.wind');
const pointer = { x: -1e4, y: -1e4 };
addEventListener('pointermove', (e) => { pointer.x = e.clientX; pointer.y = e.clientY; }, { passive: true });

if (canvas && !reduce.matches) {
  const ctx = canvas.getContext('2d');
  let w = 0, h = 0, dpr = 1, particles = [];
  const COLORS = ['29, 84, 88', '143, 213, 196', '72, 140, 130'];

  const spawn = (p = {}) => Object.assign(p, {
    x: Math.random() * w - w * 0.1,
    y: Math.random() * h,
    life: 0,
    max: 160 + Math.random() * 260,
    color: COLORS[(Math.random() * COLORS.length) | 0],
    width: 0.6 + Math.random() * 1.6,
  });

  const resize = () => {
    dpr = Math.min(devicePixelRatio || 1, 2);
    w = innerWidth; h = innerHeight;
    canvas.width = w * dpr; canvas.height = h * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const count = Math.round(Math.min(220, (w * h) / 7000));
    particles = Array.from({ length: count }, () => { const p = spawn(); p.life = Math.random() * p.max; return p; });
  };
  resize();
  addEventListener('resize', resize);

  // A smooth, slowly changing flow field that mostly blows left to right.
  const field = (x, y, t) =>
    Math.sin(x * 0.0021 + t * 0.00021) * 0.9 +
    Math.cos(y * 0.0034 - t * 0.00017) * 0.7 +
    Math.sin((x + y) * 0.0012 + t * 0.0003) * 0.5;

  let running = true;
  document.addEventListener('visibilitychange', () => { running = !document.hidden; if (running) requestAnimationFrame(draw); });

  function draw(t) {
    if (!running) return;
    ctx.globalCompositeOperation = 'destination-out';
    ctx.fillStyle = 'rgba(0,0,0,0.07)';
    ctx.fillRect(0, 0, w, h);
    ctx.globalCompositeOperation = 'source-over';
    const drift = velocity * 0.08;

    for (const p of particles) {
      const a = field(p.x, p.y, t) * 0.55;
      let vx = Math.cos(a) * 1.5 + 0.9;
      let vy = Math.sin(a) * 1.2 - drift;

      // Swirl around the pointer, like air around a moving hand.
      const dx = p.x - pointer.x, dy = p.y - pointer.y;
      const d2 = dx * dx + dy * dy;
      if (d2 < 32000) {
        const f = (1 - d2 / 32000) * 3.2;
        const d = Math.sqrt(d2) || 1;
        vx += (-dy / d) * f + (dx / d) * f * 0.35;
        vy += (dx / d) * f + (dy / d) * f * 0.35;
      }

      const life = p.life / p.max;
      const alpha = Math.sin(Math.PI * life) * 0.32;
      ctx.strokeStyle = `rgba(${p.color}, ${alpha.toFixed(3)})`;
      ctx.lineWidth = p.width;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(p.x, p.y);
      p.x += vx; p.y += vy;
      ctx.lineTo(p.x, p.y);
      ctx.stroke();

      if (++p.life > p.max || p.x > w + 40 || p.y < -40 || p.y > h + 40) spawn(p);
    }
    requestAnimationFrame(draw);
  }
  requestAnimationFrame(draw);
}

// ---------------------------------------------------------- download page

for (const button of document.querySelectorAll('[data-copy]')) {
  button.addEventListener('click', async () => {
    const text = document.getElementById(button.dataset.copy)?.textContent.trim();
    try {
      await navigator.clipboard.writeText(text);
      button.textContent = 'Copied';
    } catch {
      getSelection().selectAllChildren(document.getElementById(button.dataset.copy));
      button.textContent = 'Selected';
    }
    setTimeout(() => { button.textContent = 'Copy'; }, 2000);
  });
}

for (const link of document.querySelectorAll('[data-download]')) {
  link.addEventListener('click', () => {
    const status = document.querySelector('.download-started');
    if (status) status.hidden = false;
    document.querySelector('.install')?.scrollIntoView({ behavior: reduce.matches ? 'auto' : 'smooth', block: 'start' });
  });
}
