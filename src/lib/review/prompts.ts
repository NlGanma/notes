/**
 * The Mastery Engine's prompts. Every task gets one passage of the student's
 * notes and returns JSON that the app checks against that passage; the model
 * never writes an answer key, a fact or "your notes say" — those are always
 * cut from the note itself.
 */

export const MASTERY_ENGINE_PROMPT = `You are Nib's Mastery Engine. You help a student master THEIR OWN class notes through retrieval practice: they answer from memory and are checked against their notes.
Rules you always follow:
1. The excerpt from the student's notes is the only source of truth. Every idea, question, key point and hint must come from it. Never add facts, numbers, names, examples or formulas that are not in it, even true ones.
2. Work on one idea at a time.
3. Never put the answer in a question or a hint.
4. When asked to copy words from the excerpt, copy them exactly. Do not reword.
5. Write in the language the excerpt uses for this idea.
6. If the excerpt does not contain enough to do the task, reply {"skip": true}.
7. Reply with JSON only, in exactly the shape asked for.`;

export interface ExcerptForTask {
  n: number;
  where: string;
  text: string;
}

const block = (e: ExcerptForTask) => `[${e.n}] (${e.where})\n"""\n${e.text}\n"""`;

/** Key ideas of passages the rules found little in. */
export function conceptsTask(excerpts: ExcerptForTask[]): string {
  return `Task: concepts
List the key ideas a student should be able to recall from these excerpts.
- Only ideas that are written in the excerpts. Skip headers like the teacher's name or the date.
- At most 4 ideas per excerpt, most important first. Each "name" is 2 to 6 words, in the language the notes use.
- "proof" is the first 6 to 10 words, copied exactly, of the line that states the idea.
- "key" is the word, phrase or formula from that line a student must remember, copied exactly.
Respond with JSON only:
{"concepts":[{"name":"...","source":1,"proof":"...","key":"..."}]}

EXCERPTS:
${excerpts.map(block).join('\n\n')}`;
}

export const LEVEL_HINT = {
  explain: 'ask the student to explain this idea in their own words, as far as the excerpt explains it.',
  apply: (example: string) => `use this example that is written in the excerpt: "${example}". Ask which rule it shows and why, or what its missing part is.`,
  connect: (partner: string) => `ask how it relates to "${partner}", which the excerpt also mentions.`,
};

/** A question phrased by the model (levels 1–3), checked by `validateQuestion`. */
export function questionTask(o: { name: string; level: 'explain' | 'apply' | 'connect'; hint: string; avoid: string[]; excerpt: ExcerptForTask }): string {
  return `Task: question
Write ONE review question about "${o.name}" that the excerpt answers.
Level: ${o.level} — ${o.hint}${o.avoid.length ? `\nDo not repeat these questions: ${o.avoid.map((q) => `"${q}"`).join(' | ')}` : ''}
- The answer must be stated in the excerpt. Do not put the answer in the question.
- "proof": the first 6 to 10 words, copied exactly, of the excerpt line that answers it.
- "keyPoints": 1 to 3 short phrases copied from the excerpt that a full answer must contain.
Respond with JSON only:
{"question":"...","proof":"...","keyPoints":["..."]}

EXCERPT ${block(o.excerpt)}`;
}

/** Grading a free answer against verbatim key points (only when code can't decide). */
export function gradeTask(o: { question: string; points: string[]; answer: string }): string {
  return `Task: grade
Grade the student's answer using ONLY the key points from their notes. Ignore spelling slips and wording. Something true that is not in the key points earns nothing and loses nothing.
Question: ${o.question}
Key points (from the student's notes):
${o.points.map((p, i) => `${i + 1}. ${p}`).join('\n')}
Student's answer:
"""
${o.answer}
"""
For each key point: does the student's answer say it?
Respond with JSON only:
{"points":[{"n":1,"hit":"yes|partly|no","quote":"the student's words that say it, or empty"}],"contradicts":"the student's words that contradict a key point, or empty"}`;
}

/** A guiding question after a miss (validated: no answer, nothing new). */
export function nudgeTask(o: { question: string; blanked: string; answer: string }): string {
  return `Task: nudge
The student answered wrong.
Question: ${o.question}
From their notes: "${o.blanked}"
Student's answer: "${o.answer}"
Write ONE short question (at most 20 words) that points them back to their notes so they can find the mistake. Do not give the answer.
Respond with JSON only: {"nudge":"...?"}`;
}

export const SCHEMAS = {
  concepts: {
    type: 'object',
    properties: {
      concepts: {
        type: 'array',
        items: {
          type: 'object',
          properties: { name: { type: 'string' }, source: { type: 'integer' }, proof: { type: 'string' }, key: { type: 'string' } },
          required: ['name', 'source', 'proof'],
        },
      },
    },
    required: ['concepts'],
  },
  question: {
    type: 'object',
    properties: { question: { type: 'string' }, proof: { type: 'string' }, keyPoints: { type: 'array', items: { type: 'string' } } },
    required: ['question', 'proof', 'keyPoints'],
  },
  grade: {
    type: 'object',
    properties: {
      points: {
        type: 'array',
        items: {
          type: 'object',
          properties: { n: { type: 'integer' }, hit: { type: 'string', enum: ['yes', 'partly', 'no'] }, quote: { type: 'string' } },
          required: ['n', 'hit'],
        },
      },
      contradicts: { type: 'string' },
    },
    required: ['points'],
  },
  nudge: { type: 'object', properties: { nudge: { type: 'string' } }, required: ['nudge'] },
} as const;
