import { useFollowStore } from '../../stores/follow-store';
import { startFollow } from './start-follow';
import './follow.css';

/** "Agent is editing classes.tsx · Follow": an agent edit not shown because the user was typing elsewhere. */
export function FollowChip() {
  const chip = useFollowStore((s) => s.chip);
  const dismiss = useFollowStore((s) => s.dismissChip);
  if (!chip) return null;
  return (
    <div className="follow-chip" role="status" data-testid="follow-chip">
      <span>Agent is editing <span className="follow-chip__name">{chip.name}</span></span>
      <button type="button" onClick={() => { dismiss(); startFollow(chip); }}>Follow</button>
      <button type="button" className="follow-chip__close" aria-label="Dismiss" onClick={dismiss}>×</button>
    </div>
  );
}
