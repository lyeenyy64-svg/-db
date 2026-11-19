import { useEffect, useRef, useState } from "react";

// 업무 길라잡이 첫 단계를 끝낸 뒤 보여주는 휴식 카드 — 멍때리기 / 게임 / 기사 / 음악
// 외부 서비스에 의존하지 않도록 멍때리기·게임은 전부 이 파일 안에서 동작하고, 기사·음악은 새 탭 링크만 건다.

const tab = (on) => ({ flex: 1, padding: "6px 0", fontSize: 12, fontWeight: 700, cursor: "pointer", border: "none", borderBottom: on ? "2px solid var(--acc)" : "2px solid transparent", background: "none", color: on ? "var(--acc)" : "var(--tm)" });
const sbtn = { padding: "5px 12px", borderRadius: 6, fontSize: 12, fontWeight: 600, cursor: "pointer", border: "1px solid var(--brd)", background: "var(--card)", color: "var(--ts)" };
const pbtn = { ...sbtn, background: "var(--acc)", color: "#fff", border: "none" };

// ── 멍때리기: 숨쉬기 원 + 타이머 + (선택) 빗소리 ──
const BREATH_CSS = `@keyframes gqBreath{0%,100%{transform:scale(.55)}50%{transform:scale(1)}}`;
function Zone() {
  const [sec, setSec] = useState(180);
  const [run, setRun] = useState(false);
  const [rain, setRain] = useState(false);
  const audio = useRef(null);
  useEffect(() => {
    if (!run) return;
    const t = setInterval(() => setSec(s => (s <= 1 ? (setRun(false), 180) : s - 1)), 1000);
    return () => clearInterval(t);
  }, [run]);
  // 빗소리: 화이트 노이즈를 저역 통과 필터로 눌러서 만든다 (파일/외부 링크 불필요)
  useEffect(() => {
    if (!rain) return;
    let ctx;
    try {
      ctx = new (window.AudioContext || window.webkitAudioContext)();
      const buf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
      const d = buf.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
      const src = ctx.createBufferSource(); src.buffer = buf; src.loop = true;
      const f = ctx.createBiquadFilter(); f.type = "lowpass"; f.frequency.value = 900;
      const g = ctx.createGain(); g.gain.value = 0.12;
      src.connect(f); f.connect(g); g.connect(ctx.destination); src.start();
      audio.current = ctx;
    } catch { setRain(false); }
    return () => { try { ctx && ctx.close(); } catch { /* 무시 */ } };
  }, [rain]);
  const mm = String(Math.floor(sec / 60)), ss = String(sec % 60).padStart(2, "0");
  return (
    <div style={{ textAlign: "center", padding: "8px 0" }}>
      <style>{BREATH_CSS}</style>
      <div style={{ height: 120, display: "flex", alignItems: "center", justifyContent: "center" }}>
        <div style={{ width: 100, height: 100, borderRadius: "50%", background: "radial-gradient(circle,#93c5fd,#3b82f6)", opacity: .8, animation: run ? "gqBreath 8s ease-in-out infinite" : "none", transform: run ? undefined : "scale(.7)" }} />
      </div>
      <div style={{ fontSize: 12, color: "var(--ts)", margin: "4px 0" }}>{run ? "커질 때 들이쉬고, 작아질 때 내쉬세요" : "화면만 바라보며 3분간 아무 생각 하지 않기"}</div>
      <div className="mono" style={{ fontSize: 22, fontWeight: 800, color: "var(--tp)", marginBottom: 8 }}>{mm}:{ss}</div>
      <div style={{ display: "flex", gap: 6, justifyContent: "center" }}>
        <button style={pbtn} onClick={() => { if (run) setSec(180); setRun(r => !r); }}>{run ? "그만하기" : "시작"}</button>
        <button style={{ ...sbtn, ...(rain ? { background: "var(--hover)", color: "var(--acc)" } : {}) }} onClick={() => setRain(r => !r)}>🌧 빗소리 {rain ? "끄기" : "켜기"}</button>
      </div>
    </div>
  );
}

