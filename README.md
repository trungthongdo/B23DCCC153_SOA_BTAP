# LAB 3: KẾT NỐI VÀ DUY TRÌ KẾT NỐI GIỮA CÁC SERVICE

> **Học phần:** Xây dựng & Tích hợp Microservices  
> **Giảng viên:** ThS Nguyễn Việt Dũng  
> **Yêu cầu:** Node.js từ v18 trở lên, dữ liệu trong bộ nhớ (In-memory)

---

## 1. Giới thiệu Kiến trúc & Thành phần

Dự án mô phỏng hệ thống thanh toán học phí trực tuyến gồm 2 service:

1. **Fee Service (Cổng 4001):** Hệ thống quản lý học phí của trường.
   - Quản lý công nợ sinh viên (Sinh viên 1: 50.000.000đ, 2: 0đ, 3: 3.200.000đ).
   - Kiểm tra số tiền hợp lệ, không vượt công nợ, sinh mã lệnh tuần tự (P1, P2...).
   - Tích hợp HTTP Connection Pooling (`keepAlive: true`) để tái sử dụng TCP socket.
   - Cơ chế bảo vệ Timeout: $\le 4.0$s (tổng phản hồi $\le 4.5$s) tránh treo luồng.
   - Gửi kèm `Idempotency-Key` và tự động retry (tối đa 2 lần) khi gặp lỗi tạm thời (HTTP 500) hoặc đứt kết nối giữa chừng (`ECONNRESET`, `socket hang up`).
   - Tuyệt đối không retry khi ngân hàng từ chối dứt khoát (HTTP 4xx như 402 quá hạn mức) hoặc khi ngân hàng tắt hoàn toàn (`ECONNREFUSED` trả ngay 503 trong < 1.5s).

2. **Ngân hàng giả lập - Mock Bank (Cổng 4002):**
   - API trừ tiền `POST /charges` kèm cơ chế Idempotency chống trừ tiền trùng.
   - Thống kê thời gian thực `GET /stats`: `{ connections, requests, charges, duplicates }`.
   - Giữ kết nối TCP nhàn rỗi (Keep-Alive Idle Timeout) đúng 5 giây theo mặc định của Node.js.
   - Cấu hình các kịch bản lỗi qua biến môi trường:
     - `DELAY_MS`: Độ trễ mạng / quá tải ngân hàng (ms).
     - `FAIL_RATE`: Tỉ lệ trả về lỗi 500 trước khi trừ tiền (0 đến 1).
     - `DROP_RATE`: Tỉ lệ trừ tiền xong rồi ngắt kết nối TCP trước khi trả lời (0 đến 1).

---

## 2. Cài đặt và Hướng dẫn Khởi chạy

### Cài đặt thư viện
```bash
npm install
```

### Khởi chạy thủ công từng Service

**Khởi chạy Ngân hàng giả lập (Port 4002):**
```bash
# Chạy bình thường
npm run start:bank

# Hoặc chạy kèm biến môi trường mô phỏng sự cố:
# Chậm 5s:
DELAY_MS=5000 npm run start:bank

# Tỉ lệ đứt mạng sau trừ tiền 30%:
DROP_RATE=0.3 npm run start:bank

# Tỉ lệ lỗi 500 trước khi trừ tiền 30%:
FAIL_RATE=0.3 npm run start:bank
```

**Khởi chạy Fee Service (Port 4001):**
```bash
npm run start:fee
```

---

## 3. Chạy Toàn bộ Kịch bản Test Tự động

Dự án cung cấp bộ test tự động đo đạc đầy đủ các chỉ số của 4 tình huống:

```bash
# Chạy toàn bộ 4 kịch bản tự động
npm test

# Hoặc chạy riêng từng tình huống:
npm run test:scenario1   # Tình huống 1: Ngân hàng tắt, bật lại
npm run test:scenario2   # Tình huống 2: Ngân hàng chậm 5 giây
npm run test:scenario3   # Tình huống 3: Duy trì kết nối Keep-Alive
npm run test:scenario4   # Tình huống 4: DROP_RATE, FAIL_RATE & Vượt hạn mức
```

---

## 4. Đặc tả API

### A. Fee Service (Port 4001)

#### 1. Xem công nợ: `GET /students/:id/fees`
- **Response (200 OK):**
```json
{
  "studentId": "1",
  "name": "Sinh viên 1",
  "debt": 50000000
}
```

#### 2. Đóng học phí: `POST /students/:id/payments`
- **Request Body:**
```json
{
  "amount": 100000
}
```
- **Quy ước mã phản hồi & Trạng thái:**
  | Tình trạng | HTTP Code | `status` | Khi nào |
  | :--- | :---: | :---: | :--- |
  | **Thành công** | `201` | `PAID` | Ngân hàng xác nhận đã trừ tiền |
  | **Từ chối rõ ràng** | `402` / `400` | `FAILED` | Vượt hạn mức 20.000.000đ hoặc sai số tiền |
  | **Chắc chắn chưa trừ** | `503` | `FAILED` | Ngân hàng sập (`ECONNREFUSED`), trả trong < 1.5s |
  | **Không rõ đã trừ chưa** | `504` | `PENDING` | Quá thời gian chờ ($\le 4.5$s) hoặc đứt mạng |

### B. Ngân hàng giả lập (Port 4002)

#### 1. Trừ tiền: `POST /charges`
- **Headers:** `Idempotency-Key: P1`
- **Body:** `{"reference": "P1", "amount": 100000}`
- **Response (201 Created):**
```json
{
  "chargeId": "CHG_1_1792466692279",
  "reference": "P1",
  "amount": 100000,
  "status": "SUCCESS"
}
```

#### 2. Thống kê giám sát: `GET /stats`
- **Response:**
```json
{
  "connections": 13,
  "requests": 200,
  "charges": 200,
  "duplicates": 0
}
```
*(Lưu ý: `duplicates` phải luôn bằng 0).*
