# Evaluate function precondition
_Tạo lúc 2026-10-22 17:57_

## 🧑 User

tiếp theo làm rule precondition theo 4.3. Trước khi code, đề xuất interface hàm evaluate và context truyền vào. Chưa code.

## 🤖 Assistant

Mình sẽ đọc section 4.3 trong `DESIGN.md` cùng schema config hiện có để đề xuất cho khớp.

## 🤖 Assistant

Mình đề xuất làm một module `rules` thuần: hàm đánh giá đồng bộ, không đụng store, mọi dữ liệu cần thiết đi vào qua một context dựng sẵn. Đề xuất này dựa trên section 4.3, các bước 6.1 và 6.3 trong `DESIGN.md`, cùng `schema.ts`/`loader.ts` hiện có. Chưa viết code.

## 1. Context truyền vào

```ts
export interface EvaluationContext {
  /** View phẳng: field lõi + data của bản nháp (đã merge payload, bước 6 trong 6.1). */
  view: Readonly<Record<string, unknown>>;
  /** Payload của chính request này; chỉ providedInRequest đọc. {} khi preview (6.3). */
  payload: Readonly<Record<string, unknown>>;
  /** workflow.settings, dùng để resolve "$settings.<key>". */
  settings: Readonly<Record<string, unknown>>;
  /** Tra user cho userHasRole; dựng 1 lần từ users.json. */
  findUser(id: string): UserConfig | undefined;
  /** Lấy từ Clock một lần cho mỗi request, để mọi rule thấy cùng một thời điểm. */
  now: Date;
}
```

Lý do chọn như vậy:

- **`view` truyền sẵn, không truyền `Claim`**: kiểu `Claim` (5.1) chưa có. Bước transition sẽ tự dựng view bằng `{ ...claim.data, ...coreFields }`; tên field không bị trùng vì loader đã chặn. Nhờ vậy module rule không phụ thuộc vào mô hình dữ liệu.
- **Tách `payload` khỏi `view`**: `providedInRequest` phải biết field có trong request này hay không, chứ không quan tâm giá trị cũ còn trên claim (trường hợp vòng PENDING_INFO thứ 2).
- **`findUser` thay cho cả mảng users**: test dễ mock, và rule không phải biết cấu trúc của `users.json`.
- **`now: Date` thay cho Clock**: hàm vẫn thuần và chạy đồng bộ, test `daysElapsed` chỉ cần truyền một ngày cố định.

## 2. Hàm evaluate

```ts
export function evaluatePreconditions(
  condition: Condition | undefined,
  ctx: EvaluationContext,
  registry: RuleRegistry = defaultRules,
): EvaluationResult;

export interface EvaluationResult {
  passed: boolean;
  /** Danh sách phẳng các rule lỗi, dùng cho PRECONDITION_FAILED { errors }. */
  failures: RuleFailure[];
  /** Cây kết quả đầy đủ, dùng cho getAvailableTransitions (6.3). null nếu không có precondition. */
  tree: ConditionResult | null;
}

export interface RuleFailure {
  rule: string;
  field?: string;
  path: string;      // "all[0].any[1]", để UI nhóm lỗi theo nhánh
  message: string;   // message trong config nếu có, không thì message mặc định kèm giá trị thực tế
}

export type ConditionResult =
  | { kind: 'rule'; rule: string; field?: string; path: string; passed: boolean; message: string }
  | { kind: 'all' | 'any'; path: string; passed: boolean; children: ConditionResult[] }
  | { kind: 'not'; path: string; passed: boolean; child: ConditionResult };
```

Ngữ nghĩa của từng nút:

