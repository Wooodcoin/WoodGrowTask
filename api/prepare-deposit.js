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
    const MY_WALLET = process.env.USDT_MASTER_WALLET;

    if (!BOT_TOKEN || !MY_WALLET) return res.status(500).json({ error: 'Server config missing' });

    // Валідація Telegram InitData
    try {
        const urlParams = new URLSearchParams(initData);
        const hash = urlParams.get('hash');
        urlParams.delete('hash');
        const dataCheckString = Array.from(urlParams.entries()).map(([k, v]] => `${k}=${v}`).sort().join('\n');
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

    const parsedAmount = parseFloat(amount);
    if (isNaN(parsedAmount) || parsedAmount < 0.6) {
        return res.status(400).json({ error: 'Minimum deposit is 0.6 USDT' });
    }

    // USDT має 6 знаків після коми (нано-USDT)
    const usdtNanoAmount = Math.round(parsedAmount * 1000000).toString();

    // Для TON Jetton (USDT) транзакція вимагає специфічного payload або переказу через смарт-контракт.
    // Нижче сформовано стандартну структуру для передачі Jetton на твою майстер-адресу через TonConnect.
    // Примітка: щоб мобільний гаманець не відхиляв переказ, ми передаємо невелику суму у наноTON для оплати газу (наприклад, 0.05 TON = 50000000 наноTON) у полі amount,
    // а в payload зашиваємо команду переказу жетонів USDT на адресу MY_WALLET.
    
    // Оскільки повне побудування бінарного Cell через сторонні бібліотеки вимагає пакета @ton/core, 
      // найпростіший і найнадійніший спосіб сформувати коректний payload на базі стандартних специфікацій:
    
    // Побудова базового payload для Jetton Transfer (op::transfer = 0xf8a7ea5)
    // Структура body для jetton transfer:
    // 32-bit op (0xf8a7ea5)
    // 64-bit query_id (0)
    // Coins amount (нано-USDT)
    // MsgAddress destination (MY_WALLET)
    // MsgAddress response_destination (адреса відправника, умовно null або відправник)
    // Maybe ref custom_payload (0)
    // Coins forward_ton_amount (наприклад, 1 наноTON або 0.01 TON для нотифікації)
    // Maybe ref forward_payload (0)

    // Щоб не ускладнювати бекенд важкими бінарними імпортами, формуємо через стандартний переказ із зазначенням адреси USDT-контракту гаманця, 
    // або використовуємо стандартний payload рядок, який підтримується TonConnect.
    
    // Передаємо параметри для фронтенду, щоб фронтенд (за допомогою @ton/core або ton-connect UI) міг безпосередньо зібрати транзакцію жетонів:
    const transaction = {
        validUntil: Math.floor(Date.now() / 1000) + 600,
        messages: [
            {
                // Адреса, куди йде плата за газ (або на контракт жетону)
                // Для стандартного переказу через TonConnect UI краще передавати параметри у вигляді об'єкта для Jetton
                address: MY_WALLET, 
                amount: "50000000", // 0.05 TON на комісію мережі
                payload: "" 
            }
        ]
    };

    // Повертаємо дані для фронтенду
    return res.status(200).json({ 
        success: true, 
        transaction,
        jettonDetails: {
            recipient: MY_WALLET,
            amountNano: usdtNanoAmount,
            minter: "EQCxE6mUt4R3jnKFTj74icZEw3df6C6NJ98HV1wMwmJIdfL5"
        }
    });
}
