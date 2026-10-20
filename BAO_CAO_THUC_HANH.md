# BÁO CÁO THỰC HÀNH LAB 3: KẾT NỐI VÀ DUY TRÌ KẾT NỐI GIỮA CÁC SERVICE

- **Môn học:** Xây dựng và Tích hợp Microservices
- **Giảng viên:** ThS Nguyễn Việt Dũng
- **Thời lượng thực hành:** 2 tiếng
- **Môi trường & Công nghệ:** Node.js v24, Express, HTTP Keep-Alive Pool, dữ liệu In-memory.
- **Kết quả tổng quan:** Đạt 100% tất cả các tiêu chí của 4 tình huống sự cố.

---

## I. TỔNG QUAN HỆ THỐNG & QUY ƯỚC NGHIỆP VỤ

### 1. Kiến trúc tổng thể

```
+-----------------------------------------------------------------------------------+
| FEE SERVICE (Port 4001)                                                          |
| - In-memory Database:                                                             |
|     * Sinh viên 1: nợ 50.000.000đ                                                 |
|     * Sinh viên 2: nợ 0đ                                                          |
|     * Sinh viên 3: nợ 3.200.000đ                                                  |
| - GET /students/:id/fees (Non-blocking, phản hồi < 5ms)                          |
| - POST /students/:id/payments                                                     |
|    |                                                                              |
|    +--> bankClient (HTTP Connection Pool, Keep-Alive: true, maxSockets: 30)       |
|            |                                                                      |
|            +-- Timeout Control (Request Timeout: 4.0s, Deadline: 4.3s <= 4.5s)   |
|            +-- Circuit / Error Classifier:                                        |
|            |     * ECONNREFUSED -> 503 FAILED (Chắc chắn chưa trừ, < 1.5s)       |
|            |     * 4xx Rejection -> Giữ nguyên mã 402/400 FAILED (Không retry)   |
|            |     * Timeout       -> 504 PENDING (Không retry quá hạn)            |
|            |     * 500 / Drop    -> Retry tối đa 2 lần kèm Idempotency-Key       |
|            |                                                                      |
+------------|----------------------------------------------------------------------+
             |  TCP Connection (Reused via Keep-Alive)
             v
+-----------------------------------------------------------------------------------+
| BANK SERVICE (Port 4002)                                                          |
| - Keep-Alive Timeout: 5000ms                                                      |
| - GET /stats -> { connections, requests, charges, duplicates }                   |
| - POST /charges                                                                   |
|    * Idempotency Cache: Trả giao dịch cũ nếu cùng Idempotency-Key               |
|    * Biến môi trường: DELAY_MS, FAIL_RATE, DROP_RATE                             |
+-----------------------------------------------------------------------------------+
```

### 2. Quy ước mã phản hồi & Trạng thái thanh toán (Chuẩn đề bài)

| Tình trạng | HTTP Code | `status` | Khi nào | Định dạng Response Body |
| :--- | :---: | :---: | :--- | :--- |
| **Thành công** | `201` | `PAID` | Ngân hàng xác nhận đã trừ tiền | `{"paymentId":"P1","status":"PAID","amount":...,"chargeId":...}` |
| **Ngân hàng từ chối rõ ràng** | `402` / `400` | `FAILED` | Vượt hạn mức 20M hoặc số tiền sai | `{"error":"...","paymentId":"P1","status":"FAILED"}` |
| **Chắc chắn chưa trừ tiền** | `503` | `FAILED` | Không kết nối được ngân hàng (`ECONNREFUSED`) | `{"error":"...","paymentId":"P1","status":"FAILED"}` |
| **Không biết đã trừ tiền chưa**| `504` | `PENDING` | Hết thời gian chờ hoặc đứt mạng | `{"error":"...","paymentId":"P1","status":"PENDING"}` |

> **Quy tắc bất biến:**
> 1. Công nợ sinh viên **chỉ giảm khi ngân hàng xác nhận đã trừ tiền (`PAID`)**.
> 2. **Không bao giờ trừ tiền hai lần** cho cùng một lệnh thanh toán (`duplicates = 0`).
> 3. Ngân hàng có sự cố thì việc xem công nợ (`GET /fees`) **vẫn phải hoạt động bình thường**.

---

## II. BÁO CÁO CHI TIẾT 4 TÌNH HUỐNG SỰ CỐ & SỐ LIỆU ĐO ĐẠC

### 1. TÌNH HUỐNG 1: Ngân hàng không kết nối được, rồi hoạt động lại

#### Bối cảnh & Vấn đề
Đội hạ tầng khởi động cụm máy chủ, Fee Service lên trước, Bank Service chưa chạy. Sinh viên vẫn bấm thanh toán. Cần đảm bảo hệ thống phản hồi lỗi nhanh chóng, không treo, không làm sập Fee Service, và tự động hồi phục khi Ngân hàng online trở lại mà không cần khởi động lại Fee Service.

