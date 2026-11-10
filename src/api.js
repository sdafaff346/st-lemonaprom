// Side API calls: a Connection Manager profile if one is chosen, otherwise the main API.

import { ctx, getSettings, LOG, state } from './core.js';

/** [{ id, name }] of usable connection profiles, or [] when Connection Manager is off. */
export function listProfiles() {
    try {
        const svc = ctx().ConnectionManagerRequestService;
        if (!svc?.getSupportedProfiles) return [];
        return svc.getSupportedProfiles().map(p => ({ id: p.id, name: p.name || p.id }));
    } catch {
        return [];
    }
}

function stripThinking(text) {
    return String(text ?? '')
        .replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, '')
        .trim();
}

/**
 * @param {string} system
 * @param {string} user
 * @param {{ maxTokens?: number }} [opts]
 * @returns {Promise<string>}
 */
export async function sideGenerate(system, user, opts = {}) {
    const s = getSettings();
    const maxTokens = Number(opts.maxTokens ?? s.api_max_tokens) || 2000;
    const c = ctx();
    state.sideCall = true;
    try {
        if (s.api_profile && c.ConnectionManagerRequestService) {
            const svc = c.ConnectionManagerRequestService;
            const messages = [
                { role: 'system', content: system },
                { role: 'user', content: user },
            ];
            const prompt = svc.constructPrompt ? svc.constructPrompt(messages, s.api_profile) : messages;
            const res = await svc.sendRequest(s.api_profile, prompt, maxTokens, {
                stream: false,
                extractData: true,
                includePreset: false,
                includeInstruct: true,
            });
            const text = typeof res === 'string' ? res : res?.content ?? '';
            console.debug(LOG, 'side reply (profile)', text);
            return stripThinking(text);
        }
        const text = await c.generateRaw({ systemPrompt: system, prompt: user, responseLength: maxTokens });
        console.debug(LOG, 'side reply (main API)', text);
        return stripThinking(text);
    } finally {
        state.sideCall = false;
    }
}