- **`all`** đánh giá hết mọi nhánh, không dừng sớm, và trả về **tất cả** rule lỗi.
- **`any`** cũng đánh giá hết mọi nhánh để cây cho UI luôn đầy đủ. Nếu có ít nhất một nhánh đúng thì `failures` rỗng; nếu không, `failures` gộp lỗi của từng nhánh, phân biệt bằng `path`.
- **`not`** sai khi nhánh con đúng, với message `Condition must not hold: <message của nhánh con>`.
- **`condition === undefined`** trả về `{ passed: true, failures: [], tree: null }`.
- **Lỗi dữ liệu không bao giờ được ném ra.** Field thiếu, sai kiểu (ví dụ `containsAll` gặp giá trị không phải mảng), hay ngày không hợp lệ đều thành một failure có message rõ ràng. Riêng lỗi config (rule chưa đăng ký, params sai) đã bị chặn lúc load, nên nếu vẫn gặp lúc chạy thì ném lỗi, vì đó là lỗi lập trình.

## 3. Registry và định nghĩa rule

```ts
export interface RuleDefinition<P = unknown> {
  name: string;
  /** Validate params riêng của rule (field, ref, values, role, days...) khi load config. */
  params: z.ZodType<P>;
  evaluate(params: P, ctx: RuleContext): RuleOutcome;
}

export interface RuleOutcome {
  passed: boolean;
  /** Khi sai là message lỗi; khi đúng là mô tả ngắn (dùng cho `not` và hiển thị trên UI). */
  message: string;
}

export interface RuleContext extends EvaluationContext {
  get(path: string): unknown;           // đọc view theo dot path, ví dụ "paymentRequest.id"
  resolveRef(ref: string): unknown;     // "$settings.x" lấy từ settings, còn lại đọc field trên view
  resolveValue(v: unknown): unknown;    // "$settings.x" lấy từ settings, còn lại dùng nguyên giá trị
}

export type RuleRegistry = ReadonlyMap<string, RuleDefinition<any>>;
```

Params của 7 rule built-in, đúng theo config hiện tại:

| rule | params | đọc từ |
|---|---|---|
| `notEmpty` | `field` | `get(field)` |
| `providedInRequest` | `field` | `payload[field]` (chỉ field ở cấp trên cùng) |
| `containsAll` | `field`, đúng một trong hai `values` / `ref` | `get(field)`, `resolveRef(ref)` |
| `lte` | `field`, `ref` | cả hai phải là số |
| `eq` | `field`, `value` | so sánh `===` (chỉ giá trị nguyên thủy) |
| `daysElapsed` | `field`, `days` (số hoặc `$settings.x`) | `now - get(field)`, làm tròn xuống theo ngày |
| `userHasRole` | `field`, `role` | `findUser(get(field))?.role === role` |

Mỗi rule nhận `message` tùy biến và dùng nó thay cho message mặc định khi sai.

## 4. Tích hợp với loader

`validateConfig(raw, { rules = defaultRules })` sẽ dùng `walkRules` có sẵn để kiểm tra từng rule trong config:

- tên rule đã đăng ký chưa;
- params có đúng schema của rule đó không (đây chính là chỗ comment trong `schema.ts` hứa "validated by the rule registry");
- mọi `$settings.<key>` có tồn tại trong `settings` không (bổ sung vào danh sách 4.6);
- `role` trong `userHasRole` có nằm trong `roles` không.

Lúc chạy, engine diễn giải trực tiếp cây `Condition` thô và parse params mỗi lần đánh giá. Cách này rẻ và đơn giản. Phương án biên dịch cây ngay lúc load thì nhanh hơn, nhưng ở quy mô này không đáng thêm độ phức tạp.

## 5. Bố cục file

`packages/engine/src/rules/`: `types.ts`, `path.ts` (đọc theo dot path), `builtins.ts`, `registry.ts`, `evaluate.ts`, `index.ts`. Test đặt ở `test/rules.test.ts`.

## Ba điểm cần bạn chốt

1. **`providedInRequest` với giá trị rỗng.** Mình đề xuất coi `""`, `"   "`, `null` và `[]` là **chưa gửi**. Lý do: `rejectionReason: ""` mà vẫn qua được thì gần như chắc chắn là lỗi. Cách còn lại là chỉ kiểm tra key có trong payload hay không.
2. **Preview ở 6.3.** Mình đề xuất truyền `payload = {}`, khi đó `providedInRequest` báo sai với message `... must be provided in this request`. Thông tin này đúng, và giữ logic đúng/sai đơn giản. Cách còn lại là thêm trạng thái thứ ba `needs_input`, nhưng như vậy logic `all`/`any`/`not` sẽ phức tạp hơn.
3. **Message tùy biến cho `not`.** Schema hiện tại (`strictObject({ not })`) không cho khai báo `message` trên nút này. Mình đề xuất giữ nguyên vì config chính không dùng `not`, và dùng message mặc định như ở mục 2.

