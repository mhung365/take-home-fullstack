# Claims Workflow Orchestrator — Design

Tài liệu thiết kế trước khi code. Mọi quyết định dưới đây đã được chốt dựa trên `BRIEF.md`.

## 1. Mục tiêu và phạm vi

Xây dựng workflow engine dạng state machine điều phối vòng đời claim, gồm:

- State machine định nghĩa hoàn toàn trong file JSON.
- Kiểm tra transition, role, precondition, giới hạn cycle; lỗi trả về cụ thể.
- Side effect (mock, log ra console) chạy sau transition thành công.
- Audit trail bất biến, truy vấn theo claim ID.
- Web UI + API để xem trạng thái, transition khả dụng, thực hiện transition, xem audit.
- Lưu trữ trên PostgreSQL; request đồng thời trên cùng một claim được xử lý tuần tự, không mất cập nhật, không vượt cycle limit, không ghi trùng side effect.
- PostgreSQL chạy bằng Docker Compose; API và Web chạy local bằng `pnpm dev`.

**Ngoài phạm vi:** đăng nhập/đăng ký, nhiều role trên một user, separation of duties, reset bộ đếm cycle, chạy nhiều instance API (clock giả của chế độ demo nằm trong process), outbox cho tích hợp ngoài thật.

## 2. Kiến trúc

```
ai-challenge-14/
├── docker-compose.yml                  # chỉ postgres
├── docker/postgres/init/               # script tạo database test/scenarios
├── .env.example                        # DATABASE_URL, DEMO_MODE, ...
├── config/
│   ├── claims-workflow.json            # state machine chính
│   ├── users.json                      # user mock (userId → role)
│   └── examples/                       # demo thay đổi chỉ bằng config
├── packages/engine/src/                # TypeScript thuần, không phụ thuộc NestJS, không I/O
│   ├── config/      # load + validate config
│   ├── rules/       # bộ đánh giá precondition
│   ├── effects/     # registry side effect
│   ├── store/       # interface WorkflowStore + bản in-memory (dùng cho unit test)
│   ├── clock.ts     # Clock inject được
│   └── engine.ts    # WorkflowEngine
├── packages/store-postgres/            # WorkflowStore trên PostgreSQL (driver `pg`)
│   ├── migrations/  # file SQL đánh số, chạy bằng `pnpm db:migrate`
│   └── src/
├── apps/api/        # NestJS: controller, guard định danh, map lỗi → HTTP
├── apps/web/        # React UI (Vite, proxy /api → api)
└── docs/            # kết quả scenario, audit output, config diff
```

Nguyên tắc:

- **Engine độc lập framework.** Toàn bộ logic nghiệp vụ và phân quyền nằm trong `packages/engine`. Test engine không cần khởi động NestJS hay database.
- **NestJS chỉ là lớp bọc.** Guard đọc `X-User-Id` và tra user mock; **không** dùng `@Roles()` decorator cho transition, vì quyền phải đến từ config.
- **Lưu trữ sau interface `WorkflowStore`** (mục 5.3). Engine chỉ biết interface; API dùng bản PostgreSQL, unit test dùng bản in-memory. Cả hai bản chạy chung một bộ contract test.
- **Đồng thời được xử lý ở tầng store** bằng transaction và khóa dòng theo claim (mục 6.4). Engine luôn thực hiện một thao tác trong phạm vi một "claim transaction", nên logic nghiệp vụ không phải tự lo khóa.
- **Clock inject được** để test thời hạn kháng cáo mà không chờ thật. Mọi timestamp ghi vào DB lấy từ Clock, không dùng `now()` của PostgreSQL.
- **SQL thuần qua `pg`**, không dùng ORM, để kiểm soát rõ `SELECT ... FOR UPDATE`, `SKIP LOCKED` và `lock_timeout`.

### 2.1 Môi trường chạy

Docker chỉ dùng cho PostgreSQL. API và Web chạy trực tiếp trên máy bằng Node/pnpm.

`docker-compose.yml` có một service:

| Service | Image | Ghi chú |
|---|---|---|
| `postgres` | `postgres:16-alpine` | volume `pgdata`, healthcheck `pg_isready`, cổng `5432` map ra host; mount `docker/postgres/init` vào `docker-entrypoint-initdb.d` |

Script init tạo 3 database trên cùng container: `claims` (dữ liệu demo), `claims_test` (integration test), `claims_scenarios` (`pnpm scenarios`), để test không đụng dữ liệu demo.

Chạy local:

```bash
docker compose up -d postgres   # khởi động DB
cp .env.example .env            # DATABASE_URL=postgres://claims:claims@localhost:5432/claims
pnpm install
pnpm db:migrate                 # áp dụng migration lên database claims
pnpm dev                        # engine (watch) + api :3000 + web :5173
```

- API đọc `DATABASE_URL` từ `.env`; không tự chạy migration khi khởi động, để lỗi migration hiện rõ ở bước riêng.
- Web dùng proxy của Vite dev server (`/api` → `http://localhost:3000`), không cần CORS khi chạy qua UI.
- `docker compose down -v` xóa toàn bộ dữ liệu khi cần làm lại từ đầu.

## 3. Roles và user mock

Chỉ dùng các role có trong đề: `document_clerk`, `team_lead`, `assessor`, `finance`, `system`. Không có role `member`; member chỉ là dữ liệu (`memberId`) trên claim.

User mock khai báo trong `config/users.json`, được engine load cùng `claims-workflow.json`. Rule `userHasRole` và guard định danh đều tra danh sách này. Thêm user hoặc đổi role chỉ cần sửa file này.

```json
{
  "users": [
    { "id": "u-clerk-1", "name": "Alice (Clerk)", "role": "document_clerk" }
  ]
}
```

| userId | role |
|---|---|
| `u-clerk-1` | document_clerk |
| `u-lead-1` | team_lead |
| `u-assessor-1` | assessor |
| `u-assessor-2` | assessor |
| `u-finance-1` | finance |
| `u-system` | system |

Định danh qua header `X-User-Id`; role suy ra từ danh sách user mock (client không tự khai role). Đây là giới hạn chấp nhận cho bản demo và được ghi rõ trong README.

## 4. Schema config

### 4.1 Cấu trúc tổng

```json
{
  "version": 1,
  "initialState": "SUBMITTED",
  "roles": ["document_clerk", "team_lead", "assessor", "finance", "system"],
  "settings": {
    "requiredDocuments": ["claim_form", "invoice", "id_proof"],
    "appealPeriodDays": 30
  },
  "states": [
    { "id": "SUBMITTED", "description": "Claim received, awaiting document verification" },
    { "id": "CLOSED", "description": "Claim lifecycle complete", "terminal": true }
  ],
  "actions": {
    "createClaim":    { "roles": ["document_clerk"], "inputs": ["documents"] },
    "acknowledge":    { "roles": ["document_clerk"], "allowedStates": ["REJECTED"] },
    "runSystemTasks": { "roles": ["system"] }
  },
  "transitions": [ ]
}
```

