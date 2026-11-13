// Cards that are not one person: 다인봇 (a fixed group), 시뮬봇 (a world with people who come and go),
// RPG봇 (a game-like world). Their reading is a cast of characters (plus, for sim/RPG, the world itself),
// and only the people in the current scene go into the prompt.

import { cleanText, ctx, getSettings, isStoryMessage, LIMITS, maskNonStory, toPercent } from './core.js';

export const KINDS = Object.freeze(['single', 'multi', 'sim', 'rpg']);
export const KIND_LABELS = Object.freeze({ single: '단일 캐릭터', multi: '다인봇', sim: '시뮬봇', rpg: 'RPG봇' });
export const KIND_SHORT = Object.freeze({ single: '단일', multi: '다인', sim: '시뮬', rpg: 'RPG' });

export const MEMBER_FIELDS = Object.freeze([
    { key: 'role', label: '어떤 사람', help: '이야기 속 자리', max: () => LIMITS.role },
    { key: 'surface', label: '보여주는 모습', help: '남들이 보는 행동', max: () => LIMITS.member },
    { key: 'inner', label: '속', help: '진짜 원하는 것과 두려운 것', max: () => LIMITS.member },
    { key: 'voice', label: '말투·버릇', help: '다른 인물과 구별되는 점', max: () => LIMITS.voice },
]);

export function normalizeKind(kind) {
    return KINDS.includes(kind) ? kind : 'single';
}

export function isCastKind(kind) {
    return normalizeKind(kind) !== 'single';
}

export function emptyMember() {
    return { name: '', aliases: [], role: '', surface: '', inner: '', voice: '', pair: null, changed: '' };
}

function normalizeAliases(raw) {
    const list = Array.isArray(raw) ? raw : String(raw ?? '').split(/[,，、/]/);
    return [...new Set(list.map(a => cleanText(a, LIMITS.name)).filter(Boolean))].slice(0, 4);
}

function normalizePair(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const a = cleanText(raw.a, LIMITS.side);
    const b = cleanText(raw.b, LIMITS.side);
    return a && b ? { a, b, lean: toPercent(raw.lean, 50) } : null;
}

export function normalizeCast(raw) {
    const seen = new Set();
    return (Array.isArray(raw) ? raw : [])
        .map(m => ({
            name: cleanText(m?.name, LIMITS.name),
            aliases: normalizeAliases(m?.aliases),
            role: cleanText(m?.role, LIMITS.role),
            surface: cleanText(m?.surface, LIMITS.member),
            inner: cleanText(m?.inner, LIMITS.member),
            voice: cleanText(m?.voice, LIMITS.voice),
            pair: normalizePair(m?.pair),
            changed: cleanText(m?.changed, LIMITS.member),
        }))
        .filter(m => {
            if (!m.name || seen.has(m.name) || !(m.role || m.surface || m.inner || m.voice)) return false;
            seen.add(m.name);
            return true;
        })
        .slice(0, LIMITS.max_cast);
}

export function normalizeWorld(raw) {
    const src = raw && typeof raw === 'object' ? raw : {};
    return { stance: cleanText(src.stance, LIMITS.world), npc_rule: cleanText(src.npc_rule, LIMITS.world) };
}

// ---------------------------------------------------------------- who is in the scene

