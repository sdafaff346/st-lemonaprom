// Modules 1 & 2: two-layer reading and colliding value pairs. Model-facing text is English.

import { sideGenerate } from './api.js';
import { cleanText, ctx, currentCharacter, ensureFullCharacter, extractJson, getMeta, getSettings, LIMITS, maskNonStory, readCharData, saveMeta, toPercent, writeCharData } from './core.js';
import { collectLore } from './lore.js';
import { presetLanguage } from './preset.js';

export const LAYER_FIELDS = Object.freeze([
    { key: 'surface', label: '보여주는 모습', help: '남들이 보는 행동' },
    { key: 'desire', label: '진짜 욕구', help: '속으로 바라는 것' },
    { key: 'fear', label: '두려움·상처', help: '움직이게 만드는 원인' },
    { key: 'self_deception', label: '스스로 믿는 착각', help: '이야기가 흔들 수 있는 믿음' },
]);

const BOT_TYPES = ['original', 'motif', 'korean', 'japanese', 'western'];
const MOODS = ['none', 'slow', 'comedy', 'tense', 'work'];
const FLAGS = ['harsh', 'gentle', 'romcom', 'angst', 'multi_cast', 'foreign_speaker'];

export function emptyPair() {
    return { a: '', b: '', lean: 50, behavior: '', cost: '' };
}

export function emptyRelation() {
    return { who: '', shows: '' };
}

/** {{user}} is the player; a relation entry for them would steer the player's own scenes. */
function isUserName(who) {
    if (/\{\{\s*user\s*\}\}/i.test(who)) return true;
    let name = '';
    try {
        name = String(ctx().name1 ?? '').trim();
    } catch {
        /* no context in tests */
    }
    return !!name && who.trim() === name;
}

function normalizeBasedOn(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const messages = Math.max(0, Math.round(Number(raw.messages) || 0));
    const total = Math.max(messages, Math.round(Number(raw.total) || 0));
    return messages ? { messages, total } : null;
}

function normalizeLoreMeta(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const books = (Array.isArray(raw.books) ? raw.books : []).map(b => cleanText(b, 80)).filter(Boolean).slice(0, 12);
    const used = Math.max(0, Math.round(Number(raw.used) || 0));
    return books.length || used ? { books, used } : null;
}

function normalizeRecommendation(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const rec = {
        bot_type: BOT_TYPES.includes(raw.bot_type) ? raw.bot_type : '',
        mood: MOODS.includes(raw.mood) ? raw.mood : '',
        canon: cleanText(raw.canon, 80),
        reason: cleanText(raw.reason, 300),
    };
    for (const f of FLAGS) if (typeof raw[f] === 'boolean') rec[f] = raw[f];
    return rec;
}

/** Repairs any input (AI output, stored data, editor draft) into a valid profile. */
export function normalizeProfile(raw) {
    const src = raw && typeof raw === 'object' ? raw : {};
    const layersSrc = src.layers && typeof src.layers === 'object' ? src.layers : {};
    const layers = {};
    for (const { key } of LAYER_FIELDS) layers[key] = cleanText(layersSrc[key], LIMITS.layer);
    const pairs = (Array.isArray(src.pairs) ? src.pairs : [])
        .map(p => ({
            a: cleanText(p?.a, LIMITS.side),
            b: cleanText(p?.b, LIMITS.side),
            lean: toPercent(p?.lean, 50),
            behavior: cleanText(p?.behavior, LIMITS.pair_text),
            cost: cleanText(p?.cost, LIMITS.pair_text),
        }))
        .filter(p => p.a && p.b)
        .slice(0, LIMITS.max_pairs);
    const relations = (Array.isArray(src.relations) ? src.relations : [])
        .map(r => ({ who: cleanText(r?.who, LIMITS.who), shows: cleanText(r?.shows, LIMITS.relation) }))
        .filter(r => r.who && r.shows && !isUserName(r.who))
        .slice(0, LIMITS.max_relations);
    const changes = (Array.isArray(src.changes) ? src.changes : [])
        .map(t => cleanText(t, LIMITS.change))
        .filter(Boolean)
        .slice(0, LIMITS.max_changes);
    return {
        layers,
        pairs,
        relations,
        changes,
        based_on: normalizeBasedOn(src.based_on),
        lore: normalizeLoreMeta(src.lore),
        base_crack: toPercent(src.base_crack, 20),
        recommend: normalizeRecommendation(src.recommend ?? src.toggles),
        updated_at: typeof src.updated_at === 'string' ? src.updated_at : '',
    };
}

