// MVU dynamic layer: stat_data.캐해 { 가면균열, 기울기[], 최근갈등 }.

import { clamp, cleanText, ctx, getSettings, LIMITS, LOG, MVU_KEY, state, toPercent } from './core.js';
import { activeProfile } from './insight.js';

// The 가면균열 / 기울기 variables describe one person; a cast or a world has no single mask to track
const loadProfile = () => {
    const p = activeProfile()?.profile ?? null;
    return p && (p.kind ?? 'single') === 'single' ? p : null;
};
import { isActive } from './preset.js';

export function defaultMvuState(profile) {
    return { 가면균열: profile.base_crack, 기울기: profile.pairs.map(p => p.lean), 최근갈등: '' };
}

export function normalizeMvuState(raw, profile, fallback) {
    const src = raw && typeof raw === 'object' ? raw : {};
    const leans = Array.isArray(src.기울기) ? src.기울기 : [];
    return {
        가면균열: toPercent(src.가면균열, fallback.가면균열),
        기울기: profile.pairs.map((p, i) => toPercent(leans[i], fallback.기울기[i] ?? p.lean)),
        최근갈등: cleanText(src.최근갈등 ?? fallback.최근갈등, LIMITS.recent),
    };
}

export function mvuActive() {
    return !!state.mvu && getSettings().mvu_enabled;
}

/** stat_data of the newest message that carries MVU data (MVU stores it per swipe). */
function latestStatData() {
    const { chat } = ctx();
    for (let i = (chat?.length ?? 0) - 1; i >= 0; i--) {
        const m = chat[i];
        const vars = m?.variables?.[m.swipe_id ?? 0];
        if (vars && typeof vars === 'object' && vars.stat_data) return vars.stat_data;
    }
    return null;
}

export function readMvuState(profile) {
    if (!profile || (profile.kind ?? 'single') !== 'single' || !mvuActive()) return null;
    return normalizeMvuState(latestStatData()?.[MVU_KEY], profile, defaultMvuState(profile));
}

export function buildMvuRulesPrompt(profile, settings) {
    const d = settings.mvu_max_delta;
    const lines = [
        '<character_insight_variable_rules>',
        `Variables under \`${MVU_KEY}\` track how {{char}}'s inner logic is moving. Update them together with the other variables, using the same update format.`,
        `- ${MVU_KEY}.가면균열 (number 0-100): how much {{char}}'s inner layer shows through the surface right now. Raise it when the scene presses on their fear or wound, when they feel safe enough to drop their guard, or after a choice that cost them. Lower it when they regain composure, feel watched or threatened, or the scene returns to routine. Change by at most ${d} per reply; leave it unchanged when nothing relevant happens.`,
    ];
    if (profile.pairs.length) {
        const legend = profile.pairs.map((p, i) => `index ${i} = "${p.a}" (100) vs "${p.b}" (0)`).join('; ');
        lines.push(
            `- ${MVU_KEY}.기울기 (array of numbers 0-100, ${legend}): shift an entry only when {{char}} actually faces that dilemma on-screen or a story event clearly reshapes those values. Change by at most ${d} per reply. Keep the array length at ${profile.pairs.length}.`,
            `- ${MVU_KEY}.최근갈등 (string, under 25 words): when {{char}} faces one of the dilemmas, record which one, what they chose, and the aftermath. Otherwise keep the old value.`,
        );
    }
    lines.push(
        `JSON Patch paths: /${MVU_KEY}/가면균열, /${MVU_KEY}/기울기/<index>, /${MVU_KEY}/최근갈등.`,
        'The variable-update block is not part of the story and is always required: even when other instructions say to output only the story, finish the story first, then append the variable-update block at the very end of every reply. Never put it inside the thinking or the prose.',
        '</character_insight_variable_rules>',
    );
    return lines.join('\n');
}

// Adapted from StageDog/tavern_helper_template 初始模板/角色卡/世界书/变量/变量输出格式.yaml.
export const MVU_OUTPUT_FORMAT = `<variable_output_format>
rule:
  - you must output the update analysis and the actual update commands at once in the end of the next reply
  - the update commands works like the **JSON Patch (RFC 6902)** standard, must be a valid JSON array containing operation objects, but supports the following operations instead:
    - replace: replace the value of existing paths
    - delta: update the value of existing number paths by a delta value
    - insert: insert new items into an object or array (using \`-\` as array index intends appending to the end)
    - remove
    - move
  - don't update field names starts with \`_\` as they are readonly
format: |-
  <UpdateVariable>
  <Analysis>$(IN ENGLISH, no more than 80 words)
  - \${analyze every variable based on its rule, according only to current reply instead of previous plots: ...}
  </Analysis>
  <JSONPatch>
  [
    { "op": "replace", "path": "\${/path/to/variable}", "value": "\${new_value}" },
    { "op": "delta", "path": "\${/path/to/number/variable}", "value": "\${positive_or_negative_delta}" },
    ...
  ]
  </JSONPatch>
  </UpdateVariable>
</variable_output_format>`;

function hookMvu(Mvu, onReady) {
    if (state.mvu) return;
    state.mvu = Mvu;
    const { eventSource } = ctx();
    const ev = Mvu?.events ?? {};

    const onInit = variables => {
        const s = getSettings();
        if (!s.insight_enabled || !s.mvu_enabled || !variables || !isActive()) return;
        const profile = loadProfile();
        if (!profile) return;
        variables.stat_data ??= {};
        variables.stat_data[MVU_KEY] = defaultMvuState(profile);
    };
    new Set([ev.VARIABLE_INITIALIZED, 'mag_variable_initiailized', 'mag_variable_initialized'].filter(Boolean)).forEach(name => eventSource.on(name, onInit));

    eventSource.on(ev.VARIABLE_UPDATE_ENDED ?? 'mag_variable_update_ended', (variables, before) => {
        const s = getSettings();
        if (!s.insight_enabled || !s.mvu_enabled || !variables || !isActive()) return;
        const profile = loadProfile();
        if (!profile) return;
        const prev = normalizeMvuState(before?.stat_data?.[MVU_KEY], profile, defaultMvuState(profile));
        const next = normalizeMvuState(variables.stat_data?.[MVU_KEY], profile, prev);
        const d = s.mvu_max_delta;
        const cap = (v, p) => clamp(v, Math.max(0, p - d), Math.min(100, p + d));
        next.가면균열 = cap(next.가면균열, prev.가면균열);
        next.기울기 = next.기울기.map((v, i) => cap(v, prev.기울기[i]));
        variables.stat_data ??= {};
        variables.stat_data[MVU_KEY] = next;
    });

    console.info(LOG, 'MVU detected; dynamic layer enabled');
    onReady?.();
}

export function watchForMvu(onReady) {
    if (window.Mvu) return hookMvu(window.Mvu, onReady);
    const { eventSource } = ctx();
    const handler = () => {
        if (!window.Mvu) return;
        eventSource.removeListener('global_Mvu_initialized', handler);
        hookMvu(window.Mvu, onReady);
    };
    eventSource.on('global_Mvu_initialized', handler);
}
