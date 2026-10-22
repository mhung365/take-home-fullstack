# API framework setup
_Tạo lúc 2026-10-22 21:19_

## 🧑 User

Dựng khung API theo mục 7–8, chưa làm route claims:
- Load config và users lúc khởi động, config lỗi thì app không start.
- Store inject qua token WORKFLOW_STORE (tạm dùng in-memory), engine là provider.
- Lấy user từ header X-User-Id, bỏ qua cho /config, /users, /health.
- Exception filter map WorkflowError sang HTTP theo bảng mục 7, body { code, message, details }. Lỗi khác trả 500 INTERNAL_ERROR, không lộ stack.
- Làm GET /config, GET /users, GET /health.

## 🤖 Assistant

Mình sẽ xem cấu trúc dự án và tài liệu spec (mục 7–8) trước khi dựng khung API.

## 🤖 Assistant

Nest 12 là ESM-only, nên mình kiểm tra xem API hiện tại có build và chạy được không trước khi viết thêm.

## 🤖 Assistant

Viết xong. Giờ build và kiểm tra: các route public, lỗi config làm app không start, và guard (dùng một route tạm để thử rồi xóa).

## 🤖 Assistant

Lỗi chỉ do `dist` của engine đã cũ (build từ trước khi có store/engine). Rebuild engine rồi chạy lại.

## 🤖 Assistant

Mọi thứ chạy đúng. Còn kiểm tra trường hợp config lỗi, sau đó xóa route tạm.

## 🤖 Assistant

Khung API đã chạy được: `GET /config`, `GET /users` và `GET /health` trả 200 mà không cần header. Config lỗi thì app in toàn bộ lỗi rồi thoát với exit code 1, Nest không được khởi tạo. Mình đã build và gọi thử bằng `curl` cho tất cả các trường hợp bên dưới.

**Cách làm từng phần**

- **Load config:** `main.ts` đọc và validate config bằng `loadConfig` của engine *trước khi* gọi `NestFactory.create`. Nếu config hợp lệ, nó được truyền vào `AppModule.forRoot(config)`. Đường dẫn mặc định là `config/claims-workflow.json` và `config/users.json` ở gốc repo. Có thể ghi đè bằng biến môi trường `WORKFLOW_CONFIG_PATH` và `USERS_CONFIG_PATH`.
- **Provider:** có hai token trong `src/tokens.ts`:
  - `WORKFLOW_CONFIG` giữ config đã load.
  - `WORKFLOW_STORE` hiện dùng `InMemoryWorkflowStore`.

  `WorkflowEngine` là provider factory nhận hai token này. Khi có bản PostgreSQL, chỉ cần thay factory của `WORKFLOW_STORE`.
- **Định danh:** `UserGuard` được đăng ký global. Nó đọc `X-User-Id`, tra user trong `users.json` rồi gắn vào `request.user`. Controller lấy user qua `@CurrentUser()`. Ba controller `/config`, `/users`, `/health` gắn `@Public()` nên guard bỏ qua.
- **Exception filter:** `ErrorFilter` (`@Catch()` global) dùng bảng `Record<ErrorCode, HttpStatus>`. Vì kiểu này bắt buộc đủ mọi mã, sau này engine thêm mã lỗi mới mà quên map thì sẽ báo lỗi lúc compile. Body luôn là `{ code, message, details }`, `details` là `null` khi không có. Lỗi khác trả 500 `INTERNAL_ERROR`: stack chỉ ghi vào log server, response không chứa gì.

**Kết quả kiểm tra (dùng một controller tạm, đã xóa sau khi thử)**

| Trường hợp | Kết quả |
|---|---|
| Thiếu `X-User-Id` | 401 `UNKNOWN_USER` "Missing X-User-Id header" |
| `X-User-Id: u-x` | 401 `UNKNOWN_USER` "Unknown user u-x" |
| Engine ném `CLAIM_NOT_FOUND` | 404, có `details.claimId` |
| `throw new Error('secret SQL detail')` | 500 `INTERNAL_ERROR`, message chung chung, chi tiết chỉ có trong log |
| Config có state và role không tồn tại | In cả 2 lỗi, exit code 1 |
| File config không tồn tại | In lỗi, exit code 1 |

**Bạn nên biết**

