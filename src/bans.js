// Ban-list checker: parses Lemona's 「🚫 금지단어」 entry, scans replies, highlights hits and fixes them via the side API.

import { sideGenerate } from './api.js';
import { ctx, esc, extractJson, getSettings, guarded, isInFlight, LOG, maskNonStory, toast } from './core.js';
import { DEFAULT_BAN_TEXT } from './bans-default.js';
import { isActive, presetLanguage, presetPromptContent } from './preset.js';

const PARTICLES = ['으로', '이나', '이랑', '처럼', '에게', '한테', '까지', '부터', '은', '는', '이', '가', '을', '를', '도', '만', '의', '에', '과', '와', '로', '나', '랑'];
const EXACT_ONLY = new Set(['이기', '몰루']); // would collide with ordinary words when particles are stripped
const TOKEN_RE = /[\p{L}\p{N}]+/gu;
const RESTRAINED_CONT = /^(?:$|[하한히함해했스적이은는을를의에도만과와로으되된롭게])/;

// ---------------------------------------------------------------- parsing

function cleanItem(s) {
    return s
        .replace(/\([^)]*\)/g, '')
        .replace(/\s+about a person\.?$/i, '')
        .replace(/[.\s]+$/g, '')
        .trim();
}

function splitList(s) {
    return String(s ?? '')
        .split(/[,/]/)
        .map(cleanItem)
        .filter(Boolean);
}

function afterColon(line) {
    const i = line.indexOf(':');
    return i === -1 ? '' : line.slice(i + 1);
}

/** Root used for prefix matching: 서늘한 → 서늘, 맹렬하게 → 맹렬, 원초적인 → 원초적, 축적된 → 축적. */
export function stemOf(word) {
    const w = word.trim();
    const rules = [
        [/적인$/, '적'],
        [/스러워$/, ''],
        [/스러운$/, ''],
        [/스러$/, ''],
        [/하게$/, ''],
        [/하는$/, ''],
        [/리는$/, ''],
        [/한$/, ''],
        [/된$/, ''],
        [/해$/, ''],
        [/의$/, ''],
    ];
    for (const [re, rep] of rules) {
        if (re.test(w)) {
            const s = w.replace(re, rep);
            if (s.length >= 2) return s;
        }
    }
    return w;
}

/**
 * @returns {{ roots:string[], exact:string[], slang:string[], possessive:string[], restrained:string[], raw:string }}
 */
