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

    const { userId, initData } = req.body;

    if (!userId || !initData) {
        return res.status(400).json({ error: 'Missing parameters' });
    }

    const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
    if (!BOT_TOKEN) return res.status(500).json({ error: 'Server configuration missing' });

    // Валідація Telegram InitData для безпеки
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
        // Зчитуємо дані користувача з бази
        const userSnapshot = await db.ref(`task_users/${userId}`).once('value');
        
        if (!userSnapshot.exists()) {
            return res.status(444).json({ error: 'User not found' });
        }

        const userData = userSnapshot.val();

        // Оскільки ми хочемо бачити актуальний прогрес (скільки лайків уже поставили), 
        // нам потрібно підтягнути поточні значення current_views з глобальної гілки 'tasks'
        let myCampaigns = userData.my_campaigns || {};
        
        if (Object.keys(myCampaigns).length > 0) {
            for (let taskId in myCampaigns) {
                const globalTaskSnapshot = await db.ref(`tasks/${taskId}`).once('value');
                if (globalTaskSnapshot.exists()) {
                    const globalTask = globalTaskSnapshot.val();
                    // Оновлюємо кількість переглядів/лайків у відповіді для фронтенду
                    myCampaigns[taskId].current_views = globalTask.current_views || 0;
                }
            }
        }

        return res.status(200).json({
            success: true,
            advertiser: {
                balance: parseFloat(userData.balance) || 0,
                my_campaigns: myCampaigns
            }
        });

    } catch (e) {
        console.error("Error fetching user data:", e);
        return res.status(500).json({ error: 'Database error' });
    }
}
