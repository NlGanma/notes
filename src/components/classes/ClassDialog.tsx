import { useEffect, useMemo, useState } from 'react';
import { Check } from 'lucide-react';
import { Modal } from '../common/Modal';
import { useUI } from '../../state/ui';
import { useVault } from '../../state/vault';
import {
  CLASS_COLORS,
  CLASS_ICONS,
  CLASS_THEMES,
  classInfo,
  guessClassIcon,
  listClasses,
  settleClassName,
  themeFor,
  themeVars,
  type ClassIconName,
} from '../../lib/classes';
import { ClassGlyph } from './ClassIcon';
import { cx } from '../../lib/util';
import { openClass } from '../../lib/commands';
import { confirmDialog } from '../common/dialogs';
import { short } from '../FileTree';

type Icon = ClassIconName | 'auto';
const isIcon = (s: string | undefined): s is ClassIconName => (CLASS_ICONS as readonly string[]).includes(s ?? '');

/**
 * New class / Edit class: a name (optional), a colour and an icon. Nothing is required and nothing is an
 * error: a blank name becomes "Untitled class" and a taken one gets a number. Until an icon is picked,
 * the icon follows the name (a chemistry class gets the flask).
 */
export function ClassDialog() {
  const dialog = useUI((s) => s.dialog);
  const open = dialog?.kind === 'class';
  const path = open ? dialog.path : null;
  const folderMeta = useVault((s) => s.folderMeta);
  const folders = useVault((s) => s.folders);
  const existing = path ? classInfo(path, folderMeta[path]) : null;
  const classCount = useMemo(() => listClasses(folders, folderMeta, { archived: true }).length, [folders, folderMeta]);

  const [name, setName] = useState('');
  // null: keep the class's stored colour as it is (older versions stored other hexes; they are never rewritten).
  const [color, setColor] = useState<string | null>(null);
  const [icon, setIcon] = useState<Icon>('auto');
  const [iconTouched, setIconTouched] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setName(existing?.name ?? '');
    setColor(existing ? null : CLASS_COLORS[classCount % CLASS_COLORS.length]);
    const stored = path ? folderMeta[path]?.icon : undefined;
    setIcon(isIcon(stored) ? stored : 'auto');
    setIconTouched(false);
    setBusy(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, path]);

  if (!open) return null;
  const close = () => useUI.getState().openDialog(null);
  const theme = themeFor(color ?? (path ? folderMeta[path]?.color : undefined));
  const shownIcon: ClassIconName = icon === 'auto' ? guessClassIcon(name.trim() || existing?.name || '') : icon;

  const save = async () => {
    if (busy) return;
    setBusy(true);
    const vault = useVault.getState();
    try {
      if (path && existing) {
        // Clearing the name keeps the old one; a clash with another folder gets a number.
        const next = name.trim() ? settleClassName(name, folders, path) : existing.name;
        const patch: { name?: string; color?: string; icon?: string } = {};
        if (next !== existing.name) patch.name = next;
        if (color) patch.color = color;
        if (iconTouched) patch.icon = icon === 'auto' ? undefined : icon;
        const moved = await vault.updateClass(path, patch);
        const v = useUI.getState().view;
        if (v.kind === 'class' && v.path === path) useUI.getState().setView({ kind: 'class', path: moved });
        close();
        return;
      }
      const created = await vault.createClass({
        name: settleClassName(name, folders),
        color: color ?? CLASS_COLORS[0],
        icon: icon === 'auto' ? undefined : icon,
      });
      close();
      openClass(created);
    } finally {
      setBusy(false);
    }
  };

  const toFolder = async () => {
    if (!path || !existing) return;
    const ok = await confirmDialog({
      title: `Turn ${short(existing.name)} into a plain folder?`,
      message: 'It moves to All notes. Its notes and homework stay.',
      confirm: 'Turn into folder',
    });
    if (!ok) return;
    useVault.getState().setIsClass(path, false);
    close();
    useUI.getState().setView({ kind: 'folder', path });
  };

  return (
    <Modal open onClose={close} width={440} bare className="class-dialog">
      <form
        className="dialog-form class-form"
        style={themeVars(theme) as React.CSSProperties}
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <div className="dialog-body">
          <h2 className="dialog-title">{path ? 'Edit class' : 'New class'}</h2>
          <div className="class-name-input">
            <input
              className="input"
              value={name}
              autoFocus
              maxLength={100}
              placeholder="Untitled class"
              aria-label="Class name"
              spellCheck={false}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div className="class-field">
            <div className="class-field-label" id="class-colour-label">
              Colour
            </div>
            <div className="class-swatches" role="radiogroup" aria-labelledby="class-colour-label">
              {CLASS_THEMES.map((t) => (
                <button
                  key={t.key}
                  type="button"
                  role="radio"
                  aria-checked={t.key === theme.key}
                  className={cx('class-swatch', t.key === theme.key && 'is-active')}
                  style={{ background: t.banner }}
                  onClick={() => setColor(t.banner)}
                  aria-label={t.label}
                  title={t.label}
                >
                  {t.key === theme.key && <Check size={14} strokeWidth={2.5} />}
                </button>
              ))}
            </div>
          </div>
          <div className="class-field">
            <div className="class-field-label" id="class-icon-label">
              Icon
            </div>
            <div className="class-icons" role="radiogroup" aria-labelledby="class-icon-label">
              {CLASS_ICONS.map((ic) => (
                <button
                  key={ic}
                  type="button"
                  role="radio"
                  aria-checked={ic === shownIcon}
                  className={cx('icon-pick', ic === shownIcon && 'is-active')}
                  onClick={() => {
                    setIcon(ic);
                    setIconTouched(true);
                  }}
                  aria-label={ic}
                  title={icon === 'auto' && ic === shownIcon ? 'Picked from the name' : undefined}
                >
                  <ClassGlyph icon={ic} size={18} />
                </button>
              ))}
            </div>
          </div>
        </div>
        <div className="dialog-actions">
          {path && existing && (
            <button type="button" className="btn is-ghost is-quiet class-to-folder" onClick={() => void toFolder()}>
              Turn into a plain folder…
            </button>
          )}
          <span className="grow" />
          <button type="button" className="btn is-secondary" onClick={close}>
            Cancel
          </button>
          <button type="submit" className="btn is-primary" disabled={busy}>
            {path ? 'Save' : 'Create'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
