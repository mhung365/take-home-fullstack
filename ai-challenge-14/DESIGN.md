# Claims Workflow Orchestrator — Design

Tài liệu thiết kế trước khi code. Mọi quyết định dưới đây đã được chốt dựa trên `BRIEF.md`.

## 1. Mục tiêu và phạm vi

Xây dựng workflow engine dạng state machine điều phối vòng đời claim, gồm:

- State machine định nghĩa hoàn toàn trong file JSON.
- Kiểm tra transition, role, precondition, giới hạn cycle; lỗi trả về cụ thể.
- Side effect (mock, log ra console) chạy sau transition thành công.
- Audit trail bất biến, truy vấn theo claim ID.
- Web UI + API để xem trạng thái, transition khả dụng, thực hiện transition, xem audit.

**Ngoài phạm vi:** database, đăng nhập/đăng ký, xử lý đồng thời, nhiều role trên một user, separation of duties, reset bộ đếm cycle.

## 2. Kiến trúc

```
ai-challenge-14/
├── config/
│   ├── claims-workflow.json            # state machine chính
│   ├── users.json                      # user mock (userId → role)
│   └── examples/                       # demo thay đổi chỉ bằng config
├── packages/engine/                     # TypeScript thuần, không phụ thuộc NestJS
│   ├── config/      # load + validate config
│   ├── rules/       # bộ đánh giá precondition
│   ├── effects/     # registry side effect
│   ├── store/       # ClaimRepository, AuditRepository (in-memory)
│   ├── clock.ts     # Clock inject được
│   └── engine.ts    # WorkflowEngine
├── apps/api/        # NestJS: controller, guard định danh, map lỗi → HTTP
├── apps/web/        # React UI
└── docs/            # kết quả scenario, audit output, config diff
```

Nguyên tắc:

- **Engine độc lập framework.** Toàn bộ logic nghiệp vụ và phân quyền nằm trong `packages/engine`. Test engine không cần khởi động NestJS.
- **NestJS chỉ là lớp bọc.** Guard đọc `X-User-Id` và tra user mock; **không** dùng `@Roles()` decorator cho transition, vì quyền phải đến từ config.
- **Lưu trữ trên RAM** sau interface `ClaimRepository` / `AuditRepository`, có thể thay bằng DB sau mà engine không đổi.
- **Clock inject được** để test thời hạn kháng cáo mà không chờ thật.

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
| `daysElapsed` | đã qua ít nhất N ngày kể từ mốc thời gian | `Appeal period not expired: 12 of 30 days elapsed` |
| `userHasRole` | field là userId của user có role chỉ định | `assessorId u-finance-1 is not an assessor` |

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

`notify.params.template` dùng cú pháp `{{field}}`, đọc từ cùng "view" với rule (field lõi + `data`), ví dụ `Claim {{id}} rejected: {{rejectionReason}}`. Biến không tồn tại bị báo lỗi khi load config nếu tên không có trong field lõi, `inputs` của bất kỳ transition nào, hoặc field do side effect ghi ra.

`setField.params.value` nhận giá trị JSON cố định, `null`, hoặc `"$now"` (thời điểm hiện tại từ Clock). `setField` chỉ ghi vào `data`, không ghi được field lõi.

Nhờ `notify` và `setField`, demo `with-escalation.json` có thể thông báo cho team lead (`notify(role:team_lead)`) mà không cần thêm code.

### 4.6 Validate config khi load

Engine từ chối khởi động nếu config có lỗi, và liệt kê toàn bộ lỗi:

- JSON sai schema (validate bằng Zod).
- `initialState`, `from`, `to`, `allowedStates` trỏ tới state không tồn tại.
- Role không nằm trong `roles`.
- Tên rule hoặc side effect chưa đăng ký; `params` của side effect sai schema của handler.
- Tên field trong `inputs` hoặc `setField.params.field` trùng field lõi (`id`, `status`, `memberId`, `amount`, `policyLimit`, `stateEnteredAt`, `createdAt`, `createdBy`).
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

  // Field từ config: inputs của transition/action và kết quả side effect
  data: Record<string, unknown>;
}
```

Với config chính, `data` sẽ chứa: `documents`, `assessorId`, `assessmentReport`, `rejectionReason`, `missingInfoDescription`, `infoResponse`, `memberAcknowledged`, `assessmentStartedAt`, `paymentRequest`, `paymentInitiatedAt`, `paymentReference`, `archivedAt`. Thêm field mới (ví dụ `escalationReason`) chỉ cần khai báo trong `inputs`, không sửa kiểu `Claim`.

Kiểu dữ liệu của field trong `data` không được validate theo schema; rule tự kiểm tra kiểu khi đánh giá (ví dụ `containsAll` báo lỗi nếu field không phải mảng).

Claim được trả ra ngoài dưới dạng bản copy; chỉ engine được ghi vào repository.

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

- `AuditRepository` chỉ có `append()`, `listByClaim()`, `listAll()`; không có update/delete.
- Entry được deep-freeze trước khi lưu; `list*` trả về mảng mới chứa entry đã freeze.
- Có test chứng minh: gán field, xóa field, sửa mảng trả về đều không ảnh hưởng dữ liệu đã lưu.

Chỉ ghi audit khi claim tồn tại và user hợp lệ; request với claim hoặc user không tồn tại chỉ trả lỗi.

## 6. Luồng xử lý

### 6.1 Transition — `transition(claimId, userId, { to, payload, notes })`

1. Tìm claim → `CLAIM_NOT_FOUND`.
2. Tìm user → `UNKNOWN_USER`.
3. Tìm transition `from = claim.status, to` → `INVALID_TRANSITION`. Message phân biệt ba trường hợp, đều kèm danh sách transition hợp lệ từ state hiện tại (và role cần có):
   - `to` không phải state nào trong config: `Unknown state FOO. Known states: SUBMITTED, DOCUMENTS_VERIFIED, ...`
   - State hiện tại là terminal: `Claim is in terminal state CLOSED; no transitions allowed`
   - Có state nhưng không có transition: `Cannot transition SUBMITTED → APPROVED. Allowed from SUBMITTED: DOCUMENTS_VERIFIED (document_clerk)`
4. Kiểm tra role → `UNAUTHORIZED_ROLE`, message nêu role cần có và role hiện tại.
5. Kiểm tra payload theo `inputs` → `INVALID_PAYLOAD`.
6. Merge payload vào `data` của **bản nháp** claim, đánh giá precondition trên bản nháp → `PRECONDITION_FAILED` kèm danh sách rule lỗi.
7. Kiểm tra `cycleLimit`: đếm entry `TRANSITION` **thành công** có cùng `transitionId` của claim; nếu đã đạt `max` → `CYCLE_LIMIT_EXCEEDED` với message trong config.
8. Commit: lưu bản nháp với `status = to`, `stateEnteredAt = now`; ghi audit `TRANSITION` (kèm payload).
9. Chạy lần lượt side effect theo thứ tự trong config. Mỗi side effect ghi một entry `SIDE_EFFECT` mang cùng `transitionId`, `fromState`, `toState`, `triggeredBy` với entry `TRANSITION` gốc; `data` gồm `name`, `status` (`ok` hoặc `failed`), `result` (ví dụ `{ paymentRequestId }`) hoặc `error`. Side effect lỗi **không rollback** state, các side effect còn lại vẫn chạy.

Handler side effect có thể là hàm async; engine `await` lần lượt từng handler theo thứ tự trong config, rồi mới trả kết quả cho người gọi.

Bước 3 đến 7 thất bại: claim không đổi, ghi audit `TRANSITION_REJECTED` với `data = { code, errors, payload }`.

Hệ quả của việc không rollback: nếu `createPaymentRequest` lỗi, claim nằm ở APPROVED và không qua được `initiate_payment` vì thiếu `paymentRequest.id`. Hành vi này nhất quán và có test.

### 6.2 Action

- `createClaim(userId, input)`: kiểm tra `actions.createClaim.roles`; validate field lõi (`memberId`, `amount > 0`, `policyLimit > 0`); field ngoài lõi phải nằm trong `actions.createClaim.inputs` và được ghi vào `data`; tạo claim ở `initialState`; ghi `CLAIM_CREATED`.
- `acknowledge(claimId, userId, notes)`: kiểm tra `actions.acknowledge.roles` và `allowedStates`, set `data.memberAcknowledged = true`, `data.memberAcknowledgedAt = now`, `data.memberAcknowledgedBy = userId`, ghi `MEMBER_ACKNOWLEDGED`. Nếu đã acknowledge trước đó thì từ chối với `ACTION_NOT_ALLOWED_IN_STATE`, message `Member acknowledgement already recorded at <memberAcknowledgedAt> by <memberAcknowledgedBy>`. Bị từ chối thì ghi `ACTION_REJECTED`.
- `runSystemTasks(userId)`: kiểm tra `actions.runSystemTasks.roles`. Với mỗi transition có role `system`, quét các claim ở state `from`, **đánh giá precondition trước**; chỉ thực hiện transition với claim thỏa điều kiện. Claim chưa thỏa được bỏ qua và **không** ghi `TRANSITION_REJECTED`, để mỗi lần chạy job không làm rác audit. Trả về danh sách claim đã xử lý và đã bỏ qua kèm lý do.

### 6.3 Transition khả dụng

`getAvailableTransitions(claimId, userId?)` trả về mọi transition đi ra từ state hiện tại, mỗi cái gồm: `to`, `roles`, `inputs`, `allowedForCurrentUser`, kết quả đánh giá từng precondition trên dữ liệu hiện tại, và số lần còn lại nếu có `cycleLimit`. UI dùng để hiển thị nút và lý do bị khóa.

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

Body lỗi thống nhất: `{ code, message, details }`.

## 8. API (NestJS)

Mọi request (trừ `GET /config`, `GET /users`) cần header `X-User-Id`.

| Method | Path | Mô tả |
|---|---|---|
| GET | `/config` | state machine đang dùng |
| GET | `/users` | danh sách user mock |
| POST | `/claims` | tạo claim (`memberId`, `amount`, `policyLimit`, `documents`) |
| GET | `/claims` | danh sách claim |
| GET | `/claims/:id` | claim + transition khả dụng |
| POST | `/claims/:id/transitions` | `{ to, payload?, notes? }` |
| POST | `/claims/:id/acknowledge` | `{ notes? }` |
| GET | `/claims/:id/audit` | audit trail của claim |
| POST | `/system/run-tasks` | chạy tác vụ của role system |
| POST | `/dev/clock/advance` | `{ days }` — chỉ bật ở chế độ demo, để minh họa hết hạn kháng cáo |

## 9. Web UI (React)

Giai đoạn 1 (bắt buộc):

- Chọn user mock ở thanh trên cùng (đổi user = đổi role).
- Danh sách claim, nút tạo claim.
- Chi tiết claim: state hiện tại, danh sách transition khả dụng kèm role cần có và form nhập `inputs`, nút acknowledge.
- Audit trail dạng bảng; entry bị từ chối và side effect lỗi được tô màu riêng.
- Khu vực system: nút "Run system tasks" và "Advance clock".

Giai đoạn 2 (mở rộng):

- Sơ đồ state với state hiện tại được tô sáng.
- Hiển thị từng precondition đạt/chưa đạt trên mỗi transition.
- Audit dạng timeline, entry `SIDE_EFFECT` lồng dưới entry `TRANSITION` gốc.

## 10. Test

Dùng Vitest cho engine, test chạy trên config thật trong `config/claims-workflow.json`.

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

API và UI không có test tự động; được kiểm tra thủ công trên UI theo các scenario ở mục 11.

## 11. Bằng chứng nộp kèm

- `pnpm scenarios`: chạy 5 scenario của đề + 1 case precondition thất bại + 1 case vượt cycle, ghi ra `docs/scenario-results.md` và `docs/audit-output.json`.
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
- Danh sách giấy tờ bắt buộc dùng chung cho mọi claim.
- `policyLimit` do clerk nhập khi tạo claim và là field lõi, không thay đổi được sau khi tạo. Thực tế hạn mức phải lấy từ hệ thống quản lý hợp đồng bảo hiểm theo `policyId` của member, để người tạo claim không tự đặt được hạn mức; hướng mở rộng là thay bằng tra cứu policy mà engine không đổi.
- "Chỉ sửa config" bao gồm: thêm state, transition, role, user, field dữ liệu mới, thông báo mới (qua `notify`) và ghi field (qua `setField`). Loại rule mới hoặc tích hợp hệ thống ngoài mới (như `createPaymentRequest`) vẫn cần thêm handler vào registry.
- Role do server suy ra từ user mock; không có xác thực thật.
- Giới hạn vòng lặp chỉ được áp dụng ở runtime qua `cycleLimit`. Engine không kiểm tra đồ thị khi load, nên người viết config phải tự đặt `cycleLimit` cho mỗi vòng lặp mới (như `return_to_assessment` trong demo ESCALATED).
- Không có cơ chế khóa theo claim. Hai thao tác gửi gần như cùng lúc trên một claim, khi side effect async chưa chạy xong, có thể thấy dữ liệu chưa cập nhật. Với demo một người thao tác trên UI, rủi ro này chấp nhận được.

## 13. Timeline

Chia hai giai đoạn. Giai đoạn 1 đáp ứng toàn bộ yêu cầu và tiêu chí chấm của đề; giai đoạn 2 chỉ làm nếu còn thời gian.

### Giai đoạn 1 — bắt buộc (~7 giờ)

| Phần việc | Thời gian |
|---|---|
| Engine: load + validate config, rule, `notify`/`setField`/payment handler, store append-only | 3.5h |
| Test engine (25 case) + script `pnpm scenarios` | 1.5h |
| API NestJS: controller, guard `X-User-Id`, map lỗi → HTTP | 0.5h |
| Web UI cơ bản: chọn user, danh sách/tạo claim, transition khả dụng + form `inputs`, acknowledge, audit dạng bảng, nút system | 1h |
| README, output scenario, audit output, demo `with-escalation.json` + diff | 0.5h |

### Giai đoạn 2 — mở rộng (~1.5 giờ)

| Phần việc | Thời gian |
|---|---|
| UI: sơ đồ state tô sáng state hiện tại, hiển thị trạng thái từng precondition, audit dạng timeline với side effect lồng dưới transition | 1h |
| Demo `examples/member-self-service/` + diff | 0.5h |

Ước lượng **trước khi bắt đầu code**: khoảng 7 giờ cho phạm vi bắt buộc, tối đa 8.5 giờ nếu làm cả phần mở rộng.