// ── 두더지 잡기 (20초) ──
function Mole() {
  const [on, setOn] = useState(false);
  const [left, setLeft] = useState(20);
  const [score, setScore] = useState(0);
  const [pos, setPos] = useState(-1);
  const [best, setBest] = useState(0);
  useEffect(() => {
    if (!on) return;
    const t = setInterval(() => setLeft(l => l - 1), 1000);
    const m = setInterval(() => setPos(Math.floor(Math.random() * 9)), 650);
    return () => { clearInterval(t); clearInterval(m); };
  }, [on]);
  useEffect(() => { if (on && left <= 0) { setOn(false); setPos(-1); setBest(b => Math.max(b, score)); } }, [left, on, score]);
  const start = () => { setScore(0); setLeft(20); setOn(true); };
  const hit = (i) => { if (on && i === pos) { setScore(s => s + 1); setPos(-1); } };
  return (
    <div style={{ textAlign: "center" }}>
      <div style={{ fontSize: 12, color: "var(--ts)", marginBottom: 6 }}>🐹 두더지를 클릭하세요 · 남은 시간 <b>{left}</b>초 · 점수 <b>{score}</b> · 최고 {best}</div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 64px)", gap: 8, justifyContent: "center", marginBottom: 8 }}>
        {Array.from({ length: 9 }, (_, i) => (
          <div key={i} onMouseDown={() => hit(i)} style={{ height: 52, borderRadius: 10, background: "#8b5e3c", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 28, cursor: "pointer", userSelect: "none" }}>{i === pos ? "🐹" : ""}</div>
        ))}
      </div>
      <button style={pbtn} onClick={start}>{on ? "다시 시작" : "시작"}</button>
    </div>
  );
}

// ── 카드 짝맞추기 ──
const FACES = ["🍎", "🚚", "☕", "📦", "🌸", "🎧"];
const deal = () => [...FACES, ...FACES].map((f, i) => ({ f, i })).sort(() => Math.random() - 0.5);
function Memory() {
  const [cards, setCards] = useState(deal);
  const [open, setOpen] = useState([]);
  const [done, setDone] = useState([]);
  const [moves, setMoves] = useState(0);
  const pick = (i) => {
    if (open.length === 2 || open.includes(i) || done.includes(cards[i].f)) return;
    const next = [...open, i];
    setOpen(next);
    if (next.length === 2) {
      setMoves(m => m + 1);
      if (cards[next[0]].f === cards[next[1]].f) { setDone(d => [...d, cards[i].f]); setOpen([]); }
      else setTimeout(() => setOpen([]), 700);
    }
  };
  const reset = () => { setCards(deal()); setOpen([]); setDone([]); setMoves(0); };
  const win = done.length === FACES.length;
  return (
    <div style={{ textAlign: "center" }}>
      <div style={{ fontSize: 12, color: "var(--ts)", marginBottom: 6 }}>{win ? `🎉 ${moves}번 만에 완성!` : `같은 그림 찾기 · 시도 ${moves}회`}</div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 54px)", gap: 6, justifyContent: "center", marginBottom: 8 }}>
        {cards.map((c, i) => {
          const show = open.includes(i) || done.includes(c.f);
          return <div key={c.i} onClick={() => pick(i)} style={{ height: 54, borderRadius: 8, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 26, cursor: "pointer", userSelect: "none", background: show ? "var(--bg2)" : "var(--acc)", border: "1px solid var(--brd)" }}>{show ? c.f : ""}</div>;
        })}
      </div>
      <button style={sbtn} onClick={reset}>새로 섞기</button>
    </div>
  );
}

