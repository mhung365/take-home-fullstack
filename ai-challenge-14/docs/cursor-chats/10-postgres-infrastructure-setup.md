# Postgres infrastructure setup
_Tạo lúc 2026-10-22 22:36_

## 🧑 User

Làm hạ tầng Postgres theo 2.1 và 5.3:
- docker-compose.yml dùng postgres:16-alpine; script init tạo 3 database claims, claims_test, claims_scenarios.
- Package packages/store-postgres với migrations/001_init.sql đúng schema ở 5.3, gồm cả trigger chặn UPDATE/DELETE/TRUNCATE trên audit_entries.
- Runner migration ghi vào bảng schema_migrations, chạy bằng pnpm db:migrate.
- Thêm .env.example.

## 🤖 Assistant

Tôi sẽ đọc DESIGN.md (mục 2.1 và 5.3) và cấu trúc repo trước.

## 🤖 Assistant

Docker có sẵn. Tôi kiểm tra thêm tên biến env mà DESIGN có nhắc tới và phiên bản Node, rồi bắt đầu viết.

## 🤖 Assistant

Bắt đầu viết: docker-compose, script init, rồi package `store-postgres`.

## 🤖 Assistant

Docker daemon chưa chạy; tôi thử mở Docker Desktop và đợi nó sẵn sàng.

## 🤖 Assistant

Migration chạy được và chạy lại thì bỏ qua đúng. Giờ kiểm tra trigger chặn sửa audit trên `claims_test`, sau đó dọn database này về trạng thái rỗng.

## 🤖 Assistant

Mọi lệnh sửa/xóa audit đều bị chặn. Kiểm tra nốt hai trường hợp của runner: hai runner chạy đồng thời, và file migration bị sửa sau khi đã áp dụng.

## 🤖 Assistant

Tất cả hoạt động đúng. Sửa nhỏ một thông báo lỗi bị lặp tên file:

## 🤖 Assistant

Hạ tầng Postgres đã xong và đã chạy thử trên Docker thật. Container `postgres:16-alpine` lên healthy, có đủ 3 database `claims`, `claims_test`, `claims_scenarios`. `pnpm db:migrate` áp dụng `001_init.sql` lên `claims`, chạy lại thì báo "up to date".

**Các file đã thêm hoặc sửa**
- `docker-compose.yml`: một service `postgres`, user/mật khẩu/database đều là `claims`, có volume `pgdata`, healthcheck `pg_isready`, cổng 5432. Thư mục `docker/postgres/init` được mount vào `docker-entrypoint-initdb.d`.
- `docker/postgres/init/01-create-databases.sh`: tạo 3 database, database nào có rồi thì bỏ qua. Script này chỉ chạy khi volume còn trống, nên muốn chạy lại phải `docker compose down -v`.
- `packages/store-postgres/migrations/001_init.sql`: schema đúng như mục 5.3. Thêm một hàm trigger dùng chung: `BEFORE UPDATE OR DELETE` theo từng dòng và `BEFORE TRUNCATE` theo câu lệnh, cả hai đều raise exception.
- `packages/store-postgres/src/migrate.ts`: hàm `migrate(client)` được export để integration test và `pnpm scenarios` gọi lên database riêng của chúng.
  - Mỗi file migration chạy trong một transaction riêng, cùng với dòng ghi vào `schema_migrations` (gồm version, name, checksum, applied_at).
  - Runner giữ advisory lock, nên nhiều runner chạy song song trên cùng database không đụng nhau.
  - Nếu một file đã áp dụng bị sửa sau đó, runner báo lỗi thay vì lặng lẽ bỏ qua.
- `src/cli/migrate.ts`: đọc `DATABASE_URL` từ file `.env` ở thư mục gốc. Nếu môi trường đã có biến này thì giá trị trong môi trường được ưu tiên.
- `package.json` ở thư mục gốc có thêm script `db:migrate`, chạy build rồi gọi CLI ở trên.
- `.env.example`: `DATABASE_URL`, `DEMO_MODE`, `PORT`. Tôi chỉ đưa vào những biến code đang đọc. `lock_timeout` và kích thước pool sẽ thêm khi viết đến store và API.

