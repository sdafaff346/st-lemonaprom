// Prompt assembly. With the Lemona preset the insight goes right after </realism> and a checklist line
// goes into <thinkingProcess>; with any other preset it falls back to an in-chat extension prompt.

import { ctx, currentCharacter, getSettings, PROMPT_ROLE, PROMPT_TYPE, state } from './core.js';
import { activeProfile as pickProfile, buildInsightPrompt, isLongChatOnCard, THINK_LINE } from './insight.js';
import { buildMvuRulesPrompt, mvuActive, MVU_OUTPUT_FORMAT, readMvuState } from './mvu.js';
import { detectLemona, isActive } from './preset.js';
import { buildBreakerNote, detectRepeats, getHabits } from './repeat.js';

const KEYS = Object.freeze({
    insight: 'lemona_insight',
    rules: 'lemona_mvu_rules',
    format: 'lemona_mvu_format',
    breaker: 'lemona_breaker',
});

const ANCHORS = ['</realism>', '</narrative>', '</mainInstruction>'];

function lemonaChatCompletion() {
    return detectLemona() && ctx().mainApi === 'openai';
}

/** Profile for the prompt plus how to phrase it: chat version, card version, or card version softened for a long chat. */
export function insightForPrompt() {
    const s = getSettings();
    if (!s.insight_enabled || !currentCharacter()) return null;
    const active = pickProfile();
    if (!active) return null;
    return { profile: active.profile, opts: { source: active.source, soft: !!s.insight_soft_long && isLongChatOnCard(active, s) } };
}

export function activeProfile() {
    return insightForPrompt()?.profile ?? null;
}

export function clearInjection() {
    const { setExtensionPrompt } = ctx();
    for (const key of Object.values(KEYS)) setExtensionPrompt(key, '', PROMPT_TYPE.NONE, 0);
}

/** Extension prompts (everything that is not spliced into the Lemona prompt). Cheap; run before each generation. */
export function refreshInjection() {
    clearInjection();
    if (!isActive()) {
        document.dispatchEvent(new CustomEvent('lemona:injected'));
        return;
    }
    const s = getSettings();
    const c = ctx();
    const sub = t => c.substituteParams(t);
    const ins = insightForPrompt();
    const profile = ins?.profile ?? null;
    const mvuState = readMvuState(profile);

    if (profile && !lemonaChatCompletion()) {
        c.setExtensionPrompt(KEYS.insight, sub(buildInsightPrompt(profile, mvuState, ins.opts)), PROMPT_TYPE.IN_CHAT, Number(s.insight_fallback_depth) || 0, false, PROMPT_ROLE.system);
    }
    if (profile && mvuState && s.mvu_inject_rules) {
        c.setExtensionPrompt(KEYS.rules, sub(buildMvuRulesPrompt(profile, s)), PROMPT_TYPE.IN_CHAT, 0, false, PROMPT_ROLE.system);
        if (s.mvu_inject_format) c.setExtensionPrompt(KEYS.format, MVU_OUTPUT_FORMAT, PROMPT_TYPE.IN_CHAT, 0, false, PROMPT_ROLE.system);
    }
    if (s.repeat_enabled && currentCharacter()) {
        const note = buildBreakerNote(detectRepeats(), getHabits());
        if (note) c.setExtensionPrompt(KEYS.breaker, sub(note), PROMPT_TYPE.IN_CHAT, 1, false, PROMPT_ROLE.system);
    }
    document.dispatchEvent(new CustomEvent('lemona:injected'));
}

/** CHAT_COMPLETION_PROMPT_READY: splice into the assembled Lemona prompt. */
export function onPromptReady(eventData) {
    if (state.sideCall || state.lastGenType === 'quiet' || !isActive()) return;
    const chat = eventData?.chat;
    if (!Array.isArray(chat) || !lemonaChatCompletion()) return;
    const c = ctx();
    const s = getSettings();
    const isText = m => typeof m?.content === 'string';
    const thinkIdx = chat.findIndex(m => isText(m) && m.content.includes('<thinkingProcess>'));
    const ins = insightForPrompt();
    const profile = ins?.profile ?? null;

    if (profile) {
        const block = { role: 'system', content: c.substituteParams(buildInsightPrompt(profile, readMvuState(profile), ins.opts)) };
        let placed = false;
        for (const anchor of ANCHORS) {
            const idx = chat.findIndex(m => isText(m) && m.content.includes(anchor));
            if (idx !== -1) {
                chat.splice(idx + 1, 0, block);
                placed = true;
                break;
            }
        }
        if (!placed && thinkIdx !== -1) chat.splice(thinkIdx, 0, block);
    }

    const thinkAt = chat.findIndex(m => isText(m) && m.content.includes('<thinkingProcess>'));
    if (thinkAt === -1) return;
    let t = chat[thinkAt].content;
    if (profile && s.insight_think_line) {
        const line = c.substituteParams(THINK_LINE);
        t = t.includes('\nNarration is in') ? t.replace('\nNarration is in', `${line}\nNarration is in`) : t.replace('</thinkingProcess>', `${line.trimStart()}\n</thinkingProcess>`);
    }
    // Any MVU card needs its update block, not only ours
    if (mvuActive()) {
        t = t.replace('Output only the story.', 'Output only the story, then the variable-update block at the very end of the reply.');
    }
    chat[thinkAt].content = t;
}
