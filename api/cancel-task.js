import admin from 'firebase-admin';

if (!admin.apps.length) {
    try {
        const rawKey = process.env.FIREBASE_SERVICE_ACCOUNT;
        const decryptedKey = rawKey.startsWith('ewog') 
            ? Buffer.from(rawKey, 'base64').toString('utf-8') 
            : rawKey;
        const serviceAccount = JSON.parse(decryptedKey);
        admin.initializeApp({
            credential: admin.credential.cert(serviceAccount),
            databaseURL: "https://woodgrowbot-default-rtdb.europe-west1.firebasedatabase.app"
        });
    } catch (error) {
        console.error('Firebase admin init error:', error);
    }
}

const db = admin.database();

export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    const { userId, initData, campaignId } = req.body;

    if (!userId || !initData || !campaignId) {
        return res.status(400).json({ error: 'Missing parameters' });
    }

    const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
    if (!BOT_TOKEN) return res.status(500).json({ error: 'Server config missing' });

    // 1. Валідація Telegram InitData для безпеки
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
        const advRef = db.ref(`task_users/${userId}`);
        const snapshot = await advRef.once('value');
        
        if (!snapshot.exists()) {
            return res.status(404).json({ error: 'Advertiser not found' });
        }

        const advData = snapshot.val();
        const campaigns = advData.my_campaigns || {};

        if (!campaigns[campaignId]) {
            return res.status(404).json({ error: 'Campaign not found' });
        }

        const campaign = campaigns[campaignId];
        const createdAt = campaign.created_at ? new Date(campaign.created_at).getTime() : 0;
        const now = Date.now();
        const hoursPassed = (now - createdAt) / (1000 * 60 * 60);

        // Перевірка, чи минуло 24 години
        if (hoursPassed < 24) {
            return res.status(400).json({ error: 'Too early to cancel. 24 hours have not passed yet.' });
        }

        const currentViews = campaign.current_views || 0;
        const totalViews = 20; // Фіксований обсяг пакету
        const packageCost = 0.04; // Вартість пакета в USDT

        if (currentViews >= totalViews) {
            return res.status(400).json({ error: 'Campaign already completed' });
        }

        // Розраховуємо вартість одного виконання та суму повернення за невикористані перегляди
        const costPerView = packageCost / totalViews;
        const remainingViews = totalViews - currentViews;
        const refundAmount = remainingViews * costPerView;

        const currentBalance = parseFloat(advData.balance) || 0;
        const newBalance = currentBalance + refundAmount;

        // Видаляємо кампанію з активних та оновлюємо баланс
        delete campaigns[campaignId];

        await advRef.update({
            balance: newBalance,
            my_campaigns: campaigns
        });

        return res.status(200).json({
            success: true,
            refunded: refundAmount,
            newBalance: newBalance
        });

    } catch (e) {
        console.error("Cancel task error:", e);
        return res.status(500).json({ error: 'Internal server error' });
    }
}
