# Test case comparison table
_Tạo lúc 2026-10-22 21:04_

## 🧑 User

Lập bảng đối chiếu 25 test case ở mục 10 với các test đang có (file + tên test). Case nào chưa có hoặc mới phủ một phần thì liệt kê ra, chưa viết test.

## 🤖 Assistant

Mình sẽ tìm tài liệu có mục 10 (danh sách 25 test case) rồi đối chiếu với các file test hiện có.

## 🤖 Assistant

Đã có danh sách 25 case. Giờ mình đọc toàn bộ các file test để đối chiếu.

## 🤖 Assistant

Kiểm tra thêm case 25 (`with-escalation.json`) và case 11 (`info_received` / `infoResponse`).

## 🤖 Assistant

Trong 25 case, 15 case đã phủ đủ, 8 case mới phủ một phần và 2 case chưa có test (case 4 và case 25). Đường dẫn trong bảng tính từ `packages/engine/test/`.

## Bảng đối chiếu

| # | Trạng thái | File | Tên test |
|---|---|---|---|
| 1 | Đủ | `engine/transition.test.ts` | `happy path to CLOSED: 13 audit entries in order, notify rendered (case 1)` |
| 2 | Một phần | `engine/actions.test.ts` | `lets close_rejected run before the appeal period ends (case 2)` |
| 3 | Một phần | `engine/transition.test.ts` | `close_rejected is blocked until the appeal period ends on the clock (cases 3, 13)` |
| 4 | **Chưa có** | — | — |
| 5 | Đủ | `engine/transition.test.ts` | `INVALID_TRANSITION: no such edge lists the allowed transitions (case 5)` |
| 6 | Đủ | `engine/transition.test.ts` | `INVALID_TRANSITION: terminal state and unknown state (case 6)` |
| 7 | Đủ | `engine/transition.test.ts` | `PRECONDITION_FAILED stores every rule failure (cases 7, 9)` và hàm `rejected()` dùng chung trong `describe` "rejections are audited, then thrown" |
| 8 | Một phần | `rules.test.ts` | `containsAll › lists the missing values in order` |
| 9 | Đủ | `engine/transition.test.ts` | `PRECONDITION_FAILED stores every rule failure (cases 7, 9)` |
| 10 | Một phần | `rules.test.ts` | `preview mode › ignores inputs in execute mode` |
| 11 | Một phần | `engine/transition.test.ts` | `replaces documents with the payload list ...` và `CYCLE_LIMIT_EXCEEDED on the 4th request_info ...` |
| 12 | Đủ | `engine/transition.test.ts` | `PRECONDITION_FAILED is evaluated on the draft with the payload merged (case 12)` và `replaces documents with the payload list (not appended) ...` |
| 13 | Đủ | `engine/transition.test.ts` | `close_rejected is blocked until the appeal period ends on the clock (cases 3, 13)` |
| 14 | Đủ | `engine/transition.test.ts` | `INVALID_PAYLOAD lists every field outside inputs (case 14)` |
| 15 | Đủ | `engine/transition.test.ts` | `UNAUTHORIZED_ROLE (case 15)` |
| 16 | Đủ | `engine/actions.test.ts` | `UNKNOWN_USER and UNAUTHORIZED_ROLE (case 16), without writing anything` |
| 17 | Đủ | `engine/actions.test.ts` | `UNAUTHORIZED_ROLE (case 17)`, `ACTION_NOT_ALLOWED_IN_STATE outside allowedStates (case 17)`, `ACTION_NOT_ALLOWED_IN_STATE on a second acknowledge, naming the first (case 17)` |
| 18 | Đủ | `engine/transition.test.ts` (và `actions`, `available`, `system-tasks`) | `UNKNOWN_USER, checked before the claim (case 18)` |
| 19 | Đủ | `engine/transition.test.ts` | `CYCLE_LIMIT_EXCEEDED on the 4th request_info; rejected attempts do not count (cases 19, 20)` |
| 20 | Đủ | `engine/transition.test.ts`, `engine/available.test.ts` | Test case 19 ở trên; `counts successful transitions against cycleLimit and disables at the max` |
| 21 | Đủ (ở tầng store) | `store/contract.ts` (chạy qua `store/memory.test.ts`) | `returns deep-frozen entries`, `rejects assigning, deleting and pushing on returned entries, and the stored entry is unchanged`, `returns a new array from every list call` |
| 22 | Một phần | `engine/transition.test.ts` | `reason: reasonField, then notes, then description (case 22)` và `moves the claim, bumps version, merges payload and records TRANSITION with clock time` |
| 23 | Đủ | `engine/transition.test.ts` | `a failing handler is recorded as failed, its patch dropped, later handlers still run, no rollback (case 23)` |
| 24 | Đủ | `config.test.ts` | `rejects references to unknown states`, `rejects unknown roles in transitions, actions and users.json`, `rejects rules that are not registered` |
| 25 | **Chưa có** | — | — |

## Case chưa có test

