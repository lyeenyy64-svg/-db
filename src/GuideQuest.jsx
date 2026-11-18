import { useEffect, useMemo, useRef, useState, useCallback } from "react";
import GuideBreak from "./GuideBreak.jsx";
import GuideLegalTip from "./GuideLegalTip.jsx";

// ─── 업무 길라잡이 (데일리 미션) ───────────────────────────────────────────────
// 담당자가 출근해서 뭘 할지 모를 때, 오늘 해야 할 일을 단계(미션)별로 순서대로 보여준다.
// 완료 판정: 서버의 접속기록(오늘 내가 입력한 데이터)을 보고 자동으로 체크 → 점수 지급 → 다음 단계.
// 점수는 서버(guide_scores)에 (사용자·날짜·미션·항목) 단위로 한 번만 쌓이고, 어드민 통계에서 일/월/연 합계를 본다.

const pad2 = n => String(n).padStart(2, "0");
const localToday = () => { const d = new Date(); return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; };

// 기본 미션 순서. 사람마다 다르게 하려면 USER_ORDER에 이름으로 추가한다.
const DEFAULT_ORDER = ["installment", "civil", "schedule", "forced", "credit", "todo"];
const USER_ORDER = {
  "배현진": ["todo", "schedule", "credit", "forced"],
  "김준원": ["installment", "credit", "forced"],
  "조혜원": ["civil", "todo", "credit", "forced", "rehab"],
};

// 모든 미션을 끝낸 뒤 하단에 띄우는 사람별 안내
const USER_FINALE_NOTE = {
  "배현진": "이메일 확인하여 계약서 검토할 부분 체크해 주세요",
};

const ITEM_POINTS = 10;   // 항목(채무자/사건) 하나를 처리할 때
const STEP_POINTS = 20;   // 한 단계(미션) 전체를 끝낼 때
const WIP_POINTS = 5;     // 진행 중으로 표시하고 넘어갈 때
const NONE_POINTS = 5;    // 대상자가 없음을 확인했을 때
const CHECK_POINTS = 5;   // 확인만 하는 항목(주요일정)

// 담당자 표기가 "준원"/"김준원"처럼 다를 수 있어 포함 관계로 비교한다 (2글자 이상일 때만)
const makeIsMine = (name) => (assignee) => {
  const a = String(assignee || "").trim(), n = String(name || "").trim();
  if (!a || !n) return false;
  return a === n || (a.length >= 2 && n.includes(a)) || (n.length >= 2 && a.includes(n));
};

// 이름/이름 뒷 두 글자(예: 배현진/현진)가 문장에 들어 있으면 그 사람과 관련된 일정으로 본다
const mentionsUser = (name, ...texts) => {
  const n = String(name || "").trim(); if (n.length < 2) return false;
  const keys = [n, n.length >= 3 ? n.slice(-2) : null].filter(Boolean);
  const t = texts.map(x => String(x || "")).join(" ");
  return keys.some(k => t.includes(k));
};

const hitPath = (rows, pred) => rows.some(r => pred(String(r.path || ""), r));

