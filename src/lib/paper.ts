/** The three papers a note can have, in the order every picker shows them. */
export type Paper = 'blank' | 'grid' | 'ruled';

export const PAPERS: { id: Paper; label: string }[] = [
  { id: 'blank', label: 'Blank' },
  { id: 'grid', label: 'Squared' },
  { id: 'ruled', label: 'Lined' },
];

// Older versions offered dotted and legal-pad paper; they open as their nearest kept paper.
const LEGACY: Record<string, Paper> = { legal: 'ruled', dots: 'grid' };

/** Any stored value (old, hand-edited or missing) as one of the three papers; lined when unknown. */
export function normalizePaper(p: unknown): Paper {
  if (p === 'blank' || p === 'grid' || p === 'ruled') return p;
  return (typeof p === 'string' && LEGACY[p]) || 'ruled';
}

export const paperLabel = (p: Paper) => PAPERS.find((x) => x.id === p)?.label ?? 'Lined';
