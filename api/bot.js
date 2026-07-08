import admin from 'firebase-admin';

// Ініціалізуємо Firebase Admin SDK, якщо він ще не ініціалізований
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
  // Перевіряємо, що запит прийшов методом POST від Telegram
  if (request.method !== 'POST') {
    return response.status(200).send('Бот працює штатно!');
  }

  try {
    const { message } = request.body;

    // Якщо в запиті немає повідомлення, просто ігноруємо
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
      const webAppUrl = 'https://wood-grow-task.vercel.app/';

      // 1. РЕЄСТРАЦІЯ У FIREBASE (Гілка task_users з маленької літери)
      const userRef = db.ref(`task_users/${chatId}`);
      const userSnapshot = await userRef.once('value');
      const userData = userSnapshot.val();

      // Якщо замовника ще немає в базі — створюємо новий профіль
      if (!userData) {
        await userRef.set({
          username: username,
          first_name: firstName,
          balance: 0.00,
          role: 'advertiser',
          registered_at: Math.floor(Date.now() / 1000)
        });
      }

      // 2. НАДСИЛАННЯ ПОВІДОМЛЕННЯ В TELEGRAM
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

      // Відправка запиту в Telegram
      await fetch(telegramUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
    }

    return response.status(200).send('OK');
  } catch (error) {
    console.error('Помилка у bot handler:', error);
    return response.status(200).send('Error');
  }
}
