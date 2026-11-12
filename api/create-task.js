// api/create-task.js

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
const SUPER_ADMIN_ID = "6043278492"; // Твій Telegram ID

export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    const { userId, initData, taskLink, taskType, packageSize } = req.body;

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
        // === ПЕРЕВІРКА: ОДНЕ ПОСИЛАННЯ — ОДНЕ ЗАВДАННЯ НАЗАВЖДИ ===
        const tasksSnapshot = await db.ref('tasks').orderByChild('link').equalTo(taskLink).once('value');
        if (tasksSnapshot.exists()) {
            return res.status(409).json({ 
                error: 'duplicate_link', 
                error_ua: 'Завдання для цього посилання вже було створено раніше!' 
            });
        }
        // ============================================================

        const isSuperAdmin = (userId.toString() === SUPER_ADMIN_ID);
        const advRef = db.ref(`task_users/${userId}`);
        
        let currentBalance = 0;
        let taskCost = 0;
        let targetCount = 0;
        let rewardPerUnit = 0;
        let isReferral = (taskType === 'referral');

        if (isReferral) {
            const allowedPackages = [5, 10, 20];
            const size = parseInt(packageSize) || 5;

            if (!allowedPackages.includes(size)) {
                return res.status(400).json({ error: 'Invalid package size. Allowed: 5, 10, 20' });
            }

            targetCount = size;                    // 5, 10 або 20 рефералів
            rewardPerUnit = 0.002;                 // Винагорода виконавцю за 1 реферала
            taskCost = size * 0.004;               // Вартість для замовника (0.02, 0.04 або 0.08 USDT)
        } else {
            // Стандартні реакції на пости
            targetCount = 20;
            rewardPerUnit = 0.0005;
            taskCost = 0.03;
        }

        if (!isSuperAdmin) {
            // Перевіряємо баланс звичайного рекламодавця
            const advSnapshot = await advRef.once('value');
            if (!advSnapshot.exists()) return res.status(444).json({ error: 'Advertiser profile not found' });
            
            currentBalance = parseFloat(advSnapshot.val().balance) || 0;

            if (currentBalance < taskCost) {
                return res.status(400).json({ error: `Insufficient balance. Need ${taskCost.toFixed(4)} USDT` });
            }

            // Списуємо вартість пакету з балансу
            const newBalance = currentBalance - taskCost;
            await advRef.update({ balance: newBalance });
        }

        // 2. Додаємо завдання у загальну гілку для основної апки "tasks"
        const globalTasksRef = db.ref('tasks').push();
        const taskId = globalTasksRef.key;
        const timestamp = new Date().toISOString();

        const newTaskData = {
            id: taskId,
            creatorId: userId,
            link: taskLink,
            type: isReferral ? 'referral' : 'reaction',
            reward: rewardPerUnit,                  
            target_count: targetCount,     
            current_count: 0,
            status: "active",
            createdAt: timestamp
        };

        await globalTasksRef.set(newTaskData);

        // Також дублюємо запис у кабінет самого рекламодавця для вкладки "Прогрес"
        await db.ref(`task_users/${userId}/my_campaigns/${taskId}`).set({
            id: taskId,
            link: taskLink,
            type: isReferral ? 'referral' : 'reaction',
            ordered_views: targetCount,      
            current_views: 0,
            created_at: timestamp   
        });

        return res.status(200).json({
            success: true,
            message: isSuperAdmin ? 'Task created for free (Admin mode)' : `Task created successfully, ${taskCost.toFixed(4)} USDT debited`,
            taskId: taskId
        });

    } catch (e) {
        console.error("Error creating task:", e);
        return res.status(500).json({ error: 'Database transaction error' });
    }
}