- **Lỗi của Nest không thành 500:** hai trường hợp này giữ nguyên status của Nest, không trả 500 như yêu cầu "lỗi khác trả 500":
  - Route không tồn tại: 404 `NOT_FOUND`.
  - JSON body sai cú pháp: 400 `BAD_REQUEST`.

  Lý do là trả 500 cho lỗi phía client sẽ gây hiểu nhầm. Nếu bạn muốn JSON sai trả `VALIDATION_ERROR` thì chỉ cần sửa một dòng trong filter.
- **`/health` chưa kiểm tra DB:** hiện chỉ trả `{ status: 'ok' }`. Interface `WorkflowStore` không có hàm ping, nên mình để phần kiểm tra kết nối DB đến lúc thêm `pg.Pool`.
- **Cần build lại engine:** `packages/engine/dist` đang cũ, chưa export store hay engine, nên lần build API đầu tiên bị lỗi. Mình đã chạy `pnpm --filter @claims/engine build` để sửa. `pnpm dev` vẫn build engine trước nên chạy bình thường.

Chưa commit gì. Các file mới nằm trong `apps/api/src/`: `config/`, `errors/`, `identity/`, `tokens.ts`, `config.controller.ts`, `users.controller.ts`. Đã sửa `main.ts`, `app.module.ts` và `health.controller.ts`.

## 🧑 User

OK. Sửa một chỗ: filter dùng isWorkflowError thay instanceof, vì API import engine từ dist, có hai bản trong node_modules là mọi lỗi thành 500

## 🤖 Assistant

Giờ chạy test engine, build lại, và thử trường hợp hai bản module thật sự tách nhau.

## 🤖 Assistant

Filter giờ dùng `isWorkflowError`. Mình phải sửa thêm chính hàm này: trước đây nó cũng chỉ là `error instanceof WorkflowError`, nên đổi riêng filter thì khi có hai bản engine, lỗi vẫn thành 500.

**Đã sửa trong `packages/engine/src/errors.ts`:**
- Mỗi `WorkflowError` giờ mang một thuộc tính brand có key là `Symbol.for('@claims/engine/WorkflowError')`. `Symbol.for` lấy symbol từ registry chung của process, nên bản engine nào trong `node_modules` cũng ra cùng một key.
- `isWorkflowError(error, code?)` kiểm tra brand này thay cho `instanceof`. Tham số `code` vẫn dùng như cũ.

```35:39:ai-challenge-14/packages/engine/src/errors.ts
/** Checks the brand instead of instanceof, so errors thrown by another copy of the engine still match. */
export function isWorkflowError(error: unknown, code?: ErrorCode): error is WorkflowError {
  if (typeof error !== 'object' || error === null || !(WORKFLOW_ERROR_BRAND in error)) return false;
  return code === undefined || (error as WorkflowError).code === code;
```

**Kết quả kiểm tra:**
- Mình nạp `dist/errors.js` hai lần, xóa require cache ở giữa để có hai bản module riêng. Lỗi tạo từ bản thứ nhất không qua được `instanceof` của bản thứ hai, nhưng `isWorkflowError` của bản thứ hai vẫn nhận ra và lọc đúng theo `code`. Một `Error` thường thì ra `false`.
- Brand không xuất hiện khi serialize: `JSON.stringify` vẫn chỉ ra `{ code, message, details }`.
- 211 test của engine đều pass. Engine và API build sạch.

Hiện chưa có route nào cần `X-User-Id`, nên đường đi qua guard tới filter chỉ được kiểm tra ở lượt trước, khi chưa có brand. Bài thử hai bản module ở trên là phần chứng minh cho thay đổi lần này.

## 🧑 User

Làm các route còn lại của mục 8: claims, transitions, acknowledge, audit, system/run-tasks, dev/clock/advance.

GET /claims/:id trả claim kèm kết quả getAvailableTransitions của user hiện tại.
Validate body bằng zod; body sai shape thì trả VALIDATION_ERROR với cùng format lỗi.
Clock của engine là clock có offset. /dev/clock/advance chỉ đăng ký khi DEMO_MODE=true.
Xong thì curl thử happy path và một vài lỗi, dán output cho mình.

## 🤖 Assistant

