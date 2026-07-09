import admin from 'firebase-admin';

if (!admin.apps.length) {
    try {
        const rawKey = process.env.FIREBASE_SERVICE_ACCOUNT;
        const decryptedKey = rawKey.startsWith('ewog') ? Buffer.from(rawKey, 'base64').toString('utf-8') : rawKey;
        const serviceAccount = JSON.parse(decryptedKey);
        admin.initializeApp({
            credential: admin.credential.cert(serviceAccount),
            databaseURL: "https://woodgrowbot-default-rtdb.europe-west1.firebasedatabase.app"
        });
    } catch (error) {
        console.error('Firebase initialization error:', error);
    }
}

const db = admin.database();
const SUPER_ADMIN_ID = "6043278492"; // Твій Telegram ID (з файлу індексу)

export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    const { userId, initData, taskLink } = req.body;

    if (!userId || !initData || !taskLink) {
        return res.status(400).json({ error: 'Missing parameters' });
    }

    const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
    if (!BOT_TOKEN) return res.status(500).json({ error: 'Server configuration missing' });

    // 1. Валідація Telegram InitData
    try {
        const urlParams = new URLSearchParams(initData);
        const hash = urlParams.get('hash');
        urlParams.delete('hash');
        const dataCheckString = Array.from(urlParams.entries()).map(([k, v]) => `${k}=${v}`).sort().join('\n');
        const encoder = new TextEncoder();
        const secretKeyMaterial = await crypto.subtle.importKey("raw", encoder.encode("WebAppData"), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
        const secretKeyBuffer = await crypto.subtle.sign("HMAC", secretKeyMaterial, encoder.encode(BOT_TOKEN));
        const checkKeyMaterial = await crypto.subtle.importKey("raw", secretKeyBuffer, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
        const signatureBuffer = await crypto.subtle.sign("HMAC", checkKeyMaterial, encoder.encode(dataCheckString));
        const calculatedHash = Array.from(new Uint8Array(signatureBuffer)).map(b => b.toString(16).padStart(2, '0')).join('');
        
        if (calculatedHash !== hash) return res.status(403).json({ error: 'Auth failed' });
    } catch (err) {
        return res.status(500).json({ error: 'Telegram validation error' });
    }

    try {
        const isSuperAdmin = (userId.toString() === SUPER_ADMIN_ID);
        const advRef = db.ref(`task_users/${userId}`);
        
        let currentBalance = 0;

        if (!isSuperAdmin) {
            // Перевіряємо баланс звичайного рекламодавця
            const advSnapshot = await advRef.once('value');
            if (!advSnapshot.exists()) return res.status(444).json({ error: 'Advertiser profile not found' });
            
            currentBalance = parseFloat(advSnapshot.val().balance) || 0;

            if (currentBalance < 0.04) {
                return res.status(400).json({ error: 'Insufficient balance. Need 0.04 USDT' });
            }

            // Списуємо вартість пакету
            const newBalance = currentBalance - 0.04;
            await advRef.update({ balance: newBalance });
        }

        // 2. Додаємо завдання у загальну гілку для основної апки користувачів "tasks"
        const globalTasksRef = db.ref('tasks').push();
        const taskId = globalTasksRef.key;
        const timestamp = new Date().toISOString();

        const newTaskData = {
            id: taskId,
            creatorId: userId,
            link: taskLink,
            reward: 0.0005,         // Скільки отримає звичайний користувач за 1 лайк
            required_views: 26,     // Ліміт 20 + 6 штук захисного запасу для абузерів
            current_views: 0,
            status: "active",
            createdAt: timestamp
        };

        await globalTasksRef.set(newTaskData);

        // Також дублюємо запис у кабінет самого рекламодавця для вкладки "Прогрес"
        await db.ref(`task_users/${userId}/my_campaigns/${taskId}`).set({
            id: taskId,
            link: taskLink,
            ordered_views: 20,      // Замовник бачить чисті 20
            createdAt: timestamp
        });

        return res.status(200).json({
            success: true,
            message: isSuperAdmin ? 'Task created for free (Admin mode)' : 'Task created successfully, 0.04 USDT debited',
            taskId: taskId
        });

    } catch (e) {
        console.error("Error creating task:", e);
        return res.status(500).json({ error: 'Database transaction error' });
    }
}