function escapeRe(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Text of the last `n` story messages (both sides), which is what decides who is "in the scene". */
export function recentSceneText(n = getSettings().cast_scan_messages) {
    const chat = ctx().chat ?? [];
    const picked = [];
    for (let i = chat.length - 1; i >= 0 && picked.length < Math.max(1, Number(n) || 4); i--) {
        const m = chat[i];
        if (!isStoryMessage(m)) continue;
        picked.push(maskNonStory(m.mes));
    }
    return picked.join('\n');
}

function mentioned(member, text) {
    return [member.name, ...member.aliases].some(word => {
        if (!word) return false;
        // Latin names need word edges ("Al" must not match "also"); Korean names attach particles, so plain search
        if (/^[\x20-\x7e]+$/.test(word)) return new RegExp(`(^|[^A-Za-z])${escapeRe(word)}($|[^A-Za-z])`, 'i').test(text);
        // A one-syllable name would match inside any word ("다" in "없다"): it must start a word
        if (word.length === 1) return new RegExp(`(^|[^가-힣])${escapeRe(word)}`).test(text);
        return text.includes(word);
    });
}

/**
 * Splits the cast into who is in the scene now and who is not.
 * A small group (≤ 3) always counts as present; a group nobody mentions falls back to everyone for 다인봇.
 */
export function splitPresent(cast, kind, text = recentSceneText()) {
    if (!getSettings().cast_scene_only || cast.length <= 3) return { present: cast, absent: [] };
    const present = cast.filter(m => mentioned(m, text));
    if (!present.length && kind === 'multi') return { present: cast, absent: [] };
    return { present, absent: cast.filter(m => !present.includes(m)) };
}

// ---------------------------------------------------------------- prompt text

const HEAD = {
    multi: "This card plays a group of characters. Each has their own inner logic below. Keep their wants, fears and voices distinct so they never blend into one temperament; let them disagree, misread each other and pursue their own aims in the same scene.",
    sim: "{{char}} runs a simulated world with many people in it. Below are notes on how that world treats people and on its recurring characters. Every person on screen, named here or not, wants something of their own and acts on it.",
    rpg: "{{char}} runs a game-like world. Below are notes on how that world works and on its recurring characters. NPCs act on their own wants: they help, refuse, bargain or turn on {{user}} for their own reasons, and remember what {{user}} actually did.",
};

function leanWord(a, b, lean) {
    if (lean >= 60) return `leaning toward "${a}"`;
    if (lean <= 40) return `leaning toward "${b}"`;
    return 'torn evenly';
}

function memberLine(m, soft) {
    const parts = [`- ${m.name}${m.role ? ` (${m.role})` : ''}`];
    const bits = [];
    if (!soft && m.surface) bits.push(`Shows: ${m.surface}`);
    if (m.inner) bits.push(`Inside: ${m.inner}`);
    if (!soft && m.voice) bits.push(`Voice: ${m.voice}`);
    if (m.pair) bits.push(`Torn between "${m.pair.a}" and "${m.pair.b}", ${leanWord(m.pair.a, m.pair.b, m.pair.lean)}`);
    if (m.changed) bits.push(`Changed in this story: ${m.changed}`);
    return `${parts[0]}: ${bits.join(' / ')}`;
}

/**
 * @param {any} profile normalized profile with kind multi|sim|rpg
 * @param {{ source?: 'card'|'chat', soft?: boolean, text?: string }} [opts]
 */
export function buildCastPrompt(profile, { source = 'card', soft = false, text } = {}) {
    const kind = normalizeKind(profile.kind);
    const tag = kind === 'multi' ? 'character_insight for="cast"' : 'world_insight';
    const out = [
        `<${tag}>`,
        HEAD[kind],
        source === 'chat'
            ? 'These notes were updated from the chat so far and describe everyone as they are now.'
            : 'These notes come from the card: the baseline everyone started from.',
        'Express them through action, choice, tone and subtext; never state the notes outright or list them as traits.',
        'The story so far outranks these notes. Wherever the chat has already changed someone (a relationship moved, a belief broke, they softened or hardened), keep the change and read the notes as the history underneath it.',
    ];
    if (soft) out.push('This chat has run long and the notes may be out of date: use them only for what people want and fear, and take how they act and talk from the chat itself.');
    const changes = profile.changes ?? [];
    if (changes.length) out.push('', '[How things have changed in this story] Earned through the chat; keep them:', ...changes.map(t => `- ${t}`));
    if (kind !== 'multi') {
        const w = profile.world ?? {};
        const worldLines = [w.stance && `- How the world treats people: ${w.stance}`, w.npc_rule && `- People not listed here: ${w.npc_rule}`].filter(Boolean);
        if (worldLines.length) out.push('', '[World]', ...worldLines);
        if (profile.pairs?.length) {
            out.push('', '[Tensions in the world] Values or sides that pull against each other; the lean is where things stand now.');
            profile.pairs.forEach((p, i) => {
                out.push(`${i + 1}. "${p.a}" vs "${p.b}" — ${leanWord(p.a, p.b, p.lean)} (${p.lean}/100 toward "${p.a}").`);
                if (p.behavior && !soft) out.push(`   Shows as: ${p.behavior}`);
            });
        }
    }
    const cast = profile.cast ?? [];
    if (cast.length) {
        const { present, absent } = splitPresent(cast, kind, text);
        if (present.length) out.push('', kind === 'multi' ? '[The group] Only the parts this scene touches:' : '[People in this scene]', ...present.map(m => memberLine(m, soft)));
        if (absent.length) out.push('', `[Not in this scene] ${absent.map(m => m.name).join(', ')}. Bring them in only if the story does; if it does, keep them as written before.`);
    }
    out.push('', 'Use only what this moment touches; most replies need little of it. These are tendencies, not rules: people may surprise, contradict themselves, act out of mood, or change when the story gives a reason.', `</${tag.split(' ')[0]}>`);
    return out.join('\n');
}

export const CAST_THINK_LINE = '\n- Insight: who in this scene wants what right now, and is anyone facing their own dilemma? Keep each voice distinct, as they are now in this story (what the chat has established beats the notes); if nothing presses, leave it out.';