export function isProfileEmpty(profile) {
    return !profile || (LAYER_FIELDS.every(f => !profile.layers[f.key]) && profile.pairs.length === 0 && (profile.relations?.length ?? 0) === 0 && (profile.changes?.length ?? 0) === 0);
}

export function loadProfile() {
    const raw = readCharData().insight;
    if (!raw) return null;
    const p = normalizeProfile(raw);
    return isProfileEmpty(p) ? null : p;
}

export async function saveProfile(profile) {
    await writeCharData({ insight: { ...normalizeProfile(profile), updated_at: new Date().toISOString() } });
}

export async function deleteProfile() {
    await writeCharData({ insight: null });
}

// ---------------------------------------------------------------- this chat's version
// A long chat can move a character away from the card. The chat version lives in the chat's
// metadata (keyed by character, so it never leaks into another chat) and wins over the card version.

function chatStore() {
    const cur = currentCharacter();
    if (!cur) return null;
    const meta = getMeta();
    meta.insights ??= {};
    return { meta, key: cur.char.avatar || cur.char.name };
}

export function loadChatProfile() {
    const st = chatStore();
    const raw = st?.meta.insights[st.key];
    if (!raw) return null;
    const p = normalizeProfile(raw);
    return isProfileEmpty(p) ? null : p;
}

export function saveChatProfile(profile) {
    const st = chatStore();
    if (!st) return;
    st.meta.insights[st.key] = { ...normalizeProfile(profile), updated_at: new Date().toISOString() };
    saveMeta();
}

export function deleteChatProfile() {
    const st = chatStore();
    if (!st) return;
    delete st.meta.insights[st.key];
    saveMeta();
}

/** AI replies in the open chat, the measure of how far a chat has run. */
export function storyLength() {
    return (ctx().chat ?? []).filter(m => m && !m.is_user && !m.is_system && m.mes).length;
}

/**
 * The version that goes into the prompt: this chat's if there is one, otherwise the card's.
 * @returns {{ profile: any, source: 'chat'|'card' } | null}
 */
export function activeProfile() {
    if (!currentCharacter()) return null;
    const chat = loadChatProfile();
    if (chat) return { profile: chat, source: 'chat' };
    const card = loadProfile();
    return card ? { profile: card, source: 'card' } : null;
}

/** Card version in a chat long enough that it has probably drifted. */
export function isLongChatOnCard(active = activeProfile(), settings = getSettings()) {
    return active?.source === 'card' && storyLength() >= Math.max(1, Number(settings.insight_long_chat) || 40);
}

// ---------------------------------------------------------------- analysis

const LANGUAGE_LINE = {
    ko: 'Write every string value in Korean (한국어). Keep JSON keys and enum values in English exactly as specified.',
    en: 'Write every string value in English.',
    card: "Write every string value in the same language as the character card's main text.",
};

/** The one line telling the analyst which language to answer in. */
function languageLine(settings) {
    if (settings.output_language === 'preset') {
        const lang = presetLanguage();
        if (lang) return `Write every string value in ${lang}, the language this story is narrated in. Keep JSON keys and enum values in English exactly as specified.`;
        return LANGUAGE_LINE.card;
    }
    return LANGUAGE_LINE[settings.output_language] ?? LANGUAGE_LINE.ko;
}

