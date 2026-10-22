# WorkflowEngine transition proposal
_Tạo lúc 2026-10-22 19:33_

## 🧑 User

WorkflowEngine.transition theo 6.1. Chưa có Clock, nên thêm interface Clock và một FakeClock cho test. Trước khi code, đề xuất cách tổ chức 10 bước của 6.1, nhất là ở nhánh bị từ chối: append TRANSITION_REJECTED rồi return kết quả lỗi từ fn, sau đó mới throw ở ngoài withClaim, như contract đã chốt. Chưa code.

## 🤖 Assistant

I'll read spec section 6.1 and the current store/model/errors code before proposing anything.

## 🤖 Assistant

Now I'll check what config, rules, and the side-effect registry already export, so the proposal uses real names.

## 🤖 Assistant

Đây là đề xuất cho `WorkflowEngine.transition`, chưa code. Phần chính: các bước 2b–7 trả về một giá trị mô tả lỗi thay vì throw. Khi bị từ chối, `fn` append `TRANSITION_REJECTED` rồi return bình thường để store commit, và chỉ throw `WorkflowError` sau khi `withClaim` đã trả về. Cách này khớp với contract trong `store/types.ts` là "nếu `fn` throw thì audit đã append bị bỏ".

Còn một chỗ trống: engine chưa có registry side effect (`notify`, `setField`, ...) nên bước 9 chưa có gì để chạy. Mình hỏi bạn ở cuối.

## Hình dạng tổng thể

```ts
type Outcome<T> =
  | { ok: true; value: T }
  | { ok: false; error: WorkflowError; transitionId?: string };

async transition(claimId, userId, req): Promise<TransitionResult> {
  const user = this.requireUser(userId);                                   // 1: throw UNKNOWN_USER, không chạm store
  const outcome = await this.store.withClaim(claimId, async (tx) => {      // 2: CLAIM_NOT_FOUND / CLAIM_BUSY do store throw
    const now = this.clock.now();
    const checked = await this.check(tx, user, req, now);                  // 2b–7
    if (!checked.ok) {
      await tx.appendAudit(rejectedEntry(tx.claim, user, req, checked, now));
      return checked;                                                      // return bình thường → commit audit
    }
    return { ok: true, value: await this.apply(tx, user, req, checked.value, now) };  // 8–10
  });
  if (!outcome.ok) throw outcome.error;                                    // throw sau khi đã commit
  return outcome.value;
}
```

`check` là một chuỗi guard. Mỗi guard return `reject(...)` ngay khi gặp lỗi đầu tiên:

```ts
private async check(tx, user, req, now): Promise<Outcome<{ transition; draft }>> {
  const claim = tx.claim;
  if (req.expectedVersion !== undefined && req.expectedVersion !== claim.version)
    return reject(staleClaim(claim, req.expectedVersion));                      // 2b
  const transition = this.transitions.get(key(claim.status, req.to));
  if (!transition) return reject(this.invalidTransition(claim.status, req.to)); // 3
  if (!transition.roles.includes(user.role))
    return reject(unauthorizedRole(transition, user), transition.id);           // 4
  const payloadError = checkPayload(transition, req.payload);
  if (payloadError) return reject(payloadError, transition.id);                 // 5
  const draft = mergeDraft(claim, req.payload);
  const evaluation = evaluatePreconditions(transition.preconditions, this.evalContext(draft, req, transition, now));
  if (!evaluation.passed)
    return reject(preconditionFailed(evaluation.failures), transition.id);      // 6
  if (transition.cycleLimit &&
      (await tx.countSuccessfulTransitions(transition.id)) >= transition.cycleLimit.max)
    return reject(cycleLimitExceeded(transition), transition.id);               // 7
  return { ok: true, value: { transition, draft } };
}
```

**Vì sao return thay vì throw rồi catch bên trong `fn`:** nếu bọc `fn` bằng `try/catch` để bắt `isWorkflowError`, mọi `WorkflowError` sinh ra ngoài dự kiến cũng sẽ thành audit `TRANSITION_REJECTED` và được commit. Trả về giá trị thì chỉ các bước 2b–7 mới được audit, và điều đó thấy được ngay trong kiểu `Outcome`. Mọi thứ khác throw trong `fn` đều là lỗi hạ tầng: store rollback, không ghi audit, API trả 500. Ví dụ là `evaluatePreconditions` throw do rule chưa đăng ký, hoặc lỗi của store.

