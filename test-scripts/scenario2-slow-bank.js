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

async function runScenario2() {
  console.log('\n' + '='.repeat(70));
  console.log('>>> CHẠY TÌNH HUỐNG 2: Ngân hàng phản hồi rất chậm (DELAY_MS=5000)');
  console.log('='.repeat(70));

  let feeProcess = null;
  let bankProcess = null;

  try {
    console.log('[BƯỚC 1] Khởi động Ngân hàng (port 4002) với DELAY_MS=5000...');
    bankProcess = spawnService(BANK_SERVER_PATH, { BANK_PORT: '4002', DELAY_MS: '5000' });
    const bankReady = await waitForServiceReady('http://localhost:4002/stats');
    if (!bankReady) throw new Error('Bank Service không khởi động được');

    console.log('[BƯỚC 2] Khởi động Fee Service (port 4001)...');
    feeProcess = spawnService(FEE_SERVER_PATH, { FEE_PORT: '4001', BANK_URL: 'http://localhost:4002' });
    const feeReady = await waitForServiceReady('http://localhost:4001/students/1/fees');
    if (!feeReady) throw new Error('Fee Service không khởi động được');

    console.log('\n[BƯỚC 3] Gửi 1 thanh toán POST /students/1/payments và đo thời gian chờ:');
    const payRes = await httpPost('http://localhost:4001/students/1/payments', { amount: 100000 });
    console.log(`   - HTTP Status: ${payRes.statusCode} (Kỳ vọng: 504)`);
    console.log(`   - Body: ${JSON.stringify(payRes.data)}`);
    console.log(`   - Tổng thời gian: ${payRes.duration}ms (Kỳ vọng: <= 4500ms)`);

    const check1_504 = payRes.statusCode === 504;
    const check1_pending = payRes.data && payRes.data.status === 'PENDING';
    const check1_timeout = payRes.duration <= 4500;
    console.log(`   ✓ Tiêu chí 1: Trả 504 với status "PENDING" -> ${check1_504 && check1_pending ? 'ĐẠT' : 'KHÔNG ĐẠT'}`);
    console.log(`   ✓ Tiêu chí 2: Tổng thời gian trả lời <= 4,5 giây (${payRes.duration}ms) -> ${check1_timeout ? 'ĐẠT' : 'KHÔNG ĐẠT'}`);

    console.log('\n[BƯỚC 4] Bắn đồng thời 20 yêu cầu thanh toán...');
    const startBatch = Date.now();
    const paymentPromises = Array.from({ length: 20 }, () =>
      httpPost('http://localhost:4001/students/1/payments', { amount: 1000 })
    );

    await sleep(1000);

    console.log('   -> Trong lúc 20 thanh toán đang chờ, gọi GET /students/1/fees:');
    const feeCheckRes = await httpGet('http://localhost:4001/students/1/fees');
    console.log(`   - GET /students/1/fees Status: ${feeCheckRes.statusCode}`);
    console.log(`   - Thời gian phản hồi của GET /fees: ${feeCheckRes.duration}ms (Kỳ vọng: < 300ms)`);

    const check2_feeFast = feeCheckRes.statusCode === 200 && feeCheckRes.duration < 300;
    console.log(`   ✓ Tiêu chí 3: Khi 20 thanh toán đang chờ, GET /fees vẫn phản hồi < 300ms (${feeCheckRes.duration}ms) -> ${check2_feeFast ? 'ĐẠT' : 'KHÔNG ĐẠT'}`);

    console.log('   -> Chờ 20 thanh toán hoàn tất...');
    const results = await Promise.all(paymentPromises);
    const totalBatchDuration = Date.now() - startBatch;
    console.log(`   -> 20 thanh toán kết thúc sau ${totalBatchDuration}ms.`);

    const all504 = results.every((r) => r.statusCode === 504 && r.data.status === 'PENDING');
    const allUnderLimit = results.every((r) => r.duration <= 4500);
    console.log(`   - Cả 20/20 yêu cầu đều trả 504 PENDING: ${all504 ? 'ĐÚNG' : 'SAI'}`);
    console.log(`   - Cả 20/20 yêu cầu đều có thời gian <= 4500ms: ${allUnderLimit ? 'ĐÚNG' : 'SAI'}`);

    console.log('\n' + '-'.repeat(70));
    const allPassed = check1_504 && check1_pending && check1_timeout && check2_feeFast && all504 && allUnderLimit;
    console.log(`KẾT QUẢ TÌNH HUỐNG 2: ${allPassed ? '>>> TẤT CẢ TIÊU CHÍ ĐỀU ĐẠT <<<' : '>>> CÓ TIÊU CHÍ CHƯA ĐẠT <<<'}`);
    console.log('-'.repeat(70));
    return allPassed;
  } finally {
    if (feeProcess) await stopProcess(feeProcess);
    if (bankProcess) await stopProcess(bankProcess);
  }
}

if (require.main === module) {
  runScenario2().then((passed) => {
    process.exit(passed ? 0 : 1);
  });
}

module.exports = runScenario2;
