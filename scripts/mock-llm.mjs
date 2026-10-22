#!/usr/bin/env node
// A tiny stand-in for a local model server, for tests and demos without a GPU.
// Speaks the Ollama API (/api/*) and the OpenAI-compatible API (/v1/*) with
// streaming, vision capability flags and embeddings. Replies are canned but
// shaped by the prompt (library answers cite the excerpts they were given).
//
//   node scripts/mock-llm.mjs [port=11434]

import http from 'node:http';

const PORT = Number(process.argv[2] || process.env.PORT || 11434);
const DELAY = Number(process.env.MOCK_DELAY ?? 12);

const MODELS = [
  { name: 'qwen2.5vl:7b', family: 'qwen25vl', params: '8.3B', caps: ['completion', 'vision'] },
  { name: 'qwen3:8b', family: 'qwen3', params: '8.2B', caps: ['completion', 'thinking'] },
  { name: 'nomic-embed-text:latest', family: 'nomic-bert', params: '137M', caps: ['embedding'] },
];

// Fault injection for the test harness: POST /__mock {fail, status, truncate, firstTokenMs}
// makes the next chat requests fail, stop early (done_reason "length") or start slowly.
// badQuestions makes the next Review questions carry a false premise (the app must reject them).
const faults = { fail: 0, status: 503, truncate: 0, firstTokenMs: 0, badQuestions: 0 };
const stats = { chat: 0, failed: 0, kinds: [], last: [] };

/** Which feature a request came from (for tests: e.g. "no notes prompt was sent"). */
function kindOf(messages) {
  const system = messages.find((m) => m.role === 'system')?.content ?? '';
  const last = [...messages].reverse().find((m) => m.role === 'user')?.content ?? '';
  if (/so you are answering that part from general knowledge/i.test(system)) return 'general';
  if (/Check your answer against the excerpts/.test(last)) return 'verify';
  const task = /^Nib task: ([\w-]+)/m.exec(system + '\n' + last)?.[1];
  if (task) return task;
  if (/Mastery Engine/i.test(system)) return `mastery-${/^Task: (\w+)/m.exec(last)?.[1] ?? 'other'}`;
  if (/come from the note the student has open|The student has their note/i.test(system)) return 'note';
  if (/homework helper/i.test(system)) return 'homework';
  if (/library assistant/i.test(system)) return 'library';
  if (/careful editor/i.test(system)) return 'transform';
  return 'other';
}
function record(messages) {
  stats.kinds.push(kindOf(messages));
  if (stats.kinds.length > 200) stats.kinds.shift();
  stats.last = messages.map((m) => ({ role: m.role, content: String(m.content ?? '').slice(0, 4000) }));
}

// ------------------------------------------------------------------ helpers

