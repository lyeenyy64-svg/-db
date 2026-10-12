// 커밋 직전에 "이번에 추가되는 줄"에 API 키·비밀번호·개인키가 들어있는지 검사한다 (개인정보보호 조치 8번).
// 사용법: node scripts/check_secrets.cjs   (git add 이후, 커밋 전에 — .githooks/pre-commit 이 자동 실행)
// 정말 의도한 값이면 SKIP_SECRET_SCAN=1 git commit ... 으로 건너뛸 수 있다.
const { execSync } = require("child_process");

if (process.env.SKIP_SECRET_SCAN === "1") process.exit(0);

const RULES = [
  ["Slack 토큰", /xox[bpas]-[A-Za-z0-9-]{20,}/],
  ["OpenAI/API 키", /sk-[A-Za-z0-9_-]{30,}/],
  ["Notion 통합 토큰", /secret_[A-Za-z0-9]{30,}/],
  ["AWS 액세스 키", /AKIA[0-9A-Z]{16}/],
  ["카카오 등 16진수 키", /(KAKAO[A-Z_]*KEY|REST_API_KEY|APP_KEY)\s*[:=]\s*["']?[0-9a-f]{20,}/i],
  ["코드에 박힌 비밀번호", /password\s*[:=]\s*["'][^"'\s]{4,}["']/i],
  ["코드에 박힌 비밀값", /(secret|passcode|api[_-]?key|token)\s*[:=]\s*["'][A-Za-z0-9!@#$%^&*_\-]{8,}["']/i],
  ["개인키", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
];
// 검사에서 제외: 자리표시자/예시 파일, 이 스크립트 자체, 생성 산출물
const SKIP_FILES = /(^|\/)(\.env\.example|package-lock\.json|scripts\/check_secrets\.cjs)$|^dist\//;
const SENSITIVE_FILES = /(^|\/)(\.env|.*\.pfx|.*\.pem|.*\.key|.*\.p12)$/i;

let diff = "";
try { diff = execSync("git diff --cached --no-color -U0", { maxBuffer: 1 << 30 }).toString("utf8"); } catch { process.exit(0); }
let names = [];
try { names = execSync("git diff --cached --name-only --diff-filter=AM", { maxBuffer: 1 << 26 }).toString("utf8").split("\n").filter(Boolean); } catch {}

const problems = [];
for (const f of names) if (SENSITIVE_FILES.test(f) && !SKIP_FILES.test(f)) problems.push(`${f}: 키/인증서/환경설정 파일은 저장소에 올리면 안 됩니다`);

let file = "";
for (const line of diff.split("\n")) {
  if (line.startsWith("+++ b/")) { file = line.slice(6); continue; }
  if (!line.startsWith("+") || line.startsWith("+++") || SKIP_FILES.test(file)) continue;
  for (const [name, re] of RULES) {
    if (re.test(line)) problems.push(`${file}: ${name} 의심 — ${line.slice(1, 70).replace(/[A-Za-z0-9]{12,}/g, m => m.slice(0, 4) + "…")}`);
  }
}

if (problems.length) {
  console.error("\n[비밀값 검사] 커밋을 중단했습니다. 아래 항목을 코드에서 빼고 backend/.env(또는 환경변수)로 옮기세요:\n");
  for (const p of [...new Set(problems)]) console.error("  - " + p);
  console.error("\n의도한 값이라면: SKIP_SECRET_SCAN=1 git commit ...\n");
  process.exit(1);
}
