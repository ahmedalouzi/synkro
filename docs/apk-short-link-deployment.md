# APK Short-Link Download Deployment Notes

Phone QR scans hit `GET /d/:code` directly over HTTPS without a desktop session.

## Environment Variables

- `PUBLIC_BASE_URL` (required in production): External origin used when minting short links in `POST /api/build/:jobId/short-link`, e.g. `https://api.synkro.dev`. Never include a trailing slash. In development (`NODE_ENV !== 'production'`), it falls back to `http://localhost:${PORT || 8080}`.

## Reverse Proxy & TLS Requirements

1. **HTTPS Required:** Phones scanning QR codes must reach `PUBLIC_BASE_URL` over valid TLS (`https://`). Mixed content or self-signed certificates will block automatic APK downloads in mobile browsers.
2. **Disable Response Buffering:** Large APKs are streamed via Node `fs.createReadStream` with `Content-Length`. Configure Nginx/Caddy/ALB to disable proxy buffering (`proxy_buffering off;` in Nginx) so downloads start immediately on scan.
3. **Stream Timeouts:** Increase proxy read/send timeouts (e.g. `proxy_read_timeout 300s;`, `proxy_send_timeout 300s;`) so slow mobile connections do not drop mid-download.
4. **Preserve Response Headers:** Ensure the proxy preserves `Content-Type: application/vnd.android.package-archive`, `Content-Disposition: attachment; filename="app-release.apk"`, `Content-Length`, `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`, and `Referrer-Policy: no-referrer`.
5. **Client IP Forwarding:** Set `X-Forwarded-For` and configure Express `trust proxy` if deployed behind a load balancer so per-IP rate limiting on `/d/:code` applies per client rather than per proxy.