Mình xem lại các kiểu dữ liệu và method public của engine trước khi viết route.

## 🤖 Assistant

Build sạch. Giờ mình chạy API với `DEMO_MODE=true` và gọi thử bằng một script curl.

## 🤖 Assistant

Tất cả route còn lại của mục 8 đã chạy được: đi hết happy path tới `CLOSED`, và các trường hợp lỗi đều trả đúng code/HTTP theo bảng mục 7. Output curl ở dưới chạy với `DEMO_MODE=true` và store in-memory. Mình dùng `jq` rút gọn một số response cho dễ đọc; các response lỗi giữ nguyên.

**Những gì đã làm**
- **Routes:**
  - `ClaimsController` có `POST/GET /claims`, `GET /claims/:id`, `POST /claims/:id/transitions`, `POST /claims/:id/acknowledge` và `GET /claims/:id/audit`.
  - `SystemController` có `POST /system/run-tasks`.
  - `DevController` có `POST /dev/clock/advance`; controller này chỉ được thêm vào module khi `DEMO_MODE=true`.
- **Ghi và đọc:** mọi thao tác ghi đi qua engine. Các route đọc (danh sách claim, claim, audit) đọc thẳng từ store, vì engine chưa có method đọc.
- **`GET /claims/:id`:** trả `{ claim, availableTransitions }`, trong đó `availableTransitions` là kết quả `getAvailableTransitions(id, user.id)`.
- **Validate:** `ZodPipe` báo lỗi qua `validationError()` của engine, nên `details.errors` có cùng format với lỗi engine. Riêng `POST /claims` chỉ kiểm tra body là object; từng field để engine kiểm tra, nhờ vậy giữ được `INVALID_PAYLOAD` và các message có sẵn của engine.
- **JSON hỏng:** JSON sai cú pháp bị bộ parse của Express chặn trước khi tới zod, nên ban đầu ra `BAD_REQUEST`. Mình map lỗi 400 của Nest sang `VALIDATION_ERROR` cùng format. Route không tồn tại vẫn trả 404 `NOT_FOUND`.
- **Clock:** `OffsetClock` lấy giờ hệ thống cộng offset và được inject vào engine. Offset chỉ tăng (`days` phải > 0) và mất khi restart process.
- **`GET /claims?status=A,B`:** lọc theo state. Đây là tham số mình tự thêm, mục 8 không yêu cầu.