// 미션 정의 ────────────────────────────────────────────────────────────────
// mode "item": 항목마다 완료 판정(detect) / mode "step": 해당 저장 경로에 오늘 입력이 있으면 단계 전체 완료
// mode "check": 항목을 눈으로 확인하고 [확인] 버튼으로 완료
function buildMissions(ctx) {
  const { data, today, isMine, getCaseEventDate, nav, awarded, userName } = ctx;
  const debtors = data.debtors || [];
  const debtorById = new Map(debtors.map(d => [d.id, d]));
  const dayDiff = ev => Math.round((new Date(ev) - new Date(today)) / 86400000);

  return {
    installment: {
      label: "오늘 분할상환 대상자", mode: "item", points: ITEM_POINTS, confirmEmpty: true,
      hint: "연락 후 채무자 히스토리에 글을 남기세요 (대상자 모두)",
      items: () => (data.installmentSchedules || [])
        .filter(s => s.dueDate === today && isMine(s.assignee) && (s.status !== "이월" || awarded.has(`installment|${s.id}`)))
        .map(s => ({
          id: String(s.id), title: s.debtorName || "-", sub: `${s.brand || ""} · 예정 ${Number(s.scheduledAmount || 0).toLocaleString()}원 · ${s.status || "미납"}`,
          debtorId: s.debtorId,
          go: () => { const d = debtorById.get(s.debtorId); if (d) nav.debtor(d); },
        })),
      detect: (it, rows) => it.debtorId != null && hitPath(rows, p => p === `/api/kv/hist_m_${it.debtorId}`),
    },
    civil: {
      label: "민/형사 이벤트 확인", mode: "item", points: ITEM_POINTS,
      hint: "7일 이내 기일이 있는 사건의 진행내용을 입력하세요",
      items: () => {
        const groups = [
          { tab: "minsa", list: data.minsaCases, kind: "민사소송" },
          { tab: "legal", list: [...(data.legalCases || []), ...(data.assetDisclosures || [])], kind: "법적절차" },
          { tab: "rehabBankruptcy", list: data.rehabilitations, kind: "회생/파산" },
        ];
        return groups.flatMap(g => (g.list || []).map(c => ({ c, g }))).filter(({ c }) => {
          const ev = getCaseEventDate(c.id);
          if (!ev) return false;
          const diff = dayDiff(ev);
          return diff >= 0 && diff <= 7 && isMine(debtorById.get(c.debtorId)?.assignee);
        }).map(({ c, g }) => ({
          id: String(c.id), title: c.defendant || c.debtorName || "-",
          sub: `${g.kind} · 기일 ${getCaseEventDate(c.id)} · ${c.court || "-"} ${c.caseNumber || ""}`,
          go: () => nav.caseOf(g.tab, c.id),
        })).sort((a, b) => a.sub.localeCompare(b.sub));
      },
      detect: (it, rows) => hitPath(rows, p => p.includes(`case_notes_${it.id}`) || p.includes(`case_event_${it.id}`)),
    },
    schedule: {
      label: "월간 주요일정 확인", mode: "check", points: CHECK_POINTS, confirmEmpty: true,
      hint: "오늘 나와 관련된 일정을 확인하고 [확인]을 누르세요",
      items: () => {
        const out = [];
        for (const s of (data.monthlySchedule || [])) {
          if (today >= s.date && today <= (s.endDate || s.date) && mentionsUser(userName, s.text, s.detail)) {
            out.push({ id: `S${s.id}`, title: s.text || "-", sub: `월간 주요일정${s.detail ? " · " + s.detail : ""}`, go: () => nav.schedule() });
          }
        }
        for (const [kind, list] of [["민사소송", data.minsaCases], ["법적절차", data.legalCases], ["재산명시", data.assetDisclosures], ["회생/파산", data.rehabilitations]]) {
          for (const c of (list || [])) {
            if (getCaseEventDate(c.id) === today && isMine(debtorById.get(c.debtorId)?.assignee)) out.push({ id: `C${c.id}`, title: c.defendant || c.debtorName || "-", sub: `${kind} 기일 오늘`, go: () => nav.schedule() });
          }
        }
        return out;
      },
    },
    credit: {
      label: "신용분석 대상자", mode: "item", points: ITEM_POINTS, confirmEmpty: true,
      hint: "담당 대상자의 신용조회 결과를 입력하세요",
      items: () => (data.creditAnalyses || [])
        .filter(f => !f.deleted && isMine(f.assignee) && (!f.completed || awarded.has(`credit|${f.id}`)))
        .map(f => ({
          id: String(f.id), title: f.target || "-", badge: f.assignee ? `담당 ${f.assignee}` : "",
          sub: `${f.requestDate ? "요청 " + f.requestDate : ""}${f.checkResult ? " · 결과 " + f.checkResult + "점" : " · 결과 미입력"}`,
          hasValue: String(f.checkResult || "").trim() !== "",
          go: () => nav.tab("issues"),
        })),
      detect: (it, rows) => it.hasValue && hitPath(rows, p => p.startsWith("/api/kv/manual_credit_analyses")),
    },
    forced: {
      label: "주요현안 · 강제집행 대상자", mode: "item", points: ITEM_POINTS, confirmEmpty: true, allowHold: true,
      hint: "처리일을 입력하면 완료, 사정이 있으면 [보류] (보류는 점수 없음)",
      items: () => (data.forcedExecutions || [])
        .filter(f => !f.deleted && isMine(f.assignee) && (!f.completed || awarded.has(`forced|${f.id}`)))
        .map(f => ({
          id: String(f.id), title: f.debtorName || "-", badge: f.assignee ? `담당 ${f.assignee}` : "",
          sub: `${f.executionContent || ""}${f.resolvedDate ? " · 처리일 " + f.resolvedDate : " · 처리일 미입력"}`,
          hasValue: String(f.resolvedDate || "").trim() !== "",
          go: () => nav.tab("issues"),
        })),
      detect: (it, rows) => it.hasValue && hitPath(rows, p => p.startsWith("/api/kv/manual_forced_executions")),
    },
    todo: {
      label: "주요현안 · To Do List", mode: "item", points: ITEM_POINTS, confirmEmpty: true, allowProgress: true,
      hint: "항목별로 결과를 수정하거나, 아직 진행 중이면 [진행중]을 누르세요",
      items: () => (data.todoList || [])
        .filter(t => !t.deleted && isMine(t.assignee) && (t.status !== "완료" || awarded.has(`todo|${t.id}`) || awarded.has(`todo|${t.id}~wip`)))
        .map(t => ({
          id: String(t.id), title: t.task || "-", badge: t.assignee ? `담당 ${t.assignee}` : "",
          sub: `${t.priority || ""} · ${t.status || "진행중"}${t.result ? " · 결과 입력됨" : " · 결과 미입력"}`,
          hasValue: String(t.result || "").trim() !== "",
          go: () => nav.tab("issues"),
        })),
      detect: (it, rows) => it.hasValue && hitPath(rows, p => p.startsWith("/api/kv/manual_todo_list")),
    },
    rehab: {
      label: "회생/파산 현황", mode: "step", points: STEP_POINTS,
      hint: "담당 회생/파산 건의 진행내용을 입력하세요",
      items: () => (data.rehabilitations || []).filter(c => !c.dismissed && isMine(debtorById.get(c.debtorId)?.assignee)).slice(0, 15)
        .map(c => ({ id: String(c.id), title: c.debtorName || "-", sub: `${c.type || ""} ${c.court || ""} ${c.caseNumber || ""}`, go: () => nav.caseOf("rehabBankruptcy", c.id) })),
      stepDetect: rows => hitPath(rows, p => p.startsWith("/api/kv/manual_rehabilitations") || p.startsWith("/api/kv/rehab") || /case_notes_/.test(p)),
    },
  };
}

