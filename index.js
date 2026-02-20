const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const app = express();
require('dotenv').config();

app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

// Configuración de Firebase
const admin = require("firebase-admin");

// Debes tener la variable FIREBASE_CONFIG en Render (o un archivo serviceAccountKey.json local)
let serviceAccount;
try {
    // Primero intentamos leer desde la variable de entorno de Render (JSON stringificado)
    serviceAccount = JSON.parse(process.env.FIREBASE_CONFIG_JSON);
} catch (e) {
    // Si falla, intentamos leer desde un archivo local (para desarrollo)
    try {
        serviceAccount = require('./serviceAccountKey.json');
    } catch (err) {
        console.error("No se pudo cargar la configuración de Firebase. Asegúrate de tener FIREBASE_CONFIG_JSON o serviceAccountKey.json");
    }
}

if (serviceAccount) {
    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount)
    });
}
const db = admin.firestore();

const LANGUAGES = {
    es: {
        bible_prompt: "Eres una Biblia tecnológica. Devuelve el contenido del versículo solicitado en versión Reina-Valera 1960. IMPORTANTE: Tu respuesta debe tener estrictamente este formato: 'Libro Capitulo:Versiculo|Texto del versículo'. Ejemplo: 'Juan 3:16|Porque de tal manera amó Dios al mundo...'. Sin introducciones.",
        pastor_prompt: "Eres un asistente pastoral sabio. Escribe una reflexión de 2 o 3 párrafos en ESPAÑOL. Profundiza en el significado teológico y su aplicación práctica. Tono solemne y esperanzador."
    },
    en: {
        bible_prompt: "You are a technological Bible. I will give you a verse reference in Spanish (e.g., 'Juan 3:16'). You MUST: 1. Translate the book name to English (e.g. 'Juan' -> 'John'). 2. Return the text of that verse in King James Version (KJV). IMPORTANT: Your response must strictly follow this format: 'Book Chapter:Verse|Text of the verse'. Example: 'John 3:16|For God so loved the world...'. No introductions.",
        pastor_prompt: "You are a wise pastoral assistant. Write a 2 or 3 paragraph reflection in ENGLISH. Deepen into the theological meaning and practical application. Solemn and hopeful tone."
    },
    pt: {
        bible_prompt: "Você é uma Bíblia tecnológica. Eu lhe darei uma referência em Espanhol (ex: 'Juan 3:16'). Você DEVE: 1. Traduzir o nome do livro para Português (ex: 'Juan' -> 'João'). 2. Retornar o texto do versículo na versão Almeida Corrigida Fiel. IMPORTANTE: Sua resposta deve seguir estritamente este formato: 'Livro Capítulo:Versículo|Texto do versículo'. Exemplo: 'João 3:16|Porque Deus amou o mundo de tal maneira...'. Sem introduções.",
        pastor_prompt: "Você é um assistente pastoral sábio. Escreva uma reflexão de 2 ou 3 parágrafos em PORTUGUÊS. Aprofunde o significado teológico e sua aplicação prática. Tom solene e esperançoso."
    }
};

