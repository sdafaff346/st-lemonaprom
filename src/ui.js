// Settings drawer, insight editor, toggle helper and ban-check popups.
// Everything we draw lives inside `.lmc-ui`, a fixed light lemon palette that reads the same on
// any SillyTavern theme (dark themes included), so colours never depend on the user's theme.

import { listProfiles } from './api.js';
import { decorateRecent, fixableIssues, fixMessage, scanMessage, TYPE_LABEL, undoFix } from './bans.js';
import { clamp, ctx, currentCharacter, defaultSettings, ensureFullCharacter, esc, getSettings, guarded, LIMITS, readCharData, requireCharacter, saveSettings, state, toast } from './core.js';
import { refreshInjection } from './inject.js';
import { syncModelToggles } from './autotoggle.js';
import { analyzeCurrentCharacter, buildInsightPrompt, deleteProfile, emptyPair, emptyRelation, LAYER_FIELDS, loadProfile, normalizeProfile, saveProfile } from './insight.js';
import { readMvuState } from './mvu.js';
import { applyCharacterToggles, clearTogglesForCharacter, describeChanges, detectLemona, FLAG_LABELS, healthCheck, inactiveReason, isActive, modelToggleIds, readToggles, recommendationChanges, saveTogglesForCharacter, selectInGroup, setToggles } from './preset.js';
import { analyzeHabits, detectRepeats, getHabits, setHabits } from './repeat.js';

const VERSION = '1.4.0';

// ================================================================ small building blocks

/** A labelled on/off switch row. */
function switchRow(id, title, desc = '') {
    return `
    <label class="lmc-srow" for="${id}">
        <span class="lmc-srow-text">${title}${desc ? `<small>${desc}</small>` : ''}</span>
        <span class="lmc-switch"><input type="checkbox" id="${id}" /><i aria-hidden="true"></i></span>
    </label>`;
}

function numberRow(id, title, min, max, step = 1, desc = '') {
    return `
    <label class="lmc-frow" for="${id}">
        <span class="lmc-srow-text">${title}${desc ? `<small>${desc}</small>` : ''}</span>
        <input class="lmc-input lmc-input-num" id="${id}" type="number" min="${min}" max="${max}" step="${step}" />
    </label>`;
}

function selectRow(id, title, options = '', desc = '') {
    return `
    <label class="lmc-frow lmc-frow-wide" for="${id}">
        <span class="lmc-srow-text">${title}${desc ? `<small>${desc}</small>` : ''}</span>
        <select class="lmc-input" id="${id}">${options}</select>
    </label>`;
}

function card(icon, title, sub, body, open = false) {
    return `
    <details class="lmc-card"${open ? ' open' : ''}>
        <summary><span class="lmc-card-ico">${icon}</span><span class="lmc-card-title">${title}<small>${sub}</small></span><span class="lmc-card-chev" aria-hidden="true"></span></summary>
        <div class="lmc-card-body">${body}</div>
    </details>`;
}

/** Native popup content wrapper with the lemon header band. */
function popupFrame(title, sub, body, extraClass = '') {
    return `
    <div class="lmc-ui lmc-pop ${extraClass}">
        <div class="lmc-pop-head">
            <span class="lmc-slice lmc-slice-sm" aria-hidden="true"></span>
            <div><div class="lmc-pop-title">${title}</div>${sub ? `<div class="lmc-pop-sub">${sub}</div>` : ''}</div>
        </div>
        ${body}
    </div>`;
}

function setRangeFill(input) {
    const min = Number(input.min) || 0;
    const max = Number(input.max) || 100;
    input.style.setProperty('--v', `${((Number(input.value) - min) / (max - min)) * 100}%`);
}

// ================================================================ insight editor

function leanLabel(p) {
    const a = p.a || 'A';
    const b = p.b || 'B';
    if (p.lean > 55) return `${a} 쪽 ${p.lean}`;
    if (p.lean < 45) return `${b} 쪽 ${100 - p.lean}`;
    return '팽팽해요';
}

const BOT_LABEL = { original: '1차봇 오리지널', motif: '1차봇 모티브', korean: '2차봇 한국 장르', japanese: '2차봇 일본 애니·만화', western: '2차봇 서양 장르' };
const MOOD_LABEL = { none: '분위기 없음', slow: '썸·밀당', comedy: '일상 코미디', tense: '긴장·스릴러', work: '사건·일 중심' };

function recommendSummary(rec) {
    if (!rec) return [];
    const parts = [];
    if (rec.bot_type) parts.push(BOT_LABEL[rec.bot_type] + (rec.canon ? ` (${rec.canon})` : ''));
    if (rec.mood && rec.mood !== 'none') parts.push(MOOD_LABEL[rec.mood]);
    for (const [k, label] of Object.entries(FLAG_LABELS)) if (rec[k]) parts.push(label);
    return parts;
}

