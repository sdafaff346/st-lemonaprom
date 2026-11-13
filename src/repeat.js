// Repetition breaker: finds phrases recent replies keep leaning on and retires them for the next reply,
// in the same spirit as Lemona's 「🧹 반복 끊기」 entry but built from this chat.

import { sideGenerate } from './api.js';
import { chatIdentity, cleanText, ctx, extractJson, getMeta, getSettings, guarded, maskNonStory, recentReplies, saveMeta, toast } from './core.js';

const PARTICLES = ['으로', '에게', '한테', '까지', '부터', '처럼', '은', '는', '이', '가', '을', '를', '도', '만', '의', '에', '과', '와', '로'];
const STOP = new Set(
    `그 그는 그가 그의 그를 그녀 그녀는 그녀가 그녀의 그녀를 그들 이 저 것 수 듯 때 더 좀 안 못 또 다시 다 잘 왜 뭐 네 응 아 어 음 그래 그냥 정말 너무 아주 조금 이미 아직 그리고 하지만 그런데 그러나 그래서 있었다 없었다 했다 했고 하는 하고 있는 있던 없는 같은 같았다 같이 위해 대해 통해 보다 보며 듯이 것이다 것이었다 거였다 말했다 물었다 대답했다 the a an and or of to in is was he she it`.split(/\s+/),
);

function normalizeToken(tok) {
    let t = tok;
    for (const p of PARTICLES) {
        if (t.length > p.length + 1 && t.endsWith(p)) {
            t = t.slice(0, -p.length);
            break;
        }
    }
    return t.toLowerCase();
}

function tokensOf(text) {
    return [...maskNonStory(text).matchAll(/[\p{L}\p{N}]+/gu)].map(m => ({ raw: m[0], norm: normalizeToken(m[0]) }));
}

function firstSentence(text) {
    const s = maskNonStory(text).trim().split(/(?<=[.!?…。])\s|\n/)[0] ?? '';
    return s.trim();
}

/**
 * Local, free detection over the last N replies.
 * @returns {{ phrase:string, count:number, kind:'phrase'|'opening' }[]}
 */
export function detectRepeats() {
    const s = getSettings();
    const replies = recentReplies(Number(s.repeat_window) || 6);
    if (replies.length < 3) return [];
    const minCount = Math.min(Number(s.repeat_min_count) || 3, replies.length);
    const c = ctx();
    const names = new Set([c.name1, c.name2].filter(Boolean).flatMap(n => String(n).split(/\s+/)).map(n => n.toLowerCase()));
    const isContent = t => t.norm.length >= 2 && !STOP.has(t.norm) && !names.has(t.norm);

    const df = new Map(); // key -> { count, sample }
    for (const r of replies) {
        const toks = tokensOf(r.text);
        const seen = new Set();
        for (let n = 2; n <= 4; n++) {
            for (let i = 0; i + n <= toks.length; i++) {
                const win = toks.slice(i, i + n);
                if (win.filter(isContent).length < 2) continue;
                if (!isContent(win[0]) && !isContent(win[n - 1])) continue;
                const key = win.map(t => t.norm).join(' ');
                if (seen.has(key)) continue;
                seen.add(key);
                const e = df.get(key) ?? { count: 0, sample: win.map(t => t.raw).join(' '), n };
                e.count++;
                df.set(key, e);
            }
        }
    }
    const frequent = new Set([...df.entries()].filter(([, e]) => e.count >= minCount).map(([k]) => k));

    // merge overlapping frequent n-grams into maximal runs, so one repeated sentence is reported once
    const runs = new Map(); // normalized run -> { sample, replies:Set }
    replies.forEach((r, ri) => {
        const toks = tokensOf(r.text);
        const covered = new Array(toks.length).fill(false);
        for (let n = 2; n <= 4; n++) {
            for (let i = 0; i + n <= toks.length; i++) {
                if (frequent.has(toks.slice(i, i + n).map(t => t.norm).join(' '))) covered.fill(true, i, i + n);
            }
        }
        for (let i = 0; i < toks.length; ) {
            if (!covered[i]) {
                i++;
                continue;
            }
            let j = i;
            while (j < toks.length && covered[j]) j++;
            const span = toks.slice(i, Math.min(j, i + 8));
            const key = span.map(t => t.norm).join(' ');
            const e = runs.get(key) ?? { sample: span.map(t => t.raw).join(' ') + (j - i > 8 ? ' …' : ''), replies: new Set() };
            e.replies.add(ri);
            runs.set(key, e);
            i = j;
        }
    });
    let found = [...runs.entries()].map(([key, e]) => ({ key, sample: e.sample, count: e.replies.size })).filter(e => e.count >= minCount);
    found = found.filter(a => !found.some(b => b !== a && b.key.length > a.key.length && b.count >= a.count && b.key.includes(a.key)));
    found.sort((a, b) => b.count - a.count || b.key.length - a.key.length);

    const out = found.map(e => ({ phrase: e.sample, count: e.count, kind: 'phrase' }));

    // repeated openings: same first two content words
    const openings = new Map();
    for (const r of replies) {
        const toks = tokensOf(firstSentence(r.text)).filter(isContent).slice(0, 2);
        if (toks.length < 2) continue;
        const key = toks.map(t => t.norm).join(' ');
        const e = openings.get(key) ?? { count: 0, sample: firstSentence(r.text).slice(0, 40) };
        e.count++;
        openings.set(key, e);
    }
    for (const [, e] of openings) if (e.count >= minCount) out.unshift({ phrase: e.sample, count: e.count, kind: 'opening' });

    return out.slice(0, Number(s.repeat_max_items) || 5);
}