- **Case 4: vòng request info một lần rồi approve tới CLOSED.** Đã có test chạy vòng `request_info` → `info_received` → `start_assessment` (trong test cycle và trong `available.test.ts`). Nhưng chưa test nào đi tiếp `approve` → `initiate_payment` → `confirm_payment` để tới CLOSED.
- **Case 25: load `with-escalation.json`.** File `examples/with-escalation.json` chưa tồn tại trong repo, nên chưa có cả config lẫn test cho state ESCALATED, 3 transition mới, và lỗi `CYCLE_LIMIT_EXCEEDED` ở lần `return_to_assessment` thứ hai.

## Case mới phủ một phần

- **Case 2 và 3: rejection path.** Cả hai test đều tạo sẵn claim ở REJECTED bằng `seed()`. Chưa test nào đi transition `reject` thật từ UNDER_ASSESSMENT rồi tới CLOSED. Hai test này cũng không kiểm tra audit của việc đóng claim. Test trong `system-tasks.test.ts` (`closes qualifying REJECTED claims ...`) có kiểm tra audit, nhưng cũng bắt đầu từ claim đã seed.
- **Case 8: thiếu giấy tờ bắt buộc.** Mới có test ở tầng rule. Ở tầng engine chưa có test `verify_documents` (SUBMITTED → DOCUMENTS_VERIFIED) bị `PRECONDITION_FAILED` kèm message `Missing required documents: ...`. Test case 12 có kiểm tra message này, nhưng trên transition `info_received`.
- **Case 10: reject không có `rejectionReason`.** Mới có test ở tầng rule (`evaluatePreconditions`). Chưa có test engine gọi `transition(..., { to: 'REJECTED' })` thiếu `rejectionReason` (hoặc gửi `rejectionReason: ""`) để kiểm tra lỗi `PRECONDITION_FAILED` và `TRANSITION_REJECTED`.
- **Case 11: `info_received` không gửi gì mới.** Hai nhánh thành công đã có: chỉ gửi `documents`, hoặc chỉ gửi `infoResponse`. Còn thiếu nhánh bị từ chối: claim đã có `infoResponse` hoặc `documents` từ trước, payload không gửi cả hai, thì phải bị `PRECONDITION_FAILED`. Hiện ý "dữ liệu cũ không được tính" mới được test ở tầng rule và trên `confirm_payment`.
- **Case 22: đủ field cho mỗi entry `TRANSITION`.** Đủ `timestamp`, `fromState`, `toState`, `triggeredBy` và `reason` mới được kiểm tra cho một entry `approve`. Thứ tự ưu tiên của `reason` thì đã được test đủ. Chưa test nào duyệt **mọi** entry `TRANSITION` của một luồng (ví dụ luồng happy path) để kiểm tra đủ các field.

Còn hai điểm nhỏ ở các case mình xếp là "đủ":

- **Case 1:** `CLAIM_CREATED` đến từ `seed()` (ghi thẳng vào store), không qua `engine.createClaim`.
- **Case 21:** chỉ kiểm tra ở tầng store. Chưa kiểm tra mảng `result.audit` mà `engine.transition` trả về, nếu bạn muốn phủ cả tầng engine.

Mình chưa viết test nào cho các case trên, đúng như bạn yêu cầu.

## 🧑 User

Bảng ổn. Chuyển case 1 sang "Một phần": happy path phải tạo claim qua engine.createClaim, không dùng seed().
Viết test cho 2 case còn thiếu, 8 case một phần và case 1. Tên test bắt đầu bằng case N:
Case 2 và 3: đi reject thật từ UNDER_ASSESSMENT rồi tới CLOSED, có kiểm tra audit.
Case 22: duyệt mọi entry TRANSITION của happy path.
Case 21: thêm kiểm tra result.audit mà engine trả về là frozen.
Case 25: tạo examples/with-escalation.json đúng bảng ở mục 11, test load từ file thật. Nếu phải sửa code engine thì dừng lại báo mình, vì case này để chứng minh không cần sửa code.
Chưa làm scenarios, để sau khi có Postgres.

## 🤖 Assistant

Mình sẽ đọc config thật và code engine trước, để test bám đúng hành vi hiện tại và để xem case 25 có chạy được mà không cần sửa engine hay không.

## 🤖 Assistant

Config thật và engine đã rõ. Mình kiểm tra thêm schema của `cycleLimit` / `reasonField` và xem DESIGN có mô tả gì thêm về demo ESCALATED không.

## 🤖 Assistant

Giờ mình viết các flow đầu-cuối (case 1, 2, 3, 4, 21, 22) vào file mới `test/engine/cases.test.ts`, dùng `setup()` trong `helpers.ts` với các side effect có sẵn.

## 🤖 Assistant

Giờ là test cho case 25, đọc từ file `examples/with-escalation.json` thật.

## 🤖 Assistant

Toàn bộ 211 test đều pass ngay lần đầu, nên mình kiểm tra lại xem các test mới có thực sự chạy không, và `tsc` có kiểm tra cả thư mục test không.

## 🤖 Assistant