### 4.2 Transition

```json
{
  "id": "request_info",
  "from": "UNDER_ASSESSMENT",
  "to": "PENDING_INFO",
  "description": "Assessor requested additional information from member",
  "roles": ["assessor"],
  "inputs": ["missingInfoDescription"],
  "reasonField": "missingInfoDescription",
  "preconditions": {
    "all": [
      { "rule": "providedInRequest", "field": "missingInfoDescription" }
    ]
  },
  "sideEffects": [
    {
      "name": "notify",
      "params": {
        "to": "member",
        "template": "Claim {{id}}: please provide additional information: {{missingInfoDescription}}"
      }
    }
  ],
  "cycleLimit": {
    "max": 3,
    "message": "Maximum information requests exceeded — escalate to team lead"
  }
}
```

- `description`: bắt buộc; mô tả transition, dùng trên UI và làm `reason` mặc định trong audit.
- `reasonField`: tùy chọn; field trong payload được dùng làm `reason` trong audit (ví dụ `rejectionReason`).
- `inputs`: whitelist các field payload được phép gửi kèm. Field ngoài danh sách bị từ chối. Giá trị được ghi vào `claim.data` (xem 5.1), không bao giờ ghi vào field lõi.
- `preconditions`: cây rule, hỗ trợ `all`, `any`, `not`.
- `sideEffects`: danh sách `{ name, params? }`; `name` là handler đã đăng ký, `params` được validate theo schema riêng của handler đó.
- `cycleLimit`: tùy chọn, đặt trên transition cần giới hạn.

### 4.3 Bộ rule precondition

| rule | Ý nghĩa | Ví dụ lỗi |
|---|---|---|
| `notEmpty` | field có giá trị khác rỗng | `assessmentReport is required` |
| `providedInRequest` | field có trong payload của **chính request này** | `rejectionReason must be provided in this request` |
| `containsAll` | mảng chứa đủ các giá trị (`values` hoặc `ref`) | `Missing required documents: invoice, id_proof` |
| `lte` | field ≤ giá trị field khác (`ref`) | `amount 12000 exceeds policyLimit 10000` |
| `eq` | field bằng giá trị cố định | `memberAcknowledged must be true` |
| `daysElapsed` | đã qua ít nhất N ngày kể từ mốc thời gian | `Only 12 of 30 days elapsed since stateEnteredAt` |
| `userHasRole` | field là userId của user có role chỉ định | `assessorId u-finance-1 has role finance, expected assessor` |

- Tham chiếu settings bằng `"$settings.<key>"`, ví dụ `"ref": "$settings.requiredDocuments"`.
- Rule đọc field theo tên phẳng trên một "view" gộp field lõi và `data` của claim, ví dụ `amount` (lõi), `documents` (data). Tên field trong `data` không được trùng field lõi (validate khi load), nên không có nhập nhằng.
- Field hỗ trợ dot path, ví dụ `paymentRequest.id`.
- Mỗi rule có thể có `message` tùy biến; mặc định engine sinh message kèm giá trị thực tế.
- Với `all`, engine trả về **tất cả** rule lỗi; với `any`, trả về lỗi của từng nhánh.

`providedInRequest` giải quyết vấn đề dữ liệu cũ: ở vòng PENDING_INFO thứ 2, `infoResponse` của vòng 1 vẫn còn trên claim, nên phải bắt buộc gửi mới trong request.

### 4.4 Bảng transition

| id | from → to | roles | inputs | preconditions | side effects |
|---|---|---|---|---|---|
| `verify_documents` | SUBMITTED → DOCUMENTS_VERIFIED | document_clerk | `documents` | `containsAll(documents, $settings.requiredDocuments)` | `notify(role:assessor)` |
| `start_assessment` | DOCUMENTS_VERIFIED → UNDER_ASSESSMENT | team_lead | `assessorId` | `userHasRole(assessorId, assessor)` | `setField(assessmentStartedAt, $now)`, `notify(user:assessorId)` |
| `approve` | UNDER_ASSESSMENT → APPROVED | assessor | `assessmentReport` | `all[notEmpty(assessmentReport), lte(amount, policyLimit)]` | `notify(member)`, `createPaymentRequest` |
| `reject` | UNDER_ASSESSMENT → REJECTED | assessor | `assessmentReport`, `rejectionReason` | `all[notEmpty(assessmentReport), providedInRequest(rejectionReason)]` | `notify(member)` kèm lý do và hướng dẫn kháng cáo |
| `request_info` | UNDER_ASSESSMENT → PENDING_INFO | assessor | `missingInfoDescription` | `providedInRequest(missingInfoDescription)`; `cycleLimit.max = 3` | `notify(member)` kèm nội dung yêu cầu |
| `info_received` | PENDING_INFO → DOCUMENTS_VERIFIED | document_clerk | `infoResponse`, `documents` | `all[any[providedInRequest(infoResponse), providedInRequest(documents)], containsAll(documents, $settings.requiredDocuments)]` | `setField(assessmentStartedAt, null)` |
| `initiate_payment` | APPROVED → PAYMENT_INITIATED | finance | — | `notEmpty(paymentRequest.id)` | `triggerPaymentSystem` |
| `confirm_payment` | PAYMENT_INITIATED → CLOSED | finance | `paymentReference` | `providedInRequest(paymentReference)` | `notify(member)` kèm `paymentReference` |
| `close_rejected` | REJECTED → CLOSED | system | — | `any[daysElapsed(stateEnteredAt, $settings.appealPeriodDays), eq(memberAcknowledged, true)]` | `setField(archivedAt, $now)`, `notify(member)` |

Cột side effects viết tắt; trong config mỗi `notify` có `params.to` và `params.template` đầy đủ.

Ở `info_received`, `documents` trong payload **thay thế toàn bộ** danh sách hiện tại (không cộng dồn), để clerk có thể đổi giấy tờ theo yêu cầu bổ sung. Precondition được đánh giá trên danh sách sau khi thay thế, nên việc thay thế không được làm mất giấy tờ bắt buộc. Nếu request không gửi `documents`, danh sách cũ được giữ nguyên và vẫn phải đủ giấy tờ bắt buộc.

"New documents/info received" được hiểu là request phải mang **ít nhất một** trong hai: `infoResponse` mới hoặc `documents` mới. Request không gửi gì mới bị từ chối, kể cả khi dữ liệu cũ trên claim đã đủ.

`reasonField` được khai báo cho `reject` (`rejectionReason`), `request_info` (`missingInfoDescription`) và `confirm_payment` (`paymentReference`). Các transition khác dùng `notes` hoặc `description`.

