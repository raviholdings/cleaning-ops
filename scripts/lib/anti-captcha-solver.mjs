/**
 * Anti-Captcha (https://anti-captcha.com) ImageToText REST API Solver
 */

export async function solveCaptchaWithAntiCaptcha(imageBase64, apiKey = process.env.ANTI_CAPTCHA_API_KEY) {
  if (!apiKey) throw new Error('ANTI_CAPTCHA_API_KEY가 설정되어 있지 않습니다.');

  // 1. Create Task
  const createRes = await fetch('https://api.anti-captcha.com/createTask', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      clientKey: apiKey,
      task: {
        type: 'ImageToTextTask',
        body: imageBase64.replace(/^data:image\/\w+;base64,/, ''),
        phrase: false,
        case: false,
        numeric: 0,
        math: false,
        minLength: 0,
        maxLength: 0,
      },
    }),
  });

  const createData = await createRes.json();
  if (createData.errorId !== 0) {
    throw new Error(`Anti-Captcha createTask 에러: [${createData.errorCode}] ${createData.errorDescription}`);
  }

  const taskId = createData.taskId;
  console.log(`  [anti-captcha] Task 생성 완료 (ID: ${taskId}), 해독 대기 중...`);

  // 2. Poll Result (최대 30초 대기)
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 2000));

    const resultRes = await fetch('https://api.anti-captcha.com/getTaskResult', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        clientKey: apiKey,
        taskId,
      }),
    });

    const resultData = await resultRes.json();
    if (resultData.errorId !== 0) {
      throw new Error(`Anti-Captcha getTaskResult 에러: [${resultData.errorCode}] ${resultData.errorDescription}`);
    }

    if (resultData.status === 'ready') {
      const text = resultData.solution?.text || '';
      console.log(`  [anti-captcha] 캡차 자동 해독 성공: "${text}"`);
      return text;
    }
  }

  throw new Error('Anti-Captcha 해독 시간 초과 (30초)');
}
