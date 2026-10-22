/**
 * Atom visualizer — FLARE edition.
 * Inspired by an amber atom video: narrow elliptical orbits in the classic
 * atom-symbol layout, thin glowing orbit lines, crescent-shaped light flares
 * hugging the rings instead of round electrons, a small ragged white-hot
 * fireball nucleus, a warm halo, and a full-frame bloom flash on loud peaks.
 *
 * Usage:
 *   import { createAtomVisualizer } from './atomVisualizer.js';
 *   const viz = createAtomVisualizer(canvas, { primary, secondary, background: '#000' });
 *   viz.setState('idle' | 'thinking' | 'speaking'); viz.setColors(p, s);
 *   viz.setLevel(0..1 | null); viz.destroy();
 *
 * primary   → nucleus, halo, bloom flash    (default deep orange)
 * secondary → orbit lines and flares        (default amber)
 * Needs a dark backdrop: pass `background` or place the canvas on black.
 */
export function createAtomVisualizer(canvas, opts = {}) {
  const ctx = canvas.getContext('2d');
  let primary = opts.primary || '#FF6A00';
  let secondary = opts.secondary || '#FFA23A';
  let state = opts.state || 'idle';
  const background = opts.background ?? null;

  let s = (opts.seed ?? 7) >>> 0;
  const rand = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);

  let W = 0, H = 0, cx = 0, cy = 0, S = 1;
  let speed = 1, t = 0, prec = 0, pulse = 0, gx = 0, gy = 0, tumble = 0.12;
  let level = null, raf = 0, alive = true;
  const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

  // Classic atom symbol: three narrow ellipses 60° apart; 2 + 2 + 1 flares.
  const orbits = [
    { tilt: 1.3, rot: Math.PI / 2, n: 1 },
    { tilt: 1.3, rot: Math.PI / 2 + Math.PI / 3, n: 2 },
    { tilt: 1.3, rot: Math.PI / 2 - Math.PI / 3, n: 2 },
  ];
  const BASE_R = 112, D = 480;

  // Fireball nucleus data
  const LAYERS = 7;
  const layerNoise = Array.from({ length: LAYERS }, () =>
    Array.from({ length: 4 }, (_, k) => ({ f: 2 + k * 2 + Math.floor(rand() * 3), sp: (rand() - 0.5) * (2 + k), ph: rand() * 7 })));
  const flames = [], embers = [];

  function resize() {
    const dpr = window.devicePixelRatio || 1, rect = canvas.getBoundingClientRect();
    W = rect.width || 340; H = rect.height || 320;
    canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    cx = W / 2; cy = H / 2; S = Math.min(W / 340, H / 320);
  }
  const ro = new ResizeObserver(resize); ro.observe(canvas); resize();

  function rotG(x, y, z) {
    const y3 = y * Math.cos(gx) - z * Math.sin(gx), z3 = y * Math.sin(gx) + z * Math.cos(gx);
    return [x * Math.cos(gy) + z3 * Math.sin(gy), y3, -x * Math.sin(gy) + z3 * Math.cos(gy)];
  }
  // Point on orbit o at angle a and radius R (radius lets flares have width in the orbit plane)
  function pt(o, a, R = BASE_R) {
    const x = R * Math.cos(a), y = R * Math.sin(a);
    const y1 = y * Math.cos(o.tilt), z1 = y * Math.sin(o.tilt), r = o.rot + prec;
    const [X, Y, Z] = rotG(x * Math.cos(r) - y1 * Math.sin(r), x * Math.sin(r) + y1 * Math.cos(r), z1);
    const f = D / (D + Z);
    return { x: cx + X * f * S, y: cy + Y * f * S, z: Z, f };
  }
  const rgb = h => { const n = parseInt(h.slice(1), 16); return [n >> 16, (n >> 8) & 255, n & 255]; };
  const hexA = (h, a) => { const [r, g, b] = rgb(h); return `rgba(${r},${g},${b},${Math.max(0, a)})`; };
  const mixA = (h, k, toWhite, a) => {
    const [r, g, b] = rgb(h), m = toWhite ? 255 : 0;
    return `rgba(${Math.round(r + (m - r) * k)},${Math.round(g + (m - g) * k)},${Math.round(b + (m - b) * k)},${Math.max(0, a)})`;
  };

  // ---------- nucleus ----------
  function fireball(nr) {
    const pc = primary, P = 64, wob = 1 + pulse * 1.2;
    ctx.globalCompositeOperation = 'lighter';
    const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, nr * 3.2 * S);
    g.addColorStop(0, hexA(pc, 0.45 + pulse * 0.3)); g.addColorStop(1, hexA(pc, 0));
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(cx, cy, nr * 3.2 * S, 0, 7); ctx.fill();
    ctx.shadowColor = hexA(pc, 1); ctx.shadowBlur = 10 * S;
    flames.forEach(fl => {
      ctx.beginPath(); ctx.arc(cx + fl.x * S, cy + fl.y * S, fl.sz * fl.life * S, 0, 7);
      ctx.fillStyle = mixA(pc, 0.3 + 0.5 * fl.life, true, 0.22 * fl.life); ctx.fill();
    });
    for (let l = 0; l < LAYERS; l++) {
      const u = l / (LAYERS - 1), baseR = nr * (1.35 - u * 0.9), amp = (0.28 - u * 0.2) * wob;
      ctx.beginPath();
      for (let i = 0; i <= P; i++) {
        const a = (i / P) * Math.PI * 2;
        let n = 0; layerNoise[l].forEach((w, k) => { n += Math.sin(a * w.f + t * w.sp * 3.5 + w.ph) / (k + 1); });
        const r = baseR * (1 + amp * n * 0.6), x = cx + Math.cos(a) * r * S, y = cy + Math.sin(a) * r * S;
        i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
      }
      ctx.closePath();
      ctx.fillStyle = mixA(pc, Math.min(1, 0.15 + u * 0.9), true, 0.2 + u * 0.3); ctx.fill();
    }
    ctx.shadowColor = 'rgba(255,240,210,1)'; ctx.shadowBlur = 16 * S;
    ctx.beginPath(); ctx.arc(cx, cy, nr * (0.45 + pulse * 0.15) * S, 0, 7);
    ctx.fillStyle = `rgba(255,250,235,${0.75 + pulse * 0.25})`; ctx.fill();
    ctx.shadowBlur = 0;
    ctx.globalCompositeOperation = 'source-over';
  }
  function updateParticles(nr, m) {
    const n = m === 1 ? (state === 'speaking' ? 3 : state === 'thinking' ? 2 : 1) : 0;
    for (let i = 0; i < n; i++) {
      const a = rand() * 7, v = 0.2 + rand() * 0.45 + pulse * 0.5;
      flames.push({ x: Math.cos(a) * nr * 0.8, y: Math.sin(a) * nr * 0.8, vx: Math.cos(a) * v, vy: Math.sin(a) * v,
        life: 1, decay: 0.03 + rand() * 0.03, sz: nr * (0.2 + rand() * 0.2) });
    }
    for (let i = flames.length - 1; i >= 0; i--) {
      const f = flames[i]; f.x += f.vx; f.y += f.vy; f.vy -= 0.01; f.life -= f.decay * Math.max(m, 0.25);
      if (f.life <= 0) flames.splice(i, 1);
    }
    for (let i = embers.length - 1; i >= 0; i--) {
      const p = embers[i]; p.x += p.vx; p.y += p.vy; p.vx *= 0.95; p.vy *= 0.95; p.life -= p.decay * Math.max(m, 0.25);
      if (p.life <= 0) embers.splice(i, 1);
    }
  }

  // ---------- frame ----------
  function frame() {
    if (!alive) return;
    const m = reduceMotion ? 0.25 : 1;
    const ts = state === 'idle' ? 1 : state === 'thinking' ? 2.6 : 1.5;
    const tt = state === 'idle' ? 0.12 : state === 'thinking' ? 0.45 : 0.8;
    speed += (ts - speed) * 0.05; tumble += (tt - tumble) * 0.03;
    t += 0.011 * speed * m;
    gx = Math.sin(t * 0.35 * (0.5 + tumble)) * 0.55 * (0.4 + tumble);   // gentle rock front/back
    gy += 0.006 * tumble * m;                                            // slow turn
    prec += (state === 'thinking' ? 0.006 : 0.0015) * m;
    if (level !== null) pulse += (Math.max(0, Math.min(1, level)) - pulse) * 0.3;
    else pulse = state === 'speaking' ? Math.pow(Math.sin(t * 8) * 0.5 + 0.5, 1.5) * (0.55 + 0.45 * Math.sin(t * 2.1)) : pulse * 0.9;

    const pc = primary, sc = secondary;
    ctx.globalCompositeOperation = 'source-over';
    if (background) { ctx.fillStyle = background; ctx.fillRect(0, 0, W, H); } else ctx.clearRect(0, 0, W, H);

    // Warm ambient halo + bloom flash on loud peaks
    ctx.globalCompositeOperation = 'lighter';
    const halo = ctx.createRadialGradient(cx, cy, 0, cx, cy, Math.min(W, H) * 0.5);
    const flash = Math.pow(Math.max(0, pulse - 0.55) / 0.45, 2);
    halo.addColorStop(0, hexA(pc, 0.16 + flash * 0.55));
    halo.addColorStop(0.6, hexA(pc, 0.06 + flash * 0.3));
    halo.addColorStop(1, hexA(pc, 0));
    ctx.fillStyle = halo; ctx.fillRect(0, 0, W, H);

    // Orbit lines (thin, glowing) — collected so we can split front/back of nucleus
    const rings = [];
    orbits.forEach(o => {
      let run = null;
      for (let k = 0; k <= 120; k++) {
        const q = pt(o, (k / 120) * Math.PI * 2), back = q.z > 0;
        if (!run || run.back !== back) { if (run) { run.pts.push(q); rings.push(run); } run = { back, pts: run ? [run.pts[run.pts.length - 1]] : [], zs: 0 }; }
        run.pts.push(q); run.zs += q.z;
      }
      rings.push(run);
    });
    rings.forEach(r => { r.z = r.zs / r.pts.length; });

    // Flares: crescents hugging each orbit, pointed at both ends, widest just behind the head
    const flares = [], FL = 1.0 + 0.25 * speed, N = 26;
    orbits.forEach((o, i) => {
      for (let e = 0; e < o.n; e++) {
        const a = t * (1.1 + i * 0.18) + i * 2.1 + e * Math.PI;
        const outer = [], inner = [];
        for (let k = 0; k <= N; k++) {
          const u = k / N, aa = a - u * FL;
          const w = (u < 0.18 ? Math.sqrt(u / 0.18) : Math.pow(1 - (u - 0.18) / 0.82, 1.4)) * (0.085 + pulse * 0.03);
          outer.push(pt(o, aa, BASE_R * (1 + w * 0.25)));
          inner.push(pt(o, aa, BASE_R * (1 - w)));
        }
        const head = outer[0];
        flares.push({ outer, inner, head, z: head.z });
        if (m === 1 && rand() < (state === 'speaking' ? 0.6 : 0.3)) {
          const ang = rand() * 7, v = (0.2 + rand() * 0.6) * S;
          embers.push({ x: head.x, y: head.y, vx: Math.cos(ang) * v, vy: Math.sin(ang) * v, life: 1,
            decay: 0.04 + rand() * 0.04, z: head.z, sz: 0.6 + rand() * 1.0 });
        }
      }
    });

    const depth = z => 1 - (z + BASE_R) / (2 * BASE_R);   // 1 = near, 0 = far
    const drawRing = sg => {
      const dp = depth(sg.z);
      ctx.beginPath(); sg.pts.forEach((p, k) => k ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y));
      ctx.strokeStyle = hexA(sc, 0.06 + 0.06 * dp); ctx.lineWidth = 3.5 * S; ctx.stroke();       // soft glow
      ctx.strokeStyle = mixA(sc, 0.25, true, 0.35 + 0.35 * dp); ctx.lineWidth = 0.7 * S; ctx.stroke(); // hairline
    };
    const flarePath = (fl, shrink) => {
      ctx.beginPath();
      fl.outer.forEach((p, k) => {
        const q = shrink ? { x: p.x + (fl.inner[k].x - p.x) * shrink, y: p.y + (fl.inner[k].y - p.y) * shrink } : p;
        k ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y);
      });
      for (let k = fl.inner.length - 1; k >= 0; k--) {
        const p = fl.inner[k];
        const q = shrink ? { x: p.x + (fl.outer[k].x - p.x) * shrink, y: p.y + (fl.outer[k].y - p.y) * shrink } : p;
        ctx.lineTo(q.x, q.y);
      }
      ctx.closePath();
    };
    const drawFlare = fl => {
      const dp = depth(fl.z), boost = 1 + pulse * 0.4;
      ctx.save();
      ctx.lineJoin = 'round';
      flarePath(fl, 0);                                         // amber body with soft glow
      ctx.shadowColor = hexA(sc, 0.9); ctx.shadowBlur = 14 * S * boost;
      ctx.fillStyle = hexA(sc, (0.55 + 0.35 * dp) * boost); ctx.fill();
      ctx.shadowBlur = 0;
      flarePath(fl, 0.35);                                      // white-hot core
      ctx.fillStyle = `rgba(255,248,230,${0.55 + 0.4 * dp})`; ctx.fill();
      ctx.restore();
    };
    const drawEmber = p => {
      ctx.beginPath(); ctx.arc(p.x, p.y, p.sz * p.life * S, 0, 7);
      ctx.fillStyle = mixA(sc, 0.5 * p.life, true, p.life * 0.85); ctx.fill();
    };

    const nr = 17 + pulse * 7;
    updateParticles(nr, m);
    const byDepth = (a, b) => b.z - a.z;
    ctx.lineCap = 'round';
    ctx.globalCompositeOperation = 'lighter';
    rings.filter(x => x.back).forEach(drawRing);
    embers.filter(p => p.z > 0).forEach(drawEmber);
    flares.filter(f => f.z > 0).sort(byDepth).forEach(drawFlare);
    fireball(nr);
    ctx.globalCompositeOperation = 'lighter';
    rings.filter(x => !x.back).forEach(drawRing);
    embers.filter(p => p.z <= 0).forEach(drawEmber);
    flares.filter(f => f.z <= 0).sort(byDepth).forEach(drawFlare);
    ctx.globalCompositeOperation = 'source-over';

    raf = requestAnimationFrame(frame);
  }
  frame();

  return {
    setState(next) { state = next; },
    setColors(p, s2) { if (p) primary = p; if (s2) secondary = s2; },
    setLevel(v) { level = v; },
    destroy() { alive = false; cancelAnimationFrame(raf); ro.disconnect(); },
  };
}
