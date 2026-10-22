# Create claim and acknowledge flow
_Tạo lúc 2026-10-22 19:56_

## 🧑 User

Làm createClaim và acknowledge theo 6.2. acknowledge chạy trong withClaim giống transition: bị từ chối thì append ACTION_REJECTED rồi return, throw ở ngoài. Field ghi vào claim lấy từ ACKNOWLEDGE_FIELDS.

## 🤖 Assistant

Mình sẽ đọc DESIGN.md mục 6.2 và code engine hiện tại trước.

## 🤖 Assistant

Đã nắm đủ ngữ cảnh. Giờ mình thêm các error factory, file `engine/actions.ts` (giống vai trò của `transition.ts`), rồi hai method trong engine.

## 🤖 Assistant

Giờ thêm hai method vào `WorkflowEngine`.

## 🤖 Assistant

Giờ viết test cho hai action (cases 2, 16, 17, 28 trong DESIGN 10).

## 🤖 Assistant

Mình đã làm xong `createClaim` và `acknowledge` theo DESIGN 6.2. Toàn bộ 184 test của package engine đều pass (gồm cả file test mới) và `tsc --noEmit` không báo lỗi.

**`acknowledge(claimId, userId, notes?, expectedVersion?)`** chạy trong `withClaim` theo đúng khuôn của `transition`:
- **Thứ tự kiểm tra dưới khóa:** `expectedVersion` (lệch thì `STALE_CLAIM`), rồi role, rồi `allowedStates`, rồi đã acknowledge chưa.
- **Bị từ chối:** append `ACTION_REJECTED` rồi `return reject(error)`, ra ngoài `withClaim` mới throw. Như vậy entry audit vẫn được commit.
- **Thành công:** ghi ba field lấy tên từ `ACKNOWLEDGE_FIELDS` vào `data` (giá trị `true`, thời điểm lấy từ Clock, `userId`), `saveClaim` để tăng `version`, rồi ghi `MEMBER_ACKNOWLEDGED`. `reason` lấy `notes` nếu có, không thì dùng `Member acknowledgement recorded`.
- **Đã acknowledge rồi:** trả `ACTION_NOT_ALLOWED_IN_STATE` với message `Member acknowledgement already recorded at <at> by <by>`.
- Kết quả trả về là `{ claim, audit }`, trong đó `audit` là entry `MEMBER_ACKNOWLEDGED`.

**`createClaim(userId, input)`:**
- Kiểm tra user, rồi role của action (`Action createClaim requires role ...`).
- Field ngoài `memberId`, `amount`, `policyLimit` và `actions.createClaim.inputs` bị `INVALID_PAYLOAD`. Field lõi do engine quản lý như `status` cũng bị chặn ở bước này.
- Sau đó validate `memberId`, `amount > 0`, `policyLimit > 0`, gom mọi lỗi vào một `VALIDATION_ERROR`.
- Claim được tạo qua `store.createClaim` ở `initialState`, kèm entry `CLAIM_CREATED` (lưu input) trong cùng một transaction. Khi bị từ chối thì chỉ throw, không ghi audit vì chưa có claim để gắn vào.

**Các file thay đổi:**
- `src/engine/actions.ts` (mới): kiểu input/kết quả và các hàm kiểm tra cho hai action, cùng vai trò với `transition.ts`.
- `src/engine/workflow-engine.ts`: thêm hai method.
- `src/errors.ts`: thêm `actionNotAllowedInState` và `validationError`.
- `src/engine/index.ts`: export thêm kiểu.
- `test/engine/actions.test.ts` (mới): phủ case 2, 16, 17 và bản in-memory của case 28 (hai acknowledge cùng lúc thì đúng một `MEMBER_ACKNOWLEDGED`, một `ACTION_REJECTED`).

**Ba lựa chọn DESIGN chưa ghi rõ, bạn xem có ổn không:**
- `MEMBER_ACKNOWLEDGED` và `ACTION_REJECTED` đặt `fromState = toState =` state hiện tại của claim, vì action không đổi state.
- `data` của `ACTION_REJECTED` là `{ action, code, errors }`, có thêm `action` vì entry action không có `transitionId`.
- `createClaim` trả về `Claim`, chưa trả kèm entry audit như `transition`, vì `store.createClaim` chỉ trả về claim.