`start_assessment` không bắt buộc gửi `assessorId` mới: ở vòng lặp, assessor đã được gán vẫn hợp lệ. Có thể gửi để gán lại.

### 4.5 Side effect registry

Registry gồm 2 handler tổng quát (dùng cho hầu hết trường hợp, chỉ cần config) và 2 handler tích hợp (mock hệ thống bên ngoài):

| Tên | params | Hành vi (mock) | Thay đổi `claim.data` |
|---|---|---|---|
| `notify` | `to`, `template` | console log `[NOTIFY → <người nhận>] <nội dung>`; `result` trong audit ghi người nhận và nội dung đã render | — |
| `setField` | `field`, `value` | console log | `data[field] = value` |
| `createPaymentRequest` | — | console log | `paymentRequest = { id, amount, createdAt }` |
| `triggerPaymentSystem` | — | console log | `paymentInitiatedAt = now` |

`notify.params.to` nhận một trong ba dạng:

- `member`: gửi tới `memberId` của claim.
- `role:<role>`: gửi tới mọi user mang role đó trong `users.json`, ví dụ `role:team_lead`.
- `user:<field>`: gửi tới userId lưu trong field của claim, ví dụ `user:assessorId`.

`notify.params.template` dùng cú pháp `{{field}}`, đọc từ cùng "view" với rule (field lõi + `data`), ví dụ `Claim {{id}} rejected: {{rejectionReason}}`. Biến không tồn tại bị báo lỗi khi load config nếu tên không có trong field lõi, `inputs` của bất kỳ transition nào hoặc của `createClaim`, field do side effect ghi ra, hoặc field do `acknowledge` ghi ra (`memberAcknowledged`, `memberAcknowledgedAt`, `memberAcknowledgedBy`).

Biến hợp lệ nhưng lúc chạy không có giá trị (thiếu, `null` hoặc chuỗi rỗng) được render thành rỗng; thông báo vẫn được gửi và entry vẫn `status: ok`, nhưng `result.missingVariables` liệt kê các biến đó. Làm vậy để member vẫn nhận được thông báo, đồng thời audit cho thấy thông báo nào bị thiếu nội dung.

`setField.params.value` nhận giá trị JSON cố định, `null`, hoặc `"$now"` (thời điểm hiện tại từ Clock). `setField` chỉ ghi vào `data`, không ghi được field lõi.

Nhờ `notify` và `setField`, demo `with-escalation.json` có thể thông báo cho team lead (`notify(role:team_lead)`) mà không cần thêm code.

### 4.6 Validate config khi load

Engine từ chối khởi động nếu config có lỗi, và liệt kê toàn bộ lỗi:

- JSON sai schema (validate bằng Zod).
- `initialState`, `from`, `to`, `allowedStates` trỏ tới state không tồn tại.
- Role không nằm trong `roles`.
- Tên rule hoặc side effect chưa đăng ký; `params` của side effect sai schema của handler.
- Tên field trong `inputs` hoặc `setField.params.field` trùng field lõi (`id`, `status`, `memberId`, `amount`, `policyLimit`, `stateEnteredAt`, `createdAt`, `createdBy`, `version`).
- Biến trong `notify.params.template` không tồn tại.
- `reasonField` không nằm trong `inputs`.
- Trùng `id` transition hoặc trùng cặp `from → to`.
- State `terminal` có transition đi ra.
- State không thể tới được từ `initialState` (cảnh báo).
- Rule dùng `providedInRequest` cho field không có trong `inputs`.
- `users.json`: trùng `id`, hoặc user mang role không nằm trong `roles` của workflow config.

## 5. Mô hình dữ liệu

### 5.1 Claim

Claim tách hai phần: **field lõi** do engine quản lý và **`data`** chứa mọi field đến từ config.

```ts
interface Claim {
  // Field lõi: chỉ engine ghi, payload và side effect không ghi được
  id: string;
  memberId: string;
  status: StateId;
  stateEnteredAt: string;          // ISO, cập nhật mỗi lần đổi state
  amount: number;
  policyLimit: number;
  createdAt: string;
  createdBy: string;
  version: number;                  // tăng 1 mỗi lần claim được ghi (transition, acknowledge)

  // Field từ config: inputs của transition/action và kết quả side effect
  data: Record<string, unknown>;
}
```

Với config chính, `data` sẽ chứa: `documents`, `assessorId`, `assessmentReport`, `rejectionReason`, `missingInfoDescription`, `infoResponse`, `memberAcknowledged`, `assessmentStartedAt`, `paymentRequest`, `paymentInitiatedAt`, `paymentReference`, `archivedAt`. Thêm field mới (ví dụ `escalationReason`) chỉ cần khai báo trong `inputs`, không sửa kiểu `Claim`.

Kiểu dữ liệu của field trong `data` không được validate theo schema; rule tự kiểm tra kiểu khi đánh giá (ví dụ `containsAll` báo lỗi nếu field không phải mảng).

Claim được trả ra ngoài dưới dạng bản copy; chỉ engine được ghi vào store.

### 5.2 Audit entry

```ts
type AuditType =
  | 'CLAIM_CREATED'
  | 'TRANSITION'
  | 'TRANSITION_REJECTED'
  | 'MEMBER_ACKNOWLEDGED'
  | 'ACTION_REJECTED'
  | 'SIDE_EFFECT';             // data = { name, status: 'ok' | 'failed', result?, error? }

interface AuditEntry {
  id: string;
  seq: number;                 // tăng dần theo claim
  claimId: string;
  type: AuditType;
  timestamp: string;           // ISO, lấy từ Clock
  fromState: StateId | null;
  toState: StateId | null;     // với TRANSITION_REJECTED: state được yêu cầu
  transitionId?: string;
  triggeredBy: { userId: string; role: Role };
  reason: string;              // luôn có giá trị, xem quy tắc bên dưới
  notes?: string;              // ghi chú người dùng nhập, nếu có
  data?: Record<string, unknown>;   // payload, hoặc { code, errors } khi bị từ chối
}
```

Quy tắc lấy `reason`, theo thứ tự ưu tiên:

1. Giá trị của `reasonField` trong payload, nếu transition có khai báo.
2. `notes` người dùng nhập.
3. `description` của transition (hoặc mô tả mặc định của action như `Claim created`, `Member acknowledgement recorded`).

Với entry bị từ chối, `reason` là message lỗi.

Bất biến:

- Store chỉ có `appendAudit()`, `listAuditByClaim()`, `listAllAudit()`; không có update/delete.
- Entry trả ra ngoài được deep-freeze; `list*` trả về mảng mới.
- Ở PostgreSQL, bảng `audit_entries` có trigger `BEFORE UPDATE OR DELETE` raise exception, và `TRUNCATE` bị chặn bằng trigger tương ứng. Kể cả câu SQL viết tay cũng không sửa/xóa được entry.
- `seq` được cấp trong cùng transaction đang giữ khóa claim (mục 6.4), có ràng buộc `UNIQUE (claim_id, seq)` làm lớp bảo vệ cuối; `seq` liên tục, không trùng kể cả khi có request đồng thời.
- Có test chứng minh: gán field, xóa field, sửa mảng trả về không ảnh hưởng dữ liệu đã lưu; `UPDATE`/`DELETE` trực tiếp bằng SQL bị từ chối.

