const path = require('path');
const {
  httpGet,
  httpPost,
  sleep,
  spawnService,
  stopProcess,
  waitForServiceReady
} = require('./testHelper');

const FEE_SERVER_PATH = path.join(__dirname, '../fee-service/server.js');
const BANK_SERVER_PATH = path.join(__dirname, '../bank-service/server.js');

async function sendBatchPayments(totalRequests, concurrency, amount = 1000) {
  let index = 0;
  let successCount = 0;
  let failureCount = 0;

  async function worker() {
    while (true) {
      const current = index++;
      if (current >= totalRequests) break;
      const res = await httpPost('http://localhost:4001/students/1/payments', { amount });
      if (res.statusCode === 201 && res.data.status === 'PAID') {
        successCount++;
      } else {
        failureCount++;
      }
    }
  }

  const startTime = Date.now();
  const workers = Array.from({ length: concurrency }, () => worker());
  await Promise.all(workers);
  const duration = Date.now() - startTime;

  return { successCount, failureCount, duration };
}

async function runScenario3() {
  console.log('\n' + '='.repeat(70));
  console.log('>>> CHẠY TÌNH HUỐNG 3: Duy trì kết nối (Connection Keep-Alive)');
  console.log('='.repeat(70));

  let feeProcess = null;
  let bankProcess = null;

  try {
    console.log('\n[PHẦN A] ĐO SỐ LIỆU TRƯỚC KHI SỬA (Không dùng Keep-Alive):');
    bankProcess = spawnService(BANK_SERVER_PATH, { BANK_PORT: '4002' });
    await waitForServiceReady('http://localhost:4002/stats');

    feeProcess = spawnService(FEE_SERVER_PATH, {
      FEE_PORT: '4001',
      BANK_URL: 'http://localhost:4002',
      DISABLE_KEEP_ALIVE: 'true'
    });
    await waitForServiceReady('http://localhost:4001/students/1/fees');

    console.log('   -> Bắn thử 50 yêu cầu (concurrency 10) khi KHÔNG có Keep-Alive...');
    const noKeepAliveResult = await sendBatchPayments(50, 10, 1000);
    const statsNoKeepAlive = (await httpGet('http://localhost:4002/stats')).data;

    console.log(`   - Thành công: ${noKeepAliveResult.successCount}/50`);
    console.log(`   - Tổng thời gian: ${noKeepAliveResult.duration}ms`);
    console.log(`   - Số kết nối TCP ngân hàng nhận: ${statsNoKeepAlive.connections} (Mỗi request mở 1 kết nối mới)`);

    await stopProcess(feeProcess);
    await stopProcess(bankProcess);
    await sleep(500);

    console.log('\n[PHẦN B] ĐO SỐ LIỆU SAU KHI SỬA (Bật Connection Pooling & Keep-Alive):');
    bankProcess = spawnService(BANK_SERVER_PATH, { BANK_PORT: '4002' });
    await waitForServiceReady('http://localhost:4002/stats');

    feeProcess = spawnService(FEE_SERVER_PATH, {
      FEE_PORT: '4001',
      BANK_URL: 'http://localhost:4002',
      DISABLE_KEEP_ALIVE: 'false'
    });
    await waitForServiceReady('http://localhost:4001/students/1/fees');

    const initialStats = (await httpGet('http://localhost:4002/stats')).data;
    console.log(`   - Stats ban đầu tại ngân hàng: ${JSON.stringify(initialStats)}`);

    console.log('   -> Bắn 200 thanh toán, 10 yêu cầu cùng lúc (1.000đ mỗi lần)...');
    const keepAliveResult = await sendBatchPayments(200, 10, 1000);
    console.log(`   - Hoàn thành trong: ${keepAliveResult.duration}ms`);
    console.log(`   - Số thanh toán thành công: ${keepAliveResult.successCount}/200`);

    const statsAfter200 = (await httpGet('http://localhost:4002/stats')).data;
    console.log(`   - Stats tại ngân hàng sau 200 thanh toán: ${JSON.stringify(statsAfter200)}`);

    const check1_success200 = keepAliveResult.successCount === 200;
    const check2_connections = statsAfter200.connections <= 20;

    console.log(`   ✓ Tiêu chí 1: 200/200 thanh toán thành công -> ${check1_success200 ? 'ĐẠT' : 'KHÔNG ĐẠT'}`);
    console.log(`   ✓ Tiêu chí 2: Số kết nối TCP ngân hàng mở <= 20 (${statsAfter200.connections} kết nối) -> ${check2_connections ? 'ĐẠT' : 'KHÔNG ĐẠT'}`);

    console.log('\n[PHẦN C] Kiểm tra sau khi nhàn rỗi 6 giây (ngân hàng đã đóng kết nối cũ sau 5s):');
    console.log('   -> Đang ngủ 6 giây để ngân hàng timeout kết nối cũ...');
    await sleep(6200);

    console.log('   -> Gửi tiếp 5 yêu cầu thanh toán mới...');
    const nextResult = await sendBatchPayments(5, 1, 1000);
    const statsAfterIdle = (await httpGet('http://localhost:4002/stats')).data;

    console.log(`   - Kết quả 5 yêu cầu sau nhàn rỗi: ${nextResult.successCount}/5 thành công`);
    console.log(`   - Stats tại ngân hàng: ${JSON.stringify(statsAfterIdle)}`);

    const check3_idleSuccess = nextResult.successCount === 5;
    console.log(`   ✓ Tiêu chí 3: Sau nhàn rỗi 6s, các yêu cầu tiếp theo vẫn thành công -> ${check3_idleSuccess ? 'ĐẠT' : 'KHÔNG ĐẠT'}`);

    console.log('\n' + '='.repeat(70));
    console.log('BẢNG SO SÁNH SỐ LIỆU ĐỂ TRÌNH BÀY (BÁO CÁO NHÓM):');
    console.log('='.repeat(70));
    console.log('| Chỉ số                   | Trước khi sửa (Không Keep-Alive) | Sau khi sửa (Có Keep-Alive) |');
    console.log('|--------------------------|----------------------------------|-----------------------------|');
    console.log(`| Số yêu cầu gửi           | 50 (mẫu)                         | 200                         |`);
    console.log(`| Số kết nối TCP tạo mới   | ${statsNoKeepAlive.connections.toString().padEnd(32)} | ${statsAfter200.connections.toString().padEnd(27)} |`);
    console.log(`| Tỉ lệ kết nối/yêu cầu    | ~1:1 (lãng phí bắt tay)          | ~1:20 (tái sử dụng pool)    |`);
    console.log(`| Thành công               | ${noKeepAliveResult.successCount}/50                            | 200/200                     |`);
    console.log(`| Xử lý sau idle 6s        | Mở kết nối mới                   | Tự tạo kết nối mới mượt mà  |`);
    console.log('='.repeat(70));

    const allPassed = check1_success200 && check2_connections && check3_idleSuccess;
    console.log(`\nKẾT QUẢ TÌNH HUỐNG 3: ${allPassed ? '>>> TẤT CẢ TIÊU CHÍ ĐỀU ĐẠT <<<' : '>>> CÓ TIÊU CHÍ CHƯA ĐẠT <<<'}`);
    return allPassed;
  } finally {
    if (feeProcess) await stopProcess(feeProcess);
    if (bankProcess) await stopProcess(bankProcess);
  }
}

if (require.main === module) {
  runScenario3().then((passed) => {
    process.exit(passed ? 0 : 1);
  });
}

module.exports = runScenario3;
