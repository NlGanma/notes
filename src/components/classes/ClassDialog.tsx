import { useEffect, useMemo, useState } from 'react';
import { Archive, ArchiveRestore, FolderInput } from 'lucide-react';
import { Modal } from '../common/Modal';
import { useUI } from '../../state/ui';
import { useVault } from '../../state/vault';
import { CLASS_COLORS, CLASS_ICONS, classInfo, guessClassIcon, listClasses, type ClassIconName } from '../../lib/classes';
import { ClassBadge, ClassGlyph } from './ClassIcon';
import { cx } from '../../lib/util';
import { openClass } from '../../lib/commands';
import { confirmDialog } from '../common/dialogs';
import { toast } from '../common/toast';

/** Create or edit a class: name, course code, teacher, term, colour and icon. */
export function ClassDialog() {
  const dialog = useUI((s) => s.dialog);
  const open = dialog?.kind === 'class';
  const path = open ? dialog.path : null;
  const folderMeta = useVault((s) => s.folderMeta);
  const folders = useVault((s) => s.folders);
  const existing = path ? classInfo(path, folderMeta[path]) : null;

  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [instructor, setInstructor] = useState('');
  const [term, setTerm] = useState('');
  const [color, setColor] = useState(CLASS_COLORS[0]);
  const [icon, setIcon] = useState<ClassIconName | null>(null);
  const [error, setError] = useState('');

  const classCount = useMemo(() => listClasses(folders, folderMeta, { archived: true }).length, [folders, folderMeta]);
  // Most students take every class in the same term — reuse the last one typed.
  const lastTerm = useMemo(
    () =>
      listClasses(folders, folderMeta, { archived: true })
        .map((c) => c.term)
        .filter(Boolean)
        .pop() ?? '',
    [folders, folderMeta],
  );

  useEffect(() => {
    if (!open) return;
    setError('');
    if (existing) {
      setName(existing.name);
      setCode(existing.code ?? '');
      setInstructor(existing.instructor ?? '');
      setTerm(existing.term ?? '');
      setColor(existing.color);
      setIcon(existing.icon);
    } else {
      setName('');
      setCode('');
      setInstructor('');
      setTerm(lastTerm);
      setColor(CLASS_COLORS[classCount % CLASS_COLORS.length]);
      setIcon(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, path]);

  if (!open) return null;
  const close = () => useUI.getState().openDialog(null);
  const shownIcon = icon ?? guessClassIcon(name);

  const save = async () => {
    const n = name.trim();
    if (!n) {
      setError('Give the class a name.');
      return;
    }
    const same = folders.find((f) => !f.includes('/') && f.toLowerCase() === n.toLowerCase() && f !== path);
    // Editing: any other top-level folder with that name clashes. Creating: only another class does
    // (a plain folder with that name is turned into the class below).
    if (same && (path !== null || folderMeta[same]?.kind === 'class')) {
      setError(folderMeta[same]?.kind === 'class' ? 'You already have a class with that name.' : 'There is already a folder with that name.');
      return;
    }
    const info = { name: n, code: code.trim(), instructor: instructor.trim(), term: term.trim(), color, icon: shownIcon };
    const vault = useVault.getState();
    if (path) {
      const next = await vault.updateClass(path, info);
      const v = useUI.getState().view;
      if (v.kind === 'class' && v.path === path) useUI.getState().setView({ kind: 'class', path: next });
      close();
      return;
    }
    // A plain folder with the same name becomes the class (keeping its notes).
    const created = same ? await vault.updateClass(same, info) : await vault.createClass(info);
    close();
    openClass(created);
    toast.success(`Created ${n}`, 'New notes and homework you make here stay with this class.');
  };

  return (
    <Modal open onClose={close} width={520} title={path ? 'Class details' : 'New class'} className="class-dialog">
      <form
        className="class-form"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <div className="class-form-hero">
          <ClassBadge cls={{ color, icon: shownIcon }} size={52} />
          <div className="class-form-hero-text">
            <input
              className="class-name-input"
              autoFocus
              placeholder="Class name, e.g. Calculus I"
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                setError('');
              }}
            />
            <div className="class-form-sub">{[code, instructor, term].filter(Boolean).join(' · ') || 'Course code, teacher and term are optional'}</div>
          </div>
        </div>
        <div className="class-form-grid">
          <label>
            <span>Course code</span>
            <input className="input" placeholder="MATH 1A" value={code} onChange={(e) => setCode(e.target.value)} />
          </label>
          <label>
            <span>Teacher</span>
            <input className="input" placeholder="Prof. Alvarez" value={instructor} onChange={(e) => setInstructor(e.target.value)} />
          </label>
          <label>
            <span>Term</span>
            <input className="input" placeholder="Fall 2026" value={term} onChange={(e) => setTerm(e.target.value)} />
          </label>
        </div>
        <div className="class-form-row">
          <span className="class-form-label">Colour</span>
          <div className="swatches">
            {CLASS_COLORS.map((c) => (
              <button
                key={c}
                type="button"
                className={cx('class-swatch', c === color && 'is-active')}
                style={{ background: c }}
                onClick={() => setColor(c)}
                aria-label={`Colour ${c}`}
              />
            ))}
          </div>
        </div>
        <div className="class-form-row">
          <span className="class-form-label">Icon</span>
          <div className="icon-picks">
            {CLASS_ICONS.map((ic) => (
              <button
                key={ic}
                type="button"
                className={cx('icon-pick', ic === shownIcon && 'is-active')}
                style={{ ['--class' as string]: color }}
                onClick={() => setIcon(ic)}
                aria-label={ic}
              >
                <ClassGlyph icon={ic} size={16} />
              </button>
            ))}
          </div>
        </div>
        {error && <div className="form-error">{error}</div>}
        <div className="dialog-actions class-form-actions">
          {path && existing && (
            <>
              <button
                type="button"
                className="btn is-ghost"
                onClick={() => {
                  void useVault.getState().updateClass(path, { archived: !existing.archived });
                  close();
                }}
                title={existing.archived ? 'Show it in the sidebar again' : 'Hide it from the sidebar; its notes stay searchable'}
              >
                {existing.archived ? <ArchiveRestore size={15} /> : <Archive size={15} />} {existing.archived ? 'Unarchive' : 'Archive'}
              </button>
              <button
                type="button"
                className="btn is-ghost"
                onClick={async () => {
                  if (
                    await confirmDialog({
                      title: `Turn “${existing.name}” back into a folder?`,
                      message: 'Its notes and homework stay where they are. Only the class details are removed.',
                      confirm: 'Make folder',
                    })
                  ) {
                    useVault.getState().setIsClass(path, false);
                    close();
                    useUI.getState().setView({ kind: 'folder', path });
                  }
                }}
              >
                <FolderInput size={15} /> Make folder
              </button>
            </>
          )}
          <span className="grow" />
          <button type="button" className="btn is-ghost" onClick={close}>
            Cancel
          </button>
          <button type="submit" className="btn is-primary">
            {path ? 'Save' : 'Create class'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
