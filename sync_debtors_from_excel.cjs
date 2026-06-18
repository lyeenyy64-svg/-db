// BAROGO DEBTFLOW — 채무자 분류 동기화 스크립트 v3
// 실행: node sync_debtors_from_excel.cjs

const Database = require("better-sqlite3");
const path = require("path");
const fs = require("fs");

const DB_PATH = path.join(__dirname, "db", "debtflow.db");
const JSON_PATH = path.join(__dirname, "excel_debtors.json");

if (!fs.existsSync(DB_PATH)) { console.error("DB 파일 없음: " + DB_PATH); process.exit(1); }
if (!fs.existsSync(JSON_PATH)) { console.error("JSON 파일 없음: " + JSON_PATH); process.exit(1); }

// foreign_keys OFF로 먼저 열기
const db = new Database(DB_PATH);
db.pragma("foreign_keys = OFF");
db.pragma("journal_mode = WAL");

const excelRows = JSON.parse(fs.readFileSync(JSON_PATH, "utf-8"));
console.log("엑셀 데이터: " + excelRows.length + "건");

// 1. brands 테이블에 없는 브랜드 등록
const existingBrands = new Set(db.prepare("SELECT code FROM brands").all().map(function(r){ return r.code; }));
const brandDefs = {
  "B": { name: "바로고",   color: "#3b82f6", sort_order: 1 },
  "D": { name: "딜버",     color: "#8b5cf6", sort_order: 2 },
  "M": { name: "모아라인", color: "#f59e0b", sort_order: 3 },
  "G": { name: "그라이더", color: "#10b981", sort_order: 4 },
};
var brandKeys = Object.keys(brandDefs);
for (var bi = 0; bi < brandKeys.length; bi++) {
  var code = brandKeys[bi];
  var def = brandDefs[code];
  if (!existingBrands.has(code)) {
    db.prepare("INSERT OR IGNORE INTO brands (code, name, color, sort_order) VALUES (?, ?, ?, ?)").run(code, def.name, def.color, def.sort_order);
    console.log("브랜드 등록: " + code + " (" + def.name + ")");
  }
}
console.log("brands 테이블 현황: " + db.prepare("SELECT code FROM brands").all().map(function(r){ return r.code; }).join(", "));

// 2. DB 채무자 로드
const dbDebtors = db.prepare("SELECT * FROM debtors").all();
console.log("DB 현재 채무자: " + dbDebtors.length + "건");

function normName(name) {
  if (!name) return "";
  return String(name)
    .replace(/㈜/g, "").replace(/\(주\)/g, "").replace(/주식회사/g, "")
    .replace(/\([^)]*\)/g, "").replace(/>[^>]*$/, "")
    .replace(/\s+/g, "").trim().toLowerCase();
}

var byBrandHub = {};
var byNorm = {};
for (var di = 0; di < dbDebtors.length; di++) {
  var d = dbDebtors[di];
  var bk = d.brand_code + "|" + (d.hub_code || "");
  if (!byBrandHub[bk]) byBrandHub[bk] = [];
  byBrandHub[bk].push(d);
  var nn = normName(d.name);
  if (nn) {
    if (!byNorm[nn]) byNorm[nn] = [];
    byNorm[nn].push(d);
  }
}

// 3. 업데이트/삽입
const updateStmt = db.prepare(
  "UPDATE debtors SET category=@category, assignee=@assignee, collection_status=@collection_status, " +
  "principal_balance=@principal_balance, adjustment=@adjustment, collected_amount=@collected_amount, " +
  "updated_at=datetime('now','localtime') WHERE id=@id"
);

var maxId = 0;
for (var mi = 0; mi < dbDebtors.length; mi++) {
  var n = parseInt(dbDebtors[mi].id.replace(/\D/g, ""), 10);
  if (!isNaN(n) && n > maxId) maxId = n;
}
var idCounter = maxId;

const insertStmt = db.prepare(
  "INSERT OR IGNORE INTO debtors (id,brand_code,category,assignee,name,hub_code,hub_name," +
  "collection_status,principal_balance,adjustment,collected_amount,created_at,updated_at) " +
  "VALUES (@id,@brand_code,@category,@assignee,@name,@hub_code,@hub_name," +
  "@collection_status,@principal_balance,@adjustment,@collected_amount," +
  "datetime('now','localtime'),datetime('now','localtime'))"
);

var updated = 0, inserted = 0;
var newItems = [];

for (var ri = 0; ri < excelRows.length; ri++) {
  var row = excelRows[ri];
  var hubCode = row.hub_code ? String(row.hub_code).trim() : "";
  var brand = row.brand || "";
  var matched = null;

  // 1단계: brand+hub_code
  if (brand && hubCode) {
    var cands = byBrandHub[brand + "|" + hubCode] || [];
    if (cands.length === 1) {
      matched = cands[0];
    } else if (cands.length > 1) {
      var nn2 = normName(row.name);
      for (var ci = 0; ci < cands.length; ci++) {
        if (normName(cands[ci].name) === nn2) { matched = cands[ci]; break; }
      }
      if (!matched) matched = cands[0];
    }
  }
  // 2단계: 이름 정규화
  if (!matched && row.name) {
    var nn3 = normName(row.name);
    var cands2 = (byNorm[nn3] || []).filter(function(d){ return d.brand_code === brand; });
    if (cands2.length === 1) matched = cands2[0];
  }

  if (matched) {
    updateStmt.run({
      id: matched.id,
      category: row.category,
      assignee: row.assignee || matched.assignee,
      collection_status: row.collection_status || "추심진행",
      principal_balance: row.principal || 0,
      adjustment: row.adjustment || 0,
      collected_amount: row.collected || 0,
    });
    updated++;
  } else {
    idCounter++;
    var newId = "NPL" + String(idCounter).padStart(4, "0");
    insertStmt.run({
      id: newId,
      brand_code: brand,
      category: row.category,
      assignee: row.assignee || null,
      name: row.name,
      hub_code: hubCode || null,
      hub_name: row.hub_name || null,
      collection_status: row.collection_status || "추심진행",
      principal_balance: row.principal || 0,
      adjustment: row.adjustment || 0,
      collected_amount: row.collected || 0,
    });
    newItems.push({ id: newId, name: row.name, category: row.category });
    inserted++;
  }
}

console.log("\n동기화 완료");
console.log("  업데이트: " + updated + "건");
console.log("  신규삽입: " + inserted + "건");

var afterStats = db.prepare("SELECT category, COUNT(*) AS cnt FROM debtors GROUP BY category ORDER BY cnt DESC").all();
console.log("\nDB 분류별 현황:");
for (var si = 0; si < afterStats.length; si++) {
  console.log("  " + afterStats[si].category + ": " + afterStats[si].cnt + "건");
}

if (newItems.length > 0) {
  console.log("\n신규 삽입 " + newItems.length + "건:");
  for (var ni = 0; ni < newItems.length; ni++) {
    console.log("  [" + newItems[ni].id + "] " + newItems[ni].name + " (" + newItems[ni].category + ")");
  }
}

db.close();
console.log("\n서버를 재시작하면 변경사항이 반영됩니다.");
