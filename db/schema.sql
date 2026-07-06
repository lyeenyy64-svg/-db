-- ============================================================
-- BAROGO DEBTFLOW — 데이터베이스 스키마 v1
-- DBMS  : SQLite 3
-- 인코딩 : UTF-8
-- 작성일 : 2026-05-20
--
-- 사용법:
--   sqlite3 debtflow.db < db/schema.sql
-- ============================================================

PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;


-- ============================================================
-- 1. 시스템 설정 (코드 마스터)
-- ============================================================

-- 브랜드: 바로고(B), 딜버(D), 모아라인(M)
CREATE TABLE brands (
  code        TEXT PRIMARY KEY,              -- 'B', 'D', 'M'
  name        TEXT NOT NULL,                 -- 바로고, 딜버, 모아라인
  color       TEXT NOT NULL,                 -- 표시 색상 (#3b82f6)
  sort_order  INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);

-- 12종 코드값 통합 테이블 (담당자/허브명/분류/추심상태/활동유형 등)
-- App.jsx의 DEFAULT_CONFIG와 1:1 매칭됨
CREATE TABLE code_values (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  category    TEXT NOT NULL,                 -- 'assignees','categories','collStatuses',
                                             -- 'debtCauses','hubNames','activityTypes',
                                             -- 'paymentChannels','installmentTimings',
                                             -- 'courts','rehabTypes','chargeTypes','policeStations'
  value       TEXT NOT NULL,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  UNIQUE(category, value)
);
CREATE INDEX idx_code_values_category ON code_values(category);


-- ============================================================
-- 2. 사용자 (Slack 인증)
-- ============================================================
CREATE TABLE users (
  slack_id        TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  email           TEXT,
  avatar          TEXT,
  role            TEXT NOT NULL DEFAULT 'viewer'
                  CHECK (role IN ('admin','editor','viewer')),
  approved        INTEGER NOT NULL DEFAULT 0     -- 0=대기, 1=승인
                  CHECK (approved IN (0,1)),
  registered_at   TEXT NOT NULL DEFAULT (date('now', 'localtime')),
  last_login_at   TEXT
);


-- ============================================================
-- 3. 채무자 마스터 (debtors)
-- ============================================================
CREATE TABLE debtors (
  id                      TEXT PRIMARY KEY,      -- 'NPL0001'
  brand_code              TEXT NOT NULL REFERENCES brands(code),
  category                TEXT NOT NULL,         -- 장기채권 / 회생·파산 / 추심의뢰
  assignee                TEXT,                  -- 담당자명
  name                    TEXT NOT NULL,
  phone                   TEXT,
  hub_code                TEXT,                  -- 4자리 (또는 4자리-N)
  hub_name                TEXT,
  debt_cause              TEXT,                  -- 본사 / 웰컴
  collection_status       TEXT NOT NULL          -- 추심진행 / 추심보류
                          DEFAULT '추심진행',
  credit_check_date       TEXT,                  -- 신용조회 일자
  credit_grade            TEXT,                  -- 1등급~10등급
  exec_title              INTEGER NOT NULL DEFAULT 0   -- 집행권원 여부 0/1
                          CHECK (exec_title IN (0,1)),
  resident_copy_date      TEXT,                  -- 주민등록초본 발급일
  sales_rep               TEXT,                  -- 영업담당자
  loan_date               TEXT,                  -- 대여일자
  subrogation_month       TEXT,                  -- "2024년 3월"
  key_notes               TEXT,                  -- 주요사항 (자유 텍스트)

  principal_balance       INTEGER NOT NULL DEFAULT 0,   -- 원금잔액 (원)
  adjustment              INTEGER NOT NULL DEFAULT 0,   -- 조정액 (법무비용)
  collected_amount        INTEGER NOT NULL DEFAULT 0,   -- 회수액

  created_at              TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
  updated_at              TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);

-- 자주 쓰는 필터/정렬 컬럼에 인덱스
CREATE INDEX idx_debtors_brand     ON debtors(brand_code);
CREATE INDEX idx_debtors_category  ON debtors(category);
CREATE INDEX idx_debtors_status    ON debtors(collection_status);
CREATE INDEX idx_debtors_assignee  ON debtors(assignee);
CREATE INDEX idx_debtors_name      ON debtors(name);
CREATE INDEX idx_debtors_hub       ON debtors(hub_name);

-- 연대보증인 (한 채무자에 여러 명)
CREATE TABLE debtor_guarantors (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  debtor_id  TEXT NOT NULL REFERENCES debtors(id) ON DELETE CASCADE,
  name       TEXT NOT NULL
);
CREATE INDEX idx_guarantors_debtor ON debtor_guarantors(debtor_id);

-- 연락처 이력 (결번/이전 번호 등)
CREATE TABLE debtor_phone_history (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  debtor_id   TEXT NOT NULL REFERENCES debtors(id) ON DELETE CASCADE,
  phone       TEXT NOT NULL,
  note        TEXT,                              -- "결번", "이전번호" 등
  recorded_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);
CREATE INDEX idx_phone_history_debtor ON debtor_phone_history(debtor_id);


-- ============================================================
-- 4. 입금 트랜잭션 (payments)
-- ============================================================
CREATE TABLE payments (
  id              TEXT PRIMARY KEY,              -- 'PAY00001'
  debtor_id       TEXT NOT NULL REFERENCES debtors(id) ON DELETE CASCADE,
  payment_date    TEXT NOT NULL,
  payer_name      TEXT,                          -- 실제 입금자(대리입금 가능)
  total_amount    INTEGER NOT NULL,              -- 합계
  company_account INTEGER NOT NULL DEFAULT 0,    -- 본사계좌
  cash_charge     INTEGER NOT NULL DEFAULT 0,    -- 캐쉬충전
  welcome_direct  INTEGER NOT NULL DEFAULT 0,    -- 웰컴직접상환
  note            TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
  created_by      TEXT REFERENCES users(slack_id),

  CHECK (total_amount = company_account + cash_charge + welcome_direct)
);
CREATE INDEX idx_payments_debtor ON payments(debtor_id);
CREATE INDEX idx_payments_date   ON payments(payment_date);


-- ============================================================
-- 5. 추심활동 (activities)
-- ============================================================
CREATE TABLE activities (
  id            TEXT PRIMARY KEY,                -- 'ACT00001'
  debtor_id     TEXT NOT NULL REFERENCES debtors(id) ON DELETE CASCADE,
  activity_date TEXT NOT NULL,
  activity_type TEXT NOT NULL,                   -- 전화/문자/입금확인/법적조치/방문/카카오톡/내용증명
  content       TEXT,
  assignee      TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
  created_by    TEXT REFERENCES users(slack_id)
);
CREATE INDEX idx_activities_debtor ON activities(debtor_id);
CREATE INDEX idx_activities_date   ON activities(activity_date);
CREATE INDEX idx_activities_type   ON activities(activity_type);


-- ============================================================
-- 6. 채권압류 (seizure_cases + seizure_targets)
-- ============================================================
CREATE TABLE seizure_cases (
  id          TEXT PRIMARY KEY,                  -- 'SEZ0001'
  debtor_id   TEXT NOT NULL REFERENCES debtors(id) ON DELETE CASCADE,
  court       TEXT,                              -- 서울중앙지법 등
  case_number TEXT,                              -- "2025타채12345"
  status      TEXT,                              -- 결정/송달완료/추심중/배당완료/취하
  created_at  TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);
CREATE INDEX idx_seizure_debtor ON seizure_cases(debtor_id);

-- 제3채무자 (한 압류건에 여러 곳)
CREATE TABLE seizure_targets (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  seizure_case_id   TEXT NOT NULL REFERENCES seizure_cases(id) ON DELETE CASCADE,
  seq               INTEGER NOT NULL,            -- 순번
  third_party_name  TEXT,                        -- 국민은행/카카오뱅크 등
  response_date     TEXT,                        -- 진술서 회신일
  claim_amount      INTEGER NOT NULL DEFAULT 0,  -- 청구액
  balance           INTEGER NOT NULL DEFAULT 0,  -- 잔액
  collected         INTEGER NOT NULL DEFAULT 0,  -- 회수액
  note              TEXT,
  completed         INTEGER NOT NULL DEFAULT 0
                    CHECK (completed IN (0,1))
);
CREATE INDEX idx_seizure_targets_case ON seizure_targets(seizure_case_id);


-- ============================================================
-- 7. 회생/파산 (rehabilitations)
-- ============================================================
CREATE TABLE rehabilitations (
  id                TEXT PRIMARY KEY,            -- 'REH0001'
  debtor_id         TEXT NOT NULL REFERENCES debtors(id) ON DELETE CASCADE,
  court             TEXT,
  case_number       TEXT,                        -- "2024개회1234"
  type              TEXT NOT NULL,               -- 회생 / 파산·면책
  creditor_number   INTEGER,                     -- 채권자 번호
  plan_approved     INTEGER NOT NULL DEFAULT 0   -- 인가 여부
                    CHECK (plan_approved IN (0,1)),
  dismissed         INTEGER NOT NULL DEFAULT 0   -- 폐지/기각
                    CHECK (dismissed IN (0,1)),
  debt_amount       INTEGER NOT NULL DEFAULT 0,
  approved_amount   INTEGER NOT NULL DEFAULT 0,
  current_round     TEXT,                        -- "12회차"
  monthly_payment   INTEGER NOT NULL DEFAULT 0,
  repayment_note    TEXT,
  overdue_status    TEXT                         -- '미납' 또는 NULL
);
CREATE INDEX idx_rehab_debtor ON rehabilitations(debtor_id);


-- ============================================================
-- 8. 분할상환 (installment_plans + installment_logs)
-- ============================================================
CREATE TABLE installment_plans (
  id              TEXT PRIMARY KEY,              -- 'INS0001'
  debtor_id       TEXT NOT NULL REFERENCES debtors(id) ON DELETE CASCADE,
  payment_timing  TEXT,                          -- 월초/월중/월말/수시
  monthly_amount  INTEGER NOT NULL,
  total_debt      INTEGER,
  total_claim     INTEGER,
  start_date      TEXT,
  status          TEXT NOT NULL DEFAULT '진행중'
                  CHECK (status IN ('진행중','완료','중단'))
);
CREATE INDEX idx_installment_debtor ON installment_plans(debtor_id);

-- 월별 이행 로그
CREATE TABLE installment_logs (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  plan_id       TEXT NOT NULL REFERENCES installment_plans(id) ON DELETE CASCADE,
  target_month  TEXT NOT NULL,                   -- "2025년 3월"
  paid_amount   INTEGER NOT NULL DEFAULT 0,
  memo          TEXT,
  status        TEXT NOT NULL DEFAULT '미납'
                CHECK (status IN ('완납','미납','지연'))
);
CREATE INDEX idx_installment_logs_plan ON installment_logs(plan_id);


-- ============================================================
-- 9. 형사고소 (complaints)
-- ============================================================
CREATE TABLE complaints (
  id              TEXT PRIMARY KEY,              -- 'CRM0001'
  debtor_id       TEXT NOT NULL REFERENCES debtors(id) ON DELETE CASCADE,
  complainant     TEXT,                          -- 고소인 (㈜바로고 등)
  goods_amount    INTEGER NOT NULL DEFAULT 0,    -- 물품대
  loan_amount     INTEGER NOT NULL DEFAULT 0,    -- 대여금
  charge          TEXT,                          -- 사기 / 횡령
  complaint_date  TEXT,
  police_station  TEXT,
  status_note     TEXT                           -- 수사중/기소/불기소/재정신청/1심진행중 등
);
CREATE INDEX idx_complaints_debtor ON complaints(debtor_id);


-- ============================================================
-- 10. 알림 규칙 (alert_rules)
-- ============================================================
CREATE TABLE alert_rules (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,                 -- "분할상환 미납"
  enabled         INTEGER NOT NULL DEFAULT 1
                  CHECK (enabled IN (0,1)),
  trigger_type    TEXT NOT NULL,                 -- installment_overdue 등 (8종)
  condition_text  TEXT,                          -- "미납 1회 이상"
  target          TEXT NOT NULL                  -- channel / dm
                  CHECK (target IN ('channel','dm')),
  channel         TEXT,                          -- "#npl-알림"
  assignee        TEXT,                          -- DM 대상자명
  created_at      TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);


-- ============================================================
-- 11. 변경 로그 (audit_logs + audit_log_changes)
-- ============================================================
CREATE TABLE audit_logs (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp     TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
  user_name     TEXT NOT NULL,
  user_slack_id TEXT REFERENCES users(slack_id),
  action        TEXT NOT NULL                    -- 등록/수정/삭제
                CHECK (action IN ('등록','수정','삭제')),
  target        TEXT NOT NULL,                   -- 채권/입금/추심활동 등
  target_id     TEXT,                            -- 대상의 PK (예: NPL0001)
  detail        TEXT                             -- "홍길동 (NPL0001) — 바로고, 5,000,000원"
);
CREATE INDEX idx_audit_timestamp ON audit_logs(timestamp DESC);
CREATE INDEX idx_audit_target    ON audit_logs(target, target_id);

-- 수정 시 필드별 변경 내역
CREATE TABLE audit_log_changes (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  audit_log_id  INTEGER NOT NULL REFERENCES audit_logs(id) ON DELETE CASCADE,
  field         TEXT NOT NULL,                   -- "원금잔액"
  value_from    TEXT,
  value_to      TEXT
);


-- ============================================================
-- 12. 매칭 대기열 (pending_payments)
-- ============================================================
-- 엑셀/Slack에서 들어온 입금건 중 채무자 매칭 실패한 것을 보관.
-- 어드민 화면에서 담당자가 수동으로 채무자를 지정해주면 payments로 이동.
CREATE TABLE pending_payments (
  id                     INTEGER PRIMARY KEY AUTOINCREMENT,
  payment_date           TEXT NOT NULL,
  excel_brand            TEXT,              -- 엑셀의 '구분' (B/D/M)
  excel_assignee         TEXT,              -- 엑셀의 '담당'
  excel_hub_name         TEXT,              -- 엑셀의 '허브/지점명'
  excel_hub_code         TEXT,              -- 엑셀의 '코드'
  excel_debtor_name      TEXT,              -- 엑셀의 '채무자명'
  payer_name             TEXT,
  total_amount           INTEGER NOT NULL,
  company_account        INTEGER NOT NULL DEFAULT 0,
  cash_charge            INTEGER NOT NULL DEFAULT 0,
  welcome_direct         INTEGER NOT NULL DEFAULT 0,
  note                   TEXT,
  source                 TEXT NOT NULL      -- 'excel' / 'slack'
                         CHECK (source IN ('excel','slack')),
  source_ref             TEXT,              -- 엑셀 행 번호 또는 Slack 메시지 ts
  reason                 TEXT,              -- '채무자 미발견', '동명이인 다수' 등
  resolved               INTEGER NOT NULL DEFAULT 0 CHECK (resolved IN (0,1)),
  resolved_to_payment_id TEXT REFERENCES payments(id),
  created_at             TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);
CREATE INDEX idx_pending_resolved ON pending_payments(resolved);


-- ============================================================
-- 13. VIEW — 채무자 잔액 자동 계산
-- ============================================================
-- final_balance_finance / final_balance_legal는 저장하지 않고 자동 계산.
-- 잔액이 틀어질 위험을 없애기 위함.
CREATE VIEW v_debtors AS
SELECT
  d.*,
  b.name  AS brand_name,
  b.color AS brand_color,
  CASE WHEN d.principal_balance = 0 THEN 0
       ELSE (d.principal_balance - d.collected_amount) END          AS final_balance_finance,
  (d.principal_balance - d.collected_amount + d.adjustment)         AS final_balance_legal
FROM debtors d
LEFT JOIN brands b ON d.brand_code = b.code;


-- ============================================================
-- SEED DATA — 어드민 기본값 (App.jsx DEFAULT_CONFIG와 동일)
-- ============================================================

-- 브랜드 3개
INSERT INTO brands (code, name, color, sort_order) VALUES
  ('B', '바로고',    '#3b82f6', 1),
  ('D', '딜버',      '#8b5cf6', 2),
  ('M', '모아라인',  '#f59e0b', 3);

-- 코드값 12종
INSERT INTO code_values (category, value, sort_order) VALUES
  ('categories', '장기채권',  1),
  ('categories', '회생/파산', 2),
  ('categories', '추심의뢰',  3),

  ('collStatuses', '추심진행', 1),
  ('collStatuses', '추심보류', 2),

  ('assignees', '준원', 1),
  ('assignees', '덕진', 2),

  ('debtCauses', '본사', 1),
  ('debtCauses', '웰컴', 2),

  ('activityTypes', '전화',     1),
  ('activityTypes', '문자',     2),
  ('activityTypes', '입금확인', 3),
  ('activityTypes', '법적조치', 4),
  ('activityTypes', '방문',     5),
  ('activityTypes', '카카오톡', 6),
  ('activityTypes', '내용증명', 7),

  ('paymentChannels', '본사계좌',     1),
  ('paymentChannels', '캐쉬충전',     2),
  ('paymentChannels', '웰컴직접상환', 3),

  ('installmentTimings', '월초', 1),
  ('installmentTimings', '월중', 2),
  ('installmentTimings', '월말', 3),
  ('installmentTimings', '수시', 4),

  ('courts', '서울중앙지법', 1),
  ('courts', '서울동부지법', 2),
  ('courts', '인천지법',     3),
  ('courts', '수원지법',     4),
  ('courts', '부산지법',     5),
  ('courts', '대구지법',     6),
  ('courts', '대전지법',     7),

  ('rehabTypes', '회생',       1),
  ('rehabTypes', '파산/면책',  2),

  ('chargeTypes', '사기',  1),
  ('chargeTypes', '횡령',  2),

  ('policeStations', '광진경찰서', 1),
  ('policeStations', '강서경찰서', 2),
  ('policeStations', '송파경찰서', 3),
  ('policeStations', '서초경찰서', 4),
  ('policeStations', '강남경찰서', 5),

  ('hubNames', '광진본점허브',           1),
  ('hubNames', '충남천안원콜성두7지점',  2),
  ('hubNames', '강서마곡허브',           3),
  ('hubNames', '동대문허브',             4),
  ('hubNames', '용산허브',               5),
  ('hubNames', '송파석촌허브',           6),
  ('hubNames', '인천서구허브',           7),
  ('hubNames', '부산해운대허브',         8),
  ('hubNames', '대구수성허브',           9),
  ('hubNames', '수원영통허브',          10),
  ('hubNames', '성남분당허브',          11),
  ('hubNames', '안양만안허브',          12);

-- 기본 사용자 (관리자 1명 + 편집자 1명)
INSERT INTO users (slack_id, name, email, avatar, role, approved) VALUES
  ('U001', '이준원', 'junwon@barogo.com',  '준', 'admin',  1),
  ('U002', '김덕진', 'deokjin@barogo.com', '덕', 'editor', 1);

-- 기본 알림 규칙 5건 (App.jsx DEFAULT_ALERT_RULES와 동일)
INSERT INTO alert_rules (id, name, enabled, trigger_type, condition_text, target, channel, assignee) VALUES
  ('rule1', '분할상환 미납',     1, 'installment_overdue', '미납 1회 이상',         'channel', '#npl-알림', NULL),
  ('rule2', '회생 변제금 미납',  1, 'rehab_overdue',       '미납 상태',             'channel', '#npl-알림', NULL),
  ('rule3', '고액 잔액',         1, 'high_balance',        '잔액 1,000만원 초과',   'dm',      NULL,        '준원'),
  ('rule4', '신규 입금',         0, 'new_payment',         '입금 등록 시',          'channel', '#npl-입금', NULL),
  ('rule5', '장기 미연락',       0, 'no_contact',          '30일 이상 활동 없음',   'dm',      NULL,        NULL);
