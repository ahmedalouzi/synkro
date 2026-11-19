import { useEffect, useRef } from 'react';
import type { ApprovalRequest } from '@peep/shared';
import { useI18n } from '../../i18n';
import { useApprovalStore } from '../../stores/approval-store';
import './ApprovalCard.css';

/**
 * The agent asks before it runs a command that is not on the safe list, or deletes a file. Allow once (Enter),
 * Always allow in this project (only where main offers it: never for deleting, stopping processes, destructive or
 * system-wide commands, shells), Reject (Esc). It waits until the user answers; a new message or Stop ends it.
 */
export function ApprovalCard({ request }: { request: ApprovalRequest }) {
  const { t } = useI18n();
  const respond = useApprovalStore((s) => s.respond);
  const cardRef = useRef<HTMLDivElement>(null);

  // Take the keyboard only when the user is not typing somewhere (Enter in the composer still sends a message).
  useEffect(() => {
    const active = document.activeElement as HTMLElement | null;
    const typing = !!active && (active.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(active.tagName));
    if (!typing) cardRef.current?.focus();
  }, [request.id]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.target !== e.currentTarget && (e.target as HTMLElement).tagName === 'BUTTON' && e.key === 'Enter') return; // the button's own click
    if (e.key === 'Enter') {
      e.preventDefault();
      void respond(request.id, 'allow-once');
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      void respond(request.id, 'reject');
    }
  };

  const isDelete = request.kind === 'delete-file';
  return (
    <div
      ref={cardRef}
      id={`approval-${request.id}`}
      className="cx-approval"
      role="alertdialog"
      aria-labelledby={`approval-title-${request.id}`}
      aria-describedby={`approval-reason-${request.id}`}
      tabIndex={-1}
      onKeyDown={onKeyDown}
    >
      <div id={`approval-title-${request.id}`} className="cx-approval__title">
        {isDelete ? t('approval.deleteTitle') : t('approval.commandTitle')}
      </div>
      <code className="cx-approval__subject" dir="ltr">{request.subject}</code>
      <p id={`approval-reason-${request.id}`} className="cx-approval__reason">
        {isDelete
          ? (request.reason ? t('approval.deleteReason', { reason: request.reason }) : t('approval.deleteNoReason'))
          : request.reason}
      </p>
      {isDelete && (
        <p className="cx-approval__note">{request.reversible ? t('approval.deleteReversible') : t('approval.deleteNotReversible')}</p>
      )}
      <div className="cx-approval__actions">
        <button type="button" className="cx-approval__btn cx-approval__btn--primary" onClick={() => void respond(request.id, 'allow-once')}>
          {isDelete ? t('approval.allowDelete') : t('approval.allowOnce')} <kbd>Enter</kbd>
        </button>
        {request.alwaysAllowKey && (
          <button type="button" className="cx-approval__btn" onClick={() => void respond(request.id, 'always')}
            title={t('approval.alwaysHint', { key: request.alwaysAllowKey })}>
            {t('approval.always', { key: request.alwaysAllowKey })}
          </button>
        )}
        <button type="button" className="cx-approval__btn cx-approval__btn--reject" onClick={() => void respond(request.id, 'reject')}>
          {t('approval.reject')} <kbd>Esc</kbd>
        </button>
      </div>
    </div>
  );
}
