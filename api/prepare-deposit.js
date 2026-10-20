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

export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    const { userId, initData, amount } = req.body;

    if (!userId || !initData || !amount) {
        return res.status(400).json({ error: 'Missing parameters' });
    }

    const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
    const MY_WALLET = process.env.USDT_MASTER_WALLET; // Твій гаманець із змінних середовища

    if (!BOT_TOKEN || !MY_WALLET) return res.status(500).json({ error: 'Server config missing' });

    // Валідація Telegram InitData
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

    // Переводимо суму USDT у нано (6 знаків) для надійного передавання в коментарі
    const amountNano = Math.round(parseFloat(amount) * 1000000);

    // Конвертуємо текстовий коментар (userId та суму) у hex-формат для TON-транзакції
    const commentText = `topup_${userId}_${amount}`;
    const commentHex = Buffer.from(commentText, 'utf-8').toString('hex');
    
    // Спеціальний префікс для текстового коментаря в TON (00000000 перед байтами тексту)
    const payloadHex = "00000000" + commentHex;

    // Формуємо чисту і зрозумілу транзакцію безпосередньо на твій гаманець із коментарем
    const transaction = {
        validUntil: Math.floor(Date.now() / 1000) + 600, // 10 хвилин
        messages: [
            {
                address: MY_WALLET, // Надсилаємо напряму на твій гаманець
                amount: "50000000",   // 0.05 TON на комісію мережі
                payload: payloadHex   // Коментар у вигляді hex, щоб бекенд розпізнав платіж
            }
        ]
    };

    return res.status(200).json({ success: true, transaction });
}
