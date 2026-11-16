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

    if (!userId || !initData || !taskLink || !taskType) {
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
        // === ПЕРЕВІРКА НА ПРИВАТНЕ ПОСИЛАННЯ З ПЛЮСОМ ДЛЯ ПІДПИСОК ===
        if (taskType === 'telegram_subscription') {
            const trimmedLink = taskLink.trim();
            if (trimmedLink.includes('t.me/+') || trimmedLink.includes('t.me/joinchat/')) {
                return res.status(400).json({ 
                    error: 'private_link_not_allowed', 
                    error_ua: 'Приватні посилання з плюсом (+) не підтримуються. Використовуйте публічні канали (напр. https://t.me/channel або @channel).' 
                });
            }
        }

        // === ВАЛІДАЦІЯ ПОСИЛАННЯ ДЛЯ STORY VIEW ===
        if (taskType === 'story_view') {
            const trimmedLink = taskLink.trim();
            // Формат: t.me/<username>/s/<story_id> або https://t.me/...
            const storyRegex = /(https:\/\/)?t\.me\/[a-zA-Z0-9_]+\/s\/\d+/;
            if (!storyRegex.test(trimmedLink)) {
                return res.status(400).json({ 
                    error: 'invalid_story_link', 
                    error_ua: 'Невірний формат посилання на історію. Використовуйте формат: https://t.me/username/s/123' 
                });
            }
        }

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
        let pricePerUser = 0;
        const allowedPackages = [10, 20, 50];

        if (taskType === 'referral') {
            const refPackages = [5, 10, 20];
            const size = parseInt(packageSize) || 5;

            if (!refPackages.includes(size)) {
                return res.status(400).json({ error: 'Invalid package size. Allowed for referral: 5, 10, 20' });
            }

            targetCount = size;                    
            rewardPerUnit = 0.002;                 
            pricePerUser = 0.004;
            taskCost = size * pricePerUser;               
        } 
        else if (taskType === 'telegram_subscription') {
            const size = parseInt(packageSize);
            const subPackages = isSuperAdmin ? [20, 50, 100, 5000] : [20, 50, 100];

            if (!subPackages.includes(size)) {
                return res.status(400).json({ error: `Invalid package size. Allowed: ${subPackages.join(', ')}` });
            }

            targetCount = size;
            rewardPerUnit = 0.001;                 
            pricePerUser = 0.0018;                 
            taskCost = size * pricePerUser;        
        } 
        else if (taskType === 'story_view') {
            const size = parseInt(packageSize) || 10;

            if (!allowedPackages.includes(size)) {
                return res.status(400).json({ error: `Invalid package size. Allowed for story_view: ${allowedPackages.join(', ')}` });
            }

            targetCount = size;
            rewardPerUnit = 0.0001;
            pricePerUser = 0.00015;
            taskCost = size * pricePerUser;
        }
        else {
            // Реакції (базовий тип / else)
            const size = parseInt(packageSize) || 20;

            if (!allowedPackages.includes(size)) {
                return res.status(400).json({ error: `Invalid package size. Allowed for reactions: ${allowedPackages.join(', ')}` });
            }

            targetCount = size;
            rewardPerUnit = 0.0005;
            pricePerUser = 0.001; // Змінено з 0.0015 на 0.001
            taskCost = size * pricePerUser;
        }

        if (!isSuperAdmin) {
            const advSnapshot = await advRef.once('value');
            if (!advSnapshot.exists()) return res.status(444).json({ error: 'Advertiser profile not found' });
            
            currentBalance = parseFloat(advSnapshot.val().balance) || 0;

            if (currentBalance < taskCost) {
                return res.status(400).json({ error: `Insufficient balance. Need ${taskCost.toFixed(4)} USDT` });
            }

            const newBalance = currentBalance - taskCost;
            await advRef.update({ balance: newBalance });
        } else if (taskType === 'telegram_subscription' && targetCount === 5000) {
            taskCost = 0; 
        }

        const globalTasksRef = db.ref('tasks').push();
        const taskId = globalTasksRef.key;
        const timestamp = new Date().toISOString();

        const newTaskData = {
            id: taskId,
            creatorId: userId,
            link: taskLink,
            type: taskType,
            reward: rewardPerUnit,                  
            price_per_user: pricePerUser || rewardPerUnit,
            target_count: targetCount,     
            current_count: 0,
            status: "active",
            createdAt: timestamp,
            created_at: timestamp // дублюємо для сумісності з перевіркою 24 годин
        };

        await globalTasksRef.set(newTaskData);

        await db.ref(`task_users/${userId}/my_campaigns/${taskId}`).set({
            id: taskId,
            link: taskLink,
            type: taskType,
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
