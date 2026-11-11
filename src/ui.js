// Settings drawer, insight editor, toggle helper and ban-check popups.

import { listProfiles } from './api.js';
import { decorateRecent, fixableIssues, fixMessage, scanMessage, TYPE_LABEL, undoFix } from './bans.js';
import { clamp, ctx, currentCharacter, defaultSettings, ensureFullCharacter, esc, getSettings, guarded, LIMITS, readCharData, requireCharacter, saveSettings, state, toast } from './core.js';
import { refreshInjection } from './inject.js';
import { analyzeCurrentCharacter, deleteProfile, emptyPair, LAYER_FIELDS, loadProfile, normalizeProfile, saveProfile } from './insight.js';
import { readMvuState } from './mvu.js';
import { buildInsightPrompt } from './insight.js';
import { applyCharacterToggles, clearTogglesForCharacter, describeChanges, detectLemona, FLAG_LABELS, healthCheck, readToggles, recommendationChanges, saveTogglesForCharacter, selectInGroup, setToggles } from './preset.js';
import { analyzeHabits, detectRepeats, getHabits, setHabits } from './repeat.js';

// ================================================================ insight editor

function leanLabel(p) {
    const a = p.a || 'A';
    const b = p.b || 'B';
    if (p.lean > 55) return `${a} 쪽 ${p.lean}`;
    if (p.lean < 45) return `${b} 쪽 ${100 - p.lean}`;
    return '팽팽함';
}

const BOT_LABEL = { original: '1차봇 오리지널', motif: '1차봇 모티브', korean: '2차봇 한국 장르', japanese: '2차봇 일본 애니·만화', western: '2차봇 서양 장르' };
const MOOD_LABEL = { none: '분위기 없음', slow: '썸·밀당', comedy: '일상 코미디', tense: '긴장·스릴러', work: '사건·일 중심' };

function recommendSummary(rec) {
    if (!rec) return '';
    const parts = [];
    if (rec.bot_type) parts.push(BOT_LABEL[rec.bot_type] + (rec.canon ? ` (${rec.canon})` : ''));
    if (rec.mood && rec.mood !== 'none') parts.push(MOOD_LABEL[rec.mood]);
    for (const [k, label] of Object.entries(FLAG_LABELS)) if (rec[k]) parts.push(label);
    return parts.join(' · ');
}

function editorHtml(draft, charName, unsaved) {
    const layers = LAYER_FIELDS.map(
        f => `
        <div class="lmc-field">
            <label>${esc(f.label)} <small>${esc(f.help)}</small><span class="lmc-count" data-count="layer:${f.key}"></span></label>
            <textarea class="text_pole" rows="2" maxlength="${LIMITS.layer}" data-layer="${f.key}">${esc(draft.layers[f.key])}</textarea>
        </div>`,
    ).join('');
    const rec = draft.recommend;
    const recHtml = rec
        ? `<section>
            <h4>③ 레모나 토글 추천</h4>
            <p class="lmc-rec"><b>${esc(recommendSummary(rec) || '추가로 켤 것 없음')}</b>${rec.reason ? `<br><small>${esc(rec.reason)}</small>` : ''}</p>
            <div class="lmc-rec-diff" data-rec-diff></div>
            <div class="menu_button lmc-inline" data-apply-rec><i class="fa-solid fa-wand-magic-sparkles"></i> 추천대로 토글 바꾸기</div>
        </section>`
        : '';
    return `
    <div class="lmc-editor">
        <h3>캐릭터 해석 · ${esc(charName)} ${unsaved ? '<span class="lmc-badge">새 분석 결과 · 저장 전</span>' : ''}</h3>
        <p class="lmc-hint">라벨 대신 <b>행동 문장</b>으로 적어 주세요. 예: "공정함" → "남이 새치기하면 참지 않고 지적한다"</p>
        <section>
            <h4>① 겉과 속</h4>
            ${layers}
            <div class="lmc-field">
                <label>평소 속마음 노출 정도 <small>MVU 가면균열의 시작값</small><span class="lmc-count" data-count="base_crack"></span></label>
                <input type="range" min="0" max="100" step="5" data-base-crack value="${draft.base_crack}" />
                <div class="lmc-scale"><span>철저히 감춤</span><span>다 드러남</span></div>
            </div>
        </section>
        <section>
            <h4>② 충돌하는 가치 쌍 <small data-pair-count></small></h4>
            <div data-pairs></div>
            <div class="menu_button lmc-inline" data-add-pair><i class="fa-solid fa-plus"></i> 가치 쌍 추가</div>
        </section>
        ${recHtml}
        <details class="lmc-preview">
            <summary>AI에게 들어가는 프롬프트 미리보기</summary>
            <pre data-preview></pre>
        </details>
    </div>`;
}

