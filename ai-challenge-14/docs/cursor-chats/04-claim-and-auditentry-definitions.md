# Claim and AuditEntry definitions
_Tạo lúc 2026-10-22 19:12_

## 🧑 User

store theo 5.3. Hiện chưa có type Claim và AuditEntry. Định nghĩa theo 5.1 và 5.2 trước, kèm NewClaim và NewAuditEntry. Đề xuất ai cấp id, seq, version và timestamp. Chưa code store.

## 🤖 Assistant

Tôi sẽ đọc mục 5 trong `DESIGN.md` và cấu trúc package engine trước khi định nghĩa type.

## 🤖 Assistant

Giờ kiểm tra `schema.ts` xem đã có kiểu `StateId`/`Role` chưa.

## 🤖 Assistant

Chưa có `StateId`/`Role` (state và role đến từ config nên chỉ là `string`). Tôi sẽ đặt các type vào `src/model/` để cả engine lẫn store sau này cùng import.

## 🤖 Assistant

Tôi đã thêm các type trong `packages/engine/src/model/types.ts` và export qua `src/index.ts`; typecheck chạy qua. Phần store vẫn chưa động tới.

**Các type đã thêm**
- `Claim` và `AuditEntry` khớp field với DESIGN 5.1 và 5.2.
- `StateId` và `Role` là `string`, vì state và role đến từ config nên không làm union đóng được.
- `AuditType` được suy ra từ hằng `AUDIT_TYPES`. Store Postgres sau này có thể dùng mảng này để kiểm tra cột `type` khi đọc từ DB.
- `NewClaim = Omit<Claim, 'id' | 'version'>`
- `NewAuditEntry = Omit<AuditEntry, 'id' | 'seq' | 'claimId'>`

Bỏ `claimId` khỏi `NewAuditEntry` là điểm khác so với cách đọc thẳng 5.3. Khi `createClaim`, claim chưa có id cho tới lúc store insert, nên engine không thể điền `claimId` cho entry `CLAIM_CREATED`. Với `tx.appendAudit`, store đã biết claim nào đang bị khóa. Bắt engine truyền `claimId` vào chỉ tạo thêm chỗ để truyền sai.

**Đề xuất ai cấp giá trị nào**

| Giá trị | Bên cấp | Cách cấp |
|---|---|---|
| `Claim.id` | Store | Postgres: `'c-' \|\| nextval('claim_number_seq')`; in-memory: bộ đếm |
| `Claim.version` | Store | `createClaim` đặt 1; `saveClaim` ghi `tx.claim.version + 1` |
| `AuditEntry.id` | Store | `crypto.randomUUID()` |
| `AuditEntry.seq` | Store | Trong `appendAudit`, dưới khóa claim; entry đầu tiên của `createClaim` có `seq = 1` |
| `createdAt`, `stateEnteredAt`, `timestamp` | Engine | Lấy từ `Clock`, đã có trong `NewClaim` và `NewAuditEntry` |

Lý do chia như vậy:

- **id, seq và version do store cấp** vì tính đúng của chúng phụ thuộc vào sequence của DB và khóa của transaction (mục 6.4). Engine không thể tự đảm bảo `seq` liên tục hay id không trùng khi tạo claim đồng thời. Bản in-memory làm tương tự bằng bộ đếm, chạy dưới mutex.
- **Timestamp do engine cấp** để mọi thời điểm trong một thao tác dùng cùng một giá trị `now`. Giá trị này dùng cho rule (`ctx.now`), `stateEnteredAt`, `timestamp` của audit và các field trong `data` như `memberAcknowledgedAt`. Test cũng có thể dùng fake clock để cố định thời gian. Nếu để Postgres dùng `now()` thì sẽ lệch với `Clock`, và `now()` còn là thời điểm bắt đầu transaction chứ không phải lúc ghi.

**Một chi tiết cần chốt khi code store:** `saveClaim(next: Claim)` nhận cả `next.version`. Tôi đề xuất store bỏ qua giá trị engine gửi lên và luôn ghi `tx.claim.version + 1`. Nếu `next.id` hoặc `next.version` khác bản đang bị khóa thì báo lỗi lập trình. Một cách khác là đổi kiểu tham số thành `Omit<Claim, 'id' | 'version'>` để compiler chặn luôn từ đầu. Hãy cho tôi biết bạn muốn cách nào trước khi tôi viết store.

## 🧑 User

Type ổn, đồng ý bỏ claimId.

