// 내 텔레그램 chat id 를 알아내는 일회용 도구.
// 실행 후, 만든 봇에게 아무 메시지나 보내면 chat id 가 출력됩니다.
import { loadEnv, requireSecrets } from './lib/env.mjs';
import { getUpdates } from './lib/telegram.mjs';

loadEnv();
requireSecrets(['TELEGRAM_BOT_TOKEN']);

console.log('봇에게 텔레그램으로 아무 메시지나 보내세요… (Ctrl+C 로 종료)');
let offset = 0;
for (;;) {
  const updates = await getUpdates(offset, 50);
  for (const u of updates) {
    offset = u.update_id + 1;
    const msg = u.message || u.edited_message;
    if (msg?.chat) {
      const c = msg.chat;
      console.log(
        `\n✅ chat id = ${c.id}  (${c.first_name || ''} ${c.username ? '@' + c.username : ''})`
      );
      console.log('→ 이 숫자를 automation/.env 의 TELEGRAM_CHAT_ID 에 넣으세요.');
    }
  }
}
