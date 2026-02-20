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

        // Opcional: Limpiar registros viejos de más de 7 días usando un script externo o Cloud Function.
        // No lo hacemos aquí para no ralentizar la respuesta HTTP.

        return res.json(newVerse);
    } catch (error) {
        console.error("Error generating verse:", error);
        res.status(500).json({ error: error.message });
    }
});

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
