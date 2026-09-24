/**
 * ============================================================
 * AMHEEX BOT — ARQUIVO ÚNICO (BLINDADO, RESILIENTE & FIXADO)
 * ============================================================
 */
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");
const { spawn } = require("node:child_process");
const pino = require("pino");
const NodeCache = require("node-cache");
const qrcode = require("qrcode-terminal");

// Importação com Fallback Inteligente (Prefere @whiskeysockets/baileys)
let baileys;
try {
  baileys = require("@whiskeysockets/baileys");
} catch {
  try {
    baileys = require("baileys");
  } catch (err) {
    console.error("[FATAL] Nenhuma biblioteca do Baileys foi encontrada. Execute: npm install @whiskeysockets/baileys");
    process.exit(1);
  }
}

const {
  default: makeWASocket,
  DisconnectReason,
  useMultiFileAuthState,
  makeCacheableSignalKeyStore,
  isJidBroadcast,
  isJidStatusBroadcast
} = baileys;

/* ============================================================
   CONFIGURAÇÃO
============================================================ */
const BOT_NAME = "🤖「 WHATSAPP-BOT 」🤖";
const BOT_EMOJI = "🤖";
const BASE_DIR = path.resolve(__dirname);
const ASSETS_DIR = path.join(BASE_DIR, "assets");
const BAILEYS_DIR = path.join(ASSETS_DIR, "database", "baileys");
const TEMP_DIR = path.join(ASSETS_DIR, "temp");
const LOG_FILE = path.join(TEMP_DIR, "wa-logs.txt");

/* ============================================================
   DIRETÓRIOS DE COMANDOS
============================================================ */
const POSSIBLE_CMD_DIRS = [
  path.join(BASE_DIR, "src", "command"),
  path.join(BASE_DIR, "src", "commands")
];
const CMD_DIRS = POSSIBLE_CMD_DIRS.filter(dir => fs.existsSync(dir));
const CMD_DIR = CMD_DIRS[0] || path.join(BASE_DIR, "src", "command");

/* ============================================================
   CRIA DIRETÓRIOS
============================================================ */
for (const dir of [ASSETS_DIR, BAILEYS_DIR, TEMP_DIR, CMD_DIR]) {
  try {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  } catch (err) {
    console.error(`[${BOT_NAME}] Erro criando diretório ${dir}:`, err.message);
  }
}

/* ============================================================
   LOGGER & LOGS
============================================================ */
const logger = pino(
  {
    timestamp: () => `,"time":"${new Date().toJSON()}"`,
    level: "silent"
  },
  pino.destination(LOG_FILE)
);

function log(prefix, message) {
  console.log(`[${BOT_NAME} ${prefix}] ${message}`);
}
function info(message) { log("INFO", message); }
function success(message) { log("SUCCESS", message); }
function warning(message) { log("WARNING", message); }
function error(message) { log("ERROR", message); }

/* ============================================================
   INPUT DE PAREAMENTO
============================================================ */
let activeReadline = null;

function question(message) {
  if (activeReadline) {
    try { activeReadline.close(); } catch {}
    activeReadline = null;
  }
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });
  activeReadline = rl;
  return new Promise(resolve => {
    rl.question(message, answer => {
      rl.close();
      activeReadline = null;
      resolve(answer);
    });
  });
}

/* ============================================================
   HOT-RELOAD DE COMANDOS (SEM REINICIAR O BOT INTEIRO)
============================================================ */
const commands = new Map();