## Chi tiết từng bước

1. **User:** tra trong map `users` dựng sẵn ở constructor. Kiểm tra này đứng trước `withClaim`, nên khi cả user lẫn claim đều sai thì lỗi trả về là `UNKNOWN_USER`.
2. **Khóa và version:** `now` được đọc **một lần, sau khi đã có khóa**. Như vậy `timestamp` tăng cùng chiều với `seq`, và mọi chỗ dùng thời gian đều thấy cùng một giá trị: `stateEnteredAt`, `daysElapsed`, `$now` trong side effect, timestamp của audit. `STALE_CLAIM` được kiểm tra trước khi tìm transition, nên entry bị từ chối vì version không có `transitionId`.
3. **Transition:** dùng map `"from→to"`. Ba message theo đúng 6.1, cả ba đều kèm danh sách `Allowed from X: Y (role)`. `details` chứa `{ from, to, allowed: [{ transitionId, to, roles }] }`.
4. **Role:** `Transition approve requires role assessor; user u-clerk-1 has role document_clerk`.
5. **Payload:** payload phải là plain object (mặc định `{}`). Message liệt kê **tất cả** field nằm ngoài `inputs`. Field lõi tự động bị từ chối, vì lúc load config đã kiểm tra `inputs` không chứa field lõi.
6. **Precondition:** `draft` là `structuredClone(tx.claim)` và `data` của nó được merge với clone của payload. Với `documents`, payload thay thế cả mảng, đúng như mục 4.4. View đưa vào rule là `{ ...draft.data, ...coreFields(draft) }`. Gọi với `mode: 'execute'`, `payload` là payload của request, `now` lấy từ bước 2. Message là các failure nối bằng `; `, còn `details.failures` giữ nguyên `RuleFailure[]`.
7. **Cycle limit:** đếm dưới khóa. `TRANSITION_REJECTED` có `transitionId` nhưng không bị đếm vì store chỉ lọc `type === 'TRANSITION'`, đúng yêu cầu của case 20.
8. **Áp transition:** `draft.status = to`, `draft.stateEnteredAt = now.toISOString()`. Dựng entry `TRANSITION` gồm: `reason` lấy theo thứ tự `reasonField` (bỏ qua nếu rỗng theo `isEmpty`) → `notes` → `description`; `data = payload`. Entry chỉ được dựng ở bước này, chưa append.
9. **Side effect:** chạy tuần tự. Mỗi handler nhận một bản freeze của `draft` hiện tại, nên thấy được patch của các handler trước, và trả về `{ result, dataPatch? }`. Engine bọc mỗi handler trong `try/catch`. Nếu handler lỗi, patch bị bỏ, entry ghi `failed` kèm `error`, và các handler sau vẫn chạy. `dataPatch` không phải object, hoặc có key trùng field lõi, cũng bị coi là `failed`. Không có lỗi nào từ handler lọt ra khỏi `fn`.
10. **Commit:** `tx.saveClaim(draft)`, rồi append `TRANSITION` và lần lượt các `SIDE_EFFECT`. Kết quả trả về là `{ claim: { ...draft, version: tx.claim.version + 1 }, audit }`, trong đó `audit` là các entry đã lưu do `appendAudit` trả về. Không đọc lại bằng `getClaim` sau commit, vì lúc đó không còn khóa và có thể thấy state của request sau.

**Entry `TRANSITION_REJECTED`:**
- `fromState = claim.status`, `toState = req.to` (kể cả khi đó là state không tồn tại).
- `transitionId` chỉ có từ bước 4 trở đi.
- `reason = error.message`, `notes = req.notes`, `triggeredBy` lấy từ user.
- `data = { code, errors, payload }`. Với `PRECONDITION_FAILED`, `errors` là danh sách `RuleFailure`; các lỗi khác là `[{ message }]`.
- Nhánh này không gọi `saveClaim`, nên claim và `version` giữ nguyên.

Mục 5.2 của DESIGN ghi `data` là `{ code, errors }`, nhưng 6.1 và `model/types.ts` có thêm `payload`. Mình theo 6.1.

## Clock

Đặt trong `src/clock.ts`, export ra ngoài package:

```ts
export interface Clock { now(): Date }
export const systemClock: Clock = { now: () => new Date() };

export class FakeClock implements Clock {
  constructor(start: Date | string = '2026-01-01T00:00:00.000Z') {}
  now(): Date {}                                        // mỗi lần trả một Date mới, caller sửa không ảnh hưởng clock
  set(at: Date | string): void {}
  advance(by: { days?: number; hours?: number; ms?: number }): void {}
}
```