## 🧑 User

thực hiện runSystemTasks và getAvailableTransitions theo 6.2–6.3.

## 🤖 Assistant

Mình sẽ xem phần đánh giá precondition (chế độ `preview`) và `tryWithClaim` của store trước khi viết.

## 🤖 Assistant

Giờ sửa engine: refactor `checkTransition` và thêm hai method.

## 🤖 Assistant

Refactor không làm vỡ test cũ. Giờ mình gom phần setup test dùng chung vào một helper và viết test cho hai tính năng mới.

## 🤖 Assistant

Test đầu tiên viết hơi rối, mình viết lại cho gọn: seed thẳng `stateEnteredAt` thay vì sửa claim qua transaction.

## 🤖 Assistant

Mình đã làm xong `runSystemTasks` và `getAvailableTransitions` theo DESIGN 6.2–6.3. Toàn bộ 199 test của package engine pass, `tsc --noEmit` không báo lỗi, và lệnh này type-check cả thư mục test.

**`runSystemTasks(userId)`**
- Kiểm tra user và `actions.runSystemTasks.roles` trước. Hai lỗi này chỉ throw, không ghi audit.
- Quét danh sách claim cho mọi transition cần chạy, không khóa, trước khi chạy bất cứ thứ gì. Nhờ vậy một claim vừa được chuyển state trong lượt này sẽ không bị transition khác chạy tiếp ngay trong cùng lượt.
- Mỗi claim chạy trong transaction riêng qua `tryWithClaim`. Dưới khóa, engine kiểm tra lại theo thứ tự: `status` còn ở state `from` không, precondition ở chế độ `execute`, rồi `cycleLimit`. Đạt hết thì gọi lại đúng hàm `applyTransition` mà `transition` dùng, nên audit và side effect giống hệt khi chạy tay.
- Claim không chạy được được trả về trong `skipped` kèm `reason`, không ghi audit:
  - `busy`: claim đang bị request khác khóa.
  - `state_changed`: claim đã đổi state sau lúc quét.
  - `preconditions_not_met`: kèm danh sách rule lỗi.
  - `cycle_limit_reached`: đã chạm giới hạn vòng lặp.
  - `error`: có lỗi khi xử lý. Chỉ claim đó bị rollback, các claim khác vẫn chạy.
- Kết quả có dạng `{ processed, skipped }`.

**`getAvailableTransitions(claimId, userId?)`**
- Chỉ đọc, không khóa, không ghi audit.
- Trả về `{ claimId, status, version, transitions }`. Mỗi transition gồm `to`, `description`, `roles`, `inputs`, `allowedForCurrentUser`, và `cycleLimit: { max, used, remaining }` nếu transition có giới hạn vòng lặp.
- `preconditions` có ba phần: `passed`, `rules` (danh sách phẳng từng rule, có cờ `requiresInput`), và `tree` (cây gốc để UI hiển thị nhóm `all`/`any`).
- Precondition được đánh giá ở chế độ `preview` với payload rỗng. Số lần đã dùng cho `cycleLimit` đếm từ audit đọc không khóa.

**Các file thay đổi:**
- `workflow-engine.ts`: thêm hai method. Phần đánh giá precondition và kiểm tra `cycleLimit` trong `checkTransition` được tách thành helper dùng chung cho `transition`, system task và preview, hành vi của `transition` không đổi.
- `system-tasks.ts` và `available.ts` (mới): kiểu kết quả, cùng `ruleChecks` để làm phẳng cây kết quả precondition.
- `test/engine/helpers.ts` (mới): phần setup test dùng chung. `actions.test.ts` đã chuyển sang dùng file này; `transition.test.ts` mình để nguyên.
- `system-tasks.test.ts` (mới): phủ case 2 và 3, các lý do skip, lỗi trên một claim, và bản in-memory của case 29 (hai lượt chạy cùng lúc, mỗi claim đóng đúng một lần).
- `available.test.ts` (mới): phủ `requiresInput`, rule lỗi trên field ngoài `inputs` làm khóa nút, `cycleLimit` giảm dần, state terminal, và xác nhận hàm không ghi gì.