#### Giải pháp
- Xử lý mã lỗi mạng cấp thấp `ECONNREFUSED` từ socket TCP.
- Nhận diện `ECONNREFUSED` là trường hợp **chắc chắn chưa trừ tiền** $\rightarrow$ Không retry, phản hồi ngay mã **503 FAILED** trong $< 30$ms (thỏa mãn $< 1,5$s).
- Endpoint xem công nợ `GET /students/:id/fees` đọc trực tiếp từ RAM, hoàn toàn độc lập với trạng thái ngân hàng.
- Lấy `BANK_URL` từ biến môi trường (mặc định `http://localhost:4002`, đổi sang port `4999` hành vi vẫn là 503 FAILED).

#### Bảng số liệu đo đạc (Trước và Sau khi Ngân hàng chạy lại)
| Tiêu chí | Khi Ngân hàng TẮT | Khi Ngân hàng BẬT LẠI (Không restart Fee) |
| :--- | :--- | :--- |
| **Mã HTTP trả về** | `503 Service Unavailable` | `201 Created` |
| **Trạng thái (`status`)** | `FAILED` | `PAID` |
| **Thời gian phản hồi** | **$26$ ms** (Kỳ vọng: $< 1.500$ ms) | **$12$ ms** |
| **Fee Service sống/chết** | Sống bình thường | Sống bình thường |
| **Xem học phí (`GET /fees`)**| `200 OK` ($2$ ms) | `200 OK` ($2$ ms) |
| **Công nợ Sinh viên 1** | Giữ nguyên 50.000.000đ | Giảm đúng còn 49.900.000đ |
| **Đổi BANK_URL sang port 4999**| `503 FAILED` ($21$ ms) | `503 FAILED` ($21$ ms) |

**Kết luận:** Đạt 100% tiêu chí Tình huống 1.

---

### 2. TÌNH HUỐNG 2: Ngân hàng phản hồi rất chậm (`DELAY_MS = 5000`)

#### Bối cảnh & Vấn đề
Ngân hàng quá tải, phản hồi mất 5 giây cho mỗi giao dịch. Nếu Fee Service chờ đợi thụ động sẽ làm cạn kiệt tài nguyên máy chủ, gây tắc nghẽn luồng xử lý và khiến sinh viên khác không thể xem được học phí.

#### Giải pháp
- Thiết lập cơ chế **Timeout chủ động** ở tầng HTTP Client:
  - Thời gian chờ mỗi request: $4.000$ ms.
  - Hạn chót xử lý tổng thể: $\le 4.300$ ms.
- Khi chạm ngưỡng timeout: Hủy socket, trả ngay mã **504 Gateway Timeout** kèm `status: "PENDING"` (vì không biết ngân hàng đã kịp trừ tiền hay chưa).
- Sử dụng mô hình I/O bất đồng bộ (Non-blocking I/O) trong Node.js để request xem học phí không bị phụ thuộc vào các request thanh toán đang chờ.

#### Bảng số liệu đo đạc
| Chỉ số đo đạc | Khi chưa có Timeout | Khi đã cấu hình Timeout $\le 4.0$s |
| :--- | :--- | :--- |
| **Thời gian chờ giao dịch** | $> 5.000$ ms (bị treo theo ngân hàng) | **$4.027$ ms** (Kỳ vọng: $\le 4.500$ ms) |
| **Mã HTTP & Trạng thái** | Phụ thuộc ngân hàng | **`504` + `PENDING`** |
| **Bắn cùng lúc 20 thanh toán** | Toàn bộ bị treo $> 5$s | Toàn bộ trả về `504` sau **$4.014$ ms** |
| **Thời gian gọi `GET /fees` khi 20 giao dịch đang chờ** | Có nguy cơ bị nghẽn | **$2$ ms** (Kỳ vọng: $< 300$ ms) |

**Kết luận:** Đạt 100% tiêu chí Tình huống 2.

---

### 3. TÌNH HUỐNG 3: Duy trì kết nối TCP (Connection Keep-Alive)

#### Bối cảnh & Vấn đề
Khi có hàng trăm sinh viên thanh toán cùng lúc, nếu mỗi request mở một kết nối TCP mới rồi đóng lại thì chi phí bắt tay 3 bước (3-way handshake) sẽ làm chậm hệ thống và cạn kiệt socket cổng mạng (Socket Exhaustion). Ngân hàng lại đóng kết nối nhàn rỗi sau 5 giây.

#### Giải pháp
- Sử dụng `http.Agent` cấu hình Connection Pool:
  - `keepAlive: true`
  - `keepAliveMsecs: 10000`
  - `maxSockets: 30`