function normalizeCommandName(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/^[!/#.$%]+/, "")
    .split(/\s+/)[0];
}

function readCommandsFromDir(dirPath) {
  if (!fs.existsSync(dirPath)) return;
  let items;
  try {
    items = fs.readdirSync(dirPath);
  } catch (err) {
    error(`Erro ao ler comandos em ${dirPath}: ${err.message}`);
    return;
  }
  for (const item of items) {
    const fullPath = path.join(dirPath, item);
    let stat;
    try { stat = fs.statSync(fullPath); } catch { continue; }
    if (stat.isDirectory()) {
      readCommandsFromDir(fullPath);
      continue;
    }
    if (!item.endsWith(".js")) continue;
    try {
      delete require.cache[require.resolve(fullPath)];
      const mod = require(fullPath);
      const baseName = path.basename(item, ".js").toLowerCase();
      const commandNames = new Set([baseName]);
      if (mod && typeof mod === "object") {
        if (mod.name) commandNames.add(String(mod.name).toLowerCase());
        if (Array.isArray(mod.commands)) mod.commands.forEach(c => commandNames.add(String(c).toLowerCase()));
        if (Array.isArray(mod.aliases)) mod.aliases.forEach(a => commandNames.add(String(a).toLowerCase()));
        if (Array.isArray(mod.prefixes)) mod.prefixes.forEach(p => commandNames.add(String(p).toLowerCase()));
      }
      for (const name of commandNames) {
        const normalized = normalizeCommandName(name);
        if (normalized && !commands.has(normalized)) {
          commands.set(normalized, mod);
        }
      }
    } catch (err) {
      error(`Falha ao carregar ${item}: ${err.stack || err.message}`);
    }
  }
}

function loadCommands() {
  commands.clear();
  const targetDirs = CMD_DIRS.length ? CMD_DIRS : [CMD_DIR];
  for (const dir of targetDirs) readCommandsFromDir(dir);
  info(`Total de comandos recarregados/mapeados: ${commands.size}`);
}

function findCommand(text) {
  const clean = String(text || "").trim();
  const firstWord = normalizeCommandName(clean);
  if (!firstWord) return null;
  const command = commands.get(firstWord);
  if (!command) return null;
  return { name: firstWord, command };
}

/* ============================================================
   AUTO RESTART APENAS PARA ARQUIVOS RAIZ / SISTEMA
============================================================ */
const AUTO_RESTART = {
  enabled: true,
  interval: 2000,
  debounce: 2000,
  restarting: false,
  timer: null,
  snapshot: new Map(),
  watcherStarted: false
};

const RESTART_IGNORE = [
  "node_modules",
  ".git",
  path.join("assets"),
  path.join("src", "command"),
  path.join("src", "commands")
];

function isIgnoredPath(filePath) {
  const relative = path.relative(BASE_DIR, filePath);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    return true;
  }
  return RESTART_IGNORE.some(
    ignore => relative === ignore || relative.startsWith(ignore + path.sep)
  );
}

function getFileSnapshot() {
  const snapshot = new Map();
  function scan(dir) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (isIgnoredPath(fullPath)) continue;
      if (entry.isDirectory()) {
        scan(fullPath);
        continue;
      }
      if (entry.isFile()) {
        try {
          const stat = fs.statSync(fullPath);
          snapshot.set(fullPath, `${stat.size}:${stat.mtimeMs}`);
        } catch {}
      }
    }
  }
  scan(BASE_DIR);
  return snapshot;
}

function detectSnapshotChange(previous, current) {
  for (const [filePath, signature] of current) {
    if (!previous.has(filePath) || previous.get(filePath) !== signature) {
      return {
        type: previous.has(filePath) ? "ALTERADO" : "NOVO",
        filePath
      };
    }
  }
  for (const filePath of previous.keys()) {
    if (!current.has(filePath)) {
      return { type: "REMOVIDO", filePath };
    }
  }
  return null;
}

let activeSocket = null;
let reconnectTimer = null;

function restartSystem(reason) {
  if (AUTO_RESTART.restarting) return;
  AUTO_RESTART.restarting = true;
  if (AUTO_RESTART.timer) clearTimeout(AUTO_RESTART.timer);
  if (reconnectTimer) clearTimeout(reconnectTimer);
  info(`Auto-Restart de sistema disparado. Motivo: ${reason}`);
  try {
    if (activeSocket && typeof activeSocket.end === "function") {
      activeSocket.end(undefined);
    }
  } catch (err) {
    warning(`Erro fechando socket no restart: ${err.message}`);
  }
  try {
    const child = spawn(process.execPath, process.argv.slice(1), {
      cwd: process.cwd(),
      env: process.env,
      stdio: "inherit"
    });
    child.once("error", err => {
      error(`Falha ao sub-processar restart: ${err.message}`);
      AUTO_RESTART.restarting = false;
    });
    setTimeout(() => process.exit(0), 1000);
  } catch (err) {
    error(`Erro ao executar restart: ${err.message}`);
    AUTO_RESTART.restarting = false;
  }
}