const STOP = new Set(
  'the a an of to and or in on is are was were be by for with as at it this that what which how why do does did can i you we your my me about from'.split(' '),
);
const words = (s) => (s.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((w) => !STOP.has(w));

function embed(text, dim = 256) {
  const v = new Array(dim).fill(0);
  for (const w of words(text)) {
    const stem = w.length > 4 ? w.replace(/(ing|ed|es|s)$/, '') : w;
    let h = 2166136261;
    for (const c of stem) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
    v[Math.abs(h) % dim] += 1;
  }
  const n = Math.hypot(...v) || 1;
  return v.map((x) => x / n);
}

function pngSize(b64) {
  try {
    const buf = Buffer.from(b64.slice(0, 64), 'base64');
    return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
  } catch {
    return { w: 0, h: 0 };
  }
}

function parseExcerpts(system) {
  const out = [];
  const re = /\[(\d+)\] \(([^)]*)\)\n([\s\S]*?)(?=\n\n\[\d+\] \(|\n\nEND OF EXCERPTS|$)/g;
  let m;
  while ((m = re.exec(system))) out.push({ n: Number(m[1]), where: m[2], text: m[3].trim() });
  return out;
}

function firstSentences(text, n = 2) {
  const clean = text
    .replace(/^#+\s.*$/gm, '')
    .replace(/^[-*]\s+/gm, '')
    .replace(/\*\*/g, '')
    .replace(/==/g, '')
    .replace(/\n+/g, ' ')
    .trim();
  const parts = clean.match(/[^.!?]+[.!?]+/g) ?? [clean];
  return parts.slice(0, n).join(' ').trim();
}

/** Content words (4+ letters) a sentence shares with an excerpt. */
const content = (t) => new Set(words(t).filter((w) => w.length > 3));
function overlap(a, b) {
  const B = content(b);
  return [...content(a)].filter((w) => B.has(w)).length;
}
function bestExcerpt(ex, text) {
  let best = null;
  for (const e of ex) {
    const s = overlap(text, `${e.where} ${e.text}`);
    if (s > (best?.s ?? 0)) best = { e, s };
  }
  return best;
}

/**
 * What a well-behaved small model does: cite each sentence with the excerpt
 * it comes from (when one shares at least two words with it).
 */
function citeEach(text, ex) {
  return text
    .split('\n')
    .map((line) => {
      if (!line.trim() || /^\s*(#|\$\$|```|:::)/.test(line)) return line;
      return line
        .split(/(?<=[.!?])\s+(?=[A-Z$*✓✗])/)
        .map((sent) => {
          if (/\[\d+\]/.test(sent) || /\?\s*$/.test(sent)) return sent;
          const b = bestExcerpt(ex, sent);
          if (!b || b.s < 2) return sent;
          return /[.!?]$/.test(sent) ? `${sent.slice(0, -1)} [${b.e.n}]${sent.slice(-1)}` : `${sent} [${b.e.n}]`;
        })
        .join(' ');
    })
    .join('\n');
}

/** The first line of an excerpt that states something (not its heading). */
function firstFact(e) {
  return (
    e.text
      .split('\n')
      .map((l) => l.replace(/^[-*>\d.\s]+/, '').trim())
      .find((l) => l && !l.startsWith('#') && !/^\[Handwritten/.test(l) && l.length > 20) ?? ''
  );
}

// ------------------------------------------------------------------ the Mastery Engine (Review)

/** Excerpts as the Review tasks give them: [n] (where) then the text between triple quotes. */
function parseTaskExcerpts(text) {
  const out = [];
  const re = /\[(\d+)\] \(([^\n]*)\)\n"""\n([\s\S]*?)\n"""/g;
  let m;
  while ((m = re.exec(text))) out.push({ n: Number(m[1]), where: m[2], text: m[3] });
  return out;
}
const statementLines = (text) =>
  text
    .split('\n')
    .map((l) => l.replace(/^\s*(?:[-*+]|\d+[.)])\s+/, '').trim())
    .filter((l) => l && !l.startsWith('#') && !/^\[Handwritten/.test(l) && !l.startsWith('$$') && l.split(/\s+/).length >= 5);
const firstWords = (l, n) => l.split(/\s+/).slice(0, n).join(' ');

function masteryReply(q) {
  const task = /^Task: (\w+)/m.exec(q)?.[1];
  if (task === 'concepts') {
    const concepts = [];
    for (const e of parseTaskExcerpts(q)) {
      for (const line of statementLines(e.text).slice(0, 2)) {
        const name = (line.replace(/\*\*|==|\$[^$]*\$/g, ' ').match(/\p{L}{4,}/gu) ?? []).slice(0, 3).join(' ');
        if (!name) continue;
        const bold = /\*\*([^*]+)\*\*/.exec(line)?.[1];
        concepts.push({ name, source: e.n, proof: firstWords(line, 8), key: bold ?? line.split(/\s+/).pop().replace(/[.,;:!?]+$/, '') });
      }
    }
    // Two slips a small model makes, which the app must reject: a proof that isn't in
    // the notes, and an invented name on a real line.
    if (concepts.length) {
      concepts.push({ name: 'Photosynthesis in plants', source: 1, proof: 'Plants turn sunlight into sugar using chlorophyll', key: 'chlorophyll' });
      concepts.push({ name: 'Mitochondria powerhouse', source: 1, proof: concepts[0].proof, key: concepts[0].key });
    }
    return JSON.stringify({ concepts });
  }
  if (task === 'question') {
    const name = /about "([^"]*)" that the excerpt answers/.exec(q)?.[1] ?? 'this';
    const level = /^Level: (\w+)/m.exec(q)?.[1] ?? 'explain';
    const ex = parseTaskExcerpts(q)[0];
    if (!ex) return '{"skip": true}';
    const lines = statementLines(ex.text);
    const nameW = content(name);
    const line = [...lines].sort((a, b) => [...content(b)].filter((w) => nameW.has(w)).length - [...content(a)].filter((w) => nameW.has(w)).length)[0];
    if (!line) return '{"skip": true}';
    const clean = name.replace(/\*\*/g, '');
    if (faults.badQuestions > 0) {
      faults.badQuestions--;
      return JSON.stringify({ question: `What did Napoleon say about ${clean} in 1805?`, proof: firstWords(line, 8), keyPoints: [firstWords(line, 6)] });
    }
    const example = /use this example that is written in the excerpt: "([^"]*)"/.exec(q)?.[1];
    const question =
      level === 'apply' && example
        ? `Which idea from your notes does this example show, and why? “${example}”`
        : level === 'connect'
          ? `How does ${clean} relate to the other idea in this part of your notes?`
          : `In your own words, what do your notes say about ${clean}?`;
    // The key point is the idea (for "apply", the line without the example the student is shown).
    const idea = example ? line.replace(example, '').replace(/[:\s]+$/, '') : line;
    const tail = idea.split(/\s+/).slice(-6).join(' ').replace(/[.;:]+$/, '');
    return JSON.stringify({ question, proof: firstWords(line, 8), keyPoints: [tail] });
  }
  if (task === 'grade') {
    const points = [...(q.split(/Key points[^\n]*\n/)[1] ?? '').split("Student's answer")[0].matchAll(/^(\d+)\. (.*)$/gm)].map((m) => ({ n: Number(m[1]), text: m[2] }));
    const answer = /Student's answer:\n"""\n([\s\S]*?)\n"""/.exec(q)?.[1] ?? '';
    const stem = (w) => w.slice(0, 5);
    const aw = new Set(words(answer).map(stem));
    return JSON.stringify({
      points: points.map(({ n, text }) => {
        const pw = [...new Set(words(text).filter((w) => w.length > 2).map(stem))];
        const r = pw.length ? pw.filter((w) => aw.has(w)).length / pw.length : 0;
        return { n, hit: r >= 0.6 ? 'yes' : r >= 0.3 ? 'partly' : 'no', quote: r >= 0.3 ? answer.trim().slice(0, 160) : '' };
      }),
      contradicts: '',
    });
  }
  if (task === 'nudge') {
    const blanked = /From their notes: "([\s\S]*?)"\nStudent's answer/.exec(q)?.[1] ?? '';
    const start = blanked.replace(/\*\*|==/g, '').split(/\s+/).slice(0, 4).join(' ');
    return JSON.stringify({ nudge: `What does the line in your notes say about ${start}?` });
  }
  return '{"skip": true}';
}

// ------------------------------------------------------------------ replies

function reply(messages) {
  const system = messages.find((m) => m.role === 'system')?.content ?? '';
  const last = [...messages].reverse().find((m) => m.role === 'user') ?? { content: '' };

  // "Continue" after a cut-off reply: repeat the last few words, then the rest of the original answer.
  if (/Your reply was cut off/i.test(last.content) && messages.length >= 3) {
    const before = messages[messages.length - 2]?.content ?? '';
    const full = reply(messages.slice(0, -2));
    const rest = full.startsWith(before) ? full.slice(before.length) : full;
    const tail = before
      .split(/(?<=\s)/)
      .slice(-5)
      .join('');
    return tail + rest;
  }
  const q = last.content;
  const images = last.images ?? [];

  if (/Mastery Engine/.test(system)) return masteryReply(q);

  // Double-check: quote the excerpt line behind each statement (the app verifies the quote).
  if (/Check your answer against the excerpts/.test(q)) {
    const all = messages.map((m) => m.content).join('\n\n');
    const ex = parseExcerpts((all.split('EXCERPTS:')[1] ?? all).replace(/\n\nEND OF EXCERPTS[\s\S]*?(?=\n\n\[\d+\] \(|$)/g, ''));
    const statements = [...q.matchAll(/^(\d+)\. (.*)$/gm)].map((m) => ({ n: Number(m[1]), text: m[2] }));
    const checks = statements.map(({ n, text }) => {
      let best = null;
      for (const e of ex)
        for (const line of e.text.split('\n')) {
          const s = overlap(text, line);
          if (s >= 3 && s > (best?.s ?? 0)) best = { e, line, s };
        }
      return best ? { n, excerpt: best.e.n, quote: best.line.replace(/^[-*>\d.\s]+/, '').replace(/\*\*/g, '').trim() } : { n, excerpt: 0, quote: 'none' };
    });
    return JSON.stringify({ checks });
  }

  if (/Transcribe the handwriting/i.test(q)) {
    const { w, h } = images[0] ? pngSize(images[0]) : { w: 0, h: 0 };
    if (w && h && w / h < 3) {
      return JSON.stringify({
        kind: 'math',
        text: 'Ex. Find $\\lim_{x \\to 3} \\frac{x^2 - 9}{x - 3}$\n$= \\lim_{x \\to 3} \\frac{(x-3)(x+3)}{x-3}$\n$= \\lim_{x \\to 3} (x+3)$\n$= ?$ ← stuck here, ask the tutor',
        latex: '\\lim_{x \\to 3} \\frac{x^2 - 9}{x - 3} \\\\ = \\lim_{x \\to 3} \\frac{(x-3)(x+3)}{x-3} \\\\ = \\lim_{x \\to 3} (x+3)',
        description: '',
      });
    }
    return JSON.stringify({ kind: 'text', text: 'Hi! This line was written by hand.\nType below it, or keep writing →', latex: '', description: '' });
  }

  if (/Suggest a concise, specific title/i.test(q)) return 'Pendulum Lab — Measuring g';
  if (/Suggest 2 to 4 short lowercase tags/i.test(q)) return '["physics", "lab", "pendulum"]';
  if (/Write a 2–3 sentence summary/i.test(q))
    return 'This note covers the formal definition of a limit, the limit laws and the squeeze theorem, then works through factoring to remove a $0/0$ form. It ends with the three conditions for continuity and the Intermediate Value Theorem.';
  if (/Rewrite this paragraph as a clean bulleted list/i.test(q)) return '- First key point\n- Second key point\n- Third key point';

  if (/Transcribe ALL the text on this page/i.test(q)) {
    return '**Problem Set 5**\n1. Use the squeeze theorem to find $\\lim_{x \\to 0} x^2 \\cos(1/x)$.\n2. Is $f(x) = \\frac{x^2-4}{x-2}$ continuous at $x = 2$? Explain.';
  }

  // The one call allowed to use general knowledge (the app boxes and labels all of it).
  if (/so you are answering that part from general knowledge/i.test(system)) {
    const what = /Answer only this: (.*)/.exec(system)?.[1] ?? q;
    if (/h[oô]pital/i.test(what + q))
      return "L'Hôpital's rule: if $\\lim f = \\lim g = 0$, then $\\lim \\frac{f}{g} = \\lim \\frac{f'}{g'}$. Here $\\lim_{x \\to 0} \\frac{1-\\cos x}{x^2} = \\lim_{x \\to 0} \\frac{\\sin x}{2x} = \\frac{1}{2}$. Check with your teacher whether you're expected to use it yet.";
    if (/photosynth/i.test(what + q)) return 'In general, photosynthesis is how plants turn light, water and carbon dioxide into sugar and oxygen.';
    if (/peru/i.test(what + q)) return 'The capital of Peru is Lima.';
    return `In general, ${what.replace(/[?.]+$/, '')} is usually covered in textbooks; I'm not sure how your class treats it, so check with your teacher.`;
  }

  // Per-note assistant: the open note as numbered excerpts; replies cite them.
  if (/come from the note the student has open|The student has their note/i.test(system)) {
    const more = /MORE EXCERPTS[^\n]*\n([\s\S]*?\n\nEND OF EXCERPTS)/.exec(q)?.[1] ?? '';
    const ex = [...parseExcerpts(system.split('EXCERPTS:')[1] ?? ''), ...parseExcerpts(more)];
    // The question itself, without the app's instructions and reminder.
    const asked = q.replace(/\n*\(Only the excerpts[\s\S]*$/, '').replace(/\n*These words from the question[^\n]*/, '').split('\n\n').pop() ?? q;
    const title = /note the student has open, "([^"]*)"|has their note "([^"]*)"/.exec(system)?.slice(1).find(Boolean) ?? 'this note';
    const find = (re) => ex.find((e) => re.test(e.text) || re.test(e.where));
    const c = (e) => (e ? ` [${e.n}]` : '');
    const cont = find(/Removable discontinuity|continuous at/i);
    const sq = find(/squeeze/i);
    if (/Act as a tutor/i.test(q)) {
      return `You're finding $\\lim_{x \\to 3} \\frac{x^2-9}{x-3}$, the example your notes call a removable discontinuity at $x=3$${c(cont)}.\n\n✓ Cancelling $(x-3)$ is how that hole gets filled${c(cont)}.\n\n**Hint:** your notes say $f$ is continuous at $a$ when $\\lim_{x\\to a} f(x) = f(a)$${c(cont)}. After cancelling, what do you get when you substitute $x = 3$?\n\nTry it and tell me what you get.`;
    }
    if (/Check the student's work step by step/i.test(q)) {
      return `1. $\\frac{x^2-9}{x-3}$ is the removable discontinuity at $x=3$ from your notes ✓${c(cont)}\n2. Cancelling $(x-3)$ fills the hole your notes describe ✓${c(cont)}\n3. $\\lim_{x\\to3}(x+3)$ — not finished yet: your notes say the limit has to equal $f(a)$ ✓${c(cont)}\n\n**Verdict:** everything so far follows your notes — just finish the last step.`;
    }
    if (/Solve the problem completely/i.test(q)) {
      return `1. Your notes call $\\frac{x^2-9}{x-3}$ a removable discontinuity at $x=3$: a hole that can be filled${c(cont)}.\n2. $= \\lim_{x \\to 3} (x+3)$\n3. $= 3 + 3 = 6$\n\n$$\\boxed{6}$$\n\n**Key idea:** removable discontinuity, as your notes name it${c(cont)}.`;
    }
    if (/Summari[sz]e/i.test(q)) {
      return ex
        .filter((e) => firstFact(e))
        .slice(0, 4)
        .map((e) => `- ${firstFact(e)} [${e.n}]`)
        .join('\n');
    }
    if (/Quiz me/i.test(q)) {
      const e = ex.find((x) => firstFact(x));
      return `Let's start. **Question 1:** in your own words, what does your note say about ${(e?.where.split('›').pop() ?? 'this').replace(/"/g, '').trim()}?`;
    }
    if (/examples my notes give/i.test(q)) {
      const e = ex.find((x) => /\(([A-Z][^)]{8,})\)|e\.g\.|example/i.test(x.text));
      if (!e) return 'NOT IN NOTES: an example of this';
      const line = e.text.split('\n').find((l) => /\(([A-Z][^)]{8,})\)|e\.g\.|example/i.test(l)) ?? firstFact(e);
      return `Your notes give this example: ${line.replace(/\*\*/g, '')} [${e.n}]`;
    }
    if (/Explain this|Explain what this part/i.test(q)) {
      const lines = [];
      if (sq) {
        lines.push(`- The **squeeze theorem**: if $g(x) \\le f(x) \\le h(x)$ near $a$ and $\\lim g = \\lim h = L$, then $\\lim f = L$ [${sq.n}].`);
        lines.push(`- The classic use in your notes is $\\lim_{x \\to 0} \\frac{\\sin x}{x} = 1$, which will be on the exam [${sq.n}].`);
      } else {
        for (const e of ex.filter((x) => firstFact(x)).slice(0, 2)) lines.push(`- ${firstFact(e)} [${e.n}]`);
      }
      return `Here's the idea in plain words, based on **${title}**:\n\n${lines.join('\n')}`;
    }
    // A question: answer from the best-matching excerpt, or say what isn't there.
    const b = bestExcerpt(ex, asked);
    if (!b || !b.s) return `NOT IN NOTES: ${asked.trim()}`;
    let out = `According to your note, ${firstSentences(b.e.text, 2).replace(/^./, (ch) => ch.toLowerCase())} [${b.e.n}]`;
    // Like a careful model: name the question's words that no excerpt mentions.
    const QWORDS = new Set('what does note notes about explain mean means tell give show please your with into from that this have will would could should which when where there their them they then than were been being know want help'.split(' '));
    const inNotes = content(ex.map((e) => `${e.where} ${e.text}`).join(' '));
    const missing = [...content(asked)].filter((w) => !QWORDS.has(w) && !inNotes.has(w) && !/^power|^rule/.test(w));
    if (missing.length) out += `\n\nNOT IN NOTES: ${missing.join(' ')}`;
    // A deliberate slip, so tests can see it contained: a rule the notes never mention.
    if (/power rule/i.test(q)) out += `\n\nThe power rule says the derivative of $x^n$ is $nx^{n-1}$ [${b.e.n}].`;
    return out;
  }

  // Homework helper: answers strictly from the linked notes, with an :::outside block for the rest.
  if (/homework helper/i.test(system)) {
    const notesPart = system.split("THE STUDENT'S NOTES")[1] ?? '';
    const ex = parseExcerpts(notesPart);
    const find = (re) => ex.find((e) => re.test(e.text) || re.test(e.where));
    const sq = find(/squeeze/i);
    const laws = find(/limit laws|Sum:|Product:/i);
    const cont = find(/continuous at|Removable discontinuity/i);
    const ivt = find(/Intermediate Value/i);
    const c = (e) => (e ? ` [${e.n}]` : '');
    if (/has not linked any notes/i.test(system)) {
      return "You haven't linked any notes to this homework yet, so nothing here can come from your class notes.\n\n:::outside\nIn general, a limit describes the value a function approaches as $x$ gets close to a point. Link the lecture that covers this problem and I'll answer from it instead.\n:::";
    }
    if (/h[oô]pital|1 - \\\\?cos|problem 4/i.test(q)) {
      return `Your notes don't cover L'Hôpital's rule — Lecture 4 only covers limit laws, the squeeze theorem and continuity.\n\nWhat your notes do give you here: the limit laws${c(laws)} and the squeeze theorem${c(sq)}.\n\nNOT IN NOTES: L'Hôpital's rule\n\nAsk your teacher whether you're expected to use it yet.`;
    }
    if (/continuous|discontinu|x\^2-9|problem 2/i.test(q)) {
      return `Your notes define continuity at $a$ by three conditions: $f(a)$ is defined, $\\lim_{x\\to a} f(x)$ exists, and the two are equal${c(cont)}.\n\nThey also name this exact example: $\\frac{x^2-9}{x-3}$ has a removable discontinuity at $x=3$ — a hole that can be filled${c(cont)}.`;
    }
    if (/root|x\^3|intermediate|problem 3/i.test(q)) {
      return `Use the Intermediate Value Theorem from your notes: if $f$ is continuous on $[a,b]$ and $N$ is between $f(a)$ and $f(b)$, there is a $c \\in (a,b)$ with $f(c) = N$${c(ivt)}.\n\nYour notes say it is used to prove equations have roots${c(ivt)}.`;
    }
    if (/Act as a tutor/i.test(q)) {
      return `This is the squeeze theorem from your notes${c(sq)}.\n\n**One hint:** your notes say to trap $f$ between $g(x) \\le f(x) \\le h(x)$ with $\\lim g = \\lim h = L$${c(sq)}. Since $-1 \\le \\sin(1/x) \\le 1$, what two functions could $x^2 \\sin(1/x)$ sit between?`;
    }
    if (/Check the student's work against the method/i.test(q)) {
      return `1. Bounding the function between two others ✓ — that is the first step of the squeeze theorem in your notes${c(sq)}.\n2. Both bounds must have the same limit $L$ ✓${c(sq)}.\n\nMost students forget to say why the bounds hold near $a$.`;
    }
    return `Use the squeeze theorem exactly as your notes state it: if $g(x) \\le f(x) \\le h(x)$ near $a$ and $\\lim g = \\lim h = L$, then $\\lim f = L$${c(sq)}.\n\n1. Bound it: $-x^2 \\le x^2 \\sin(1/x) \\le x^2$, the $g \\le f \\le h$ step in your notes${c(sq)}.\n2. Both bounds go to $0$, so by the squeeze theorem the limit is $0$${c(sq)}.\n\n$$\\boxed{0}$$`;
  }

  // Library (retrieval-augmented) answers cite the excerpts they were given.
  if (/library assistant/i.test(system)) {
    const ex = parseExcerpts(system);
    if (/"cards"/.test(q)) {
      const cards = ex.slice(0, 8).map((e) => ({
        front: `What does your note say about ${e.where.split('›').pop().replace(/"/g, '').trim() || 'this topic'}?`,
        back: firstSentences(e.text, 1),
        source: e.n,
      }));
      return JSON.stringify({ cards });
    }
    if (/"questions"/.test(q)) {
      // Every question is built from a line of an excerpt; wrong choices are lines from other excerpts.
      const facts = ex.map((e) => ({ e, f: firstFact(e) })).filter((x) => x.f.length > 24);
      const questions = facts.slice(0, 5).map(({ e, f }, i) => {
        const short = (t) => (t.length <= 100 ? t : t.slice(0, t.lastIndexOf(' ', 100)) + '…');
        const others = facts.filter((x) => x.e !== e).map((x) => short(x.f));
        const choices = [short(f), ...others.slice(i, i + 3), ...others.slice(0, Math.max(0, 3 - others.slice(i, i + 3).length))].slice(0, 4);
        const answer = i % choices.length;
        [choices[0], choices[answer]] = [choices[answer], choices[0]];
        return {
          q: `Which of these is in your notes on ${e.where.split('›').pop().replace(/"/g, '').trim()}?`,
          choices,
          answer,
          explain: f,
          source: e.n,
        };
      });
      return JSON.stringify({ questions: questions.filter((x) => x.choices.length >= 2) });
    }
    if (!ex.length) return 'NOT IN NOTES: anything about this';
    const qWords = new Set(words(q));
    const scored = ex.map((e) => ({ e, s: words(e.text + ' ' + e.where).filter((w) => qWords.has(w)).length })).sort((a, b) => b.s - a.s);
    if (!scored[0].s) return `NOT IN NOTES: ${q.split('\n\n')[0]}`;
    const [a, b] = scored;
    let out = `According to your notes, ${firstSentences(a.e.text, 2).replace(/^./, (c) => c.toLowerCase())} [${a.e.n}]`;
    if (b && b.s) out += `\n\nYour notes also mention: ${firstSentences(b.e.text, 1)} [${b.e.n}]`;
    if (/squeeze/i.test(q))
      out += '\n\n$$\\lim_{x \\to 0} \\frac{\\sin x}{x} = 1$$\n\nThe professor flagged this as one that **will be on the exam** [' + a.e.n + '].';
    // A deliberate slip (a cited sentence the notes don't say), so tests can see it contained.
    if (/who (discovered|invented|proved)/i.test(q)) out += `\n\nIt was first proved by Archimedes in 250 BC [${a.e.n}].\n\nNOT IN NOTES: who discovered it`;
    return out;
  }

  if (/Act as a tutor/i.test(q)) {
    return "You're finding $\\lim_{x \\to 3} \\frac{x^2-9}{x-3}$.\n\n✓ Factoring the numerator as $(x-3)(x+3)$ is exactly right, and cancelling $(x-3)$ is allowed because $x \\neq 3$ while taking the limit.\n\n**Hint:** you're left with $\\lim_{x \\to 3}(x+3)$. This expression is a polynomial — it's continuous everywhere. What does that let you do with $x = 3$?\n\nTry it and tell me what you get.";
  }
  if (/Check the student's work step by step/i.test(q)) {
    return '1. $\\frac{x^2-9}{x-3}$ → $\\frac{(x-3)(x+3)}{x-3}$ ✓ — difference of squares.\n2. Cancel $(x-3)$ ✓ — valid because $x \\neq 3$ inside the limit.\n3. $\\lim_{x\\to3}(x+3)$ ✓ — not finished yet.\n\n**Verdict:** everything so far is correct — just substitute $x=3$.';
  }
  if (/Solve the problem completely/i.test(q)) {
    return '1. Factor: $x^2 - 9 = (x-3)(x+3)$.\n2. Cancel the common factor (valid since $x \\neq 3$): $$\\lim_{x \\to 3} \\frac{(x-3)(x+3)}{x-3} = \\lim_{x \\to 3} (x+3)$$\n3. $(x+3)$ is continuous, so substitute: $3 + 3 = 6$.\n\n$$\\boxed{6}$$\n\n**Key idea:** factor and cancel to remove a removable discontinuity, then use direct substitution.';
  }

  const title = /<note title="([^"]*)"/.exec(system)?.[1] ?? 'this note';
  if (/Explain this|Explain the key ideas|Explain this passage/i.test(q)) {
    return `Here's the idea in plain words, based on **${title}**:\n\n- A **limit** describes what $f(x)$ gets close to as $x$ approaches a value — not what happens *at* that value.\n- That's why $\\frac{x^2-9}{x-3}$ can have a limit at $x=3$ even though it's undefined there.\n\n**Tiny example:** $\\lim_{x\\to 2} (3x+1) = 7$, because $3x+1$ gets as close to $7$ as you like when $x$ is near $2$.`;
  }
  if (/Quiz me/i.test(q)) return `Let's start. **Question 1:** in your own words, what does $\\lim_{x \\to a} f(x) = L$ mean?`;
  if (/Summari[sz]e/i.test(q))
    return `- **Limits** describe behaviour near a point.\n- **Limit laws** let you split sums, products and quotients.\n- **Squeeze theorem:** trap $f$ between two functions with the same limit.\n- $\\lim_{x\\to0} \\frac{\\sin x}{x} = 1$ — expected on the exam.\n- **Continuity** needs $f(a)$ defined, the limit to exist, and the two to match.`;
  return `Good question. From **${title}**: the key fact is $\\lim_{x \\to 0} \\frac{\\sin x}{x} = 1$, which follows from the squeeze theorem. Want me to walk through the unit-circle argument step by step?`;
}

