// BAROGO DEBTFLOW — 미매칭 최종 재처리 v4
// 실행: node retry_pending.cjs

const Database = require("better-sqlite3");
const path = require("path");
const fs = require("fs");
const matcher = require("./backend/matcher.cjs");

const DB_PATH = path.join(__dirname, "db", "debtflow.db");
if (!fs.existsSync(DB_PATH)) { console.error("DB 파일 없음"); process.exit(1); }

const db = new Database(DB_PATH);
db.pragma("foreign_keys = ON");

const allDebtors = db.prepare("SELECT id, brand_code, name, hub_code FROM debtors").all();
const idx = matcher.buildIndex(allDebtors);

// hub_code로 채무자 ID 찾기
function findByHubCode(hubCode, brand) {
  var found = allDebtors.filter(function(d) {
    return d.hub_code === hubCode && (!brand || brand === '?' || d.brand_code === brand);
  });
  return found.length === 1 ? found[0].id : (found.length > 0 ? found[0].id : null);
}

// 이름 정규화로 찾기
function findByName(name, brand) {
  var m = matcher.matchDebtor(idx, { brand: brand === '?' ? null : brand, hubCode: null, debtorName: name, payerName: null });
  return m ? m.debtorId : null;
}

// 추가 매핑: 오류난 입금자들 hubCode 기반으로 재매핑
var EXTRA = [["송채안", "송봉은(송채안)", "M", "1778"], ["고윤기01", "고윤기", "M", "537-1"], ["딜버옥천", "임관식", "D", "260309"], ["신민정01", "신민정", "B", "6106"], ["미래/김현민", "김현민", "B", "6847"], ["김보경11", "전영주", "B", "2785-2"], ["이동규", "이동규95", "D", "1197"], ["김성훈01", "김성훈", "M", "1218"], ["김영준", "김영준97", "B", "7248"], ["서병택", "서병택1,2", "B", "017"], ["김일호", "김동욱", "M", "2332"], ["고윤기", "고윤기", "M", "537"], ["문호섭", "문호섭", "D", "1234-1"], ["채병민00", "채병민", "B", "5816-3"], ["전영재11", "전영재", "B", "3620"], ["임하준", "임동연", "B", "113"], ["이민우11", "이민우4", "B", "4268-3"], ["우일남", "우일남", "D", "1012"]];

console.log("=== 추가 매핑 등록 ===");
var added = 0;
for (var i = 0; i < EXTRA.length; i++) {
  var payer = EXTRA[i][0], debtorName = EXTRA[i][1], brand = EXTRA[i][2], hubCode = EXTRA[i][3];
  var debtorId = findByHubCode(hubCode, brand) || findByName(debtorName, brand);
  if (!debtorId) {
    console.log("  못 찾음: " + debtorName + " [" + brand + "] " + hubCode);
    continue;
  }
  var debtor = allDebtors.find(function(d) { return d.id === debtorId; });
  db.prepare("INSERT INTO payer_name_mappings (payer_name,debtor_id,debtor_name,resolved_count,learned_at) VALUES (?,?,?,1,datetime('now','localtime')) ON CONFLICT(payer_name) DO UPDATE SET debtor_id=excluded.debtor_id, debtor_name=excluded.debtor_name")
    .run(payer, debtorId, debtor ? debtor.name : debtorName);
  console.log("  등록: '" + payer + "' → " + (debtor ? debtor.name : debtorName) + " [" + debtorId + "]");
  added++;
}
console.log("추가 등록: " + added + "건\n");

// 전체 매핑 테이블 로드
var learnedMap = {};
db.prepare("SELECT payer_name, debtor_id FROM payer_name_mappings").all().forEach(function(r) {
  learnedMap[r.payer_name] = r.debtor_id;
});

// 미매칭 재처리
var pending = db.prepare("SELECT * FROM pending_payments WHERE resolved = 0").all();
console.log("=== 미매칭 재처리: " + pending.length + "건 ===");

function nextPayId() {
  var row = db.prepare("SELECT id FROM payments ORDER BY id DESC LIMIT 1").get();
  if (!row) return "PAY00001";
  return "PAY" + String(parseInt(row.id.replace(/\D/g,""),10)+1).padStart(5,"0");
}

var success = 0, fail = 0, failList = [];

for (var i = 0; i < pending.length; i++) {
  var p = pending[i];
  var debtorId = learnedMap[p.payer_name] || null;
  var matchedBy = debtorId ? "학습매핑" : "";

  if (!debtorId) {
    var m = matcher.matchDebtor(idx, {
      brand: p.excel_brand||null, hubCode: p.excel_hub_code||null,
      debtorName: p.excel_debtor_name||null, payerName: p.payer_name||null
    });
    if (m) { debtorId = m.debtorId; matchedBy = m.matchedBy; }
  }

  if (!debtorId) {
    fail++;
    failList.push("  미매칭: [" + (p.excel_brand||"?") + "] 입금자:" + (p.payer_name||"?") + " / " + Number(p.total_amount).toLocaleString() + "원");
    continue;
  }

  var debtor = db.prepare("SELECT * FROM debtors WHERE id=?").get(debtorId);
  if (!debtor) { fail++; failList.push("  채무자없음: " + debtorId); continue; }

  var dup = db.prepare("SELECT id FROM payments WHERE debtor_id=? AND payment_date=? AND total_amount=?")
    .get(debtorId, p.payment_date, p.total_amount);

  try {
    (db.transaction(function(pp,did,deb,dupRow) { return function() {
      if (dupRow) {
        db.prepare("UPDATE pending_payments SET resolved=1, resolved_to_payment_id=? WHERE id=?").run(dupRow.id, pp.id);
      } else {
        var payId = nextPayId();
        db.prepare("INSERT INTO payments (id,debtor_id,payment_date,payer_name,total_amount,company_account,cash_charge,welcome_direct,note,created_by) VALUES (?,?,?,?,?,?,?,?,?,?)")
          .run(payId,did,pp.payment_date,pp.payer_name,pp.total_amount,
            pp.company_account||pp.total_amount, pp.cash_charge||0, pp.welcome_direct||0, pp.note||null,"재처리v4");
        db.prepare("UPDATE debtors SET collected_amount=collected_amount+?, updated_at=datetime('now','localtime') WHERE id=?")
          .run(pp.total_amount, did);
        db.prepare("UPDATE pending_payments SET resolved=1, resolved_to_payment_id=? WHERE id=?").run(payId, pp.id);
      }
    };})(p,debtorId,debtor,dup))();
    success++;
    console.log("  [" + matchedBy + "] " + debtor.name + " <- " + (p.payer_name||"?") + " " + Number(p.total_amount).toLocaleString() + "원");
  } catch(e) {
    fail++;
    failList.push("  오류: " + (p.payer_name||"?") + " - " + e.message);
  }
}

console.log("\n========== 결과 ==========");
console.log("성공: " + success + "건 / 미매칭: " + fail + "건");
if (failList.length > 0) {
  console.log("\n[미매칭 잔여]");
  failList.forEach(function(s){ console.log(s); });
}
var remaining = db.prepare("SELECT COUNT(*) AS c FROM pending_payments WHERE resolved=0").get().c;
console.log("\n대기열 잔여: " + remaining + "건");
console.log("브라우저 새로고침하면 반영됩니다.");
db.close();
