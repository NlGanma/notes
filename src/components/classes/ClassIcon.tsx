import {
  Atom,
  BookOpen,
  Brain,
  Calculator,
  ChartLine,
  Code,
  Dna,
  FlaskConical,
  Globe,
  GraduationCap,
  Landmark,
  Languages,
  Music,
  Palette,
  Scale,
  Sigma,
} from 'lucide-react';
import type { ClassIconName, ClassInfo } from '../../lib/classes';

const ICONS: Record<ClassIconName, typeof Sigma> = {
  sigma: Sigma,
  calculator: Calculator,
  atom: Atom,
  flask: FlaskConical,
  dna: Dna,
  landmark: Landmark,
  book: BookOpen,
  languages: Languages,
  code: Code,
  globe: Globe,
  chart: ChartLine,
  palette: Palette,
  music: Music,
  brain: Brain,
  scale: Scale,
  cap: GraduationCap,
};

export function ClassGlyph({ icon, size = 14 }: { icon: ClassIconName; size?: number }) {
  const I = ICONS[icon] ?? GraduationCap;
  return <I size={size} />;
}

/** A class's coloured badge with its icon. */
export function ClassBadge({ cls, size = 22 }: { cls: Pick<ClassInfo, 'color' | 'icon'>; size?: number }) {
  return (
    <span className="class-badge" style={{ width: size, height: size, ['--class' as string]: cls.color }}>
      <ClassGlyph icon={cls.icon} size={Math.round(size * 0.6)} />
    </span>
  );
}