// ------------------------------------------------------------------ server

function tokens(text) {
  return text.match(/\S+\s*|\s+/g) ?? [];
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        resolve({});
      }
    });
  });
}

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
}

function json(res, obj, status = 200) {
  cors(res);
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (req.method === 'OPTIONS') {
    cors(res);
    res.writeHead(204);
    return res.end();
  }
  const log = (extra = '') => process.env.MOCK_QUIET || console.log(`${req.method} ${url.pathname} ${extra}`);

  if (url.pathname === '/__mock') {
    if (req.method === 'POST') Object.assign(faults, await readBody(req));
    return json(res, { faults, stats });
  }

  // --- Ollama
  if (url.pathname === '/api/tags') {
    log();
    return json(res, {
      models: MODELS.map((m) => ({
        name: m.name,
        model: m.name,
        size: 4_000_000_000,
        details: { family: m.family, families: [m.family], parameter_size: m.params },
      })),
    });
  }
  if (url.pathname === '/api/show') {
    const body = await readBody(req);
    const m = MODELS.find((x) => x.name === body.model || x.name === body.name);
    log(body.model);
    if (!m) return json(res, { error: 'model not found' }, 404);
    return json(res, { capabilities: m.caps, details: { family: m.family } });
  }
  if (url.pathname === '/api/embed' || url.pathname === '/api/embeddings') {
    const body = await readBody(req);
    const input = body.input ?? body.prompt;
    const list = Array.isArray(input) ? input : [input];
    log(`${list.length} input(s)`);
    if (url.pathname === '/api/embeddings') return json(res, { embedding: embed(String(list[0])) });
    return json(res, { model: body.model, embeddings: list.map((t) => embed(String(t))) });
  }
  if (url.pathname === '/api/chat') {
    const body = await readBody(req);
    const m = MODELS.find((x) => x.name === body.model);
    log(`${body.model} ${body.messages?.length} msgs${body.messages?.some((x) => x.images?.length) ? ' +image' : ''}`);
    if (!m) return json(res, { error: `model "${body.model}" not found, try pulling it first` }, 404);
    if (body.messages?.some((x) => x.images?.length) && !m.caps.includes('vision')) return json(res, { error: 'model does not support images' }, 400);
    stats.chat++;
    record(body.messages ?? []);
    if (faults.fail > 0) {
      faults.fail--;
      stats.failed++;
      return json(res, { error: 'server busy, try again' }, faults.status);
    }
    let text = reply(body.messages ?? []);
    let reason = 'stop';
    if (faults.truncate > 0) {
      faults.truncate--;
      text = text.slice(0, Math.max(40, Math.floor(text.length / 2)));
      reason = 'length';
    }
    cors(res);
    res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
    if (faults.firstTokenMs) {
      await sleep(faults.firstTokenMs);
      faults.firstTokenMs = 0;
    }
    if (m.caps.includes('thinking')) {
      for (const t of tokens('The student wants a grounded answer. Let me look at the relevant part of the notes first.')) {
        res.write(JSON.stringify({ model: m.name, message: { role: 'assistant', content: '', thinking: t }, done: false }) + '\n');
        await sleep(DELAY);
      }
    }
    for (const t of tokens(text)) {
      res.write(JSON.stringify({ model: m.name, message: { role: 'assistant', content: t }, done: false }) + '\n');
      await sleep(DELAY);
    }
    res.end(
      JSON.stringify({
        model: m.name,
        message: { role: 'assistant', content: '' },
        done: true,
        done_reason: reason,
        eval_count: tokens(text).length,
        eval_duration: tokens(text).length * DELAY * 1e6,
      }) + '\n',
    );
    return;
  }

  // --- OpenAI-compatible
  if (url.pathname === '/v1/models') {
    log();
    return json(res, {
      object: 'list',
      data: MODELS.map((m) => ({ id: m.name, object: 'model', type: m.caps.includes('vision') ? 'vlm' : m.caps.includes('embedding') ? 'embeddings' : 'llm' })),
    });
  }
  if (url.pathname === '/v1/embeddings') {
    const body = await readBody(req);
    const list = Array.isArray(body.input) ? body.input : [body.input];
    log(`${list.length} input(s)`);
    return json(res, { object: 'list', data: list.map((t, index) => ({ object: 'embedding', index, embedding: embed(String(t)) })) });
  }
  if (url.pathname === '/v1/chat/completions') {
    const body = await readBody(req);
    const msgs = (body.messages ?? []).map((m) => ({
      role: m.role,
      content: Array.isArray(m.content)
        ? m.content
            .filter((p) => p.type === 'text')
            .map((p) => p.text)
            .join('\n')
        : m.content,
      images: Array.isArray(m.content) ? m.content.filter((p) => p.type === 'image_url').map((p) => p.image_url.url.split(',')[1]) : undefined,
    }));
    log(`${body.model} ${msgs.length} msgs`);
    stats.chat++;
    record(msgs);
    if (faults.fail > 0) {
      faults.fail--;
      stats.failed++;
      return json(res, { error: { message: 'server busy, try again' } }, faults.status);
    }
    let text = reply(msgs);
    let reason = 'stop';
    if (faults.truncate > 0) {
      faults.truncate--;
      text = text.slice(0, Math.max(40, Math.floor(text.length / 2)));
      reason = 'length';
    }
    cors(res);
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    for (const t of tokens(text)) {
      res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: t } }] })}\n\n`);
      await sleep(DELAY);
    }
    res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: reason }] })}\n\n`);
    res.write('data: [DONE]\n\n');
    return res.end();
  }

  json(res, { error: 'not found' }, 404);
});

server.listen(PORT, '127.0.0.1', () => console.log(`mock LLM server on http://localhost:${PORT} (Ollama /api + OpenAI /v1)`));
