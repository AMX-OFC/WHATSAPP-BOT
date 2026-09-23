"use strict";

const fs = require("node:fs");
const path = require("node:path");

const CONFIG_FILE = path.join(__dirname, "..", "..", "assets", "temp", "welcome_config.json");

function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
    }
  } catch (err) {}
  return {};
}

function saveConfig(config) {
  try {
    const dir = path.dirname(CONFIG_FILE);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), "utf8");
  } catch (err) {}
}

/**
 * Dispara a mensagem de boas-vindas com tratamento seguro para a foto e ID do usuário
 */
async function triggerWelcome(socket, groupId, participant) {
  try {
    const groupMetadata = await socket.groupMetadata(groupId);
    const nomeGrupo = groupMetadata.subject || "AMHEEX";
    const totalMembros = groupMetadata.participants.length;

    // Trata formato de ID normal (@s.whatsapp.net) ou @lid
    const cleanId = String(participant || "").split("@")[0];
    const userJid = participant.includes("@") ? participant : `${cleanId}@s.whatsapp.net`;

    // Obtém a foto do grupo com segurança
    let imageBuffer = null;
    try {
      const pUrl = await socket.profilePictureUrl(groupId, "image");
      if (pUrl) {
        const resp = await fetch(pUrl);
        const arrayBuf = await resp.arrayBuffer();
        imageBuffer = Buffer.from(arrayBuf);
      }
    } catch (e) {
      // Se falhar ao pegar a foto do grupo, prossegue sem imagem
    }

    const agora = new Date();
    const dataFormatada = agora.toLocaleDateString("pt-BR");
    const horaFormatada = agora.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });

    const mensagemBoasVindas = `👋 *Bem-vindo(a) ao grupo \( {nomeGrupo}* 👋\n\nSeja muito bem-vindo(a) @ \){cleanId}!\n\nEstamos felizes em ter você aqui! 🌟\n\n📍 Total de membros: ${totalMembros}\n🗓️ *Data/Hora da entrada:* ${dataFormatada} às ${horaFormatada}\n\nDivirta-se e participe! 💬`;

    // Botão de suporte interativo URL (padrão Baileys NativeFlow)
    const nativeButtons = [
      {
        name: "cta_url",
        buttonParamsJson: JSON.stringify({
          display_text: "📞 Suporte",
          url: "https://wa.me/5546999020341?text=AMHEEX%20Olá",
          merchant_url: "https://wa.me/5546999020341?text=AMHEEX%20Olá"
        })
      }
    ];

    // Envio seguro utilizando o payload direto no sendMessage
    try {
      await socket.sendMessage(groupId, {
        viewOnce: false,
        interactiveMessage: {
          header: {
            hasMediaAttachment: Boolean(imageBuffer),
            imageMessage: imageBuffer 
              ? { jpegThumbnail: imageBuffer } 
              : undefined
          },
          body: {
            text: mensagemBoasVindas
          },
          footer: {
            text: "Central de Atendimento AMHEEX"
          },
          nativeFlowMessage: {
            buttons: nativeButtons
          }
        }
      }, { mentions: [userJid] });

    } catch (errInteractive) {
      // Fallback seguro enviando imagem comum + legenda com menção caso o chat rejeite o formato interativo
      await socket.sendMessage(groupId, {
        image: imageBuffer ? imageBuffer : undefined,
        caption: mensagemBoasVindas,
        mentions: [userJid]
      });
    }

  } catch (err) {
    console.error("[WELCOME] Erro ao enviar mensagem de boas-vindas:", err);
  }
}

module.exports = {
  name: "welcome",
  description: "Ativa/desativa ou testa o bem-vindo automático no grupo com foto + botão suporte",
  aliases: ["bemvindo", "boasvindas"],

  handle: async (ctx) => {
    const { remoteJid, args, reply } = ctx;

    try {
      if (!remoteJid.endsWith("@g.us")) {
        return reply("❌ Este comando só funciona em grupos.");
      }

      const subCommand = String(args[0] || "").toLowerCase();
      const config = loadConfig();

      if (subCommand === "on") {
        config[remoteJid] = true;
        saveConfig(config);
        return reply("✅ *Recurso de Boas-Vindas ativado!* Novos membros receberão a mensagem automática com foto e botão.");
      }

      if (subCommand === "off") {
        config[remoteJid] = false;
        saveConfig(config);
        return reply("❌ *Recurso de Boas-Vindas desativado* neste grupo.");
      }

      const statusAtual = config[remoteJid] ? "ATIVADO 🟢" : "DESATIVADO 🔴";
      return reply(`ℹ️ *Status do Boas-Vindas:* ${statusAtual}\n\nPara alterar, utilize:\n• \`!welcome on\` (Ativar)\n• \`!welcome off\` (Desativar)`);

    } catch (erro) {
      console.error("[WELCOME CMD] Erro:", erro);
      reply("❌ Ocorreu um erro ao processar o comando.");
    }
  },

  onGroupParticipantsUpdate: async (socket, update) => {
    try {
      const { id: groupId, participants, action } = update;
      
      if (action !== "add" || !participants || !participants.length) return;

      const config = loadConfig();
      if (!config[groupId]) return;

      for (const participant of participants) {
        await triggerWelcome(socket, groupId, participant);
        await new Promise((resolve) => setTimeout(resolve, 1500));
      }
    } catch (err) {
      console.error("[WELCOME EVENT] Erro:", err);
    }
  }
};