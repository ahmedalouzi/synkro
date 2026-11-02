import { isSafeExternalUrl, urlScheme } from '../../../apps/desktop/src/main/safe-external-url';

/** Only web and mail links reach shell.openExternal (window.open from any window, the preview iframe included). */
export default async function run() {
  console.log('  [external-links] https, http and mailto are opened...');
  for (const ok of ['https://atomvs.com/download', 'http://localhost:8081/', 'mailto:support@atomvs.com', 'HTTPS://EXAMPLE.COM']) {
    if (!isSafeExternalUrl(ok)) throw new Error(`Refused a safe link: ${ok}`);
  }

  console.log('  [external-links] files, OS protocol handlers and scripts are refused...');
  for (const bad of [
    'file:///C:/Windows/System32/calc.exe', 'file://server/share/x.exe', 'ms-msdt:/id PCWDiagnostic', 'search-ms:query=x',
    'javascript:alert(1)', 'data:text/html,<script>1</script>', 'vbscript:x', 'smb://host/share', 'ssh://root@host',
    'myapp://do-something', 'C:\\Windows\\notepad.exe', 'not a url', '', null, undefined, 42,
  ]) {
    if (isSafeExternalUrl(bad)) throw new Error(`Allowed an unsafe link: ${String(bad)}`);
  }

  console.log('  [external-links] Logs name the scheme only (a URL can carry a token)...');
  if (urlScheme('https://x.com/a?token=secret') !== 'https:' || urlScheme('nonsense') !== '(invalid url)') {
    throw new Error('urlScheme');
  }
  console.log('  v Safe external link tests passed.');
}
