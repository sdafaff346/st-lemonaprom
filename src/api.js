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

function findProfile(svc, id) {
    try {
        if (svc.getProfile) return svc.getProfile(id);
    } catch { /* fall through */ }
    return ctx().extensionSettings?.connectionManager?.profiles?.find(p => p.id === id) ?? null;
}

/**
 * Connection Manager leaves out Vertex AI's auth mode and Express project ID,
 * and uses the profile's URL field as the region. Without them the server falls
 * back to a us-central1 endpoint with no project, which Google refuses with
 * "API keys are not supported by this API". Fill them in from the main
 * Chat Completion settings, the same values the main chat already sends.
 */
function vertexOverrides(profile) {
    const api = String(profile?.api ?? '').toLowerCase();
    if (!api.includes('vertex')) return {};
    const oai = ctx().chatCompletionSettings ?? {};
    const out = {};
    if (oai.vertexai_auth_mode) out.vertexai_auth_mode = oai.vertexai_auth_mode;
    if (oai.vertexai_express_project_id) out.vertexai_express_project_id = oai.vertexai_express_project_id;
    const region = profile?.['api-url'] || oai.vertexai_region;
    if (region) out.vertexai_region = region;
    return out;
}

async function viaProfile(c, s, system, user, maxTokens) {
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
    }, vertexOverrides(findProfile(svc, s.api_profile)));
    const text = typeof res === 'string' ? res : res?.content ?? '';
    console.debug(LOG, 'side reply (profile)', text);
    return stripThinking(text);
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
            try {
                return await viaProfile(c, s, system, user, maxTokens);
            } catch (err) {
                // The profile failed (auth, region, missing key…). The main API is what
                // the chat itself uses, so try it once instead of leaving the user stuck.
                console.warn(LOG, 'profile request failed, retrying on the main API', err);
                globalThis.toastr?.warning(
                    `보조 API 프로필 요청이 실패해서 본 채팅 API로 다시 보냈어요. (${String(err?.message ?? err).slice(0, 160)})`,
                    '레모나 도우미', { timeOut: 8000 });
            }
        }
        const text = await c.generateRaw({ systemPrompt: system, prompt: user, responseLength: maxTokens });
        console.debug(LOG, 'side reply (main API)', text);
        return stripThinking(text);
    } finally {
        state.sideCall = false;
    }
}