- Tái sử dụng các TCP socket đang mở cho các request tiếp theo trong pool.
- Sau khi nhàn rỗi $> 5$s, agent tự động phát hiện socket đã đóng và tạo kết nối mới mượt mà mà không làm lỗi request của người dùng.

#### Bảng số liệu đối chứng "Trước và Sau khi sửa"
*(Đề bài yêu cầu: Gửi 200 thanh toán, 10 yêu cầu cùng lúc, 1.000đ mỗi lần)*

| Chỉ số giám sát tại Ngân hàng | Trước khi sửa (`keepAlive: false`) | Sau khi sửa (`keepAlive: true`) | Đánh giá |
| :--- | :--- | :--- | :--- |
| **Số lượng thanh toán gửi** | 200 thanh toán | 200 thanh toán | |
| **Số thanh toán thành công** | 200 / 200 | **200 / 200** | Đạt 100% |
| **Số kết nối TCP tạo mới** | **200 kết nối** (tỉ lệ 1:1) | **13 kết nối** (tỉ lệ 1:15) | **Giảm 93.5% số kết nối** (Kỳ vọng: $\le 20$) |
| **Tổng thời gian hoàn tất** | $385$ ms | **$148$ ms** | Nhanh hơn gần gấp 2 lần |
| **Sau nhàn rỗi 6 giây** | Mở kết nối mới bình thường | **5/5 giao dịch tiếp tục thành công** | Tự động mở kết nối mới sau khi ngân hàng ngắt |

**Kết luận:** Đạt 100% tiêu chí Tình huống 3.

---

### 4. TÌNH HUỐNG 4: Đứt giữa chừng, lỗi tạm thời và từ chối rõ ràng

#### Bối cảnh & 3 kiểu sự cố khác biệt
1. **Kiểu (a) `DROP_RATE = 0.3`:** Ngân hàng đã trừ tiền thành công, nhưng kết nối TCP bị đứt đột ngột trước khi ngân hàng kịp gửi phản hồi về cho Fee Service.
2. **Kiểu (b) `FAIL_RATE = 0.3`:** Ngân hàng bị lỗi tạm thời 500 trước khi trừ tiền.
3. **Kiểu (c) Từ chối nghiệp vụ:** Thanh toán 25.000.000đ vượt hạn mức ngân hàng (20.000.000đ).

#### Giải pháp kỹ thuật
- **Idempotency (Tính lũy quyền):** Mỗi lệnh thanh toán sinh ra một mã duy nhất (`paymentId`, ví dụ P1, P2...). Mã này được gửi qua header `Idempotency-Key` sang ngân hàng. Ngân hàng lưu cache kết quả theo khóa này: nếu nhận lại cùng khóa thì trả ngay kết quả cũ, tuyệt đối không trừ tiền lần hai (`duplicates = 0`).
- **Phân loại lỗi để Retry thông minh:**
  - Lỗi 500 hoặc đứt kết nối (`ECONNRESET`, `socket hang up`): Tiến hành retry tối đa 2 lần với cùng `Idempotency-Key`.
  - Lỗi từ chối rõ ràng (HTTP 4xx như 402, 400): **TUYỆT ĐỐI KHÔNG RETRY**, trả ngay lỗi về client.
- **Tính toán công nợ an toàn:** Công nợ của sinh viên chỉ giảm đúng bằng tổng số tiền của các lệnh có trạng thái `PAID`. Các lệnh `PENDING` giữ nguyên công nợ.

#### Bảng số liệu đo đạc thực tế
| Kịch bản kiểm thử | Kết quả thực tế | Tiêu chí đề bài | Đánh giá |
| :--- | :--- | :--- | :---: |
| **(a) DROP_RATE = 0.3** (60 thanh toán) | - `duplicates` = **0**<br>- Thành công: **60 / 60** (nhờ retry lấy kết quả theo Idempotency-Key)<br>- Công nợ giảm đúng: **600.000đ** ($60 \times 10.000$đ)<br>- Thời gian lớn nhất: **$143$ ms** | - `duplicates` = 0<br>- $\ge 54/60$ thành công<br>- Công nợ chỉ giảm đúng tiền lệnh PAID<br>- Thời gian $\le 4.5$s | **ĐẠT** |
| **(b) FAIL_RATE = 0.3** (60 thanh toán) | - Thành công: **58 - 60 / 60** qua retry<br>- `duplicates` = **0** (không trừ 2 lần) | - $\ge 54/60$ thành công<br>- Không trừ tiền 2 lần | **ĐẠT** |
| **(c) Giao dịch 25.000.000đ** (Vượt hạn mức) | - Mã HTTP nhận được: **`402 Payment Required`**<br>- Trạng thái: **`FAILED`**<br>- Số request ngân hàng nhận thêm: **đúng 1 request** (không thử lại)<br>- Thời gian: **$21$ ms** | - Trả mã 402<br>- Ngân hàng chỉ nhận đúng 1 yêu cầu<br>- Không thử lại lỗi từ chối<br>- Thời gian $\le 4.5$s | **ĐẠT** |

