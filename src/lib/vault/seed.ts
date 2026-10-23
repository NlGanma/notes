import type { JSONContent } from '@tiptap/core';
import type { FolderMeta, NoteDoc } from './types';
import type { Stroke } from '../ink/types';
import seedInk from './seedInk.json';
import { uid } from '../util';

/** Demo notebook shown on first launch. Handwriting comes from scripts/build-seed.mjs. */

type Inline = string | JSONContent;
const ink = seedInk as unknown as Record<string, Stroke[]>;

const text = (s: string, ...marks: string[]): JSONContent => ({ type: 'text', text: s, ...(marks.length ? { marks: marks.map((type) => ({ type })) } : {}) });
const b = (s: string) => text(s, 'bold');
const i = (s: string) => text(s, 'italic');
const hl = (s: string, color = '#fff3a3'): JSONContent => ({ type: 'text', text: s, marks: [{ type: 'highlight', attrs: { color } }] });
const m = (latex: string): JSONContent => ({ type: 'mathInline', attrs: { latex } });
const inl = (parts: Inline[]) => parts.filter((x) => x !== '').map((x) => (typeof x === 'string' ? text(x) : x));
const p = (...parts: Inline[]): JSONContent => ({ type: 'paragraph', content: parts.length ? inl(parts) : undefined });
const h = (level: 1 | 2 | 3, s: string): JSONContent => ({ type: 'heading', attrs: { level }, content: [text(s)] });
const ul = (...items: Inline[][]): JSONContent => ({
  type: 'bulletList',
  content: items.map((it) => ({ type: 'listItem', content: [p(...it)] })),
});
const ol = (...items: Inline[][]): JSONContent => ({
  type: 'orderedList',
  content: items.map((it) => ({ type: 'listItem', content: [p(...it)] })),
});
const todo = (...items: [boolean, ...Inline[]][]): JSONContent => ({
  type: 'taskList',
  content: items.map(([checked, ...it]) => ({ type: 'taskItem', attrs: { checked }, content: [p(...it)] })),
});
const math = (latex: string): JSONContent => ({ type: 'mathBlock', attrs: { latex } });
const inkBlock = (strokes: Stroke[], height: number): JSONContent => ({ type: 'inkBlock', attrs: { height, ink: strokes } });
const callout = (variant: string, ...content: JSONContent[]): JSONContent => ({ type: 'callout', attrs: { variant }, content });
const code = (s: string): JSONContent => ({ type: 'codeBlock', attrs: { language: 'bash' }, content: [text(s)] });
const quote = (...content: JSONContent[]): JSONContent => ({ type: 'blockquote', content });
const annotated = (block: JSONContent, strokes: Stroke[]): JSONContent => ({ ...block, attrs: { ...(block.attrs ?? {}), ink: strokes } });
const doc = (...content: JSONContent[]): JSONContent => ({ type: 'doc', content });

const inlineApprox: JSONContent = {
  type: 'inkInline',
  attrs: { strokes: ink.inlineImplies, w: 40, h: 34, em: 80, drop: 2, transcript: '⇒' },
};

function fixInline(): JSONContent {
  // Normalise the generated glyph to its bounding box.
  const strokes = ink.inlineImplies;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const s of strokes)
    for (let k = 0; k < s.pts.length; k += 3) {
      minX = Math.min(minX, s.pts[k]);
      maxX = Math.max(maxX, s.pts[k]);
      minY = Math.min(minY, s.pts[k + 1]);
      maxY = Math.max(maxY, s.pts[k + 1]);
    }
  const moved = strokes.map((s) => ({
    ...s,
    pts: s.pts.map((v, k) => (k % 3 === 0 ? v - minX : k % 3 === 1 ? v - minY : v)),
  }));
  return { ...inlineApprox, attrs: { ...inlineApprox.attrs, strokes: moved, w: maxX - minX, h: maxY - minY, drop: maxY - 74 } };
}