Nếu bạn đồng ý với các đề xuất trên (hoặc chỉnh lại), mình sẽ bắt đầu code kèm test.

## 🧑 User

Interface ổn:
1. Đồng ý coi rỗng là chưa gửi. Ghi lại thành giả định ở mục 12.
2. Không đồng ý. Preview mà providedInRequest luôn sai thì nút reject và request_info lúc nào cũng hiện bị khóa, trong khi user chỉ cần điền form là dùng được. Thêm mode: 'preview': khi preview, rule này pass kèm requiresInput: true để UI đánh dấu field bắt buộc. Vẫn giữ logic đúng/sai.
3. Đồng ý, giữ nguyên.
Viết test trước, chưa cài đặt. Viết xong thì dừng để tôi duyệt.

## 🤖 Assistant

Mình sẽ xem mục 12 trong `DESIGN.md`, test hiện có và cấu hình test runner để viết test cùng phong cách.

## 🤖 Assistant

Mình sẽ ghi giả định vào mục 12, rồi viết `test/rules.test.ts` cho evaluator và bổ sung vào `config.test.ts` các test kiểm tra rule lúc load config.

## 🤖 Assistant

Bây giờ thêm các test kiểm tra rule lúc load config vào `config.test.ts`.

## 🤖 Assistant

Chạy thử để xác nhận test đang đỏ vì chưa có code, chứ không phải vì lỗi cú pháp.

## 🤖 Assistant

Test đã viết xong và đang đỏ đúng như mong đợi: `test/rules.test.ts` lỗi vì chưa có module `../src/rules`, và 4 test mới trong `config.test.ts` lỗi vì loader chưa kiểm tra rule. 14 test cũ vẫn xanh. Mình dừng ở đây để bạn duyệt.

**Đã làm:**
- **`DESIGN.md` mục 12:** thêm giả định về giá trị rỗng. `undefined`, `null`, chuỗi rỗng hoặc chỉ có khoảng trắng, và mảng rỗng được coi là chưa có. `0` và `false` vẫn là giá trị hợp lệ. Giả định này áp dụng chung cho `notEmpty` và `providedInRequest`.
- **`test/rules.test.ts`** (file mới), chia làm ba nhóm:
  - **`all`, `any`, `not`:** gom hết lỗi, `path` trỏ đúng tới rule lỗi (ví dụ `all[0].any[1]`), `message` tùy biến thay được message mặc định, và rule chưa đăng ký thì ném lỗi.
  - **Từng rule trong 7 rule:** trường hợp đúng, trường hợp sai kèm message, sai kiểu dữ liệu, thiếu field, dot path, tham chiếu `$settings` và các trường hợp biên. Ví dụ, `daysElapsed` chỉ đếm số ngày trọn vẹn và lấy thời điểm từ `ctx.now`.
  - **Preview:** `providedInRequest` trả về đúng kèm `requiresInput: true`, các rule khác vẫn đánh giá như thường. Khi không truyền `mode` thì mặc định là `execute`.
- **`test/config.test.ts`** thêm 4 case kiểm tra lúc load: tên rule chưa đăng ký, params sai schema (`containsAll` phải có đúng một trong `values` hoặc `ref`), `$settings.<key>` không tồn tại, và `userHasRole` dùng role không có trong `roles`.

So với interface đã chốt, `EvaluationContext` có thêm `mode?: 'execute' | 'preview'`, và nút rule trong cây kết quả có thêm `requiresInput?: true`.

**Cần bạn xem:**

