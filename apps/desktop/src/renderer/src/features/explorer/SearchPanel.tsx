import { useState, useCallback, useEffect, useRef } from 'react';
import { useWorkspaceStore } from '../../stores/workspace-store';
import { useWorkspace } from '../../hooks/useWorkspace';

interface SearchMatch {
  file: string;
  line: number;
  col: number;
  text: string;
}

interface SearchResult {
  file: string;       // relative path
  fullPath: string;
  matches: SearchMatch[];
}

/* ── Toolbar icon button ─────────────────────────────────────────────────── */
function IconBtn({ title, active, onClick, children }: {
  title: string;
  active?: boolean;
  onClick?: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      title={title}
      onClick={onClick}
      style={{
        background: active ? 'var(--bg-hover)' : 'none',
        border: active ? '1px solid var(--border-bright)' : '1px solid transparent',
        borderRadius: '4px',
        color: active ? 'var(--text-primary)' : 'var(--text-muted)',
        cursor: 'pointer',
        padding: '2px 4px',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        lineHeight: 1,
        fontSize: '11px',
        fontWeight: 700,
        fontFamily: 'var(--font-ui)',
        transition: 'background 0.12s, color 0.12s',
        minWidth: '20px',
        height: '20px',
      }}
      onMouseEnter={(e) => !active && (e.currentTarget.style.background = 'var(--bg-hover)')}
      onMouseLeave={(e) => !active && (e.currentTarget.style.background = 'none')}
    >
      {children}
    </button>
  );
}

/* ── Highlighted text ────────────────────────────────────────────────────── */
function HighlightedText({ text, query, useRegex, caseSensitive }: {
  text: string; query: string; useRegex: boolean; caseSensitive: boolean;
}) {
  if (!query) return <span>{text}</span>;
  try {
    const pattern = useRegex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const flags = caseSensitive ? 'g' : 'gi';
    const regex = new RegExp(pattern, flags);
    const match = regex.exec(text);
    if (!match) return <span>{text}</span>;

    const start = match.index;
    const end = start + match[0].length;
    let prefix = text.substring(0, start);
    if (prefix.length > 28) prefix = '…' + prefix.substring(prefix.length - 28);
    const highlight = text.substring(start, end);
    const suffix = text.substring(end, end + 60);

    return (
      <span style={{ display: 'inline', whiteSpace: 'pre' }}>
        <span>{prefix}</span>
        <span style={{ background: 'rgba(217,119,6,0.35)', color: '#fcd34d', borderRadius: '2px', padding: '0 1px' }}>{highlight}</span>
        <span>{suffix}</span>
      </span>
    );
  } catch {
    return <span>{text}</span>;
  }
}

/** Matches the case pattern of `matched` (UPPER, lower, Capitalized) like VS Code's Preserve Case. */
function applyPreserveCase(matched: string, replacement: string): string {
  if (matched === matched.toUpperCase() && matched !== matched.toLowerCase()) return replacement.toUpperCase();
  if (matched === matched.toLowerCase()) return replacement.toLowerCase();
  if (matched[0] === matched[0].toUpperCase()) return replacement.charAt(0).toUpperCase() + replacement.slice(1);
  return replacement;
}

