// api/moderate-task.js

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

    const { userId, initData, taskId, submissionId, action, reason } = req.body; // action: 'approve' або 'reject'

    if (!userId || !initData || !taskId || !submissionId || !action) {
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
        const subRef = db.ref(`task_submissions/${taskId}/${submissionId}`);
        const subSnap = await subRef.once('value');

        if (!subSnap.exists()) {
            return res.status(404).json({ error: 'Submission not found' });
        }

        const submission = subSnap.val();

        if (submission.creatorId.toString() !== userId.toString()) {
            return res.status(403).json({ error: 'Unauthorized: You are not the owner of this task' });
        }

        if (submission.status !== 'pending') {
            return res.status(400).json({ error: `Submission is already ${submission.status}` });
        }

        const executorUserId = submission.userId;
        const timestamp = Date.now();

        if (action === 'approve') {
            await subRef.update({ status: 'approved', moderatedAt: timestamp });
            await db.ref(`task_users/${userId}/my_campaigns/${taskId}/submissions/${submissionId}`).update({ status: 'approved', moderatedAt: timestamp });

            const taskRef = db.ref(`tasks/${taskId}`);
            const taskSnap = await taskRef.once('value');
            if (taskSnap.exists()) {
                const taskData = taskSnap.val();
                const newCount = (parseInt(taskData.current_count || taskData.current_views || 0)) + 1;
                
                await taskRef.update({ current_count: newCount });
                await db.ref(`task_users/${userId}/my_campaigns/${taskId}`).update({ current_views: newCount, current_count: newCount });
            }

            const executorRef = db.ref(`task_users/${executorUserId}`);
            const executorSnap = await executorRef.once('value');
            
            let currentExecutorBalance = 0;
            if (executorSnap.exists() && executorSnap.val().balance) {
                currentExecutorBalance = parseFloat(executorSnap.val().balance) || 0;
            }

            const rewardAmount = 0.002;
            const newExecutorBalance = currentExecutorBalance + rewardAmount;

            await executorRef.update({ balance: newExecutorBalance });

            // Повідомлення виконавцю про успішне схвалення
            try {
                await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        chat_id: executorUserId,
                        text: `✅ Ваш звіт по завданню успішно схвалено! Ви отримали +${rewardAmount} USDT.`
                    })
                });
            } catch (tgErr) {
                console.error("Failed to send approval notification to user:", tgErr);
            }

            return res.status(200).json({
                success: true,
                message: 'Submission approved and reward credited to executor'
            });

        } else if (action === 'reject') {
            const rejectReasonText = reason || 'Завдання виконано некоректно';

            await subRef.update({ status: 'rejected', rejectReason: rejectReasonText, moderatedAt: timestamp });
            await db.ref(`task_users/${userId}/my_campaigns/${taskId}/submissions/${submissionId}`).update({ status: 'rejected', rejectReason: rejectReasonText, moderatedAt: timestamp });

            // Сповіщення виконавцю про відхилення з причиною
            try {
                await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        chat_id: executorUserId,
                        text: `❌ Ваш звіт по завданню було відхилено.\nПричина: ${rejectReasonText}`
                    })
                });
            } catch (tgErr) {
                console.error("Failed to send rejection notification to user:", tgErr);
            }

            return res.status(200).json({
                success: true,
                message: 'Submission rejected'
            });
        } else {
            return res.status(400).json({ error: 'Invalid action' });
        }

    } catch (e) {
        console.error("Error moderating task:", e);
        return res.status(500).json({ error: 'Database transaction error' });
    }
}
