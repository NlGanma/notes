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
const faults = { fail: 0, status: 503, truncate: 0, firstTokenMs: 0 };
const stats = { chat: 0, failed: 0 };

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
  const re = /\[(\d+)\] \(([^)]*)\)\n([\s\S]*?)(?=\n\n\[\d+\] \(|$)/g;
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
      return `Your notes don't cover L'Hôpital's rule — Lecture 4 only covers limit laws, the squeeze theorem and continuity.\n\nWhat your notes do give you here: the limit laws${c(laws)} and the squeeze theorem${c(sq)}.\n\n:::outside\n**L'Hôpital's rule:** if $\\lim f = \\lim g = 0$, then $\\lim \\frac{f}{g} = \\lim \\frac{f'}{g'}$. Here $\\lim_{x \\to 0} \\frac{1-\\cos x}{x^2} = \\lim_{x \\to 0} \\frac{\\sin x}{2x} = \\frac{1}{2}$.\n:::\n\nAsk your teacher whether you're expected to use it yet.`;
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
      return JSON.stringify({
        questions: [
          {
            q: 'According to the squeeze theorem, if $g(x) \\le f(x) \\le h(x)$ and $\\lim g = \\lim h = L$, then…',
            choices: ['$\\lim f$ does not exist', '$\\lim f = L$', '$\\lim f = 0$', '$f$ is continuous'],
            answer: 1,
            explain: 'The function is "squeezed" between two functions with the same limit, so it shares that limit.',
            source: ex[0]?.n ?? 1,
          },
          {
            q: 'What is $\\lim_{x \\to 0} \\frac{\\sin x}{x}$?',
            choices: ['$0$', '$\\infty$', '$1$', 'It does not exist'],
            answer: 2,
            explain: 'This classic limit equals 1; your notes say to know the unit-circle proof.',
            source: ex[1]?.n ?? 1,
          },
          {
            q: 'Which organelle is the site of cellular respiration?',
            choices: ['Golgi apparatus', 'Ribosome', 'Lysosome', 'Mitochondrion'],
            answer: 3,
            explain: 'Mitochondria carry out cellular respiration and make ATP.',
            source: ex[2]?.n ?? 1,
          },
        ],
      });
    }
    if (!ex.length) return "I couldn't find that in your notes.";
    const qWords = new Set(words(q));
    const scored = ex.map((e) => ({ e, s: words(e.text + ' ' + e.where).filter((w) => qWords.has(w)).length })).sort((a, b) => b.s - a.s);
    if (!scored[0].s)
      return `I couldn't find that in your notes. They do cover ${ex
        .slice(0, 2)
        .map((e) => e.where.split('›').pop().trim())
        .join(' and ')}.`;
    const [a, b] = scored;
    let out = `According to your notes, ${firstSentences(a.e.text, 2).replace(/^./, (c) => c.toLowerCase())} [${a.e.n}]`;
    if (b && b.s) out += `\n\nYour notes also mention: ${firstSentences(b.e.text, 1)} [${b.e.n}]`;
    if (/squeeze/i.test(q))
      out += '\n\n$$\\lim_{x \\to 0} \\frac{\\sin x}{x} = 1$$\n\nThe professor flagged this as one that **will be on the exam** [' + a.e.n + '].';
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