Mình đề xuất để `FakeClock` trong `src/` chứ không phải `test/`, vì API khi bật `DEMO_MODE` cần đúng clock này cho `/dev/clock/advance`. Nhờ đó test case 3 và bản demo dùng chung một cài đặt.

## File và test

Các file sẽ tạo hoặc sửa:
- **`src/clock.ts`**: interface `Clock`, `systemClock`, `FakeClock`.
- **`src/errors.ts`**: thêm các factory `unknownUser`, `staleClaim`, `invalidTransition`, `unauthorizedRole`, `invalidPayload`, `preconditionFailed`, `cycleLimitExceeded`, viết giống `claimNotFound` hiện có.
- **`src/engine/transition.ts`**: các helper thuần: `checkPayload`, `mergeDraft`, `buildView`, `resolveReason`, các hàm dựng entry.
- **`src/engine/workflow-engine.ts`**: class nhận `{ config: LoadedConfig, store, clock, rules?, sideEffects? }`.
- **`src/engine/index.ts`** và cập nhật `src/index.ts` để export.

Test đặt ở `test/engine/transition.test.ts`, chạy trên store in-memory:
- Mỗi mã từ chối, gồm cả `STALE_CLAIM`, đều ghi đúng một `TRANSITION_REJECTED` với `seq` liên tục; claim và `version` không đổi; error được throw là đúng `WorkflowError` đó.
- `UNKNOWN_USER`, `CLAIM_NOT_FOUND`, `CLAIM_BUSY` không ghi audit.
- Bị từ chối không tính vào cycle (case 20), và lần thứ 4 của `request_info` bị chặn (case 19).
- Thứ tự ưu tiên của `reason` (case 22).
- Timestamp và `stateEnteredAt` lấy đúng từ `FakeClock`.
- Rule chưa đăng ký throw bên trong `fn` thì rollback và không có audit.

## 🤖 Assistant

Đã chốt hai điểm, đề xuất ở trên giữ nguyên, chưa sửa file nào.

- **Side effect:** lượt này chỉ định nghĩa interface `SideEffectHandler` và registry, inject vào `WorkflowEngine` qua option `sideEffects`, test bằng handler giả. Bốn handler thật (`notify`, `setField`, `createPaymentRequest`, `triggerPaymentSystem`) làm ở bước sau.
- **`reason` của `SIDE_EFFECT`:** dùng `Side effect <name>`, ví dụ `Side effect notify`.

Bạn duyệt thì mình bắt đầu code.

## 🧑 User

Đồng ý tách handler thật sang bước sau, nhưng nối loader (tên, params, biến template) làm cùng lúc với 4 handler, trước createClaim/acknowledge.
reason thêm trạng thái: Side effect <name> succeeded / Side effect <name> failed: <error>, để nhìn audit là biết effect nào hỏng.
Còn lại OK, bắt đầu code.

## 🤖 Assistant

I'll start coding. First I'm reading the rest of the loader, the rule builtins, the test setup and the real config so the engine matches existing conventions.

## 🤖 Assistant

I have the conventions. Writing `Clock` and `FakeClock`, the shared utilities, and the new error factories first.

## 🤖 Assistant

Now the side-effect handler interface (no real handlers yet) and the transition helpers.

## 🤖 Assistant

Now the engine itself: the 10 steps, with the rejection branch returning out of `withClaim` and throwing afterwards.

## 🤖 Assistant

Typechecking before writing tests.

## 🤖 Assistant

Typecheck passes. Now the tests: they run on the real `claims-workflow.json` and the in-memory store, with fake handlers registered under the four side-effect names in the config.

## 🤖 Assistant

All 140 tests pass and the typecheck is clean. One more check that the package build config compiles too.

## 🤖 Assistant

`WorkflowEngine.transition` đã chạy đủ 10 bước của 6.1, kèm `Clock`/`FakeClock` và interface side effect. Toàn bộ 140 test pass, cả `tsconfig.json` lẫn `tsconfig.build.json` đều typecheck sạch. Mình chưa commit.

Nhánh bị từ chối làm đúng như contract: bên trong `withClaim`, `fn` append `TRANSITION_REJECTED` rồi return `{ ok: false, error }` để store commit; `WorkflowError` chỉ được throw sau khi `withClaim` đã trả về.

