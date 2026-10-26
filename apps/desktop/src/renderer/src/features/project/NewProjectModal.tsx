import { useEffect, useState, type ReactNode } from 'react';
import type { ProjectInfo, ProjectTemplateInfo } from '@peep/shared';
import { useWorkspace } from '../../hooks/useWorkspace';
import './NewProjectModal.css';

type Mode = 'template' | 'prompt';
type Platform = 'flutter' | 'react-native';
type EnvMode = 'beginner' | 'advanced';

interface NewProjectModalProps {
  open: boolean;
  onClose: () => void;
  onCreated: (project: ProjectInfo) => void;
}

function slugify(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/_+/g, '_');
}

/** The official Flutter mark. */
function FlutterLogo({ size = 34 }: { size?: number }) {
  return (
    <svg width={size} height={size * (317 / 256)} viewBox="0 0 256 317" aria-label="Flutter">
      <path fill="#47C5FB" d="M157.666.001L.001 157.666l48.8 48.8L255.268.001z" />
      <path fill="#47C5FB" d="M156.567 145.397L72.15 229.815l48.982 49.716 48.708-48.708 85.428-85.427z" />
      <path fill="#00569E" d="M121.133 279.531l37.082 37.082h97.052l-85.428-85.428z" />
      <path fill="#00B5F8" d="M71.6 230.364l48.8-48.8 49.441 49.258-48.708 48.709z" />
    </svg>
  );
}

/** The official React mark. */
function ReactLogo({ size = 40 }: { size?: number }) {
  return (
    <svg width={size} height={size * (20.46 / 23)} viewBox="-11.5 -10.23 23 20.46" aria-label="React Native">
      <circle r="2.05" fill="#61DAFB" />
      <g stroke="#61DAFB" strokeWidth="1" fill="none">
        <ellipse rx="11" ry="4.2" />
        <ellipse rx="11" ry="4.2" transform="rotate(60)" />
        <ellipse rx="11" ry="4.2" transform="rotate(120)" />
      </g>
    </svg>
  );
}

function Icon({ d, size = 15 }: { d: string; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={d} />
    </svg>
  );
}

const ICON = {
  close: 'M18 6 6 18M6 6l12 12',
  check: 'M20 6 9 17l-5-5',
  cloud: 'M17.5 19a4.5 4.5 0 1 0-1.4-8.8A6 6 0 0 0 4 12a4 4 0 0 0 1 7.9z',
  terminal: 'M4 17l6-6-6-6M12 19h8',
  template: 'M3 3h7v7H3zM14 3h7v7h-7zM14 14h7v7h-7zM3 14h7v7H3z',
  sparkle: 'M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8zM19 15l.9 2.1L22 18l-2.1.9L19 21l-.9-2.1L16 18l2.1-.9z',
  folder: 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z',
};

const PLATFORMS: Record<Platform, { label: string; hint: string; logo: ReactNode; accent: string }> = {
  flutter: {
    label: 'Flutter',
    hint: 'Dart · one codebase for Android, iOS and web',
    logo: <FlutterLogo />,
    accent: '#47C5FB',
  },
  'react-native': {
    label: 'React Native',
    hint: 'JavaScript / TypeScript · Expo for a quick start',
    logo: <ReactLogo />,
    accent: '#61DAFB',
  },
};

const ENV_MODES: Record<EnvMode, { label: string; hint: (platform: string) => string; icon: string }> = {
  beginner: {
    label: 'Managed',
    hint: () => 'No SDK needed — Synkro runs the toolchain for you.',
    icon: ICON.cloud,
  },
  advanced: {
    label: 'Local CLI',
    hint: (platform) => `Uses the ${platform} SDK installed on this computer.`,
    icon: ICON.terminal,
  },
};