1. **Preview vẫn khóa nút trong hai trường hợp.** Lý do bạn đưa ra cho `providedInRequest` cũng đúng với `notEmpty` và `containsAll` khi field nằm trong `inputs`:
   - Lúc preview, claim chưa có `assessmentReport`, nên `approve` và `reject` vẫn bị khóa dù user chỉ cần điền form. Test "keeps evaluating other rules normally" đang khẳng định đúng hành vi này.
   - Tương tự, `verify_documents` bị khóa nếu lúc tạo claim chưa đủ giấy tờ.

   Hướng sửa mình đề xuất: khi preview, mọi rule có `field` nằm trong `inputs` của transition đều trả về đúng kèm `requiresInput`. Để làm vậy, context cần biết danh sách `inputs`. Bạn chọn giữ như hiện tại hay mở rộng theo hướng này?
2. **Hai message mặc định khác ví dụ trong bảng 4.3.** Câu trong bảng mang từ ngữ nghiệp vụ, còn message mặc định của engine phải dùng chung cho mọi field:

   | rule | Test đang chờ | Ví dụ trong bảng 4.3 |
   |---|---|---|
   | `daysElapsed` | `Only 12 of 30 days elapsed since stateEnteredAt` | `Appeal period not expired: ...` |
   | `userHasRole` | `assessorId u-finance-1 has role finance, expected assessor` | `... is not an assessor` |

   `message` tùy biến là chuỗi cố định nên không chèn được số ngày. Mình đề xuất sửa lại ví dụ trong bảng cho khớp.
3. **Mục 6.3 chưa nhắc tới chế độ preview và `requiresInput`.** Mình có thể bổ sung khi bạn chốt điểm 1.

## 🧑 User

Test ổn, sửa 3 chỗ:
1. Preview vẫn khóa sai: reject fail vì thiếu assessmentReport, trong khi đó là input, user sẽ điền trong form. Truyền inputs vào ctx; khi preview, rule nào đọc field thuộc inputs mà chưa thỏa thì pass kèm requiresInput. Field lõi vẫn eval bình thường.
2. "Appeal period not expired…" là message nghiệp vụ, chuyển thành custom message trong config close_rejected. Message của userHasRole giữ bản hiện tại, sửa ví dụ trong DESIGN cho khớp.
3. Thêm case notEmpty({}) là rỗng. Test "defaults to execute mode" đang trùng với test ở dòng 168, đổi sang kiểm tra không có requiresInput.
Chỉ sửa test và config.

## 🤖 Assistant

Mình sẽ sửa `rules.test.ts`, thêm custom message vào `close_rejected` trong config, và cập nhật ví dụ trong bảng 4.3.

## 🤖 Assistant

Giờ sửa test: message `close_rejected`, case `{}`, test mode mặc định, và viết lại nhóm preview.

## 🤖 Assistant

Giờ viết lại nhóm test preview.

## 🤖 Assistant

Đã sửa cả 3 chỗ, chưa viết code cài đặt. Kết quả chạy test giữ nguyên như lần trước: `test/rules.test.ts` vẫn đỏ vì chưa có module `../src/rules`, 4 test kiểm tra rule lúc load vẫn đỏ vì loader chưa làm phần này, và 14 test cũ vẫn xanh. Như vậy config sau khi thêm `message` vẫn load bình thường.

**1. Preview dùng `inputs`**
- Context trong test có thêm `inputs`. Helper `preview(transitionId, view)` lấy `inputs` từ chính transition trong config thật.
- Nhóm test preview giờ kiểm tra các trường hợp sau:
  - Rule đọc field thuộc `inputs` mà chưa thỏa thì vẫn đúng, kèm `requiresInput: true`. Ví dụ: `reject` khi claim chưa có `assessmentReport` không còn bị khóa.
  - Rule đọc field thuộc `inputs` mà đã thỏa thì đúng, không có `requiresInput`.
  - Khi gắn `requiresInput`, message lỗi vẫn được giữ để UI hiển thị còn thiếu gì, ví dụ `Missing required documents: invoice, id_proof`.
  - Field lõi vẫn được đánh giá bình thường: `approve` vượt hạn mức vẫn bị khóa bởi `lte`.
  - Field trong `data` nhưng không thuộc `inputs` của transition cũng vẫn đánh giá bình thường: `initiate_payment` khi chưa có `paymentRequest` vẫn bị khóa.
  - Ở mode `execute`, engine bỏ qua `inputs`.

