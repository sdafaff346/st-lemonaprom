// Modules 1 & 2: two-layer reading and colliding value pairs. Model-facing text is English.

import { sideGenerate } from './api.js';
import { cleanText, ctx, ensureFullCharacter, extractJson, getSettings, LIMITS, readCharData, toPercent, writeCharData } from './core.js';
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
    return {
        layers,
        pairs,
        base_crack: toPercent(src.base_crack, 20),
        recommend: normalizeRecommendation(src.recommend ?? src.toggles),
        updated_at: typeof src.updated_at === 'string' ? src.updated_at : '',
    };
}

export function isProfileEmpty(profile) {
    return !profile || (LAYER_FIELDS.every(f => !profile.layers[f.key]) && profile.pairs.length === 0);
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
        "You are a character analyst for interactive fiction. Read the character card and extract the character's inner logic so another writer can keep them consistent yet multi-faceted in situations the card never mentions.",
        '',
        'Principles:',
        '- Do NOT use personality-type labels (MBTI, enneagram, zodiac, "tsundere", etc.) or bare adjectives ("cold", "kind").',
        '- Write each item as an observable behaviour or a concrete motive, e.g. "Calls out anyone who cuts in line, even strangers" instead of "values fairness".',
        '- Connect motives to causes found in the card when the card gives one. If the card is silent, infer the most plausible cause and keep it modest; do not invent major backstory events.',
        '- Prefer tension: the inner layer should explain or contradict the surface layer, not repeat it.',
        '- Keep the character at the intensity the card writes. Do not soften edges (rudeness, selfishness, cruelty) or add kindness the card does not give.',
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
        '3. base_crack: integer 0-100, how much of the inner layer normally leaks through the surface at the start of a story (0 = perfectly masked, 100 = wears their heart on their sleeve).',
        '4. recommend — which writing-preset switches fit this card:',
        '   - bot_type: "original" (the card\'s own original character), "motif" (inspired by an existing work but not that canon), "korean" / "japanese" / "western" (a fan-work character from an existing Korean / Japanese anime-manga / Western work).',
        '   - canon: the name of the original work for a fan-work character, otherwise "".',
        '   - mood: "none", "slow" (slow-burn flirting), "comedy" (everyday comedy), "tense" (thriller tension) or "work" (case- or job-driven); "none" unless the card clearly sets one.',
        '   - harsh: true if being rude, cruel, selfish or contemptuous is core to them. gentle: true if gentle, courteous kindness is core to them. Never both.',
        '   - romcom: true if the card sets up a romantic-comedy dynamic. angst: true if the card is built on sorrow, loss or tragedy.',
        '   - multi_cast: true if the card plays several characters at once. foreign_speaker: true if the character cannot speak the narration language well.',
        '   - reason: one short sentence explaining the picks.',
        '',
        `Length limits: each layers field under ${LIMITS.layer} characters; a and b under ${LIMITS.side} characters; behavior and cost under ${LIMITS.pair_text} characters.`,
        languageLine(settings),
        '',
        'Output ONLY one JSON object, no commentary, no code fence, in exactly this shape:',
        '{"layers":{"surface":"...","desire":"...","fear":"...","self_deception":"..."},"pairs":[{"a":"...","b":"...","lean":70,"behavior":"...","cost":"..."}],"base_crack":20,"recommend":{"bot_type":"original","canon":"","mood":"none","harsh":false,"gentle":false,"romcom":false,"angst":false,"multi_cast":false,"foreign_speaker":false,"reason":"..."}}',
    ].join('\n');
}

function clip(value, max) {
    const s = String(value ?? '').trim();
    return s.length > max ? `${s.slice(0, max)}\n[...truncated]` : s;
}

export async function analyzeCurrentCharacter() {
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
    const reply = await sideGenerate(analysisSystemPrompt(getSettings()), `${card}\n\nAnalyse this character now. Output the JSON object only.`);
    const profile = normalizeProfile(extractJson(reply));
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
export function buildInsightPrompt(profile, mvuState) {
    const l = profile.layers;
    const out = [
        '<character_insight for="{{char}}">',
        "A structured reading of {{char}}'s inner logic, to fill in the realism rules above with this specific person. Express it through action, choice, tone and subtext; never state these notes outright, never have {{char}} recite them, and never list them as traits.",
    ];
    const layerLines = [
        l.surface && `- Surface (what others see): ${l.surface}`,
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
            if (p.behavior) out.push(`   When they collide: ${p.behavior}`);
            if (p.cost) out.push(`   Cost of going against the lean: ${p.cost}`);
        });
        if (mvuState?.최근갈등) out.push(`Most recent dilemma: ${mvuState.최근갈등}`);
    }
    out.push('', 'Use only the parts this moment actually touches; most replies need one or none. Leans are tendencies, not rules. Contradiction between the layers is intended: keep it alive instead of resolving it.', '</character_insight>');
    return out.join('\n');
}

/** Extra checklist line for Lemona's <thinkingProcess>. */
export const THINK_LINE = '\n- Insight: does this moment press on one side of {{char}}\'s two layers, or force one of their value pairs? If so, which way they lean and what it costs; if not, leave it out.';
