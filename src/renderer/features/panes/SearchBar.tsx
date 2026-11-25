import { ArrowDown16Regular, ArrowUp16Regular, Dismiss12Regular } from '@fluentui/react-icons';
import { useEffect, useRef, useSyncExternalStore } from 'react';
import { cx, IconButton } from '../../components/Button';
import { useT } from '../../state/app';
import type { TerminalController } from '../../terminal/TerminalController';
import s from './PaneGrid.module.css';

/** Find bar of one terminal (Ctrl+Shift+F); state lives in the controller. */
export function SearchBar({ c }: { c: TerminalController }) {
  const t = useT();
  const st = useSyncExternalStore(
    (l) => c.subscribe(l),
    () => c.searchState,
  );
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (st.open) {
      input.current?.focus();
      input.current?.select();
    }
  }, [st.open]);

  if (!st.open) return null;
  const toggle = (key: 'caseSensitive' | 'wholeWord' | 'regex', label: string, text: string) => (
    <button
      type="button"
      className={cx(s.toggle, st[key] && s.toggleOn)}
      title={label}
      aria-pressed={st[key]}
      onClick={() => c.setSearch({ [key]: !st[key] })}
    >
      {text}
    </button>
  );
  return (
    <div className={s.search} role="search">
      <input
        ref={input}
        className={cx(s.searchInput, !!st.query && st.resultCount === 0 && s.noMatch)}
        value={st.query}
        placeholder={t('search.placeholder')}
        spellCheck={false}
        onChange={(e) => c.setSearch({ query: e.target.value })}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault();
            c.closeSearch();
          } else if (e.key === 'Enter') {
            e.preventDefault();
            c.findNext(e.shiftKey);
          }
        }}
      />
      {toggle('caseSensitive', t('search.case'), 'Aa')}
      {toggle('wholeWord', t('search.word'), 'ab')}
      {toggle('regex', t('search.regex'), '.*')}
      <span className={s.count}>
        {st.query
          ? st.resultCount > 0
            ? `${st.resultIndex + 1} / ${st.resultCount}`
            : t('search.none')
          : ''}
      </span>
      <IconButton label={t('search.prev')} size="sm" onClick={() => c.findNext(true)}>
        <ArrowUp16Regular />
      </IconButton>
      <IconButton label={t('search.next')} size="sm" onClick={() => c.findNext(false)}>
        <ArrowDown16Regular />
      </IconButton>
      <IconButton label={t('search.close')} size="sm" onClick={() => c.closeSearch()}>
        <Dismiss12Regular />
      </IconButton>
    </div>
  );
}