**2. Message**
- `close_rejected` trong `claims-workflow.json` có thêm `"message": "Appeal period has not expired"` cho rule `daysElapsed`. Test của nhánh `any` đã đổi theo message này. Test message mặc định của `daysElapsed` vẫn giữ, nhưng dùng một rule viết riêng trong test thay vì lấy từ config.
- `DESIGN.md` mục 4.3: đã sửa ví dụ của `daysElapsed` và `userHasRole` theo message mặc định, và thêm một câu nói rằng message nghiệp vụ được đặt trong config.

**3. Hai chỗ trong test**
- Thêm `{}` vào danh sách giá trị rỗng của `notEmpty`, và để giữ ngữ nghĩa rỗng thống nhất, thêm cả vào `providedInRequest`.
- Test "defaults to execute mode" giờ truyền `inputs` nhưng bỏ trống `mode`, rồi kiểm tra cây kết quả không có `requiresInput`.

Ngoài các file bạn cho phép, mình có sửa thêm `DESIGN.md` ở hai chỗ:
- mục 4.3, vì bạn yêu cầu sửa ví dụ;
- mục 12, thêm "object rỗng" vào giả định về giá trị rỗng cho khớp với test mới.

Mục 6.3 vẫn chưa mô tả chế độ preview và `requiresInput`; mình sẽ bổ sung khi bạn muốn.

## 🧑 User

sửa lại chỗ: custom message "Appeal period has not expired" làm mất số ngày, user không biết còn phải đợi bao lâu. Bỏ custom message trong close_rejected, dùng message mặc định, và xóa câu ví dụ đó ở DESIGN 4.3. Sửa xong thì cài đặt cho pass test, không đổi test. Thấy test sai thì báo tôi trước.

## 🤖 Assistant

Mình sẽ bỏ custom message trong config và câu ví dụ trong `DESIGN.md` trước, rồi cài đặt.

Có một test sẽ sai sau khi bỏ message: test "any: reports the failure of each branch when none passes" (`rules.test.ts`) đang chờ `'Appeal period has not expired'`. Mình giữ nguyên test đó và báo lại ở cuối.

## 🤖 Assistant

Giờ viết module `rules`. Mình xem nhanh `tsconfig.base.json` để biết các cờ strict.

## 🤖 Assistant

Giờ nối registry vào loader.

## 🤖 Assistant

Thêm export vào `src/index.ts`, rồi chạy test và typecheck.

## 🤖 Assistant

Typecheck sạch, và repo không dùng ESLint, nên mình bỏ dòng `eslint-disable` thừa.

## 🤖 Assistant

Phần cài đặt đã xong: 72/73 test pass và typecheck sạch. Test duy nhất còn đỏ là test sai sau khi bỏ custom message, nên mình chưa sửa và chờ bạn duyệt.

**Test cần sửa:** case "any: reports the failure of each branch when none passes" trong `rules.test.ts` (khoảng dòng 92) vẫn chờ message cũ `'Appeal period has not expired'`. Giờ `close_rejected` dùng message mặc định, nên kết quả thực tế là `'Only 12 of 30 days elapsed since stateEnteredAt'`, đúng như bạn muốn. Mình đề xuất đổi dòng đó thành:

```ts
{ rule: 'daysElapsed', field: 'stateEnteredAt', path: 'any[0]', message: 'Only 12 of 30 days elapsed since stateEnteredAt' },
```

Bạn đồng ý thì mình sửa.

**Config và DESIGN:** đã bỏ `message` khỏi rule `daysElapsed` trong `close_rejected`, và xóa câu ví dụ đó ở mục 4.3 của `DESIGN.md`.