Chỉ ghi audit khi claim tồn tại và user hợp lệ; request với claim hoặc user không tồn tại chỉ trả lỗi.

### 5.3 Lưu trữ

**Interface trong engine** (`packages/engine/src/store`):

```ts
interface WorkflowStore {
  // Chạy fn trong một transaction đang giữ khóa độc quyền trên claim.
  // Trả về CLAIM_NOT_FOUND nếu claim không tồn tại; CLAIM_BUSY nếu chờ khóa quá lock_timeout.
  withClaim<T>(claimId: string, fn: (tx: ClaimTx) => Promise<T>): Promise<T>;

  // Như withClaim nhưng bỏ qua (trả về null) nếu claim đang bị khóa. Dùng cho runSystemTasks.
  tryWithClaim<T>(claimId: string, fn: (tx: ClaimTx) => Promise<T>): Promise<T | null>;

  createClaim(claim: NewClaim, audit: NewAuditEntry): Promise<Claim>;  // một transaction
  getClaim(id: string): Promise<Claim | null>;                          // đọc không khóa
  listClaims(filter?: { status?: StateId[] }): Promise<Claim[]>;
  listAuditByClaim(claimId: string): Promise<AuditEntry[]>;
  listAllAudit(): Promise<AuditEntry[]>;
}

interface ClaimTx {
  claim: Claim;                                          // bản đọc dưới khóa
  countSuccessfulTransitions(transitionId: string): Promise<number>;
  saveClaim(next: Claim): Promise<void>;                 // version = claim.version + 1
  appendAudit(entry: NewAuditEntry): Promise<AuditEntry>; // cấp seq
}
```

Bản in-memory cài khóa bằng mutex theo `claimId` (chuỗi promise), nên có cùng ngữ nghĩa tuần tự với bản PostgreSQL. Transaction in-memory thao tác trên bản copy và chỉ ghi đè khi `fn` hoàn tất, để lỗi giữa chừng không để lại dữ liệu dở dang.

**Schema PostgreSQL** (`packages/store-postgres/migrations/001_init.sql`):

```sql
CREATE SEQUENCE claim_number_seq;

CREATE TABLE claims (
  id               text PRIMARY KEY,               -- 'c-' || nextval('claim_number_seq')
  member_id        text NOT NULL,
  status           text NOT NULL,
  state_entered_at timestamptz NOT NULL,
  amount           numeric(14,2) NOT NULL CHECK (amount > 0),
  policy_limit     numeric(14,2) NOT NULL CHECK (policy_limit > 0),
  created_at       timestamptz NOT NULL,
  created_by       text NOT NULL,
  version          integer NOT NULL DEFAULT 1,
  data             jsonb NOT NULL DEFAULT '{}'
);
CREATE INDEX claims_status_idx ON claims (status);

CREATE TABLE audit_entries (
  id                   uuid PRIMARY KEY,
  claim_id             text NOT NULL REFERENCES claims(id),
  seq                  integer NOT NULL,
  type                 text NOT NULL,
  timestamp            timestamptz NOT NULL,
  from_state           text,
  to_state             text,
  transition_id        text,
  triggered_by_user_id text NOT NULL,
  triggered_by_role    text NOT NULL,
  reason               text NOT NULL,
  notes                text,
  data                 jsonb,
  UNIQUE (claim_id, seq)
);
CREATE INDEX audit_transition_idx ON audit_entries (claim_id, transition_id) WHERE type = 'TRANSITION';

-- trigger chặn UPDATE / DELETE / TRUNCATE trên audit_entries
```

- `status` không có CHECK theo danh sách state, vì state đến từ config và có thể thay đổi (ví dụ `with-escalation.json`).
- `numeric` được đọc về `number` trong repository; số tiền demo nằm trong phạm vi an toàn của `number`.
- Config workflow và `users.json` vẫn là file, không lưu DB: mục tiêu "chỉ sửa config" giữ nguyên.
- Migration là file SQL đánh số, áp dụng theo thứ tự và ghi vào bảng `schema_migrations`; chạy bằng `pnpm db:migrate` (nhận `DATABASE_URL` từ env). Script integration test và `pnpm scenarios` tự áp dụng migration lên database riêng của chúng.

## 6. Luồng xử lý

### 6.1 Transition — `transition(claimId, userId, { to, payload, notes, expectedVersion })`

1. Tìm user trong `users.json` → `UNKNOWN_USER`. Bước này không chạm DB.
2. Mở `store.withClaim(claimId, ...)`: bắt đầu transaction và khóa dòng claim → `CLAIM_NOT_FOUND` hoặc `CLAIM_BUSY`. Các bước 3–10 chạy bên trong transaction này, trên dữ liệu claim đọc **sau khi** đã có khóa.
   - Nếu request có `expectedVersion` khác `claim.version` → `STALE_CLAIM`, message `Claim c-42 was modified (version 5, expected 4); reload and retry`.
3. Tìm transition `from = claim.status, to` → `INVALID_TRANSITION`. Message phân biệt ba trường hợp, đều kèm danh sách transition hợp lệ từ state hiện tại (và role cần có):
   - `to` không phải state nào trong config: `Unknown state FOO. Known states: SUBMITTED, DOCUMENTS_VERIFIED, ...`
   - State hiện tại là terminal: `Claim is in terminal state CLOSED; no transitions allowed`
   - Có state nhưng không có transition: `Cannot transition SUBMITTED → APPROVED. Allowed from SUBMITTED: DOCUMENTS_VERIFIED (document_clerk)`
4. Kiểm tra role → `UNAUTHORIZED_ROLE`, message nêu role cần có và role hiện tại.
5. Kiểm tra payload theo `inputs` → `INVALID_PAYLOAD`.
6. Merge payload vào `data` của **bản nháp** claim, đánh giá precondition trên bản nháp → `PRECONDITION_FAILED` kèm danh sách rule lỗi.
7. Kiểm tra `cycleLimit`: `tx.countSuccessfulTransitions(transitionId)` đếm entry `TRANSITION` **thành công** của claim; nếu đã đạt `max` → `CYCLE_LIMIT_EXCEEDED` với message trong config. Vì đếm dưới khóa, hai request đồng thời không thể cùng lọt qua ở lần thứ `max`.
8. Áp dụng transition vào bản nháp: `status = to`, `stateEnteredAt = now`; tạo audit `TRANSITION` (kèm payload).
9. Chạy lần lượt side effect theo thứ tự trong config, trên bản nháp. Handler **không truy cập DB**: nó nhận bản nháp (chỉ đọc) và trả về `{ result, dataPatch? }`; engine áp `dataPatch` vào `data` của bản nháp. Mỗi side effect tạo một entry `SIDE_EFFECT` mang cùng `transitionId`, `fromState`, `toState`, `triggeredBy` với entry `TRANSITION` gốc; `data` gồm `name`, `status` (`ok` hoặc `failed`), `result` (ví dụ `{ paymentRequestId }`) hoặc `error`. Handler ném lỗi thì patch của nó bị bỏ, entry ghi `failed`, các side effect còn lại vẫn chạy, và transition **không bị rollback**.
10. `tx.saveClaim(bản nháp)` (tăng `version`), `tx.appendAudit()` cho entry `TRANSITION` và các entry `SIDE_EFFECT` theo đúng thứ tự, rồi commit.

