import katex from 'katex';

const cache = new Map<string, string>();

/** Renders LaTeX to HTML; never throws (errors render as red source). */
export function renderMath(latex: string, display = false): string {
  const key = (display ? 'D:' : 'I:') + latex;
  let html = cache.get(key);
  if (html === undefined) {
    try {
      html = katex.renderToString(latex || '\\square', {
        displayMode: display,
        throwOnError: false,
        strict: 'ignore',
        trust: false,
        output: 'htmlAndMathml',
      });
    } catch {
      html = `<span class="math-error">${latex.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!)}</span>`;
    }
    if (cache.size > 2000) cache.clear();
    cache.set(key, html);
  }
  return html;
}

/** MathML-only rendering for self-contained exports (no fonts needed). */
export function renderMathML(latex: string, display = false): string {
  try {
    return katex.renderToString(latex, { displayMode: display, throwOnError: false, strict: 'ignore', output: 'mathml' });
  } catch {
    return latex;
  }
}
