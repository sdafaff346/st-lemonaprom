// Reads and switches the Lemona preset's toggles (Prompt Manager entries of the active CC preset).

import { ctx, LOG, readCharData, saveSettings, state, toast, writeCharData } from './core.js';

const GLOBAL_ORDER_ID = 100001; // PromptManager dummyId for the global prompt order

// Entries never shown as optional toggles (always-on core of the preset)
const CORE_IDS = new Set(['main', 'lm_lastmsg', 'lm_narrative', 'lm_realism', 'lm_bans', 'lm_think', 'lm_reset', 'lm_lang', 'lm_fandom', 'nsfw', 'jailbreak', 'enhanceDefinitions']);
const MUST_ON = ['lm_reset', 'lm_lang', 'lm_fandom'];

// Analysis recommendation keys → words that appear in the Lemona entry names
export const RECOMMEND_MAP = Object.freeze({
    bot_type: {
        original: '오리지널',
        motif: '모티브',
        korean: '한국 장르',
        japanese: '일본',
        western: '서양',
    },
    mood: {
        slow: '썸',
        comedy: '코미디',
        tense: '긴장',
        work: '사건',
    },
    flags: {
        harsh: '혐성',
        gentle: '젠틀',
        romcom: '로코',
        angst: '앵스트',
        multi_cast: '다인봇',
        foreign_speaker: '한국어 못하는',
    },
});

export const FLAG_LABELS = Object.freeze({
    harsh: '혐성 캐릭터',
    gentle: '젠틀 캐릭터',
    romcom: '로코 캐해',
    angst: '앵스트',
    multi_cast: '다인봇 시장통 방지',
    foreign_speaker: '한국어 못하는 외국인',
});

function settingsObj() {
    return ctx().chatCompletionSettings ?? null;
}

function orderList() {
    const oai = settingsObj();
    if (!oai?.prompt_order) return null;
    const entry = oai.prompt_order.find(o => Number(o.character_id) === GLOBAL_ORDER_ID) ?? oai.prompt_order[0];
    return entry?.order ?? null;
}

function promptById(id) {
    return settingsObj()?.prompts?.find(p => p.identifier === id) ?? null;
}

/** Content of an entry in the active preset, found by identifier or by a word in its name. */
export function presetPromptContent(id, nameWord) {
    const prompts = settingsObj()?.prompts ?? [];
    const p = prompts.find(x => x.identifier === id) ?? (nameWord ? prompts.find(x => String(x.name ?? '').includes(nameWord)) : null);
    return p?.content ?? '';
}

export function detectLemona() {
    const order = orderList();
    const ids = new Set(order?.map(e => e.identifier) ?? []);
    state.lemona = ids.has('lm_realism') && ids.has('lm_think') && ids.has('lm_reset');
    return state.lemona;
}

function isEnabled(id) {
    return !!orderList()?.find(e => e.identifier === id)?.enabled;
}

function groupKey(name) {
    const m = String(name).match(/^\s*(\S+)\s+(.+?)\s*택1\s*[:：]\s*(.+)$/u);
    if (!m) return null;
    let label = m[2].trim();
    if (/^\d차봇$/.test(label)) label = '봇 유형'; // 1차봇 / 2차봇 share the {{fandom}} slot
    return { label, icon: m[1], option: m[3].trim() };
}

/**
 * @returns {{ groups: {label:string, icon:string, options:{id:string, label:string, enabled:boolean}[]}[],
 *             optional: {id:string, name:string, enabled:boolean}[] }}
 */
