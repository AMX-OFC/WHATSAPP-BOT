"use strict";

const path = require("path");
const axios = require("axios");

/* =====================================================
   CONFIGURAÇÃO PRINCIPAL
===================================================== */

const CONFIG = {
  nome: "🤖「 AMHEEX-PAG 」🤖",
  footer: "🤖「 AMHEEX-PAG 」🤖 | Sistema de Pagamento",

  // APIs do Sistema
  apiGenerate: "https://api-amheex.onrender.com/X/pix/generate/payment/point/v1/index.php",
  apiVerify: "https://api-amheex.onrender.com/X/pix/verification/payment/point/v1/index.php",

  // Configuração da verificação automática
  intervaloVerificacao: 5000, // 5 segundos
  tempoExpiracao: 15 * 60 * 1000, // Expira sessão em 15 minutos

  // Definição dos Botões
  botoes: {
    copiar: {
      id: "pix_copiar",
      text: "📋 Copiar Chave Pix",
    },
    cancelar: {
      id: "pix_cancelar",
      text: "❌ Cancelar Pix",
    },
  },
};

/* =====================================================
   IMPORTAÇÃO DOS BOTÕES
===================================================== */

let sendButtons = null;
let sendInteractiveMessage = null;

try {
  const buttonsPath = path.join(process.cwd(), "src", "buttons");
  const buttonsModule = require(buttonsPath);

  if (typeof buttonsModule?.sendButtons === "function") {
    sendButtons = buttonsModule.sendButtons;
  }

  if (typeof buttonsModule?.sendInteractiveMessage === "function") {
    sendInteractiveMessage = buttonsModule.sendInteractiveMessage;
  }
} catch (error) {
  console.log("[PIX] Módulo de botões em modo nativo:", error?.message || error);
}

/* =====================================================
   GERENCIAMENTO DE SESSÕES E INTERVALOS
===================================================== */

const sessoesPix = Object.create(null);

function pararMonitoramento(chave) {
  if (sessoesPix[chave]?.timer) {
    clearInterval(sessoesPix[chave].timer);
  }
  delete sessoesPix[chave];
}

/* =====================================================
   HELPERS
===================================================== */

function obterSocket(ctx) {
  return ctx?.socket || ctx?.sock || ctx?.client || ctx?.conn || ctx;
}

function obterMensagem(ctx, p2) {
  return ctx?.webMessage || ctx?.message || ctx?.msg || ctx?.m || p2 || null;
}

function obterJid(ctx, mensagem) {
  return ctx?.remoteJid || ctx?.jid || ctx?.from || ctx?.chat || mensagem?.key?.remoteJid || null;
}

function obterRemetente(ctx, mensagem, jid) {
  const rawSender = mensagem?.key?.participant || ctx?.sender || mensagem?.participant || mensagem?.key?.remoteJid || jid || "desconhecido";
  return String(rawSender).trim();
}

function extrairTexto(ctx, mensagem, args) {
  const msg = mensagem?.message;

  // Extração de resposta interativa (botões)
  const interactiveMsg = msg?.interactiveResponseMessage || msg?.viewOnceMessage?.message?.interactiveResponseMessage;
  if (interactiveMsg?.nativeFlowResponseMessage?.paramsJson) {
    try {
      const parsed = JSON.parse(interactiveMsg.nativeFlowResponseMessage.paramsJson);
      return parsed.id || parsed.selectedId || "";
    } catch (_) {}
  }

  const textoEntrada = String(
    ctx?.text || ctx?.body || msg?.conversation || msg?.extendedTextMessage?.text || ""
  ).trim();

  if (textoEntrada) return textoEntrada;
  if (Array.isArray(args) && args.length) return args.join(" ").trim();
  return "";
}

/**
 * Extrai detalhes minuciosos de erros do Axios/Servidor
 */
function formatarErroDetalhado(error) {
  if (axios.isAxiosError(error)) {
    if (error.response) {
      const status = error.response.status;
      const data = typeof error.response.data === "object" 
        ? JSON.stringify(error.response.data) 
        : String(error.response.data);
      return `[HTTP ${status}]${data}`;
    } else if (error.request) {
      return `[Rede] Sem resposta do servidor. O serviço pode estar hibernando no Render.`;
    }
  }
  return error?.message || String(error);
}