saveClaim: chọn cách 1. Omit không chặn được, vì truyền biến Claim vào vẫn compile (TS chỉ báo field thừa với object literal). Store tự ghi version = tx.claim.version + 1; next.id khác claim đang khóa thì throw. Gọi saveClaim 2 lần trong cùng tx thì version vẫn chỉ +1, lần sau đè lần trước.

Tiếp: viết WorkflowStore/ClaimTx theo 5.3, kèm class lỗi có code dùng chung với mục 7 cho CLAIM_NOT_FOUND/CLAIM_BUSY.

## 🤖 Assistant

Tôi sẽ đọc mục 7 (mã lỗi) và kiểm tra xem engine đã có class lỗi nào chưa.

## 🤖 Assistant

Tôi đã viết `WorkflowStore`, `ClaimTx` và class lỗi dùng chung; typecheck và 73 test hiện có đều qua. Chưa có bản cài đặt store nào.

**Các file mới**
- `src/errors.ts`:
  - `ERROR_CODES` và `ErrorCode` gồm 11 mã của mục 7.
  - `WorkflowError(code, message, details?)` có `toJSON()` trả đúng body `{ code, message, details }`.
  - `isWorkflowError(err, code?)`.
  - Hai hàm tạo lỗi `claimNotFound(id)` và `claimBusy(id)`, message lấy đúng bảng ở mục 7.
- `src/store/types.ts`: `WorkflowStore` và `ClaimTx` có chữ ký giống 5.3. Hợp đồng `saveClaim` theo đúng cách bạn chọn được ghi vào doc comment.
- `src/index.ts` export thêm `errors` và `store`.

Tôi không đưa `INTERNAL_ERROR` và bảng mã lỗi → HTTP status vào engine. Engine không bao giờ ném `INTERNAL_ERROR`, và việc ánh xạ sang HTTP là việc của API.

**Những chỗ DESIGN chưa nói rõ, tôi đã chốt trong doc comment. Bạn xem giúp có đồng ý không:**

1. **`fn` ném lỗi thì rollback cả audit đã append.** Hệ quả là khi bị từ chối, engine phải `appendAudit(TRANSITION_REJECTED)` rồi *return* kết quả lỗi từ `fn`, sau đó mới ném `WorkflowError` ở bên ngoài `withClaim`. Nếu ném ngay bên trong `fn` thì entry bị từ chối sẽ mất.
2. **`tx.claim` giữ nguyên bản đọc dưới khóa**, không được cập nhật sau `saveClaim`. Nhờ vậy `version + 1` luôn tính từ cùng một gốc, đúng với quy tắc "gọi hai lần vẫn chỉ +1".
3. **`countSuccessfulTransitions` đếm cả entry đã append trong cùng tx.** Postgres tự nhìn thấy dữ liệu chính nó vừa ghi, nên bản in-memory cũng phải làm như vậy. Thực tế engine luôn đếm trước khi append, nên điểm này chủ yếu để hai bản cài đặt không lệch nhau.
4. **Thứ tự trả về của các hàm `list*`:**
   - `listAuditByClaim` theo `seq`.
   - `listAllAudit` theo `timestamp`, rồi thứ tự tạo claim, rồi `seq`. Không thể sắp chỉ theo `timestamp`, vì các entry trong cùng một tx có chung timestamp.
   - `listClaims` theo thứ tự tạo. Không sắp theo `id` dạng chuỗi được, vì khi đó `c-10` đứng trước `c-9`, nên Postgres cần `ORDER BY` theo phần số của id.
5. **`tryWithClaim` trả `null` khi claim đang bị khóa**, đúng như 5.3. Nếu `fn` cũng trả `null` thì người gọi không phân biệt được hai trường hợp, nên `runSystemTasks` cần cho `fn` trả về một object.

## 🧑 User

Đồng ý 1, 2, 3, 5. Điểm 4: listAllAudit sắp theo claim (thứ tự tạo) rồi seq, bỏ timestamp. Fake clock làm trùng timestamp gần hết, và xếp theo claim thì audit-output.json dễ đọc hơn.

Tiếp: viết contract test runStoreContract(name, factory), chưa cài đặt. Phủ đủ các điểm vừa chốt, cộng thêm:

mutate sâu object trả về (data.documents.push) không ảnh hưởng dữ liệu đã lưu
fn throw thì khóa vẫn được nhả
CLAIM_BUSY: in-memory nhận lockTimeoutMs để test chạy chung được cho Postgres
cùng claim thì tuần tự, khác claim thì song song, tryWithClaim trả null khi đang bị khóa

## 🤖 Assistant

Tôi sẽ sửa doc comment của `listAllAudit` trước, rồi xem cấu trúc package (exports, tsconfig, vitest) để quyết định đặt contract test ở đâu cho `store-postgres` dùng lại được.

