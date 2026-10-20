const runScenario1 = require('./scenario1-bank-down');
const runScenario2 = require('./scenario2-slow-bank');
const runScenario3 = require('./scenario3-keepalive');
const runScenario4 = require('./scenario4-drop-fail-limit');
const { stopAllProcesses, sleep } = require('./testHelper');

async function main() {
  console.log('\n' + '#'.repeat(75));
  console.log('#   BẮT ĐẦU CHẠY TOÀN BỘ BÀI THỰC HÀNH LAB 3 - 4 TÌNH HUỐNG SỰ CỐ          #');
  console.log('#   Học phần: Kết nối và duy trì kết nối giữa các service                  #');
  console.log('#'.repeat(75));

  const results = {};

  try {
    console.log('\n>>> Đang thực thi Tình huống 1...');
    results['Tình huống 1: Ngân hàng ngắt kết nối'] = await runScenario1();
    await stopAllProcesses();
    await sleep(1000);

    console.log('\n>>> Đang thực thi Tình huống 2...');
    results['Tình huống 2: Ngân hàng phản hồi chậm'] = await runScenario2();
    await stopAllProcesses();
    await sleep(1000);

    console.log('\n>>> Đang thực thi Tình huống 3...');
    results['Tình huống 3: Duy trì kết nối TCP'] = await runScenario3();
    await stopAllProcesses();
    await sleep(1000);

    console.log('\n>>> Đang thực thi Tình huống 4...');
    results['Tình huống 4: Đứt kết nối / Lỗi 500 / Từ chối'] = await runScenario4();
    await stopAllProcesses();

    console.log('\n' + '='.repeat(75));
    console.log('TỔNG HỢP KẾT QUẢ ĐÁNH GIÁ 4 TÌNH HUỐNG (LAB 3):');
    console.log('='.repeat(75));
    let allPassed = true;
    for (const [scenario, passed] of Object.entries(results)) {
      const statusText = passed ? '✅ ĐẠT 100% TIÊU CHÍ' : '❌ CHƯA ĐẠT';
      console.log(`- ${scenario.padEnd(48)}: ${statusText}`);
      if (!passed) allPassed = false;
    }
    console.log('='.repeat(75));
    console.log(`KẾT LUẬN CHUNG: ${allPassed ? '🎉 TOÀN BỘ BÀI LAB ĐẠT YÊU CẦU XUẤT SẮC!' : '⚠️ CẦN KIỂM TRA LẠI'}`);
    console.log('='.repeat(75) + '\n');

    process.exit(allPassed ? 0 : 1);
  } catch (err) {
    console.error('Lỗi nghiêm trọng khi chạy bài test:', err);
    await stopAllProcesses();
    process.exit(1);
  }
}

main();
