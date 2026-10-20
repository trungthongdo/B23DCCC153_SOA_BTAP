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

async function runScenario4() {
  console.log('\n' + '='.repeat(70));
  console.log('>>> CHẠY TÌNH HUỐNG 4: Đứt giữa chừng, lỗi tạm thời, bị từ chối');
  console.log('='.repeat(70));

  let feeProcess = null;
  let bankProcess = null;

  try {
    console.log('\n[PHẦN 4A] Kiểm tra (a) DROP_RATE = 0.3 (đứt kết nối sau khi trừ tiền):');
    bankProcess = spawnService(BANK_SERVER_PATH, { BANK_PORT: '4002', DROP_RATE: '0.3' });
    await waitForServiceReady('http://localhost:4002/stats');

    feeProcess = spawnService(FEE_SERVER_PATH, { FEE_PORT: '4001', BANK_URL: 'http://localhost:4002' });
    await waitForServiceReady('http://localhost:4001/students/1/fees');

    await httpPost('http://localhost:4001/students/reset');
    const studentBefore4A = (await httpGet('http://localhost:4001/students/1/fees')).data;
    const initialDebt4A = studentBefore4A.debt;

    console.log(`   - Công nợ ban đầu Sinh viên 1: ${initialDebt4A} VND`);
    console.log('   - Gửi lần lượt 60 thanh toán (10.000đ mỗi lần)...');

    let paidCount4A = 0;
    let pendingCount4A = 0;
    let otherCount4A = 0;
    let maxDuration4A = 0;

    for (let i = 1; i <= 60; i++) {
      const res = await httpPost('http://localhost:4001/students/1/payments', { amount: 10000 });
      if (res.duration > maxDuration4A) maxDuration4A = res.duration;

      if (res.statusCode === 201 && res.data.status === 'PAID') {
        paidCount4A++;
      } else if (res.statusCode === 504 && res.data.status === 'PENDING') {
        pendingCount4A++;
      } else {
        otherCount4A++;
      }
    }

    const stats4A = (await httpGet('http://localhost:4002/stats')).data;
    const studentAfter4A = (await httpGet('http://localhost:4001/students/1/fees')).data;
    const expectedDebt4A = initialDebt4A - (paidCount4A * 10000);

    console.log(`   - Kết quả 60 thanh toán: PAID = ${paidCount4A}, PENDING = ${pendingCount4A}, Khác = ${otherCount4A}`);
    console.log(`   - Thống kê tại Ngân hàng: charges = ${stats4A.charges}, duplicates = ${stats4A.duplicates}`);
    console.log(`   - Công nợ thực tế: ${studentAfter4A.debt} VND | Công nợ kỳ vọng: ${expectedDebt4A} VND`);
    console.log(`   - Thời gian xử lý lớn nhất: ${maxDuration4A}ms (Kỳ vọng: <= 4500ms)`);

    const check4A_dup = stats4A.duplicates === 0;
    const check4A_success = paidCount4A >= 54;
    const check4A_pending = otherCount4A === 0;
    const check4A_debt = studentAfter4A.debt === expectedDebt4A;
    const check4A_time = maxDuration4A <= 4500;

    console.log(`   ✓ Tiêu chí (a).1: duplicates = 0 -> ${check4A_dup ? 'ĐẠT' : 'KHÔNG ĐẠT'}`);
    console.log(`   ✓ Tiêu chí (a).2: >= 54/60 thanh toán thành công (${paidCount4A}/60) -> ${check4A_success ? 'ĐẠT' : 'KHÔNG ĐẠT'}`);
    console.log(`   ✓ Tiêu chí (a).3: Các giao dịch không thành công trả 504 + PENDING -> ${check4A_pending ? 'ĐẠT' : 'KHÔNG ĐẠT'}`);
    console.log(`   ✓ Tiêu chí (a).4: Công nợ chỉ giảm đúng số tiền của các lệnh PAID -> ${check4A_debt ? 'ĐẠT' : 'KHÔNG ĐẠT'}`);

    await stopProcess(feeProcess);
    await stopProcess(bankProcess);
    await sleep(500);

    console.log('\n[PHẦN 4B] Kiểm tra (b) FAIL_RATE = 0.3 (lỗi 500 trước khi trừ tiền):');
    bankProcess = spawnService(BANK_SERVER_PATH, { BANK_PORT: '4002', FAIL_RATE: '0.3' });
    await waitForServiceReady('http://localhost:4002/stats');

    feeProcess = spawnService(FEE_SERVER_PATH, { FEE_PORT: '4001', BANK_URL: 'http://localhost:4002' });
    await waitForServiceReady('http://localhost:4001/students/1/fees');

    await httpPost('http://localhost:4001/students/reset');
    console.log('   - Gửi lần lượt 60 thanh toán (10.000đ mỗi lần)...');

    let paidCount4B = 0;
    let maxDuration4B = 0;

    for (let i = 1; i <= 60; i++) {
      const res = await httpPost('http://localhost:4001/students/1/payments', { amount: 10000 });
      if (res.duration > maxDuration4B) maxDuration4B = res.duration;
      if (res.statusCode === 201 && res.data.status === 'PAID') {
        paidCount4B++;
      }
    }

    const stats4B = (await httpGet('http://localhost:4002/stats')).data;
    console.log(`   - Kết quả 60 thanh toán: PAID = ${paidCount4B}/60`);
    console.log(`   - Thống kê tại Ngân hàng: charges = ${stats4B.charges}, duplicates = ${stats4B.duplicates}`);

    const check4B_success = paidCount4B >= 54;
    const check4B_noDup = stats4B.duplicates === 0;
    const check4B_time = maxDuration4B <= 4500;

    console.log(`   ✓ Tiêu chí (b).1: >= 54/60 thanh toán thành công (${paidCount4B}/60) -> ${check4B_success ? 'ĐẠT' : 'KHÔNG ĐẠT'}`);
    console.log(`   ✓ Tiêu chí (b).2: Không trừ tiền 2 lần (duplicates = 0) -> ${check4B_noDup ? 'ĐẠT' : 'KHÔNG ĐẠT'}`);

    await stopProcess(feeProcess);
    await stopProcess(bankProcess);
    await sleep(500);

    console.log('\n[PHẦN 4C] Kiểm tra (c) Thanh toán 25.000.000đ (vượt hạn mức):');
    bankProcess = spawnService(BANK_SERVER_PATH, { BANK_PORT: '4002' });
    await waitForServiceReady('http://localhost:4002/stats');

    feeProcess = spawnService(FEE_SERVER_PATH, { FEE_PORT: '4001', BANK_URL: 'http://localhost:4002' });
    await waitForServiceReady('http://localhost:4001/students/1/fees');

    await httpPost('http://localhost:4001/students/reset');
    await httpPost('http://localhost:4002/stats/reset');

    const statsBefore4C = (await httpGet('http://localhost:4002/stats')).data;
    console.log(`   - Số request tại ngân hàng trước gọi: ${statsBefore4C.requests}`);

    console.log('   - Gửi thanh toán 25.000.000đ cho Sinh viên 1 (nợ 50.000.000đ)...');
    const payRes4C = await httpPost('http://localhost:4001/students/1/payments', { amount: 25000000 });
    console.log(`   - HTTP Status nhận được: ${payRes4C.statusCode} (Kỳ vọng: 402)`);
    console.log(`   - Body: ${JSON.stringify(payRes4C.data)}`);
    console.log(`   - Thời gian phản hồi: ${payRes4C.duration}ms`);

    const statsAfter4C = (await httpGet('http://localhost:4002/stats')).data;
    const requestsDelta4C = statsAfter4C.requests - statsBefore4C.requests;
    console.log(`   - Số request ngân hàng nhận thêm: ${requestsDelta4C} (Kỳ vọng: đúng 1 yêu cầu)`);

    const check4C_402 = payRes4C.statusCode === 402;
    const check4C_failed = payRes4C.data && payRes4C.data.status === 'FAILED';
    const check4C_exactOneReq = requestsDelta4C === 1;
    const check4C_time = payRes4C.duration <= 4500;

    console.log(`   ✓ Tiêu chí (c).1: Trả HTTP 402 + status FAILED -> ${check4C_402 && check4C_failed ? 'ĐẠT' : 'KHÔNG ĐẠT'}`);
    console.log(`   ✓ Tiêu chí (c).2: Ngân hàng chỉ nhận đúng 1 yêu cầu (không thử lại) -> ${check4C_exactOneReq ? 'ĐẠT' : 'KHÔNG ĐẠT'}`);
    console.log(`   ✓ Tiêu chí chung: Vẫn giữ giới hạn <= 4.5s (${payRes4C.duration}ms) -> ${check4C_time ? 'ĐẠT' : 'KHÔNG ĐẠT'}`);

    console.log('\n' + '-'.repeat(70));
    const allPassed =
      check4A_dup && check4A_success && check4A_pending && check4A_debt && check4A_time &&
      check4B_success && check4B_noDup && check4B_time &&
      check4C_402 && check4C_failed && check4C_exactOneReq && check4C_time;

    console.log(`KẾT QUẢ TÌNH HUỐNG 4: ${allPassed ? '>>> TẤT CẢ TIÊU CHÍ ĐỀU ĐẠT <<<' : '>>> CÓ TIÊU CHÍ CHƯA ĐẠT <<<'}`);
    console.log('-'.repeat(70));
    return allPassed;
  } finally {
    if (feeProcess) await stopProcess(feeProcess);
    if (bankProcess) await stopProcess(bankProcess);
  }
}

if (require.main === module) {
  runScenario4().then((passed) => {
    process.exit(passed ? 0 : 1);
  });
}

module.exports = runScenario4;
