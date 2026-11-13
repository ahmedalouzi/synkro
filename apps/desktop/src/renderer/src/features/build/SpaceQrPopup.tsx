import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import QRCode from 'qrcode';
import { buildApi } from '../../services/build-api';
import { useI18n } from '../../i18n';

export const SPACE_QR_OPTIONS = {
  width: 320,
  margin: 4,
  errorCorrectionLevel: 'M' as const,
  color: {
    dark: '#000000',
    light: '#ffffff',
  },
};

const TOTAL_TTL_SECONDS = 15 * 60;
const RING_RADIUS = 172;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

export function formatSpaceCountdown(seconds: number): string {
  const clamped = Math.max(0, Math.floor(seconds));
  const mins = Math.floor(clamped / 60);
  const secs = clamped % 60;
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

interface Star {
  x: number;
  y: number;
  layer: number; // 0.35, 0.65, 1.0
  size: number;
  phase: number;
  speed: number;
}

function createStars(count: number, width: number, height: number): Star[] {
  const layers = [0.35, 0.65, 1.0];
  const stars: Star[] = [];
  for (let i = 0; i < count; i += 1) {
    const layer = layers[i % layers.length];
    stars.push({
      x: Math.random() * width,
      y: Math.random() * height,
      layer,
      size: layer === 1.0 ? 2 : layer === 0.65 ? 1.4 : 1,
      phase: Math.random() * Math.PI * 2,
      speed: 0.6 + Math.random() * 1.4,
    });
  }
  return stars;
}

export interface SpaceQrPopupProps {
  jobId: string;
  initialShortUrl?: string;
  initialExpiresAt?: number;
  onClose: () => void;
  onShortLinkUpdated?: (url: string, expiresAt: number) => void;
  createShortLinkFn?: (id: string) => Promise<{ url: string; expiresAt: number }>;
  generateQrDataUrl?: (text: string, opts: typeof SPACE_QR_OPTIONS) => Promise<string>;
}

export function SpaceQrPopup({
  jobId,
  initialShortUrl,
  initialExpiresAt,
  onClose,
  onShortLinkUpdated,
  createShortLinkFn,
  generateQrDataUrl,
}: SpaceQrPopupProps) {
  const { t } = useI18n();
  const closeBtnRef = useRef<HTMLButtonElement>(null);
  const popupRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const exitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isExitingRef = useRef<boolean>(false);

  const [shortUrl, setShortUrl] = useState<string>(initialShortUrl || '');
  const [expiresAt, setExpiresAt] = useState<number>(
    initialExpiresAt || Date.now() + TOTAL_TTL_SECONDS * 1000
  );
  const [qrDataUrl, setQrDataUrl] = useState<string>('');
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<boolean>(false);
  const [now, setNow] = useState<number>(() => Date.now());
  const [animRunId, setAnimRunId] = useState<number>(1);
  const [isReplay, setIsReplay] = useState<boolean>(false);
  const [isRefreshing, setIsRefreshing] = useState<boolean>(false);
  const [isExiting, setIsExiting] = useState<boolean>(false);

  const onShortLinkUpdatedRef = useRef(onShortLinkUpdated);
  onShortLinkUpdatedRef.current = onShortLinkUpdated;
  const createShortLinkFnRef = useRef(createShortLinkFn);
  createShortLinkFnRef.current = createShortLinkFn;

  const triggerClose = useCallback(() => {
    if (isExitingRef.current) return;
    isExitingRef.current = true;
    const reduced =
      typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduced) {
      onClose();
      return;
    }
    setIsExiting(true);
    exitTimerRef.current = setTimeout(() => {
      onClose();
    }, 300);
  }, [onClose]);

  const mintShortLink = useCallback(
    async (isRefresh = false) => {
      if (isRefresh) {
        setIsRefreshing(true);
      } else {
        setLoading(true);
      }
      setError(false);

      try {
        const mint =
          createShortLinkFnRef.current ??
          (buildApi.createShortLink
            ? (id: string) => buildApi.createShortLink!(id)
            : async (id: string) => {
                const job = await buildApi.getBuild(id);
                return {
                  url: job.shortUrl || '',
                  expiresAt: job.shortExpiresAt || Date.now() + TOTAL_TTL_SECONDS * 1000,
                };
              });
        const res = await mint(jobId);
        if (!res.url) throw new Error('Missing short URL');
        setShortUrl(res.url);
        setExpiresAt(res.expiresAt);
        setNow(Date.now());
        if (isRefresh) setIsReplay(true);
        setAnimRunId((prev) => prev + 1);
        onShortLinkUpdatedRef.current?.(res.url, res.expiresAt);
      } catch {
        setError(true);
      } finally {
        setLoading(false);
        setIsRefreshing(false);
      }
    },
    [jobId]
  );

  // Mint short link on mount or when jobId changes
  useEffect(() => {
    void mintShortLink(false);
  }, [mintShortLink]);

  // Generate QR image whenever shortUrl updates
  useEffect(() => {
    if (!shortUrl) {
      setQrDataUrl('');
      return;
    }
    let active = true;
    const gen = generateQrDataUrl ?? ((text, opts) => QRCode.toDataURL(text, opts));
    gen(shortUrl, SPACE_QR_OPTIONS)
      .then((dataUrl) => {
        if (active) setQrDataUrl(dataUrl);
      })
      .catch(() => {
        if (active) setError(true);
      });
    return () => {
      active = false;
    };
  }, [shortUrl, generateQrDataUrl]);

  // Countdown tick
  useEffect(() => {
    const interval = setInterval(() => {
      setNow(Date.now());
    }, 1000);
    return () => clearInterval(interval);
  }, []);

  // Lock body scroll while open
  useEffect(() => {
    if (typeof document === 'undefined') return;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prevOverflow;
    };
  }, []);

  // Focus management, focus trap & Escape key
  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    closeBtnRef.current?.focus();

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        triggerClose();
        return;
      }
      if (e.key === 'Tab' && popupRef.current) {
        const focusable = popupRef.current.querySelectorAll<HTMLElement>(
          'button:not([disabled]), [tabindex]:not([tabindex="-1"])'
        );
        if (focusable.length > 0) {
          const first = focusable[0];
          const last = focusable[focusable.length - 1];
          if (e.shiftKey && document.activeElement === first) {
            e.preventDefault();
            last.focus();
          } else if (!e.shiftKey && document.activeElement === last) {
            e.preventDefault();
            first.focus();
          }
        }
      }
    };
    window.addEventListener('keydown', onKeyDown);

    return () => {
      window.removeEventListener('keydown', onKeyDown);
      if (exitTimerRef.current) clearTimeout(exitTimerRef.current);
      if (previouslyFocused && typeof previouslyFocused.focus === 'function') {
        previouslyFocused.focus();
      }
    };
  }, [triggerClose]);

  // 3-layer parallax starfield + hyperspace warp canvas
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let ctx: CanvasRenderingContext2D | null = null;
    try {
      ctx = canvas.getContext('2d');
    } catch {
      ctx = null;
    }
    if (!ctx) return;

    const reducedMotion =
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    let width = (canvas.width = window.innerWidth || 1280);
    let height = (canvas.height = window.innerHeight || 720);
    const stars = createStars(140, width, height);
    const startTime = performance.now();
    let rafId = 0;

    const drawStatic = () => {
      if (!ctx) return;
      ctx.clearRect(0, 0, width, height);
      for (const s of stars) {
        ctx.fillStyle = `rgba(226, 232, 240, ${0.35 + s.layer * 0.45})`;
        ctx.fillRect(s.x, s.y, s.size, s.size);
      }
    };

    if (reducedMotion) {
      drawStatic();
      return;
    }

    const renderFrame = (time: number) => {
      if (!ctx) return;
      if (document.visibilityState === 'hidden') {
        rafId = requestAnimationFrame(renderFrame);
        return;
      }

      const elapsedMs = time - startTime;
      const warpProgress = Math.min(1, elapsedMs / 1100);
      const warpStrength = Math.pow(1 - warpProgress, 2.4);
      const cx = width / 2;
      const cy = height / 2;

      ctx.clearRect(0, 0, width, height);

      for (const s of stars) {
        // Gentle parallax drift
        s.x += s.layer * 0.06;
        if (s.x > width) s.x -= width;

        const twinkle = 0.45 + 0.55 * Math.sin(elapsedMs * 0.002 * s.speed + s.phase);
        const alpha = Math.min(1, (0.28 + s.layer * 0.52) * twinkle);

        if (warpStrength > 0.02) {
          const dx = s.x - cx;
          const dy = s.y - cy;
          const streak = warpStrength * s.layer * 0.35;
          ctx.strokeStyle = `rgba(165, 243, 252, ${alpha})`;
          ctx.lineWidth = s.size;
          ctx.beginPath();
          ctx.moveTo(s.x, s.y);
          ctx.lineTo(s.x + dx * streak, s.y + dy * streak);
          ctx.stroke();
        } else {
          ctx.fillStyle = `rgba(226, 232, 240, ${alpha})`;
          ctx.fillRect(s.x, s.y, s.size, s.size);
        }
      }

      rafId = requestAnimationFrame(renderFrame);
    };

    const onResize = () => {
      width = canvas.width = window.innerWidth || 1280;
      height = canvas.height = window.innerHeight || 720;
    };
    window.addEventListener('resize', onResize);
    rafId = requestAnimationFrame(renderFrame);

    return () => {
      cancelAnimationFrame(rafId);
      window.removeEventListener('resize', onResize);
    };
  }, []);

  const remainingSec = Math.max(0, Math.floor((expiresAt - now) / 1000));
  const isExpired = !loading && !error && remainingSec <= 0;
  const isWarning = !isExpired && remainingSec <= 60;
  const progressRatio = Math.max(0, Math.min(1, remainingSec / TOTAL_TTL_SECONDS));
  const strokeDashoffset = RING_CIRCUMFERENCE * (1 - progressRatio);

  const overlay = (
    <div
      ref={popupRef}
      id="space-qr-popup"
      className={`space-qr-overlay${isExiting ? ' is-exiting' : ''}`}
      role="dialog"
      aria-modal="true"
      aria-labelledby="space-qr-title"
    >
      <canvas ref={canvasRef} className="space-qr-starfield" aria-hidden="true" />
      <div className="space-qr-nebula space-qr-nebula--purple" aria-hidden="true" />
      <div className="space-qr-nebula space-qr-nebula--blue" aria-hidden="true" />
      <div className="space-qr-nebula space-qr-nebula--teal" aria-hidden="true" />
      <div className="space-qr-planet" aria-hidden="true" />
      <div className="space-qr-shooting-star" aria-hidden="true" />
      <div className="space-qr-shooting-star space-qr-shooting-star--delayed" aria-hidden="true" />
      <div className="space-qr-shockwave" aria-hidden="true" />

      <button
        ref={closeBtnRef}
        id="space-qr-close-btn"
        type="button"
        className="space-qr-close-btn"
        onClick={triggerClose}
        aria-label={t('build.fullPageClose')}
      >
        <span aria-hidden="true">×</span>
        <span>{t('build.fullPageClose')}</span>
      </button>

      <div key={animRunId} className={`space-qr-card-wrap${isReplay ? ' is-replay' : ''}`}>
        <h2 id="space-qr-title" className="space-qr-title">
          {t('build.fullPageTitle')}
        </h2>

        {loading ? (
          <div id="space-qr-loading" className="space-qr-state-box" role="status">
            <span>{t('build.fullPageLoading')}</span>
          </div>
        ) : error ? (
          <div id="space-qr-error" className="space-qr-state-box" role="alert">
            <p className="space-qr-error-text">{t('build.fullPageError')}</p>
            <button
              id="space-qr-retry-btn"
              type="button"
              className="space-qr-action-btn"
              onClick={() => void mintShortLink(false)}
            >
              {t('build.fullPageRetry')}
            </button>
          </div>
        ) : (
          <>
            <div className="space-qr-stage">
              <div className="space-qr-glow" aria-hidden="true" />
              <div className="space-qr-orbit-ring" aria-hidden="true" />
              <svg
                className="space-qr-countdown-svg"
                viewBox="0 0 360 360"
                aria-hidden="true"
              >
                <circle className="space-qr-ring-track" cx="180" cy="180" r={RING_RADIUS} />
                <circle
                  className={`space-qr-ring-progress${
                    isExpired ? ' is-expired' : isWarning ? ' is-warning' : ''
                  }`}
                  cx="180"
                  cy="180"
                  r={RING_RADIUS}
                  strokeDasharray={RING_CIRCUMFERENCE}
                  strokeDashoffset={strokeDashoffset}
                />
              </svg>

              <div className="space-qr-frame" dir="ltr">
                {qrDataUrl && (
                  <img
                    id="space-qr-img"
                    className={`space-qr-img${isExpired ? ' is-expired' : ''}`}
                    width={SPACE_QR_OPTIONS.width}
                    height={SPACE_QR_OPTIONS.width}
                    src={qrDataUrl}
                    alt={t('build.qrAriaLabel')}
                    aria-label={t('build.qrAriaLabel')}
                  />
                )}
                {!isExpired && <div className="space-qr-scan-line" aria-hidden="true" />}

                {isExpired && (
                  <div id="space-qr-expired-overlay" className="space-qr-expired-overlay">
                    <span className="space-qr-expired-text">{t('build.fullPageExpired')}</span>
                    <button
                      id="space-qr-expired-refresh-btn"
                      type="button"
                      className="space-qr-action-btn"
                      onClick={() => void mintShortLink(true)}
                      disabled={isRefreshing}
                    >
                      {isRefreshing ? t('build.refreshing') : t('build.fullPageRefresh')}
                    </button>
                  </div>
                )}
              </div>
            </div>

            <div
              id="space-qr-expiry-label"
              aria-live="polite"
              className={`space-qr-expiry-label${
                isExpired ? ' is-expired' : isWarning ? ' is-warning' : ''
              }`}
            >
              {isExpired
                ? t('build.fullPageExpired')
                : t('build.fullPageExpiresIn', { time: formatSpaceCountdown(remainingSec) })}
            </div>

            <p className="space-qr-subtitle">{t('build.fullPageSubtitle')}</p>
          </>
        )}
      </div>
    </div>
  );

  if (typeof document !== 'undefined' && document.body) {
    return createPortal(overlay, document.body);
  }

  return overlay;
}