## 🤖 Assistant

Tôi đã viết `runStoreContract(name, factory)` trong `packages/engine/test/store/contract.ts`, gồm 35 test. Typecheck qua, 73 test cũ vẫn xanh. Contract chưa chạy lần nào vì chưa có store để gọi nó, nên lỗi trong chính các test chỉ lộ ra khi viết bản in-memory.

Tôi cũng đã đổi doc comment của `listAllAudit` thành: sắp theo thứ tự tạo claim, rồi theo `seq`.

**Cách dùng.** Mỗi bản cài đặt có một file `.test.ts` gọi `runStoreContract('in-memory', async ({ lockTimeoutMs }) => ({ store, dispose? }))`. Factory được gọi trước mỗi test và phải trả về một store rỗng. Bản Postgres sẽ dùng `dispose` để đóng pool. Contract tự truyền `lockTimeoutMs` (500ms), nên constructor của bản in-memory cần nhận tham số này giống bản Postgres.

**Những gì contract phủ**
- **Các điểm đã chốt:**
  - `saveClaim` luôn ghi `version + 1` và bỏ qua `next.version`.
  - Gọi `saveClaim` hai lần thì lần sau đè lần trước, version chỉ tăng một.
  - `id` khác claim đang khóa thì throw.
  - `tx.claim` không được cập nhật sau `saveClaim`.
  - `fn` ném lỗi thì rollback cả audit đã append, và ném lại đúng error đó.
  - `countSuccessfulTransitions` chỉ đếm entry `TRANSITION` đúng claim và đúng `transitionId`, có tính các entry đã append trong cùng tx.
  - `listAllAudit` sắp theo claim rồi `seq`.
  - `listClaims` qua 11 claim, để bắt lỗi sắp theo chuỗi (`c-10` đứng trước `c-9`).
- **Mutate sâu:** đẩy phần tử vào `data.documents`, gán field hay xóa field trên claim trả về từ `createClaim`, `getClaim`, `listClaims` và trên `tx.claim` đều không ảnh hưởng dữ liệu đã lưu. Sửa object đầu vào sau khi đã gọi `createClaim`, `saveClaim` hay `appendAudit` cũng vậy. Audit entry phải bị deep-freeze: gán, xóa field và push vào mảng đều ném `TypeError`. Mỗi lần gọi `list*` trả về một mảng mới.
- **`fn` throw thì khóa được nhả:** ngay sau đó, `tryWithClaim` phải trả về giá trị, và lần append tiếp theo nhận `seq = 2`. Tức là `seq` của tx đã rollback không bị tiêu, vì 5.2 yêu cầu `seq` liên tục.
- **Khóa:**
  - Cùng claim thì tuần tự, và tx thứ hai nhìn thấy dữ liệu tx thứ nhất đã commit.
  - Khác claim thì không chặn nhau. Nếu cài đặt dùng nhầm một mutex toàn cục, test này fail với `CLAIM_BUSY` chứ không treo.
  - Giữ khóa lâu hơn `lockTimeoutMs` thì nhận `CLAIM_BUSY`, `fn` không chạy và không ghi audit.
  - Khi claim đang bị khóa, `tryWithClaim` trả `null` ngay, không chờ hết timeout.
  - 10 tx ghi đồng thời cho `seq` liên tục từ 1 đến 11 và version bằng 11.

**Ba quyết định tôi tự thêm trong lúc viết test, bạn xem có đồng ý không:**
1. **`tryWithClaim` với claim không tồn tại thì ném `CLAIM_NOT_FOUND`, không trả `null`.** Với Postgres, `SKIP LOCKED` làm dòng đang bị khóa trông giống như không tồn tại. Vì vậy bản Postgres phải phân biệt hai trường hợp này; test buộc nó làm đúng.
2. **Claim trả ra chỉ là bản copy, không freeze.** Test mutate trực tiếp `tx.claim` và các claim trả về, nên nếu store freeze claim thì test sẽ fail. Chỉ audit entry bị freeze.
3. **Fixture dùng timestamp có phần mili giây** (`...000Z`), để giá trị đi qua cột `timestamptz` rồi đọc về vẫn bằng đúng chuỗi ban đầu. Repository của bản Postgres cần trả về `toISOString()`.

Package `store-postgres` hiện chưa tồn tại. Khi tạo, test của nó có thể import contract qua đường dẫn tương đối, hoặc ta thêm subpath export `@claims/engine/testing`. Việc này để đến khi làm package đó rồi chốt.

## 🧑 User

