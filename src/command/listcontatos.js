"use strict";

const fs = require("node:fs");
const path = require("node:path");

/* =====================================================
   MÓDULO DE MARCAR CONTATOS (COMPATÍVEL COM INDEX.JS)
===================================================== */

module.exports = {
  name: "marcarcontatos",
  description: "Lista os contatos do JSON, extraindo o número e marcando no grupo",
  commands: ["listcontatos", "listarcontatos", "marcarcontatos"],
  usage: "listcontatos",

  handle: async (ctx) => {
    const {
      socket,
      remoteJid,
      reply,
      baseDir,
      info,
      warning,
      error
    } = ctx;

    // Caminho padronizado para o banco de dados do bot
    const filePath = path.join(baseDir, "assets", "database", "contatos.json");

    try {
      // ⚠️ Verifica se está em grupo
      if (!remoteJid || !remoteJid.endsWith("@g.us")) {
        return reply("⚠️ Este comando só pode ser usado dentro de um grupo.");
      }

      // ⚠️ Verifica se o arquivo de contatos existe
      if (!fs.existsSync(filePath)) {
        return reply("⚠️ Nenhum arquivo de contatos encontrado. Use /extraircontatos primeiro.");
      }

      // 📂 Lê e analisa o JSON
      let data;
      try {
        data = JSON.parse(fs.readFileSync(filePath, "utf8"));
      } catch (e) {
        error(`JSON inválido em contatos.json: ${e.message}`);
        return reply("❌ Erro ao ler contatos.json (formato inválido).");
      }

      const contatos = Array.isArray(data.contatos) ? data.contatos : [];
      if (!contatos.length) {
        return reply("⚠️ Nenhum contato salvo em contatos.json.");
      }

      // 🔢 Gera a listagem formatada
      let lista = "📋 *Lista de contatos (Extraídos):*\n\n";
      let mentions = [];

      contatos.forEach((contato, i) => {
        if (typeof contato !== "string") return;

        // Extrai o número do JID/LID (compatível com @lid ou @s.whatsapp.net)
        const match = contato.match(/^(\d+)@(lid|s\.whatsapp\.net)$/);
        const numeroLimpo = contato.replace(/@.+$/, ""); // Fallback seguro caso o sufixo varie

        const numero = match ? match[1] : ((/^\d+$/.test(numeroLimpo) ? numeroLimpo : null));

        if (numero && numero.length >= 10 && numero.length <= 15) {
          const jid = `${numero}@s.whatsapp.net`;
          lista += `${i + 1}. @${numero}\n`;
          mentions.push(jid);
        } else {
          warning(`[IGNORADO] Contato inválido ou formato desconhecido: ${contato}`);
        }
      });

      if (!mentions.length) {
        return reply("⚠️ Nenhum número válido encontrado no arquivo de contatos.");
      }

      // ✉️ Envia a mensagem com menções nativas
      await socket.sendMessage(remoteJid, {
        text: lista.trim(),
        mentions,
      });

      info(`[LISTAGEM] Enviada lista de ${mentions.length} contatos extraídos com sucesso.`);

    } catch (err) {
      error(`Erro no comando marcarcontatos: ${err?.stack || err?.message || err}`);
      return reply(`❌ Erro inesperado ao listar os contatos: ${err.message}`);
    }
  },
};