function pairHtml(p, i) {
    return `
    <div class="lmc-pair" data-pair="${i}">
        <div class="lmc-pair-head">
            <input class="text_pole" maxlength="${LIMITS.side}" placeholder="가치 A (예: 정의)" data-pf="a" value="${esc(p.a)}" />
            <span>vs</span>
            <input class="text_pole" maxlength="${LIMITS.side}" placeholder="가치 B (예: 동료)" data-pf="b" value="${esc(p.b)}" />
            <div class="menu_button fa-solid fa-trash-can" title="이 쌍 삭제" data-del-pair></div>
        </div>
        <div class="lmc-field">
            <label>기우는 쪽<span class="lmc-count" data-lean-label></span></label>
            <input type="range" min="0" max="100" step="5" data-pf="lean" value="${p.lean}" />
            <div class="lmc-scale"><span data-side="b">${esc(p.b || 'B')}</span><span>팽팽</span><span data-side="a">${esc(p.a || 'A')}</span></div>
        </div>
        <div class="lmc-field">
            <label>부딪힐 때 하는 행동<span class="lmc-count" data-count="behavior"></span></label>
            <textarea class="text_pole" rows="2" maxlength="${LIMITS.pair_text}" data-pf="behavior">${esc(p.behavior)}</textarea>
        </div>
        <div class="lmc-field">
            <label>반대로 골랐을 때의 대가<span class="lmc-count" data-count="cost"></span></label>
            <textarea class="text_pole" rows="2" maxlength="${LIMITS.pair_text}" data-pf="cost">${esc(p.cost)}</textarea>
        </div>
    </div>`;
}