**Đã kiểm tra trên `claims_test`**
- `UPDATE`, `DELETE`, `TRUNCATE audit_entries` và `TRUNCATE claims CASCADE` đều bị từ chối với lỗi `audit_entries is append-only: ... is not allowed`.
- Xóa claim đã có audit bị khóa ngoại chặn. Ghi trùng `(claim_id, seq)` bị `UNIQUE` chặn.
- Hai runner chạy cùng lúc thì chỉ một runner áp dụng migration. Sửa file đã áp dụng thì runner thoát với mã lỗi 1.
- `DROP SCHEMA public CASCADE` vẫn dọn được dữ liệu, vì trigger không chặn lệnh `DROP`. Đây là cách reset mà mục 10 đã mô tả cho integration test. Sau khi thử, tôi đã đưa `claims_test` về rỗng.

Tôi cũng đã tạo `.env` từ `.env.example` để chạy thử. Repo chưa có test tự động cho trigger (DESIGN yêu cầu chứng minh `UPDATE`/`DELETE` bằng SQL bị từ chối). Tôi để phần đó cho lúc viết `PostgresStore` và `pnpm test:integration`.

## 🧑 User

Cài PostgresWorkflowStore implement WorkflowStore, chạy runStoreContract trên claims_test. Dùng SELECT ... FOR UPDATE cùng lock_timeout (lấy từ env) cho withClaim, FOR UPDATE SKIP LOCKED cho tryWithClaim. Lỗi lock_timeout thì map sang CLAIM_BUSY. Thêm script pnpm test:integration.

## 🤖 Assistant

Tôi sẽ đọc interface `WorkflowStore`, bản in-memory và bộ contract test trong engine trước.

## 🤖 Assistant

Đọc đoạn giữa của contract test bị cắt (phần audit/withClaim), vì đó là chỗ quyết định ngữ nghĩa của store.

## 🤖 Assistant

Tiếp theo là phần đọc env (`DB_LOCK_TIMEOUT_MS`, `DB_POOL_MAX`), export, và cấu hình test.

## 🤖 Assistant

Cập nhật `package.json`/`tsconfig` của package và script ở root, rồi cài dependency.

## 🤖 Assistant

`PostgresWorkflowStore` đã xong và pass toàn bộ `runStoreContract` trên `claims_test`. `pnpm test:integration` cho 42/42 test pass, chạy lại 3 lần vẫn ổn định. 211 unit test của engine vẫn pass.

**Cách khóa** (`packages/store-postgres/src/store.ts`)
- **`withClaim`:** mở transaction `READ COMMITTED` và đặt `lock_timeout` chỉ cho transaction đó, rồi chạy `SELECT ... FOR UPDATE`.
  - Nếu Postgres báo hết thời gian chờ khóa (mã `55P03`) thì đổi thành `CLAIM_BUSY`. Tôi chỉ bắt lỗi này ở câu khóa claim, nên lỗi SQL khác bên trong `fn` không bị nhầm thành `CLAIM_BUSY`.
  - Không có dòng nào thì trả `CLAIM_NOT_FOUND` mà không gọi `fn`.
- **`tryWithClaim`:** dùng `FOR UPDATE SKIP LOCKED`. Trường hợp này không có dòng thì có thể là claim đang bị khóa hoặc không tồn tại, nên store đọc lại một lần không khóa: không tồn tại thì báo `CLAIM_NOT_FOUND`, còn lại thì trả `null`.
- **`seq` của audit:** lấy max + 1 ngay trong câu `INSERT`, dưới khóa của claim. `UNIQUE (claim_id, seq)` là lớp chặn cuối cùng.
- **`listClaims` và `listAllAudit`:** sắp xếp theo số trong id (`c-N`) để đúng thứ tự tạo khi có hơn 10 claim.
- **Kết thúc transaction:** gọi `tx` sau khi `fn` đã xong sẽ bị báo lỗi. Nếu transaction đã hỏng mà `COMMIT` lặng lẽ rollback, store ném lỗi thay vì báo thành công.

**Env** (`src/env.ts`, `.env.example`)

`readPostgresEnv()` đọc `DATABASE_URL`, `DB_LOCK_TIMEOUT_MS` (mặc định 5000) và `DB_POOL_MAX` (mặc định 10). Store tự nó không đọc env: nó nhận `lockTimeoutMs` qua constructor, nên test truyền 500ms. Pool do bên gọi tạo và đóng.

