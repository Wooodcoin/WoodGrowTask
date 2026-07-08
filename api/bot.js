export default async function handler(request, response) {
  // Перевіряємо, що запит прийшов методом POST від Telegram
  if (request.method !== 'POST') {
    return response.status(200).send('Бот працює штатно!');
  }

  try {
    const { message } = request.body;

    // Якщо в запиті немає повідомлення (наприклад, це сервісне сповіщення), просто ігноруємо
    if (!message || !message.text) {
      return response.status(200).send('OK');
    }

    const chatId = message.chat.id;
    const text = message.text.trim();

    // Обробка команди /start
    if (text === '/start') {
      const botToken = process.env.BOT_TOKEN;
      const webAppUrl = 'https://wood-grow-task.vercel.app/'; // Посилання на наш майбутній графічний кабінет

      const telegramUrl = `https://api.telegram.org/bot${botToken}/sendMessage`;

      // Формуємо текст привітання та графічну WebApp кнопку
      const payload = {
        chat_id: chatId,
        text: `*Вітаємо у WoodGrow TASK! 💻*\n\nТут ви можете замовити просування ваших Telegram-постів за допомогою лайків.\n\nНатисніть кнопку нижче, щоб відкрити свій персональний графічний кабінет замовника.`,
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: '🚀 Відкрити WoodGrow TASK',
                web_app: { url: webAppUrl }
              }
            ]
          ]
        }
      };

      // Надсилаємо запит в Telegram
      await fetch(telegramUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
    }

    return response.status(200).send('OK');
  } catch (error) {
    console.error('Помилка бота:', error);
    return response.status(200).send('Error');
  }
}