/* =====================================================
   FUNÇÕES DE ENVIO NATIVO/CUSTOMIZADO
===================================================== */

async function enviarPixComImagemEBotoes(socket, jid, { texto, qrBuffer, chavePix, quoted }) {
  const botoesFormatados = [
    {
      name: "cta_copy",
      buttonParamsJson: JSON.stringify({
        display_text: CONFIG.botoes.copiar.text,
        id: CONFIG.botoes.copiar.id,
        copy_code: chavePix,
      }),
    },
    {
      name: "quick_reply",
      buttonParamsJson: JSON.stringify({
        display_text: CONFIG.botoes.cancelar.text,
        id: CONFIG.botoes.cancelar.id,
      }),
    },
  ];

  const mensagem = {
    viewOnceMessage: {
      message: {
        interactiveMessage: {
          body: { text: String(texto) },
          footer: { text: CONFIG.footer },
          header: qrBuffer
            ? {
                hasMediaAttachment: true,
                imageMessage: { jpegThumbnail: qrBuffer },
              }
            : undefined,
          nativeFlowMessage: {
            buttons: botoesFormatados,
          },
        },
      },
    },
  };

  if (typeof sendInteractiveMessage === "function") {
    try {
      return await sendInteractiveMessage(socket, jid, {
        image: qrBuffer,
        text: String(texto),
        footer: CONFIG.footer,
        quoted,
        interactiveButtons: botoesFormatados,
      });
    } catch (e) {
      console.log("[PIX] Falha no wrapper interativo, usando fallback nativo.");
    }
  }

  return socket.sendMessage(jid, mensagem, { quoted: quoted || undefined });
}

/* =====================================================
   MÓDULO PRINCIPAL
===================================================== */