export function readToggles() {
    const order = orderList() ?? [];
    const groups = new Map();
    const optional = [];
    for (const e of order) {
        const p = promptById(e.identifier);
        if (!p || p.marker) continue;
        const g = groupKey(p.name ?? '');
        if (g) {
            if (!groups.has(g.label)) groups.set(g.label, { label: g.label, icon: g.icon, options: [] });
            groups.get(g.label).options.push({ id: e.identifier, label: g.option, enabled: !!e.enabled });
            continue;
        }
        if (CORE_IDS.has(e.identifier)) continue;
        if (/끄지마요|검열방지/.test(p.name ?? '')) continue;
        optional.push({ id: e.identifier, name: p.name ?? e.identifier, enabled: !!e.enabled });
    }
    return { groups: [...groups.values()], optional };
}

async function rerenderPromptManager() {
    try {
        const mod = await import('/scripts/openai.js');
        mod.promptManager?.render?.(false);
    } catch (e) {
        console.debug(LOG, 'prompt manager re-render skipped', e);
    }
}

/** @param {Record<string, boolean>} changes identifier → enabled */
export async function setToggles(changes) {
    const order = orderList();
    if (!order) throw new Error('채팅 완성(Chat Completion) 프리셋을 찾지 못했어요.');
    let changed = 0;
    for (const [id, on] of Object.entries(changes)) {
        const e = order.find(x => x.identifier === id);
        if (e && !!e.enabled !== !!on) {
            e.enabled = !!on;
            changed++;
        }
    }
    if (changed) {
        saveSettings();
        await rerenderPromptManager();
        document.dispatchEvent(new CustomEvent('lemona:toggles'));
    }
    return changed;
}

/** Select one option in a 택1 group (null = all off). */
export async function selectInGroup(groupLabel, id) {
    const group = readToggles().groups.find(g => g.label === groupLabel);
    if (!group) return 0;
    const changes = {};
    for (const o of group.options) changes[o.id] = o.id === id;
    return setToggles(changes);
}

// ---------------------------------------------------------------- health check

/** @returns {{level:'warn'|'info', text:string}[]} */
export function healthCheck() {
    const out = [];
    if (!detectLemona()) {
        out.push({ level: 'info', text: '지금 프리셋이 레모나가 아니에요. 레모나 연동 기능(추론 체크 줄, 토글 도우미)은 쉬고, 나머지는 일반 모드로 작동해요.' });
        return out;
    }
    const order = orderList();
    for (const id of MUST_ON) {
        if (!isEnabled(id)) out.push({ level: 'warn', text: `「${promptById(id)?.name ?? id}」이(가) 꺼져 있어요. 켜 두어야 레모나가 제대로 동작해요.` });
    }
    const first = order.find(e => !promptById(e.identifier)?.marker);
    if (first && first.identifier !== 'lm_reset') out.push({ level: 'warn', text: '「📌 변수 초기화」가 맨 위에 있지 않아요. 맨 위로 옮겨 주세요.' });

    const { groups, optional } = readToggles();
    for (const g of groups) {
        const on = g.options.filter(o => o.enabled);
        if (on.length > 1) out.push({ level: 'warn', text: `「${g.label} 택1」에 ${on.length}개가 켜져 있어요: ${on.map(o => o.label).join(', ')}. 하나만 남겨 주세요.` });
        if (on.length === 0 && /언어|시점|문체|사칭/.test(g.label)) out.push({ level: 'warn', text: `「${g.label} 택1」이 하나도 켜져 있지 않아요.` });
    }
    const byWord = w => optional.find(o => o.name.includes(w));
    const messenger = byWord('메신저');
    const status = byWord('상태창');
    if (messenger?.enabled && status?.enabled) out.push({ level: 'warn', text: '메신저 모드와 상태창이 같이 켜져 있어요. 메신저 모드에서는 상태창을 꺼 주세요.' });

    const argon = optional.find(o => o.id === 'lm_argon');
    if (argon?.enabled) {
        const c = ctx();
        let model = '';
        try {
            model = String(c.getChatCompletionModel?.() ?? c.chatCompletionSettings?.model ?? '');
        } catch {
            /* ignore */
        }
        if (model && !/gemini|argon/i.test(model)) out.push({ level: 'info', text: `🔷 Argon 호환이 켜져 있는데 지금 모델은 ${model}이에요. Gemini 4 Argon이 아니면 꺼도 돼요.` });
    }
    if (state.mvu && /Output only the story/.test(presetPromptContent('lm_think'))) {
        out.push({ level: 'info', text: 'MVU 감지: 추론의 "Output only the story" 줄은 확장이 보낼 때마다 "본문 뒤 변수 블록"으로 바꿔서 보내요.' });
    }
    return out;
}