// 폭죽: 3곳에서 터지는 점 파티클 (CSS 애니메이션 한 번)
const FW_COLORS = ["#ff5f00", "#f59e0b", "#10b981", "#3b82f6", "#ec4899", "#8b5cf6"];
const FIREWORKS = [[22, 38], [50, 22], [78, 40]].flatMap(([x, y], c) => Array.from({ length: 16 }, (_, k) => {
  const ang = (k / 16) * Math.PI * 2, r = 38 + (k % 3) * 14;
  return { i: c * 16 + k, x, y, dx: Math.round(Math.cos(ang) * r), dy: Math.round(Math.sin(ang) * r), color: FW_COLORS[(k + c) % FW_COLORS.length], delay: c * 0.35 };
}));
const FIREWORK_CSS = `@keyframes gqFw{0%{transform:translate(0,0) scale(1);opacity:1}80%{opacity:1}100%{transform:translate(var(--dx),var(--dy)) scale(.4);opacity:0}}
.gq-fw{position:absolute;width:6px;height:6px;border-radius:50%;pointer-events:none;opacity:0;animation:gqFw 1.2s ease-out both}`;

const btn = { padding: "4px 10px", borderRadius: 6, fontSize: 11, fontWeight: 600, cursor: "pointer", border: "1px solid var(--brd)", background: "var(--card)", color: "var(--ts)" };

