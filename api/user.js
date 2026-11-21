// api/user.js (Advertiser Cabinet)

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
        let myCampaigns = userData.my_campaigns || {};
        
        if (Object.keys(myCampaigns).length > 0) {
            for (let taskId in myCampaigns) {
                const campaign = myCampaigns[taskId] || {};
                const globalTaskSnapshot = await db.ref(`tasks/${taskId}`).once('value');

                if (globalTaskSnapshot.exists()) {
                    const globalTask = globalTaskSnapshot.val();
                    const actualCount = parseInt(
                        globalTask.current_count ??
                        globalTask.current_views ??
                        campaign.current_count ??
                        campaign.current_views ??
                        0
                    ) || 0;

                    myCampaigns[taskId].current_count = actualCount;
                    myCampaigns[taskId].current_views = actualCount;
                    if (globalTask.status) {
                        myCampaigns[taskId].status = globalTask.status;
                    }
                    if (globalTask.type && !campaign.type) {
                        myCampaigns[taskId].type = globalTask.type;
                    }
                }

                // Підтягуємо заявки з task_submissions/${taskId} та об'єднуємо з my_campaigns/${taskId}/submissions
                const campaignSubs = (campaign.submissions && typeof campaign.submissions === 'object')
                    ? campaign.submissions
                    : {};
                const globalSubsSnapshot = await db.ref(`task_submissions/${taskId}`).once('value');
                const globalSubs = globalSubsSnapshot.exists() ? globalSubsSnapshot.val() : {};

                const mergedSubs = { ...campaignSubs };
                for (const subId in globalSubs) {
                    const gSub = globalSubs[subId] || {};
                    const cSub = mergedSubs[subId] || {};
                    const gModerated = gSub.moderatedAt || 0;
                    const cModerated = cSub.moderatedAt || 0;

                    if (gModerated >= cModerated || gSub.status !== 'pending') {
                        mergedSubs[subId] = { ...cSub, ...gSub, id: gSub.id || subId };
                    } else {
                        mergedSubs[subId] = { ...gSub, ...cSub, id: cSub.id || subId };
                    }
                }

                if (Object.keys(mergedSubs).length > 0) {
                    myCampaigns[taskId].submissions = mergedSubs;
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
