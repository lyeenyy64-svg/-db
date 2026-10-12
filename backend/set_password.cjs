// 비상용: 서버 PC에서 특정 계정의 비밀번호를 직접 지정한다 (다음 로그인 때 새 비밀번호 설정을 강제).
// 사용법: node backend/set_password.cjs <이름 또는 이메일> <새 비밀번호>
// 예) 관리자 전원이 비밀번호를 잊었거나, 계정에 비밀번호가 아직 없을 때.
const path = require("path");
const Database = require("better-sqlite3");
const { hashPassword, validatePassword } = require("./auth.cjs");

const [login, pw] = process.argv.slice(2);
if (!login || !pw) { console.error("사용법: node backend/set_password.cjs <이름 또는 이메일> <새 비밀번호>"); process.exit(1); }
const bad = validatePassword(pw);
if (bad) { console.error(bad); process.exit(1); }

const db = new Database(path.join(__dirname, "..", "db", "debtflow.db"));
const v = login.trim().toLowerCase();
const acc = db.prepare("SELECT id, name FROM auth_accounts WHERE lower(name) = ? OR lower(email) = ?").get(v, v);
if (!acc) { console.error("계정을 찾을 수 없습니다 (서버를 한 번 시작해 계정 이전이 끝난 뒤 실행하세요)"); process.exit(1); }
db.prepare("UPDATE auth_accounts SET password_hash = ?, must_change_pw = 1 WHERE id = ?").run(hashPassword(pw), acc.id);
db.prepare("DELETE FROM auth_sessions WHERE user_id = ?").run(acc.id);
console.log(`${acc.name} 계정의 비밀번호를 설정했습니다. 다음 로그인 때 새 비밀번호를 정하게 됩니다.`);