```84:97:ai-challenge-14/packages/engine/src/engine/workflow-engine.ts
    const outcome = await this.store.withClaim(claimId, async (tx): Promise<Outcome<TransitionResult>> => {
      // Read under the lock, so timestamps follow seq order across requests on the same claim.
      const now = this.clock.now();
      const checked = await this.checkTransition(tx, user, request, now);
      if (!checked.ok) {
        // Must return, not throw: withClaim discards everything written when fn throws.
        await tx.appendAudit(rejectedEntry(tx.claim, user, request, checked, now));
        return checked;
      }
      return { ok: true, value: await this.applyTransition(tx, user, request, checked.value, now) };
    });

    if (!outcome.ok) throw outcome.error;
    return outcome.value;
```

**Các file chính:**
- **`src/engine/workflow-engine.ts`**: class engine. `checkTransition` lo các bước 2b–7 theo dạng guard trả về lỗi; `applyTransition` lo bước 8–10; `runSideEffect` lo bước 9.
- **`src/engine/transition.ts`**: các helper thuần, như dựng message `INVALID_TRANSITION` (3 trường hợp), kiểm tra payload, merge bản nháp, chọn `reason`.
- **`src/clock.ts`**: `Clock`, `systemClock`, và `FakeClock` với `set` và `advance({ days, hours, minutes, ms })`.
- **`src/side-effects/types.ts`**: `SideEffectHandler` gồm `name`, schema `params` và `run(params, ctx)` trả `{ result, dataPatch }`.
- **`src/errors.ts`**: thêm các factory cho từng mã lỗi.
- **`src/util.ts`**: chuyển `deepFreeze` ra từ `memory.ts`.

`reason` của `SIDE_EFFECT` theo đúng ý bạn: `Side effect notify succeeded` hoặc `Side effect notify failed: <error>`. Nếu `dataPatch` không phải object hoặc ghi vào field lõi, side effect đó cũng bị ghi là failed.

**Ba điểm nên biết:**
- **Kiểm tra side effect ở constructor.** Loader chưa kiểm tra side effect, nên constructor sẽ throw nếu config dùng một handler chưa đăng ký hoặc `params` sai schema. Mặc định registry đang rỗng, nên tạm thời phải luôn truyền `sideEffects` vào. Khi nối loader cùng 4 handler thật ở bước sau, loader sẽ báo lỗi đầy đủ lúc load, và registry mặc định sẽ là 4 handler đó.
- **Khi thiếu cả state lẫn transition.** Nếu claim ở state terminal và `to` cũng là state không tồn tại, message trả về là `Unknown state ...`, vì mình kiểm tra state không tồn tại trước.
- **Claim trả về không đọc lại từ store.** `claim` trong kết quả có `version = tx.claim.version + 1`, đúng contract của `saveClaim`, thay vì gọi `getClaim` sau commit (lúc đó đã mất khóa).

**Test:** `test/engine/transition.test.ts` chạy trên `claims-workflow.json` thật, store in-memory, `FakeClock` và handler giả. Các phần được kiểm tra:
- **Lỗi bị từ chối:** từng mã có audit, gồm `STALE_CLAIM`, ba message `INVALID_TRANSITION`, role, payload, precondition và cycle limit. Mỗi lần từ chối phải ghi đúng 1 entry, `seq` liên tục, claim và `version` không đổi.
- **Lỗi không ghi audit:** `UNKNOWN_USER`, `CLAIM_NOT_FOUND`, `CLAIM_BUSY`, và trường hợp rule throw bên trong làm rollback.
- **Theo DESIGN:** case 3, 12, 13, 19, 20, 22, 23, và một bản case 26 trên store in-memory.

`test/clock.test.ts` kiểm tra riêng `FakeClock`.

## 🧑 User

thực hiện 4 handler theo 4.5: notify, setField, createPaymentRequest, triggerPaymentSystem, và đặt làm registry mặc định. Nối registry vào loader: tên handler chưa đăng ký, params sai, biến template không tồn tại (4.6) đều phải báo đủ lỗi lúc load. Viết test trước.

## 🤖 Assistant

I'll start by reading the existing config tests and the unknown-rule path in the loader, so the side-effect checks follow the same pattern.

## 🤖 Assistant

Now the loader tests. They use the real config's indexes, for example `transitions[2]` is `approve` with `notify` then `createPaymentRequest`.