Handler side effect có thể là hàm async; engine `await` lần lượt từng handler theo thứ tự trong config, rồi mới commit và trả kết quả cho người gọi. Vì vậy state mới, `data` do side effect ghi ra và toàn bộ audit của một transition được commit **nguyên tử**: không request nào khác nhìn thấy claim đã đổi state mà side effect chưa chạy xong.

Bước 2 (`STALE_CLAIM`) đến 7 thất bại: claim không đổi, ghi audit `TRANSITION_REJECTED` với `data = { code, errors, payload }` trong cùng transaction rồi commit. `CLAIM_NOT_FOUND` và `CLAIM_BUSY` chỉ trả lỗi, không ghi audit (không có khóa để cấp `seq`).

Lỗi hạ tầng (mất kết nối DB, lỗi khi commit) làm rollback toàn bộ transaction, nên không có trạng thái dở dang; API trả 500.

Hệ quả của việc không rollback khi side effect lỗi: nếu `createPaymentRequest` lỗi, claim nằm ở APPROVED và không qua được `initiate_payment` vì thiếu `paymentRequest.id`. Hành vi này nhất quán và có test.

### 6.2 Action

- `createClaim(userId, input)`: kiểm tra `actions.createClaim.roles`; validate field lõi (`memberId`, `amount > 0`, `policyLimit > 0`); field ngoài lõi phải nằm trong `actions.createClaim.inputs` và được ghi vào `data`; tạo claim ở `initialState`; ghi `CLAIM_CREATED`. Claim và entry audit đầu tiên (`seq = 1`) được ghi trong một transaction; ID lấy từ sequence nên không trùng khi tạo đồng thời.
- `acknowledge(claimId, userId, notes, expectedVersion?)`: chạy trong `store.withClaim` như transition. Kiểm tra `actions.acknowledge.roles` và `allowedStates`, set `data.memberAcknowledged = true`, `data.memberAcknowledgedAt = now`, `data.memberAcknowledgedBy = userId`, ghi `MEMBER_ACKNOWLEDGED`. Nếu đã acknowledge trước đó thì từ chối với `ACTION_NOT_ALLOWED_IN_STATE`, message `Member acknowledgement already recorded at <memberAcknowledgedAt> by <memberAcknowledgedBy>`. Bị từ chối thì ghi `ACTION_REJECTED`.
- `runSystemTasks(userId)`: kiểm tra `actions.runSystemTasks.roles`. Với mỗi transition có role `system` (hằng `SYSTEM_ROLE` trong engine; transition được chọn theo hằng này chứ không theo role người gọi, nên thêm role khác vào `actions.runSystemTasks.roles` chỉ cho phép role đó kích hoạt job, không làm job chạy transition của role đó), lấy danh sách claim ở state `from` (đọc không khóa), rồi xử lý **từng claim trong transaction riêng** qua `store.tryWithClaim` (`FOR UPDATE SKIP LOCKED`). Dưới khóa, engine kiểm tra lại `status` (claim có thể đã đổi state sau lúc quét), **đánh giá precondition trước**, và chỉ thực hiện transition với claim thỏa điều kiện. Claim chưa thỏa được bỏ qua và **không** ghi `TRANSITION_REJECTED`, để mỗi lần chạy job không làm rác audit. Claim đang bị request khác khóa được bỏ qua với lý do `busy`, lần chạy sau sẽ xử lý. Trả về danh sách claim đã xử lý và đã bỏ qua kèm lý do. Một claim lỗi không làm hỏng các claim khác trong cùng lần chạy.

### 6.3 Transition khả dụng

`getAvailableTransitions(claimId, userId?)` trả về mọi transition đi ra từ state hiện tại, mỗi cái gồm: `to`, `roles`, `inputs`, `allowedForCurrentUser` (`false` nếu không truyền `userId`), kết quả đánh giá từng precondition trên dữ liệu hiện tại, số lần còn lại nếu có `cycleLimit`, và `enabled` = `allowedForCurrentUser` và precondition đạt và `cycleLimit` còn lượt. UI dùng `enabled` để bật/tắt nút, các field còn lại để hiển thị lý do bị khóa. Hàm này chỉ đọc, không khóa; kết quả có dạng `{ claim, transitions }`, trong đó `claim` chính là bản claim dùng để đánh giá, nên UI gửi lại `claim.version` làm `expectedVersion`.

Precondition được đánh giá ở chế độ `preview`, trên claim hiện tại và payload rỗng:

- Rule đọc field thuộc `inputs` của transition mà chưa thỏa thì **pass kèm `requiresInput: true`**, giữ nguyên message lỗi (ví dụ `assessmentReport is required`). User sẽ điền field đó trong form, nên nút không bị khóa; UI dùng cờ này để đánh dấu field bắt buộc và hiển thị message làm gợi ý. Field dạng dot path xét theo đoạn đầu (`paymentRequest.id` → `paymentRequest`).
- Rule đã thỏa thì pass bình thường, không có `requiresInput`.
- Field lõi và field trong `data` không thuộc `inputs` vẫn được đánh giá bình thường, nên lỗi thật vẫn khóa nút. Ví dụ `approve` với `amount` vượt `policyLimit`, hoặc `initiate_payment` khi chưa có `paymentRequest`.
- `providedInRequest` luôn rơi vào trường hợp đầu, vì payload preview rỗng.

Khi thực thi transition (6.1 bước 6), engine dùng chế độ `execute`: bỏ qua `inputs`, mọi rule chưa thỏa đều là lỗi. Vì vậy preview chỉ là gợi ý cho UI; request thật vẫn bị kiểm tra đầy đủ.

### 6.4 Xử lý request đồng thời

**Vấn đề cần chặn** khi hai request cùng chạm một claim:

