import { FolderOpen16Regular, FolderSearch16Regular } from '@fluentui/react-icons';
import { useEffect, useMemo, useState } from 'react';
import type { ScanItem } from '@shared/ipc';
import { joinPath } from '@shared/move';
import { Button, cx } from '../../components/Button';
import { api } from '../../lib/api';
import { toast, useApp, useT } from '../../state/app';
import { op, useLibrary, useLibraryView } from '../../state/library';
import { newId } from '../../state/workspace';
import s from './Library.module.css';

/** "Scan a folder": every subfolder, analyzed; the ones that look like projects come pre-checked. */
export function ImportDialog() {
  const open = useLibraryView((v) => v.importOpen);
  return open ? <Scan /> : null;
}

function Scan() {
  const tr = useT();
  const home = useApp((st) => st.home);
  const collections = useLibrary((l) => l.collections);
  const startDir = useLibraryView((v) => v.scanDir);
  const [dir, setDir] = useState<string | null>(startDir);
  const [scanned, setScanned] = useState<{ dir: string; items: ScanItem[] } | null>(null);
  // A list from another folder (the user picked a new one) counts as still scanning.
  const items = scanned && scanned.dir === dir ? scanned.items : null;
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [showAll, setShowAll] = useState(false);
  const [collection, setCollection] = useState<string>('');
  const [adding, setAdding] = useState(false);

  const close = () => useLibraryView.setState({ importOpen: false, scanDir: null });

  useEffect(() => {
    if (!dir) return;
    let live = true;
    void api.invoke('library:scan', dir).then((list) => {
      if (!live) return;
      setScanned({ dir, items: list });
      setChecked(new Set(list.filter((x) => !x.entryId && x.facts.isCode).map((x) => x.path)));
    });
    return () => {
      live = false;
    };
  }, [dir]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const pick = async () => {
    const p = await api.invoke('dialog:pick-folder', tr('library.scanPick'));
    if (p) setDir(p);
  };

  const visible = useMemo(
    () =>
      (items ?? [])
        .filter((x) => showAll || x.facts.isCode || x.entryId)
        .sort((a, b) => a.name.localeCompare(b.name)),
    [items, showAll],
  );
  const hidden = (items?.length ?? 0) - visible.length;
  const candidates = visible.filter((x) => !x.entryId);
  const count = candidates.filter((x) => checked.has(x.path)).length;

  const add = async () => {
    setAdding(true);
    let collectionId: string | null = collection || null;
    if (collection === '__new') {
      const name = tr('library.importedCollection');
      collectionId = newId('c');
      await op({ op: 'collectionAdd', id: collectionId, name });
    }
    const paths = candidates.filter((x) => checked.has(x.path)).map((x) => x.path);
    const added = await api.invoke('library:add', paths, collectionId);
    toast(tr('library.added', added.length), 'success');
    close();
  };

  return (
    <div className={s.scrim} onPointerDown={(e) => e.target === e.currentTarget && close()}>
      <div className={cx(s.dialog, s.wide)} role="dialog" aria-modal="true" aria-labelledby="scan-title">
        <div className={s.dialogHead}>
          <h2 id="scan-title" className={s.dialogTitle}>
            {tr('library.scanTitle')}
          </h2>
        </div>
        <div className={s.dialogBody}>
          <div className={s.inputRow}>
            <span className={s.pathLine} style={{ flex: 1 }}>
              {dir ?? tr('library.scanNone')}
            </span>
            {home && !dir && (
              <Button onClick={() => setDir(joinPath(home, 'Desktop'))}>{tr('library.scanDesktop')}</Button>
            )}
            <Button onClick={() => void pick()}>
              <FolderOpen16Regular />
              {tr('library.scanChoose')}
            </Button>
          </div>
          {dir && items === null && <span className={s.muted}>{tr('library.scanning')}</span>}
          {items && (
            <>
              <div className={s.scanTools}>
                <Button variant="subtle" onClick={() => setChecked(new Set(candidates.map((x) => x.path)))}>
                  {tr('library.selectAll')}
                </Button>
                <Button variant="subtle" onClick={() => setChecked(new Set())}>
                  {tr('library.selectNone')}
                </Button>
                {hidden > 0 || showAll ? (
                  <label className={s.check}>
                    <input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} />
                    {tr('library.showNotCode', hidden)}
                  </label>
                ) : null}
              </div>
              <div className={s.scanList} role="list">
                {visible.length === 0 && <span className={s.muted}>{tr('library.scanEmpty')}</span>}
                {visible.map((x) => {
                  const inLib = !!x.entryId;
                  return (
                    <label
                      key={x.path}
                      className={cx(s.scanRow, (inLib || !x.facts.isCode) && s.scanFaded)}
                      role="listitem"
                    >
                      <input
                        type="checkbox"
                        disabled={inLib}
                        checked={inLib || checked.has(x.path)}
                        onChange={(e) => {
                          const next = new Set(checked);
                          if (e.target.checked) next.add(x.path);
                          else next.delete(x.path);
                          setChecked(next);
                        }}
                      />
                      <span className={s.cardName} title={x.path}>
                        {x.name}
                      </span>
                      <span className={s.chips}>
                        {inLib ? (
                          <span className={s.chip}>{tr('library.inLibrary')}</span>
                        ) : x.facts.stack.length ? (
                          x.facts.stack.slice(0, 5).map((st) => (
                            <span key={st} className={s.chip}>
                              {st}
                            </span>
                          ))
                        ) : (
                          <span className={s.muted}>
                            {x.facts.isCode ? tr('library.noStack') : tr('library.notCode')}
                          </span>
                        )}
                        {x.facts.git?.branch && !inLib && <span className={cx(s.chip, s.tag)}>git</span>}
                      </span>
                    </label>
                  );
                })}
              </div>
            </>
          )}
        </div>
        <div className={s.dialogFoot}>
          <span className={s.footNote}>
            {items && (
              <label className={s.check}>
                {tr('library.addTo')}
                <select
                  className={s.select}
                  value={collection}
                  onChange={(e) => setCollection(e.target.value)}
                >
                  <option value="">{tr('library.inbox')}</option>
                  {collections.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                  <option value="__new">{tr('library.newCollectionImported')}</option>
                </select>
              </label>
            )}
          </span>
          <Button onClick={close}>{tr('common.cancel')}</Button>
          <Button variant="primary" disabled={count === 0 || adding} onClick={() => void add()}>
            <FolderSearch16Regular />
            {tr('library.addCount', count)}
          </Button>
        </div>
      </div>
    </div>
  );
}