## 🤖 Assistant

Next, engine tests: the default registry is used when `sideEffects` is omitted, plus DESIGN test case 1 (the full happy path on the real handlers).

## 🤖 Assistant

Running the suite to confirm the new tests fail before implementing.

## 🤖 Assistant

24 new tests fail as expected. Implementing: template helpers, the four handlers, the load-time hooks on the handler interface, then the loader wiring.

## 🤖 Assistant

Now wiring the registry into the loader and making it the engine default.

## 🤖 Assistant

Bốn handler của 4.5 đã có và là registry mặc định cho cả loader lẫn engine. Loader báo đủ ba loại lỗi của 4.6 trong một lần load. Viết test trước: 24 test mới đỏ, sau khi cài đặt toàn bộ 166 test pass và typecheck sạch.

Mình sửa thêm kỳ vọng của hai test loader cũ. Cả hai test này xóa một input khỏi config, mà template `notify` đang đọc đúng input đó (`rejectionReason`, `paymentReference`). Giờ loader báo thêm lỗi biến template, đó là hành vi đúng.

**Handler** (`src/side-effects/builtins.ts`): `createBuiltinSideEffects({ log, paymentRequestId })` cho phép test thay chỗ ghi log và cách sinh id. `defaultSideEffects` là bản mặc định: ghi bằng `console.log`, id là `pr-<uuid>`.
- **`notify`**: `to` nhận `member`, `role:<role>` hoặc `user:<field>`. Log dạng `[NOTIFY → <người nhận>] <nội dung>`, audit ghi `{ to, recipients, message }`. Nếu không có ai để gửi (field rỗng, user không tồn tại, hoặc role không có user nào) thì side effect bị ghi `failed`.
- **`setField`**: nhận `{ field, value }`, trong đó `value` là JSON bất kỳ, kể cả `null`, hoặc `"$now"` lấy giờ từ Clock.
- **`createPaymentRequest`**: ghi `paymentRequest = { id, amount, createdAt }`, audit ghi `{ paymentRequestId, amount }`.
- **`triggerPaymentSystem`**: ghi `paymentInitiatedAt`. Nếu claim chưa có `paymentRequest.id` thì báo failed.

**Loader**: handler có thêm hai hook, `writes(params)` khai báo field mà nó ghi vào `data`, và `validate(params, ctx)` kiểm tra thêm lúc load. Loader chạy hai lượt:
- **Lượt 1** kiểm tra tên handler (`Unknown side effect X. Known side effects: ...`) và parse `params` theo schema của handler. Đường dẫn lỗi đi vào trong params, ví dụ `transitions[2].sideEffects[0].params.to`. Lượt này cũng gom các field mà các handler ghi.
- **Lượt 2** kiểm tra:
  - biến template;
  - `role:<role>` phải là role có trong config;
  - `user:<field>` phải là field đã biết;
  - `setField` không được ghi vào field lõi.

  Nhờ chạy sau lượt 1, template có thể đọc field do side effect của bất kỳ transition nào ghi, kể cả transition khai báo sau.

`ValidateOptions` nhận thêm `sideEffects` để dùng registry tùy chỉnh. Engine nên dùng cùng registry mà config đã được load với nó.

**Test mới:**
- `test/side-effects.test.ts`: unit test cho từng handler và phần render template.
- `test/config.test.ts`: 9 test cho side effect lúc load.
- `test/engine/transition.test.ts`: case 1 của DESIGN đi tới CLOSED với handler thật (13 entry đúng thứ tự, kiểm tra từng dòng log đã render), và một test engine dùng registry mặc định khi không truyền `sideEffects`.

**Ba quyết định mình tự chọn, bạn xem có ổn không:**
- **Field được coi là đã biết** gồm: field lõi, `inputs` của mọi transition, `inputs` của `createClaim`, field do side effect ghi, và ba field mà `acknowledge` sẽ ghi (`ACKNOWLEDGE_FIELDS` trong loader). DESIGN chỉ liệt kê field lõi, inputs của transition và field do side effect ghi. Mình thêm field của action để template có thể dùng `memberAcknowledgedAt`.
- **`setField` chặn mọi chuỗi bắt đầu bằng `$` trừ `$now`**, ví dụ `$today`, để bắt lỗi gõ nhầm lúc load. Đổi lại, config không thể ghi một chuỗi literal bắt đầu bằng `$`.
- **Biến template đúng tên nhưng lúc chạy chưa có giá trị thì render thành chuỗi rỗng** thay vì làm `notify` fail.