async function getVerseFromGroq(slotId, lang, todayString) {
    const groqKey = process.env.GROQ_API_KEY;
    if (!groqKey) throw new Error("GROQ_API_KEY missing");

    // 1. Get Verse Reference
    let referenceBase = "Salmos 23:1";
    try {
        const randomSalt = Math.random().toString(36).substring(7);
        const refResponse = await axios.post('https://api.groq.com/openai/v1/chat/completions', {
            messages: [
                {
                    role: "system",
                    content: `You are a Bible Verse Selector. Select a UNIQUE and inspiring Bible Verse reference for ${todayString} (${slotId}). Salt: ${randomSalt}. Return ONLY the reference. NEVER pick Zefanías 3:17, Salmo 23:1, or Juan 3:16.`
                },
                {
                    role: "user",
                    content: `Pick a totally new verse for ${slotId} of ${todayString}. Be creative. ID: ${randomSalt}`
                }
            ],
            model: "llama-3.3-70b-versatile",
            temperature: 1.0
        }, {
            headers: { 'Authorization': `Bearer ${groqKey}`, 'Content-Type': 'application/json' }
        });
        referenceBase = refResponse.data.choices[0].message.content.trim().replace(/^Vers[íi]culo:\s*/i, '');
    } catch (e) {
        console.warn("Using fallback verse ref", e.message);
    }

    // 2. Get Text (translated)
    const langConfig = LANGUAGES[lang];
    const response = await axios.post('https://api.groq.com/openai/v1/chat/completions', {
        messages: [
            { role: "system", content: langConfig.bible_prompt },
            { role: "user", content: `Cita: ${referenceBase}` }
        ],
        model: "llama-3.3-70b-versatile",
        temperature: 0.1
    }, {
        headers: { 'Authorization': `Bearer ${groqKey}`, 'Content-Type': 'application/json' }
    });

    const rawContent = response.data.choices[0].message.content.trim().replace(/\*/g, '');
    let finalRef = referenceBase;
    let finalText = rawContent;

    if (rawContent.includes('|')) {
        const parts = rawContent.split('|');
        finalRef = parts[0].trim();
        finalText = parts[1].trim();
    }

    // 3. Generate Image
    const imagePrompt = encodeURIComponent(`ethereal divine light, heavenly clouds, golden rays, peaceful bright atmosphere, religious spiritual art, masterpiece, ${finalText.substring(0, 30)}`);
    const randomSeed = Math.floor(Math.random() * 999999);
    const generatedImageUrl = `https://pollinations.ai/p/${imagePrompt}?width=800&height=450&seed=${randomSeed}&model=flux&nologo=true`;

    // 4. Get Explanation
    const expResp = await axios.post('https://api.groq.com/openai/v1/chat/completions', {
        messages: [
            { role: "system", content: langConfig.pastor_prompt },
            { role: "user", content: `Versículo: ${finalRef} - "${finalText}"` }
        ],
        model: "llama-3.3-70b-versatile",
    }, { headers: { 'Authorization': `Bearer ${groqKey}`, 'Content-Type': 'application/json' } });

    const explanation = expResp.data.choices[0].message.content.trim().replace(/\*/g, '');

    return {
        reference: finalRef,
        text: finalText,
        explanation,
        imageUrl: generatedImageUrl,
        lang
    };
}

app.get('/api/daily-verse', async (req, res) => {
    // ... código existente sin modificar ...
    const { lang, slot } = req.query; // lang: es/en/pt, slot: morning/afternoon/evening

    if (!lang || !slot) return res.status(400).json({ error: "Missing lang or slot" });

    const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD

    try {
        const verseRef = db.collection('daily_verses').doc(`${today}_${slot}_${lang}`);
        const doc = await verseRef.get();

        if (doc.exists) {
            console.log(`Retornando versículo de Firebase para ${today} ${slot} ${lang}...`);
            return res.json(doc.data());
        }

        // Si no está en Firebase, generarlo
        console.log(`Generando NUEVO versículo para ${today} ${slot} ${lang}...`);
        const newVerse = await getVerseFromGroq(slot, lang, today);

        // Guardar en Firebase
        await verseRef.set({
            ...newVerse,
            createdAt: admin.firestore.FieldValue.serverTimestamp()
        });

        return res.json(newVerse);
    } catch (error) {
        console.error("Error generating verse:", error);
        res.status(500).json({ error: error.message });
    }
});

// Endpoint para pre-generar los versículos (Llamado idealmente por un Cron Job en la madrugada)
app.get('/api/cron/generate-verses', async (req, res) => {
    // Definimos qué día queremos generar. 
    // Usamos el día actual del servidor (UTC)
    const targetDate = new Date().toISOString().split('T')[0];

    // Si quisieras generar siempre los de "mañana", harías: 
    // const dateObj = new Date(); dateObj.setDate(dateObj.getDate() + 1);
    // const targetDate = dateObj.toISOString().split('T')[0];

    const slots = ['morning', 'afternoon', 'evening'];
    const langs = ['es', 'en', 'pt'];

    let stats = {
        generated: 0,
        skipped: 0,
        errors: []
    };

    try {
        for (const slot of slots) {
            for (const lang of langs) {
                const docId = `${targetDate}_${slot}_${lang}`;
                const verseRef = db.collection('daily_verses').doc(docId);
                const doc = await verseRef.get();

                if (doc.exists) {
                    stats.skipped++;
                    console.log(`[Cron] Ya existe: ${docId}`);
                } else {
                    console.log(`[Cron] Generando: ${docId}...`);
                    try {
                        const newVerse = await getVerseFromGroq(slot, lang, targetDate);
                        await verseRef.set({
                            ...newVerse,
                            createdAt: admin.firestore.FieldValue.serverTimestamp()
                        });
                        stats.generated++;
                    } catch (generationError) {
                        console.error(`[Cron] Error generando ${docId}:`, generationError);
                        stats.errors.push(docId);
                    }
                }
            }
        }
        res.json({ message: "Cron execution finished", targetDate, stats });
    } catch (error) {
        console.error("Error in cron route:", error);
        res.status(500).json({ error: error.message });
    }
});