function Games() {
  const [g, setG] = useState("mole");
  return (
    <div>
      <div style={{ display: "flex", gap: 6, justifyContent: "center", marginBottom: 8 }}>
        <button style={{ ...sbtn, ...(g === "mole" ? { background: "var(--hover)", color: "var(--acc)" } : {}) }} onClick={() => setG("mole")}>두더지 잡기</button>
        <button style={{ ...sbtn, ...(g === "mem" ? { background: "var(--hover)", color: "var(--acc)" } : {}) }} onClick={() => setG("mem")}>짝맞추기</button>
      </div>
      {g === "mole" ? <Mole /> : <Memory />}
    </div>
  );
}

const linkRow = { display: "flex", alignItems: "center", gap: 8, padding: "7px 10px", borderRadius: 8, background: "var(--bg2)", fontSize: 12, fontWeight: 600, color: "var(--tp)", textDecoration: "none" };
const NEWS = [
  ["📰 네이버 뉴스 — 경제", "https://news.naver.com/section/101"],
  ["📰 연합뉴스 — 주요뉴스", "https://www.yna.co.kr/"],
  ["⚖️ 법률신문", "https://www.lawtimes.co.kr/"],
  ["🛵 배달·물류 소식 검색", "https://search.naver.com/search.naver?where=news&query=%EB%B0%B0%EB%8B%AC+%EB%9D%BC%EC%8A%A4%ED%8A%B8%EB%A7%88%EC%9D%BC"],
];
const yt = (q) => "https://www.youtube.com/results?search_query=" + encodeURIComponent(q);
const MUSIC = [
  ["🎹 잔잔한 피아노", yt("잔잔한 피아노 플레이리스트")],
  ["☕ 카페 재즈", yt("카페 재즈 플레이리스트")],
  ["🌿 로파이 · 집중", yt("lofi hip hop 집중")],
  ["🎤 신나는 K-POP", yt("k-pop 플레이리스트 신나는")],
  ["🌊 자연 소리 (ASMR)", yt("자연 소리 힐링 10시간")],
];
const Links = ({ items, note }) => (
  <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
    {items.map(([t, u]) => <a key={t} href={u} target="_blank" rel="noopener noreferrer" style={linkRow}>{t}<span style={{ marginLeft: "auto", color: "var(--tm)", fontWeight: 400 }}>↗</span></a>)}
    <div style={{ fontSize: 10, color: "var(--tm)" }}>{note}</div>
  </div>
);

export default function GuideBreak({ onSkip, title = "첫 단계 완료! 잠깐 쉬어가세요" }) {
  const [t, setT] = useState("zone");
  return (
    <div style={{ border: "2px dashed var(--ok)", borderRadius: 12, padding: 10, marginBottom: 12, background: "rgba(16,185,129,.06)" }}>
      <div style={{ fontSize: 13, fontWeight: 800, color: "var(--tp)" }}>☕ {title}</div>
      <div style={{ fontSize: 11, color: "var(--tm)", marginBottom: 6 }}>쉬고 나서 [휴식 끝]을 누르면 다음 단계로 이어집니다.</div>
      <div style={{ display: "flex", borderBottom: "1px solid var(--brd)", marginBottom: 10 }}>
        <button style={tab(t === "zone")} onClick={() => setT("zone")}>멍때리기</button>
        <button style={tab(t === "game")} onClick={() => setT("game")}>게임</button>
        <button style={tab(t === "news")} onClick={() => setT("news")}>기사</button>
        <button style={tab(t === "music")} onClick={() => setT("music")}>음악</button>
      </div>
      {t === "zone" && <Zone />}
      {t === "game" && <Games />}
      {t === "news" && <Links items={NEWS} note="새 탭에서 열립니다. 업무 화면은 그대로 유지돼요." />}
      {t === "music" && <Links items={MUSIC} note="유튜브 검색 결과가 새 탭에서 열립니다." />}
      <div style={{ textAlign: "right", marginTop: 10 }}><button style={pbtn} onClick={onSkip}>휴식 끝 · 다음 단계로</button></div>
    </div>
  );
}
