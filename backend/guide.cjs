// 업무 길라잡이(데일리 미션) — 점수 저장/조회 API.
// 완료 판정에 쓰는 "오늘 내가 입력한 기록"은 user_activity_log(data_input)에서 읽고,
// 점수는 guide_scores에 (사용자·날짜·미션·항목) 단위로 한 번만 쌓는다(중복 지급 방지).
// 이 라우트들은 server.cjs의 접속기록 미들웨어보다 먼저 등록되므로 활동로그/입력량 통계에 섞이지 않는다.
module.exports = function setupGuide(app, db, extractUserName) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS guide_scores (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_name TEXT NOT NULL,
      date TEXT NOT NULL,
      mission TEXT NOT NULL,
      item_id TEXT NOT NULL,
      points INTEGER NOT NULL DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now','localtime')),
      UNIQUE(user_name, date, mission, item_id)
    );
    CREATE INDEX IF NOT EXISTS idx_guide_scores_date ON guide_scores(date);
  `);

  const todayStr = () => {
    const d = new Date();
    const p = n => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  };
  const myName = req => {
    const n = extractUserName(req);
    return n && n !== "알수없음" ? n : null;
  };

  // 오늘 내가 입력한 데이터 기록(경로·대상 채무자) — 클라이언트가 미션 항목별 완료를 판정하는 근거
  app.get("/api/guide/activity", (req, res) => {
    const user = myName(req);
    if (!user) return res.status(401).json({ error: "login required" });
    const date = todayStr();
    const rows = db.prepare(
      `SELECT path, ref_debtor_id AS refDebtorId, ts FROM user_activity_log
       WHERE type='data_input' AND user_name=? AND substr(ts,1,10)=? AND bytes > 0
       ORDER BY ts DESC LIMIT 2000`
    ).all(user, date);
    res.json({ date, rows });
  });

  app.get("/api/guide/awards", (req, res) => {
    const user = myName(req);
    if (!user) return res.status(401).json({ error: "login required" });
    const date = todayStr();
    const rows = db.prepare("SELECT mission, item_id AS itemId, points FROM guide_scores WHERE user_name=? AND date=?").all(user, date);
    res.json({ date, rows, total: rows.reduce((s, r) => s + r.points, 0) });
  });

  // 점수 지급 — 오늘 날짜만, 같은 항목은 한 번만(INSERT OR IGNORE)
  app.post("/api/guide/award", (req, res) => {
    const user = myName(req);
    if (!user) return res.status(401).json({ error: "login required" });
    const b = req.body || {};
    const mission = String(b.mission || "").slice(0, 40);
    const itemId = String(b.itemId || "").slice(0, 120);
    const points = Math.max(0, Math.min(100, parseInt(b.points, 10) || 0));
    if (!mission || !itemId) return res.status(400).json({ error: "mission/itemId required" });
    const r = db.prepare("INSERT OR IGNORE INTO guide_scores (user_name, date, mission, item_id, points) VALUES (?,?,?,?,?)")
      .run(user, todayStr(), mission, itemId, points);
    res.json({ ok: true, added: r.changes > 0 });
  });

  // 일별/월별/연간 점수 (통계 화면용)
  app.get("/api/guide/stats", (req, res) => {
    const q = len => db.prepare(
      `SELECT substr(date,1,${len}) AS period, user_name AS user, SUM(points) AS score
       FROM guide_scores WHERE user_name NOT IN ('Claude','관리자')
       GROUP BY period, user ORDER BY period DESC`
    ).all();
    res.json({ daily: q(10), monthly: q(7), yearly: q(4) });
  });
};
