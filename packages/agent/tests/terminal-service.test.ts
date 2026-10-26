import { TerminalService } from '../../../apps/desktop/src/main/services/terminal-service';

export default async function run() {
  console.log('  Testing TerminalService safety guarantees...');

  const service = new TerminalService();

  // Regression guard: the user's terminal must never answer prompts on its own.
  // An earlier auto-responder typed "y" into any "(y/n)" prompt — including destructive
  // confirmations — so it was removed and must not come back.
  if (typeof (service as any).checkAndAutoRespond === 'function') {
    throw new Error('TerminalService must not auto-respond to interactive prompts in user terminals');
  }

  // Operations on unknown sessions are safe no-ops (e.g. a tab closed while output was in flight).
  service.write('missing-session', 'echo hi\r');
  service.resize('missing-session', 80, 24);
  service.destroy('missing-session');
  service.resize('missing-session', 0, 0);

  console.log('  Testing TerminalService successfully passed!');
}