function bindEditor(root, draft) {
    const q = sel => root.querySelector(sel);
    const updatePreview = () => {
        const pre = q('[data-preview]');
        if (!pre) return;
        const p = normalizeProfile(draft);
        pre.textContent = ctx().substituteParams(buildInsightPrompt(p, readMvuState(p)));
    };
    const updateRecDiff = () => {
        const el = q('[data-rec-diff]');
        if (!el) return;
        if (!detectLemona()) {
            el.textContent = '지금 프리셋이 레모나가 아니라 적용할 수 없어요.';
            return;
        }
        const diff = describeChanges(recommendationChanges(draft.recommend));
        el.innerHTML = diff.length ? diff.map(d => `<div>· ${esc(d)}</div>`).join('') : '<div>지금 토글이 이미 추천과 같아요.</div>';
    };
    const updateCounts = () => {
        for (const f of LAYER_FIELDS) q(`[data-count="layer:${f.key}"]`).textContent = `${draft.layers[f.key].length}/${LIMITS.layer}`;
        q('[data-count="base_crack"]').textContent = String(draft.base_crack);
        q('[data-pair-count]').textContent = `(${draft.pairs.length}/${LIMITS.max_pairs})`;
        q('[data-add-pair]').style.display = draft.pairs.length >= LIMITS.max_pairs ? 'none' : '';
        root.querySelectorAll('[data-pair]').forEach(el => {
            const p = draft.pairs[Number(el.dataset.pair)];
            if (!p) return;
            el.querySelector('[data-lean-label]').textContent = leanLabel(p);
            el.querySelector('[data-count="behavior"]').textContent = `${p.behavior.length}/${LIMITS.pair_text}`;
            el.querySelector('[data-count="cost"]').textContent = `${p.cost.length}/${LIMITS.pair_text}`;
            el.querySelector('[data-side="a"]').textContent = p.a || 'A';
            el.querySelector('[data-side="b"]').textContent = p.b || 'B';
        });
    };
    const renderPairs = () => {
        q('[data-pairs]').innerHTML = draft.pairs.map(pairHtml).join('');
        updateCounts();
        updatePreview();
    };
    root.addEventListener('input', e => {
        const t = e.target;
        if (t.dataset.layer) draft.layers[t.dataset.layer] = t.value;
        else if (t.hasAttribute('data-base-crack')) draft.base_crack = Number(t.value);
        else if (t.dataset.pf) {
            const p = draft.pairs[Number(t.closest('[data-pair]').dataset.pair)];
            p[t.dataset.pf] = t.dataset.pf === 'lean' ? Number(t.value) : t.value;
        } else return;
        updateCounts();
    });
    root.addEventListener('change', updatePreview);
    root.addEventListener('click', async e => {
        if (e.target.closest('[data-add-pair]')) {
            if (draft.pairs.length < LIMITS.max_pairs) draft.pairs.push(emptyPair());
            renderPairs();
        } else if (e.target.closest('[data-del-pair]')) {
            draft.pairs.splice(Number(e.target.closest('[data-pair]').dataset.pair), 1);
            renderPairs();
        } else if (e.target.closest('[data-apply-rec]')) {
            const n = await setToggles(recommendationChanges(draft.recommend));
            toast(n ? 'success' : 'info', n ? `토글 ${n}개를 바꿨어요.` : '바꿀 토글이 없어요.');
            updateRecDiff();
        }
    });
    q('details.lmc-preview').addEventListener('toggle', updatePreview);
    renderPairs();
    updateRecDiff();
}

export async function runAnalysis() {
    const cur = requireCharacter();
    if (!cur) return;
    const result = await guarded('analyze', async () => {
        const pending = toast('info', `${cur.char.name} 카드를 분석하는 중…`, '레모나', { timeOut: 0, extendedTimeOut: 0 });
        try {
            return await analyzeCurrentCharacter();
        } finally {
            toastr.clear(pending);
        }
    });
    if (result) {
        toast('success', '분석 완료. 내용을 확인하고 저장해 주세요.');
        await openEditor(result, true);
    }
}

export async function openEditor(initial = null, unsaved = false) {
    const cur = await ensureFullCharacter();
    if (!cur) return requireCharacter();
    const { Popup, POPUP_TYPE, POPUP_RESULT } = ctx();
    const RE_ANALYZE = POPUP_RESULT.CUSTOM1;
    const DELETE = POPUP_RESULT.CUSTOM2;
    const base = initial ?? loadProfile() ?? normalizeProfile({});
    const draft = { layers: { ...base.layers }, pairs: base.pairs.map(p => ({ ...p })), base_crack: base.base_crack, recommend: base.recommend };
    let dirty = unsaved;

    const popup = new Popup(editorHtml(draft, cur.char.name, unsaved), POPUP_TYPE.TEXT, '', {
        wide: true,
        large: true,
        allowVerticalScrolling: true,
        leftAlign: true,
        okButton: '저장',
        cancelButton: '닫기',
        customButtons: [
            { text: '다시 분석', icon: 'fa-wand-magic-sparkles', result: RE_ANALYZE },
            { text: '삭제', icon: 'fa-trash-can', result: DELETE },
        ],
        onOpen: p => {
            bindEditor(p.content, draft);
            p.content.addEventListener('input', () => (dirty = true));
        },
        onClosing: async p => {
            if (p.result === POPUP_RESULT.AFFIRMATIVE) {
                if (draft.pairs.some(x => (x.a || x.b) && !(x.a && x.b))) toast('warning', 'A와 B를 둘 다 적지 않은 가치 쌍은 저장되지 않아요.');
                return true;
            }
            if (p.result === DELETE) return (await Popup.show.confirm('캐릭터 해석 삭제', `${esc(cur.char.name)}의 캐릭터 해석을 삭제할까요?`)) === POPUP_RESULT.AFFIRMATIVE;
            if (dirty && p.result !== RE_ANALYZE) return (await Popup.show.confirm('저장하지 않고 닫기', '저장하지 않은 내용이 있어요. 닫을까요?')) === POPUP_RESULT.AFFIRMATIVE;
            return true;
        },
    });

    const result = await popup.show();
    if (result === POPUP_RESULT.AFFIRMATIVE) {
        await guarded('save', async () => {
            await saveProfile(draft);
            toast('success', '저장했어요. 다음 답변부터 적용돼요.');
        });
    } else if (result === DELETE) {
        await deleteProfile();
        toast('info', '삭제했어요.');
    } else if (result === RE_ANALYZE) {
        await runAnalysis();
    }
    refreshInjection();
    updateStatus();
}