export default function GuideQuest({ data, currentUser, getCaseEventDate, nav, onClose }) {
  const [rows, setRows] = useState([]);          // 오늘 내가 입력한 기록
  const [awards, setAwards] = useState([]);      // 이미 지급된 점수 [{mission,itemId,points}]
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  const [today] = useState(localToday);
  const posting = useRef(new Set());
  const boxRef = useRef(null);
  const [pos, setPos] = useState(null); // null이면 기본(우하단), 드래그하면 {x,y}

  const startDrag = (e) => {
    if (e.button !== undefined && e.button !== 0) return;
    if (e.target.closest("button")) return;
    const el = boxRef.current; if (!el) return;
    const r = el.getBoundingClientRect();
    const dx = e.clientX - r.left, dy = e.clientY - r.top;
    const move = (ev) => {
      setPos({ x: ev.clientX - dx, y: ev.clientY - dy });
    };
    const up = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    e.preventDefault();
  };

  const isMine = useMemo(() => makeIsMine(currentUser?.name), [currentUser?.name]);
  const order = USER_ORDER[currentUser?.name] || DEFAULT_ORDER;
  const awardedSet = useMemo(() => new Set(awards.map(a => `${a.mission}|${a.itemId}`)), [awards]);
  const pointsOf = useMemo(() => new Map(awards.map(a => [`${a.mission}|${a.itemId}`, a.points || 0])), [awards]);
  const missions = useMemo(
    () => buildMissions({ data, today, isMine, getCaseEventDate, nav, awarded: awardedSet, userName: currentUser?.name }),
    [data, today, isMine, getCaseEventDate, nav, awardedSet, currentUser?.name]
  );

  const award = useCallback(async (mission, itemId, points) => {
    const k = `${mission}|${itemId}`;
    if (posting.current.has(k)) return false;
    posting.current.add(k);
    try {
      await fetch("/api/guide/award", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ mission, itemId, points }) });
      return true;
    } catch { posting.current.delete(k); return false; }
  }, []);

  const refresh = useCallback(async () => {
    try {
      const [a, w] = await Promise.all([
        fetch("/api/guide/activity").then(r => r.ok ? r.json() : Promise.reject()),
        fetch("/api/guide/awards").then(r => r.ok ? r.json() : Promise.reject()),
      ]);
      setRows(a.rows || []); setAwards(w.rows || []); setFailed(false);
    } catch { setFailed(true); }
    setLoaded(true);
  }, []);

  // 열려 있는 동안 5초마다 입력 기록을 다시 확인 — 채무자 화면에서 히스토리를 쓰고 오면 자동으로 체크된다
  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 5000);
    return () => clearInterval(t);
  }, [refresh]);

  const grant = useCallback((mission, itemId, points) => award(mission, itemId, points).then(ok => ok && refresh()), [award, refresh]);

  // 단계별 상태 계산
  //  - 항목마다 done(처리됨) / held(보류: 점수 없이 통과)
  //  - 대상자가 없는 단계는 confirmEmpty면 [없음]을 눌러야 통과, 아니면 자동으로 건너뜀(skip)
  const steps = useMemo(() => order.filter(k => missions[k]).map(key => {
    const m = missions[key];
    const items = m.items();
    let done;
    if (m.mode === "item") {
      items.forEach(it => {
        const k = `${key}|${it.id}`;
        it.held = !!m.allowHold && awardedSet.has(k) && (pointsOf.get(k) || 0) === 0;
        it.wip = !!m.allowProgress && awardedSet.has(`${k}~wip`) && !awardedSet.has(k);
        it.done = it.held || it.wip || awardedSet.has(k) || !!m.detect(it, rows);
      });
    } else if (m.mode === "check") {
      items.forEach(it => { it.done = awardedSet.has(`${key}|${it.id}`); });
    } else {
      const hit = awardedSet.has(`${key}|step`) || m.stepDetect(rows);
      items.forEach(it => { it.done = hit; });
    }
    const empty = items.length === 0;
    const noneConfirmed = awardedSet.has(`${key}|none`);
    if (empty) done = !!m.confirmEmpty && noneConfirmed;
    else done = items.every(i => i.done);
    return { key, m, items, done, empty, skip: empty && !m.confirmEmpty };
  }), [order, missions, awardedSet, pointsOf, rows]);

  // 새로 감지된 완료를 점수로 지급 (서버가 중복은 막는다)
  useEffect(() => {
    if (!loaded || failed) return;
    for (const s of steps) {
      if (s.m.mode === "item") {
        for (const it of s.items) if (it.done && !it.held && !it.wip && !awardedSet.has(`${s.key}|${it.id}`)) grant(s.key, it.id, s.m.points);
      } else if (s.m.mode === "step" && s.done && !awardedSet.has(`${s.key}|step`)) {
        grant(s.key, "step", s.m.points);
      }
      // 단계 보너스는 실제로 처리한 항목이 하나라도 있을 때만 (전부 보류거나 대상자 없음이면 없음)
      if (s.done && !s.empty && s.items.some(i => !i.held) && !awardedSet.has(`${s.key}|__clear__`)) grant(s.key, "__clear__", STEP_POINTS);
    }
  }, [steps, loaded, failed, awardedSet, grant]);

  const total = awards.reduce((n, a) => n + (a.points || 0), 0);
  const active = steps.filter(s => !s.skip);
  const doneCount = active.filter(s => s.done).length;
  const current = active.find(s => !s.done);
  const allClear = loaded && active.length > 0 && !current;
  const finaleNote = USER_FINALE_NOTE[currentUser?.name];
  // 첫 단계를 끝낸 순간부터 휴식 카드를 보여준다 — [휴식 끝]을 누르면 오늘은 다시 안 뜬다 (브라우저별 기억)
  const breakKey = `gqBreakDone_${currentUser?.name || ""}_${today}`;
  const [breakDone, setBreakDone] = useState(() => { try { return localStorage.getItem(breakKey) === "1"; } catch { return false; } });
  const endBreak = () => { setBreakDone(true); try { localStorage.setItem(breakKey, "1"); } catch { /* 무시 */ } };
  const showBreak = loaded && !failed && !breakDone && !allClear && active.length > 1 && active[0].done && !!current;
  // 열자마자 오늘의 법률상식을 먼저 보여준다 — [확인]을 누르면 오늘은 다시 안 뜬다 (브라우저별 기억)
  const tipKey = `gqTipDone_${currentUser?.name || ""}_${today}`;
  const [tipDone, setTipDone] = useState(() => { try { return localStorage.getItem(tipKey) === "1"; } catch { return false; } });
  const endTip = () => { setTipDone(true); try { localStorage.setItem(tipKey, "1"); } catch { /* 무시 */ } };
  const dataReady = (data.debtors || []).length > 0; // 데이터 로딩 전에 [없음]을 눌러 잘못 통과하는 것을 막는다

  return (
    <div ref={boxRef} style={{ position: "fixed", ...(pos ? { left: pos.x, top: pos.y } : { right: 20, bottom: 20 }), width: 360, maxHeight: "78vh", zIndex: 1200, background: "var(--card)", border: "1px solid var(--brd)", borderRadius: 14, boxShadow: "0 12px 40px rgba(0,0,0,.22)", display: "flex", flexDirection: "column", overflow: "hidden", textAlign: "left" }}>
      <div onPointerDown={startDrag} title="드래그해서 이동" style={{ padding: "12px 14px", background: "var(--acc)", color: "#fff", display: "flex", alignItems: "center", justifyContent: "space-between", cursor: "move", userSelect: "none", touchAction: "none" }}>
        <div>
          <div style={{ fontSize: 14, fontWeight: 800 }}>업무 길라잡이</div>
          <div style={{ fontSize: 11, opacity: 0.9 }}>오늘 미션 {doneCount}/{active.length} · 오늘 점수 <b>{total}</b>점</div>
        </div>
        <button onClick={onClose} aria-label="닫기" style={{ background: "none", color: "#fff", fontSize: 18, lineHeight: 1, cursor: "pointer", border: "none" }}>×</button>
      </div>
      <div style={{ height: 5, background: "var(--bg)" }}>
        <div style={{ height: "100%", width: `${active.length ? (doneCount / active.length) * 100 : 0}%`, background: "var(--ok)", transition: "width .4s" }} />
      </div>

      <div style={{ padding: 14, overflow: "auto", flex: 1 }}>
        {!tipDone && <GuideLegalTip today={today} onDone={endTip} />}
        {!loaded && <div style={{ fontSize: 12, color: "var(--tm)" }}>오늘 할 일을 불러오는 중…</div>}
        {loaded && failed && <div style={{ fontSize: 12, color: "var(--err)" }}>서버와 연결하지 못했습니다. 잠시 후 다시 시도합니다.</div>}
        {loaded && !failed && active.length === 0 && (
          <div style={{ fontSize: 13, color: "var(--ts)", lineHeight: 1.6 }}>오늘 배정된 미션이 없습니다.<br />담당자 이름과 채무자 담당자 표기가 같은지 확인해 주세요.</div>
        )}
        {allClear && (
          <div style={{ position: "relative", textAlign: "center", padding: "18px 0 14px", overflow: "hidden" }}>
            <style>{FIREWORK_CSS}</style>
            {FIREWORKS.map(p => <span key={p.i} className="gq-fw" style={{ left: p.x + "%", top: p.y + "%", background: p.color, "--dx": p.dx + "px", "--dy": p.dy + "px", animationDelay: p.delay + "s" }} />)}
            <div style={{ fontSize: 34 }}>🎆🎉🎆</div>
            <div style={{ fontSize: 16, fontWeight: 800, color: "var(--tp)", marginTop: 6 }}>오늘 주요업무를 끝냈습니다!</div>
            <div style={{ fontSize: 12, color: "var(--ts)", marginTop: 4 }}>오늘 획득 점수 {total}점</div>
          </div>
        )}
        {showBreak && <GuideBreak onSkip={endBreak} />}
        {current && !showBreak && (
          <div style={{ border: "2px solid var(--acc)", borderRadius: 12, padding: 12, marginBottom: 12 }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: "var(--acc)" }}>STEP {active.indexOf(current) + 1} / {active.length}</div>
            <div style={{ fontSize: 15, fontWeight: 800, color: "var(--tp)", margin: "2px 0" }}>{current.m.label}</div>
            <div style={{ fontSize: 11, color: "var(--tm)", marginBottom: 8 }}>{current.m.hint} · {current.m.mode === "step" ? `완료 시 ${current.m.points}점` : `건당 ${current.m.points}점`} + 단계 보너스 {STEP_POINTS}점</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {current.items.map(it => (
                <div key={it.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 8px", borderRadius: 8, background: (it.held || it.wip) ? "rgba(148,163,184,.18)" : it.done ? "rgba(16,185,129,.1)" : "var(--bg2)" }}>
                  <div style={{ width: 18, height: 18, borderRadius: 9, flexShrink: 0, border: it.done ? "none" : "2px solid var(--brd)", background: it.held ? "var(--tm)" : it.done ? "var(--ok)" : "transparent", color: "#fff", fontSize: 11, display: "flex", alignItems: "center", justifyContent: "center" }}>{it.held ? "–" : it.done ? "✓" : ""}</div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 12, fontWeight: 600, color: "var(--tp)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", textDecoration: it.done ? "line-through" : "none" }}>{it.title}{it.badge && <span style={{ marginLeft: 6, fontSize: 10, fontWeight: 700, color: "var(--acc)", background: "var(--hover)", borderRadius: 4, padding: "1px 5px", textDecoration: "none", display: "inline-block" }}>{it.badge}</span>}{it.held && <span style={{ marginLeft: 6, fontSize: 10, color: "var(--tm)" }}>보류</span>}{it.wip && <span style={{ marginLeft: 6, fontSize: 10, color: "var(--tm)" }}>진행중</span>}</div>
                    {it.sub && <div style={{ fontSize: 10, color: "var(--tm)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{it.sub}</div>}
                  </div>
                  {!it.done && current.m.mode === "check" && <button style={{ ...btn, background: "var(--acc)", color: "#fff", border: "none" }} onClick={() => grant(current.key, it.id, current.m.points)}>확인</button>}
                  {!it.done && current.m.allowProgress && <button style={btn} onClick={() => grant(current.key, `${it.id}~wip`, WIP_POINTS)}>진행중</button>}
                  {!it.done && current.m.allowHold && <button style={btn} onClick={() => grant(current.key, it.id, 0)}>보류</button>}
                  {!it.done && it.go && <button style={btn} onClick={it.go}>이동</button>}
                </div>
              ))}
            </div>
            {current.empty && (
              <div style={{ textAlign: "center", padding: "10px 0 4px" }}>
                <div style={{ fontSize: 13, color: "var(--ts)", marginBottom: 10 }}>오늘 해당 대상자가 없습니다.</div>
                <button disabled={!dataReady} onClick={() => grant(current.key, "none", NONE_POINTS)} style={{ ...btn, padding: "8px 28px", fontSize: 13, background: "var(--acc)", color: "#fff", border: "none", opacity: dataReady ? 1 : 0.5 }}>없음</button>
                <div style={{ fontSize: 10, color: "var(--tm)", marginTop: 6 }}>확인 후 [없음]을 누르면 다음 단계로 넘어갑니다 (+{NONE_POINTS}점)</div>
              </div>
            )}
            {current.m.mode === "step" && <div style={{ fontSize: 10, color: "var(--tm)", marginTop: 8 }}>이 단계는 해당 화면에서 데이터를 한 번 입력/수정하면 완료됩니다.</div>}
          </div>
        )}

        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          {steps.map((s, i) => (
            <div key={s.key} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, color: s.skip ? "var(--tm)" : s.done ? "var(--ok)" : "var(--ts)", opacity: s.skip ? 0.6 : 1 }}>
              <span style={{ width: 16, textAlign: "center", fontWeight: 700 }}>{s.skip ? "–" : s.done ? "✓" : current === s ? "▶" : i + 1}</span>
              <span style={{ flex: 1, fontWeight: current === s ? 700 : 500 }}>{s.m.label}</span>
              <span style={{ fontSize: 10, color: "var(--tm)" }}>{s.empty ? (s.done ? "없음 확인" : "해당 없음") : `${s.items.filter(x => x.done).length}/${s.items.length}`}</span>
            </div>
          ))}
        </div>
      </div>
      {allClear && finaleNote && (
        <div style={{ padding: "10px 14px", borderTop: "1px solid var(--brd)", background: "var(--hover)", fontSize: 12, fontWeight: 700, color: "var(--tp)" }}>📧 {finaleNote}</div>
      )}
    </div>
  );
}