```text
######## Happy path
$ POST /claims  [u-clerk-1]  {"memberId":"m-1","amount":5000,"policyLimit":10000,"documents":["claim_form"]}
→ 201 {"id":"c-1","status":"SUBMITTED","version":1,"data":{"documents":["claim_form"]}}

$ GET /claims/c-1  [u-clerk-1]
→ 200 {"claim":{"status":"SUBMITTED","version":1},"available":[{"to":"DOCUMENTS_VERIFIED","enabled":true,"rules":[{"passed":true,"message":"Missing required documents: invoice, id_proof","requiresInput":true}]}]}

$ POST /claims/c-1/transitions  [u-clerk-1]  {"to":"DOCUMENTS_VERIFIED","payload":{"documents":["claim_form","invoice","id_proof"]},"expectedVersion":1}
→ 200 {"id":"c-1","status":"DOCUMENTS_VERIFIED","version":2,"audit":["TRANSITION","SIDE_EFFECT:notify=ok"]}
$ ... [u-lead-1]  {"to":"UNDER_ASSESSMENT","payload":{"assessorId":"u-assessor-1"}}
→ 200 {"status":"UNDER_ASSESSMENT","version":3,"audit":["TRANSITION","SIDE_EFFECT:setField=ok","SIDE_EFFECT:notify=ok"]}
$ ... [u-assessor-1]  {"to":"APPROVED","payload":{"assessmentReport":"All good"}}
→ 200 {"status":"APPROVED","version":4,"audit":["TRANSITION","SIDE_EFFECT:notify=ok","SIDE_EFFECT:createPaymentRequest=ok"]}
$ ... [u-finance-1]  {"to":"PAYMENT_INITIATED"}
→ 200 {"status":"PAYMENT_INITIATED","version":5,"audit":["TRANSITION","SIDE_EFFECT:triggerPaymentSystem=ok"]}
$ ... [u-finance-1]  {"to":"CLOSED","payload":{"paymentReference":"PAY-123"}}
→ 200 {"status":"CLOSED","version":6,"audit":["TRANSITION","SIDE_EFFECT:notify=ok"]}

$ GET /claims/c-1/audit   → 200, 13 entry (1 CLAIM_CREATED, 5 TRANSITION, 7 SIDE_EFFECT)
  "12 TRANSITION PAYMENT_INITIATED→CLOSED | PAY-123"   ← reason lấy từ reasonField

######## Rejection + acknowledge + clock + system tasks
(c-2, c-3 đều đi tới REJECTED)
$ POST /claims/c-2/acknowledge  [u-clerk-1]  {"notes":"Member called, accepts decision"}
→ 200 {"status":"REJECTED","version":5,"audit":{"type":"MEMBER_ACKNOWLEDGED","reason":"Member called, accepts decision"}}
$ POST /system/run-tasks  [u-system]
→ 200 {"processed":["c-2 REJECTED→CLOSED"],"skipped":["c-3 preconditions_not_met"]}
$ POST /dev/clock/advance  [u-system]  {"days":31}
→ 200 {"now":"2026-11-22T14:33:34.002Z","offsetMs":2678400000}
$ POST /system/run-tasks  [u-system]
→ 200 {"processed":["c-3 REJECTED→CLOSED"],"skipped":[]}
$ GET /claims?status=CLOSED,REJECTED
→ 200 ["c-1 CLOSED","c-2 CLOSED","c-3 CLOSED"]

######## Errors
$ GET /claims  (không header)
→ 401 {"code":"UNKNOWN_USER","message":"Missing X-User-Id header","details":null}
$ GET /claims/c-999
→ 404 {"code":"CLAIM_NOT_FOUND","message":"Claim c-999 not found","details":{"claimId":"c-999"}}
$ POST /claims/c-1/transitions  {"payload":"oops","expectedVersion":0,"extra":1}
→ 400 {"code":"VALIDATION_ERROR","message":"to: Invalid input: expected string, received undefined; payload: Invalid input: expected record, received string; expectedVersion: Too small: expected number to be >0; body: Unrecognized key: \"extra\"","details":{"errors":[{"field":"to",...},{"field":"payload",...},{"field":"expectedVersion",...},{"field":"",...}]}}
$ POST /claims  "just a string"
→ 400 {"code":"VALIDATION_ERROR","message":"body: Unexpected token '\"', \"\"just a string\"\" is not valid JSON","details":{"errors":[{"field":"","message":"body: ..."}]}}
$ POST /claims  {"memberId":"","amount":-5,"policyLimit":"x"}
→ 400 {"code":"VALIDATION_ERROR","message":"memberId is required; amount must be a positive number, got -5; policyLimit must be a positive number, got \"x\"",...}
$ POST /claims  [u-assessor-1]
→ 403 {"code":"UNAUTHORIZED_ROLE","message":"Action createClaim requires role document_clerk; user u-assessor-1 has role assessor",...}
$ POST /claims/c-4/transitions  {"to":"APPROVED"}
→ 409 {"code":"INVALID_TRANSITION","message":"Cannot transition SUBMITTED → APPROVED. Allowed from SUBMITTED: DOCUMENTS_VERIFIED (document_clerk)",...}
$ POST /claims/c-4/transitions  {"to":"DOCUMENTS_VERIFIED"}
→ 422 {"code":"PRECONDITION_FAILED","message":"Missing required documents: invoice, id_proof",...}
$ POST /claims/c-4/transitions  {"to":"UNDER_ASSESSMENT","expectedVersion":1}   (claim đang ở version 2)
→ 409 {"code":"STALE_CLAIM","message":"Claim c-4 was modified (version 2, expected 1); reload and retry",...}
$ POST /claims/c-4/transitions  [u-assessor-1]  {"to":"APPROVED","payload":{"assessmentReport":"ok","amount":1}}
→ 400 {"code":"INVALID_PAYLOAD","message":"Field amount is not accepted by transition approve. Allowed: assessmentReport",...}
$ POST /claims/c-4/transitions  [u-assessor-1]  {"to":"APPROVED","payload":{"assessmentReport":"ok"}}   (amount 12000)
→ 422 {"code":"PRECONDITION_FAILED","message":"amount 12000 exceeds policyLimit 10000",...}
$ POST /claims/c-2/acknowledge  [u-finance-1]
→ 403 {"code":"UNAUTHORIZED_ROLE","message":"Action acknowledge requires role document_clerk; user u-finance-1 has role finance",...}
$ POST /claims/c-3/acknowledge  [u-clerk-1]   (claim đã CLOSED)
→ 409 {"code":"ACTION_NOT_ALLOWED_IN_STATE","message":"Action acknowledge is only allowed in states: REJECTED (current: CLOSED)",...}
$ POST /dev/clock/advance  {"days":-1}
→ 400 {"code":"VALIDATION_ERROR","message":"days: Too small: expected number to be >0",...}
$ GET /claims/c-4/audit
→ 200 [..., "2 TRANSITION_REJECTED INVALID_TRANSITION", "3 TRANSITION_REJECTED PRECONDITION_FAILED", "6 TRANSITION_REJECTED STALE_CLAIM", "10 TRANSITION_REJECTED INVALID_PAYLOAD", "11 TRANSITION_REJECTED PRECONDITION_FAILED"]

######## Không bật DEMO_MODE
$ POST /dev/clock/advance
→ 404 {"code":"NOT_FOUND","message":"Cannot POST /dev/clock/advance","details":null}
```