function editorHtml(draft, charName, unsaved) {
    const layers = LAYER_FIELDS.map(
        f => `
        <div class="lmc-field">
            <div class="lmc-field-head"><b>${esc(f.label)}</b><small>${esc(f.help)}</small><span class="lmc-count" data-count="layer:${f.key}"></span></div>
            <textarea class="lmc-input lmc-textarea" rows="2" maxlength="${LIMITS.layer}" data-layer="${f.key}">${esc(draft.layers[f.key])}</textarea>
        </div>`,
    ).join('');
    const rec = draft.recommend;
    const recChips = recommendSummary(rec);
    const recHtml = rec
        ? `<section class="lmc-sec">
            <h4><span class="lmc-num">4</span>레모나 토글 추천</h4>
            <div class="lmc-chips">${recChips.length ? recChips.map(c => `<span class="lmc-chip lmc-chip-lemon">${esc(c)}</span>`).join('') : '<span class="lmc-chip">추가로 켤 것 없음</span>'}</div>
            ${rec.reason ? `<p class="lmc-hint">${esc(rec.reason)}</p>` : ''}
            <div class="lmc-diff" data-rec-diff></div>
            <button type="button" class="lmc-btn lmc-btn-leaf" data-apply-rec><i class="fa-solid fa-wand-magic-sparkles"></i> 추천대로 토글 바꾸기</button>
        </section>`
        : '';
    let body = `
        <p class="lmc-note-box">라벨 대신 <b>행동 문장</b>으로 적어 주세요. <span class="lmc-strike">공정함</span> → 남이 새치기하면 참지 않고 지적한다</p>
        <section class="lmc-sec">
            <h4><span class="lmc-num">1</span>겉과 속</h4>
            <div class="lmc-layer-grid">${layers}</div>
            <div class="lmc-field">
                <div class="lmc-field-head"><b>평소 속마음 노출</b><small>MVU 가면 균열의 시작값</small><span class="lmc-count" data-count="base_crack"></span></div>
                <input type="range" class="lmc-range lmc-range-crack" min="0" max="100" step="5" data-base-crack value="${draft.base_crack}" />
                <div class="lmc-scale"><span>철저히 감춤</span><span>다 드러남</span></div>
            </div>
        </section>
        <section class="lmc-sec">
            <h4><span class="lmc-num">2</span>부딪히는 가치 쌍 <small data-pair-count></small></h4>
            <div data-pairs></div>
            <button type="button" class="lmc-btn lmc-btn-ghost" data-add-pair><i class="fa-solid fa-plus"></i> 가치 쌍 추가</button>
        </section>
        <section class="lmc-sec">
            <h4><span class="lmc-num">3</span>사람에 따라 <small data-rel-count></small></h4>
            <p class="lmc-hint">이 사람 앞에서만 겉이나 속이 다르게 드러나는 방식이에요. 그 사람이 장면에 있을 때만 써요.</p>
            <div data-relations></div>
            <button type="button" class="lmc-btn lmc-btn-ghost" data-add-rel><i class="fa-solid fa-plus"></i> 사람 추가</button>
        </section>
        ${recHtml}
        <details class="lmc-preview">
            <summary>AI에게 들어가는 프롬프트 미리보기</summary>
            <pre data-preview></pre>
        </details>`;
    const lore = draft.lore;
    const loreLine = lore?.used
        ? `<p class="lmc-lore-line"><i class="fa-solid fa-book-atlas"></i> 로어북 ${lore.used}개 항목도 같이 읽었어요${lore.books.length ? `<small>${lore.books.map(esc).join(' · ')}</small>` : ''}</p>`
        : '';
    body = loreLine + body;
    const sub = `${esc(charName)}${unsaved ? ' <span class="lmc-pill lmc-pill-new">새 분석 · 저장 전</span>' : ''}`;
    return popupFrame('캐릭터 해석', sub, body, 'lmc-editor');
}

function pairHtml(p, i) {
    return `
    <div class="lmc-pair" data-pair="${i}">
        <div class="lmc-pair-head">
            <input class="lmc-input lmc-pair-a" maxlength="${LIMITS.side}" placeholder="가치 A (예: 정의)" data-pf="a" value="${esc(p.a)}" />
            <span class="lmc-vs">vs</span>
            <input class="lmc-input lmc-pair-b" maxlength="${LIMITS.side}" placeholder="가치 B (예: 동료)" data-pf="b" value="${esc(p.b)}" />
            <button type="button" class="lmc-icon-btn" title="이 쌍 삭제" aria-label="이 쌍 삭제" data-del-pair><i class="fa-solid fa-trash-can"></i></button>
        </div>
        <div class="lmc-field">
            <div class="lmc-field-head"><b>기우는 쪽</b><span class="lmc-count lmc-count-strong" data-lean-label></span></div>
            <input type="range" class="lmc-range lmc-range-lean" min="0" max="100" step="5" data-pf="lean" value="${p.lean}" />
            <div class="lmc-scale"><span class="lmc-side-b" data-side="b">${esc(p.b || 'B')}</span><span>팽팽</span><span class="lmc-side-a" data-side="a">${esc(p.a || 'A')}</span></div>
        </div>
        <div class="lmc-field">
            <div class="lmc-field-head"><b>부딪힐 때 하는 행동</b><span class="lmc-count" data-count="behavior"></span></div>
            <textarea class="lmc-input lmc-textarea" rows="2" maxlength="${LIMITS.pair_text}" data-pf="behavior">${esc(p.behavior)}</textarea>
        </div>
        <div class="lmc-field">
            <div class="lmc-field-head"><b>반대로 골랐을 때의 대가</b><span class="lmc-count" data-count="cost"></span></div>
            <textarea class="lmc-input lmc-textarea" rows="2" maxlength="${LIMITS.pair_text}" data-pf="cost">${esc(p.cost)}</textarea>
        </div>
    </div>`;
}