**Test**
- `test/store.contract.test.ts` gọi `runStoreContract` từ `packages/engine/test/store/contract.ts`, nên bản in-memory và Postgres chạy chung một bộ contract. Trước mỗi test, database được reset bằng `DROP SCHEMA` rồi chạy lại migration, vì trigger chặn `TRUNCATE`.
- `test/audit-append-only.test.ts` kiểm tra rằng `UPDATE`, `DELETE`, `TRUNCATE` (kể cả `TRUNCATE claims CASCADE`) viết tay đều bị từ chối. Đây là yêu cầu ở mục 5.2.
- Một test helper từ chối chạy nếu database không có đuôi `_test`, để lệnh reset không thể xóa nhầm `claims`. Có thể đổi database bằng biến `TEST_DATABASE_URL`.
- Các file test chạy tuần tự vì dùng chung một schema.

**Thay đổi phụ**
- `pnpm test:integration` và `pnpm db:migrate` ở thư mục gốc giờ build engine trước, vì `store-postgres` import `@claims/engine`.
- Engine có thêm export `deepFreeze` để store đóng băng các audit entry trả ra ngoài.
- Bản typecheck của `store-postgres` đặt `rootDir: "../.."` để import được contract test từ engine; bản build vẫn dùng `rootDir: src`.

API vẫn đang dùng store cũ, chưa chuyển sang Postgres. Tôi để việc tạo `pg.Pool` trong một Nest provider (mục 8) cho bước tiếp theo.

## 🧑 User

Ổn, tôi đã chạy lại 42/42

## 🤖 Assistant

Tốt, vậy bản Postgres đã chạy đúng cùng một contract với bản in-memory, trên máy bạn cũng như lúc tôi chạy.

Việc tiếp theo là cho API dùng store Postgres thay cho bản in-memory. Cụ thể: tạo một Nest provider đọc `readPostgresEnv()`, dựng một `pg.Pool` dùng chung theo `DB_POOL_MAX`, tạo `PostgresWorkflowStore` với `DB_LOCK_TIMEOUT_MS`, và đóng pool khi app shutdown (mục 8). Nếu bạn muốn, tôi làm phần này luôn.

## 🧑 User

Cho API dùng PostgresWorkflowStore: pg.Pool là một Nest provider, đóng khi app shutdown, đọc env qua readPostgresEnv(). /health ping DB, lỗi thì trả 503. Sau đó viết integration test cho case 26–31 ở mục 10 chạy qua engine với store Postgres. Mỗi case lặp 20 lần, bắn song song bằng Promise.all. Case 32 đã có rồi, chỉ cần ghi chú trong test.

## 🤖 Assistant

Tôi sẽ đọc code API hiện tại (module, health, cách dựng engine/store) và mục 10 của DESIGN.

## 🤖 Assistant

Viết phần database cho API.

## 🤖 Assistant

Giờ là `main.ts`: nạp `.env`, gọi `readPostgresEnv()`, và bật shutdown hooks để `onApplicationShutdown` chạy khi nhận SIGINT/SIGTERM.

## 🤖 Assistant

Thêm dependency cho API và cập nhật script `dev` ở thư mục gốc, để `store-postgres` được build (và watch) trước khi API chạy.

## 🤖 Assistant

Phần API đã xong. Giờ đến test: cho `setup()` trong helper của engine nhận thêm một `store` tùy chọn.

## 🤖 Assistant

API giờ chạy trên `PostgresWorkflowStore`, và case 26–31 đã có integration test chạy qua engine thật trên Postgres. `pnpm test:integration` cho 49/49 pass trong khoảng 8 giây; 211 unit test của engine vẫn pass.

Để chắc các test này thật sự bắt được race, tôi tạm bỏ `FOR UPDATE` trong `withClaim` thì case 26, 27, 28, 30, 31a và 31b fail. Bỏ `SKIP LOCKED` trong `tryWithClaim` thì case 29 fail, vì mỗi claim bị đóng hai lần. Sau đó tôi đã khôi phục code và chạy lại cho pass.

