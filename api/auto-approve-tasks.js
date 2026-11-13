// api/auto-approve-tasks.js

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
const CRON_SECRET = "Super5891referal7071tokeN";

export default async function handler(req, res) {
    const secret = req.query.secret || req.body?.secret;

    if (secret !== CRON_SECRET) {
        return res.status(403).json({ error: 'Unauthorized: Invalid secret token' });
    }

    const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;

    try {
        const now = Date.now();
        const submissionsRef = db.ref('task_submissions');
        const submissionsSnap = await submissionsRef.once('value');

        if (!submissionsSnap.exists()) {
            return res.status(200).json({ success: true, message: 'No submissions found', approvedCount: 0 });
        }

        let approvedCount = 0;
        const allTasksSubmissions = submissionsSnap.val();

        for (const [taskId, submissions] of Object.entries(allTasksSubmissions)) {
            for (const [submissionId, sub] of Object.entries(submissions)) {
                // Перевіряємо чи статус 'pending' і чи минув час (expiresAt)
                if (sub.status === 'pending' && sub.expiresAt && sub.expiresAt <= now) {
                    const creatorId = sub.creatorId;
                    const executorUserId = sub.userId;
                    const rewardAmount = 0.002;

                    // 1. Оновлюємо статус сабміту на approved (автозарахування)
                    await db.ref(`task_submissions/${taskId}/${submissionId}`).update({
                        status: 'approved',
                        autoApproved: true,
                        moderatedAt: now
                    });

                    // Також оновлюємо у кабінеті рекламодавця
                    await db.ref(`task_users/${creatorId}/my_campaigns/${taskId}/submissions/${submissionId}`).update({
                        status: 'approved',
                        autoApproved: true,
                        moderatedAt: now
                    });

                    // 2. Збільшуємо лічильники виконаних завдань у кампанії
                    const taskRef = db.ref(`tasks/${taskId}`);
                    const taskSnap = await taskRef.once('value');
                    if (taskSnap.exists()) {
                        const taskData = taskSnap.val();
                        const newCount = (parseInt(taskData.current_count || taskData.current_views || 0)) + 1;
                        
                        await taskRef.update({ current_count: newCount });
                        await db.ref(`task_users/${creatorId}/my_campaigns/${taskId}`).update({ 
                            current_views: newCount, 
                            current_count: newCount 
                        });
                    }

                    // 3. Нараховуємо винагороду виконавцю
                    const executorRef = db.ref(`task_users/${executorUserId}`);
                    const executorSnap = await executorRef.once('value');
                    
                    let currentExecutorBalance = 0;
                    if (executorSnap.exists() && executorSnap.val().balance) {
                        currentExecutorBalance = parseFloat(executorSnap.val().balance) || 0;
                    }

                    await executorRef.update({ balance: currentExecutorBalance + rewardAmount });

                    // 4. Сповіщаємо виконавця в Telegram про автоматичне схвалення
                    if (BOT_TOKEN) {
                        try {
                            await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({
                                    chat_id: executorUserId,
                                    text: `⚡️ Ваш звіт по завданню було автоматично схвалено системою (минуло 48 годин).\nВам нараховано +${rewardAmount} USDT.`
                                })
                            });
                        } catch (tgErr) {
                            console.error("Failed to send auto-approval notification to user:", tgErr);
                        }
                    }

                    approvedCount++;
                }
            }
        }

        return res.status(200).json({
            success: true,
            message: `Auto-approval completed successfully`,
            approvedCount: approvedCount
        });

    } catch (e) {
        console.error("Error in auto-approve cron:", e);
        return res.status(500).json({ error: 'Server error during auto-approval' });
    }
}
