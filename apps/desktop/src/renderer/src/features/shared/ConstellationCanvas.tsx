import { useEffect, useRef } from 'react';

const POINTER_RADIUS = 170;

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  r: number;
  color: string;
}

interface ConstellationOptions {
  /**
   * 'always': nearby stars are always linked (login page).
   * 'pointer': stars only link up around the pointer, fading in and out (home page).
   */
  links?: 'always' | 'pointer';
  /** Star colors as "r, g, b". */
  colors?: string[];
  /** Pixels of area per star (smaller = denser). */
  areaPerStar?: number;
  maxStars?: number;
  /** Max distance between two linked stars. */
  linkDistance?: number;
  speed?: number;
  starAlpha?: number;
  className?: string;
}

const DEFAULT_COLORS = ['96, 165, 250', '167, 139, 250', '244, 114, 182'];

/** Drifting stars on a canvas that link up with lines and reach toward the pointer. */
export function ConstellationCanvas({
  links = 'always',
  colors = DEFAULT_COLORS,
  areaPerStar = 16000,
  maxStars = 120,
  linkDistance = 130,
  speed = 0.22,
  starAlpha = 0.85,
  className = 'lx-constellation',
}: ConstellationOptions) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;

    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const pointer = { x: -9999, y: -9999, inside: false };
    // 0..1, eases toward 1 while the pointer is over the canvas so lines fade instead of popping.
    let presence = links === 'always' ? 1 : 0;
    let particles: Particle[] = [];
    let width = 0;
    let height = 0;
    let frame = 0;

    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      width = canvas.clientWidth;
      height = canvas.clientHeight;
      if (!width || !height) return;
      canvas.width = width * dpr;
      canvas.height = height * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const count = Math.min(maxStars, Math.round((width * height) / areaPerStar));
      particles = Array.from({ length: count }, () => ({
        x: Math.random() * width,
        y: Math.random() * height,
        vx: (Math.random() - 0.5) * speed,
        vy: (Math.random() - 0.5) * speed,
        r: Math.random() * 1.3 + 0.4,
        color: colors[Math.floor(Math.random() * colors.length)],
      }));
    };

    const line = (ax: number, ay: number, bx: number, by: number, color: string, alpha: number, lineWidth: number) => {
      if (alpha <= 0.005) return;
      ctx.strokeStyle = `rgba(${color}, ${alpha})`;
      ctx.lineWidth = lineWidth;
      ctx.beginPath();
      ctx.moveTo(ax, ay);
      ctx.lineTo(bx, by);
      ctx.stroke();
    };

    const draw = () => {
      ctx.clearRect(0, 0, width, height);
      if (links === 'pointer') presence += ((pointer.inside ? 1 : 0) - presence) * 0.08;

      for (const p of particles) {
        if (!reducedMotion) {
          p.x += p.vx;
          p.y += p.vy;
          if (p.x < -10) p.x = width + 10;
          if (p.x > width + 10) p.x = -10;
          if (p.y < -10) p.y = height + 10;
          if (p.y > height + 10) p.y = -10;
        }
      }

      const reach = POINTER_RADIUS * 1.4;
      for (let i = 0; i < particles.length; i++) {
        const a = particles[i];
        const aToPointer = Math.hypot(a.x - pointer.x, a.y - pointer.y);

        for (let j = i + 1; j < particles.length; j++) {
          const b = particles[j];
          const dist = Math.hypot(a.x - b.x, a.y - b.y);
          if (dist >= linkDistance) continue;
          const strength = 1 - dist / linkDistance;
          if (links === 'always') {
            line(a.x, a.y, b.x, b.y, a.color, 0.14 * strength, 0.6);
          } else {
            // Only the part of the sky around the pointer lights up.
            const mid = Math.hypot((a.x + b.x) / 2 - pointer.x, (a.y + b.y) / 2 - pointer.y);
            if (mid < reach) line(a.x, a.y, b.x, b.y, a.color, 0.7 * strength * (1 - mid / reach) * presence, 0.8);
          }
        }

        if (aToPointer < POINTER_RADIUS) {
          line(a.x, a.y, pointer.x, pointer.y, a.color, (links === 'pointer' ? 0.6 : 0.4) * (1 - aToPointer / POINTER_RADIUS) * presence, 0.8);
        }
      }

      for (const p of particles) {
        const near = links === 'pointer' ? Math.max(0, 1 - Math.hypot(p.x - pointer.x, p.y - pointer.y) / reach) * presence : 0;
        ctx.fillStyle = `rgba(${p.color}, ${Math.min(1, starAlpha + near * 0.5)})`;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.r + near * 0.6, 0, Math.PI * 2);
        ctx.fill();
      }

      if (!reducedMotion) frame = requestAnimationFrame(draw);
    };

    const onPointerMove = (e: PointerEvent) => {
      const rect = canvas.getBoundingClientRect();
      pointer.x = e.clientX - rect.left;
      pointer.y = e.clientY - rect.top;
      pointer.inside = pointer.x >= 0 && pointer.y >= 0 && pointer.x <= rect.width && pointer.y <= rect.height;
      if (reducedMotion) draw();
    };
    const onPointerLeave = () => {
      pointer.inside = false;
      if (links === 'always') pointer.x = pointer.y = -9999;
    };

    // The canvas can change size without a window resize (side bar, panels).
    const observer = new ResizeObserver(resize);
    observer.observe(canvas);
    resize();
    draw();
    window.addEventListener('pointermove', onPointerMove);
    document.addEventListener('pointerleave', onPointerLeave);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener('pointermove', onPointerMove);
      document.removeEventListener('pointerleave', onPointerLeave);
    };
    // Options are read once per mount.
  }, []);

  return <canvas ref={canvasRef} className={className} aria-hidden="true" />;
}