function startBaseDirWatcher() {
  if (!AUTO_RESTART.enabled || AUTO_RESTART.watcherStarted) return;
  AUTO_RESTART.watcherStarted = true;
  info("Watcher do sistema e atualização rápida de comandos ativos.");
  
  // Watcher dos comandos para Hot-Reload
  const targetDirs = CMD_DIRS.length ? CMD_DIRS : [CMD_DIR];
  for (const cDir of targetDirs) {
    try {
      fs.watch(cDir, { recursive: true }, (eventType, filename) => {
        if (filename && filename.endsWith(".js")) {
          info(`Alteração detectada no comando "${filename}". Atualizando comandos sem reiniciar o bot...`);
          loadCommands();
        }
      });
    } catch (e) {}
  }

  AUTO_RESTART.snapshot = getFileSnapshot();
  setInterval(() => {
    if (AUTO_RESTART.restarting) return;
    const current = getFileSnapshot();
    const change = detectSnapshotChange(AUTO_RESTART.snapshot, current);
    AUTO_RESTART.snapshot = current;
    if (!change) return;
    const relativePath = path.relative(BASE_DIR, change.filePath);
    clearTimeout(AUTO_RESTART.timer);
    AUTO_RESTART.timer = setTimeout(() => {
      restartSystem(`${change.type}: ${relativePath}`);
    }, AUTO_RESTART.debounce);
  }, AUTO_RESTART.interval);
}

/* ============================================================
   CACHE & CONTROLE DE MENSAGENS
============================================================ */
const msgRetryCounterCache = new NodeCache();
const outgoingIds = new Set();
const MAX_OUTGOING_IDS = 2000;

function markOutgoing(result) {
  const id = result?.key?.id;
  if (!id) return result;
  outgoingIds.add(id);
  if (outgoingIds.size > MAX_OUTGOING_IDS) {
    const first = outgoingIds.values().next().value;
    if (first) outgoingIds.delete(first);
  }
  return result;
}

/* ============================================================
   EXTRAÇÃO E TRATAMENTO DE MENSAGENS
============================================================ */
function unwrapMessage(message) {
  let current = message || {};
  for (let i = 0; i < 15; i++) {
    if (current.ephemeralMessage?.message) { current = current.ephemeralMessage.message; continue; }
    if (current.viewOnceMessage?.message) { current = current.viewOnceMessage.message; continue; }
    if (current.viewOnceMessageV2?.message) { current = current.viewOnceMessageV2.message; continue; }
    if (current.viewOnceMessageV2Extension?.message) { current = current.viewOnceMessageV2Extension.message; continue; }
    if (current.documentWithCaptionMessage?.message) { current = current.documentWithCaptionMessage.message; continue; }
    if (current.editedMessage?.message) { current = current.editedMessage.message; continue; }
    if (current.protocolMessage?.editedMessage) { current = current.protocolMessage.editedMessage; continue; }
    break;
  }
  return current;
}

function getMessageType(webMessage) {
  try {
    const message = unwrapMessage(webMessage?.message);
    if (!message) return "unknown";
    return Object.keys(message)[0] || "unknown";
  } catch {
    return "unknown";
  }
}

function getContextInfo(message) {
  try {
    return (
      message?.contextInfo ||
      message?.extendedTextMessage?.contextInfo ||
      message?.imageMessage?.contextInfo ||
      message?.videoMessage?.contextInfo ||
      message?.documentMessage?.contextInfo ||
      message?.audioMessage?.contextInfo ||
      message?.stickerMessage?.contextInfo ||
      null
    );
  } catch {
    return null;
  }
}