module.exports = {
  name: "pix",

  prefixes: ["pix", "Pix", "PIX"],

  commands: ["pix", "pix_cancelar", "pix_copiar"],

  aliases: ["gerarpix", "pagar"],

  description: "Gerador de Pagamento PIX com Verificação Automática",

  usage: "pix <valor>",

  handle: async (ctx = {}, p2, p3) => {
    const socket = obterSocket(ctx);
    const webMessage = obterMensagem(ctx, p2);
    const remoteJid = obterJid(ctx, webMessage);
    const args = ctx?.args || p3 || [];
    const texto = extrairTexto(ctx, webMessage, Array.isArray(args) ? args : [args]);
    const remetente = obterRemetente(ctx, webMessage, remoteJid);

    const enviarResposta = async (msg) => {
      if (!socket || !remoteJid) return;
      return socket.sendMessage(remoteJid, { text: `🤖 ${msg}` }, { quoted: webMessage });
    };

    try {
      if (!socket || !remoteJid) return;

      const textoMin = texto.toLowerCase();

      /* =============================================
         AÇÃO: CANCELAMENTO DO PIX
      ============================================= */
      if (textoMin.includes("pix_cancelar") || textoMin.includes("cancelar pix") || textoMin === "cancelar") {
        if (sessoesPix[remetente]) {
          pararMonitoramento(remetente);
          return enviarResposta("O seu pedido de PIX foi cancelado com sucesso!");
        }
        return enviarResposta("Você não possui nenhuma cobrança PIX ativa no momento.");
      }

      /* =============================================
         GERAÇÃO DE UM NOVO PIX
      ============================================= */
      const valorFormatado = texto.replace(/^pix\s*/i, "").replace(",", ".").trim();
      const valor = parseFloat(valorFormatado);

      if (isNaN(valor) || valor <= 0) {
        return enviarResposta("Por favor, insira um valor válido para gerar o PIX.\nExemplo: *pix 10.50*");
      }

      if (sessoesPix[remetente]) {
        pararMonitoramento(remetente);
      }

      await enviarResposta("⏳ Gerando cobrança PIX, aguarde um instante...");

      // 1. Requisição para a API de Geração
      let data;
      try {
        const response = await axios.get(`${CONFIG.apiGenerate}?valor=${valor}`, { timeout: 15000 });
        data = response.data;
      } catch (axiosErr) {
        const detalhe = formatarErroDetalhado(axiosErr);
        console.error("[PIX] Erro de Requisição (Geração):", detalhe);
        return enviarResposta(`⚠️ *Erro na API de PIX:*\n\`${detalhe}\``);
      }

      // Verificação de insucesso explícito da API
      if (data?.sucesso === false) {
        const motivo = data?.mensagem || data?.erro || "API retornou insucesso.";
        return enviarResposta(`⚠️ *Falha ao gerar PIX:*\n${motivo}`);
      }

      // 2. Leitura com fallback (Nível Raiz ou Aninhado em "dados")
      const conteudo = data?.dados || data || {};

      const idPagamento =
        conteudo.id_pagamento ||
        conteudo.id ||
        conteudo.pix_id;

      const chavePix =
        conteudo.qr_code_copia_cola ||
        conteudo.copia_cola ||
        conteudo.pix_copy_paste ||
        conteudo.qrcode ||
        conteudo.pix?.copia_cola ||
        conteudo.point_of_interaction?.transaction_data?.qr_code;

      const qrCodeBase64 =
        conteudo.qr_code_base64 ||
        conteudo.base64 ||
        conteudo.pix?.qr_code_base64;

      if (!idPagamento || !chavePix) {
        console.error("[PIX] Resposta JSON incompleta:", JSON.stringify(data));
        return enviarResposta(
          `⚠️ *Erro de Estrutura JSON:*\nCampos \`id_pagamento\` ou \`qr_code_copia_cola\` ausentes na resposta da API.\nResposta da API: \`${JSON.stringify(data)}\``
        );
      }

      // 3. Conversão segura do QR Code em Buffer
      let qrBuffer = null;
      if (typeof qrCodeBase64 === "string" && qrCodeBase64.length > 0) {
        try {
          const base64Limpo = qrCodeBase64.replace(/^data:image\/\w+;base64,/, "");
          qrBuffer = Buffer.from(base64Limpo, "base64");
        } catch (e) {
          console.error("[PIX] Erro ao converter Base64 da imagem:", e.message);
        }
      }

      const agora = new Date().toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" });

      const mensagemLegenda =
        `✨ *COBRANÇA PIX GERADA* ✨\n\n` +
        `💵 *Valor:* R$ ${valor.toFixed(2)}\n` +
        `🆔 *ID do Pagamento:* ${idPagamento}\n` +
        `📅 *Data/Hora:* ${agora}\n\n` +
        `👇 Use os botões abaixo para copiar a chave Pix Copia e Cola ou cancelar a cobrança.`;

      await enviarPixComImagemEBotoes(socket, remoteJid, {
        texto: mensagemLegenda,
        qrBuffer,
        chavePix,
        quoted: webMessage,
      });

      /* =============================================
         MONITORAMENTO CONTÍNUO
      ============================================= */
      const timer = setInterval(async () => {
        try {
          const checkRes = await axios.get(`${CONFIG.apiVerify}?id=${idPagamento}`, { timeout: 5000 });
          const checkData = checkRes.data;

          const aprovado =
            checkData?.pago === true ||
            checkData?.status === "approved" ||
            checkData?.status === "pago" ||
            checkData?.pagamento === "sucesso" ||
            checkData?.dados?.status === "approved" ||
            checkData?.dados?.pago === true;

          if (aprovado) {
            pararMonitoramento(remetente);
            return enviarResposta(
              `✅ *PAGAMENTO CONFIRMADO!*\n\n` +
              `O pagamento referente ao ID *${idPagamento}* (R$ ${valor.toFixed(2)}) foi aprovado com sucesso! 🎉`
            );
          }
        } catch (err) {
          console.error(`[PIX] Erro ao verificar pagamento ID ${idPagamento}:`, formatarErroDetalhado(err));
        }
      }, CONFIG.intervaloVerificacao);

      sessoesPix[remetente] = {
        idPagamento,
        valor,
        timer,
        criadoEm: Date.now(),
      };

      setTimeout(() => {
        if (sessoesPix[remetente] && sessoesPix[remetente].idPagamento === idPagamento) {
          pararMonitoramento(remetente);
        }
      }, CONFIG.tempoExpiracao);

    } catch (error) {
      const detalheErro = formatarErroDetalhado(error);
      console.error("[PIX] Erro Crítico na execução:", error?.stack || detalheErro);
      pararMonitoramento(remetente);
      return enviarResposta(`❌ *Erro de Execução Interna:*\n\`${detalheErro}\``);
    }
  },
};