// ================================================================ toggle helper

function togglesHtml() {
    if (!detectLemona()) return '<p>지금 채팅 완성 프리셋이 레모나가 아니에요. 레모나 프리셋을 고른 뒤 다시 열어 주세요.</p>';
    const { groups, optional } = readToggles();
    const cur = currentCharacter();
    const saved = cur ? readCharData().toggles : null;
    const rec = cur ? loadProfile()?.recommend : null;
    const groupRows = groups
        .map(g => {
            const on = g.options.filter(o => o.enabled);
            const opts = [`<option value="">(끔)</option>`, ...g.options.map(o => `<option value="${esc(o.id)}" ${o.enabled && on.length === 1 ? 'selected' : ''}>${esc(o.label)}</option>`)];
            if (on.length > 1) opts.unshift(`<option value="__multi" selected>⚠ ${on.length}개 켜짐</option>`);
            return `<div class="lmc-row"><label>${esc(g.icon)} ${esc(g.label)}</label><select class="text_pole" data-group="${esc(g.label)}">${opts.join('')}</select></div>`;
        })
        .join('');
    const optRows = optional
        .map(o => `<label class="checkbox_label lmc-opt"><input type="checkbox" data-opt="${esc(o.id)}" ${o.enabled ? 'checked' : ''} /> ${esc(o.name)}</label>`)
        .join('');
    const health = healthCheck()
        .map(h => `<div class="lmc-health lmc-health-${h.level}">${h.level === 'warn' ? '⚠' : 'ℹ'} ${esc(h.text)}</div>`)
        .join('');
    return `
    <div class="lmc-toggles">
        <h3>레모나 토글 도우미</h3>
        ${health || '<div class="lmc-health lmc-health-ok">✓ 토글 구성에 문제 없어요.</div>'}
        <h4>택1</h4>
        ${groupRows}
        <h4>선택 항목</h4>
        <div class="lmc-opts">${optRows}</div>
        ${
            cur
                ? `<h4>${esc(cur.char.name)} 전용</h4>
        <p class="lmc-hint">${saved ? '저장된 토글 세트가 있어요. 이 캐릭터 채팅을 열면 자동으로 적용돼요(설정에서 끌 수 있음).' : '저장된 토글 세트가 없어요.'}</p>
        <div class="flex-container">
            <div class="menu_button lmc-inline" data-save-char><i class="fa-solid fa-floppy-disk"></i> 지금 토글을 이 캐릭터용으로 저장</div>
            ${saved ? '<div class="menu_button lmc-inline" data-clear-char><i class="fa-solid fa-eraser"></i> 저장된 세트 지우기</div>' : ''}
            ${rec ? `<div class="menu_button lmc-inline" data-apply-rec title="${esc(recommendSummary(rec))}"><i class="fa-solid fa-wand-magic-sparkles"></i> 캐해 추천 적용</div>` : ''}
        </div>`
                : ''
        }
    </div>`;
}