Đồng ý cả 3 quyết định. Thêm 2 test:
1. Test CLAIM_BUSY: sau release(), chạy thêm một withClaim rồi mới kiểm tra called. Hiện tại nếu waiter đã timeout mà quên gỡ khỏi hàng đợi thì fn vẫn chạy ở tick sau và test vẫn xanh. Kiểm tra luôn khóa vẫn dùng được sau timeout.
2. Dùng tx sau khi fn xong (saveClaim/appendAudit) thì throw. PG sẽ lỗi vì connection đã trả pool, nên in-memory phải lỗi theo.
Xong thì cài bản in-memory cho pass contract, không sửa test.

## 🤖 Assistant

Tôi sẽ sửa test `CLAIM_BUSY` và thêm test dùng `tx` sau khi `fn` xong, rồi mới viết bản in-memory.

## 🤖 Assistant

Giờ đến bản in-memory: một mutex theo `claimId` (có timeout và try), và một tx ghi vào vùng đệm rồi commit đồng bộ.

## 🤖 Assistant

Test `CLAIM_BUSY` bắt được waiter bị bỏ quên. Tôi khôi phục dòng đó rồi thử tắt bước kiểm tra tx đã đóng.

## 🤖 Assistant

Bản in-memory pass cả 37 test của contract mà không phải sửa test nào. Toàn bộ package hiện có 110 test xanh; tôi chạy liên tiếp 5 lần, không lần nào chập chờn. Typecheck qua cả `tsconfig.json` lẫn `tsconfig.build.json`.

**Hai test mới trong `test/store/contract.ts`**
- **`CLAIM_BUSY`:** sau `release()`, test chạy thêm một `withClaim` có append rồi mới kiểm tra `called`. Nếu waiter đã timeout mà vẫn nằm trong hàng đợi, nó sẽ chạy trước lần gọi này. Test cũng kiểm tra entry mới có `seq = 2` và `tryWithClaim` vẫn lấy được khóa sau timeout.
- **Dùng `tx` sau khi `fn` xong:** test thử với ba loại tx: tx đã commit, tx mà `fn` ném lỗi, và tx của `tryWithClaim`. Với mỗi loại, `saveClaim`, `appendAudit` và `countSuccessfulTransitions` đều phải reject, và dữ liệu đã lưu không đổi. Tôi thêm `countSuccessfulTransitions` vào danh sách vì Postgres cũng sẽ lỗi ở lời gọi này khi connection đã trả về pool.

Tôi đã cố ý làm hỏng code để kiểm tra hai test này bắt được lỗi, rồi khôi phục lại:
- Bỏ dòng gỡ waiter khỏi hàng đợi khi timeout: chỉ test `CLAIM_BUSY` fail.
- Tắt bước kiểm tra tx đã đóng: chỉ test dùng tx sau khi `fn` xong fail.

**Bản cài đặt**
- `src/store/keyed-mutex.ts`: khóa theo từng key, waiter được phục vụ theo thứ tự đến trước. Khi một tx nhả khóa, khóa được trao thẳng cho waiter kế tiếp, nên `tryAcquire` không chen ngang được. Waiter hết timeout bị gỡ khỏi hàng đợi. Hàm `release` gọi nhiều lần vẫn an toàn.
- `src/store/memory.ts`: `InMemoryWorkflowStore({ lockTimeoutMs })`, mặc định 5000ms.
  - Claim lưu trong một `Map`, nên thứ tự chèn chính là thứ tự tạo. `listAllAudit` duyệt theo thứ tự này.
  - Tx làm việc trên bản copy và gom thay đổi vào vùng chờ. Commit chạy đồng bộ ngay sau khi `fn` resolve, nên không có thao tác nào chen vào giữa lúc commit. Khi `fn` xong (dù thành công hay lỗi), tx bị đóng và mọi lời gọi tiếp theo đều reject.
  - `seq` chỉ được tính lúc append, từ số entry đã commit cộng số entry đang chờ. Vì vậy tx bị rollback không làm mất `seq` nào.
  - Audit entry bị deep-freeze lúc được tạo, nên các hàm `list*` trả về mảng mới mà không cần clone từng entry. Claim thì luôn được clone bằng `structuredClone`.
- `test/store/memory.test.ts` gọi `runStoreContract('in-memory', ...)`.

Có một điểm khác so với Postgres: id của audit trong bản in-memory là `a-1`, `a-2`, … chứ không phải UUID. Contract chỉ yêu cầu id là chuỗi và không trùng nhau, và id dạng này giúp output của test dễ đọc, không đổi giữa các lần chạy. Tôi chọn cách này cũng vì build của engine đặt `types: []`, nên không dùng được kiểu của `node:crypto`.
