"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { downloadContentFromMessage } = require("baileys");

/* =====================================================
   MÓDULO DE DIVULGAÇÃO PV (COMPATÍVEL COM INDEX.JS)
===================================================== */

module.exports = {
  name: "divulpv",
  description: "Duplica mensagem marcada e envia para todos os contatos",
  commands: ["divulpv"],
  usage: "divulpv (marcando uma mensagem)",

  handle: async (ctx) => {
    const {
      socket,
      remoteJid,
      webMessage,
      reply,
      baseDir,
      info,
      warning,
      error
    } = ctx;

    try {
      // 1. Obtém a mensagem marcada usando o extrator do index.js
      const quotedDetails = ctx.getQuotedDetails ? ctx.getQuotedDetails() : null;
      
      if (!quotedDetails || !quotedDetails.raw || Object.keys(quotedDetails.raw).length === 0) {
        return reply("⚠️ Marque uma mensagem válida para divulgar.");
      }

      const quotedMsg = quotedDetails.raw;
      const startTime = Date.now();

      // 📁 Diretório de salvamento
      const dirPath = path.join(baseDir, "assets", "temp", "duplicadas");
      if (!fs.existsSync(dirPath)) {
        fs.mkdirSync(dirPath, { recursive: true });
      }

      // 📁 Contatos
      const contatosPath = path.join(baseDir, "assets", "database", "contatos.json");
      if (!fs.existsSync(contatosPath)) {
        return reply("⚠️ Arquivo contatos.json não encontrado em assets/database/.");
      }

      let contatos = [];
      try {
        const rawContatos = fs.readFileSync(contatosPath, "utf8");
        contatos = JSON.parse(rawContatos).contatos || [];
      } catch (e) {
        return reply("⚠️ Erro ao ler o arquivo contatos.json.");
      }

      if (!contatos.length) {
        return reply("⚠️ Nenhum contato salvo na lista.");
      }

      const total = contatos.length;

      // 🔥 Mensagem única inicial de status
      const statusMsg = await socket.sendMessage(remoteJid, {
        text: "🚀 Iniciando divulgação..."
      }, { quoted: webMessage });

      // 🔄 Atualização em tempo real do status
      const updateStatus = async (current, sucesso, falha) => {
        const agora = Date.now();
        const tempo = (agora - startTime) / 1000;
        const percent = Math.floor((current / total) * 100);

        const tempoPorMsg = current > 0 ? tempo / current : 0;
        const restante = tempoPorMsg * (total - current);

        const barraTotal = 20;
        const filled = Math.floor((percent / 100) * barraTotal);
        const barra = "█".repeat(filled) + "░".repeat(barraTotal - filled);

        const ping = agora - startTime;
        const hora = new Date().toLocaleTimeString();

        const text = `
🚀 *DIVULGAÇÃO EM TEMPO REAL*

📊 Progresso: ${percent}%
[${barra}]

📨 Enviados: ${current}/${total}
✔️ Sucesso: ${sucesso}
❌ Falhas: ${falha}

⚡ Velocidade: ${tempoPorMsg.toFixed(2)}s/msg
⏳ Restante: ${restante.toFixed(1)}s
⏱️ Decorrido: ${tempo.toFixed(1)}s

📡 Ping: ${ping}ms
🕒 Hora: ${hora}
`.trim();

        try {
          await socket.sendMessage(remoteJid, {
            text,
            edit: statusMsg?.key
          });
        } catch {
          await socket.sendMessage(remoteJid, { text });
        }
      };

      const keys = Object.keys(quotedMsg || {});
      const type = keys.length ? keys[0] : null;

      let savedFile = "";
      let sendFn;

      const getBuffer = async (msg, mediaType) => {
        const stream = await downloadContentFromMessage(msg, mediaType);
        let buffer = Buffer.from([]);
        for await (const chunk of stream) {
          buffer = Buffer.concat([buffer, chunk]);
        }
        return buffer;
      };

      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const DELAY_ENTRE_CONTATOS = 2 * 60 * 1000; // 2 minutos (ajuste se preferir mais rápido)

      // =========================
      // TRATAMENTO DOS TIPOS DE MÍDIA
      // =========================

      if (type === "conversation" || type === "extendedTextMessage") {
        const text = quotedMsg.conversation || quotedMsg.extendedTextMessage?.text || "[mensagem vazia]";

        savedFile = path.join(dirPath, `text_${Date.now()}.txt`);
        fs.writeFileSync(savedFile, text, "utf-8");

        sendFn = (lid) => socket.sendMessage(lid, { text });
      } else if (type === "imageMessage") {
        const caption = quotedMsg.imageMessage.caption || "";
        const buffer = await getBuffer(quotedMsg.imageMessage, "image");

        savedFile = path.join(dirPath, `img_${Date.now()}.jpg`);
        fs.writeFileSync(savedFile, buffer);

        sendFn = (lid) => socket.sendMessage(lid, { image: buffer, caption });
      } else if (type === "videoMessage") {
        const caption = quotedMsg.videoMessage.caption || "";
        const buffer = await getBuffer(quotedMsg.videoMessage, "video");

        savedFile = path.join(dirPath, `video_${Date.now()}.mp4`);
        fs.writeFileSync(savedFile, buffer);

        sendFn = (lid) => socket.sendMessage(lid, { video: buffer, caption });
      } else if (type === "audioMessage") {
        const isPTT = quotedMsg.audioMessage.ptt || false;
        const buffer = await getBuffer(quotedMsg.audioMessage, "audio");
        const mimetype = quotedMsg.audioMessage.mimetype || "audio/ogg; codecs=opus";

        savedFile = path.join(dirPath, `audio_${Date.now()}.ogg`);
        fs.writeFileSync(savedFile, buffer);

        sendFn = (lid) => socket.sendMessage(lid, { audio: buffer, mimetype, ptt: isPTT });
      } else if (type === "documentMessage") {
        const fileName = quotedMsg.documentMessage.fileName || `doc_${Date.now()}`;
        const mimetype = quotedMsg.documentMessage.mimetype || "application/octet-stream";
        const buffer = await getBuffer(quotedMsg.documentMessage, "document");

        savedFile = path.join(dirPath, fileName);
        fs.writeFileSync(savedFile, buffer);

        sendFn = (lid) => socket.sendMessage(lid, { document: buffer, mimetype, fileName });
      } else if (type === "stickerMessage") {
        const buffer = await getBuffer(quotedMsg.stickerMessage, "sticker");

        savedFile = path.join(dirPath, `stk_${Date.now()}.webp`);
        fs.writeFileSync(savedFile, buffer);

        sendFn = (lid) => socket.sendMessage(lid, { sticker: buffer });
      } else {
        const text = JSON.stringify(quotedMsg, null, 2);
        savedFile = path.join(dirPath, `unknown_${Date.now()}.txt`);
        fs.writeFileSync(savedFile, text, "utf-8");

        sendFn = (lid) => socket.sendMessage(lid, { text: "⚠️ Tipo não suportado.\n\n" + text });
      }

      // =========================
      // 🚀 LOOP DE ENVIO
      // =========================
      let sucesso = 0;
      let falha = 0;

      for (let i = 0; i < contatos.length; i++) {
        const lid = contatos[i];

        if (!lid || typeof lid !== "string") {
          falha++;
          await updateStatus(i + 1, sucesso, falha);
          continue;
        }

        try {
          await sendFn(lid);
          sucesso++;
        } catch (e) {
          falha++;
          warning(`Erro ao enviar para ${lid}: ${e.message}`);
        }

        await updateStatus(i + 1, sucesso, falha);

        if (i < contatos.length - 1) {
          await sleep(DELAY_ENTRE_CONTATOS);
        }
      }

      await updateStatus(total, sucesso, falha);
      info(`[DIVULPV OK] Concluído. Arquivo salvo em: ${savedFile}`);

    } catch (e) {
      error(`Erro crítico no divulpv: ${e?.stack || e?.message || e}`);
      return reply("❌ Ocorreu um erro interno ao realizar a divulgação.");
    }
  }
};
