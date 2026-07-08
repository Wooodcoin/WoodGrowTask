import admin from 'firebase-admin';

// Ініціалізуємо Firebase Admin SDK
if (!admin.apps.length) {
    try {
        const base64Key = process.env.FIREBASE_SERVICE_ACCOUNT;
        
        if (!base64Key) {
            console.error('КРИТИЧНА ПОМИЛКА: Змінна FIREBASE_SERVICE_ACCOUNT порожня у Vercel!');
        } else {
            const decodedJson = Buffer.from(base64Key, 'base64').toString('utf-8');
            const serviceAccount = JSON.parse(decodedJson);
            
            admin.initializeApp({
                credential: admin.credential.cert(serviceAccount),
                databaseURL: "https://woodgrowbot-default-rtdb.europe-west1.firebasedatabase.app"
            });
        }
    } catch (error) {
        console.error('Firebase admin initialization error:', error);
    }
}

const db = admin.database();

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

    if (text === '/start') {
      // Використовуємо ТВОЮ точну змінну з Vercel
      const botToken = process.env.TELEGRAM_BOT_TOKEN; 
      const webAppUrl = 'https://wood-grow-task.vercel.app/';

      if (!botToken) {
        console.error('Помилка: TELEGRAM_BOT_TOKEN не знайдено в оточенні!');
        return response.status(200).send('OK');
      }

      // 1. РЕЄСТРАЦІЯ У FIREBASE (як Супер-Адмін через SDK)
      try {
        const userRef = db.ref(`task_users/${chatId}`);
        const userSnapshot = await userRef.once('value');
        const userData = userSnapshot.val();

        if (!userData) {
          await userRef.set({
            username: username,
            first_name: firstName,
            balance: 0.00,
            role: 'advertiser',
            registered_at: Math.floor(Date.now() / 1000)
          });
        }
      } catch (dbError) {
        console.error('Помилка запису в Firebase:', dbError);
      }

      // 2. НАДСИЛАННЯ ПОВІДОМЛЕННЯ В TELEGRAM (через стандартний HTTPS модуль)
      const telegramUrl = `https://api.telegram.org/bot${botToken}/sendMessage`;
      
      const payload = {
        chat_id: chatId,
        text: `*Вітаємо у WoodGrow TASK, ${firstName}! 💻*\n\nТут ви можете замовити просування ваших Telegram-постів за допомогою лайків.\n\nНатисніть кнопку нижче, щоб відкрити свій персональний графічний кабінет замовника.`,
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

      // Використовуємо глобальний fetch для відправки
      await fetch(telegramUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
    }

    return response.status(200).send('OK');
  } catch (error) {
    console.error('Загальна помилка бота:', error);
    return response.status(200).send('Error');
  }
}