export function parseBanList(text) {
    const lines = String(text ?? '').split('\n').map(l => l.trim());
    const res = { roots: [], exact: [], slang: [], possessive: [], restrained: [], notes: {}, raw: String(text ?? '') };
    const absRoots = [];
    const absExact = [];
    let inRestrained = false;
    let inAbsolute = false;
    let absHead = '';
    for (let i = 0; i < lines.length; i++) {
        const l = lines[i];
        if (/^#\s*RESTRAINED/i.test(l)) {
            inRestrained = true;
            continue;
        }
        // v8.0.2: "# ABSOLUTE BANS" with one "## word" block per ban
        if (/^#\s*ABSOLUTE/i.test(l)) {
            inAbsolute = true;
            inRestrained = false;
            continue;
        }
        if (inAbsolute && /^##\s+/.test(l)) {
            absHead = l.replace(/^##\s+/, '').trim();
            continue;
        }
        if (/^#(?!#)/.test(l)) {
            inRestrained = false;
            inAbsolute = false;
        }
        if (inAbsolute && absHead) {
            const forms = l.match(/covers every form:\s*(.+)$/i)?.[1];
            const spellings = l.match(/^-\s*Never write\s+(.+?)(?:,?\s+or any other spelling|\s+in narration|$)/i)?.[1];
            const swaps = /do not swap in/i.test(l) ? l.match(/\(([^)]*,[^)]*)\)/)?.[1] : null;
            if (forms) {
                absRoots.push(absHead.includes(' ') ? stemOf(absHead) : absHead);
                for (const f of splitList(forms)) absRoots.push(stemOf(f.replace(/(?<=..)다$/, '')));
            }
            if (spellings) for (const w of splitList(spellings.replace(/\bor\s+/g, ''))) absExact.push([w, '절대 금지']);
            if (swaps) for (const w of splitList(swaps).filter(x => /^[가-힣]+$/.test(x))) absExact.push([w, `「${absHead}」 대신 쓰는 말도 금지`]);
            continue;
        }
        if (/^A\./.test(l)) {
            const tail = afterColon(l);
            const listLine = tail.includes(',') ? tail : lines.slice(i + 1).find(x => x.includes(','));
            res.roots = [...new Set(splitList(listLine).map(stemOf))];
        } else if (/^B\./.test(l)) res.exact = splitList(afterColon(l));
        else if (/^C\./.test(l)) res.slang = splitList(afterColon(l));
        else if (/^D\./.test(l)) res.possessive = splitList(afterColon(l));
        else if (inRestrained && l.includes(',') && !/^Only when/i.test(l)) {
            res.restrained = [...new Set(splitList(l).map(stemOf))];
            inRestrained = false;
        }
    }
    // A root that another root already covers (서늘 ⊃ 서늘하) adds nothing; 서느렇다 still adds 서느렇
    for (const r of absRoots) if (r && !res.roots.some(x => r.startsWith(x))) res.roots.push(r);
    for (const [w, note] of absExact) {
        if (!res.exact.includes(w)) res.exact.push(w);
        res.notes[w] = note;
    }
    return res;
}

let cache = { text: null, rules: null };
export function getRules() {
    const live = presetPromptContent('lm_bans', '금지단어');
    const text = live && /BANNED WORDS/i.test(live) ? live : DEFAULT_BAN_TEXT;
    if (cache.text !== text) cache = { text, rules: parseBanList(text) };
    return cache.rules;
}

// ---------------------------------------------------------------- scanning

function stripParticle(tok) {
    for (const p of PARTICLES) if (tok.length > p.length && tok.endsWith(p)) return tok.slice(0, -p.length);
    return tok;
}

/**
 * Word-level hits in a plain string.
 * @returns {{type:'root'|'exact'|'slang'|'possessive'|'restrained', word:string, index:number, length:number}[]}
 */