function analysisSystemPrompt(settings) {
    return [
        "You are a character analyst for interactive fiction. Read the character card (and its lorebook, when one is given) and extract the character's inner logic so another writer can keep them consistent yet multi-faceted in situations the card never mentions.",
        '',
        'Principles:',
        '- Do NOT use personality-type labels (MBTI, enneagram, zodiac, "tsundere", etc.) or bare adjectives ("cold", "kind").',
        '- Write each item as an observable behaviour or a concrete motive, e.g. "Calls out anyone who cuts in line, even strangers" instead of "values fairness".',
        '- Connect motives to causes found in the card when the card gives one. If the card is silent, infer the most plausible cause and keep it modest; do not invent major backstory events.',
        '- Prefer tension: the inner layer should explain or contradict the surface layer, not repeat it.',
        '- Keep the character at the intensity the card writes. Do not soften edges (rudeness, selfishness, cruelty) or add kindness the card does not give.',
        '- A <lorebook> holds world-info entries tied to this character. Treat it as part of the card: use it for past events, relationships and world rules that explain the motives. The card wins where the two disagree. Do not summarise the lorebook or copy world facts into the output; use it only to ground the inner logic.',
        '',
        'Produce:',
        '1. layers — the two-layer reading:',
        '   - surface: how the character presents to others (behaviour, manner).',
        '   - desire: what they actually want underneath.',
        '   - fear: the fear or wound that drives them.',
        '   - self_deception: a false belief they hold about themselves that the story could challenge.',
        "2. pairs — 2 or 3 pairs of the character's own values that collide. For each pair:",
        '   - a, b: short names of the two values (1-4 words each).',
        '   - lean: integer 0-100, how strongly they choose a over b by default (100 = always a, 50 = torn).',
        '   - behavior: what they visibly do when the two collide.',
        '   - cost: what follows when they go against their lean (guilt, rationalisation, a habit, a change in tone...).',
        '3. relations — 0 to 3 people from the card or lorebook who change how the two layers show (family, a rival, a former partner...). Only people the character actually has history with; never {{user}}. For each:',
        '   - who: their name as the card writes it.',
        '   - shows: how the surface or the inner layer behaves differently around this person, as behaviour (e.g. "drops the formal speech only with her; the old fear shows as overprotectiveness").',
        '   Leave the array empty when the card and lorebook name nobody like that.',
        '4. base_crack: integer 0-100, how much of the inner layer normally leaks through the surface at the start of a story (0 = perfectly masked, 100 = wears their heart on their sleeve).',
        '5. recommend — which writing-preset switches fit this card:',
        '   - bot_type: "original" (the card\'s own original character), "motif" (inspired by an existing work but not that canon), "korean" / "japanese" / "western" (a fan-work character from an existing Korean / Japanese anime-manga / Western work).',
        '   - canon: the name of the original work for a fan-work character, otherwise "".',
        '   - mood: "none", "slow" (slow-burn flirting), "comedy" (everyday comedy), "tense" (thriller tension) or "work" (case- or job-driven); "none" unless the card clearly sets one.',
        '   - harsh: true if being rude, cruel, selfish or contemptuous is core to them. gentle: true if gentle, courteous kindness is core to them. Never both.',
        '   - romcom: true if the card sets up a romantic-comedy dynamic. angst: true if the card is built on sorrow, loss or tragedy.',
        '   - multi_cast: true if the card plays several characters at once. foreign_speaker: true if the character cannot speak the narration language well.',
        '   - reason: one short sentence explaining the picks.',
        '',
        `Length limits: each layers field under ${LIMITS.layer} characters; a and b under ${LIMITS.side} characters; behavior and cost under ${LIMITS.pair_text} characters; who under ${LIMITS.who} and shows under ${LIMITS.relation} characters.`,
        languageLine(settings),
        '',
        'Output ONLY one JSON object, no commentary, no code fence, in exactly this shape:',
        '{"layers":{"surface":"...","desire":"...","fear":"...","self_deception":"..."},"pairs":[{"a":"...","b":"...","lean":70,"behavior":"...","cost":"..."}],"relations":[{"who":"...","shows":"..."}],"base_crack":20,"recommend":{"bot_type":"original","canon":"","mood":"none","harsh":false,"gentle":false,"romcom":false,"angst":false,"multi_cast":false,"foreign_speaker":false,"reason":"..."}}',
    ].join('\n');
}