function relationHtml(r, i) {
    return `
    <div class="lmc-rel" data-rel="${i}">
        <div class="lmc-rel-head">
            <input class="lmc-input lmc-rel-who" maxlength="${LIMITS.who}" placeholder="이름 (예: 여동생 하린)" data-rf="who" value="${esc(r.who)}" />
            <button type="button" class="lmc-icon-btn" title="이 사람 삭제" aria-label="이 사람 삭제" data-del-rel><i class="fa-solid fa-trash-can"></i></button>
        </div>
        <div class="lmc-field">
            <div class="lmc-field-head"><b>이 사람 앞에서</b><span class="lmc-count" data-count="shows"></span></div>
            <textarea class="lmc-input lmc-textarea" rows="2" maxlength="${LIMITS.relation}" placeholder="예: 이 사람한테만 존댓말을 놓는다. 감춰 둔 두려움이 과보호로 새어 나온다." data-rf="shows">${esc(r.shows)}</textarea>
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
            el.innerHTML = '<span class="lmc-muted">지금 프리셋이 레모나가 아니라 적용할 수 없어요.</span>';
            return;
        }
        const diff = describeChanges(recommendationChanges(draft.recommend));
        el.innerHTML = diff.length
            ? diff.map(d => `<div class="lmc-diff-row ${d.startsWith('켜기') ? 'is-on' : 'is-off'}">${esc(d)}</div>`).join('')
            : '<span class="lmc-muted">지금 토글이 이미 추천과 같아요.</span>';
    };
    const updateCounts = () => {
        for (const f of LAYER_FIELDS) q(`[data-count="layer:${f.key}"]`).textContent = `${draft.layers[f.key].length}/${LIMITS.layer}`;
        q('[data-count="base_crack"]').textContent = String(draft.base_crack);
        q('[data-pair-count]').textContent = `${draft.pairs.length}/${LIMITS.max_pairs}`;
        q('[data-add-pair]').style.display = draft.pairs.length >= LIMITS.max_pairs ? 'none' : '';
        q('[data-rel-count]').textContent = `${draft.relations.length}/${LIMITS.max_relations}`;
        q('[data-add-rel]').style.display = draft.relations.length >= LIMITS.max_relations ? 'none' : '';
        root.querySelectorAll('[data-rel]').forEach(el => {
            const r = draft.relations[Number(el.dataset.rel)];
            if (r) el.querySelector('[data-count="shows"]').textContent = `${r.shows.length}/${LIMITS.relation}`;
        });
        root.querySelectorAll('[data-pair]').forEach(el => {
            const p = draft.pairs[Number(el.dataset.pair)];
            if (!p) return;
            el.querySelector('[data-lean-label]').textContent = leanLabel(p);
            el.querySelector('[data-count="behavior"]').textContent = `${p.behavior.length}/${LIMITS.pair_text}`;
            el.querySelector('[data-count="cost"]').textContent = `${p.cost.length}/${LIMITS.pair_text}`;
            el.querySelector('[data-side="a"]').textContent = p.a || 'A';
            el.querySelector('[data-side="b"]').textContent = p.b || 'B';
        });
        root.querySelectorAll('input[type=range]').forEach(setRangeFill);
    };
    const renderPairs = () => {
        q('[data-pairs]').innerHTML = draft.pairs.length ? draft.pairs.map(pairHtml).join('') : '<p class="lmc-empty">아직 가치 쌍이 없어요.</p>';
        updateCounts();
        updatePreview();
    };
    const renderRelations = () => {
        q('[data-relations]').innerHTML = draft.relations.length ? draft.relations.map(relationHtml).join('') : '<p class="lmc-empty">따로 적을 사람이 없어요.</p>';
        updateCounts();
        updatePreview();
    };
    root.addEventListener('input', e => {
        const t = e.target;
        if (t.dataset.layer) draft.layers[t.dataset.layer] = t.value;
        else if (t.dataset.rf) draft.relations[Number(t.closest('[data-rel]').dataset.rel)][t.dataset.rf] = t.value;
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
        } else if (e.target.closest('[data-add-rel]')) {
            if (draft.relations.length < LIMITS.max_relations) draft.relations.push(emptyRelation());
            renderRelations();
        } else if (e.target.closest('[data-del-rel]')) {
            draft.relations.splice(Number(e.target.closest('[data-rel]').dataset.rel), 1);
            renderRelations();
        } else if (e.target.closest('[data-apply-rec]')) {
            const n = await setToggles(recommendationChanges(draft.recommend));
            toast(n ? 'success' : 'info', n ? `토글 ${n}개를 바꿨어요.` : '바꿀 토글이 없어요.');
            updateRecDiff();
        }
    });
    q('details.lmc-preview').addEventListener('toggle', updatePreview);
    renderPairs();
    renderRelations();
    updateRecDiff();
}

function requireActive() {
    const reason = inactiveReason();
    if (!reason) return true;
    toast('info', reason === 'off' ? '레모나 도우미가 꺼져 있어요. 확장 패널에서 켜 주세요.' : '레모나 프리셋이 아니라서 쉬고 있어요. 확장 패널에서 "레모나 프리셋에서만 켜기"를 끄면 다른 프리셋에서도 쓸 수 있어요.');
    return false;
}

export async function runAnalysis() {
    if (!requireActive()) return;
    const cur = requireCharacter();
    if (!cur) return;
    const result = await guarded('analyze', async () => {
        let pending = toast('info', `${cur.char.name} 카드를 분석하는 중…`, '레모나', { timeOut: 0, extendedTimeOut: 0 });
        try {
            return await analyzeCurrentCharacter({
                onLore: lore => {
                    if (!lore.used) return;
                    toastr.clear(pending);
                    pending = toast('info', `${cur.char.name} 카드와 로어북 ${lore.used}개 항목을 분석하는 중…`, '레모나', { timeOut: 0, extendedTimeOut: 0 });
                },
            });
        } finally {
            toastr.clear(pending);
        }
    });
    if (result) {
        toast('success', result.lore?.used ? `분석 완료 (로어북 ${result.lore.used}개 항목 포함). 내용을 확인하고 저장해 주세요.` : '분석 완료. 내용을 확인하고 저장해 주세요.');
        await openEditor(result, true);
    }
}

export async function openEditor(initial = null, unsaved = false) {
    if (!requireActive()) return;
    const cur = await ensureFullCharacter();
    if (!cur) return requireCharacter();
    const { Popup, POPUP_TYPE, POPUP_RESULT } = ctx();
    const RE_ANALYZE = POPUP_RESULT.CUSTOM1;
    const DELETE = POPUP_RESULT.CUSTOM2;
    const base = initial ?? loadProfile() ?? normalizeProfile({});
    const draft = {
        layers: { ...base.layers },
        pairs: base.pairs.map(p => ({ ...p })),
        relations: (base.relations ?? []).map(r => ({ ...r })),
        base_crack: base.base_crack,
        recommend: base.recommend,
        lore: base.lore,
    };
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
                if (draft.relations.some(x => (x.who || x.shows) && !(x.who && x.shows))) toast('warning', '이름과 내용을 둘 다 적지 않은 사람은 저장되지 않아요.');
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

function healthHtml(items, okText) {
    if (!items.length) return okText ? `<div class="lmc-health lmc-health-ok"><i class="fa-solid fa-circle-check"></i><span>${okText}</span></div>` : '';
    return items
        .map(h => `<div class="lmc-health lmc-health-${h.level}"><i class="fa-solid ${h.level === 'warn' ? 'fa-triangle-exclamation' : 'fa-circle-info'}"></i><span>${esc(h.text)}</span></div>`)
        .join('');
}

function togglesHtml() {
    if (!detectLemona()) {
        return popupFrame('레모나 토글', '', '<div class="lmc-empty-big"><span class="lmc-slice lmc-slice-dim" aria-hidden="true"></span><p>지금 채팅 완성 프리셋이 레모나가 아니에요.<br>레모나 프리셋을 고른 뒤 다시 열어 주세요.</p></div>', 'lmc-toggles');
    }
    const { groups, optional } = readToggles();
    const cur = currentCharacter();
    const saved = cur ? readCharData().toggles : null;
    const rec = cur ? loadProfile()?.recommend : null;
    const groupRows = groups
        .map(g => {
            const on = g.options.filter(o => o.enabled);
            const chips = g.options
                .map(o => `<button type="button" class="lmc-seg${o.enabled ? ' is-on' : ''}" aria-pressed="${o.enabled}" data-seg-group="${esc(g.label)}" data-seg-id="${esc(o.id)}">${esc(o.label)}</button>`)
                .join('');
            const offChip = `<button type="button" class="lmc-seg lmc-seg-off${on.length === 0 ? ' is-on' : ''}" aria-pressed="${on.length === 0}" data-seg-group="${esc(g.label)}" data-seg-id="">끔</button>`;
            return `
            <div class="lmc-group${on.length > 1 ? ' is-conflict' : ''}">
                <div class="lmc-group-label">${esc(g.icon)} ${esc(g.label)}${on.length > 1 ? `<span class="lmc-pill lmc-pill-warn">${on.length}개 켜짐</span>` : ''}</div>
                <div class="lmc-segs">${chips}${offChip}</div>
            </div>`;
        })
        .join('');
    const auto = getSettings().model_auto_toggle ? modelToggleIds() : new Set();
    const optRows = optional
        .map(
            o => `
            <label class="lmc-opt${o.enabled ? ' is-on' : ''}">
                <span class="lmc-opt-name">${esc(o.name)}${auto.has(o.id) ? '<span class="lmc-pill lmc-pill-auto">모델 따라 자동</span>' : ''}</span>
                <span class="lmc-switch lmc-switch-sm"><input type="checkbox" data-opt="${esc(o.id)}" ${o.enabled ? 'checked' : ''} /><i aria-hidden="true"></i></span>
            </label>`,
        )
        .join('');
    const charBlock = cur
        ? `<section class="lmc-sec lmc-sec-char">
            <h4><i class="fa-solid fa-user"></i> ${esc(cur.char.name)} 전용 세트</h4>
            <p class="lmc-hint">${saved ? '저장된 세트가 있어요. 이 캐릭터 채팅을 열 때, 그리고 프리셋을 다시 불러올 때(연결 프로필 전환 포함) 자동으로 적용돼요.' : '저장된 세트가 없어요. 지금 토글을 이 캐릭터용으로 저장해 두면 다음부터 자동으로 바뀌어요.'} 🔷 Argon·🔶 Carbon 호환은 세트에 넣지 않고 모델을 따라가요.</p>
            <div class="lmc-btn-row">
                <button type="button" class="lmc-btn lmc-btn-lemon" data-save-char><i class="fa-solid fa-floppy-disk"></i> 지금 토글 저장</button>
                ${saved ? '<button type="button" class="lmc-btn lmc-btn-ghost" data-clear-char><i class="fa-solid fa-eraser"></i> 세트 지우기</button>' : ''}
                ${rec ? `<button type="button" class="lmc-btn lmc-btn-leaf" data-apply-rec title="${esc(recommendSummary(rec).join(' · '))}"><i class="fa-solid fa-wand-magic-sparkles"></i> 캐해 추천 적용</button>` : ''}
            </div>
        </section>`
        : '';
    const body = `
        ${healthHtml(healthCheck(), '토글 구성에 문제 없어요.')}
        <section class="lmc-sec">
            <h4>택1</h4>
            ${groupRows}
        </section>
        <section class="lmc-sec">
            <h4>선택 항목 <small>${optional.filter(o => o.enabled).length}개 켜짐</small></h4>
            <div class="lmc-opts">${optRows}</div>
        </section>
        ${charBlock}`;
    return popupFrame('레모나 토글', '바꾸면 Prompt Manager에도 바로 반영돼요', body, 'lmc-toggles');
}

export async function openToggles() {
    if (!requireActive()) return;
    const { Popup, POPUP_TYPE } = ctx();
    let popup;
    const render = () => {
        if (!popup?.content) return;
        const top = popup.content.scrollTop;
        popup.content.innerHTML = togglesHtml();
        popup.content.scrollTop = top;
    };
    popup = new Popup(togglesHtml(), POPUP_TYPE.TEXT, '', {
        wide: true,
        allowVerticalScrolling: true,
        leftAlign: true,
        okButton: '닫기',
        onOpen: p => {
            p.content.addEventListener('change', async e => {
                const t = e.target;
                if (!t.dataset.opt) return;
                await setToggles({ [t.dataset.opt]: t.checked });
                render();
            });
            p.content.addEventListener('click', async e => {
                const seg = e.target.closest('[data-seg-group]');
                if (seg) {
                    await selectInGroup(seg.dataset.segGroup, seg.dataset.segId || null);
                } else if (e.target.closest('[data-save-char]')) {
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
                  let ctxHtml;
                  if (i.type === 'structure') {
                      ctxHtml = esc(i.text);
                  } else {
                      const from = Math.max(0, i.index - 22);
                      const to = Math.min(m.mes.length, i.index + i.length + 22);
                      const flat = s => esc(s.replace(/\s+/g, ' '));
                      ctxHtml = `${from > 0 ? '…' : ''}${flat(m.mes.slice(from, i.index))}<mark class="lmc-ban lmc-ban-${i.type}">${flat(m.mes.slice(i.index, i.index + i.length))}</mark>${flat(m.mes.slice(i.index + i.length, to))}${to < m.mes.length ? '…' : ''}`;
                  }
                  return `
                  <li class="lmc-issue lmc-issue-${i.type}">
                      <div class="lmc-issue-head"><span class="lmc-tag lmc-tag-${i.type}">${TYPE_LABEL[i.type]}</span><b>${esc(i.type === 'structure' ? i.word : i.text)}</b>${i.note ? `<small>${esc(i.note)}</small>` : ''}</div>
                      <div class="lmc-issue-ctx">${ctxHtml}</div>
                  </li>`;
              })
              .join('')
        : '';
    const fixable = fixableIssues(scan.issues).length;
    const counts = {};
    for (const i of scan.issues) counts[i.type] = (counts[i.type] ?? 0) + 1;
    const summary = Object.entries(counts)
        .map(([t, n]) => `<span class="lmc-tag lmc-tag-${t}">${TYPE_LABEL[t]} ${n}</span>`)
        .join('');
    const buttons = [];
    if (fixable) buttons.push({ text: `AI로 고치기 (${fixable})`, icon: 'fa-wand-magic-sparkles', result: FIX });
    if (m.extra?.lemona_original) buttons.push({ text: '고치기 전으로', icon: 'fa-rotate-left', result: UNDO });
    const body = scan.issues.length
        ? `<div class="lmc-tags">${summary}</div>
           <ul class="lmc-issues">${rows}</ul>
           <p class="lmc-hint">기준은 지금 프리셋의 「🚫 금지단어」예요. 소유 표현은 사물 얘기일 수도 있어서 표시만 하고 고치지 않아요.</p>`
        : '<div class="lmc-empty-big"><span class="lmc-slice" aria-hidden="true"></span><p>이 답은 깨끗해요!</p></div>';
    const result = await new Popup(popupFrame('금지어 검사', `#${mesId} 답변`, body, 'lmc-report'), POPUP_TYPE.TEXT, '', {
        wide: true,
        allowVerticalScrolling: true,
        leftAlign: true,
        okButton: '닫기',
        customButtons: buttons,
    }).show();
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
    const insight = card(
        '🧠',
        '캐릭터 해석',
        '겉과 속 · 부딪히는 가치',
        `<div class="lmc-btn-row">
            <button type="button" id="lmc_analyze" class="lmc-btn lmc-btn-lemon"><i class="fa-solid fa-wand-magic-sparkles"></i> <span>카드 분석</span></button>
            <button type="button" id="lmc_edit" class="lmc-btn lmc-btn-ghost"><i class="fa-solid fa-pen-to-square"></i> 편집 열기</button>
        </div>
        ${switchRow('lmc_insight_enabled', '답변 생성 때 넣기', '레모나에선 「👤 현실적·캐해」 바로 뒤')}
        ${switchRow('lmc_insight_think', '추론에 캐해 확인 줄', '「🔍 추론」 체크리스트 끝에 한 줄')}
        ${numberRow('lmc_insight_depth', '다른 프리셋일 때 깊이', 0, 20, 1, '「레모나에서만」을 껐을 때만 써요')}
        <div class="lmc-subhead"><i class="fa-solid fa-book-atlas"></i> 로어북</div>
        ${switchRow('lmc_lore_enabled', '로어북도 같이 분석', '캐릭터·채팅 로어북의 켜진 항목. 변수·상태창 항목은 빼요')}
        ${switchRow('lmc_lore_global', '전역 로어북도 넣기', '전역·페르소나 로어북까지 읽어요')}
        ${numberRow('lmc_lore_budget', '로어북 최대 글자 수', 2000, 60000, 1000, '넘치면 캐릭터 이름이 나오는 항목부터 넣어요')}`,
        true,
    );
    const toggles = card(
        '🎛️',
        '토글 도우미',
        '택1 · 캐릭터별 세트',
        `<div class="lmc-btn-row"><button type="button" id="lmc_toggles" class="lmc-btn lmc-btn-lemon"><i class="fa-solid fa-sliders"></i> 토글 열기</button></div>
        ${switchRow('lmc_toggles_auto', '캐릭터별 세트 자동 적용', '채팅 열 때, 프리셋을 다시 불러올 때')}
        ${switchRow('lmc_model_auto', '모델 따라 🔷/🔶 자동 전환', 'Argon이면 🔷, Carbon이면 🔶만 켜요')}
        ${switchRow('lmc_model_other_off', '다른 모델이면 둘 다 끄기', '3.8 Flash 같은 모델일 때')}`,
    );
    const bans = card(
        '🚫',
        '금지어 검수',
        '형광펜 · 문제 문장만 고치기',
        `${switchRow('lmc_bans_enabled', '답마다 검사해서 배지 띄우기')}
        ${switchRow('lmc_bans_highlight', '본문에 형광펜')}
        ${switchRow('lmc_bans_auto', '새 답 자동 고치기', 'API 호출이 늘어요')}
        <div class="lmc-legend"><span><i class="lmc-sw-ban"></i>금지어</span><span><i class="lmc-sw-res"></i>제한어</span><span><i class="lmc-sw-pos"></i>소유 표현</span></div>
        <div class="lmc-btn-row"><button type="button" id="lmc_bans_last" class="lmc-btn lmc-btn-ghost"><i class="fa-solid fa-magnifying-glass"></i> 마지막 답 검사</button></div>`,
    );
    const repeat = card(
        '🔁',
        '반복 끊기',
        '이 채팅의 버릇을 다음 답에서 피하기',
        `${switchRow('lmc_repeat_enabled', '반복 표현 피하게 하기')}
        ${numberRow('lmc_repeat_window', '살펴볼 최근 답 수', 3, 20)}
        ${numberRow('lmc_repeat_min', '몇 번부터 반복으로', 2, 10)}
        <div id="lmc_repeat_list" class="lmc-list"></div>
        <div class="lmc-btn-row">
            <button type="button" id="lmc_habits_ai" class="lmc-btn lmc-btn-lemon"><i class="fa-solid fa-magnifying-glass-plus"></i> <span>AI로 버릇 찾기</span></button>
            <button type="button" id="lmc_habits_clear" class="lmc-btn lmc-btn-ghost"><i class="fa-solid fa-broom"></i> 목록 지우기</button>
        </div>`,
    );
    const mvu = card(
        '📊',
        'MVU 연동',
        '가면 균열 · 가치 기울기',
        `${switchRow('lmc_mvu', 'MVU 변수로 추적', '<code>stat_data.캐해</code>')}
        ${switchRow('lmc_mvu_rules', '변수 갱신 규칙 넣기')}
        ${switchRow('lmc_mvu_format', '변수 출력 형식도 넣기', 'MVU 카드가 아닐 때만 켜요')}
        ${numberRow('lmc_mvu_delta', '한 턴 최대 변화량', 1, 50)}`,
    );
    const api = card(
        '🔌',
        '보조 API',
        '분석 · 고치기 · 버릇 찾기용',
        `<p class="lmc-hint">연결 프로필을 고르면 본 채팅과 다른(싼) 모델로 돌릴 수 있어요.</p>
        ${selectRow('lmc_api_profile', '연결 프로필')}
        ${numberRow('lmc_api_tokens', '응답 길이 (토큰)', 300, 16000, 100)}
        ${selectRow('lmc_lang', '분석 결과 언어', '<option value="preset">프리셋 서술 언어에 맞춤</option><option value="ko">한국어</option><option value="en">영어</option><option value="card">카드와 같은 언어</option>')}`,
    );

    return `
    <div id="lmc_settings" class="extension_settings">
        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b class="lmc-drawer-title"><span class="lmc-slice lmc-slice-xs" aria-hidden="true"></span>레모나 도우미</b>
                <span id="lmc_head_state" class="lmc-head-state"></span>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content">
                <div class="lmc-ui lmc-panel">
                    <div class="lmc-hero">
                        <span class="lmc-slice" aria-hidden="true"></span>
                        <div class="lmc-hero-text">
                            <div class="lmc-hero-title">레모나 도우미 <span class="lmc-pill">v${VERSION}</span></div>
                            <div class="lmc-hero-sub" id="lmc_mode_line"></div>
                        </div>
                        <span class="lmc-switch lmc-switch-lg" title="레모나 도우미 전체 켜기·끄기"><input type="checkbox" id="lmc_enabled" aria-label="레모나 도우미 켜기" /><i aria-hidden="true"></i></span>
                    </div>
                    ${switchRow('lmc_lemona_only', '레모나 프리셋에서만 켜기', '다른 프리셋을 쓰면 알아서 쉬어요')}

                    <div id="lmc_sleep" class="lmc-sleep"></div>

                    <div id="lmc_body" class="lmc-body">
                        <div class="lmc-status">
                            <span class="lmc-stat"><small>캐릭터</small><b id="lmc_st_char"></b></span>
                            <span class="lmc-stat"><small>프리셋</small><b id="lmc_st_preset"></b></span>
                            <span class="lmc-stat"><small>캐해</small><b id="lmc_st_insight"></b></span>
                            <span class="lmc-stat"><small>MVU</small><b id="lmc_st_mvu"></b></span>
                        </div>
                        <div id="lmc_health"></div>
                        ${insight}${toggles}${bans}${repeat}${mvu}${api}
                        <p class="lmc-foot">슬래시 커맨드 <code>/lemona</code> analyze · edit · toggles · check · fix · habits · show · health · on · off</p>
                    </div>
                </div>
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

/** Turns the extension on or off (or "Lemona only") and brings every surface in line. */
export function setPower(patch) {
    Object.assign(getSettings(), patch);
    saveSettings();
    if ('enabled' in patch) $('#lmc_enabled').prop('checked', !!getSettings().enabled);
    if ('lemona_only' in patch) $('#lmc_lemona_only').prop('checked', !!getSettings().lemona_only);
    applyActiveState({ announce: true });
}

let lastActive = null;
/**
 * Re-applies everything that depends on being active: prompts, chat marks, menu items, panel.
 * With `announce`, tells the user when the state actually changed.
 */
export function applyActiveState({ announce = false } = {}) {
    const active = isActive();
    const changed = lastActive !== null && lastActive !== active;
    lastActive = active;
    refreshInjection();
    decorateRecent(openBanReport);
    updateMenu();
    updateStatus();
    if (announce && changed) {
        const reason = inactiveReason();
        if (active) toast('success', '레모나 도우미가 다시 일해요.', '🍋 레모나');
        else if (reason === 'off') toast('info', '레모나 도우미를 껐어요. 프롬프트에 아무것도 넣지 않고 검사도 쉬어요.', '🍋 레모나');
        else toast('info', '레모나 프리셋이 아니라서 레모나 도우미가 쉬어요.', '🍋 레모나');
    }
}

/** Cheap check for places that run often: re-applies only when active/inactive actually flipped. */
export function syncActiveState() {
    if (isActive() !== lastActive) applyActiveState({ announce: true });
}

function bindSettings() {
    const s = getSettings();
    const after = () => {
        saveSettings();
        refreshInjection();
        decorateRecent(openBanReport);
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

    $('#lmc_enabled')
        .prop('checked', !!s.enabled)
        .on('change', function () {
            setPower({ enabled: $(this).prop('checked') });
        });
    $('#lmc_lemona_only')
        .prop('checked', !!s.lemona_only)
        .on('change', function () {
            setPower({ lemona_only: $(this).prop('checked') });
        });
    // Clicking the big switch must not also open or close the drawer
    $('#lmc_settings .lmc-hero .lmc-switch').on('click', e => e.stopPropagation());

    check('#lmc_insight_enabled', 'insight_enabled');
    check('#lmc_insight_think', 'insight_think_line');
    num('#lmc_insight_depth', 'insight_fallback_depth', 0, 20);
    check('#lmc_toggles_auto', 'toggles_auto_apply');
    check('#lmc_lore_enabled', 'lore_enabled');
    check('#lmc_lore_global', 'lore_include_global');
    num('#lmc_lore_budget', 'lore_budget', 2000, 60000);
    for (const [id, key] of [['#lmc_model_auto', 'model_auto_toggle'], ['#lmc_model_other_off', 'model_other_off']]) {
        $(id)
            .prop('checked', !!s[key])
            .on('change', async function () {
                s[key] = $(this).prop('checked');
                saveSettings();
                if (s.model_auto_toggle) await syncModelToggles({ force: true });
                updateStatus();
            });
    }
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

    $('#lmc_sleep').on('click', '[data-lmc-act]', function () {
        const act = $(this).data('lmc-act');
        if (act === 'turn-on') setPower({ enabled: true });
        else if (act === 'everywhere') setPower({ lemona_only: false });
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
        if (!requireActive()) return;
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

function sleepHtml(reason) {
    if (reason === 'off') {
        return `
        <span class="lmc-slice lmc-slice-dim" aria-hidden="true"></span>
        <div class="lmc-sleep-text"><b>꺼져 있어요</b><small>프롬프트에 아무것도 넣지 않고, 답 검사도 하지 않아요.</small></div>
        <button type="button" class="lmc-btn lmc-btn-lemon" data-lmc-act="turn-on"><i class="fa-solid fa-power-off"></i> 켜기</button>`;
    }
    return `
    <span class="lmc-slice lmc-slice-dim" aria-hidden="true"></span>
    <div class="lmc-sleep-text"><b>쉬는 중이에요</b><small>지금 프리셋이 레모나가 아니에요. 레모나로 바꾸면 알아서 다시 일해요.</small></div>
    <button type="button" class="lmc-btn lmc-btn-ghost" data-lmc-act="everywhere">다른 프리셋에서도 켜기</button>`;
}

export function updateStatus() {
    if (!$('#lmc_settings').length) return;
    const s = getSettings();
    const reason = inactiveReason();
    const active = reason === null;
    const lemona = detectLemona();
    const cur = currentCharacter();

    $('#lmc_head_state')
        .text(active ? '켜짐' : reason === 'off' ? '꺼짐' : '쉬는 중')
        .attr('data-state', active ? 'on' : reason === 'off' ? 'off' : 'rest');
    $('#lmc_mode_line').text(active ? (lemona ? '레모나 프리셋에서 일하는 중' : '다른 프리셋에서 일반 모드로 일하는 중') : reason === 'off' ? '꺼져 있어요' : '레모나 프리셋이 아니라 쉬는 중');
    $('#lmc_settings .lmc-panel').attr('data-active', String(active));
    $('#lmc_enabled').prop('checked', !!s.enabled);
    $('#lmc_lemona_only').prop('checked', !!s.lemona_only);
    $('#lmc_sleep').html(active ? '' : sleepHtml(reason)).toggle(!active);
    $('#lmc_body').toggle(active);
    if (!active) return;

    const setStat = (id, text, tone) => $(id).text(text).attr('data-tone', tone);
    setStat('#lmc_st_char', cur ? cur.char.name : '없음', cur ? 'ok' : 'none');
    setStat('#lmc_st_preset', lemona ? '레모나' : '다른 프리셋', lemona ? 'ok' : 'warn');
    const profile = cur ? loadProfile() : null;
    setStat('#lmc_st_insight', !cur ? '-' : profile ? '저장됨' : '아직', !cur ? 'none' : profile ? 'ok' : 'warn');
    setStat('#lmc_st_mvu', state.mvu ? '감지됨' : '없음', state.mvu ? 'ok' : 'none');

    $('#lmc_health').html(healthHtml(healthCheck().filter(h => h.level === 'warn')));
    const busyBtn = (id, key, idle, busy) => {
        const $b = $(id);
        $b.prop('disabled', state.busy.has(key)).toggleClass('is-busy', state.busy.has(key));
        $b.find('span').text(state.busy.has(key) ? busy : idle);
    };
    busyBtn('#lmc_analyze', 'analyze', '카드 분석', '분석 중…');
    busyBtn('#lmc_habits_ai', 'habits', 'AI로 버릇 찾기', '찾는 중…');

    const repeats = s.repeat_enabled && cur ? detectRepeats() : [];
    const habits = cur ? getHabits() : [];
    const rows = [
        ...habits.map(
            (h, i) =>
                `<div class="lmc-item"><span class="lmc-tag lmc-tag-ai">AI 버릇</span><span class="lmc-item-text">${esc(h.habit)}${h.example ? `<small>“${esc(h.example)}”</small>` : ''}</span><button type="button" class="lmc-icon-btn" title="지우기" aria-label="이 버릇 지우기" data-del-habit="${i}"><i class="fa-solid fa-xmark"></i></button></div>`,
        ),
        ...repeats.map(r => `<div class="lmc-item"><span class="lmc-tag">${r.kind === 'opening' ? '첫 문장' : `${r.count}회`}</span><span class="lmc-item-text">${esc(r.phrase)}</span></div>`),
    ];
    $('#lmc_repeat_list').html(rows.length ? `<div class="lmc-list-head">다음 답에서 피할 것</div>${rows.join('')}` : '<p class="lmc-empty">지금은 피할 반복이 없어요.</p>');
}

export function mountSettings() {
    $('#extensions_settings2').append(settingsHtml());
    bindSettings();
    lastActive = isActive();
    updateStatus();
}

// ================================================================ wand menu

const MENU_FEATURES = ['lmc_menu_analyze', 'lmc_menu_edit', 'lmc_menu_toggles', 'lmc_menu_check'];

function updateMenu() {
    const active = isActive();
    for (const id of MENU_FEATURES) $(`#${id}`).toggle(active);
    const on = !!getSettings().enabled;
    $('#lmc_menu_power span').text(on ? '레모나 도우미 끄기' : '레모나 도우미 켜기');
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
    $menu.append(item('lmc_menu_power', 'fa-lemon', '레모나 도우미 끄기', () => setPower({ enabled: !getSettings().enabled })));
    updateMenu();
}

export { applyCharacterToggles, decorateRecent };