| Tình huống | Hậu quả nếu không xử lý |
|---|---|
| Assessor A `approve`, assessor B `reject` cùng lúc | Cả hai đọc `UNDER_ASSESSMENT`, cả hai thành công; claim vừa có payment request vừa bị reject |
| Hai `request_info` khi đã có 2 vòng | Cả hai đếm được 2 < 3 và cùng lọt; vượt cycle limit |
| Hai `acknowledge` | Ghi nhận hai lần, mất thông tin người ghi nhận đầu |
| Hai lần chạy `runSystemTasks` | Một claim bị đóng hai lần, side effect `notify` chạy trùng |
| Ghi `seq` audit song song | Trùng hoặc nhảy `seq` |
| Clerk thao tác trên màn hình cũ | Gửi `info_received` dựa trên dữ liệu đã bị người khác thay đổi |

**Cơ chế**

1. **Khóa bi quan theo claim.** Mọi thao tác ghi (transition, acknowledge, system task) chạy trong một transaction `READ COMMITTED` bắt đầu bằng `SELECT ... FROM claims WHERE id = $1 FOR UPDATE`. Request thứ hai chờ đến khi request thứ nhất commit, rồi đọc lại state mới và được đánh giá lại từ đầu (ví dụ nhận `INVALID_TRANSITION` vì claim đã ở `APPROVED`). Các claim khác nhau không chặn nhau.
2. **Giới hạn thời gian chờ.** Transaction đặt `SET LOCAL lock_timeout = '5s'` (cấu hình bằng env). Quá hạn → `CLAIM_BUSY` (409), client có thể thử lại. Không có retry tự động trong engine.
3. **Mọi thứ của một thao tác nằm trong cùng transaction**: kiểm tra, đếm cycle, cấp `seq`, chạy side effect, ghi claim, ghi audit. Không có bước nào đọc dữ liệu ngoài khóa rồi ghi dựa trên dữ liệu đó.
4. **Khóa lạc quan tùy chọn ở tầng UI.** `version` tăng mỗi lần ghi claim. Request có thể gửi `expectedVersion`; lệch thì trả `STALE_CLAIM` và ghi `TRANSITION_REJECTED`/`ACTION_REJECTED`. UI luôn gửi `expectedVersion`, để người dùng không vô tình thao tác trên dữ liệu đã cũ. Client không gửi thì chỉ có khóa bi quan.
5. **Job hệ thống dùng `SKIP LOCKED`** và kiểm tra lại state dưới khóa, nên chạy song song nhiều lần vẫn đóng mỗi claim đúng một lần.
6. **Ràng buộc DB làm lớp bảo vệ cuối**: `UNIQUE (claim_id, seq)` trên audit. Nếu có lỗi lập trình làm lọt race, transaction sẽ lỗi thay vì ghi dữ liệu sai.

**Đánh đổi**

- Khóa được giữ trong lúc chạy side effect. Với handler mock thì không đáng kể; với tích hợp ngoài thật (gọi cổng thanh toán), nên chuyển sang **transactional outbox**: ghi side effect vào bảng `outbox` trong cùng transaction, worker xử lý sau commit. Đây là hướng mở rộng, không làm trong phạm vi này.
- Handler mock in log ra console trước khi commit. Nếu commit lỗi, log đã in nhưng DB không đổi. Outbox cũng giải quyết vấn đề này.
- Chọn khóa bi quan thay vì chỉ dùng `version` + retry, vì lưu lượng trên một claim thấp, logic đơn giản hơn và không phải chạy lại side effect.

## 7. Mã lỗi

| code | HTTP | Ví dụ message |
|---|---|---|
| `CLAIM_NOT_FOUND` | 404 | `Claim c-42 not found` |
| `UNKNOWN_USER` | 401 | `Unknown user u-x` |
| `INVALID_TRANSITION` | 409 | `Cannot transition SUBMITTED → APPROVED. Allowed from SUBMITTED: DOCUMENTS_VERIFIED (document_clerk)` |
| `UNAUTHORIZED_ROLE` | 403 | Transition: `Transition approve requires role assessor; user u-clerk-1 has role document_clerk`. Action: `Action createClaim requires role document_clerk; user u-assessor-1 has role assessor` |
| `INVALID_PAYLOAD` | 400 | `Field amount is not accepted by transition approve. Allowed: assessmentReport` |
| `PRECONDITION_FAILED` | 422 | `amount 12000 exceeds policyLimit 10000` |
| `CYCLE_LIMIT_EXCEEDED` | 422 | `Maximum information requests exceeded — escalate to team lead` |
| `ACTION_NOT_ALLOWED_IN_STATE` | 409 | `Action acknowledge is only allowed in states: REJECTED (current: APPROVED)`; `Member acknowledgement already recorded at 2026-10-22T09:00:00Z by u-clerk-1` |
| `VALIDATION_ERROR` | 400 | dữ liệu tạo claim không hợp lệ |
| `STALE_CLAIM` | 409 | `Claim c-42 was modified (version 5, expected 4); reload and retry` |
| `CLAIM_BUSY` | 409 | `Claim c-42 is being modified by another request; retry later` |

Body lỗi thống nhất: `{ code, message, details }`. Lỗi hạ tầng (DB không kết nối được) trả 500 với code `INTERNAL_ERROR`, không lộ chi tiết SQL.

## 8. API (NestJS)

Mọi request (trừ `GET /config`, `GET /users`) cần header `X-User-Id`.

| Method | Path | Mô tả |
|---|---|---|
| GET | `/config` | state machine đang dùng |
| GET | `/users` | danh sách user mock |
| POST | `/claims` | tạo claim (`memberId`, `amount`, `policyLimit`, `documents`) |
| GET | `/claims` | danh sách claim |
| GET | `/claims/:id` | claim (kèm `version`) + transition khả dụng |
| POST | `/claims/:id/transitions` | `{ to, payload?, notes?, expectedVersion? }` |
| POST | `/claims/:id/acknowledge` | `{ notes?, expectedVersion? }` |
| GET | `/claims/:id/audit` | audit trail của claim |
| POST | `/system/run-tasks` | chạy tác vụ của role system |
| GET | `/dev/clock` | thời điểm hiện tại của clock giả — chỉ có khi `DEMO_MODE=true`; UI dùng route này để biết có hiện nút "Advance clock" hay không |
| POST | `/dev/clock/advance` | `{ days }` — chỉ bật khi `DEMO_MODE=true`, để minh họa hết hạn kháng cáo |
| GET | `/health` | kiểm tra API và kết nối DB |

API dùng một `pg.Pool` dùng chung (kích thước cấu hình bằng env), được tạo trong một Nest provider và đóng khi app shutdown.

## 9. Web UI (React)

Giai đoạn 1 (bắt buộc):

- Chọn user mock ở thanh trên cùng (đổi user = đổi role).
- Danh sách claim, nút tạo claim.
- Chi tiết claim: state hiện tại, danh sách transition khả dụng kèm role cần có và form nhập `inputs`, nút acknowledge.
- Audit trail dạng bảng; entry bị từ chối và side effect lỗi được tô màu riêng.
- Khu vực system: nút "Run system tasks" và "Advance clock".
- Mọi thao tác ghi gửi kèm `expectedVersion`; khi nhận `STALE_CLAIM` hoặc `CLAIM_BUSY`, UI hiện thông báo và tải lại claim.