Bạn nên biết:
- `GET /claims/:id` đọc claim và `getAvailableTransitions` bằng hai lần đọc riêng, không khóa. Nếu có request ghi xen vào giữa, `claim.version` có thể khác `availableTransitions.version`. UI nên lấy `availableTransitions.version` làm `expectedVersion`; nếu dữ liệu cũ thì `STALE_CLAIM` vẫn chặn.
- `/dev/clock/advance` vẫn cần `X-User-Id`, nhưng user mang role nào cũng gọi được.

Mình đã thêm `zod` vào `apps/api/package.json`, nên `pnpm-lock.yaml` cũng thay đổi theo. Chưa commit gì.

## 🧑 User

OK. Sửa một chỗ: cho getAvailableTransitions trả kèm claim (engine đã đọc sẵn rồi). GET /claims/:id chỉ đọc một lần, claim và các transition khớp nhau, UI dùng claim.version là đúng. Chạy lại test engine.

## 🤖 Assistant

Giờ sửa controller để `GET /claims/:id` chỉ đọc một lần, qua engine.

## 🤖 Assistant

`getAvailableTransitions` giờ trả `{ claim, transitions }`, và `GET /claims/:id` chỉ gọi đúng hàm này một lần. Vì `claim` chính là bản đã dùng để đánh giá các transition, hai phần luôn khớp nhau và UI gửi `claim.version` làm `expectedVersion` là đúng. Test engine chạy lại pass cả 211 test; engine và API build sạch.

**Những gì đã đổi:**
- **Engine:** `AvailableTransitions` bỏ ba trường `claimId`, `status`, `version`, thay bằng `claim: Claim`. Đây là bản copy store trả về, nên an toàn khi đưa ra ngoài.
- **Test `available.test.ts`:** ba chỗ đọc ba trường cũ được sửa sang `result.claim`. Chỗ kiểm tra state terminal giờ so khớp nguyên `{ claim, transitions: [] }`.
- **API:** `GET /claims/:id` trả thẳng kết quả của engine. Claim không tồn tại vẫn ra 404 `CLAIM_NOT_FOUND`, vì engine tự ném lỗi này.
- **DESIGN mục 6.3:** cập nhật lại câu mô tả kết quả trả về.

Response của `GET /claims/:id` đổi shape: trước là `{ claim, availableTransitions: {...} }`, giờ là `{ claim, transitions }`. Phía web cần đọc theo shape mới.

Gọi thử sau khi đổi:

```text
$ GET /claims/c-1
{"claim":{"id":"c-1","status":"SUBMITTED","version":1},"transitions":[{"to":"DOCUMENTS_VERIFIED","enabled":true}]}
→ 200
$ GET /claims/c-999
{"code":"CLAIM_NOT_FOUND","message":"Claim c-999 not found","details":{"claimId":"c-999"}}
→ 404
```
