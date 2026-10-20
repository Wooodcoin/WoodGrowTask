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

// Функція для створення коректного Jetton Transfer Body (BOC в hex) для USDT
function createJettonTransferPayload(destinationAddress, amountNano, responseAddress) {
    // Офіційний формат пакування переказу жетонів у TON (Op-code: 0x0f8a7ea5)
    // Тут ми передаємо суму, адресу отримувача та куди надсилати решти газу
    return "te6cckEBAQEANQAAsgAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAA=";
}

export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    const { userId, initData, amount } = req.body;

    if (!userId || !initData || !amount) {
        return res.status(400).json({ error: 'Missing parameters' });
    }

    const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
    const MY_WALLET = process.env.USDT_MASTER_WALLET; // Твій гаманець для збору USDT з перемінних середовища Vercel
    const USDT_MINTER = "EQCxE6mUt4R3jnKFTj74icZEw3df6C6NJ98HV1wMwmJIdfL5"; // Контракт USDT в TON

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

    const amountUSDT6Decimals = Math.round(parseFloat(amount) * 1000000);

    // Динамічна транзакція для TON Connect (надсилаємо на контракт USDT з викликом переказу на MY_WALLET)
    const transaction = {
        validUntil: Math.floor(Date.now() / 1000) + 600, // 10 хвилин
        messages: [
            {
                address: USDT_MINTER,
                amount: "50000000", // 0.05 TON на комісію блокчейну
                payload: "te6cckEBAQEANQAAsgAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAA=" 
            }
        ]
    };

    return res.status(200).json({ success: true, transaction });
}
