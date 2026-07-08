export default async function handler(request, response) {
  if (request.method !== 'POST') {
    return response.status(200).send('Бот працює штатно!');
  }

  try {
    const { message } = request.body;
    if (!message || !message.text) {
      return response.status(200).send('OK');
    }

    const chatId = message.chat.id;
    const text = message.text.trim();
    const username = message.from.username || 'Без юзернейму';
    const firstName = message.from.first_name || 'Користувач';

    // Обробка команди /start
    if (text === '/start') {
      const botToken = process.env.BOT_TOKEN;
      const dbUrl = process.env.FIREBASE_DATABASE_URL.replace(/\/$/, ''); // Прибираємо зайвий слеш в кінці, якщо він є
      const webAppUrl = 'https://wood-grow-task.vercel.app/';

      // 1. ПЕРЕВІРКА ТА РЕЄСТРАЦІЯ У FIREBASE (через REST API з маленької літери task_users)
      const userUrl = `${dbUrl}/task_users/${chatId}.json`;
      
      // Перевіряємо, чи є вже такий замовник в базі
      const checkRes = await fetch(userUrl);
      const userData = await checkRes.json();

      // Якщо користувача немає — створюємо новий профіль
      if (!userData) {
        const newUser = {
          username: username,
          first_name: firstName,
          balance: 0.00,
          role: 'advertiser',
          registered_at: Math.floor(Date.now() / 1000)
        };

        // Записуємо дані в Firebase
        await fetch(userUrl, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(newUser)
        });
      }

      // 2. НАДСИЛАННЯ ПРИВІТАННЯ В TELEGRAM
      const telegramUrl = `https://api.telegram.org/bot${botToken}/sendMessage`;
      const payload = {
        chat_id: chatId,
        text: `*Вітаємо у WoodGrow TASK, ${firstName}! 💻*\n\nТут ви можете замовити просування ваших проєктів та керувати завданнями.\n\nНатисніть кнопку нижче, щоб відкрити свій персональний графічний кабінет.`,
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
