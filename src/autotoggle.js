// Keeps Lemona's toggles in line when something outside the extension changes them:
//  - the connected model changes → only 🔷 Argon / 🔶 Carbon and the reasoning effort follow it
//  - the SAME preset is loaded again (a SillyTavern connection profile does this) → the toggles on
//    screen are kept instead of falling back to the preset file, so a profile switch changes nothing
//    but the model toggles
//  - a DIFFERENT preset is loaded → its own file state becomes the user's baseline, then the
//    character's set (if it was saved for this preset) and the model toggles
// Connection profiles fire several events in a row (source, model, preset), so changes are
// settled once things have been quiet for a moment, and checked once more right before sending.

import { ctx, currentCharacter, getSettings, LOG, toast } from './core.js';
import { applyTogglesForChat, currentModelName, currentReasoning, detectLemona, isActive, modelFamily, modelToggleChanges, modelToggles, reasoningFor, resetForNewPreset, setReasoning, setToggles } from './preset.js';

const SETTLE_MS = 600;
const FAMILY_LABEL = { argon: 'Gemini 4 Argon', carbon: 'Gemini 4 Carbon' };

let lastSignature = null; // preset + model the model toggles were last matched to
let timer = null;
let pendingPreset = false;
let reload = null; // what the last OAI_PRESET_CHANGED_BEFORE saw: { kept, changed }
let running = Promise.resolve();

function presetName() {
    return String(ctx().chatCompletionSettings?.preset_settings_openai ?? '');
}

function signature() {
    return `${presetName()}\u0000${currentModelName()}`;
}

function describe(model, changes, reasoning) {
    const { argon, carbon } = modelToggles();
    const on = id => changes[id] === true;
    const family = modelFamily(model);
    const parts = [];
    if (carbon && carbon.id in changes) parts.push(`🔶 Carbon 호환 ${on(carbon.id) ? '켬' : '끔'}`);
    if (argon && argon.id in changes) parts.push(`🔷 Argon 호환 ${on(argon.id) ? '켬' : '끔'}`);
    if (reasoning) parts.push(`추론 강도 ${reasoning}`);
    const who = FAMILY_LABEL[family] ?? model;
    return `모델에 맞춰 바꿨어요 (${who}): ${parts.join(' · ')}`;
}

/**
 * Matches 🔷 / 🔶 to the connected model. Without `force` it only acts when the preset or the model
 * changed since last time, so a manual flip stays put until one of them changes.
 */
export async function syncModelToggles({ force = false, silent = false } = {}) {
    const s = getSettings();
    if (!s.model_auto_toggle || !isActive() || !detectLemona()) return 0;
    const sig = signature();
    if (!force && sig === lastSignature) return 0;
    lastSignature = sig;
    const model = currentModelName();
    const changes = modelToggleChanges(model, s);
    const { argon, carbon } = modelToggles();
    const live = Object.fromEntries([argon, carbon].filter(Boolean).map(o => [o.id, o.enabled]));
    const real = Object.fromEntries(Object.entries(changes).filter(([id, on]) => live[id] !== on));
    const n = Object.keys(real).length ? await setToggles(real) : 0;
    // Argon medium, Carbon low; any other model keeps whatever the user chose
    const effort = s.model_auto_reasoning ? reasoningFor(modelFamily(model)) : '';
    const reasoned = effort && currentReasoning() !== effort && setReasoning(effort) ? effort : '';
    if ((n || reasoned) && !silent) toast('info', describe(model, n ? real : {}, reasoned), '🍋 레모나');
    return n + (reasoned ? 1 : 0);
}

async function settle() {
    timer = null;
    const preset = pendingPreset;
    const seen = reload;
    pendingPreset = false;
    reload = null;
    if (!isActive() || !detectLemona()) return;
    const s = getSettings();
    // Same preset loaded again with its toggles kept: nothing to redo but the model toggles
    if (preset && !seen?.kept) {
        if (seen?.changed) resetForNewPreset();
        if (s.toggles_auto_apply && currentCharacter()) {
            try {
                await applyTogglesForChat();
            } catch (e) {
                console.warn(LOG, 'character toggles re-apply failed', e);
            }
        }
    }
    await syncModelToggles({ force: preset });
}