export function NewProjectModal({ open, onClose, onCreated }: NewProjectModalProps) {
  const { syncProject } = useWorkspace();
  const [platform, setPlatform] = useState<Platform>('flutter');
  const [mode, setMode] = useState<Mode>('template');
  const [templates, setTemplates] = useState<ProjectTemplateInfo[]>([]);
  const [templateId, setTemplateId] = useState('material-app');
  const [name, setName] = useState('my_app');
  const [parentPath, setParentPath] = useState('');
  const [prompt, setPrompt] = useState('');
  const [envMode, setEnvMode] = useState<EnvMode>('beginner');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');

  useEffect(() => {
    if (!open) return;
    void window.peep.listProjectTemplates().then((items) => {
      setTemplates(items);
      if (items.length > 0) setTemplateId(items[0].id);
    });
    setError('');
    setStatus('');
  }, [open]);

  useEffect(() => {
    const unsub = window.peep.onAgentStream((event) => {
      if (event.type === 'status') setStatus(event.content);
    });
    return unsub;
  }, []);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !loading) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, loading, onClose]);

  if (!open) return null;

  const platformLabel = PLATFORMS[platform].label;

  // Templates for the selected framework (all of them if none are tagged for it).
  const filteredTemplates = templates.filter((t) =>
    platform === 'flutter'
      ? !t.id.startsWith('rn-') && !t.id.startsWith('blank-rn')
      : t.id.startsWith('rn-') || t.id.startsWith('blank-rn'),
  );
  const displayTemplates = filteredTemplates.length > 0 ? filteredTemplates : templates;
  // Switching framework can leave a template from the other one selected; fall back to the first.
  const effectiveTemplateId = displayTemplates.some((t) => t.id === templateId) ? templateId : displayTemplates[0]?.id ?? '';
  const slug = slugify(name);

  const handleSelectFolder = async () => {
    const folder = await window.peep.selectFolder();
    if (folder) setParentPath(folder);
  };

  const handleCreate = async () => {
    setError('');
    setLoading(true);
    setStatus(mode === 'prompt' ? 'Creating project…' : '');

    try {
      if (!parentPath) throw new Error('Select a parent folder.');
      if (!name.trim()) throw new Error('Enter a project name.');

      const projectName = slugify(name);
      if (!/^[a-z][a-z0-9_]*$/.test(projectName)) {
        throw new Error('Name must start with a letter and use only lowercase, numbers, underscores.');
      }

      let project: ProjectInfo;

      if (mode === 'template') {
        project = await window.peep.createProject({
          name: projectName,
          parentPath,
          templateId: effectiveTemplateId,
          mode: envMode,
          framework: platform,
        });
      } else {
        if (!prompt.trim()) throw new Error('Describe the app you want to build.');
        setStatus(`Creating ${platformLabel} project…`);
        project = await window.peep.createProjectFromPrompt({
          name: projectName,
          parentPath,
          prompt: prompt.trim(),
          mode: envMode,
          framework: platform,
        });
      }

      await syncProject(project);
      onCreated(project);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
      setStatus('');
    }
  };

  const sep = parentPath.includes('\\') ? '\\' : '/';

  return (
    <div className="new-project-overlay" onClick={loading ? undefined : onClose}>
      <div className="new-project-modal np" style={{ ['--np-accent' as string]: PLATFORMS[platform].accent }} onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="new-project-modal__header">
          <div>
            <h2>New Project</h2>
            <p className="np-subtitle">Pick a framework, then start from a template or describe your app.</p>
          </div>
          <button type="button" className="np-close" title="Close (Esc)" onClick={onClose} disabled={loading}>
            <Icon d={ICON.close} />
          </button>
        </div>

        <div className="new-project-modal__body">
          {/* Framework */}
          <div className="np-section">
            <div className="np-label">Framework</div>
            <div className="np-platforms">
              {(Object.keys(PLATFORMS) as Platform[]).map((p) => {
                const meta = PLATFORMS[p];
                const active = platform === p;
                return (
                  <button
                    key={p}
                    type="button"
                    className={`np-platform ${active ? 'np-platform--active' : ''}`}
                    style={{ ['--brand' as string]: meta.accent }}
                    onClick={() => setPlatform(p)}
                    aria-pressed={active}
                  >
                    <span className="np-platform__logo">{meta.logo}</span>
                    <span className="np-platform__text">
                      <span className="np-platform__name">{meta.label}</span>
                      <span className="np-platform__hint">{meta.hint}</span>
                    </span>
                    {active && <span className="np-check"><Icon d={ICON.check} size={11} /></span>}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Toolchain */}
          <div className="np-section">
            <div className="np-label">Toolchain</div>
            <div className="np-options">
              {(Object.keys(ENV_MODES) as EnvMode[]).map((m) => {
                const meta = ENV_MODES[m];
                const active = envMode === m;
                return (
                  <button key={m} type="button" className={`np-option ${active ? 'np-option--active' : ''}`} onClick={() => setEnvMode(m)} aria-pressed={active}>
                    <span className="np-option__icon"><Icon d={meta.icon} /></span>
                    <span className="np-option__text">
                      <span className="np-option__name">{meta.label}</span>
                      <span className="np-option__hint">{meta.hint(platformLabel)}</span>
                    </span>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Details */}
          <div className="np-grid">
            <label className="new-project-field">
              <span>Project name</span>
              <input value={name} placeholder="my_app" spellCheck={false} onChange={(e) => setName(e.target.value)} autoFocus />
            </label>

            <label className="new-project-field">
              <span>Location</span>
              <div className="new-project-field__row">
                <input value={parentPath} readOnly placeholder="Choose a folder…" onClick={() => void handleSelectFolder()} />
                <button type="button" className="np-browse" onClick={() => void handleSelectFolder()}>
                  <Icon d={ICON.folder} size={14} />
                  Browse
                </button>
              </div>
            </label>
          </div>
          <div className="np-path" title={parentPath ? `${parentPath}${sep}${slug}` : undefined}>
            {parentPath ? <>Creates <code>{parentPath}{sep}<strong>{slug || '…'}</strong></code></> : <>Folder name: <code>{slug || '…'}</code></>}
          </div>

          {/* Start from */}
          <div className="np-section">
            <div className="np-segmented" role="tablist">
              <button type="button" role="tab" aria-selected={mode === 'template'} className={mode === 'template' ? 'is-active' : ''} onClick={() => setMode('template')}>
                <Icon d={ICON.template} size={14} />
                From template
              </button>
              <button type="button" role="tab" aria-selected={mode === 'prompt'} className={mode === 'prompt' ? 'is-active' : ''} onClick={() => setMode('prompt')}>
                <Icon d={ICON.sparkle} size={14} />
                Describe with AI
              </button>
            </div>

            {mode === 'template' ? (
              displayTemplates.length > 0 ? (
                <div className="np-templates" role="radiogroup">
                  {displayTemplates.map((t) => (
                    <button
                      key={t.id}
                      type="button"
                      role="radio"
                      aria-checked={t.id === effectiveTemplateId}
                      className={`np-template ${t.id === effectiveTemplateId ? 'np-template--active' : ''}`}
                      onClick={() => setTemplateId(t.id)}
                    >
                      <span className="np-template__name">{t.name}</span>
                      <span className="np-template__desc">{t.description}</span>
                    </button>
                  ))}
                </div>
              ) : (
                <div className="np-note">No {platformLabel} templates found — the project will use the default setup.</div>
              )
            ) : (
              <label className="new-project-field np-prompt">
                <textarea
                  rows={4}
                  value={prompt}
                  placeholder={
                    platform === 'flutter'
                      ? 'A todo app with dark mode, categories, and a floating add button…'
                      : 'A social feed app with infinite scroll, like button, and profile screen…'
                  }
                  onChange={(e) => setPrompt(e.target.value)}
                />
                <small>The AI scaffolds the first version of your app. Requires a Synkro account.</small>
              </label>
            )}
          </div>

          {status && <div className="new-project-status">{status}</div>}
          {error && <div className="new-project-error">{error}</div>}
        </div>

        {/* Footer */}
        <div className="new-project-modal__footer">
          <button type="button" className="np-btn np-btn--ghost" onClick={onClose} disabled={loading}>
            Cancel
          </button>
          <button type="button" className="np-btn np-btn--primary" onClick={() => void handleCreate()} disabled={loading}>
            {loading ? <span className="np-spinner" aria-hidden="true" /> : null}
            {loading ? 'Creating…' : `Create ${platformLabel} Project`}
          </button>
        </div>
      </div>
    </div>
  );
}
