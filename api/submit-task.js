// api/submit-task.js

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

export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    const { userId, initData, taskId, screenshotUrl } = req.body;

    if (!userId || !initData || !taskId || !screenshotUrl) {
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
        // Перевіряємо чи існує таке завдання
        const taskRef = db.ref(`tasks/${taskId}`);
        const taskSnap = await taskRef.once('value');

        if (!taskSnap.exists()) {
            return res.status(404).json({ error: 'Task not found' });
        }

        const taskData = taskSnap.val();

        // Перевіряємо чи виконавець вже не надсилав звіт по цьому завданню
        const existingSubmissionsSnap = await db.ref(`task_submissions/${taskId}`).orderByChild('userId').equalTo(userId).once('value');
        if (existingSubmissionsSnap.exists()) {
            return res.status(409).json({ error: 'You have already submitted a report for this task' });
        }

        // Створюємо унікальний ID для сабміту
        const submissionRef = db.ref(`task_submissions/${taskId}`).push();
        const submissionId = submissionRef.key;
        const timestamp = Date.now();

        const submissionData = {
            id: submissionId,
            taskId: taskId,
            userId: userId,
            creatorId: taskData.creatorId, // ID рекламодавця, який створив завдання
            screenshotUrl: screenshotUrl,
            status: 'pending',            // pending, approved, rejected
            submittedAt: timestamp,
            expiresAt: timestamp + (48 * 60 * 60 * 1000) // 48 годин для автозарахування
        };

        // Зберігаємо сабміт у глобальну гілку сабмітів завдання
        await submissionRef.set(submissionData);

        // Також дублюємо посилання у профіль рекламодавця для зручності модерації у його кабінеті
        await db.ref(`task_users/${taskData.creatorId}/my_campaigns/${taskId}/submissions/${submissionId}`).set(submissionData);

        return res.status(200).json({
            success: true,
            message: 'Submission sent successfully and is pending review',
            submissionId: submissionId
        });

    } catch (e) {
        console.error("Error submitting task:", e);
        return res.status(500).json({ error: 'Database transaction error' });
    }
}
