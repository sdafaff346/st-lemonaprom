/**
 * 레모나 도우미 (Lemona Companion) — SillyTavern extension for the 레모나 v7 preset.
 *
 * 1. 캐해: two-layer reading + colliding value pairs, spliced after </realism> and into <thinkingProcess>
 * 2. MVU: stat_data.캐해 dynamic layer (mask crack, per-pair lean)
 * 3. 토글 도우미: 택1 groups, health check, per-character toggle sets, analysis-based recommendations
 * 4. 금지어 검수: live 「🚫 금지단어」 rules, highlight, AI fix with undo
 * 5. 반복 끊기: chat-specific breaker note built from recurring phrases and AI-found habits
 *
 * UI text is Korean; every string the model reads is English.
 */

import { decorateMessage, decorateRecent, fixableIssues, fixMessage, scanMessage, stillGenerating } from './src/bans.js';
import { ctx, currentCharacter, ensureFullCharacter, getSettings, LOG, state, toast } from './src/core.js';
import { onPromptReady, refreshInjection } from './src/inject.js';
import { buildInsightPrompt, loadProfile } from './src/insight.js';
import { readMvuState, watchForMvu } from './src/mvu.js';
import { applyCharacterToggles, detectLemona, healthCheck } from './src/preset.js';
import { analyzeHabits } from './src/repeat.js';
import { addMenuButtons, lastReplyId, mountSettings, openBanReport, openEditor, openToggles, runAnalysis, updateStatus } from './src/ui.js';

function decorate(mesId) {
    decorateMessage(Number(mesId), openBanReport);
}

async function maybeAutoFix(mesId) {
    const s = getSettings();
    if (!s.bans_enabled || !s.bans_auto_fix) return;
    const id = Number(mesId);
    if (id !== lastReplyId()) return;
    const m = ctx().chat?.[id];
    if (!m || m.extra?.lemona_original) return; // already fixed once
    if (stillGenerating(m)) return; // another extension is still filling this reply in
    const scan = scanMessage(id);
    if (scan && fixableIssues(scan.issues).length) await fixMessage(id);
}

function registerCommand() {
    const { SlashCommandParser, SlashCommand, SlashCommandArgument, ARGUMENT_TYPE } = ctx();
    if (!SlashCommandParser?.addCommandObject) return;
    const actions = ['analyze', 'edit', 'toggles', 'check', 'fix', 'habits', 'show', 'health'];
    SlashCommandParser.addCommandObject(
        SlashCommand.fromProps({
            name: 'lemona',
            aliases: ['caehae'],
            returns: 'text for "show" and "health", otherwise empty',
            callback: async (_named, unnamed) => {
                const [action = 'edit', arg] = String(unnamed ?? '').trim().split(/\s+/);
                const target = arg !== undefined && arg !== '' ? Number(arg) : lastReplyId();
                switch (action) {
                    case 'analyze':
                        await runAnalysis();
                        break;
                    case 'edit':
                        await openEditor();
                        break;
                    case 'toggles':
                        await openToggles();
                        break;
                    case 'check':
                        if (target >= 0) await openBanReport(target);
                        break;
                    case 'fix':
                        if (target >= 0) await fixMessage(target);
                        break;
                    case 'habits':
                        await analyzeHabits();
                        refreshInjection();
                        break;
                    case 'show': {
                        const p = currentCharacter() ? loadProfile() : null;
                        return p ? ctx().substituteParams(buildInsightPrompt(p, readMvuState(p))) : '';
                    }
                    case 'health':
                        return healthCheck()
                            .map(h => `${h.level === 'warn' ? '⚠' : 'ℹ'} ${h.text}`)
                            .join('\n');
                    default:
                        toast('warning', `사용법: /lemona ${actions.join('|')} [메시지번호]`);
                }
                return '';
            },
            unnamedArgumentList: [
                SlashCommandArgument.fromProps({
                    description: `${actions.join(' | ')} [message id]`,
                    typeList: [ARGUMENT_TYPE.STRING],
                    isRequired: false,
                    enumList: actions,
                }),
            ],
            helpString:
                '<div>레모나 도우미. <code>analyze</code> 카드 분석, <code>edit</code> 캐해 편집, <code>toggles</code> 토글 도우미, <code>check [번호]</code> 금지어 검사, <code>fix [번호]</code> AI로 고치기, <code>habits</code> AI 버릇 찾기, <code>show</code> 캐해 주입 텍스트, <code>health</code> 프리셋 점검.</div>',
        }),
    );
}

async function onChatChanged() {
    await ensureFullCharacter();
    detectLemona();
    if (getSettings().toggles_auto_apply && currentCharacter()) {
        try {
            await applyCharacterToggles();
        } catch (e) {
            console.warn(LOG, 'auto toggle apply failed', e);
        }
    }
    refreshInjection();
    updateStatus();
    setTimeout(() => decorateRecent(openBanReport), 300);
}

function init() {
    getSettings();
    detectLemona();
    mountSettings();
    addMenuButtons();
    registerCommand();

    const { eventSource, event_types } = ctx();
    eventSource.on(event_types.CHAT_CHANGED, onChatChanged);
    eventSource.on(event_types.GENERATION_AFTER_COMMANDS, (type, _opts, dryRun) => {
        if (!dryRun) state.lastGenType = type ?? 'normal';
        refreshInjection();
    });
    eventSource.on(event_types.CHAT_COMPLETION_PROMPT_READY, onPromptReady);
    eventSource.on(event_types.GENERATION_ENDED, () => {
        state.lastGenType = null;
        updateStatus();
    });
    eventSource.on(event_types.CHARACTER_EDITED, () => {
        refreshInjection();
        updateStatus();
    });
    for (const ev of [event_types.OAI_PRESET_CHANGED_AFTER, event_types.SETTINGS_UPDATED].filter(Boolean)) {
        eventSource.on(ev, () => {
            detectLemona();
            refreshInjection();
            updateStatus();
        });
    }
    eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, async mesId => {
        decorate(mesId);
        updateStatus();
        await maybeAutoFix(mesId);
    });
    for (const ev of [event_types.MESSAGE_UPDATED, event_types.MESSAGE_EDITED, event_types.MESSAGE_SWIPED].filter(Boolean)) {
        eventSource.on(ev, mesId => setTimeout(() => decorate(mesId), 50));
    }
    eventSource.on(event_types.MESSAGE_DELETED, () => updateStatus());
    document.addEventListener('lemona:busy', updateStatus);
    document.addEventListener('lemona:toggles', updateStatus);
    document.addEventListener('lemona:habits', updateStatus);

    watchForMvu(() => {
        refreshInjection();
        updateStatus();
    });
    refreshInjection();
    decorateRecent(openBanReport);
    console.info(LOG, 'loaded', detectLemona() ? '(Lemona preset detected)' : '(generic mode)');
}

(function boot() {
    const { eventSource, event_types } = ctx();
    eventSource.on(event_types.APP_READY, () => {
        try {
            init();
        } catch (e) {
            console.error(LOG, 'init failed', e);
            toast('error', String(e?.message ?? e), '레모나 도우미 로드 실패');
        }
    });
})();
