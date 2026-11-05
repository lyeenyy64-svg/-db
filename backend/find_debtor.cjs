// 이름 일부로 채무자를 찾는다 (읽기 전용).
// 사용법: node backend/find_debtor.cjs 홍정      (이름에 '홍정'이 들어간 채무자)
//         node backend/find_debtor.cjs 정용
const path = require("path");
const Database = require("better-sqlite3");

const DB_PATH = process.env.DEBTFLOW_DB_PATH || path.join(__dirname, "..", "db", "debtflow.db");
const q = (process.argv[2] || "").replace(/\s+/g, "");
if (!q) { console.log("사용법: node backend/find_debtor.cjs <이름 일부>"); process.exit(1); }

const db = new Database(DB_PATH, { readonly: true });
const rows = db.prepare("SELECT id, name, brand_code AS brand, category, principal_balance AS bal FROM debtors WHERE REPLACE(name, ' ', '') LIKE ?").all(`%${q}%`);
console.log(`'${q}' 포함 채무자 ${rows.length}명`);
rows.forEach(r => console.log(`  ${r.id}  ${r.name}  브랜드 ${r.brand}  분류 ${r.category}  원금잔액 ${r.bal}`));