export async function openToggles() {
    const { Popup, POPUP_TYPE } = ctx();
    let popup;
    const render = () => {
        if (popup?.content) popup.content.innerHTML = togglesHtml();
    };
    popup = new Popup(togglesHtml(), POPUP_TYPE.TEXT, '', {
        wide: true,
        allowVerticalScrolling: true,
        leftAlign: true,
        okButton: '닫기',
        onOpen: p => {
            p.content.addEventListener('change', async e => {
                const t = e.target;
                if (t.dataset.group !== undefined) {
                    if (t.value === '__multi') return;
                    await selectInGroup(t.dataset.group, t.value || null);
                } else if (t.dataset.opt) {
                    await setToggles({ [t.dataset.opt]: t.checked });
                }
                render();
            });
            p.content.addEventListener('click', async e => {
                if (e.target.closest('[data-save-char]')) {
                    await guarded('toggles-save', saveTogglesForCharacter);
                    toast('success', '이 캐릭터용 토글 세트를 저장했어요.');
                } else if (e.target.closest('[data-clear-char]')) {
                    await guarded('toggles-clear', clearTogglesForCharacter);
                    toast('info', '저장된 토글 세트를 지웠어요.');
                } else if (e.target.closest('[data-apply-rec]')) {
                    const n = await setToggles(recommendationChanges(loadProfile()?.recommend));
                    toast(n ? 'success' : 'info', n ? `토글 ${n}개를 바꿨어요.` : '이미 추천과 같아요.');
                } else return;
                render();
            });
        },
    });
    await popup.show();
    updateStatus();
}

// ================================================================ ban-check popup

export async function openBanReport(mesId) {
    const m = ctx().chat?.[mesId];
    const scan = scanMessage(mesId);
    if (!m || !scan) return;
    const { Popup, POPUP_TYPE, POPUP_RESULT } = ctx();
    const FIX = POPUP_RESULT.CUSTOM1;
    const UNDO = POPUP_RESULT.CUSTOM2;
    const rows = scan.issues.length
        ? scan.issues
              .map(i => {
                  const ctxText = i.type === 'structure' ? i.text : m.mes.slice(Math.max(0, i.index - 18), i.index + i.length + 18).replace(/\s+/g, ' ');
                  return `<tr><td><span class="lmc-tag lmc-ban-${i.type}">${TYPE_LABEL[i.type]}</span></td><td><b>${esc(i.type === 'structure' ? i.word : i.text)}</b>${i.note ? `<br><small>${esc(i.note)}</small>` : ''}</td><td class="lmc-ctx">${esc(ctxText)}</td></tr>`;
              })
              .join('')
        : '<tr><td colspan="3">문제 없음</td></tr>';
    const fixable = fixableIssues(scan.issues).length;
    const buttons = [];
    if (fixable) buttons.push({ text: `AI로 고치기 (${fixable})`, icon: 'fa-wand-magic-sparkles', result: FIX });
    if (m.extra?.lemona_original) buttons.push({ text: '고치기 전으로', icon: 'fa-rotate-left', result: UNDO });
    const html = `
    <div class="lmc-report">
        <h3>금지어 검사 · #${mesId}</h3>
        <p class="lmc-hint">기준: 지금 프리셋의 「🚫 금지단어」. 소유 표현은 사물 얘기일 수도 있어서 표시만 하고 고치지 않아요.</p>
        <table class="lmc-table"><tbody>${rows}</tbody></table>
    </div>`;
    const result = await new Popup(html, POPUP_TYPE.TEXT, '', { wide: true, allowVerticalScrolling: true, leftAlign: true, okButton: '닫기', customButtons: buttons }).show();
    if (result === FIX) await fixMessage(mesId);
    else if (result === UNDO && (await undoFix(mesId))) toast('info', '고치기 전으로 되돌렸어요.');
}

export function lastReplyId() {
    const { chat } = ctx();
    for (let i = (chat?.length ?? 0) - 1; i >= 0; i--) if (chat[i] && !chat[i].is_user && !chat[i].is_system) return i;
    return -1;
}