**Phần cài đặt** nằm trong thư mục mới `packages/engine/src/rules/`:
- **`types.ts`:** context, kết quả và registry đúng như interface đã chốt, có thêm `inputs` và `mode`.
- **`values.ts`:** đọc field theo dot path, kiểm tra giá trị rỗng theo giả định ở mục 12 (gồm cả object rỗng), và format giá trị cho message.
- **`builtins.ts`:** 7 rule. Mỗi rule có schema params riêng dạng strict, nên gõ sai tên param sẽ bị báo lỗi lúc load. Riêng `userHasRole` có thêm bước kiểm tra role phải nằm trong danh sách `roles`.
- **`evaluate.ts`:** hàm `evaluatePreconditions`, đánh giá toàn bộ cây rồi gom lỗi từ đó.
  - Message tùy biến chỉ thay message lỗi, không thay mô tả khi rule đúng.
  - Ở preview, rule chưa thỏa trên field thuộc `inputs` sẽ pass kèm `requiresInput: true`. Engine xét theo đoạn đầu của dot path, ví dụ `paymentRequest.id` xét `paymentRequest`.

`validateConfig` và `loadConfig` giờ nhận thêm tham số tùy chọn `{ rules }`; mặc định dùng 7 rule built-in. Với mỗi rule trong precondition, loader kiểm tra:
- tên rule đã đăng ký chưa;
- params có đúng schema của rule đó không;
- mọi tham chiếu `$settings.<key>` có trỏ tới key tồn tại không;
- các kiểm tra riêng của rule, như `role` của `userHasRole`.

`src/index.ts` có export thêm module `rules`.

Có một hành vi không test nào kiểm tra: khi `not` bọc một nhóm `all`/`any` mà bị sai, message chỉ là `Condition must not hold`, không kèm chi tiết. Config hiện tại không dùng `not`, nên mình để đơn giản.

## 🧑 User

72/73 test pass. phần này tôi đã tự sửa. bạn kiểm tra lại

## 🤖 Assistant

Phần bạn sửa đã đúng: giờ cả 73 test đều pass, typecheck sạch và `pnpm build` cũng chạy thành công.

Dòng 92 trong `rules.test.ts` giờ chờ `'Only 12 of 30 days elapsed since stateEnteredAt'`, khớp với message mặc định mà `close_rejected` đang dùng. Trong file không còn chỗ nào nhắc tới `Appeal period`. `rules.test.ts` chưa được git theo dõi nên không có diff để so; mình chỉ kiểm tra được qua kết quả chạy test và nội dung hiện tại của file.

Mục 6.3 trong `DESIGN.md` vẫn chưa mô tả chế độ preview và `requiresInput`. Đây là việc còn lại của phần rule precondition, bạn muốn thì mình bổ sung.

## 🧑 User

bổ sung

## 🤖 Assistant

Mình đã bổ sung chế độ preview vào mục 6.3 của `DESIGN.md`. Ở đó, `getAvailableTransitions` đánh giá precondition ở chế độ `preview`, trên claim hiện tại và với payload rỗng. Nội dung mới mô tả bốn quy tắc:

- **Rule đọc field nằm trong `inputs` mà chưa thỏa:** vẫn được tính là pass, kèm cờ `requiresInput: true`, và giữ nguyên message lỗi. Nhờ vậy nút không bị khóa, còn UI dùng cờ này để đánh dấu field bắt buộc trong form. Field dạng dot path được xét theo phần đầu, ví dụ `paymentRequest.id` được xét theo `paymentRequest`.
- **Rule đã thỏa:** pass bình thường, không có `requiresInput`.
- **Field lõi, và field trong `data` không thuộc `inputs`:** vẫn đánh giá bình thường, nên lỗi thật vẫn khóa nút. Ví dụ `approve` khi `amount` vượt `policyLimit`, hoặc `initiate_payment` khi chưa có `paymentRequest`.
- **`providedInRequest`:** luôn rơi vào trường hợp đầu, vì payload lúc preview rỗng.

Mục này cũng nói rõ rằng khi transition thực sự chạy (bước 6 của mục 6.1), engine dùng chế độ `execute` và bỏ qua `inputs`, nên mọi rule chưa thỏa đều là lỗi. Preview chỉ là gợi ý cho UI; request thật vẫn bị kiểm tra đầy đủ.

Lần này chỉ sửa tài liệu, không đụng tới code hay test.