/**
 * OAI_PRESET_CHANGED_BEFORE hands over the preset about to be applied, and lets us edit it.
 * When it is the preset already in use (a connection profile re-selecting it), copy the toggles
 * on screen into it, so the user's choices and the character's set survive the reload.
 */
function onPresetBefore(data) {
    const s = getSettings();
    const same = !!data?.presetName && data.presetName === data.presetNameBefore;
    reload = { kept: false, changed: !same };
    if (!same || !s.enabled || !s.toggles_keep_on_reload || !detectLemona()) return;
    const pick = list => (Array.isArray(list) ? list.find(o => Number(o.character_id) === 100001) ?? list[0] : null);
    const now = pick(ctx().chatCompletionSettings?.prompt_order)?.order;
    const next = pick(data.preset?.prompt_order)?.order;
    if (!Array.isArray(now) || !Array.isArray(next)) return;
    const enabled = new Map(now.map(e => [e.identifier, !!e.enabled]));
    let kept = 0;
    for (const e of next) {
        if (enabled.has(e.identifier) && !!e.enabled !== enabled.get(e.identifier)) {
            e.enabled = enabled.get(e.identifier);
            kept++;
        }
    }
    // Reasoning effort is part of the preset too; the model sync after the reload decides it again
    if (data.preset && 'reasoning_effort' in data.preset && ctx().chatCompletionSettings?.reasoning_effort) {
        data.preset.reasoning_effort = ctx().chatCompletionSettings.reasoning_effort;
    }
    reload.kept = true;
    if (kept) console.info(LOG, `same preset reloaded; kept ${kept} toggle(s) as they were`);
}

function queue(fn) {
    running = running.then(fn, fn).catch(e => console.warn(LOG, 'toggle sync failed', e));
    return running;
}

/** Called for model, source, connection profile and preset events. */
export function scheduleSettle({ preset = false } = {}) {
    if (preset) pendingPreset = true;
    clearTimeout(timer);
    timer = setTimeout(() => queue(settle), SETTLE_MS);
}

/** Runs any pending settle now and checks the model once more; awaited before a generation. */
export function flushSettle() {
    if (timer) {
        clearTimeout(timer);
        return queue(settle);
    }
    return queue(() => syncModelToggles());
}

/** After a chat opens: the character set has just been applied, now the model toggles. */
export function afterCharacterToggles() {
    return queue(() => syncModelToggles());
}

export function registerAutoToggle() {
    const { eventSource, event_types } = ctx();
    const on = (name, fn) => name && eventSource.on(name, fn);
    on(event_types.CHATCOMPLETION_MODEL_CHANGED, () => scheduleSettle());
    on(event_types.CHATCOMPLETION_SOURCE_CHANGED, () => scheduleSettle());
    // A connection profile only reloads the preset if it names one, and that arrives as
    // OAI_PRESET_CHANGED_*; the profile itself just changes the model, which is all we follow
    on(event_types.CONNECTION_PROFILE_LOADED, () => scheduleSettle());
    on(event_types.OAI_PRESET_CHANGED_BEFORE, onPresetBefore);
    on(event_types.OAI_PRESET_CHANGED_AFTER, () => scheduleSettle({ preset: true }));
    // A typed-in model (custom endpoints, proxies) changes without CHATCOMPLETION_MODEL_CHANGED;
    // settings are saved right after, so check there. Cheap, and a no-op when nothing moved.
    on(event_types.SETTINGS_UPDATED, () => {
        if (lastSignature !== null && signature() !== lastSignature && !timer) scheduleSettle();
    });
}

/** For tests. */
export function _resetAutoToggle() {
    lastSignature = null;
    clearTimeout(timer);
    timer = null;
    pendingPreset = false;
    reload = null;
    running = Promise.resolve();
}
