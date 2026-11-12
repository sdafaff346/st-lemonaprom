// Modules 1 & 2: two-layer reading and colliding value pairs. Model-facing text is English.

import { sideGenerate } from './api.js';
import { cleanText, ctx, currentCharacter, ensureFullCharacter, extractJson, getMeta, getSettings, LIMITS, maskNonStory, readCharData, saveMeta, toPercent, writeCharData } from './core.js';
import { buildCastPrompt, CAST_THINK_LINE, isCastKind, KIND_LABELS, normalizeCast, normalizeKind, normalizeWorld } from './cast.js';
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
    const kind = normalizeKind(src.kind);
    return {
        kind,
        cast: kind === 'single' ? [] : normalizeCast(src.cast).filter(m => !isUserName(m.name)),
        world: normalizeWorld(kind === 'sim' || kind === 'rpg' ? src.world : null),
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
    return !profile || (LAYER_FIELDS.every(f => !profile.layers[f.key]) && profile.pairs.length === 0 && (profile.relations?.length ?? 0) === 0 && (profile.changes?.length ?? 0) === 0
        && (profile.cast?.length ?? 0) === 0 && !profile.world?.stance && !profile.world?.npc_rule);
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

function kindSection(forcedKind) {
    const lines = [
        'Card kinds:',
        '- "single": the card is one character; {{char}} is that person.',
        '- "multi" (다인봇): the card plays a fixed group of two or more named characters who share the scenes (siblings, a party, a household, rivals).',
        '- "sim" (시뮬봇): a simulation or setting card; {{char}} is a narrator or a world, and people come and go as the story needs (school, city, workplace, dating sim with many routes).',
        '- "rpg" (RPG봇): a game-like card with quests, stats, combat, levels, a system window or a game-master narrator.',
        forcedKind
            ? `The user has set this card's kind to "${forcedKind}". Use it.`
            : 'First decide which kind this card is and put it in "kind".',
        '',
        'What to fill for each kind (leave the other fields empty or out):',
        '- single: layers, pairs, relations, base_crack (items 1-4 below).',
        `- multi: cast — every main character of the group (up to ${LIMITS.max_cast}). pairs and relations stay empty; put tensions inside each member.`,
        `- sim / rpg: world, pairs as the world's tensions (2-3 values or sides that pull against each other, e.g. "order" vs "freedom", "guild" vs "crown"; lean = where things stand now; behavior = how it shows in daily life; cost may be empty), and cast = the recurring people named in the card or lorebook (up to ${LIMITS.max_cast}, most important first; empty if it names nobody).`,
        '',
        'cast members (multi, sim, rpg):',
        '   - name: as the card writes it. aliases: other names, titles or nicknames the story uses for them (0-4).',
        '   - role: who they are in the story, in a few words.',
        '   - surface: how they come across to others, as behaviour.',
        '   - inner: what they actually want and what they fear underneath; it should explain or contradict the surface.',
        '   - voice: what makes their speech or habits recognisably theirs, so they do not sound like the others.',
        '   - pair: their own two colliding values {"a","b","lean"} (lean 0-100 toward a), or null.',
        '   Every member must differ from the others in want and voice. Never include {{user}}.',
        'world (sim, rpg):',
        '   - stance: how this world treats people and {{user}} — what it rewards, punishes, ignores (e.g. "nobody does anything for free; favours are remembered and called in").',
        '   - npc_rule: how people the card does not name should be written so they are not props (e.g. "every shopkeeper has their own worry that colours how they deal").',
        `Length limits for these: name and aliases under ${LIMITS.name}, role under ${LIMITS.role}, surface and inner under ${LIMITS.member}, voice under ${LIMITS.voice}, stance and npc_rule under ${LIMITS.world} characters.`,
    ];
    return lines.join('\n');
}

function analysisSystemPrompt(settings, forcedKind = null) {
    return [
        "You are a character analyst for interactive fiction. Read the character card (and its lorebook, when one is given) and extract the inner logic of the people in it so another writer can keep them consistent yet multi-faceted in situations the card never mentions.",
        '',
        'Principles:',
        '- Do NOT use personality-type labels (MBTI, enneagram, zodiac, "tsundere", etc.) or bare adjectives ("cold", "kind").',
        '- Write each item as an observable behaviour or a concrete motive, e.g. "Calls out anyone who cuts in line, even strangers" instead of "values fairness".',
        '- Connect motives to causes found in the card when the card gives one. If the card is silent, infer the most plausible cause and keep it modest; do not invent major backstory events.',
        '- Prefer tension: the inner layer should explain or contradict the surface layer, not repeat it.',
        '- Keep the character at the intensity the card writes. Do not soften edges (rudeness, selfishness, cruelty) or add kindness the card does not give.',
        '- A <lorebook> holds world-info entries tied to this character. Treat it as part of the card: use it for past events, relationships and world rules that explain the motives. The card wins where the two disagree. Do not summarise the lorebook or copy world facts into the output; use it only to ground the inner logic.',
        '',
        kindSection(forcedKind),
        '',
        'Items for "single" (and recommend for every kind):',
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
        '{"kind":"single","layers":{"surface":"...","desire":"...","fear":"...","self_deception":"..."},"pairs":[{"a":"...","b":"...","lean":70,"behavior":"...","cost":"..."}],"relations":[{"who":"...","shows":"..."}],"base_crack":20,"cast":[{"name":"...","aliases":["..."],"role":"...","surface":"...","inner":"...","voice":"...","pair":{"a":"...","b":"...","lean":60}}],"world":{"stance":"...","npc_rule":"..."},"recommend":{"bot_type":"original","canon":"","mood":"none","harsh":false,"gentle":false,"romcom":false,"angst":false,"multi_cast":false,"foreign_speaker":false,"reason":"..."}}',
    ].join('\n');
}

function clip(value, max) {
    const s = String(value ?? '').trim();
    return s.length > max ? `${s.slice(0, max)}\n[...truncated]` : s;
}

/** @param {{ onLore?: (lore: {books:string[], used:number, total:number, skipped:number, cut:number}) => void }} [opts] */
export async function analyzeCurrentCharacter({ onLore, kind = null } = {}) {
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
    const forced = kind ? normalizeKind(kind) : null;
    // A cast or a world needs more room than one person
    const roomy = lore.text || forced !== 'single';
    const reply = await sideGenerate(analysisSystemPrompt(settings, forced), input, roomy ? { maxTokens: Math.max(Number(settings.api_max_tokens) || 2000, forced && forced !== 'single' ? 3500 : 2500) } : {});
    const json = extractJson(reply) ?? {};
    const profile = normalizeProfile({ ...json, kind: forced ?? json.kind, lore: lore.used ? { books: lore.books, used: lore.used } : null });
    // A fixed group of characters is exactly what Lemona's 「👥 다인봇 시장통 방지」 is for
    if (profile.kind === 'multi' && profile.recommend) profile.recommend.multi_cast = true;
    if (isProfileEmpty(profile)) throw new Error('분석 결과가 비어 있어요. 다시 시도해 주세요.');
    return profile;
}

function readingText(p) {
    const lines = [`kind: ${p.kind ?? 'single'}`];
    if (p.world?.stance) lines.push(`world stance: ${p.world.stance}`);
    if (p.world?.npc_rule) lines.push(`world npc_rule: ${p.world.npc_rule}`);
    for (const m of p.cast ?? []) {
        lines.push(`member ${m.name}${m.aliases.length ? ` (aka ${m.aliases.join(', ')})` : ''}: role ${m.role} | surface ${m.surface} | inner ${m.inner} | voice ${m.voice}${m.pair ? ` | pair "${m.pair.a}" vs "${m.pair.b}" lean ${m.pair.lean}` : ''}${m.changed ? ` | changed ${m.changed}` : ''}`);
    }
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
    '- For multi, sim and rpg: update the cast the same way. Keep every member, bring their fields to where the story has them now, and fill "changed" (one line: how they now differ from the card and why) for members the story has changed. Add people who have become recurring in the story (in several scenes, or who matter to {{user}}), most important first, within the member limit; a member the story removed (left, died) keeps a "changed" line saying so. Update world stance and tensions only where the story shows it.',
    '- recommend is not needed in this mode.',
    'Output the same JSON object with "changes" added: {"kind":"...","layers":{...},"pairs":[...],"relations":[...],"cast":[{"name":"...","aliases":[],"role":"...","surface":"...","inner":"...","voice":"...","pair":null,"changed":"..."}],"world":{...},"changes":["..."],"base_crack":20}',
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
    const kind = normalizeKind(prev?.kind);
    const reply = await sideGenerate(analysisSystemPrompt(settings, prev ? kind : null) + UPDATE_RULES, input, { maxTokens: Math.max(Number(settings.api_max_tokens) || 2000, kind === 'single' ? 2500 : 3500) });
    const json = extractJson(reply) ?? {};
    const profile = normalizeProfile({
        ...json,
        kind: prev ? kind : json.kind,
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
export function buildInsightPrompt(profile, mvuState, { source = 'card', soft = false, text } = {}) {
    if (isCastKind(profile.kind)) return buildCastPrompt(profile, { source, soft, text });
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

/** Checklist line that fits the profile's kind. */
export function thinkLineFor(profile) {
    return isCastKind(profile?.kind) ? CAST_THINK_LINE : THINK_LINE;
}

export { KIND_LABELS };

/** Extra checklist line for Lemona's <thinkingProcess>. */
export const THINK_LINE = '\n- Insight: does this moment press on one side of {{char}}\'s two layers, or force one of their value pairs? If so, which way they lean and what it costs, as {{char}} is now in this story (what the chat has established beats the notes); if not, leave it out.';
