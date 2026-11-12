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
            storageBucket: "woodgrowbot.firebasestorage.app" // Додали бакет для файлів
        });
    } catch (error) {
        console.error('Firebase initialization error:', error);
    }
}

const db = admin.database();
const storage = admin.storage().bucket();

// Допоміжна функція для парсингу multipart/form-data на Vercel через busboy
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
        bodyParser: false, // Вимикаємо стандартний парсер Vercel, щоб працював Busboy для файлів
    },
};

export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
    if (!BOT_TOKEN) return res.status(500).json({ error: 'Server configuration missing' });

    try {
        // Парсимо дані форми та файл
        const { fields, file } = await parseMultipartForm(req);
        const { userId, initData, taskId } = fields;

        if (!userId || !initData || !taskId) {
            return res.status(400).json({ error: 'Missing parameters' });
        }

        if (!file) {
            return res.status(400).json({ error: 'Screenshot file is required' });
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

        // Перевіряємо чи виконавець вже не надсилав звіт
        const existingSubmissionsSnap = await db.ref(`task_submissions/${taskId}`).orderByChild('userId').equalTo(userId).once('value');
        if (existingSubmissionsSnap.exists()) {
            return res.status(409).json({ error: 'You have already submitted a report for this task' });
        }

        // 2. Завантаження файлу у Firebase Storage
        const fileExtension = file.name.split('.').pop() || 'jpg';
        const fileName = `task_screenshots/${taskId}_${userId}_${Date.now()}.${fileExtension}`;
        const fileUpload = storage.file(fileName);

        await fileUpload.save(file.buffer, {
            metadata: { contentType: file.mimetype },
            public: true, // Робімо файл публічним для перегляду рекламодавцем
        });

        // Формуємо публічне посилання на картинку у Firebase Storage
        const screenshotUrl = `https://storage.googleapis.com/${storage.name}/${fileName}`;

        // 3. Збереження звіту в базу даних
        const submissionRef = db.ref(`task_submissions/${taskId}`).push();
        const submissionId = submissionRef.key;
        const timestamp = Date.now();

        const submissionData = {
            id: submissionId,
            taskId: taskId,
            userId: userId,
            creatorId: taskData.creatorId,
            screenshotUrl: screenshotUrl, // Тепер це пряме посилання на завантажений файл!
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
        console.error("Error submitting task with file:", e);
        return res.status(500).json({ error: 'Server error during file upload or database transaction' });
    }
}