function extractMessageDetails(webMessage) {
  try {
    const original = webMessage?.message || {};
    const message = unwrapMessage(original);
    const key = webMessage?.key || {};
    if (!message) {
      return {
        type: "unknown", text: "", buttonId: "", buttonText: "",
        listId: "", listTitle: "", data: {}, raw: {}, original,
        contextInfo: null, key
      };
    }
    let type = getMessageType(webMessage);
    let text = "";
    let data = {};

    const interactiveMsg = message?.interactiveResponseMessage || message?.viewOnceMessage?.message?.interactiveResponseMessage;
    if (interactiveMsg?.nativeFlowResponseMessage?.paramsJson) {
      try {
        const parsed = JSON.parse(interactiveMsg.nativeFlowResponseMessage.paramsJson);
        text = parsed.id || parsed.selectedId || "";
      } catch (_) {}
    } else if (message.buttonsResponseMessage) {
      text = message.buttonsResponseMessage.selectedButtonId || "";
    } else if (message.templateButtonReplyMessage) {
      text = message.templateButtonReplyMessage.selectedId || "";
    } else if (message.conversation) {
      type = "text";
      text = message.conversation;
      data = { text: message.conversation };
    } else if (message.extendedTextMessage) {
      type = "extended_text";
      text = message.extendedTextMessage.text || "";
      data = { ...message.extendedTextMessage };
    } else if (message.imageMessage) {
      type = "image";
      text = message.imageMessage.caption || "";
      data = { ...message.imageMessage };
    } else if (message.videoMessage) {
      type = "video";
      text = message.videoMessage.caption || "";
      data = { ...message.videoMessage };
    } else {
      type = getMessageType(webMessage);
      data = { ...message };
    }

    return {
      type,
      text: String(text || "").trim(),
      data,
      raw: message,
      original,
      contextInfo: getContextInfo(message),
      key,
      webMessage
    };
  } catch {
    return {
      type: "unknown", text: "", data: {}, raw: {}, original: webMessage?.message || {},
      contextInfo: null, key: webMessage?.key || {}
    };
  }
}

function getRemoteJid(webMessage) {
  return webMessage?.key?.remoteJid || null;
}

function getChatType(remoteJid) {
  if (!remoteJid) return "DESCONHECIDO";
  if (remoteJid.endsWith("@g.us")) return "GRUPO";
  if (remoteJid.endsWith("@newsletter")) return "CANAL";
  if (remoteJid.endsWith("@broadcast")) return "TRANSMISSÃO";
  if (remoteJid.endsWith("@s.whatsapp.net")) return "PRIVADO";
  return "OUTRO";
}

/* ============================================================
   FUNÇÕES DE ENVIO E INTERAÇÕES
============================================================ */
async function sendText(socket, jid, text, quoted) {
  if (!text) return null;
  const result = await socket.sendMessage(
    jid,
    { text: `${BOT_EMOJI} ${text}` },
    quoted ? { quoted } : undefined
  );
  return markOutgoing(result);
}

/* ============================================================
   CONTEXTO TOTAL PARA OS COMANDOS
============================================================ */
function createCommandContext(socket, webMessage, text, commandName) {
  const jid = getRemoteJid(webMessage);
  const key = webMessage?.key || {};
  const chatType = getChatType(jid);
  const senderJid = key.participant || key.remoteJid || "";
  const senderNumber = String(senderJid).replace(/[^0-9]/g, "");
  const args = String(text || "").trim().split(/\s+/).slice(1);

  const context = {
    socket, sock: socket, client: socket, conn: socket,
    message: webMessage, msg: webMessage, webMessage, m: webMessage,
    remoteJid: jid, jid, from: jid, chat: jid,
    senderJid, sender: senderJid, senderNumber,
    pushName: webMessage?.pushName || "", fromMe: !!key.fromMe,
    chatType,
    text, args,
    command: commandName, commandName,
    send: (content, options) => socket.sendMessage(jid, content, options),
    sendText: (value, quoted = webMessage) => sendText(socket, jid, value, quoted),
    reply: value => sendText(socket, jid, value, webMessage),
    sendReply: value => sendText(socket, jid, value, webMessage)
  };

  if (webMessage && typeof webMessage === "object") {
    webMessage.sendReply = context.sendReply;
    webMessage.reply = context.reply;
    webMessage.sendText = context.sendText;
  }

  return context;
}