Giai đoạn 2 (mở rộng):

- Sơ đồ state với state hiện tại được tô sáng.
- Hiển thị từng precondition đạt/chưa đạt trên mỗi transition.
- Audit dạng timeline, entry `SIDE_EFFECT` lồng dưới entry `TRANSITION` gốc.

## 10. Test

Dùng Vitest, test chạy trên config thật trong `config/claims-workflow.json`. Hai tầng:

- `pnpm test`: case 1–25 chạy trên engine với store in-memory; không cần Docker, chạy nhanh.
- `pnpm test:integration`: chạy trên PostgreSQL thật (`docker compose up -d postgres`, database `claims_test`, mỗi test file tạo lại schema bằng `DROP SCHEMA ... CASCADE` rồi chạy migration, vì trigger chặn xóa audit). Gồm contract test cho `WorkflowStore` chạy trên **cả hai** bản cài đặt, và case 26–32.

**Transition hợp lệ**
1. Happy path đi tới CLOSED, audit đủ 13 entry đúng thứ tự: 1 `CLAIM_CREATED`, 5 `TRANSITION`, 7 `SIDE_EFFECT` với `status: ok` (`start_assessment` và `approve` mỗi transition có 2 side effect); nội dung `notify` đã render đúng biến.
2. Rejection path đóng claim khi member đã acknowledge.
3. Rejection path đóng claim khi hết hạn kháng cáo (clock giả).
4. Vòng request info một lần rồi approve tới CLOSED.

**Transition không hợp lệ**
5. SUBMITTED → APPROVED bị từ chối với `INVALID_TRANSITION`, message liệt kê transition hợp lệ.
6. Transition từ CLOSED bị từ chối, message nêu state terminal; `to` là state không tồn tại bị từ chối với message `Unknown state ...`. Cả hai đều ghi `TRANSITION_REJECTED`.
7. Transition bị từ chối không làm thay đổi claim và ghi `TRANSITION_REJECTED`.

**Precondition**
8. Thiếu giấy tờ bắt buộc, message liệt kê giấy tờ thiếu.
9. Approve khi `amount > policyLimit`.
10. Reject không có `rejectionReason`.
11. `info_received` không gửi `infoResponse` lẫn `documents` mới bị từ chối (dữ liệu cũ trên claim không được tính); chỉ gửi một trong hai thì thành công.
12. `info_received` thay thế `documents` bằng danh sách thiếu giấy tờ bắt buộc bị từ chối, message liệt kê giấy tờ thiếu; thay thế bằng danh sách đủ thì thành công.
13. `close_rejected` khi chưa hết hạn và chưa acknowledge, message nêu cả hai nhánh.
14. Payload chứa field ngoài `inputs` (ví dụ `amount`) bị `INVALID_PAYLOAD`.

**Phân quyền**
15. Clerk cố approve bị `UNAUTHORIZED_ROLE`.
16. Assessor cố tạo claim bị `UNAUTHORIZED_ROLE`.
17. Finance cố acknowledge bị `UNAUTHORIZED_ROLE`; clerk acknowledge ở state khác REJECTED bị `ACTION_NOT_ALLOWED_IN_STATE`; acknowledge lần thứ hai bị `ACTION_NOT_ALLOWED_IN_STATE` với message nêu thời điểm và người đã ghi nhận lần đầu, và ghi `ACTION_REJECTED`.
18. User không tồn tại bị `UNKNOWN_USER`.

**Cycle**
19. 3 vòng request info thành công, lần thứ 4 trả đúng message `Maximum information requests exceeded — escalate to team lead`.
20. Request info bị từ chối (thiếu mô tả) không được tính vào bộ đếm cycle.

**Audit**
21. Entry audit không sửa/xóa được; sửa mảng trả về không ảnh hưởng dữ liệu đã lưu.
22. Mỗi entry `TRANSITION` có đủ `timestamp`, `fromState`, `toState`, `triggeredBy.userId`, `triggeredBy.role`, `reason`; `reason` lấy đúng thứ tự ưu tiên (`rejectionReason` → `notes` → `description`).

**Side effect và config**
23. Side effect lỗi được ghi `SIDE_EFFECT` với `status: failed` và `error`; state không rollback; các side effect sau vẫn chạy và được ghi `status: ok`.
24. Config lỗi (state không tồn tại, role lạ, rule chưa đăng ký) bị từ chối khi load.
25. Load `with-escalation.json`: state ESCALATED và 3 transition mới dùng được mà không sửa code; `return_to_assessment` lần thứ 2 bị `CYCLE_LIMIT_EXCEEDED`.

**Đồng thời và PostgreSQL** (integration)

Các case dưới đây bắn request song song bằng `Promise.all` trên các connection khác nhau của pool; mỗi case lặp lại 20 lần để tăng khả năng lộ race.

26. `approve` và `reject` cùng lúc trên một claim: đúng một request thành công, request kia bị `INVALID_TRANSITION`; audit có đúng 1 `TRANSITION` và 1 `TRANSITION_REJECTED`; claim chỉ có side effect của transition thắng.
27. Claim đã có 2 vòng request info, gửi 5 `request_info` đồng thời: đúng 1 thành công, số `TRANSITION` của `request_info` là 3; lần thứ 4 sau đó bị `CYCLE_LIMIT_EXCEEDED`.
28. Hai `acknowledge` đồng thời: đúng 1 `MEMBER_ACKNOWLEDGED` và 1 `ACTION_REJECTED`.
29. Hai lần `runSystemTasks` đồng thời trên 10 claim đủ điều kiện: mỗi claim có đúng 1 `TRANSITION` `close_rejected` và đúng 1 bộ `SIDE_EFFECT`.
30. `seq` audit của một claim liên tục từ 1, không trùng, sau một loạt request đồng thời trộn lẫn thành công và bị từ chối.
31. `expectedVersion` cũ bị `STALE_CLAIM`, claim không đổi, ghi `TRANSITION_REJECTED`; một connection khác giữ khóa claim lâu hơn `lock_timeout` thì request bị `CLAIM_BUSY` và không ghi audit.
32. `UPDATE`, `DELETE`, `TRUNCATE` trực tiếp trên `audit_entries` bằng SQL đều bị trigger từ chối.

API và UI không có test tự động; được kiểm tra thủ công trên UI (`docker compose up -d postgres` + `pnpm dev`) theo các scenario ở mục 11.

## 11. Bằng chứng nộp kèm

