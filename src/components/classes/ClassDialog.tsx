import { useEffect, useMemo, useState } from 'react';
import { Check } from 'lucide-react';
import { Modal } from '../common/Modal';
import { Field } from '../common/Field';
import { useUI } from '../../state/ui';
import { useVault } from '../../state/vault';
import { CLASS_COLORS, CLASS_ICONS, CLASS_THEMES, classInfo, guessClassIcon, listClasses, themeVars, type ClassIconName } from '../../lib/classes';
import { ClassGlyph } from './ClassIcon';
import { ClassArt } from './ClassesView';
import { cx, sanitizeFolderName } from '../../lib/util';
import { openClass } from '../../lib/commands';
import { confirmDialog } from '../common/dialogs';
import { toast } from '../common/toast';

/**
 * Google Classroom's "Create class" dialog: four calm fields, Cancel and
 * Create as text buttons. A new class gets the next theme and an icon guessed
 * from its name; the banner's "Customize" changes them.
 */
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
    setName(existing?.name ?? '');
    setCode(existing?.code ?? '');
    setInstructor(existing?.instructor ?? '');
    setTerm(existing ? (existing.term ?? '') : lastTerm);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, path]);

  if (!open) return null;
  const close = () => useUI.getState().openDialog(null);
  const clash = folders.find((f) => !f.includes('/') && f.toLowerCase() === sanitizeFolderName(name).toLowerCase() && f !== path);
  const clashError = clash && (path !== null || folderMeta[clash]?.kind === 'class') ? (folderMeta[clash]?.kind === 'class' ? 'You already have a class with this name' : 'There is already a folder with this name') : '';

  const save = async () => {
    // The name becomes a folder on disk, so it's cleaned the same way the vault cleans it.
    const n = sanitizeFolderName(name);
    if (!n) {
      setError(name.trim() ? 'Use letters or numbers; a class name can’t start with a dot' : '');
      return;
    }
    if (clashError) return;
    // Editing only the details of a class must never rename its folder.
    const keepName = !!path && !!existing && name === existing.name;
    const color = existing ? (folderMeta[path!]?.color ?? CLASS_COLORS[0]) : CLASS_COLORS[classCount % CLASS_COLORS.length];
    const icon: ClassIconName = existing?.icon ?? guessClassIcon(n);
    const info = { name: n, code: code.trim(), instructor: instructor.trim(), term: term.trim(), color, icon };
    const vault = useVault.getState();
    try {
      if (path) {
        const next = await vault.updateClass(path, keepName ? { ...info, name: undefined } : info);
        const v = useUI.getState().view;
        if (v.kind === 'class' && v.path === path) useUI.getState().setView({ ...v, path: next });
        close();
        return;
      }
      // A plain folder with the same name becomes the class (keeping its notes).
      const created = clash ? await vault.updateClass(clash, info) : await vault.createClass(info);
      close();
      openClass(created);
      toast.success(`Created ${n}`);
    } catch (e) {
      setError(String((e as Error)?.message ?? e));
    }
  };

  const canSave = !!sanitizeFolderName(name) && !clashError && name.length <= 100;

  return (
    <Modal open onClose={close} width={448} bare className="class-dialog">
      <form
        className="gdialog class-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (canSave) void save();
        }}
      >
        <h2 className="gdialog-title">{path ? 'Edit class' : 'Create class'}</h2>
        <div className="gdialog-fields">
          <Field
            label="Class name (required)"
            value={name}
            autoFocus
            maxLength={120}
            onChange={(v) => {
              setName(v);
              setError('');
            }}
            error={name.length > 100 ? '100 characters max' : clashError || error}
            className="class-name-input"
          />
          <Field label="Course code" value={code} onChange={setCode} />
          <Field label="Teacher" value={instructor} onChange={setInstructor} />
          <Field label="Term" value={term} onChange={setTerm} />
        </div>
        <div className="gdialog-actions">
          {path && existing && (
            <button
              type="button"
              className="btn is-ghost is-quiet"
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
              Make folder
            </button>
          )}
          <span className="grow" />
          <button type="button" className="btn is-ghost" onClick={close}>
            Cancel
          </button>
          <button type="submit" className="btn is-ghost" disabled={!canSave}>
            {path ? 'Save' : 'Create'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

/** Classroom's "Customize appearance": a live banner preview, the theme colour and the banner icon. */
export function CustomizeDialog() {
  const dialog = useUI((s) => s.dialog);
  const open = dialog?.kind === 'customize';
  const path = open ? dialog.path : null;
  const folderMeta = useVault((s) => s.folderMeta);
  const cls = path ? classInfo(path, folderMeta[path]) : null;
  const [theme, setTheme] = useState(CLASS_THEMES[0]);
  const [icon, setIcon] = useState<ClassIconName>('cap');

  useEffect(() => {
    if (cls) {
      setTheme(cls.theme);
      setIcon(cls.icon);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, path]);

  if (!open || !cls || !path) return null;
  const close = () => useUI.getState().openDialog(null);
  const save = async () => {
    await useVault.getState().updateClass(path, { color: theme.banner, icon });
    close();
  };

  return (
    <Modal open onClose={close} width={560} bare className="customize-dialog">
      <div className="gdialog">
        <h2 className="gdialog-title">Customize appearance</h2>
        <div className="customize-preview" style={themeVars(theme) as React.CSSProperties}>
          <ClassArt icon={icon} h={128} />
          <div className="customize-preview-name">{cls.name}</div>
        </div>
        <div className="customize-label">Theme colour</div>
        <div className="theme-swatches" role="radiogroup" aria-label="Theme colour">
          {CLASS_THEMES.map((t) => (
            <button
              key={t.key}
              role="radio"
              aria-checked={t.key === theme.key}
              className={cx('theme-swatch', t.key === theme.key && 'is-active')}
              style={{ background: t.banner, ['--ring' as string]: t.banner }}
              onClick={() => setTheme(t)}
              aria-label={t.label}
              title={t.label}
            >
              {t.key === theme.key && <Check size={18} />}
            </button>
          ))}
        </div>
        <div className="customize-label">Banner icon</div>
        <div className="icon-picks" role="radiogroup" aria-label="Banner icon">
          {CLASS_ICONS.map((ic) => (
            <button
              key={ic}
              role="radio"
              aria-checked={ic === icon}
              className={cx('icon-pick', ic === icon && 'is-active')}
              style={themeVars(theme) as React.CSSProperties}
              onClick={() => setIcon(ic)}
              aria-label={ic}
            >
              <ClassGlyph icon={ic} size={20} />
            </button>
          ))}
        </div>
        <div className="gdialog-actions">
          <span className="grow" />
          <button className="btn is-ghost" onClick={close}>
            Cancel
          </button>
          <button className="btn is-ghost" onClick={() => void save()}>
            Save
          </button>
        </div>
      </div>
    </Modal>
  );
}