**Ba lựa chọn DESIGN chưa ghi rõ, bạn xem có ổn không:**
- Transition được coi là "có role `system`" khi `roles` của nó chứa role của người gọi, thay vì so với chuỗi `system` cố định. Với config hiện tại hai cách cho kết quả như nhau, nhưng nếu `runSystemTasks.roles` có thêm role khác thì role đó sẽ tự chạy các transition của mình.
- Không truyền `userId` thì `allowedForCurrentUser` là `false`.
- Mình thêm field `enabled`, chỉ `true` khi user có quyền, precondition đạt và `cycleLimit` còn lượt, để UI không phải tự ghép ba điều kiện này.

## 🧑 User

2 và 3 OK, nhớ ghi enabled vào 6.3.

Điểm 1 sửa lại: chọn transition theo roles chứa 'system' (đặt thành hằng), không theo role người gọi. Người gọi vẫn check bằng actions.runSystemTasks.roles. Để như bây giờ thì chỉ cần thêm team_lead vào runSystemTasks.roles là team lead gọi job sẽ tự chạy verify_documents trên mọi claim. Thêm test: config có runSystemTasks.roles: ['system', 'team_lead'], team lead gọi thì chỉ chạy transition của system.

## 🤖 Assistant

Mình sẽ đổi cách chọn transition sang hằng `SYSTEM_ROLE`, cho `setup` trong test nhận config tùy chỉnh, thêm test, rồi cập nhật DESIGN 6.2 và 6.3.

## 🤖 Assistant

Giờ cập nhật DESIGN.

## 🤖 Assistant

`runSystemTasks` giờ chọn transition theo hằng `SYSTEM_ROLE = 'system'` chứ không theo role người gọi nữa. Người gọi vẫn được kiểm tra bằng `actions.runSystemTasks.roles`. Toàn bộ 200 test pass, kể cả test mới, và `tsc` không báo lỗi.

- **Engine:** hằng `SYSTEM_ROLE` nằm trong `engine/system-tasks.ts` và được export ra ngoài. Vòng quét trong `runSystemTasks` giờ lọc theo `transition.roles.includes(SYSTEM_ROLE)`. Entry audit vẫn ghi `triggeredBy` là người thực sự gọi job.
- **Test mới** trong `system-tasks.test.ts`:
  - Config đặt `runSystemTasks.roles: ['system', 'team_lead']`, rồi `u-lead-1` gọi job.
  - Kết quả: chỉ `close_rejected` chạy. Claim ở `SUBMITTED` và claim ở `DOCUMENTS_VERIFIED` giữ nguyên `version` 1.
  - Claim ở `DOCUMENTS_VERIFIED` đã có sẵn `assessorId` hợp lệ. Nếu vẫn lọc theo role người gọi thì `start_assessment` (transition của team lead) sẽ chạy trên claim này và test fail.
  - Mình chưa thực sự chạy test này trên code cũ để thấy nó fail; đây là suy luận từ cách dựng dữ liệu.
  - Để chạy được với config tùy chỉnh, `setup()` trong `helpers.ts` nhận thêm tùy chọn `config`.
- **DESIGN.md:**
  - 6.2 ghi rằng transition được chọn theo hằng `SYSTEM_ROLE`. Thêm role vào `actions.runSystemTasks.roles` chỉ cho role đó quyền kích hoạt job, không làm job chạy transition của role đó.
  - 6.3 thêm `enabled`, tức là `allowedForCurrentUser`, precondition đạt và `cycleLimit` còn lượt. Cũng ghi luôn rằng không truyền `userId` thì `allowedForCurrentUser` là `false`.

Một chỗ nhỏ trong ví dụ của bạn: `verify_documents` là transition của `document_clerk`, không phải của team lead. Vì vậy test dùng `start_assessment` để kiểm tra lỗi này. Mình vẫn seed thêm một claim ở `SUBMITTED` để chắc chắn `verify_documents` cũng không chạy.