// ---------------------------------------------------------------- AI habits (stored per chat)

export function getHabits() {
    const h = getMeta().habits;
    return Array.isArray(h) ? h : [];
}

export function setHabits(list) {
    getMeta().habits = list.slice(0, 5);
    saveMeta();
    document.dispatchEvent(new CustomEvent('lemona:habits'));
}

const HABIT_SYSTEM = [
    'You review a long roleplay written by a novelist and find the habits that recent replies keep leaning on.',
    'A habit is a recurring move, not a single word: a gesture or reaction that keeps coming back (a smirk, a sigh, a hand through the hair), a sentence shape, the way replies open or end, a stock line, a running comparison, the same kind of inner thought.',
    'Only report habits that appear in at least three of the replies. Ignore names, the setting, and facts of the story.',
    'For each habit give: habit (one short English sentence describing the move in general terms, so a writer can avoid it and its nearest variants) and example (a short quote from the replies, in the original language).',
    'Report at most 3, most noticeable first. If there is no clear habit, return an empty list.',
    'Output ONLY one JSON object, no commentary, no code fence: {"habits":[{"habit":"...","example":"..."}]}',
].join('\n');

export async function analyzeHabits() {
    return guarded('habits', async () => {
        const replies = recentReplies(Math.max(6, Number(getSettings().repeat_window) || 6));
        if (replies.length < 3) {
            toast('info', 'AI 답변이 3개 이상 쌓이면 분석할 수 있어요.');
            return [];
        }
        const body = replies.map((r, i) => `<reply n="${i + 1}">\n${maskNonStory(r.text).trim().slice(0, 3000)}\n</reply>`).join('\n\n');
        const pending = toast('info', '최근 답변의 버릇을 찾는 중…', '레모나', { timeOut: 0, extendedTimeOut: 0 });
        const where = chatIdentity();
        try {
            const reply = await sideGenerate(HABIT_SYSTEM, `${body}\n\nOutput the JSON object only.`);
            // Habits are stored per chat: after a switch they would describe the wrong one
            if (chatIdentity() !== where) {
                toast('warning', '그사이 다른 채팅으로 옮겨서 결과를 버렸어요. 그 채팅으로 돌아가서 다시 눌러 주세요.', '레모나', { timeOut: 9000 });
                return [];
            }
            const parsed = extractJson(reply);
            const habits = (Array.isArray(parsed?.habits) ? parsed.habits : [])
                .map(h => ({ habit: cleanText(h?.habit, 200), example: cleanText(h?.example, 80) }))
                .filter(h => h.habit);
            setHabits(habits);
            toast(habits.length ? 'success' : 'info', habits.length ? `버릇 ${habits.length}개를 찾았어요. 다음 답변부터 피하게 할게요.` : '뚜렷한 버릇이 없어요.');
            return habits;
        } finally {
            toastr.clear(pending);
        }
    });
}

// ---------------------------------------------------------------- prompt

export function buildBreakerNote(repeats, habits) {
    if (!repeats.length && !habits.length) return '';
    const lines = ['[Note for this reply only: recent replies in this chat keep leaning on the items below, and they are retired for now.'];
    let n = 1;
    for (const h of habits) lines.push(`${n++}. ${h.habit}${h.example ? ` (e.g. "${h.example}")` : ''}`);
    const phrases = repeats.filter(r => r.kind === 'phrase').map(r => `"${r.phrase}"`);
    if (phrases.length) lines.push(`${n++}. These exact wordings: ${phrases.join(', ')}.`);
    const opening = repeats.find(r => r.kind === 'opening');
    if (opening) lines.push(`${n++}. Opening the reply the same way as before (e.g. "${opening.phrase}").`);
    lines.push(
        'For this reply:',
        '- Do not write these in any wording, and do not swap in their nearest cousin.',
        '- Do not overcorrect either: the story beat behind a habit can still happen, shown in a fresh way, or left out if it does not matter here.',
        '- Never mention or hint that anything is being avoided.]',
    );
    return lines.join('\n');
}