/** The demo notebooks are set up as classes. */
export const SEED_CLASSES: Record<string, FolderMeta> = {
  'Calculus I': { kind: 'class', code: 'MATH 1A', instructor: 'Prof. Alvarez', term: 'Fall 2026', color: '#2160e8', icon: 'sigma' },
  Biology: { kind: 'class', code: 'BIO 110', instructor: 'Dr. Chen', term: 'Fall 2026', color: '#1f9d4c', icon: 'dna' },
  Physics: { kind: 'class', code: 'PHYS 7A', instructor: 'Dr. Okafor', term: 'Fall 2026', color: '#7346e6', icon: 'atom' },
  History: { kind: 'class', code: 'HIST 12', instructor: 'Ms. Patel', term: 'Fall 2026', color: '#e35d14', icon: 'landmark' },
  'Spanish II': { kind: 'class', code: 'SPAN 2', instructor: 'Sra. Morales', term: 'Fall 2026', color: '#d6336c', icon: 'languages' },
};

export function buildSeedNotes(): NoteDoc[] {
  const now = Date.now();
  const day = 86_400_000;
  const note = (title: string, folder: string, tags: string[], content: JSONContent, ago: number, extra: Partial<NoteDoc['meta']> = {}): NoteDoc => ({
    version: 1,
    meta: { id: uid('n'), title, folder, tags, created: now - ago - day, updated: now - ago, paper: 'ruled', ...extra },
    content,
  });

  const welcome = note(
    'Welcome to Nib',
    '',
    ['guide'],
    doc(
      p(
        'Nib is a notebook where ',
        b('typing and handwriting live on the same page'),
        ' — and where your own ',
        b('local AI'),
        ' can read both. Nothing leaves your Mac.',
      ),
      inkBlock(ink.welcome, 96),
      callout(
        'tip',
        p(
          b('Just start typing'),
          ' after you write. Your text lands on the ruled line right under your handwriting. Press ',
          b('Esc'),
          ' to pick the marker back up.',
        ),
      ),
      h(2, 'Things to try'),
      todo(
        [false, 'Choose the marker (⌥P) and write anywhere below. The page grows as you go'],
        [false, 'Type a sentence, write a symbol right after it, then keep typing ', fixInline(), ' — it joins the sentence'],
        [false, 'Press ⌘D to sketch a symbol inline, exactly at the cursor'],
        [false, 'Draw a circle or a box and ', i('hold'), ' at the end — it snaps into a clean shape'],
        [false, 'Pick ', b('Select'), ' (⌥S), drag a box over anything on the page, and ask about it'],
        [false, 'Open ', b('Ask your notes'), ' (⇧⌘L) and ask a question across every notebook'],
        [
          false,
          'Open ',
          b('Homework'),
          ' → Problem Set 4 and ask for help — answers come only from Lecture 4, and anything else is marked ',
          i('Not from your notes'),
        ],
        [false, 'Add your own class with ', b('New class'), ' on the ', b('Classes'), ' page. Notes and homework made there stay with it'],
      ),
      h(2, 'Make it pretty, fast'),
      ul(
        ['Type ', b('/'), ' for any block: headings, checklists, equations, callouts, handwriting areas.'],
        ['Markdown works as you type: ', b('#'), ' heading, ', b('-'), ' list, ', b('[]'), ' checklist, ', b('$x^2$'), ' math, ', b('$$'), ' equation.'],
        ['Everything snaps to the same baseline grid, so typed text and handwriting always line up.'],
        [b('Polish'), ', in the ⋯ menu, suggests cleanups: tidy spacing, harmonise ink colours, typeset handwritten math.'],
      ),
      h(2, 'Your AI stays on your Mac'),
      p(
        'Nib talks to a model running locally through ',
        b('Ollama'),
        ', ',
        b('LM Studio'),
        ' or any OpenAI-compatible server. For the best experience, pull a model that can see images so it can read your handwriting:',
      ),
      code('ollama pull qwen2.5vl:7b        # reads handwriting & diagrams\nollama pull nomic-embed-text     # semantic search across your notes'),
      p('Then open ', b('Settings → Local AI'), ' (⌘,) and press ', i('Detect'), '.'),
    ),
    0,
    { pinned: true, color: '#2160e8' },
  );

  const calc = note(
    'Lecture 4 — Limits & Continuity',
    'Calculus I',
    [],
    doc(
      p(i('Prof. Alvarez · Tuesday')),
      h(2, 'Definition of a limit'),
      annotated(
        p(
          'We write ',
          m('\\lim_{x \\to a} f(x) = L'),
          ' if we can make ',
          m('f(x)'),
          ' as close to ',
          m('L'),
          ' as we like by taking ',
          m('x'),
          ' close enough to ',
          m('a'),
          ' (but not equal to ',
          m('a'),
          ').',
        ),
        ink.calcHighlight,
      ),
      callout(
        'important',
        p(
          b('ε–δ form: '),
          'for every ',
          m('\\varepsilon > 0'),
          ' there is a ',
          m('\\delta > 0'),
          ' such that ',
          m('0 < |x-a| < \\delta \\implies |f(x) - L| < \\varepsilon'),
          '.',
        ),
      ),
      h(2, 'Limit laws'),
      ul(
        ['Sum: ', m('\\lim (f+g) = \\lim f + \\lim g')],
        ['Product: ', m('\\lim (fg) = (\\lim f)(\\lim g)')],
        ['Quotient: ', m('\\lim \\frac{f}{g} = \\frac{\\lim f}{\\lim g}'), ' when ', m('\\lim g \\neq 0')],
      ),
      annotated(h(2, 'Squeeze theorem'), ink.calcAnnotation),
      p('If ', m('g(x) \\le f(x) \\le h(x)'), ' near ', m('a'), ' and ', m('\\lim g = \\lim h = L'), ', then ', m('\\lim f = L'), '. The classic use:'),
      math('\\lim_{x \\to 0} \\frac{\\sin x}{x} = 1'),
      p('The professor said this one ', hl('will definitely be on the exam'), ' — know the geometric proof with the unit circle.'),
      h(2, 'Worked example (in class)'),
      inkBlock(ink.calcExample, 224),
      h(2, 'Continuity'),
      p(m('f'), ' is ', b('continuous at a'), ' when all three hold:'),
      ol(['', m('f(a)'), ' is defined'], ['', m('\\lim_{x\\to a} f(x)'), ' exists'], ['the two are equal: ', m('\\lim_{x\\to a} f(x) = f(a)')]),
      p(
        b('Removable discontinuity:'),
        ' a hole that can be "filled", like ',
        m('\\frac{x^2-9}{x-3}'),
        ' at ',
        m('x=3'),
        '. ',
        b('Jump:'),
        ' left and right limits differ. ',
        b('Infinite:'),
        ' vertical asymptote.',
      ),
      h(2, 'Intermediate Value Theorem'),
      p(
        'If ',
        m('f'),
        ' is continuous on ',
        m('[a,b]'),
        ' and ',
        m('N'),
        ' is between ',
        m('f(a)'),
        ' and ',
        m('f(b)'),
        ', there is a ',
        m('c \\in (a,b)'),
        ' with ',
        m('f(c)=N'),
        '. Used to prove equations have roots.',
      ),
    ),
    2 * 3_600_000,
    { color: '#7346e6' },
  );

  const bio = note(
    'Cell Structure & Organelles',
    'Biology',
    [],
    doc(
      p(i('Ch. 6 — reading + lab notes')),
      inkBlock(ink.cell, 320),
      h(2, 'Organelles'),
      ul(
        [b('Nucleus'), ' — holds DNA; the ', b('nucleolus'), ' inside it builds ribosomes.'],
        [b('Mitochondria'), ' — site of cellular respiration; make ', b('ATP'), '. Have their own DNA (endosymbiotic theory).'],
        [b('Ribosomes'), ' — synthesise proteins; free in the cytosol or bound to the rough ER.'],
        [b('Rough ER'), ' — ribosome-studded; folds and modifies proteins. ', b('Smooth ER'), ' — lipids, detox.'],
        [b('Golgi apparatus'), ' — modifies, sorts and ships proteins ("the post office").'],
        [b('Lysosomes'), ' — digestive enzymes (animal cells).'],
        [b('Chloroplasts'), ' — photosynthesis (plants & algae only).'],
      ),
      callout('tip', p('Mnemonic for the endomembrane system: ', b('"Nobody Eats Green Lemons"'), ' — Nucleus → ER → Golgi → Lysosome / membrane.')),
      h(2, 'Prokaryotes vs eukaryotes'),
      p(
        b('Prokaryotic'),
        ' cells (bacteria, archaea) have no nucleus or membrane-bound organelles; DNA sits in the nucleoid. ',
        b('Eukaryotic'),
        ' cells are ~10× larger and compartmentalised.',
      ),
      quote(
        p(
          '“The mitochondrion is the powerhouse of the cell” — true, but the exam wants you to name ',
          b('the electron transport chain'),
          ' on the inner membrane as where most ATP is made.',
        ),
      ),
    ),
    day,
    { color: '#1f9d4c' },
  );

  const phys = note(
    'Kinematics — cheat sheet',
    'Physics',
    [],
    doc(
      p('Constant acceleration only. Pick the equation that is ', b('missing'), ' the variable you don’t know.'),
      math('v = v_0 + a t'),
      math('x = x_0 + v_0 t + \\tfrac{1}{2} a t^2'),
      math('v^2 = v_0^2 + 2a\\,\\Delta x'),
      h(2, 'Projectile motion'),
      inkBlock(ink.projectile, 288),
      ul(
        ['Horizontal: ', m('a_x = 0'), ', so ', m('x = v_0 \\cos\\theta \\, t')],
        ['Vertical: ', m('a_y = -g'), ', so ', m('y = v_0 \\sin\\theta \\, t - \\tfrac12 g t^2')],
        ['Range on level ground: ', m('R = \\frac{v_0^2 \\sin 2\\theta}{g}'), ' — maximised at ', m('\\theta = 45^\\circ')],
      ),
      callout('note', p('Use ', m('g = 9.8\\ \\text{m/s}^2'), ' unless the problem says otherwise. Keep the sign convention consistent: up is positive.')),
    ),
    3 * day,
    { color: '#e35d14' },
  );

  const hist = note(
    'French Revolution — essay outline',
    'History',
    [],
    doc(
      p(b('Thesis: '), 'The French Revolution was driven less by Enlightenment ideas alone than by a fiscal crisis that made those ideas politically urgent.'),
      h(2, 'Causes'),
      ol(
        [b('Debt'), ' from the Seven Years’ War and support for the American Revolution.'],
        [b('Tax system'), ' — the First and Second Estates were largely exempt; the burden fell on the Third Estate.'],
        [b('Bread prices'), ' — poor harvests in 1788 doubled the price of bread in Paris.'],
        [b('Enlightenment'), ' — Rousseau’s popular sovereignty, Montesquieu’s separation of powers.'],
      ),
      h(2, 'Key events'),
      ul(
        [b('May 1789'), ' — Estates-General convened at Versailles.'],
        [b('June 1789'), ' — Tennis Court Oath; National Assembly formed.'],
        [b('14 July 1789'), ' — Storming of the Bastille.'],
        [b('Aug 1789'), ' — Declaration of the Rights of Man and of the Citizen.'],
        [b('1793–94'), ' — the Reign of Terror under Robespierre and the Committee of Public Safety.'],
      ),
      h(2, 'Sources to cite'),
      todo(
        [true, 'Doyle, ', i('Oxford History of the French Revolution')],
        [false, 'Primary: Sieyès, ', i('What is the Third Estate?'), ' (1789)'],
        [false, 'Lecture slides, week 7'],
      ),
    ),
    5 * day,
    { color: '#c98a04' },
  );

  // Homework linked to the lecture it practises. Question 4 needs a rule the
  // lecture never covered — the helper must say so and mark its answer.
  const hw = note(
    'Problem Set 4 — Limits & Continuity',
    'Calculus I/Homework',
    [],
    doc(
      p(i('Show all work. Use the methods from Lecture 4.')),
      ol(
        ['Use the squeeze theorem to find ', m('\\lim_{x \\to 0} x^2 \\sin(1/x)'), '.'],
        ['Where is ', m('f(x) = \\frac{x^2-9}{x-3}'), ' discontinuous? What kind of discontinuity is it?'],
        ['Show that ', m('x^3 + x - 1 = 0'), ' has a root between ', m('0'), ' and ', m('1'), '.'],
        ['Use L’Hôpital’s rule to evaluate ', m('\\lim_{x \\to 0} \\frac{1 - \\cos x}{x^2}'), '.'],
      ),
      h(2, 'My work'),
      inkBlock([], 192),
    ),
    30 * 60_000,
    { homework: { sources: [calc.meta.id], folders: [], due: startOfDay(now) + 2 * day + 23 * 3_600_000 + 59 * 60_000 } },
  );

  // A class organised by chapter (a subfolder per unit), for Review.
  const unit = 'Spanish II/Unidad 3 — El pasado';
  const pretImp = note(
    'Pretérito vs. imperfecto',
    unit,
    [],
    doc(
      p(i('Unidad 3 · clase del martes')),
      h(2, 'El pretérito'),
      p('Use the ', b('preterite'), ' for completed actions with a clear beginning or end: ', i('Ayer comí paella.'), ' (Yesterday I ate paella.)'),
      ul(
        ['Regular ', b('-ar'), ' endings: ', b('-é, -aste, -ó, -amos, -aron'), ' — ', i('hablé, hablaste, habló')],
        ['Regular ', b('-er/-ir'), ' endings: ', b('-í, -iste, -ió, -imos, -ieron'), ' — ', i('comí, viviste, salió')],
        ['Trigger words: ', i('ayer, anoche, el año pasado, de repente, una vez')],
      ),
      h(2, 'El imperfecto'),
      p('Use the ', b('imperfect'), ' for habits, ongoing background and descriptions in the past: ', i('De niño, jugaba al fútbol.'), ' (As a child, I used to play soccer.)'),
      ul(
        [b('-ar'), ' endings: ', b('-aba, -abas, -aba, -ábamos, -aban'), ' — ', i('hablaba')],
        [b('-er/-ir'), ' endings: ', b('-ía, -ías, -ía, -íamos, -ían'), ' — ', i('comía, vivía')],
        ['Only three irregular verbs: ', b('ser'), ' (era), ', b('ir'), ' (iba), ', b('ver'), ' (veía).'],
        ['Trigger words: ', i('siempre, todos los días, mientras, de niño, a menudo')],
      ),
      callout('tip', p(b('Interrupted action:'), ' the imperfect sets the scene and the preterite interrupts it — ', i('Leía cuando sonó el teléfono.'))),
    ),
    4 * 3_600_000,
    { color: '#d6336c' },
  );
  const vocab = note(
    'Vocabulario — la niñez',
    unit,
    [],
    doc(
      p('Words for talking about childhood (use them with the imperfect).'),
      ul(
        [b('la niñez'), ' — childhood'],
        [b('el juguete'), ' — toy'],
        [b('portarse bien / mal'), ' — to behave well / badly'],
        [b('pelearse'), ' — to fight'],
        [b('el vecindario'), ' — neighbourhood'],
        [b('la guardería'), ' — daycare / nursery school'],
      ),
    ),
    6 * 3_600_000,
    { color: '#d6336c' },
  );

  return [welcome, calc, bio, phys, hist, hw, pretImp, vocab];
}

function startOfDay(t: number) {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}
