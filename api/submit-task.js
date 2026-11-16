// api/submit-task.js

import admin from 'firebase-admin';
import Busboy from 'busboy';

if (!admin.apps.length) {
    try {
        const rawKey = process.env.FIREBASE_SERVICE_ACCOUNT;
        const decryptedKey = rawKey.startsWith('ewog') ? Buffer.from(rawKey, 'base64').toString('utf-8') : rawKey;
        const serviceAccount = JSON.parse(decryptedKey);
        admin.initializeApp({
            credential: admin.credential.cert(serviceAccount),
            databaseURL: "https://woodgrowbot-default-rtdb.europe-west1.firebasedatabase.app",
            storageBucket: "woodgrowbot.firebasestorage.app"
        });
    } catch (error) {
        console.error('Firebase initialization error:', error);
    }
}

const db = admin.database();
const storage = admin.storage().bucket();

// Допоміжна функція для парсингу multipart/form-data (потрібна для рефералів зі скріншотами)
const parseMultipartForm = (req) => {
    return new Promise((resolve, reject) => {
        const busboy = Busboy({ headers: req.headers });
        const fields = {};
        let fileBuffer = null;
        let fileName = '';
        let fileMimeType = '';

        busboy.on('field', (fieldname, val) => {
            fields[fieldname] = val;
        });

        busboy.on('file', (fieldname, file, info) => {
            const { filename, mimeType } = info;
            fileName = filename;
            fileMimeType = mimeType;
            const chunks = [];

            file.on('data', (chunk) => {
                chunks.push(chunk);
            });

            file.on('end', () => {
                fileBuffer = Buffer.concat(chunks);
            });
        });

        busboy.on('finish', () => {
            resolve({ fields, file: fileBuffer ? { buffer: fileBuffer, name: fileName, mimetype: fileMimeType } : null });
        });

        busboy.on('error', (error) => {
            reject(error);
        });

        req.pipe(busboy);
    });
};

export const config = {
    api: {
        bodyParser: false, // Вимикаємо стандартний парсер для підтримки multipart/form-data
    },
};

export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
    if (!BOT_TOKEN) return res.status(500).json({ error: 'Server configuration missing' });

    try {
        // Парсимо дані форми (працює як для JSON-подібних полів, так і для multipart)
        const { fields, file } = await parseMultipartForm(req);
        const { userId, initData, taskId } = fields;

        if (!userId || !initData || !taskId) {
            return res.status(400).json({ error: 'Missing parameters' });
        }

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

        // Перевіряємо чи існує завдання
        const taskRef = db.ref(`tasks/${taskId}`);
        const taskSnap = await taskRef.once('value');

        if (!taskSnap.exists()) {
            return res.status(404).json({ error: 'Task not found' });
        }

        const taskData = taskSnap.val();
        const taskType = taskData.type;

        // ==========================================
        // ГІЛКА А: АВТОМАТИЧНІ ЗАВДАННЯ (Story View, Реакції тощо)
        // ==========================================
        if (taskType === 'story_view' || taskType === 'reaction' || taskType === 'telegram_subscription') {
            
            // 1. Перевірка на унікальність: чи використав користувач це завдання раніше
            const completionRef = db.ref(`task_completions/${taskId}/${userId}`);
            const completionSnap = await completionRef.once('value');
            if (completionSnap.exists()) {
                return res.status(409).json({ error: 'You have already completed this task' });
            }

            // 2. Перевірка лімітів завдання
            const currentCount = parseInt(taskData.current_count) || 0;
            const targetCount = parseInt(taskData.target_count) || 0;
            if (currentCount >= targetCount) {
                return res.status(400).json({ error: 'Task is already completed' });
            }

            // 3. Визначення винагороди залежно від типу
            let reward = parseFloat(taskData.reward) || 0.0001;
            let systemCommission = 0.00005; // комісія платформи (наприклад, для сторіс)

            if (taskType === 'reaction') {
                reward = 0.0005;
                systemCommission = 0.0005;
            } else if (taskType === 'telegram_subscription') {
                reward = 0.001;
                systemCommission = 0.0008;
            }

            // 4. Нарахування коштів виконавцю
            const userWalletRef = db.ref(`task_users/${userId}`);
            const userWalletSnap = await userWalletRef.once('value');
            let userBalance = 0;
            if (userWalletSnap.exists()) {
                userBalance = parseFloat(userWalletSnap.val().balance) || 0;
            }

            const newBalance = userBalance + reward;

            // Використовуємо транзакцію/оновлення для безпеки
            const updates = {};
            updates[`task_users/${userId}/balance`] = newBalance;
            updates[`task_completions/${taskId}/${userId}`] = true;
            updates[`tasks/${taskId}/current_count`] = currentCount + 1;
            updates[`task_users/${taskData.creatorId}/my_campaigns/${taskId}/current_views`] = currentCount + 1;

            // Якщо досягнуто цільової кількості — закриваємо завдання
            if (currentCount + 1 >= targetCount) {
                updates[`tasks/${taskId}/status`] = 'completed';
            }

            await db.ref().update(updates);

            return res.status(200).json({
                success: true,
                message: 'Task completed automatically and reward credited',
                reward: reward
            });
        }

        // ==========================================
        // ГІЛКА Б: ЗАВДАННЯ З РУЧНОЮ МОДЕРАЦІЄЮ (Реферали)
        // ==========================================
        if (!file) {
            return res.status(400).json({ error: 'Screenshot file is required for this task type' });
        }

        // Перевіряємо чи виконавець вже не надсилав звіт
        const existingSubmissionsSnap = await db.ref(`task_submissions/${taskId}`).orderByChild('userId').equalTo(userId).once('value');
        if (existingSubmissionsSnap.exists()) {
            return res.status(409).json({ error: 'You have already submitted a report for this task' });
        }

        // Завантаження файлу у Firebase Storage
        const fileExtension = file.name.split('.').pop() || 'jpg';
        const fileName = `task_screenshots/${taskId}_${userId}_${Date.now()}.${fileExtension}`;
        const fileUpload = storage.file(fileName);

        await fileUpload.save(file.buffer, {
            metadata: { contentType: file.mimetype },
            public: true,
        });

        const screenshotUrl = `https://storage.googleapis.com/${storage.name}/${fileName}`;

        // Збереження звіту для ручної модерації
        const submissionRef = db.ref(`task_submissions/${taskId}`).push();
        const submissionId = submissionRef.key;
        const timestamp = Date.now();

        const submissionData = {
            id: submissionId,
            taskId: taskId,
            userId: userId,
            creatorId: taskData.creatorId,
            screenshotUrl: screenshotUrl,
            status: 'pending',
            submittedAt: timestamp,
            expiresAt: timestamp + (48 * 60 * 60 * 1000)
        };

        await submissionRef.set(submissionData);
        await db.ref(`task_users/${taskData.creatorId}/my_campaigns/${taskId}/submissions/${submissionId}`).set(submissionData);

        return res.status(200).json({
            success: true,
            message: 'Submission sent successfully and is pending review',
            submissionId: submissionId
        });

    } catch (e) {
        console.error("Error in submit-task:", e);
        return res.status(500).json({ error: 'Server error during task submission' });
    }
}