// ================================================================ settings drawer

function settingsHtml() {
    return `
    <div id="lmc_settings" class="extension_settings">
        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>🍋 레모나 도우미</b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content">
                <div class="lmc-status">
                    <span>캐릭터 <b id="lmc_st_char"></b></span>
                    <span>프리셋 <b id="lmc_st_preset"></b></span>
                    <span>캐해 <b id="lmc_st_insight"></b></span>
                    <span>MVU <b id="lmc_st_mvu"></b></span>
                </div>
                <div id="lmc_health"></div>

                <h4>🧠 캐릭터 해석</h4>
                <div class="flex-container">
                    <input id="lmc_analyze" class="menu_button" type="button" value="카드 분석" />
                    <input id="lmc_edit" class="menu_button" type="button" value="편집 열기" />
                </div>
                <label class="checkbox_label"><input id="lmc_insight_enabled" type="checkbox" /> 답변 생성 때 넣기 (레모나: 「👤 현실적·캐해」 바로 뒤)</label>
                <label class="checkbox_label"><input id="lmc_insight_think" type="checkbox" /> 「🔍 추론」 체크리스트에 캐해 확인 줄 추가</label>
                <div class="lmc-row"><label for="lm_insight_depth">다른 프리셋일 때 주입 깊이</label><input id="lmc_insight_depth" class="text_pole" type="number" min="0" max="20" /></div>

                <h4>🎛️ 토글 도우미</h4>
                <div class="flex-container"><input id="lmc_toggles" class="menu_button" type="button" value="토글 열기" /></div>
                <label class="checkbox_label"><input id="lmc_toggles_auto" type="checkbox" /> 캐릭터별로 저장한 토글을 채팅 열 때 자동 적용</label>

                <h4>🚫 금지어 검수</h4>
                <label class="checkbox_label"><input id="lmc_bans_enabled" type="checkbox" /> 답변마다 검사해서 표시</label>
                <label class="checkbox_label"><input id="lmc_bans_highlight" type="checkbox" /> 본문에 형광펜 표시</label>
                <label class="checkbox_label"><input id="lmc_bans_auto" type="checkbox" /> 새 답변은 AI로 자동 고치기 (API 호출이 늘어요)</label>
                <div class="flex-container"><input id="lmc_bans_last" class="menu_button" type="button" value="마지막 답변 검사" /></div>

                <h4>🔁 반복 끊기</h4>
                <label class="checkbox_label"><input id="lmc_repeat_enabled" type="checkbox" /> 최근 답변에서 반복되는 표현을 다음 답변에서 피하게 하기</label>
                <div class="lmc-row"><label for="lm_repeat_window">살펴볼 최근 답변 수</label><input id="lmc_repeat_window" class="text_pole" type="number" min="3" max="20" /></div>
                <div class="lmc-row"><label for="lm_repeat_min">몇 번 이상 나오면 반복으로 볼까</label><input id="lmc_repeat_min" class="text_pole" type="number" min="2" max="10" /></div>
                <div id="lmc_repeat_list" class="lmc-list"></div>
                <div class="flex-container">
                    <input id="lmc_habits_ai" class="menu_button" type="button" value="AI로 버릇 찾기" />
                    <input id="lmc_habits_clear" class="menu_button" type="button" value="버릇 목록 지우기" />
                </div>

                <h4>📊 MVU 연동</h4>
                <label class="checkbox_label"><input id="lmc_mvu" type="checkbox" /> 가면 균열·가치 기울기를 MVU 변수(stat_data.캐해)로 추적</label>
                <label class="checkbox_label"><input id="lmc_mvu_rules" type="checkbox" /> 변수 갱신 규칙 넣기</label>
                <label class="checkbox_label" title="카드에 이미 [mvu_update] 변수 출력 형식 항목이 있으면 끄세요"><input id="lmc_mvu_format" type="checkbox" /> 변수 출력 형식도 넣기 (MVU 카드가 아닐 때만)</label>
                <div class="lmc-row"><label for="lm_mvu_delta">한 턴 최대 변화량</label><input id="lmc_mvu_delta" class="text_pole" type="number" min="1" max="50" /></div>

                <h4>🔌 보조 API</h4>
                <small class="lmc-note">캐해 분석·금지어 고치기·버릇 찾기에 쓰여요. 연결 프로필을 고르면 본 채팅과 다른(싼) 모델을 쓸 수 있어요.</small>
                <div class="lmc-row"><label for="lm_api_profile">연결 프로필</label><select id="lmc_api_profile" class="text_pole"></select></div>
                <div class="lmc-row"><label for="lm_api_tokens">응답 길이 (토큰)</label><input id="lmc_api_tokens" class="text_pole" type="number" min="300" max="16000" step="100" /></div>
                <div class="lmc-row"><label for="lm_lang">분석 결과 언어</label>
                    <select id="lmc_lang" class="text_pole"><option value="preset">프리셋 서술 언어에 맞춤</option><option value="ko">한국어</option><option value="en">영어</option><option value="card">카드와 같은 언어</option></select></div>
                <small class="lmc-note">슬래시 커맨드: <code>/lemona analyze|edit|toggles|check|fix|habits|show</code></small>
            </div>
        </div>
    </div>`;
}