Mình đã viết xong test cho 10 case: case 1, 2, 3, 4, 8, 10, 11, 21, 22 và 25. Case 25 chạy được **mà không phải sửa engine**: ESCALATED và 3 transition mới chỉ cần thêm vào config. Toàn bộ 211 test pass, và `tsc --noEmit` (có kiểm tra cả thư mục `test`) không báo lỗi.

| Case | File | Tên test |
|---|---|---|
| 1 | `test/engine/cases.test.ts` | `case 1: createClaim through CLOSED writes 13 audit entries in order, all side effects ok, notify rendered` |
| 22 | `test/engine/cases.test.ts` | `case 22: every TRANSITION entry has timestamp, states, triggeredBy and reason by priority` |
| 2 | `test/engine/cases.test.ts` | `case 2: reject, member acknowledges, close_rejected closes the claim before the appeal period ends` |
| 3 | `test/engine/cases.test.ts` | `case 3: reject, then runSystemTasks closes the claim once the appeal period since rejection ends` |
| 4 | `test/engine/cases.test.ts` | `case 4: one request_info round, then approve through to CLOSED` |
| 21 | `test/engine/cases.test.ts` | `case 21: result.audit from transition and acknowledge is frozen; editing the returned array changes nothing stored` |
| 8 | `test/engine/transition.test.ts` | `case 8: verify_documents with missing required documents lists them, from the claim or the payload` |
| 10 | `test/engine/transition.test.ts` | `case 10: reject without rejectionReason, or with a blank one, is PRECONDITION_FAILED` |
| 11 | `test/engine/transition.test.ts` | `case 11: info_received needs infoResponse or documents in this request; values already on the claim do not count` |
| 25 | `test/engine/escalation.test.ts` | 3 test bắt đầu bằng `case 25:` |

**Thay đổi so với test cũ.** Test happy path cũ trong `transition.test.ts` dùng `seed()`, nên mình đã xóa nó vì case 1 mới thay thế hoàn toàn. Case 8, 10, 11 dùng lại hàm `rejected()` có sẵn, nên mỗi lần bị từ chối đều được kiểm tra luôn là có ghi `TRANSITION_REJECTED` và claim không đổi.

**Chi tiết theo từng case:**
- **Case 1 và 22** dùng chung một luồng: tạo claim qua `engine.createClaim`, sau đó mỗi transition cách nhau 1 giờ. Nhờ vậy mỗi entry `TRANSITION` có `timestamp` riêng để so sánh. Luồng này cũng phủ cả ba mức ưu tiên của `reason`:
  - `start_assessment` có `notes` nên `reason` lấy theo `notes`.
  - `confirm_payment` có cả `paymentReference` lẫn `notes`, và `reason` lấy theo `paymentReference`.
  - Các transition còn lại lấy theo `description`.
- **Case 2 và 3** đi `reject` thật từ UNDER_ASSESSMENT và so sánh toàn bộ audit theo từng dòng.
  - Case 2 đóng claim sau khi member acknowledge.
  - Case 3 dùng `runSystemTasks`. Claim bị reject lúc 01:00 nên lúc 00:00 ngày thứ 30 vẫn bị bỏ qua, và một giờ sau mới được đóng. Điều này chứng minh hạn kháng cáo tính từ lúc reject, không tính từ lúc tạo claim.
- **Case 21:** các entry trong `result.audit` (của cả `transition` lẫn `acknowledge`) đều bị freeze sâu, sửa hoặc xóa field đều ném `TypeError`. Riêng mảng `result.audit` thì không bị freeze. Test chỉ kiểm tra rằng `pop`/`push` trên mảng đó không ảnh hưởng dữ liệu trong store. Như vậy là khớp với mô tả ở mục 10; nếu bạn muốn chính mảng đó cũng bị freeze thì phải sửa engine.

**Case 25.** File `examples/with-escalation.json` là bản sao của config chính, thêm state ESCALATED và 3 transition `escalate`, `return_to_assessment` (`cycleLimit.max = 1`) và `reject_escalated`, đúng bảng ở mục 11. Ba test kiểm tra:
- **Chỉ thêm, không sửa:** bỏ 4 phần mới đi thì file giống hệt `claims-workflow.json`. File load không có cảnh báo.
- **Luồng từ chối:** claim đi UNDER_ASSESSMENT → ESCALATED → REJECTED → CLOSED, `escalationReason` được lưu vào `claim.data`, và team lead nhận được thông báo.
- **Giới hạn vòng lặp:** lần `return_to_assessment` thứ hai bị `CYCLE_LIMIT_EXCEEDED`, có ghi audit, và claim không đổi.

Có hai chỗ mình tự đặt vì bảng ở mục 11 không quy định:
- Message của `cycleLimit`: `Claim has already been returned to assessment once — team lead must decide`.
- Nội dung thông báo cho team lead của `escalate`.

Phần scenarios chưa làm, để sau khi có Postgres như bạn dặn.

## 🧑 User

OK hết. Mảng result.audit để vậy được.

## 🤖 Assistant

Mình giữ mảng `result.audit` như hiện tại, không freeze. Engine không đổi gì: các test mới đều pass trên code cũ, chỉ thêm `examples/with-escalation.json` và các file test.