// ---------------------------------------------------------------- per-character toggle sets

/** Snapshot of all optional toggles (택1 groups + 선택 entries). */
export function snapshotToggles() {
    const { groups, optional } = readToggles();
    const snap = {};
    for (const g of groups) for (const o of g.options) snap[o.id] = o.enabled;
    for (const o of optional) snap[o.id] = o.enabled;
    return snap;
}

export async function saveTogglesForCharacter() {
    await writeCharData({ toggles: snapshotToggles() });
}

export async function clearTogglesForCharacter() {
    await writeCharData({ toggles: null });
}

export async function applyCharacterToggles({ silent = false } = {}) {
    if (!detectLemona()) return 0;
    const saved = readCharData().toggles;
    if (!saved || typeof saved !== 'object') return 0;
    const known = new Set(Object.keys(snapshotToggles()));
    const changes = Object.fromEntries(Object.entries(saved).filter(([id]) => known.has(id)));
    const n = await setToggles(changes);
    if (n && !silent) toast('info', `이 캐릭터용 레모나 토글로 바꿨어요 (${n}개 변경).`);
    return n;
}

// ---------------------------------------------------------------- recommendations

function findByWord(list, word) {
    return list.find(x => (x.label ?? x.name ?? '').includes(word));
}

/** Turns an analysis `toggles` object into concrete Prompt Manager changes. */
export function recommendationChanges(rec) {
    if (!rec || !detectLemona()) return {};
    const { groups, optional } = readToggles();
    const changes = {};
    const botGroup = groups.find(g => g.label === '봇 유형');
    const botWord = RECOMMEND_MAP.bot_type[rec.bot_type];
    if (botGroup && botWord) {
        const pick = findByWord(botGroup.options, botWord);
        if (pick) for (const o of botGroup.options) changes[o.id] = o.id === pick.id;
    }
    const moodGroup = groups.find(g => g.label === '분위기');
    if (moodGroup && rec.mood) {
        const word = RECOMMEND_MAP.mood[rec.mood];
        const pick = word ? findByWord(moodGroup.options, word) : null;
        if (rec.mood === 'none' || pick) for (const o of moodGroup.options) changes[o.id] = pick ? o.id === pick.id : false;
    }
    for (const [flag, word] of Object.entries(RECOMMEND_MAP.flags)) {
        if (typeof rec[flag] !== 'boolean') continue;
        const entry = findByWord(optional, word);
        if (entry) changes[entry.id] = rec[flag];
    }
    // 혐성 and 젠틀 cannot both be on
    const harsh = findByWord(optional, RECOMMEND_MAP.flags.harsh);
    const gentle = findByWord(optional, RECOMMEND_MAP.flags.gentle);
    if (harsh && gentle && changes[harsh.id] && changes[gentle.id]) changes[gentle.id] = false;
    return changes;
}

/** Human-readable list of what `changes` would do. */
export function describeChanges(changes) {
    const { groups, optional } = readToggles();
    const names = new Map();
    for (const g of groups) for (const o of g.options) names.set(o.id, { name: `${g.label}: ${o.label}`, enabled: o.enabled });
    for (const o of optional) names.set(o.id, { name: o.name, enabled: o.enabled });
    return Object.entries(changes)
        .filter(([id, on]) => names.has(id) && names.get(id).enabled !== on)
        .map(([id, on]) => `${on ? '켜기' : '끄기'} · ${names.get(id).name}`);
}