function fillProfiles() {
    const s = getSettings();
    const $sel = $('#lmc_api_profile');
    const profiles = listProfiles();
    $sel.empty().append('<option value="">본 채팅과 같은 API</option>');
    for (const p of profiles) $sel.append($('<option></option>').val(p.id).text(p.name));
    if (s.api_profile && !profiles.some(p => p.id === s.api_profile)) $sel.append($('<option></option>').val(s.api_profile).text('(찾을 수 없는 프로필)'));
    $sel.val(s.api_profile);
}

function bindSettings() {
    const s = getSettings();
    const after = () => {
        saveSettings();
        refreshInjection();
        updateStatus();
    };
    const check = (id, key) =>
        $(id)
            .prop('checked', !!s[key])
            .on('change', function () {
                s[key] = $(this).prop('checked');
                after();
            });
    const num = (id, key, lo, hi) =>
        $(id)
            .val(s[key])
            .on('change', function () {
                const n = Number($(this).val());
                s[key] = Number.isFinite(n) ? clamp(Math.round(n), lo, hi) : defaultSettings[key];
                $(this).val(s[key]);
                after();
            });
    const sel = (id, key) =>
        $(id)
            .val(s[key])
            .on('change', function () {
                s[key] = String($(this).val() ?? '');
                after();
            });

    check('#lmc_insight_enabled', 'insight_enabled');
    check('#lmc_insight_think', 'insight_think_line');
    num('#lmc_insight_depth', 'insight_fallback_depth', 0, 20);
    check('#lmc_toggles_auto', 'toggles_auto_apply');
    check('#lmc_bans_enabled', 'bans_enabled');
    check('#lmc_bans_highlight', 'bans_highlight');
    check('#lmc_bans_auto', 'bans_auto_fix');
    check('#lmc_repeat_enabled', 'repeat_enabled');
    num('#lmc_repeat_window', 'repeat_window', 3, 20);
    num('#lmc_repeat_min', 'repeat_min_count', 2, 10);
    check('#lmc_mvu', 'mvu_enabled');
    check('#lmc_mvu_rules', 'mvu_inject_rules');
    check('#lmc_mvu_format', 'mvu_inject_format');
    num('#lmc_mvu_delta', 'mvu_max_delta', 1, 50);
    num('#lmc_api_tokens', 'api_max_tokens', 300, 16000);
    sel('#lmc_lang', 'output_language');
    fillProfiles();
    sel('#lmc_api_profile', 'api_profile');
    $('#lmc_settings .inline-drawer-toggle').on('click', () => {
        fillProfiles();
        updateStatus();
    });

    $('#lmc_analyze').on('click', () => runAnalysis());
    $('#lmc_edit').on('click', () => openEditor());
    $('#lmc_toggles').on('click', () => openToggles());
    $('#lmc_bans_last').on('click', () => {
        const id = lastReplyId();
        if (id < 0) return toast('info', '검사할 AI 답변이 없어요.');
        openBanReport(id);
    });
    $('#lmc_habits_ai').on('click', async () => {
        await analyzeHabits();
        refreshInjection();
    });
    $('#lmc_habits_clear').on('click', () => {
        setHabits([]);
        refreshInjection();
    });
    $('#lmc_repeat_list').on('click', '[data-del-habit]', function () {
        const list = getHabits();
        list.splice(Number($(this).data('del-habit')), 1);
        setHabits(list);
        refreshInjection();
    });
}

