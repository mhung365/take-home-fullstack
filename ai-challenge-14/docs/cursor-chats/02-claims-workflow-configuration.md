# Claims workflow configuration
_Tạo lúc 2026-10-22 17:40_

## 🧑 User

Viết config/claims-workflow.json và config/users.json đúng bảng 4.4 và mục 3. Viết Zod schema và loader trong packages/engine/src/config theo 4.6, trả về toàn bộ lỗi. Chưa làm rule, effect hay store. Xong khi: config thật load được, và có test cho config lỗi (state không tồn tại, role lạ, reasonField không có trong inputs, trùng from → to).

## 🤖 Assistant

I'll start by reading the design doc and brief to get table 4.4, section 3, and section 4.6.

## 🤖 Assistant

I have what I need from the design. Next I'll look at the engine package's build config, the smoke test, and the installed zod version.

## 🤖 Assistant

Zod 4 is installed and the package compiles to CommonJS. Now I'll write the two config files.

## 🤖 Assistant

Now the loader with the semantic checks from 4.6, collecting every error instead of stopping at the first one.

## 🤖 Assistant

Now the tests: the real config loads, plus one test per required failure case and a few extra checks from 4.6.

## 🤖 Assistant

Running the tests, the type check, and the build.

## 🤖 Assistant

Cả hai file config đã xong, và config thật load được: không có lỗi, không có cảnh báo. 14 test pass (13 test config cộng smoke test cũ), type check sạch, và `pnpm build` chạy được.

**Config**
- `config/claims-workflow.json` có 8 state lấy từ brief, `CLOSED` là terminal. File có `settings`, `actions`, và 9 transition đúng bảng 4.4. Mỗi `notify` có đủ `to` và `template`. `request_info` có `cycleLimit` 3 lần với đúng message của đề. `reasonField` được khai báo cho `reject`, `request_info`, `confirm_payment`.
- `config/users.json` có 6 user đúng bảng ở mục 3.

**Engine (`packages/engine/src/config`)**
- `schema.ts` là Zod schema cho cả hai file. Object đều là strict, nên key gõ sai sẽ bị báo lỗi. Precondition là cây đệ quy `all`/`any`/`not`/rule. Schema chọn nhánh theo key của từng node, nên lỗi lồng sâu vẫn giữ đúng đường dẫn, ví dụ `transitions[2].preconditions.all[1].rule`.
- `loader.ts` có hai hàm:
  - `validateConfig({ workflow, users })` trả về `{ ok, config | errors, warnings }` và không bao giờ ném lỗi.
  - `loadConfig()` ném `ConfigValidationError`, kèm danh sách toàn bộ lỗi.
- Hai file được kiểm tra độc lập. Nếu Zod báo lỗi ở một file, file kia vẫn được kiểm tra semantic, nên một lần chạy gom đủ mọi lỗi.
- Loader nhận JSON đã parse chứ không tự đọc file, để engine giữ đúng nguyên tắc không I/O. API và test tự đọc file.

**Các kiểm tra semantic đã làm theo mục 4.6**
- State không tồn tại (`initialState`, `from`, `to`, `allowedStates`).
- Role không nằm trong `roles` (ở transition, action và `users.json`).
- `inputs` trùng field lõi.
- `reasonField` không có trong `inputs`.
- Trùng `id` transition, trùng cặp `from → to`.
- State terminal có transition đi ra.
- `providedInRequest` dùng field không có trong `inputs`.
- Trùng id user.
- State không tới được từ `initialState`: chỉ là cảnh báo, không làm load thất bại.

Ngoài mục 4.6, tôi thêm kiểm tra trùng id state và trùng role, vì cần chúng để kiểm tra state và role ở trên cho đúng.

**Test (`test/config.test.ts`)** bao gồm config thật load được và bốn case bạn yêu cầu: state không tồn tại, role lạ, `reasonField` thiếu trong `inputs`, trùng `from → to`. Ngoài ra có test cho từng kiểm tra semantic còn lại, cho lỗi schema có đường dẫn, và một test xác nhận gom đủ 5 lỗi trong một lần chạy.

**Chưa làm**, vì chúng cần registry rule và side effect mà bạn đã bảo để sau:
- Tên rule hoặc side effect chưa đăng ký.
- `params` của side effect sai schema của handler.
- `setField.params.field` trùng field lõi.
- Biến trong template `notify` không tồn tại.

Khi làm phần rule và effect, nên cho loader nhận registry làm tham số để thêm các kiểm tra này.

**Thay đổi ngoài thư mục `config`:**
- Thêm `@types/node` vào devDependencies của engine, vì test cần `fs`.
- `tsconfig.json` bật Node types cho test.
- `tsconfig.build.json` đặt `types: []`, để code trong `src` không dùng nhầm Node API.