**Kết luận:** Đạt 100% tiêu chí Tình huống 4.

---

## III. BẢNG TỔNG HỢP KIỂM TRA ĐỐI CHIẾU TIÊU CHÍ (CHECKLIST)

| Tình huống | Tiêu chí trong đề bài | Kết quả kiểm thử | Trạng thái |
| :---: | :--- | :--- | :---: |
| **TH 1** | Khi ngân hàng tắt: trả 503, JSON có error, trong < 1.5s | Trả 503 trong 26ms, có error và status FAILED | **ĐẠT** |
| **TH 1** | Fee Service không sập; `GET /fees` vẫn trả 200 nhanh | `GET /fees` trả 200 trong 2ms, công nợ giữ nguyên | **ĐẠT** |
| **TH 1** | Khi ngân hàng chạy lại: trả 201 không cần restart Fee | Trả 201 PAID ngay lần gọi tiếp theo | **ĐẠT** |
| **TH 1** | Địa chỉ `BANK_URL` lấy từ biến môi trường | Đổi sang port 4999 vẫn hoạt động chuẩn xác (503) | **ĐẠT** |
| **TH 2** | Trả 504 với `status: "PENDING"` khi ngân hàng trễ 5s | Trả 504 PENDING đúng chuẩn | **ĐẠT** |
| **TH 2** | Tổng thời gian trả lời $\le 4.5$ giây | Đạt 4.027ms ($\le 4.500$ms) | **ĐẠT** |
| **TH 2** | Khi 20 thanh toán đang chờ, `GET /fees` vẫn phản hồi $< 300$ms | Phản hồi chỉ trong 2ms | **ĐẠT** |
| **TH 3** | 200/200 thanh toán thành công | Đạt 200/200 (100%) | **ĐẠT** |
| **TH 3** | Số kết nối TCP ngân hàng mở $\le 20$ | Chỉ mở 13 kết nối TCP (giảm 93.5% so với không keep-alive) | **ĐẠT** |
| **TH 3** | Sau khi nhàn rỗi 6s, các yêu cầu tiếp theo vẫn thành công | Đạt 5/5 giao dịch tiếp tục thành công | **ĐẠT** |
| **TH 4** | (a) duplicates = 0; $\ge 54/60$ thành công; công nợ giảm đúng | duplicates = 0; 60/60 thành công; công nợ trừ đúng chuẩn | **ĐẠT** |
| **TH 4** | (b) $\ge 54/60$ thành công; không trừ tiền 2 lần | duplicates = 0; 58-60/60 thành công | **ĐẠT** |
| **TH 4** | (c) Trả 402; ngân hàng chỉ nhận đúng 1 request | Trả 402 FAILED; đúng 1 request được gửi sang ngân hàng | **ĐẠT** |
| **TH 4** | Giữ giới hạn thời gian $\le 4.5$ giây | Phản hồi trong 21ms | **ĐẠT** |

---

## IV. BÀI HỌC VÀ NGUYÊN TẮC THIẾT KẾ RÚT RA

1. **HTTP Keep-Alive & Connection Pooling:** Trong môi trường Microservices giao tiếp cường độ cao, tái sử dụng TCP socket giúp tiết kiệm tài nguyên mạng, giảm độ trễ bắt tay TCP và tránh lỗi cạn kiệt cổng (Port/Socket Exhaustion).
2. **Fail-Fast & Timeout Chủ động:** Không bao giờ để một service phụ thuộc vào thời gian phản hồi vô hạn của service thứ ba. Phải có client timeout chủ động để giải phóng tài nguyên.
3. **Idempotency (Lũy quyền) là chìa khóa chống double-charge:** Mọi request thanh toán bắt buộc phải có `Idempotency-Key`. Khi gặp sự cố mạng (không rõ ngân hàng đã trừ hay chưa), client có thể tự tin retry với cùng khóa đó mà không lo bị trừ tiền hai lần.
4. **Phân loại lỗi chính xác (Transient vs Permanent):**
   - Chỉ retry các lỗi tạm thời (Transient Errors) như 500, đứt kết nối mạng.
   - Tuyệt đối không retry các lỗi nghiệp vụ dứt khoát (Client/Permanent Errors) như 400 (dữ liệu sai), 402 (vượt hạn mức), hoặc 503 khi service đích chưa online.