- `pnpm scenarios`: chạy 5 scenario của đề + 1 case precondition thất bại + 1 case vượt cycle + 1 case hai request đồng thời trên cùng claim, trên PostgreSQL (database riêng `claims_scenarios`, reset mỗi lần chạy). Kết quả ghi ra `docs/scenario-results.md` và `docs/audit-output.json` (audit đọc lại từ DB).
- `docs/config-diff.md`: diff giữa `claims-workflow.json` và `examples/with-escalation.json`, kèm output chạy thử. Diff gồm 1 state và 3 transition mới, chỉ dùng lại rule và side effect đã có:

  | id | from → to | roles | inputs | preconditions | side effects |
  |---|---|---|---|---|---|
  | `escalate` | UNDER_ASSESSMENT → ESCALATED | assessor | `escalationReason` | `providedInRequest(escalationReason)` | `notify(role:team_lead)` kèm `escalationReason` |
  | `return_to_assessment` | ESCALATED → UNDER_ASSESSMENT | team_lead | `assessorId` | `userHasRole(assessorId, assessor)`; `cycleLimit.max = 1` | `setField(assessmentStartedAt, $now)`, `notify(user:assessorId)` |
  | `reject_escalated` | ESCALATED → REJECTED | team_lead | `rejectionReason` | `providedInRequest(rejectionReason)` | `notify(member)` kèm lý do |

  Field mới `escalationReason` được lưu vào `claim.data` mà không sửa kiểu `Claim`.

  Output chạy thử minh họa hai điều: (1) config mới load thành công; (2) một claim đi `UNDER_ASSESSMENT → ESCALATED → REJECTED → CLOSED` và một claim bị chặn ở lần `return_to_assessment` thứ 2.
- Giai đoạn 2 — ví dụ phụ trong `examples/member-self-service/`: cho member tự tạo claim chỉ bằng config, gồm 3 thay đổi: thêm `member` vào `roles`, thêm user `u-member-1` vào `users.json`, thêm `member` vào `actions.createClaim.roles`. Kèm diff và output chạy thử.

## 12. Giả định

- `document_clerk` tạo claim để đơn giản hóa bài test; thực tế member có thể tự tạo hoặc clerk tạo giúp. Quyền nằm trong config nên thay đổi không cần sửa code.
- Acknowledge của member do `document_clerk` ghi nhận.
- "Assessment report complete" được hiểu là có nội dung báo cáo (`notEmpty`).
- "Payment confirmed" được hiểu là finance gửi `paymentReference` trong request.
- Giá trị rỗng được coi là chưa có: `undefined`, `null`, chuỗi rỗng hoặc chỉ có khoảng trắng, mảng rỗng, object rỗng. Áp dụng cho cả `notEmpty` và `providedInRequest`, nên gửi `rejectionReason: ""` bị coi như không gửi. `0` và `false` là giá trị hợp lệ.
- `setField.params.value` dạng chuỗi bắt đầu bằng `$` chỉ chấp nhận `$now`; chuỗi `$` khác (ví dụ `$today`) bị từ chối khi load để bắt lỗi gõ nhầm. Hệ quả: config không ghi được chuỗi literal bắt đầu bằng `$` qua `setField`.
- Danh sách giấy tờ bắt buộc dùng chung cho mọi claim.
- `policyLimit` do clerk nhập khi tạo claim và là field lõi, không thay đổi được sau khi tạo. Thực tế hạn mức phải lấy từ hệ thống quản lý hợp đồng bảo hiểm theo `policyId` của member, để người tạo claim không tự đặt được hạn mức; hướng mở rộng là thay bằng tra cứu policy mà engine không đổi.
- "Chỉ sửa config" bao gồm: thêm state, transition, role, user, field dữ liệu mới, thông báo mới (qua `notify`) và ghi field (qua `setField`). Loại rule mới hoặc tích hợp hệ thống ngoài mới (như `createPaymentRequest`) vẫn cần thêm handler vào registry.
- Role do server suy ra từ user mock; không có xác thực thật.
- Giới hạn vòng lặp chỉ được áp dụng ở runtime qua `cycleLimit`. Engine không kiểm tra đồ thị khi load, nên người viết config phải tự đặt `cycleLimit` cho mỗi vòng lặp mới (như `return_to_assessment` trong demo ESCALATED).
- Thao tác ghi trên cùng một claim được tuần tự hóa bằng khóa dòng PostgreSQL (mục 6.4). Thao tác đọc (`GET /claims/:id`, transition khả dụng) không khóa nên có thể thấy dữ liệu cũ vài mili giây; `expectedVersion` chặn việc ghi dựa trên dữ liệu cũ đó.
- Chỉ chạy một instance API. Khóa nằm ở DB nên nhiều instance vẫn an toàn về dữ liệu, nhưng clock giả của chế độ demo nằm trong process và không đồng bộ giữa các instance.
- Side effect chạy trong transaction, nên chỉ phù hợp với handler mock hoặc thao tác nhanh. Tích hợp thật cần outbox (mục 6.4).

## 13. Timeline

Chia hai giai đoạn. Giai đoạn 1 đáp ứng toàn bộ yêu cầu và tiêu chí chấm của đề; giai đoạn 2 chỉ làm nếu còn thời gian.

### Giai đoạn 1 — bắt buộc (~9 giờ)

| Phần việc | Thời gian |
|---|---|
| Engine: load + validate config, rule, `notify`/`setField`/payment handler, interface `WorkflowStore` + bản in-memory có mutex | 3.5h |
| `store-postgres`: migration, repository, `withClaim`/`tryWithClaim`, trigger audit | 1h |
| Test engine (25 case) + script `pnpm scenarios` | 1.5h |
| Integration test: contract test store + case đồng thời 26–32 | 0.75h |
| API NestJS: controller, guard `X-User-Id`, map lỗi → HTTP, pool `pg` | 0.5h |
| Docker PostgreSQL: `docker-compose.yml`, script init database, `.env.example`, `pnpm db:migrate` | 0.25h |
| Web UI cơ bản: chọn user, danh sách/tạo claim, transition khả dụng + form `inputs`, acknowledge, audit dạng bảng, nút system, xử lý `STALE_CLAIM` | 1h |
| README, output scenario, audit output, demo `with-escalation.json` + diff | 0.5h |

### Giai đoạn 2 — mở rộng (~1.5 giờ)

| Phần việc | Thời gian |
|---|---|
| UI: sơ đồ state tô sáng state hiện tại, hiển thị trạng thái từng precondition, audit dạng timeline với side effect lồng dưới transition | 1h |
| Demo `examples/member-self-service/` + diff | 0.5h |

Ước lượng **trước khi bắt đầu code**: khoảng 9 giờ cho phạm vi bắt buộc, tối đa 10.5 giờ nếu làm cả phần mở rộng. Phần tăng thêm so với khung 5–8 giờ của đề đến từ PostgreSQL và xử lý đồng thời, vốn ngoài yêu cầu tối thiểu.