## 🧑 User

OK cả 3, chỉnh điểm 3: vẫn render và gửi, nhưng ghi missingVariables vào result của audit. Rỗng mà không báo thì thông báo hỏng không ai biết; còn fail thì member không nhận được gì. Thêm test.

Điểm 1: khi làm acknowledge, ghi field qua chính ACKNOWLEDGE_FIELDS, đừng hardcode lại tên. Điểm 2: ghi vào mục 12.

## 🤖 Assistant

I'll change `renderTemplate` to also report which variables rendered empty, have `notify` record them in its audit result, switch `ACKNOWLEDGE_FIELDS` to named keys, then add the assumption to DESIGN section 12.

## 🤖 Assistant

Now the tests: update the existing render test for the new return shape, and add `missingVariables` cases for `notify`, including one through the engine audit.

## 🤖 Assistant

Tests pass. Now adding the `$now` assumption to DESIGN section 12.

## 🤖 Assistant

`notify` giờ vẫn render và gửi khi có biến rỗng, và ghi `missingVariables` vào `result` của entry `SIDE_EFFECT`. Cả 169 test pass, typecheck sạch.

**Điểm 3 – biến template rỗng:**
- Thông báo vẫn gửi bình thường, `status` vẫn là `ok`.
- `result.missingVariables` liệt kê các biến render ra rỗng, mỗi biến một lần, theo thứ tự xuất hiện. Biến bị tính là rỗng khi giá trị không có, là `null`, hoặc là chuỗi `""`. `0`, `false` và mảng rỗng (`[]`) vẫn render ra nội dung nên không bị tính.
- Field này chỉ xuất hiện khi có biến rỗng, nên notify bình thường không mang thêm field nào.
- `renderTemplate` giờ trả về `{ text, missing }` thay vì một chuỗi.

Có 3 test mới:
- Hai test ở mức template: chuỗi rỗng, dot path thiếu, và biến lặp lại chỉ được ghi một lần.
- Một test `notify` có hai biến rỗng.
- Một test qua engine: sửa template của `approve` để đọc `assessorId` trong khi claim chưa có field đó. Audit vẫn ghi `Side effect notify succeeded` kèm `missingVariables: ['assessorId']`, và dòng log vẫn được in ra.

**Điểm 1 – `ACKNOWLEDGE_FIELDS`:** mình đổi hằng số này từ mảng sang object có key, để action acknowledge ghi bằng `ACKNOWLEDGE_FIELDS.acknowledged`, `.at`, `.by` thay vì dựa vào thứ tự phần tử. Loader dùng `Object.values(...)`. Doc comment của hằng số có ghi rằng action phải ghi field qua chính các tên này. Khi làm acknowledge, mình sẽ dùng nó.

**Điểm 2:** đã thêm vào mục 12 của DESIGN: chuỗi `setField` bắt đầu bằng `$` chỉ chấp nhận `$now`, và vì vậy config không ghi được chuỗi literal bắt đầu bằng `$`.

Mục 4.5 của DESIGN hiện chỉ ghi `result` của `notify` gồm người nhận và nội dung đã render, chưa nhắc tới `missingVariables`. Bạn muốn thì mình bổ sung luôn.

## 🧑 User

đồng ý

## 🤖 Assistant

Mình đã bổ sung mục 4.5 của DESIGN, chỉ sửa tài liệu, không đụng code. Có hai chỗ:

- **Đoạn mới về biến không có giá trị lúc chạy.** Đoạn này nằm ngay sau đoạn mô tả cú pháp template. Biến thiếu, `null` hoặc chuỗi rỗng được render thành rỗng. Thông báo vẫn được gửi và entry vẫn `status: ok`, nhưng `result.missingVariables` liệt kê các biến đó. Lý do cũng được ghi lại: member vẫn nhận được thông báo, còn audit cho biết thông báo nào bị thiếu nội dung.
- **Danh sách field mà template được đọc.** Câu cũ chỉ liệt kê field lõi, `inputs` của transition và field do side effect ghi, nên chưa khớp với loader. Mình thêm `inputs` của `createClaim` và ba field do `acknowledge` ghi (`memberAcknowledged`, `memberAcknowledgedAt`, `memberAcknowledgedBy`). Đây là điểm 1 bạn đã đồng ý.