/* ============================================================
   EXECUÇÃO DE COMANDOS
============================================================ */
async function executeCommand(socket, webMessage, text) {
  try {
    const found = findCommand(text);
    if (!found || !found.command) return false;
    const commandName = found.name;
    const mod = found.command;
    const context = createCommandContext(socket, webMessage, text, commandName);
    info(`Executando: ${commandName} por ${context.senderNumber || "desconhecido"}`);

    if (typeof mod === "function") {
      await mod(context, webMessage, context.args);
    } else if (mod && typeof mod.handle === "function") {
      await mod.handle(context, webMessage, context.args);
    } else if (mod && typeof mod.execute === "function") {
      await mod.execute(context, webMessage, context.args);
    }
    success(`Concluído: ${commandName}`);
    return true;
  } catch (err) {
    error(`Erro isolado no comando (não derruba a conexão): ${err?.stack || err?.message || err}`);
    return true;
  }
}

/* ============================================================
   PROCESSAMENTO DE MENSAGENS
============================================================ */
async function processMessage(socket, webMessage) {
  try {
    const key = webMessage?.key || {};
    const remoteJid = key.remoteJid;
    if (!remoteJid || !webMessage?.message) return;
    const details = extractMessageDetails(webMessage);
    const text = details.text;
    if (!text) return;
    await executeCommand(socket, webMessage, text);
  } catch (err) {
    error(`Erro em processMessage: ${err?.message || err}`);
  }
}

/* ============================================================
   LIMPEZA DE SESSÃO SE CORROMPIDA
============================================================ */
function purgeCorruptedSession() {
  try {
    if (fs.existsSync(BAILEYS_DIR)) {
      const files = fs.readdirSync(BAILEYS_DIR);
      for (const file of files) {
        fs.unlinkSync(path.join(BAILEYS_DIR, file));
      }
      info("Sessão antiga/corrompida removida com sucesso.");
    }
  } catch (e) {
    error(`Erro limpando arquivos de sessão: ${e.message}`);
  }
}

