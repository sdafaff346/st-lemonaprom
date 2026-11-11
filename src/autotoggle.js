// Keeps Lemona's toggles in line when something outside the extension changes them:
//  - the connected model changes      → 🔷 Argon / 🔶 Carbon follow it
//  - a preset (re)loads, e.g. through a SillyTavern connection profile, which resets every toggle to
//    the preset file → the character's saved set is put back, then the model toggles
// Connection profiles fire several events in a row (source, model, preset), so changes are
// settled once things have been quiet for a moment, and checked once more right before sending.

import { ctx, currentCharacter, getSettings, LOG, toast } from './core.js';
import { applyCharacterToggles, currentModelName, detectLemona, isActive, modelFamily, modelToggleChanges, modelToggles, setToggles } from './preset.js';

const SETTLE_MS = 600;
const FAMILY_LABEL = { argon: 'Gemini 4 Argon', carbon: 'Gemini 4 Carbon' };

let lastSignature = null; // preset + model the model toggles were last matched to
let timer = null;
let pendingPreset = false;
let running = Promise.resolve();

function presetName() {
    return String(ctx().chatCompletionSettings?.preset_settings_openai ?? '');
}

function signature() {
    return `${presetName()}\u0000${currentModelName()}`;
}

function describe(model, changes) {
    const { argon, carbon } = modelToggles();
    const on = id => changes[id] === true;
    const family = modelFamily(model);
    const parts = [];
    if (carbon && carbon.id in changes) parts.push(`🔶 Carbon 호환 ${on(carbon.id) ? '켬' : '끔'}`);
    if (argon && argon.id in changes) parts.push(`🔷 Argon 호환 ${on(argon.id) ? '켬' : '끔'}`);
    const who = FAMILY_LABEL[family] ?? model;
    return `모델에 맞춰 토글을 바꿨어요 (${who}): ${parts.join(' · ')}`;
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
    if (!Object.keys(real).length) return 0;
    const n = await setToggles(real);
    if (n && !silent) toast('info', describe(model, real), '🍋 레모나');
    return n;
}

async function settle() {
    timer = null;
    const preset = pendingPreset;
    pendingPreset = false;
    if (!isActive() || !detectLemona()) return;
    const s = getSettings();
    if (preset && s.toggles_auto_apply && currentCharacter()) {
        // The preset just reloaded from its file, which undid the character's set
        try {
            const n = await applyCharacterToggles({ silent: true });
            if (n) toast('info', `프리셋을 다시 불러와서 이 캐릭터용 토글을 다시 적용했어요 (${n}개).`, '🍋 레모나');
        } catch (e) {
            console.warn(LOG, 'character toggles re-apply failed', e);
        }
    }
    await syncModelToggles({ force: preset });
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
    on(event_types.CONNECTION_PROFILE_LOADED, () => scheduleSettle({ preset: true }));
    on(event_types.OAI_PRESET_CHANGED_AFTER, () => scheduleSettle({ preset: true }));
}

/** For tests. */
export function _resetAutoToggle() {
    lastSignature = null;
    clearTimeout(timer);
    timer = null;
    pendingPreset = false;
    running = Promise.resolve();
}
