import { forwardRef, useEffect, useImperativeHandle, useMemo, useState } from 'react';
import { useWorkspaceStore } from '../../stores/workspace-store';
import { useDiagnosticsStore } from '../../stores/preview-store';
import { useChatStore } from '../../stores/chat-store';
import {
  fileMention,
  gitDiffMention,
  problemsMention,
  selectionMention,
  terminalMention,
  type MentionItem,
  type MentionPickerHandle,
} from './MentionPicker';
import './MentionPicker.css';

/**
 * `/` commands: ready-made prompts that also attach the right context automatically
 * (e.g. /fix attaches @Problems, /review attaches @Git Diff).
 */
export interface SlashCommandResult {
  /** Prompt placed in the input (the user can edit it before sending). */
  prompt: string;
  attachments: MentionItem[];
}

interface SlashCommand {
  name: string;
  description: string;
  /** Returns null when the command acts immediately instead of filling the input. */
  build: () => SlashCommandResult | null;
  available?: () => boolean;
}

/** Selected code if any, otherwise the active file. */
function codeContext(): MentionItem[] {
  const { activeSelection, activeFilePath, project } = useWorkspaceStore.getState();
  if (activeSelection) return [selectionMention(activeSelection)];
  if (activeFilePath && !/^[a-z-]+:\/\//.test(activeFilePath) && !activeFilePath.startsWith('untitled-')) {
    return [fileMention(activeFilePath, project?.path)];
  }
  return [];
}

const hasCode = () => codeContext().length > 0;

const COMMANDS: SlashCommand[] = [
  {
    name: 'fix',
    description: 'Fix the errors and warnings in Problems',
    build: () => ({
      prompt: 'Fix the problems below. Explain the root cause of each briefly, then apply the fixes.',
      attachments: [problemsMention(useDiagnosticsStore.getState().items.length)],
    }),
  },
  {
    name: 'explain',
    description: 'Explain the selected code (or the current file)',
    available: hasCode,
    build: () => ({ prompt: 'Explain what this code does and how it works, step by step.', attachments: codeContext() }),
  },
  {
    name: 'review',
    description: 'Review uncommitted changes for bugs and risks',
    available: () => !!useWorkspaceStore.getState().project,
    build: () => ({
      prompt: 'Review my uncommitted changes. Point out bugs, security issues, missing edge cases and anything that will break — most important first. Do not edit files yet.',
      attachments: [gitDiffMention()],
    }),
  },
  {
    name: 'tests',
    description: 'Write tests for the selected code or current file',
    available: hasCode,
    build: () => ({ prompt: 'Write thorough unit tests for this code, covering edge cases, using the testing setup this project already uses.', attachments: codeContext() }),
  },
  {
    name: 'doc',
    description: 'Add documentation comments',
    available: hasCode,
    build: () => ({ prompt: 'Add clear documentation comments to this code in the idiomatic style for its language. Do not change behavior.', attachments: codeContext() }),
  },
  {
    name: 'refactor',
    description: 'Refactor for readability without changing behavior',
    available: hasCode,
    build: () => ({ prompt: 'Refactor this code to be cleaner and easier to read without changing its behavior. Explain the main changes.', attachments: codeContext() }),
  },
  {
    name: 'terminal',
    description: 'Explain and fix the error in the terminal',
    available: () => !!terminalMention(),
    build: () => ({
      prompt: 'Explain the error in this terminal output and fix it.',
      attachments: [terminalMention()].filter((m): m is MentionItem => !!m),
    }),
  },
  {
    name: 'new',
    description: 'Start a new chat',
    build: () => {
      void useChatStore.getState().newThread();
      return null;
    },
  },
];

interface SlashCommandPickerProps {
  query: string;
  onRun: (result: SlashCommandResult | null) => void;
  onClose: () => void;
}

export const SlashCommandPicker = forwardRef<MentionPickerHandle, SlashCommandPickerProps>(function SlashCommandPicker(
  { query, onRun, onClose },
  ref,
) {
  const [highlighted, setHighlighted] = useState(0);
  const items = useMemo(
    () => COMMANDS.filter((c) => (c.available?.() ?? true) && c.name.startsWith(query.toLowerCase())),
    [query],
  );
  useEffect(() => setHighlighted(0), [query]);

  const run = (cmd: SlashCommand) => onRun(cmd.build());

  useImperativeHandle(ref, () => ({
    handleKeyDown: (e) => {
      switch (e.key) {
        case 'ArrowDown':
          setHighlighted((h) => (items.length ? (h + 1) % items.length : 0));
          break;
        case 'ArrowUp':
          setHighlighted((h) => (items.length ? (h - 1 + items.length) % items.length : 0));
          break;
        case 'Enter':
        case 'Tab':
          if (!items[highlighted]) return false;
          run(items[highlighted]);
          break;
        case 'Escape':
          onClose();
          break;
        default:
          return false;
      }
      e.preventDefault();
      return true;
    },
  }), [items, highlighted, onClose]);

  if (items.length === 0) return null;

  return (
    <div className="mention-picker" role="listbox" onMouseDown={(e) => e.preventDefault()}>
      <div className="mention-section">Commands</div>
      {items.map((cmd, i) => (
        <div
          key={cmd.name}
          role="option"
          aria-selected={i === highlighted}
          className={`mention-item ${i === highlighted ? 'highlighted' : ''}`}
          onMouseMove={() => setHighlighted(i)}
          onClick={() => run(cmd)}
        >
          <span className="mention-label" style={{ color: 'var(--accent)', fontFamily: 'var(--font-code)' }}>/{cmd.name}</span>
          <span className="mention-detail" style={{ direction: 'ltr' }}>{cmd.description}</span>
        </div>
      ))}
    </div>
  );
});
