"use strict";

const fs = require("node:fs");
const path = require("node:path");

/* =====================================================
   MÓDULO DE EXTRAÇÃO DE CONTATOS (COMPATÍVEL COM INDEX.JS)
===================================================== */

module.exports = {
  name: "extraircontatos",
  description: "Extrai contatos do grupo e salva em assets/database/contatos.json",
  commands: ["extraircontatos", "salvarcontatos"],
  usage: "extraircontatos [link do grupo | @pessoa | limite numérico]",

  handle: async (ctx) => {
    const {
      socket,
      remoteJid,
      text,
      args,
      reply,
      baseDir,
      info,
      error
    } = ctx;

    try {
      let groupId = remoteJid;
      let limite = null;
      let contatosSelecionados = null;
      let metadata = null;
      
      const textoCompleto = String(text || args.join(" ")).trim();
      // Remove o próprio comando da string de argumentos se vier nela
      const argSemLink = textoCompleto.replace(/^[!/#.$%]?\w+/, "").trim();

      // ============================================================
      // 🔗 Detecta URL do grupo
      // ============================================================
      const regex = /(https?:\/\/)?chat\.whatsapp\.com\/([A-Za-z0-9]+)/i;
      const match = argSemLink.match(regex);

      let argumentoRestante = argSemLink;

      if (match && match[2]) {
        const inviteCode = match[2];
        argumentoRestante = argSemLink.replace(match[0], "").trim();

        try {
          let inviteInfo = null;

          if (typeof socket.groupGetInviteInfo === "function") {
            inviteInfo = await socket.groupGetInviteInfo(inviteCode);
          } else if (typeof socket.groupInviteInfo === "function") {
            inviteInfo = await socket.groupInviteInfo(inviteCode);
          }

          const inviteGroupId =
            inviteInfo?.id ||
            inviteInfo?.jid ||
            inviteInfo?.groupJid ||
            null;

          if (inviteGroupId) {
            try {
              metadata = await socket.groupMetadata(inviteGroupId);
              groupId = inviteGroupId;
            } catch {
              await reply("⏳ Entrando no grupo pelo link...");
              const joined = await socket.groupAcceptInvite(inviteCode);
              groupId = joined;
              metadata = await socket.groupMetadata(groupId);
              await reply("🔗 Entrei no grupo com sucesso!");
            }
          } else {
            await reply("⏳ Entrando no grupo pelo link...");
            const joined = await socket.groupAcceptInvite(inviteCode);
            groupId = joined;
            metadata = await socket.groupMetadata(groupId);
            await reply("🔗 Entrei no grupo com sucesso!");
          }
        } catch (e) {
          error(`Erro ao usar link do grupo: ${e.message}`);
          return reply("❌ Não consegui localizar ou entrar no grupo pelo link.");
        }
      }

      // ============================================================
      // 🔍 Validação de Grupo
      // ============================================================
      if (!groupId || !groupId.endsWith("@g.us")) {
        return reply("❌ Este comando só pode ser usado dentro de grupos ou fornecendo um link de convite válido.");
      }

      if (!metadata) {
        metadata = await socket.groupMetadata(groupId);
      }

      const participantes = metadata.participants.map((p) => p.id);

      if (!participantes || participantes.length === 0) {
        return reply("⚠️ Nenhum contato encontrado neste grupo.");
      }

      // ============================================================
      // 🔎 Filtro de Contatos (Mencionado ou Limite Numérico)
      // ============================================================
      if (argumentoRestante) {
        if (argumentoRestante.startsWith("@")) {
          const mentions = argumentoRestante
            .split(/\s+/)
            .filter((m) => m.startsWith("@"));

          contatosSelecionados = participantes.filter((p) =>
            mentions.includes("@" + p.split("@")[0])
          );
        } else if (/^\d+$/.test(argumentoRestante)) {
          limite = Math.min(parseInt(argumentoRestante, 10), 999);
          contatosSelecionados = participantes.slice(0, limite);
        }
      }

      if (!contatosSelecionados || contatosSelecionados.length === 0) {
        contatosSelecionados = participantes;
      }

      // ============================================================
      // 💾 Salvamento dos Contatos
      // ============================================================
      const dirPath = path.join(baseDir, "assets", "database");
      const filePath = path.join(dirPath, "contatos.json");

      if (!fs.existsSync(dirPath)) {
        fs.mkdirSync(dirPath, { recursive: true });
      }

      fs.writeFileSync(
        filePath,
        JSON.stringify(
          {
            grupo: {
              id: groupId,
              nome: metadata.subject,
            },
            contatos: contatosSelecionados,
          },
          null,
          2
        )
      );

      info(`[💾] ${contatosSelecionados.length} contatos salvos do grupo ${metadata.subject}`);
      return reply(`✅ *${contatosSelecionados.length} contatos* salvos com sucesso em *contatos.json*!`);

    } catch (e) {
      error(`Erro ao extrair contatos: ${e?.stack || e?.message || e}`);
      return reply("❌ Ocorreu um erro interno ao tentar salvar os contatos.");
    }
  },
};