/* ── Main component ──────────────────────────────────────────────────────── */
export function SearchPanel() {
  const project = useWorkspaceStore((s) => s.project);
  const { openFile } = useWorkspace();

  const [query, setQuery]         = useState('');
  const [results, setResults]     = useState<SearchResult[]>([]);
  const [loading, setLoading]     = useState(false);
  const [searched, setSearched]   = useState(false);
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [useRegex, setUseRegex]   = useState(false);
  const [wholeWord, setWholeWord] = useState(false);
  const [showReplace, setShowReplace] = useState(false);
  const [replaceText, setReplaceText] = useState('');
  const [preserveCase, setPreserveCase] = useState(false);
  const [replacing, setReplacing] = useState(false);
  const [includeFiles, setIncludeFiles] = useState('');
  const [excludeFiles, setExcludeFiles] = useState('');
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const searchInputRef = useRef<HTMLInputElement>(null);

  // Edit › Find in Files / Replace in Files — seeded with the editor selection like VS Code.
  useEffect(() => {
    const onFocus = (e: Event) => {
      const { replace } = (e as CustomEvent<{ replace?: boolean } | undefined>).detail ?? {};
      if (replace) setShowReplace(true);
      const selection = useWorkspaceStore.getState().activeSelection?.text;
      if (selection && !selection.includes('\n')) setQuery(selection);
      searchInputRef.current?.focus();
      searchInputRef.current?.select();
    };
    window.addEventListener('peep:search-focus', onFocus);
    return () => window.removeEventListener('peep:search-focus', onFocus);
  }, []);

  const doSearch = useCallback(async (q: string) => {
    if (!project || !q.trim()) {
      setResults([]);
      setSearched(false);
      return;
    }
    setLoading(true);
    setSearched(true);
    try {
      const raw = await (window.peep as any).searchContent({
        projectPath: project.path,
        query: wholeWord ? `\\b${q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b` : q,
        caseSensitive,
        isRegex: useRegex || wholeWord,
      }) as SearchMatch[];

      const map = new Map<string, SearchResult>();
      for (const m of raw) {
        const rel = m.file.replace(project.path, '').replace(/^[\\/]/, '');
        if (!map.has(rel)) map.set(rel, { file: rel, fullPath: m.file, matches: [] });
        map.get(rel)!.matches.push(m);
      }
      setResults([...map.values()]);
    } catch {
      setResults([]);
    } finally {
      setLoading(false);
    }
  }, [project, caseSensitive, useRegex, wholeWord]);

  useEffect(() => {
    const timer = setTimeout(() => void doSearch(query), 300);
    return () => clearTimeout(timer);
  }, [query, doSearch]);

  const handleOpenFile = (fullPath: string, line = 1, col = 1) => {
    const name = fullPath.split(/[\\/]/).pop() ?? 'file';
    openFile({ path: fullPath, name, content: '', dirty: false });
    // Give the editor time to load the file content then navigate
    setTimeout(() => {
      window.dispatchEvent(new CustomEvent('peep:go-to-line', { detail: { line, col } }));
    }, 400);
  };

  const toggleCollapse = (file: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(file)) next.delete(file); else next.add(file);
      return next;
    });
  };

  const replaceAll = async () => {
    if (!query || results.length === 0 || replacing) return;
    const matchCount = results.reduce((acc, r) => acc + r.matches.length, 0);
    const confirmed = window.confirm(
      `Replace ${matchCount} occurrence${matchCount === 1 ? '' : 's'} across ${results.length} file${results.length === 1 ? '' : 's'} with '${replaceText}'?`,
    );
    if (!confirmed) return;

    let regex: RegExp;
    try {
      const escaped = useRegex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      regex = new RegExp(wholeWord ? `\\b${escaped}\\b` : escaped, caseSensitive ? 'g' : 'gi');
    } catch (err) {
      window.alert(`Invalid regular expression: ${(err as Error).message}`);
      return;
    }

    const replaceMatch = (matched: string, ...groups: unknown[]) => {
      // With regex mode, $1-style references expand like VS Code; otherwise the text is literal.
      let text = replaceText;
      if (useRegex) {
        // replace() passes captures, then the numeric offset, the input, and (optionally) named groups.
        const captures = groups.slice(0, groups.findIndex((g) => typeof g === 'number')) as (string | undefined)[];
        text = replaceText.replace(/\$(\d+|&)/g, (ref, n: string) => (n === '&' ? matched : captures[Number(n) - 1] ?? ref));
      }
      return preserveCase ? applyPreserveCase(matched, text) : text;
    };

    setReplacing(true);
    const failures: string[] = [];
    const store = useWorkspaceStore.getState();
    for (const result of results) {
      try {
        const open = store.openFiles.find((f) => f.path === result.fullPath);
        if (open?.dirty) {
          // Unsaved edits live only in the editor: replace there and leave the file dirty.
          store.updateFileContent(open.path, open.content.replace(regex, replaceMatch));
          continue;
        }
        const content = await window.peep.readFile(result.fullPath);
        const next = content.replace(regex, replaceMatch);
        if (next === content) continue;
        await window.peep.writeFile(result.fullPath, next);
        if (open) store.syncFileContent(open.path, next);
      } catch (err) {
        failures.push(`${result.file}: ${(err as Error).message}`);
      }
    }
    setReplacing(false);
    if (failures.length) window.alert(`Some files could not be updated:\n${failures.join('\n')}`);
    void doSearch(query);
  };

  const collapseAll = () => setCollapsed(new Set(results.map((r) => r.file)));
  const expandAll   = () => setCollapsed(new Set());
  const total = results.reduce((acc, r) => acc + r.matches.length, 0);

  /* ── Input row style ── */
  const inputStyle: React.CSSProperties = {
    flex: 1,
    background: 'var(--bg-elevated)',
    border: '1px solid var(--border)',
    borderRadius: '2px',
    padding: '3px 6px',
    fontSize: '12px',
    color: 'var(--text-primary)',
    outline: 'none',
    fontFamily: 'var(--font-ui)',
    minWidth: 0,
  };

  return (
    <aside style={{ display: 'flex', flexDirection: 'column', height: '100%', background: 'var(--bg-panel)', overflow: 'hidden' }}>

      {/* ── Header ── */}
      <div style={{
        display: 'flex', alignItems: 'center',
        padding: '0 4px 0 8px', height: '35px', flexShrink: 0,
        borderBottom: '1px solid var(--border)', gap: '4px',
      }}>
        <span style={{ fontSize: '11px', fontWeight: 700, letterSpacing: '0.08em', color: 'var(--text-muted)', textTransform: 'uppercase', flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>SEARCH</span>
        <div style={{ display: 'flex', gap: '1px', alignItems: 'center', flexShrink: 0 }}>
          {/* Refresh */}
          <IconBtn title="Refresh" onClick={() => void doSearch(query)}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 .49-4.46"/></svg>
          </IconBtn>
          {/* Collapse all */}
          <IconBtn title="Collapse All" onClick={collapseAll}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="21 8 21 21 3 21 3 8"/><rect x="1" y="3" width="22" height="5"/></svg>
          </IconBtn>
          {/* Expand all */}
          <IconBtn title="Expand All" onClick={expandAll}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/></svg>
          </IconBtn>
          {/* Toggle replace */}
          <IconBtn title="Toggle Replace" active={showReplace} onClick={() => setShowReplace((v) => !v)}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/></svg>
          </IconBtn>
        </div>
      </div>

      {/* ── Search + Replace rows ── */}
      <div style={{ padding: '6px 8px 4px', display: 'flex', flexDirection: 'column', gap: '4px', flexShrink: 0, borderBottom: '1px solid var(--border)' }}>

        {/* Search row */}
        <div style={{ display: 'flex', gap: '4px', alignItems: 'center' }}>
          {/* Toggle collapse chevron */}
          <button
            title="Toggle Details"
            onClick={() => setShowReplace((v) => !v)}
            style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', padding: '2px', display: 'flex', alignItems: 'center', flexShrink: 0 }}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" style={{ transform: showReplace ? 'rotate(90deg)' : 'none', transition: 'transform 0.15s' }}>
              <polyline points="9 18 15 12 9 6"/>
            </svg>
          </button>
          
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: '2px', minWidth: 0 }}>
            {/* Input */}
            <input
              ref={searchInputRef}
              autoFocus
              type="text"
              placeholder="Search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && void doSearch(query)}
              style={{ ...inputStyle }}
            />
            {/* Toggle row below input */}
            <div style={{ display: 'flex', gap: '2px', alignItems: 'center' }}>
              <IconBtn title="Match Case (Alt+C)" active={caseSensitive} onClick={() => setCaseSensitive((v) => !v)}>Aa</IconBtn>
              <IconBtn title="Match Whole Word (Alt+W)" active={wholeWord} onClick={() => setWholeWord((v) => !v)}>
                <span style={{ textDecoration: 'underline', textUnderlineOffset: '2px' }}>ab</span>
              </IconBtn>
              <IconBtn title="Use Regular Expression (Alt+R)" active={useRegex} onClick={() => setUseRegex((v) => !v)}>.*</IconBtn>
              {loading && (
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="var(--text-muted)" strokeWidth="2" style={{ animation: 'spin 1s linear infinite', marginLeft: 'auto' }}>
                  <circle cx="12" cy="12" r="10" strokeOpacity="0.2"/><path d="M12 2a10 10 0 0 1 10 10"/>
                </svg>
              )}
            </div>
          </div>
        </div>

        {/* Replace row */}
        {showReplace && (
          <div style={{ display: 'flex', gap: '4px', alignItems: 'center' }}>
            <div style={{ width: '20px', flexShrink: 0 }} />
            <div style={{ flex: 1, position: 'relative', display: 'flex', alignItems: 'center' }}>
              <input
                type="text"
                placeholder="Replace"
                value={replaceText}
                onChange={(e) => setReplaceText(e.target.value)}
                style={{ ...inputStyle, paddingRight: '28px' }}
              />
              <div style={{ position: 'absolute', right: '4px', display: 'flex', alignItems: 'center' }}>
                <IconBtn title="Preserve Case (Alt+P)" active={preserveCase} onClick={() => setPreserveCase((v) => !v)}>AB</IconBtn>
              </div>
            </div>
            <button
              title="Replace All"
              onClick={() => void replaceAll()}
              disabled={replacing || results.length === 0}
              style={{ background: 'none', border: 'none', cursor: results.length ? 'pointer' : 'default', opacity: results.length ? 1 : 0.4, color: 'var(--text-muted)', padding: '3px', display: 'flex', alignItems: 'center', flexShrink: 0 }}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="2" y="2" width="8" height="8" rx="1"/><rect x="14" y="2" width="8" height="8" rx="1"/><rect x="2" y="14" width="8" height="8" rx="1"/><path d="M14 17h8m-4-4v8"/></svg>
            </button>
          </div>
        )}

        {/* files to include */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '4px', paddingLeft: '20px' }}>
          <div style={{ flex: 1, position: 'relative', display: 'flex', alignItems: 'center', minWidth: 0 }}>
            <input
              type="text"
              placeholder="files to include"
              value={includeFiles}
              onChange={(e) => setIncludeFiles(e.target.value)}
              style={{ ...inputStyle, fontSize: '11px', paddingRight: '22px', width: '100%' }}
            />
            <span style={{ position: 'absolute', right: '5px', pointerEvents: 'none', display: 'flex', alignItems: 'center' }}>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--text-muted)" strokeWidth="1.5"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>
            </span>
          </div>
        </div>

        {/* files to exclude */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '4px', paddingLeft: '20px' }}>
          <div style={{ flex: 1, position: 'relative', display: 'flex', alignItems: 'center', minWidth: 0 }}>
            <input
              type="text"
              placeholder="files to exclude"
              value={excludeFiles}
              onChange={(e) => setExcludeFiles(e.target.value)}
              style={{ ...inputStyle, fontSize: '11px', paddingRight: '22px', width: '100%' }}
            />
            <span style={{ position: 'absolute', right: '5px', pointerEvents: 'none', display: 'flex', alignItems: 'center' }}>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--text-muted)" strokeWidth="1.5"><circle cx="12" cy="12" r="3"/><path d="M19.07 4.93l-1.41 1.41M16.95 7.05A7 7 0 1 0 7.05 16.95M4.93 19.07l1.41-1.41"/></svg>
            </span>
          </div>
        </div>

        {/* Status line */}
        {searched && !loading && (
          <div style={{ fontSize: '11px', color: 'var(--text-muted)', paddingLeft: '20px', paddingTop: '2px' }}>
            {total > 0
              ? <><span style={{ color: 'var(--text-secondary)', fontWeight: 500 }}>{total.toLocaleString()}</span> results in <span style={{ color: 'var(--text-secondary)', fontWeight: 500 }}>{results.length}</span> files</>
              : 'No results found'}
          </div>
        )}
        {loading && (
          <div style={{ fontSize: '11px', color: 'var(--text-muted)', paddingLeft: '20px', display: 'flex', alignItems: 'center', gap: '6px' }}>
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ animation: 'spin 1s linear infinite' }}>
              <circle cx="12" cy="12" r="10" strokeOpacity="0.2"/>
              <path d="M12 2a10 10 0 0 1 10 10"/>
            </svg>
            Searching…
          </div>
        )}
      </div>

      {/* ── Results ── */}
      <div style={{ flex: 1, overflowY: 'auto', paddingTop: '4px' }}>
        {results.map((result) => {
          const isCollapsed = collapsed.has(result.file);
          const parts = result.file.replace(/\\/g, '/').split('/');
          const basename = parts.pop() ?? result.file;
          const dirname = parts.join('/');

          return (
            <div key={result.file}>
              {/* File header */}
              <button
                onClick={() => toggleCollapse(result.file)}
                style={{
                  width: '100%', textAlign: 'left', background: 'none', border: 'none',
                  padding: '3px 8px 3px 4px', display: 'flex', alignItems: 'center', gap: '4px',
                  cursor: 'pointer', fontSize: '12px', color: 'var(--text-secondary)',
                }}
                onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--bg-hover)')}
                onMouseLeave={(e) => (e.currentTarget.style.background = 'none')}
              >
                {/* Chevron */}
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"
                  style={{ flexShrink: 0, color: 'var(--text-muted)', transform: isCollapsed ? 'rotate(-90deg)' : 'none', transition: 'transform 0.12s' }}>
                  <polyline points="6 9 12 15 18 9"/>
                </svg>

                {/* File icon */}
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"
                  style={{ flexShrink: 0, color: 'var(--accent)' }}>
                  <path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/>
                  <polyline points="13 2 13 9 20 9"/>
                </svg>

                <span style={{ color: 'var(--text-primary)', fontWeight: 500, whiteSpace: 'nowrap' }}>{basename}</span>
                {dirname && <span style={{ color: 'var(--text-muted)', fontSize: '11px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>&nbsp;{dirname}</span>}
                {!dirname && <div style={{ flex: 1 }} />}

                <span style={{
                  background: 'var(--accent)', color: '#fff', fontSize: '10px', fontWeight: 700,
                  borderRadius: '10px', padding: '0px 5px', flexShrink: 0, lineHeight: '16px',
                }}>
                  {result.matches.length}
                </span>
              </button>

              {/* Match rows */}
              {!isCollapsed && result.matches.map((m, i) => (
                <button
                  key={i}
                  onClick={() => handleOpenFile(result.fullPath, m.line, m.col)}
                  style={{
                    width: '100%', textAlign: 'left', background: 'none', border: 'none',
                    padding: '1px 8px 1px 36px', cursor: 'pointer', display: 'flex',
                    alignItems: 'center', gap: '8px',
                  }}
                  onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--bg-hover)')}
                  onMouseLeave={(e) => (e.currentTarget.style.background = 'none')}
                >
                  <span style={{ fontSize: '11px', color: 'var(--text-muted)', width: '28px', textAlign: 'right', flexShrink: 0, fontVariantNumeric: 'tabular-nums' }}>
                    {m.line}
                  </span>
                  <span style={{ fontSize: '12px', color: 'var(--text-secondary)', overflow: 'hidden', whiteSpace: 'nowrap', fontFamily: 'var(--font-code)', flex: 1 }}>
                    <HighlightedText text={m.text.trim()} query={query} useRegex={useRegex} caseSensitive={caseSensitive} />
                  </span>
                </button>
              ))}
            </div>
          );
        })}

        {searched && !loading && total === 0 && (
          <div style={{ padding: '20px 16px', textAlign: 'center', color: 'var(--text-muted)', fontSize: '12px' }}>
            No results found
          </div>
        )}
      </div>

      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </aside>
  );
}
