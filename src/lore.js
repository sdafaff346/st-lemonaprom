// Lorebook (World Info) reading for the insight analysis.
// Collects the enabled entries of the books tied to the open character (and the chat), drops
// technical entries (variables, scripts, status-bar HTML), ranks what is left by how much it is
// about this character, and fits it into a character budget.

import { ctx, getSettings, LOG } from './core.js';

const PER_ENTRY_MAX = 1500;

// Entries that steer formatting or variables rather than describe the story world
const TECH_TITLE = /initvar|\bmvu\b|mvu_|变量|변수|상태창|status ?bar|정규식|regex|美化|\bejs\b|\bhtml\b|\bcss\b|前端|프론트/i;
const TECH_BODY = /<%|\{\{\s*(?:setvar|getvar|addvar|incvar|decvar|setglobalvar)\b|\[InitVar\]|<script|<style|^\s*```/m;

async function worldInfoModule() {
    try {
        return await import('/scripts/world-info.js');
    } catch (e) {
        console.debug(LOG, 'world-info module not reachable', e);
        return null;
    }
}

function charaFilename(char) {
    return String(char?.avatar ?? '').replace(/\.[^/.]+$/, '');
}

/**
 * Books tied to the current character and chat, in the order SillyTavern itself would read them.
 * @returns {Promise<{name:string, kind:'character'|'extra'|'chat'|'persona'|'global'}[]>}
 */
export async function lorebookSources(char, settings = getSettings()) {
    const c = ctx();
    const wi = await worldInfoModule();
    const out = [];
    const add = (name, kind) => {
        if (name && typeof name === 'string' && !out.some(b => b.name === name)) out.push({ name, kind });
    };
    add(char?.data?.extensions?.world, 'character');
    const extra = wi?.world_info?.charLore?.find?.(e => e.name === charaFilename(char));
    for (const name of extra?.extraBooks ?? []) add(name, 'extra');
    add(c.chatMetadata?.world_info, 'chat');
    if (settings.lore_include_global) {
        for (const name of wi?.selected_world_info ?? []) add(name, 'global');
        add(c.powerUserSettings?.persona_description_lorebook, 'persona');
    }
    return out;
}

function stripMarkup(text) {
    return String(text ?? '')
        .replace(/<!--[\s\S]*?-->/g, '')
        .replace(/<\/?[a-z][^>\n]{0,200}>/gi, '')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

/** True for entries that are about formatting, variables or scripts rather than the story world. */
export function isTechnicalEntry(entry) {
    const title = `${entry.comment ?? ''} ${(entry.key ?? []).join(' ')}`;
    return TECH_TITLE.test(title) || TECH_BODY.test(String(entry.content ?? ''));
}

function entryList(data) {
    const entries = data?.entries;
    if (!entries) return [];
    return Array.isArray(entries) ? entries : Object.values(entries);
}

/** The card's own embedded book, used when it was never imported as a world. */
function embeddedEntries(char) {
    const book = char?.data?.character_book;
    if (!book?.entries?.length) return [];
    return book.entries.map(e => ({
        key: e.keys ?? [],
        comment: e.comment || e.name || '',
        content: e.content ?? '',
        constant: !!e.constant,
        disable: e.enabled === false,
        order: e.insertion_order ?? 100,
    }));
}

/**
 * Lorebook text for the analysis, within the configured budget.
 * @returns {Promise<{text:string, books:string[], used:number, total:number, skipped:number, cut:number}>}
 */
export async function collectLore(char, settings = getSettings()) {
    const empty = { text: '', books: [], used: 0, total: 0, skipped: 0, cut: 0 };
    if (!settings.lore_enabled || !char) return empty;
    const c = ctx();
    const sources = await lorebookSources(char, settings);
    const raw = [];
    for (const src of sources) {
        try {
            const data = await c.loadWorldInfo?.(src.name);
            for (const e of entryList(data)) raw.push({ ...e, book: src.name, kind: src.kind });
        } catch (e) {
            console.warn(LOG, `lorebook "${src.name}" could not be loaded`, e);
        }
    }
    // A card whose book was never imported still carries it inside the card
    if (!char.data?.extensions?.world) {
        for (const e of embeddedEntries(char)) raw.push({ ...e, book: `${char.name} (카드 내장)`, kind: 'character' });
    }

    const name = String(char.name ?? '').trim();
    let skipped = 0;
    const usable = [];
    for (const e of raw) {
        if (e.disable) continue;
        const content = stripMarkup(c.substituteParams ? c.substituteParams(String(e.content ?? '')) : e.content);
        if (content.length < 20) continue;
        if (isTechnicalEntry(e)) {
            skipped++;
            continue;
        }
        const keys = (Array.isArray(e.key) ? e.key : []).filter(Boolean);
        const title = String(e.comment ?? '').trim() || keys.slice(0, 3).join(', ') || '(제목 없음)';
        const head = `${title} ${keys.join(' ')} ${content.slice(0, 400)}`;
        let score = 0;
        if (e.constant) score += 3;
        if (name && head.includes(name)) score += 2;
        if (e.kind === 'character' || e.kind === 'extra') score += 1;
        else if (e.kind === 'chat') score += 0.5;
        usable.push({ title, keys, content, book: e.book, constant: !!e.constant, score, order: Number(e.order) || 0 });
    }
    usable.sort((a, b) => b.score - a.score || b.order - a.order);

    const budget = Math.max(1000, Number(settings.lore_budget) || 12000);
    const parts = [];
    const books = new Set();
    let size = 0;
    let cut = 0;
    for (const e of usable) {
        const body = e.content.length > PER_ENTRY_MAX ? `${e.content.slice(0, PER_ENTRY_MAX)} [...]` : e.content;
        const block = `### ${e.title}${e.constant ? ' (always on)' : e.keys.length ? ` (keys: ${e.keys.slice(0, 6).join(', ')})` : ''}\n${body}`;
        if (size + block.length > budget) {
            cut++;
            continue;
        }
        parts.push(block);
        books.add(e.book);
        size += block.length + 2;
    }
    return {
        text: parts.length ? `<lorebook>\n${parts.join('\n\n')}\n</lorebook>` : '',
        books: [...books],
        used: parts.length,
        total: usable.length,
        skipped,
        cut,
    };
}