export function updateStatus() {
    if (!$('#lmc_settings').length) return;
    const cur = currentCharacter();
    const lemona = detectLemona();
    $('#lmc_st_char').text(cur ? cur.char.name : '없음');
    $('#lmc_st_preset').text(lemona ? '레모나 ✓' : '다른 프리셋').toggleClass('lmc-ok', lemona);
    $('#lmc_st_insight').text(!cur ? '-' : loadProfile() ? '저장됨' : '없음');
    $('#lmc_st_mvu').text(state.mvu ? '감지됨' : '없음').toggleClass('lmc-ok', !!state.mvu);
    const health = healthCheck().filter(h => h.level === 'warn');
    $('#lmc_health').html(health.map(h => `<div class="lmc-health lmc-health-warn">⚠ ${esc(h.text)}</div>`).join(''));
    $('#lmc_analyze').prop('disabled', state.busy.has('analyze')).val(state.busy.has('analyze') ? '분석 중…' : '카드 분석');
    $('#lmc_habits_ai').prop('disabled', state.busy.has('habits')).val(state.busy.has('habits') ? '찾는 중…' : 'AI로 버릇 찾기');

    const s = getSettings();
    const repeats = s.repeat_enabled && cur ? detectRepeats() : [];
    const habits = cur ? getHabits() : [];
    const rows = [
        ...habits.map((h, i) => `<div class="lmc-item"><span class="lmc-tag">AI 버릇</span> ${esc(h.habit)}${h.example ? ` <small>“${esc(h.example)}”</small>` : ''} <i class="fa-solid fa-xmark interactable" title="지우기" data-del-habit="${i}"></i></div>`),
        ...repeats.map(r => `<div class="lmc-item"><span class="lmc-tag">${r.kind === 'opening' ? '첫 문장' : `${r.count}회`}</span> ${esc(r.phrase)}</div>`),
    ];
    $('#lmc_repeat_list').html(rows.length ? `<small>다음 답변에서 피할 것:</small>${rows.join('')}` : '<small>지금은 피할 반복이 없어요.</small>');
}

export function mountSettings() {
    $('#extensions_settings2').append(settingsHtml());
    bindSettings();
    updateStatus();
}

export function addMenuButtons() {
    const $menu = $('#extensionsMenu');
    if (!$menu.length) return;
    const item = (id, icon, label, fn) =>
        $(`<div id="${id}" class="list-group-item flex-container flexGap5 interactable" tabindex="0"><div class="fa-solid ${icon} extensionsMenuExtensionButton"></div><span>${label}</span></div>`).on('click', fn);
    $menu.append(item('lmc_menu_analyze', 'fa-masks-theater', '캐해 분석', () => runAnalysis()));
    $menu.append(item('lmc_menu_edit', 'fa-pen-to-square', '캐해 편집', () => openEditor()));
    $menu.append(item('lmc_menu_toggles', 'fa-sliders', '레모나 토글', () => openToggles()));
    $menu.append(
        item('lmc_menu_check', 'fa-ban', '마지막 답변 금지어 검사', () => {
            const id = lastReplyId();
            if (id >= 0) openBanReport(id);
        }),
    );
}

export { applyCharacterToggles, decorateRecent };