/* ============================================================
   CONEXÃO COM A BAILEYS (TRATAMENTO DE ERRO 440)
============================================================ */
async function connect() {
  if (AUTO_RESTART.restarting) return null;
  if (activeSocket) {
    warning("Instância de conexão já ativa. Ignorando requisição de reconexão duplicada.");
    return activeSocket;
  }

  const { state, saveCreds } = await useMultiFileAuthState(BAILEYS_DIR);

  const socket = makeWASocket({
    logger,
    printQRInTerminal: false,
    browser: ["Ubuntu", "Chrome", "125.0.0.0"],
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger)
    },
    shouldIgnoreJid: jid => isJidBroadcast(jid) || isJidStatusBroadcast(jid),
    connectTimeoutMs: 60_000,
    keepAliveIntervalMs: 25_000,
    markOnlineOnConnect: true,
    syncFullHistory: false,
    emitOwnEvents: true,
    msgRetryCounterCache
  });
  activeSocket = socket;

  let promptTimer = null;

  socket.ev.on("connection.update", async update => {
    const { connection, qr, lastDisconnect } = update;
    
    if (qr && !state.creds.registered && !AUTO_RESTART.restarting) {
      info("QR Code gerado (escaneie no aplicativo):");
      qrcode.generate(qr, { small: true });

      if (promptTimer) clearTimeout(promptTimer);

      promptTimer = setTimeout(async () => {
        if (AUTO_RESTART.restarting || state.creds.registered) return;
        try {
          const phoneNumber = await question("\nDigite o número com DDI (ex: 5511999999999) ou ENTER para QR Code: ");
          if (AUTO_RESTART.restarting) return;
          const cleanNumber = String(phoneNumber || "").replace(/[^0-9]/g, "");
          if (cleanNumber) {
            info("Solicitando código de pareamento...");
            const code = await socket.requestPairingCode(cleanNumber);
            console.log("\n=================================");
            success(`CÓDIGO DE PAREAMENTO: ${code}`);
            console.log("=================================\n");
          }
        } catch (err) {
          if (!AUTO_RESTART.restarting) {
            error(`Erro no pareamento: ${err?.message || err}`);
          }
        }
      }, 500);
    }

    if (connection === "open") {
      if (promptTimer) clearTimeout(promptTimer);
      if (activeReadline) {
        try { activeReadline.close(); } catch {}
        activeReadline = null;
      }
      success("Conectado ao WhatsApp com sucesso!");
    }

    if (connection === "close") {
      if (promptTimer) clearTimeout(promptTimer);
      if (activeReadline) {
        try { activeReadline.close(); } catch {}
        activeReadline = null;
      }
      
      activeSocket = null;
      if (AUTO_RESTART.restarting) return;
      
      const statusCode = lastDisconnect?.error?.output?.statusCode || lastDisconnect?.error?.statusCode;
      const reason = lastDisconnect?.error?.output?.payload?.error || "Desconhecido";
      
      warning(`Conexão fechada. Código Status: ${statusCode || "N/A"} (${reason})`);

      // Tratamento para Erro 440 ou sessão substituída/duplicada
      if (statusCode === 440) {
        warning("Erro 440 (Sessão Conflitante). Aguardando estabilização para reconectar...");
        if (reconnectTimer) clearTimeout(reconnectTimer);
        reconnectTimer = setTimeout(() => connect(), 3000);
        return;
      }

      if (statusCode === DisconnectReason.loggedOut || statusCode === 401) {
        error("Sessão revogada ou inválida (Logged Out). Limpando sessão...");
        purgeCorruptedSession();
        warning("Reiniciando para gerar novo QR Code em 5 segundos...");
        setTimeout(() => connect(), 5000);
        return;
      }
      
      warning("Reconectando em 3 segundos...");
      if (reconnectTimer) clearTimeout(reconnectTimer);
      reconnectTimer = setTimeout(async () => {
        reconnectTimer = null;
        if (AUTO_RESTART.restarting) return;
        try {
          await connect();
        } catch (err) {
          error(`Erro ao reconectar: ${err?.message || err}`);
        }
      }, 3000);
    }
  });

  socket.ev.on("creds.update", saveCreds);

  socket.ev.on("messages.upsert", async data => {
    const messages = Array.isArray(data?.messages) ? data.messages : [];
    if (!messages.length) return;
    for (const webMessage of messages) {
      try {
        await processMessage(socket, webMessage);
      } catch (err) {
        error(`Erro no processamento da mensagem: ${err?.stack || err?.message || err}`);
      }
    }
  });

  return socket;
}

/* ============================================================
   INICIALIZAÇÃO & TRATAMENTO DE ERROS GLOBAIS
============================================================ */
async function start() {
  console.clear();
  console.log("\n🤖「 ============================================================ 」🤖\n");
  console.log("                       🤖「 WHATSAPP BOT 」🤖");
  console.log("\n🤖「 ============================================================ 」🤖\n");
  info(`BASE_DIR: ${BASE_DIR}`);
  info(`Diretório de Comandos: ${CMD_DIR}`);
  loadCommands();
  startBaseDirWatcher();
  info("Iniciando socket do WhatsApp...");
  await connect();
}

process.on("uncaughtException", err => {
  error(`UNCAUGHT EXCEPTION IGNORADA: ${err?.stack || err?.message || err}`);
});
process.on("unhandledRejection", reason => {
  error(`UNHANDLED REJECTION IGNORADA: ${reason?.stack || reason?.message || reason}`);
});

start().catch(err => {
  error(`Erro fatal na inicialização: ${err?.stack || err?.message || err}`);
  process.exit(1);
});
