const path = require('path');
const {
  httpGet,
  httpPost,
  spawnService,
  stopProcess,
  waitForServiceReady
} = require('./testHelper');

const FEE_SERVER_PATH = path.join(__dirname, '../fee-service/server.js');
const BANK_SERVER_PATH = path.join(__dirname, '../bank-service/server.js');

async function runScenario1() {
  console.log('\n' + '='.repeat(70));
  console.log('>>> CHẠY TÌNH HUỐNG 1: Ngân hàng không kết nối được, rồi hoạt động lại');
  console.log('='.repeat(70));

  let feeProcess = null;
  let bankProcess = null;

  try {
    console.log('[BƯỚC 1] Khởi động Fee Service (port 4001) trong khi Ngân hàng TẮT...');
    feeProcess = spawnService(FEE_SERVER_PATH, { FEE_PORT: '4001', BANK_URL: 'http://localhost:4002' });
    const feeReady = await waitForServiceReady('http://localhost:4001/students/1/fees');
    if (!feeReady) throw new Error('Fee Service không khởi động được');
    console.log('-> Fee Service đã sẵn sàng.');

    console.log('\n[BƯỚC 2] Gọi POST /students/1/payments với amount=100000 khi Ngân hàng TẮT:');
    const payRes1 = await httpPost('http://localhost:4001/students/1/payments', { amount: 100000 });
    console.log(`   - HTTP Status: ${payRes1.statusCode} (Kỳ vọng: 503)`);
    console.log(`   - Body: ${JSON.stringify(payRes1.data)}`);
    console.log(`   - Thời gian phản hồi: ${payRes1.duration}ms (Kỳ vọng: < 1500ms)`);

    const check1_503 = payRes1.statusCode === 503;
    const check1_hasError = payRes1.data && payRes1.data.error && payRes1.data.status === 'FAILED';
    const check1_fast = payRes1.duration < 1500;
    console.log(`   ✓ Tiêu chí 1: Trả 503, JSON có error, status FAILED -> ${check1_503 && check1_hasError ? 'ĐẠT' : 'KHÔNG ĐẠT'}`);
    console.log(`   ✓ Tiêu chí 2: Thời gian phản hồi < 1.5s (${payRes1.duration}ms) -> ${check1_fast ? 'ĐẠT' : 'KHÔNG ĐẠT'}`);

    console.log('\n[BƯỚC 3] Kiểm tra Fee Service có sống không và gọi GET /students/1/fees:');
    const feeCheck = await httpGet('http://localhost:4001/students/1/fees');
    console.log(`   - HTTP Status: ${feeCheck.statusCode} (Kỳ vọng: 200)`);
    console.log(`   - Body: ${JSON.stringify(feeCheck.data)}`);
    console.log(`   - Thời gian phản hồi: ${feeCheck.duration}ms (Kỳ vọng: < 300ms)`);
    const check2_alive = feeCheck.statusCode === 200 && feeCheck.data.debt === 50000000;
    const check2_fast = feeCheck.duration < 300;
    console.log(`   ✓ Tiêu chí 3: Fee Service không sập, công nợ giữ nguyên 50.000.000 -> ${check2_alive ? 'ĐẠT' : 'KHÔNG ĐẠT'}`);
    console.log(`   ✓ Tiêu chí 4: Xem công nợ phản hồi nhanh < 300ms (${feeCheck.duration}ms) -> ${check2_fast ? 'ĐẠT' : 'KHÔNG ĐẠT'}`);

    console.log('\n[BƯỚC 4] Bật Ngân hàng (port 4002) lên mà KHÔNG khởi động lại Fee Service...');
    bankProcess = spawnService(BANK_SERVER_PATH, { BANK_PORT: '4002' });
    const bankReady = await waitForServiceReady('http://localhost:4002/stats');
    if (!bankReady) throw new Error('Bank Service không khởi động được');
    console.log('-> Bank Service đã hoạt động.');

    console.log('\n[BƯỚC 5] Gọi lại POST /students/1/payments với amount=100000:');
    const payRes2 = await httpPost('http://localhost:4001/students/1/payments', { amount: 100000 });
    console.log(`   - HTTP Status: ${payRes2.statusCode} (Kỳ vọng: 201)`);
    console.log(`   - Body: ${JSON.stringify(payRes2.data)}`);
    console.log(`   - Thời gian phản hồi: ${payRes2.duration}ms`);
    const check3_recovered = payRes2.statusCode === 201 && payRes2.data.status === 'PAID';
    console.log(`   ✓ Tiêu chí 5: Ngân hàng chạy lại -> Trả 201 PAID không cần khởi động lại Fee Service -> ${check3_recovered ? 'ĐẠT' : 'KHÔNG ĐẠT'}`);

    const feeCheckAfter = await httpGet('http://localhost:4001/students/1/fees');
    console.log(`   - Công nợ sau thanh toán: ${feeCheckAfter.data.debt} (Đã trừ đúng 100.000đ: ${feeCheckAfter.data.debt === 49900000 ? 'ĐÚNG' : 'SAI'})`);

    console.log('\n[BƯỚC 6] Kiểm tra biến môi trường BANK_URL=http://localhost:4999 (port không tồn tại):');
    await stopProcess(feeProcess);
    feeProcess = spawnService(FEE_SERVER_PATH, { FEE_PORT: '4001', BANK_URL: 'http://localhost:4999' });
    await waitForServiceReady('http://localhost:4001/students/1/fees');

    const payRes3 = await httpPost('http://localhost:4001/students/1/payments', { amount: 100000 });
    console.log(`   - HTTP Status khi BANK_URL trỏ port 4999: ${payRes3.statusCode} (Kỳ vọng: 503)`);
    console.log(`   - Body: ${JSON.stringify(payRes3.data)}`);
    const check4_env = payRes3.statusCode === 503 && payRes3.data.status === 'FAILED';
    console.log(`   ✓ Tiêu chí 6: BANK_URL đổi sang port 4999 hành vi vẫn là 503 FAILED -> ${check4_env ? 'ĐẠT' : 'KHÔNG ĐẠT'}`);

    console.log('\n' + '-'.repeat(70));
    const allPassed = check1_503 && check1_hasError && check1_fast && check2_alive && check2_fast && check3_recovered && check4_env;
    console.log(`KẾT QUẢ TÌNH HUỐNG 1: ${allPassed ? '>>> TẤT CẢ TIÊU CHÍ ĐỀU ĐẠT <<<' : '>>> CÓ TIÊU CHÍ CHƯA ĐẠT <<<'}`);
    console.log('-'.repeat(70));
    return allPassed;
  } finally {
    if (feeProcess) await stopProcess(feeProcess);
    if (bankProcess) await stopProcess(bankProcess);
  }
}

if (require.main === module) {
  runScenario1().then((passed) => {
    process.exit(passed ? 0 : 1);
  });
}

module.exports = runScenario1;