// A possessive is only worth flagging when it claims a person: "넌 내 거야", "그녀는 나의 것이다", "You're mine".
// "내 거실", "그건 내 거야" (an object) and "a friend of mine" are left alone.
const KO_PERSON = /(?:^|[^가-힣])(?:너|넌|널|네가|니가|너는|너를|당신|당신은|당신을|그대|그녀|그녀는|그녀를|그는|그를|이 여자|이 남자|그 여자|그 남자|이 사람|그 사람)(?![가-힣]{2})/;
const KO_THING = /(?:^|[^가-힣])(?:그건|그거|이건|이거|저건|저거|그것|이것|저것)(?:은|도|만|까지)?(?![가-힣])/;
// What may follow the phrase: nothing, or an ending (야, 다, 이야, 이다, 라고, 잖아, 지, 니까, 예요, 이에요, 요, 란, 인데, 로, 으로, 이니까, 이었, 였…)
const KO_AFTER = /^(?:$|[^가-힣]|(?:이)?(?:야|다|라|란|잖|지|니|예|에요|요|었|였|고|든|던|면|인|일|로|으로|라는|란다|거든|구나)|이)/;
const EN_PERSON = /\b(?:you|you're|youre|she|she's|he|he's|her|him)\b/i;

function sentenceAround(text, i, len) {
    const stop = /[.!?…\n"“”「」『』]/;
    let a = i;
    while (a > 0 && !stop.test(text[a - 1])) a--;
    let b = i + len;
    while (b < text.length && !stop.test(text[b])) b++;
    return { before: text.slice(a, i), after: text.slice(i + len, b) };
}

function possessiveHits(text, list) {
    const out = [];
    let userName = '';
    try {
        userName = String(ctx().name1 ?? '').trim();
    } catch { /* no context outside SillyTavern */ }
    for (const w of list ?? []) {
        const english = /^[a-z ]+$/i.test(w);
        const parts = w.trim().split(/\s+/).map(x => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
        const re = new RegExp(english ? `\\b${parts.join('\\s+')}\\b` : parts.join('\\s*'), english ? 'gi' : 'g');
        for (const m of text.matchAll(re)) {
            const at = m.index;
            const { before, after } = sentenceAround(text, at, m[0].length);
            const prev = text[at - 1] ?? '';
            if (english) {
                // "mine" claims someone only at the end of its clause with a person in it; "of mine" is ordinary
                if (/\bof\s+$/i.test(before) || !/^\s*(?:[,.!?…"”]|$|\s+(?:now|forever|alone|and)\b)/i.test(after)) continue;
                if (!EN_PERSON.test(before) && !(userName && before.includes(userName))) continue;
            } else {
                if (/[가-힣]/.test(prev)) continue; // 내내 거실: the phrase starts inside another word
                if (!KO_AFTER.test(after)) continue; // 내 거실, 내 것들
                const near = before.slice(-24);
                if (KO_THING.test(near)) continue;
                if (!KO_PERSON.test(near) && !(userName && near.includes(userName))) continue;
            }
            out.push({ type: 'possessive', word: w, index: at, length: m[0].length });
        }
    }
    return out;
}

export function findWords(text, rules = getRules()) {
    const hits = [];
    const lower = text.toLowerCase();
    // token-based: roots, restrained (prefix at token start), slang (whole token)
    for (const m of text.matchAll(TOKEN_RE)) {
        const tok = m[0];
        const at = m.index;
        const root = rules.roots.find(r => tok.startsWith(r));
        if (root) {
            hits.push({ type: 'root', word: root, index: at, length: tok.length });
            continue;
        }
        const slang = rules.slang.find(w => /^[\p{L}\p{N}]+$/u.test(w) && (tok === w || (!EXACT_ONLY.has(w) && stripParticle(tok) === w)));
        if (slang) {
            hits.push({ type: 'slang', word: slang, index: at, length: tok.length });
            continue;
        }
        // restrained words are ordinary vocabulary, so the stem must be followed by an ending, not another noun (고등 ≠ 고등학교)
        const res = rules.restrained.find(r => tok.startsWith(r) && (r.length >= 2 ? RESTRAINED_CONT.test(tok.slice(r.length)) : tok === r || stripParticle(tok) === r));
        if (res) hits.push({ type: 'restrained', word: res, index: at, length: tok.length });
    }
    // substring-based: exact phrases, multi-word / symbol slang and possessives
    const substr = (list, type, filter) => {
        for (const w of list) {
            if (!filter(w)) continue;
            const needle = w.toLowerCase();
            let i = lower.indexOf(needle);
            while (i !== -1) {
                if (!hits.some(h => i >= h.index && i < h.index + h.length)) hits.push({ type, word: w, index: i, length: w.length });
                i = lower.indexOf(needle, i + needle.length);
            }
        }
    };
    substr(rules.exact, 'exact', () => true);
    substr(rules.slang, 'slang', w => !/^[\p{L}\p{N}]+$/u.test(w));
    for (const h of possessiveHits(text, rules.possessive)) {
        if (!hits.some(x => h.index < x.index + x.length && x.index < h.index + h.length)) hits.push(h);
    }
    return hits.sort((a, b) => a.index - b.index);
}

/** Sentence ranges over a (masked) text: [{start, end}] */
export function sentenceRanges(text) {
    const out = [];
    const re = /[^\n.!?…。]+(?:[.!?…。]+["'”’」』)\]]*)?/g;
    for (const m of text.matchAll(re)) {
        const raw = m[0];
        const lead = raw.length - raw.trimStart().length;
        const body = raw.trim();
        if (!body) continue;
        out.push({ start: m.index + lead, end: m.index + lead + body.length });
    }
    return out;
}

const EXCLAIM_FREE = 2; // more than this many -라니/-다니 endings in one reply counts as overuse
const EXCLAIM_RE = /(?:라니|다니|하고는)[.!?…]*["'”’]?$/;
const CONTRAST_RE = /[가-힣]+(?:이|가)\s?아니라[,\s]/;
const NOT_BUT_RE = /(?<!\b(?:do|does|did|could|would|should|will|can|may|might|must|shall)\s)\bnot\s+(?:just\s+|only\s+|merely\s+|simply\s+)?(?:[\w'-]+\s+){0,4}?[\w'-]+,?\s+but\s+(?!(?:i|you|he|she|it|we|they|there|then|the|this|that|his|her|their|my|your|our)\b)/i;
const NEGATED_RE = /\b(?:did|was|were|is|are|am|had|has|have|do|does|could|would|should|will|wo|ca|can)n[o']t\b|\b(?:did|was|were|is|are|am|had|has|have|could|would|should|will|can|does|do)\s+not\b|\bnever\s+\w/i;

/**
 * Full scan of one reply.
 * @param {string} mes raw message text
 * @param {string} [prevMes] previous assistant reply (for the "not in consecutive replies" rules)
 */
export function scanReply(mes, prevMes = '') {
    const rules = getRules();
    const masked = maskNonStory(mes);
    const words = findWords(masked, rules);
    const sentences = sentenceRanges(masked);
    const issues = [];

    const prevWords = prevMes ? findWords(maskNonStory(prevMes), rules) : [];
    const prevRestrained = new Set(prevWords.filter(h => h.type === 'restrained').map(h => h.word));
    const seenRestrained = new Set();
    for (const h of words) {
        if (h.type === 'restrained') {
            const over = seenRestrained.size >= 1 && !seenRestrained.has(h.word);
            const repeat = seenRestrained.has(h.word);
            const consecutive = prevRestrained.has(h.word);
            seenRestrained.add(h.word);
            if (!(over || repeat || consecutive)) continue;
            h.note = consecutive ? '직전 답변에도 씀' : '한 답변에 1개까지';
        }
        if (!h.note && rules.notes?.[h.word]) h.note = rules.notes[h.word];
        issues.push({ ...h, text: mes.slice(h.index, h.index + h.length) });
    }

    // structure checks, per sentence
    const exclaims = [];
    let negRun = []; // consecutive English negated sentences sharing an opening word
    const flushNegRun = () => {
        if (negRun.length >= 2) {
            const first = negRun[0];
            const last = negRun[negRun.length - 1];
            issues.push({
                type: 'structure',
                word: 'He did not A. He did not B.',
                note: `부정문 ${negRun.length}문장 연속 (교정 대비 구조)`,
                index: first.start,
                length: last.end - first.start,
                text: mes.slice(first.start, last.end),
            });
        }
        negRun = [];
    };
    for (const r of sentences) {
        const s = masked.slice(r.start, r.end);
        if (CONTRAST_RE.test(s)) issues.push({ type: 'structure', word: 'A가 아니라 B', note: '교정 대비 구조', index: r.start, length: r.end - r.start, text: mes.slice(r.start, r.end) });
        if (NOT_BUT_RE.test(s)) issues.push({ type: 'structure', word: 'not A but B', note: '교정 대비 구조', index: r.start, length: r.end - r.start, text: mes.slice(r.start, r.end) });
        // "He did not A. He did not B. He C." — the ban list names this shape explicitly
        const opener = s.match(/^["'“”‘’(]*([A-Za-z]+)/)?.[1]?.toLowerCase();
        if (opener && NEGATED_RE.test(s)) {
            if (negRun.length && negRun[negRun.length - 1].opener !== opener) flushNegRun();
            negRun.push({ start: r.start, end: r.end, opener });
        } else {
            flushNegRun();
        }
        if (EXCLAIM_RE.test(s)) {
            exclaims.push(r);
        }
    }
    flushNegRun();
    // -라니 / -다니 is a normal Korean exclamation; only flag it when a reply leans on it.
    // The first EXCLAIM_FREE stay, the rest are rewritten.
    if (exclaims.length > EXCLAIM_FREE) {
        for (const r of exclaims.slice(EXCLAIM_FREE)) {
            issues.push({ type: 'structure', word: '-라니/-다니/-하고는', note: `한 답변에 ${exclaims.length}번 (남발)`, index: r.start, length: r.end - r.start, text: mes.slice(r.start, r.end) });
        }
    }
    issues.sort((a, b) => a.index - b.index);
    return { issues, sentences };
}

export const TYPE_LABEL = {
    root: '금지어',
    exact: '금지 구문',
    slang: '비속어',
    possessive: '소유 표현',
    restrained: '제한어',
    structure: '구조',
};

/** Issues the fixer should rewrite (possessive hits are often about objects, so they are only shown). */
export function fixableIssues(issues) {
    return issues.filter(i => i.type !== 'possessive');
}

// ---------------------------------------------------------------- per-message helpers

function previousReplyText(mesId) {
    const { chat } = ctx();
    for (let i = mesId - 1; i >= 0; i--) {
        const m = chat[i];
        if (m && !m.is_user && !m.is_system && m.mes) return m.mes;
    }
    return '';
}

export function scanMessage(mesId) {
    const m = ctx().chat?.[mesId];
    if (!m || m.is_user || m.is_system || !m.mes) return null;
    return scanReply(m.mes, previousReplyText(mesId));
}

/**
 * True when extra.display_text holds something other than the raw message, i.e. another
 * extension (a translator, for instance) decides what the reader sees. ST renders
 * `extra.display_text ?? mes`, so our edits to `mes` would not show up on their own.
 */
/**
 * True while another extension marks this message as still being produced (a background-reply
 * job, say). Rewriting it then would fight whoever is filling it in.
 */
export function stillGenerating(message) {
    return isInFlight(message);
}

export function displayOwnedByOther(mesId) {
    const m = ctx().chat?.[mesId];
    const d = m?.extra?.display_text;
    return typeof d === 'string' && d.length > 0 && d !== m.mes;
}

// ---------------------------------------------------------------- DOM: highlight + badge

function mesElement(mesId) {
    return document.querySelector(`#chat .mes[mesid="${mesId}"]`);
}

function highlightTextNodes(root, rules) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
        acceptNode: n => (n.parentElement?.closest('code, pre, details, .lmc-ban, script, style') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
    });
    const nodes = [];
    for (let n = walker.nextNode(); n; n = walker.nextNode()) nodes.push(n);
    for (const node of nodes) {
        const text = node.nodeValue;
        const hits = findWords(text, rules);
        if (!hits.length) continue;
        const frag = document.createDocumentFragment();
        let pos = 0;
        for (const h of hits) {
            if (h.index < pos) continue;
            frag.append(text.slice(pos, h.index));
            const mark = document.createElement('mark');
            mark.className = `lmc-ban lmc-ban-${h.type}`;
            mark.title = `${TYPE_LABEL[h.type]}: ${h.word}`;
            mark.textContent = text.slice(h.index, h.index + h.length);
            frag.append(mark);
            pos = h.index + h.length;
        }
        frag.append(text.slice(pos));
        node.replaceWith(frag);
    }
}

/** Puts the text back the way ST rendered it: removes our marks (merging the split text nodes). */
function unhighlight(root) {
    const marks = root?.querySelectorAll('mark.lmc-ban') ?? [];
    for (const m of marks) {
        const parent = m.parentNode;
        m.replaceWith(document.createTextNode(m.textContent));
        parent?.normalize();
    }
}

export function decorateMessage(mesId, onOpen) {
    const el = mesElement(mesId);
    if (!el) return;
    el.querySelectorAll('.lmc-ban-badge').forEach(b => b.remove());
    const textEl = el.querySelector('.mes_text');
    const s = getSettings();
    const scan = isActive() && s.bans_enabled ? scanMessage(mesId) : null;
    // Another extension (a translator, say) may own what is on screen via extra.display_text.
    // Highlighting that text would mark the wrong words, so only the badge is shown.
    const wantMarks = !!scan && s.bans_highlight && !displayOwnedByOther(mesId);
    if (!wantMarks) unhighlight(textEl);
    else if (textEl && !textEl.querySelector('.lmc-ban')) highlightTextNodes(textEl, getRules());
    if (!scan?.issues.length) return;

    const counts = {};
    for (const i of scan.issues) counts[i.type] = (counts[i.type] ?? 0) + 1;
    const badge = document.createElement('div');
    badge.className = 'lmc-ban-badge interactable';
    badge.tabIndex = 0;
    badge.setAttribute('role', 'button');
    badge.title = '눌러서 자세히 보기 · 고치기';
    badge.innerHTML =
        '<span class="lmc-ban-badge-dot"></span>' +
        Object.entries(counts)
            .map(([t, n]) => `<span class="lmc-ban-badge-part lmc-ban-${t}">${esc(TYPE_LABEL[t])} <b>${n}</b></span>`)
            .join('');
    badge.addEventListener('click', () => onOpen?.(mesId));
    badge.addEventListener('keydown', e => {
        if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onOpen?.(mesId);
        }
    });
    (textEl ?? el).after(badge);
}

export function decorateRecent(onOpen, limit = 30) {
    const { chat } = ctx();
    const n = chat?.length ?? 0;
    for (let i = Math.max(0, n - limit); i < n; i++) decorateMessage(i, onOpen);
}

// ---------------------------------------------------------------- fixing

/** Language the reply is written in, from the preset (or a guess from the text itself). */
function replyLanguage(text) {
    const lang = presetLanguage();
    if (lang) return lang;
    const hangul = (text.match(/[가-힣]/g) ?? []).length;
    const latin = (text.match(/[A-Za-z]/g) ?? []).length;
    return hangul >= latin ? '한국어' : 'English';
}

function fixSystemPrompt(rulesText, lang) {
    const korean = /한국|korean/i.test(lang);
    return [
        `You are a copy editor for a web novel written in ${korean ? 'Korean' : lang}, by an author with strict style rules.`,
        'You will get the whole reply for context and a numbered list of sentences that break the rules, each with what is wrong.',
        `Rewrite ONLY those sentences so they break none of the rules below. Write the rewritten sentences in ${korean ? 'Korean' : lang}, the language of the reply; never translate.`,
        `- Keep the meaning, the speaker, the point of view, the tense, the tone and register${korean ? ' (존댓말/반말)' : ''}, the narrator's voice, quotation marks and line breaks exactly as they are.`,
        '- Change as little as possible. Do not add or remove story content, and do not touch words that are not part of the problem.',
        '- Use plain, natural words. Never swap in a rare, odd, or wrong word just to avoid a banned one, and never use one fixed substitute.',
        '- A banned root covers all its derived forms, so the replacement must not reuse the root.',
        '- A corrective contrast is rewritten as a direct statement of what is true: "A가 아니라 B" becomes B, "not A but B" becomes B, and a run of negated sentences ("He did not A. He did not B. He C.") becomes the affirmative action or one plain sentence. Keep any joke or attitude the original carried.',
        '',
        'Rules:',
        rulesText,
        '',
        'Output ONLY one JSON object, no commentary, no code fence: {"fixes":[{"i":1,"text":"rewritten sentence"}]}',
    ].join('\n');
}

/** Groups issues by sentence: [{ start, end, text, problems: string[] }] */
function problemSentences(mes, scan) {
    const targets = fixableIssues(scan.issues);
    const out = [];
    for (const r of scan.sentences) {
        const inside = targets.filter(i => i.index < r.end && i.index + i.length > r.start);
        if (!inside.length) continue;
        out.push({
            start: r.start,
            end: r.end,
            text: mes.slice(r.start, r.end),
            problems: [...new Set(inside.map(i => `${TYPE_LABEL[i.type]} "${i.type === 'structure' ? i.word : i.text}"${i.note ? ` (${i.note})` : ''}`))],
        });
    }
    return out;
}

/** Accepts the shapes models actually send: {fixes:[…]}, a bare array, i as a string, text under another key. */
function readFixes(parsed) {
    const list = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.fixes) ? parsed.fixes : Array.isArray(parsed?.sentences) ? parsed.sentences : [];
    const out = new Map();
    list.forEach((f, k) => {
        const i = Number(f?.i ?? f?.index ?? f?.id ?? k + 1) - 1;
        const text = String(f?.text ?? f?.fixed ?? f?.rewrite ?? f?.sentence ?? '').trim();
        if (Number.isInteger(i) && i >= 0 && text) out.set(i, text);
    });
    return out;
}

/** One rewrite round over `text`; returns the new text and how many sentences changed. */
async function fixRound(text, prev, retry) {
    const scan = scanReply(text, prev);
    const targets = problemSentences(text, scan);
    if (!targets.length) return { text, applied: 0, targets: 0 };
    const story = maskNonStory(text).replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim().slice(0, 8000);
    const list = targets.map((t, i) => `${i + 1}. ${t.text}\n   problems: ${t.problems.join('; ')}`).join('\n');
    const again = retry ? '\n\nThese sentences were already rewritten once and still break the rules. Change the flagged words to different, plain words this time; a derived form of a banned root is still banned.' : '';
    const reply = await sideGenerate(fixSystemPrompt(getRules().raw, replyLanguage(story)), `<reply>\n${story}\n</reply>\n\n<sentences_to_fix>\n${list}\n</sentences_to_fix>${again}\n\nOutput the JSON object only.`);
    const byIndex = readFixes(extractJson(reply));
    let out = text;
    let applied = 0;
    for (let k = targets.length - 1; k >= 0; k--) {
        const t = targets[k];
        const next = byIndex.get(k);
        if (!next || next === t.text || out.slice(t.start, t.end) !== t.text) continue;
        out = out.slice(0, t.start) + next + out.slice(t.end);
        applied++;
    }
    return { text: out, applied, targets: targets.length };
}

export async function fixMessage(mesId) {
    return guarded(`fix:${mesId}`, async () => {
        const c = ctx();
        const m = c.chat?.[mesId];
        if (!m) return 0;
        if (stillGenerating(m)) {
            toast('info', '이 답변은 아직 생성 중이에요. 끝난 뒤에 고쳐 주세요.');
            return 0;
        }
        const scan = scanMessage(mesId);
        const first = scan ? problemSentences(m.mes, scan).length : 0;
        if (!first) {
            toast('info', scan?.issues.length ? '소유 표현은 표시만 하고 고치지 않아요. 고칠 문장이 없어요.' : '고칠 문장이 없어요.');
            return 0;
        }
        // The side call takes seconds, and the user may switch chats meanwhile (background-reply
        // extensions make that normal). Writing then would render and save into the wrong chat.
        const chatAtStart = c.getCurrentChatId?.();
        const mesAtStart = m.mes;
        const prev = previousReplyText(mesId);
        const pending = toast('info', `문장 ${first}개 고치는 중…`, '레모나', { timeOut: 0, extendedTimeOut: 0 });
        try {
            // A rewrite sometimes keeps the banned root in another form; one more round on just those
            let mes = m.mes;
            let applied = 0;
            for (let round = 0; round < 2; round++) {
                let r;
                try {
                    r = await fixRound(mes, prev, round > 0);
                } catch (e) {
                    // The retry is a bonus: keep what the first round fixed
                    if (round === 0 || e?.name === 'CancelledError') throw e;
                    console.warn(LOG, 'second fix round failed', e);
                    break;
                }
                mes = r.text;
                applied += r.applied;
                if (!r.targets) break;
                if (c.getCurrentChatId?.() !== chatAtStart || m.mes !== mesAtStart) break;
            }
            if (chatAtStart !== undefined && c.getCurrentChatId?.() !== chatAtStart) {
                toast('warning', '고치는 동안 다른 채팅으로 옮겨서 적용하지 않았어요. 그 채팅으로 돌아가서 다시 눌러 주세요.', '레모나', { timeOut: 10000 });
                return 0;
            }
            if (c.chat?.[mesId] !== m || m.mes !== mesAtStart || stillGenerating(m)) {
                toast('warning', '고치는 동안 메시지가 바뀌어서 적용하지 않았어요. 다시 눌러 주세요.', '레모나', { timeOut: 10000 });
                return 0;
            }
            if (!applied || mes === m.mes) {
                toast('warning', 'AI가 문장을 그대로 돌려줬어요. 다시 눌러 보거나, 보조 API를 다른 모델로 바꿔 보세요.', '레모나', { timeOut: 10000 });
                return 0;
            }
            const owned = displayOwnedByOther(mesId);
            m.extra ??= {};
            m.extra.lemona_original = m.mes;
            // SillyTavern swaps m.extra with the swipe's own copy when swiping; keep the undo there too
            const info = Array.isArray(m.swipe_info) ? m.swipe_info[m.swipe_id ?? 0] : null;
            if (info) {
                info.extra ??= {};
                info.extra.lemona_original = m.mes;
            }
            m.mes = mes;
            if (Array.isArray(m.swipes) && m.swipes[m.swipe_id ?? 0] !== undefined) m.swipes[m.swipe_id ?? 0] = mes;
            // A display_text that was a plain copy of the message is ours to keep in sync;
            // one another extension transformed is left alone and reported instead.
            if (typeof m.extra.display_text === 'string' && !owned) m.extra.display_text = mes;
            c.updateMessageBlock(mesId, m);
            await c.saveChat();
            await c.eventSource.emit(c.event_types.MESSAGE_EDITED, mesId);
            const left = fixableIssues(scanMessage(mesId)?.issues ?? []).length;
            toast(left ? 'warning' : 'success', left ? `고쳤어요. 아직 ${left}개가 남았어요. 한 번 더 누르면 남은 것만 고쳐요.` : `${first}문장을 고쳤어요.`);
            if (owned) toast('info', '다른 확장이 이 메시지의 화면 표시를 맡고 있어요(번역 등). 고친 내용은 저장됐지만, 화면에 보이려면 그 확장을 다시 실행해 주세요.', '레모나', { timeOut: 12000 });
            return applied;
        } finally {
            toastr.clear(pending);
        }
    });
}

export async function undoFix(mesId) {
    const c = ctx();
    const m = c.chat?.[mesId];
    const orig = m?.extra?.lemona_original;
    if (!orig) return false;
    const owned = displayOwnedByOther(mesId);
    m.mes = orig;
    if (Array.isArray(m.swipes) && m.swipes[m.swipe_id ?? 0] !== undefined) m.swipes[m.swipe_id ?? 0] = orig;
    if (typeof m.extra.display_text === 'string' && !owned) m.extra.display_text = orig;
    delete m.extra.lemona_original;
    const info = Array.isArray(m.swipe_info) ? m.swipe_info[m.swipe_id ?? 0] : null;
    if (info?.extra) delete info.extra.lemona_original;
    c.updateMessageBlock(mesId, m);
    await c.saveChat();
    await c.eventSource.emit(c.event_types.MESSAGE_EDITED, mesId);
    console.info(LOG, 'fix undone', mesId);
    return true;
}