// Endpoint para guardar tokens FCM
app.post('/api/register-token', async (req, res) => {
    const { token, lang, frequency, timezone } = req.body;
    if (!token || !lang || frequency === undefined) return res.status(400).json({ error: "Missing data" });

    try {
        await db.collection('fcm_tokens').doc(token).set({
            lang,
            frequency,
            timezone: timezone || 'America/Santiago',
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
        });
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Endpoint para lanzar notificaciones según la hora local de cada usuario (Ej. CronJob cada 1 hora en punto)
app.get('/api/cron/push-hourly', async (req, res) => {
    try {
        const tokensSnapshot = await db.collection('fcm_tokens').get();
        if (tokensSnapshot.empty) return res.json({ message: "No tokens registered" });

        // Group tokens by target definition: `${dateStr}_${slot}_${lang}` -> array of tokens
        const targetGroups = {};
        const now = new Date();

        tokensSnapshot.forEach(doc => {
            const data = doc.data();
            const tz = data.timezone || 'America/Santiago';

            let localHour;
            let localDateStr;
            try {
                localHour = parseInt(new Intl.DateTimeFormat('en-US', { hour: 'numeric', hourCycle: 'h23', timeZone: tz }).format(now));
                localDateStr = new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit', timeZone: tz }).format(now);
            } catch (e) {
                // Ignore invalid timezones
                return;
            }

            let slot = null;
            if (localHour === 10) slot = 'morning';
            else if (localHour === 14 && data.frequency === 3) slot = 'afternoon';
            else if (localHour === 18 && data.frequency === 3) slot = 'evening';

            // Si la frecuencia de bd es 1, solo se le manda el de la mañana.
            if (data.frequency === 1 && slot !== 'morning') {
                slot = null;
            }

            if (slot) {
                const groupKey = `${localDateStr}_${slot}_${data.lang}`;
                if (!targetGroups[groupKey]) {
                    targetGroups[groupKey] = {
                        localDateStr, slot, lang: data.lang, tokens: []
                    };
                }
                targetGroups[groupKey].tokens.push(doc.id);
            }
        });

        const results = {};

        for (const key of Object.keys(targetGroups)) {
            const group = targetGroups[key];
            const tokens = group.tokens;
            if (tokens.length === 0) continue;

            const { localDateStr, slot, lang } = group;

            const verseRef = db.collection('daily_verses').doc(key);
            let verseDoc = await verseRef.get();

            if (!verseDoc.exists) {
                console.log(`Versículo faltante para ${key} (Hourly Push). Generando...`);
                try {
                    const newVerse = await getVerseFromGroq(slot, lang, localDateStr);
                    await verseRef.set({ ...newVerse, createdAt: admin.firestore.FieldValue.serverTimestamp() });
                    verseDoc = await verseRef.get();
                } catch (err) {
                    console.error("Error generating verse for hourly push", err);
                    continue;
                }
            }

            const verseData = verseDoc.data();
            const titles = {
                es: { morning: "Palabra Viva: Mañana 🌅", afternoon: "Palabra Viva: Tarde ☀️", evening: "Palabra Viva: Noche 🌙" },
                en: { morning: "Living Word: Morning 🌅", afternoon: "Living Word: Afternoon ☀️", evening: "Living Word: Evening 🌙" },
                pt: { morning: "Palavra Viva: Manhã 🌅", afternoon: "Palavra Viva: Tarde ☀️", evening: "Palavra Viva: Noite 🌙" }
            };

            const title = titles[lang]?.[slot] || "Palabra Viva";
            const body = `${verseData.reference} - "${verseData.text}"`;

            const BATC_SIZE = 500;
            let successCount = 0;
            let failureCount = 0;

            for (let i = 0; i < tokens.length; i += BATC_SIZE) {
                const batchTokens = tokens.slice(i, i + BATC_SIZE);
                const message = { notification: { title, body }, tokens: batchTokens };

                const response = await admin.messaging().sendEachForMulticast(message);
                successCount += response.successCount;
                failureCount += response.failureCount;

                if (response.failureCount > 0) {
                    response.responses.forEach((resp, idx) => {
                        if (!resp.success && resp.error && (resp.error.code === 'messaging/registration-token-not-registered' || resp.error.code === 'messaging/invalid-registration-token')) {
                            db.collection('fcm_tokens').doc(batchTokens[idx]).delete();
                        }
                    });
                }
            }
            results[key] = { successCount, failureCount };
        }

        res.json({ success: true, processed: Object.keys(targetGroups).length, results });
    } catch (e) {
        console.error("Hourly Push Error:", e);
        res.status(500).json({ error: e.message });
    }
});

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
