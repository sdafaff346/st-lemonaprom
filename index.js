/**
 * 레모나 도우미 (Lemona Companion) — SillyTavern extension for the 레모나 v7 preset.
 *
 * 1. 캐해: two-layer reading + colliding value pairs, spliced after </realism> and into <thinkingProcess>
 * 2. MVU: stat_data.캐해 dynamic layer (mask crack, per-pair lean)
 * 3. 토글 도우미: 택1 groups, health check, per-character toggle sets, analysis-based recommendations,
 *    🔷 Argon / 🔶 Carbon following the connected model
 * 4. 금지어 검수: live 「🚫 금지단어」 rules, highlight, AI fix with undo
 * 5. 반복 끊기: chat-specific breaker note built from recurring phrases and AI-found habits
 *
 * UI text is Korean; every string the model reads is English.
 */

import { afterCharacterToggles, flushSettle, registerAutoToggle, scheduleSettle } from './src/autotoggle.js';
import { decorateMessage, decorateRecent, fixableIssues, fixMessage, scanMessage, stillGenerating } from './src/bans.js';
import { ctx, currentCharacter, ensureFullCharacter, getSettings, LOG, state, toast } from './src/core.js';
import { insightForPrompt, onPromptReady, refreshInjection } from './src/inject.js';
import { buildInsightPrompt } from './src/insight.js';
import { readMvuState, watchForMvu } from './src/mvu.js';
import { applyCharacterToggles, detectLemona, healthCheck, inactiveReason, isActive } from './src/preset.js';
import { analyzeHabits } from './src/repeat.js';
import { addMenuButtons, applyActiveState, lastReplyId, mountSettings, openBanReport, openEditor, openToggles, runAnalysis, runChatAnalysis, setPower, syncActiveState, updateStatus } from './src/ui.js';

function decorate(mesId) {
    decorateMessage(Number(mesId), openBanReport);
}

async function maybeAutoFix(mesId) {
    const s = getSettings();
    if (!isActive() || !s.bans_enabled || !s.bans_auto_fix) return;
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
    const actions = ['analyze', 'reread', 'edit', 'toggles', 'check', 'fix', 'habits', 'show', 'health', 'on', 'off'];
    SlashCommandParser.addCommandObject(
        SlashCommand.fromProps({
            name: 'lemona',
            aliases: ['caehae'],
            returns: 'text for "show" and "health", otherwise empty',
            callback: async (_named, unnamed) => {
                const [action = 'edit', arg] = String(unnamed ?? '').trim().split(/\s+/);
                const target = arg !== undefined && arg !== '' ? Number(arg) : lastReplyId();
                if (action === 'on' || action === 'off') {
                    setPower({ enabled: action === 'on' });
                    return '';
                }
                // Everything else waits while the extension is off or sleeping on another preset
                const reason = inactiveReason();
                if (reason && action !== 'health') {
                    toast('info', reason === 'off' ? '레모나 도우미가 꺼져 있어요. /lemona on 으로 켤 수 있어요.' : '레모나 프리셋이 아니라서 쉬고 있어요.');
                    return '';
                }
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
                    case 'reread':
                        await runChatAnalysis();
                        break;
                    case 'show': {
                        const ins = currentCharacter() ? insightForPrompt() : null;
                        return ins ? ctx().substituteParams(buildInsightPrompt(ins.profile, readMvuState(ins.profile), ins.opts)) : '';
                    }
                    case 'health':
                        if (reason) return reason === 'off' ? '레모나 도우미가 꺼져 있어요.' : '레모나 프리셋이 아니라서 쉬고 있어요.';
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
                '<div>레모나 도우미. <code>analyze</code> 카드 분석, <code>edit</code> 캐해 편집, <code>toggles</code> 토글 도우미, <code>check [번호]</code> 금지어 검사, <code>fix [번호]</code> AI로 고치기, <code>habits</code> AI 버릇 찾기, <code>show</code> 캐해 주입 텍스트, <code>health</code> 프리셋 점검, <code>on</code> / <code>off</code> 켜기·끄기.</div>',
        }),
    );
}

async function onChatChanged() {
    await ensureFullCharacter();
    detectLemona();
    if (isActive() && getSettings().toggles_auto_apply && currentCharacter()) {
        try {
            await applyCharacterToggles();
        } catch (e) {
            console.warn(LOG, 'auto toggle apply failed', e);
        }
    }
    await afterCharacterToggles();
    applyActiveState({ announce: true });
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
    eventSource.on(event_types.GENERATION_AFTER_COMMANDS, async (type, _opts, dryRun) => {
        if (!dryRun) state.lastGenType = type ?? 'normal';
        // In case a preset switch slipped past the preset events, settle the state before sending
        syncActiveState();
        // SillyTavern awaits this event before building the prompt, so toggles fixed here count now
        if (!dryRun && type !== 'quiet') {
            try {
                await flushSettle();
            } catch (e) {
                console.warn(LOG, 'toggle sync before sending failed', e);
            }
        }
        refreshInjection();
    });
    eventSource.on(event_types.CHAT_COMPLETION_PROMPT_READY, onPromptReady);
    registerAutoToggle();
    scheduleSettle(); // match 🔷 / 🔶 to whatever model is connected at startup
    eventSource.on(event_types.GENERATION_ENDED, () => {
        state.lastGenType = null;
        updateStatus();
    });
    eventSource.on(event_types.CHARACTER_EDITED, () => {
        refreshInjection();
        updateStatus();
    });
    for (const ev of [event_types.OAI_PRESET_CHANGED_AFTER, event_types.SETTINGS_UPDATED].filter(Boolean)) {
        // Switching presets can wake the extension up or put it to sleep
        eventSource.on(ev, () => applyActiveState({ announce: true }));
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
    console.info(LOG, 'loaded', detectLemona() ? '(Lemona preset detected)' : '(generic mode)', isActive() ? '' : `(inactive: ${inactiveReason()})`);
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
