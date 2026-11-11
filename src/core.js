// Shared state, settings, helpers and per-character storage.

export const MODULE = 'lemona_companion';
export const EXT_FIELD = 'lemona_companion'; // character card data.extensions key
export const LEGACY_FIELD = 'character_insight'; // Character Insight v0.1 data, read as fallback
export const META_KEY = 'lemona_companion'; // chat metadata key
export const MVU_KEY = '캐해';
export const LOG = '[레모나]';

export const LIMITS = Object.freeze({ layer: 160, side: 24, pair_text: 160, max_pairs: 3, recent: 120 });

// extension_prompt_types / extension_prompt_roles from script.js (not exported via getContext)
export const PROMPT_TYPE = Object.freeze({ NONE: -1, IN_PROMPT: 0, IN_CHAT: 1 });
export const PROMPT_ROLE = Object.freeze({ system: 0, user: 1, assistant: 2 });

export const defaultSettings = Object.freeze({
    // side API
    api_profile: '', // '' = main API
    api_max_tokens: 2000,
    output_language: 'preset',

    // insight
    insight_enabled: true,
    insight_fallback_depth: 4,
    insight_think_line: true,

    // MVU
    mvu_enabled: true,
    mvu_inject_rules: true,
    mvu_inject_format: false,
    mvu_max_delta: 10,

    // preset toggles
    toggles_auto_apply: true,

    // ban checker
    bans_enabled: true,
    bans_highlight: true,
    bans_auto_fix: false,

    // repetition
    repeat_enabled: true,
    repeat_window: 6,
    repeat_min_count: 3,
    repeat_max_items: 5,
});

export const state = {
    busy: new Set(),
    mvu: null,
    lemona: false, // active preset looks like Lemona
    sideCall: false, // our own side generation in flight
    lastGenType: null,
};

export function ctx() {
    return SillyTavern.getContext();
}

export function getSettings() {
    const { extensionSettings } = ctx();
    if (!extensionSettings[MODULE]) extensionSettings[MODULE] = structuredClone(defaultSettings);
    const s = extensionSettings[MODULE];
    for (const key of Object.keys(defaultSettings)) {
        if (!Object.hasOwn(s, key)) s[key] = defaultSettings[key];
    }
    return s;
}

export function saveSettings() {
    ctx().saveSettingsDebounced();
}

// ---------------------------------------------------------------- small helpers

export function clamp(v, lo, hi) {
    return Math.min(hi, Math.max(lo, v));
}

export function cleanText(value, max) {
    if (value === null || value === undefined) return '';
    return String(value).replace(/\s+/g, ' ').trim().slice(0, max);
}

export function toPercent(value, fallback) {
    const n = Number(value);
    const v = value === null || value === undefined || value === '' || !Number.isFinite(n) ? fallback : n;
    return clamp(Math.round(v), 0, 100);
}

export function esc(text) {
    return String(text ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

export function toast(type, msg, title = '레모나', opts = {}) {
    return toastr[type](msg, title, opts);
}

/** Runs fn once at a time per key; shows errors as toasts. */
export async function guarded(key, fn) {
    if (state.busy.has(key)) return undefined;
    state.busy.add(key);
    document.dispatchEvent(new CustomEvent('lemona:busy'));
    try {
        return await fn();
    } catch (e) {
        console.error(LOG, key, e);
        toast('error', String(e?.message ?? e) + (e?.cause ? ` (${e.cause?.message ?? e.cause})` : ''), '레모나 오류', { timeOut: 10000 });
        return undefined;
    } finally {
        state.busy.delete(key);
        document.dispatchEvent(new CustomEvent('lemona:busy'));
    }
}

export function extractJson(reply) {
    const cleaned = String(reply ?? '')
        .replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, '')
        .replace(/```(?:json)?/gi, '')
        .trim();
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start === -1 || end <= start) throw new Error('응답에서 JSON을 찾지 못했어요. (설정의 응답 길이를 늘려 보세요)');
    return JSON.parse(cleaned.slice(start, end + 1));
}

// ---------------------------------------------------------------- character storage

/** { id, char } for the open 1:1 character, or null (group chat / none). */
export function currentCharacter() {
    const c = ctx();
    if (c.groupId || c.characterId === undefined || c.characterId === null) return null;
    const char = c.characters?.[Number(c.characterId)];
    return char ? { id: c.characterId, char } : null;
}

export async function ensureFullCharacter() {
    const cur = currentCharacter();
    if (!cur) return null;
    const { unshallowCharacter } = ctx();
    if (typeof unshallowCharacter === 'function') {
        try {
            await unshallowCharacter(cur.id);
        } catch (e) {
            console.warn(LOG, 'unshallowCharacter failed', e);
        }
    }
    return currentCharacter();
}

export function readCharData() {
    const cur = currentCharacter();
    const ext = cur?.char?.data?.extensions ?? {};
    const data = ext[EXT_FIELD] && typeof ext[EXT_FIELD] === 'object' ? { ...ext[EXT_FIELD] } : {};
    if (!data.insight && ext[LEGACY_FIELD]) data.insight = ext[LEGACY_FIELD];
    return data;
}

export async function writeCharData(patch) {
    const cur = currentCharacter();
    if (!cur) throw new Error('1:1 채팅에서 캐릭터를 연 상태여야 해요.');
    const data = { ...readCharData(), ...patch };
    for (const k of Object.keys(data)) if (data[k] === null) delete data[k];
    await ctx().writeExtensionField(cur.id, EXT_FIELD, data);
}

export function requireCharacter() {
    const cur = currentCharacter();
    if (!cur) toast('warning', '1:1 채팅에서 캐릭터를 연 상태에서 사용해 주세요. (그룹 채팅은 아직 지원하지 않아요)');
    return cur;
}

// ---------------------------------------------------------------- chat metadata

export function getMeta() {
    const { chatMetadata } = ctx();
    if (!chatMetadata) return {};
    chatMetadata[META_KEY] ??= {};
    return chatMetadata[META_KEY];
}

export function saveMeta() {
    const c = ctx();
    (c.saveMetadataDebounced ?? c.saveMetadata)?.();
}

// ---------------------------------------------------------------- message text

/**
 * Blanks out non-story parts of a reply (thinking, MVU blocks, code, HTML tags, status line)
 * with spaces of equal length, so offsets still match the original text.
 */
export function maskNonStory(text) {
    const blank = m => m.replace(/[^\n]/g, ' ');
    return String(text ?? '')
        .replace(/<(think|thinking|thinkingProcess|UpdateVariable|StatusPlaceHolderImpl|status_current_variables?)\b[^>]*>[\s\S]*?<\/\1>/gi, blank)
        .replace(/<UpdateVariable>[\s\S]*$/i, blank) // unterminated block at the end
        .replace(/```[\s\S]*?```/g, blank)
        .replace(/<[^>\n]{1,200}>/g, blank)
        .replace(/^\s*\[[^\]\n]*(?:년|월|°C|AM|PM|오전|오후)[^\]\n]*\]\s*$/gm, blank); // Lemona status line
}

/** Assistant messages (newest last) that are real character replies. */
export function recentReplies(limit) {
    const { chat } = ctx();
    const out = [];
    for (let i = (chat?.length ?? 0) - 1; i >= 0 && out.length < limit; i--) {
        const m = chat[i];
        if (!m || m.is_user || m.is_system || !m.mes) continue;
        out.unshift({ id: i, text: m.mes });
    }
    return out;
}