**API**
- `pg.Pool` là provider `PG_POOL`, kích thước lấy từ `DB_POOL_MAX`, chờ lấy connection tối đa 5 giây. Pool có gắn listener `error`, để một connection rảnh bị server ngắt không làm sập process.
- `PgPoolLifecycle` gọi `pool.end()` trong `onApplicationShutdown`, và `main.ts` bật `enableShutdownHooks()`. Đã thử: gửi SIGINT thì log ra `Pool closed`.
- `main.ts` nạp file `.env` ở thư mục gốc rồi gọi `readPostgresEnv()`. Env sai (ví dụ `DB_LOCK_TIMEOUT_MS=abc`) thì API dừng ngay lúc khởi động với thông báo rõ ràng. Log khởi động có in host và database, không in mật khẩu.
- `/health` chạy `SELECT 1`: thành công thì trả 200 `{status:'ok', database:'ok'}`, lỗi thì trả 503 `{status:'unavailable', database:'unreachable'}`. Controller tự đặt status 503, vì `ErrorFilter` biến mọi exception 5xx thành 500. Đã thử với một cổng không có DB.
- `pnpm dev` giờ build và watch cả `store-postgres`.

**Test** (`packages/store-postgres/test/concurrency.test.ts`)

Mỗi case chạy 20 vòng tuần tự. Trong mỗi vòng, các request được bắn cùng lúc bằng `Promise.all`, nên mỗi request chạy trên một connection riêng của pool. Test dùng lại `setup()` và `seed` của engine; tôi chỉ thêm tùy chọn `store` vào `setup()`.
- **26:** `approve` và `reject` cùng lúc. Kiểm tra bên thắng, bên thua bị `INVALID_TRANSITION` tính từ state của bên thắng, và chỉ có side effect của transition thắng.
- **27:** 5 `request_info` cùng lúc sau 2 vòng. 1 request thành công, 4 request bị `INVALID_TRANSITION` vì claim đã sang `PENDING_INFO`. Số `TRANSITION` của `request_info` là 3, và lần thứ tư bị `CYCLE_LIMIT_EXCEEDED` đúng message.
- **28:** hai `acknowledge` cùng lúc cho ra đúng 1 `MEMBER_ACKNOWLEDGED` và 1 `ACTION_REJECTED`.
- **29:** hai `runSystemTasks` cùng lúc trên 10 claim. Mỗi claim được xử lý đúng một lần, có đúng 1 bộ side effect, và có 10 thông báo `notify`.
- **30:** 11 request trộn lẫn, cả thành công lẫn bị từ chối. `seq` liên tục từ 1, mỗi request được ghi audit đúng một lần, và `version` bằng 1 cộng số lần ghi thành công.
- **31:** tách làm hai:
  - **31a:** hai request cùng gửi `expectedVersion: 1`. Bên thua bị `STALE_CLAIM`, claim giữ đúng dữ liệu bên thắng ghi, và có `TRANSITION_REJECTED`.
  - **31b:** một connection khác giữ `FOR UPDATE` lâu hơn `lock_timeout` 200ms. Request bị `CLAIM_BUSY` sau khi chờ đủ thời gian, không ghi audit. Khi connection kia nhả khóa thì request cùng loại đi qua bình thường.
- **32:** chỉ thêm ghi chú ở đầu file và đổi tên `describe` trong `audit-append-only.test.ts` để nhắc tới case 32.

Khi chạy thử API, tôi có tạo một claim trong database `claims`, sau đó đã reset database này và chạy lại migration, nên giờ nó trống như trước.

## 🧑 User

ổn, tôi đã tự chạy lại pnpm test:integration: 49/49 test pass.

## 🤖 Assistant

Tốt, kết quả trên máy bạn khớp với lúc tôi chạy: 49/49. Như vậy API đang chạy trên Postgres, và cả 7 case từ 26 đến 32 trong mục 10 đã có integration test.

Theo mục 11, việc còn lại là script `pnpm scenarios`: chạy 5 scenario của đề cùng 3 case bổ sung (precondition thất bại, vượt cycle, hai request đồng thời) trên database `claims_scenarios`. Script ghi kết quả ra `docs/scenario-results.md` và `docs/audit-output.json`. Sau đó là `docs/config-diff.md`. Nếu bạn muốn, tôi làm tiếp phần đó.