function clip(value, max) {
    const s = String(value ?? '').trim();
    return s.length > max ? `${s.slice(0, max)}\n[...truncated]` : s;
}

/** @param {{ onLore?: (lore: {books:string[], used:number, total:number, skipped:number, cut:number}) => void }} [opts] */
export async function analyzeCurrentCharacter({ onLore } = {}) {
    const cur = await ensureFullCharacter();
    if (!cur) throw new Error('1:1 채팅에서 캐릭터를 연 상태여야 해요.');
    const { char } = cur;
    const pick = k => char[k] ?? char.data?.[k];
    const sections = [
        ['Name', char.name],
        ['Description', clip(pick('description'), 12000)],
        ['Personality', clip(pick('personality'), 3000)],
        ['Scenario', clip(pick('scenario'), 3000)],
        ['First message', clip(pick('first_mes'), 3000)],
        ['Example dialogue', clip(pick('mes_example'), 4000)],
        ["Creator's notes", clip(pick('creator_notes'), 1500)],
    ].filter(([, v]) => v);
    const card = ctx().substituteParams(`<character_card>\n${sections.map(([k, v]) => `## ${k}\n${v}`).join('\n\n')}\n</character_card>`);
    const settings = getSettings();
    const lore = await collectLore(char, settings);
    onLore?.(lore);
    const input = `${card}${lore.text ? `\n\n${lore.text}` : ''}\n\nAnalyse this character now. Output the JSON object only.`;
    // The lorebook makes the input longer; give the answer a little more room too
    const reply = await sideGenerate(analysisSystemPrompt(settings), input, lore.text ? { maxTokens: Math.max(Number(settings.api_max_tokens) || 2000, 2500) } : {});
    const profile = normalizeProfile({ ...extractJson(reply), lore: lore.used ? { books: lore.books, used: lore.used } : null });
    if (isProfileEmpty(profile)) throw new Error('분석 결과가 비어 있어요. 다시 시도해 주세요.');
    return profile;
}

function readingText(p) {
    const lines = [];
    for (const { key } of LAYER_FIELDS) if (p.layers[key]) lines.push(`${key}: ${p.layers[key]}`);
    p.pairs.forEach((x, i) => lines.push(`pair ${i + 1}: "${x.a}" vs "${x.b}", lean ${x.lean} toward "${x.a}". behavior: ${x.behavior} cost: ${x.cost}`));
    for (const r of p.relations ?? []) lines.push(`around ${r.who}: ${r.shows}`);
    for (const c of p.changes ?? []) lines.push(`changed: ${c}`);
    lines.push(`base_crack: ${p.base_crack}`);
    return lines.join('\n');
}

/** Most recent story messages, newest kept, within `budget` characters. */
function storyExcerpt(budget) {
    const c = ctx();
    const msgs = (c.chat ?? []).filter(m => m && !m.is_system && m.mes);
    const picked = [];
    let size = 0;
    for (let i = msgs.length - 1; i >= 0; i--) {
        const m = msgs[i];
        const text = maskNonStory(m.mes).replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim();
        if (!text) continue;
        const line = `${m.is_user ? '{{user}}' : m.name || '{{char}}'}: ${text.length > 2500 ? `${text.slice(0, 2500)} [...]` : text}`;
        if (size + line.length > budget && picked.length) break;
        picked.unshift(line);
        size += line.length + 1;
    }
    return { text: picked.join('\n'), used: picked.length, total: msgs.length };
}

const UPDATE_RULES = [
    '',
    'UPDATE MODE. This character is already deep into a roleplay. <story_so_far> holds its most recent part and <current_reading> the reading used so far.',
    '- Describe {{char}} as they are NOW. Where the story has visibly changed them (a relationship moved, a belief broke, they softened or hardened, they decided something), the story wins over the card and over the current reading.',
    '- Change only what the story actually shows. Keep everything else from the current reading as it is.',
    '- Do not flatten. Growth adds a layer; it does not erase the old one. Keep the old fear or habit alive underneath, and keep the two layers in tension even if one has grown.',
    '- Keep the value pairs that still apply, in the same order, and move each lean to where the story now has it. Replace a pair only if the story has made it irrelevant.',
    '- base_crack: how much the inner layer shows now.',
    `- changes: 0 to ${LIMITS.max_changes} lines, each how {{char}} now acts differently from the card and what in the story caused it, as behaviour (e.g. "answers {{user}}'s teasing with teasing now instead of silence, since the night at the station"). Under ${LIMITS.change} characters each. Empty array when nothing has changed.`,
    "- Judge {{char}} by what {{char}} did and said. {{user}}'s lines are context only.",
    '- recommend is not needed in this mode.',
    'Output the same JSON object with "changes" added: {"layers":{...},"pairs":[...],"relations":[...],"changes":["..."],"base_crack":20}',
].join('\n');

/** Re-reads the character through the chat so far. The result is this chat's version. */
export async function analyzeChatEvolution({ onLore } = {}) {
    const cur = await ensureFullCharacter();
    if (!cur) throw new Error('1:1 채팅에서 캐릭터를 연 상태여야 해요.');
    const { char } = cur;
    const settings = getSettings();
    const story = storyExcerpt(Math.max(4000, Number(settings.chat_budget) || 24000));
    if (storyLength() < 5) throw new Error('채팅이 아직 짧아요. AI 답변이 5개 넘게 쌓인 뒤에 해 주세요.');
    const pick = k => char[k] ?? char.data?.[k];
    const sections = [
        ['Name', char.name],
        ['Description', clip(pick('description'), 8000)],
        ['Personality', clip(pick('personality'), 2000)],
        ['Scenario', clip(pick('scenario'), 2000)],
    ].filter(([, v]) => v);
    const c = ctx();
    const card = `<character_card>\n${sections.map(([k, v]) => `## ${k}\n${v}`).join('\n\n')}\n</character_card>`;
    const lore = await collectLore(char, { ...settings, lore_budget: Math.min(Number(settings.lore_budget) || 12000, 6000) });
    onLore?.(lore);
    const prev = loadChatProfile() ?? loadProfile();
    const parts = [
        card,
        lore.text,
        prev ? `<current_reading>\n${readingText(prev)}\n</current_reading>` : '',
        `<story_so_far messages="${story.used} of ${story.total}, most recent">\n${story.text}\n</story_so_far>`,
        'Update the reading of {{char}} for where the story is now. Output the JSON object only.',
    ].filter(Boolean);
    const input = c.substituteParams(parts.join('\n\n'));
    const reply = await sideGenerate(analysisSystemPrompt(settings) + UPDATE_RULES, input, { maxTokens: Math.max(Number(settings.api_max_tokens) || 2000, 2500) });
    const json = extractJson(reply);
    const profile = normalizeProfile({
        ...json,
        recommend: prev?.recommend ?? json?.recommend,
        based_on: { messages: story.used, total: story.total },
        lore: lore.used ? { books: lore.books, used: lore.used } : null,
    });
    if (isProfileEmpty(profile)) throw new Error('분석 결과가 비어 있어요. 다시 시도해 주세요.');
    return profile;
}

// ---------------------------------------------------------------- prompt text

function crackBand(v) {
    if (v <= 20) return 'the surface holds; the inner layer shows only in tiny, deniable slips';
    if (v <= 40) return 'mostly surface; the inner layer leaks through small habits and pauses';
    if (v <= 60) return 'the mask is visibly strained; inner motives surface under pressure';
    if (v <= 80) return 'the inner layer often breaks through; they struggle to keep up appearances';
    return 'the mask has largely fallen; they act from the inner layer and know it';
}

function leanText(a, b, lean) {
    if (lean >= 85) return `firmly toward "${a}"`;
    if (lean >= 60) return `toward "${a}"`;
    if (lean > 40) return 'torn between them';
    if (lean > 15) return `toward "${b}"`;
    return `firmly toward "${b}"`;
}

/** The <character_insight> block. Lemona's realism rules already cover how a wound surfaces, so this stays factual. */
/**
 * @param {{ source?: 'card'|'chat', soft?: boolean }} [opts]
 *   source: where the reading came from. soft: card reading in a long chat, so keep only the deep motives.
 */
export function buildInsightPrompt(profile, mvuState, { source = 'card', soft = false } = {}) {
    const l = profile.layers;
    const head = source === 'chat'
        ? "A reading of {{char}} as they are now in this story, updated from the card by what has happened in the chat. Use it to fill in the realism rules above with this specific person."
        : "A reading of {{char}}'s inner logic taken from the character card: the baseline they started from. Use it to fill in the realism rules above with this specific person.";
    const out = [
        '<character_insight for="{{char}}">',
        head,
        'Express it through action, choice, tone and subtext; never state these notes outright, never have {{char}} recite them, and never list them as traits.',
        'The story so far outranks these notes. Wherever the chat has already shown {{char}} change (warmer or colder, broken, decided otherwise, a relationship moved), keep the change and read the notes as the history underneath it, never as a state to snap back to.',
    ];
    if (soft) out.push('This chat has run long and the notes may be out of date: use them only for the deep motives below, and take how {{char}} acts and talks from the chat itself.');
    const changes = profile.changes ?? [];
    if (changes.length) out.push('', '[How {{char}} has changed in this story] Earned through the chat; keep them, while the older layer still shows underneath:', ...changes.map(t => `- ${t}`));
    const layerLines = [
        !soft && l.surface && `- Surface (what others see): ${l.surface}`,
        l.desire && `- Core desire (what they actually want): ${l.desire}`,
        l.fear && `- Fear / wound (surfaces rarely, in a flash, and is shoved away): ${l.fear}`,
        l.self_deception && `- Self-deception (what they wrongly believe about themselves): ${l.self_deception}`,
    ].filter(Boolean);
    if (layerLines.length) {
        out.push('', '[Two layers]', ...layerLines);
        if (mvuState) out.push(`- Mask crack right now: ${mvuState.가면균열}/100 — ${crackBand(mvuState.가면균열)}.`);
    }
    if (profile.pairs.length) {
        out.push('', '[Colliding values] When a scene forces these against each other, {{char}} leans as marked. Going against the lean is possible, but it always leaves the listed cost.');
        profile.pairs.forEach((p, i) => {
            const lean = mvuState?.기울기[i] ?? p.lean;
            out.push(`${i + 1}. "${p.a}" vs "${p.b}" — currently ${leanText(p.a, p.b, lean)} (${lean}/100 toward "${p.a}").`);
            if (p.behavior && !soft) out.push(`   When they collide: ${p.behavior}`);
            if (p.cost && !soft) out.push(`   Cost of going against the lean: ${p.cost}`);
        });
        if (mvuState?.최근갈등) out.push(`Most recent dilemma: ${mvuState.최근갈등}`);
    }
    const relations = profile.relations ?? [];
    if (relations.length && !soft) {
        out.push('', '[Around key people] Only when this person is present or on {{char}}\'s mind:');
        for (const r of relations) out.push(`- ${r.who}: ${r.shows}`);
    }
    out.push('', 'Use only the parts this moment actually touches; most replies need one or none. These are tendencies, not rules: {{char}} may surprise, contradict themselves, act out of mood, or change when the story gives a reason. Contradiction between the layers is intended: keep it alive instead of resolving it.', '</character_insight>');
    return out.join('\n');
}

/** Extra checklist line for Lemona's <thinkingProcess>. */
export const THINK_LINE = '\n- Insight: does this moment press on one side of {{char}}\'s two layers, or force one of their value pairs? If so, which way they lean and what it costs, as {{char}} is now in this story (what the chat has established beats the notes); if not, leave it out.';
