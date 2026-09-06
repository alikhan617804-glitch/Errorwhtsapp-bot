
import "dotenv/config";
import express from "express";
import makeWASocket, {
  Browsers,
  DisconnectReason,
  useMultiFileAuthState,
  makeCacheableSignalKeyStore
} from "@whiskeysockets/baileys";
import pino from "pino";
import qrcode from "qrcode-terminal";
import QRCode from "qrcode";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import configFile from "../config.json" with { type: "json" };
import { AUTO_REPLIES } from "./replies.js";
import {
  getGroupSettings, setGroupSettings, addWarning,
  clearWarnings, logAction
} from "./db.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
fs.mkdirSync(path.join(__dirname, "../data"), { recursive: true });
fs.mkdirSync(path.join(__dirname, "../auth"), { recursive: true });

const C = configFile;
const logger = pino({ level: process.env.LOG_LEVEL || "silent" });
const flood = new Map();
const cooldown = new Map();

function isGroup(jid) { return jid?.endsWith("@g.us"); }
function senderOf(msg) { return msg.key.participant || msg.key.remoteJid; }
function numberOf(jid) { return (jid || "").split("@")[0]; }

function unwrap(m) {
  if (!m) return null;
  if (m.ephemeralMessage?.message) return unwrap(m.ephemeralMessage.message);
  if (m.viewOnceMessage?.message) return unwrap(m.viewOnceMessage.message);
  if (m.viewOnceMessageV2?.message) return unwrap(m.viewOnceMessageV2.message);
  return m;
}

function textOf(msg) {
  const m = unwrap(msg.message);
  return m?.conversation ||
    m?.extendedTextMessage?.text ||
    m?.imageMessage?.caption ||
    m?.videoMessage?.caption ||
    m?.documentMessage?.caption || "";
}

function typeOf(msg) {
  const m = unwrap(msg.message);
  return m ? Object.keys(m)[0] : null;
}

function hasUrl(text) {
  return /(?:https?:\/\/|www\.|chat\.whatsapp\.com\/|t\.me\/|discord\.gg\/)/i.test(text);
}

function badWord(text) {
  const s = text.toLowerCase();
  return C.badWords.some(w => s.includes(w.toLowerCase()));
}

function mediaBlocked(type, settings) {
  const map = {
    imageMessage: "blockImage",
    videoMessage: "blockVideo",
    audioMessage: "blockAudio",
    documentMessage: "blockDocument",
    stickerMessage: "blockSticker"
  };
  return settings.antiMedia && map[type] && C.media[map[type]];
}

function parseCommand(text) {
  if (!text.startsWith(C.prefix)) return null;
  const parts = text.slice(C.prefix.length).trim().split(/\s+/);
  const command = (parts.shift() || "").toLowerCase();
  return { command, args: parts };
}

async function metadata(sock, jid) {
  return sock.groupMetadata(jid);
}

async function isAdmin(sock, jid, user) {
  const md = await metadata(sock, jid);
  const p = md.participants.find(x => x.id === user);
  return !!p && (p.admin === "admin" || p.admin === "superadmin");
}

function owner(user) {
  return C.ownerNumbers.includes(numberOf(user));
}

async function deleteMessage(sock, msg) {
  try { await sock.sendMessage(msg.key.remoteJid, { delete: msg.key }); return true; }
  catch { return false; }
}

async function warn(sock, msg, reason, settings) {
  const jid = msg.key.remoteJid;
  const user = senderOf(msg);
  const count = addWarning(jid, user);
  logAction(jid, user, "WARN", reason);

  if (settings.deleteWarnedMessages) await deleteMessage(sock, msg);

  await sock.sendMessage(jid, {
    text:
`${C.branding.header}

⚠️ *WARNING ${count}/${settings.maxWarnings}*

👤 @${numberOf(user)}
📌 Reason: ${reason}

${C.branding.footer}`,
    mentions: [user]
  });

  if (count >= settings.maxWarnings) {
    try {
      await sock.groupParticipantsUpdate(jid, [user], "remove");
      clearWarnings(jid, user);
      logAction(jid, user, "REMOVE", "Maximum warnings reached");
    } catch {
      await sock.sendMessage(jid, { text: "❌ I could not remove the member. Make sure I am a group admin." });
    }
  }
}

function quotedParticipant(msg) {
  return msg.message?.extendedTextMessage?.contextInfo?.participant;
}

function mentionTarget(msg, args) {
  const q = quotedParticipant(msg);
  if (q) return q;
  const mentioned = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid;
  if (mentioned?.length) return mentioned[0];
  if (args[0]) return `${args[0].replace(/\D/g, "")}@s.whatsapp.net`;
  return null;
}

async function commandHandler(sock, msg, parsed) {
  const jid = msg.key.remoteJid;
  const user = senderOf(msg);
  const { command, args } = parsed;

  if (command === "help" || command === "menu") {
    return sock.sendMessage(jid, { text:
`${C.branding.header}

⚡ *GENERAL*
!help • !ping • !bot • !rules • !reply

🛡️ *MODERATION*
!warn • !kick • !del • !admins
!antilink • !antispam • !antiflood • !antimedia

👑 *GROUP*
!tagall • !groupinfo • !promote • !demote

⚙️ *SETTINGS*
!settings • !set <feature> on/off
!warnings @user • !clearwarn @user

${C.branding.footer}` });
  }

  if (command === "ping") return sock.sendMessage(jid, { text: "🏓 PONG — ALTITUDE 💀 ONLINE" });
  if (command === "bot") return sock.sendMessage(jid, {
    text: `${C.branding.header}\n\n🟢 ONLINE\n💬 ${AUTO_REPLIES.length}+ replies\n🛡️ Moderation enabled\n⚡ Stable mode\n\n${C.branding.footer}`
  });
  if (command === "reply") {
    const r = AUTO_REPLIES[Math.floor(Math.random() * AUTO_REPLIES.length)];
    return sock.sendMessage(jid, { text: r });
  }
  if (command === "rules") return sock.sendMessage(jid, {
    text: "📜 *GROUP RULES*\n\n1. No spam\n2. No unwanted links\n3. Respect members\n4. No abusive content\n5. Follow admin instructions\n\n💀 ALTITUDE SECURITY"
  });

  if (!isGroup(jid)) return;

  const admin = await isAdmin(sock, jid, user);
  if (!admin && !owner(user)) return sock.sendMessage(jid, { text: "⛔ Admin-only command." });

  const settings = getGroupSettings(jid, C.settings);

  if (command === "settings") {
    return sock.sendMessage(jid, { text:
`⚙️ *ALTITUDE SETTINGS*

Anti-Link: ${settings.antiLink ? "ON" : "OFF"}
Anti-Spam: ${settings.antiSpam ? "ON" : "OFF"}
Anti-Flood: ${settings.antiFlood ? "ON" : "OFF"}
Bad Words: ${settings.antiBadWords ? "ON" : "OFF"}
Media Filter: ${settings.antiMedia ? "ON" : "OFF"}
Welcome: ${settings.welcome ? "ON" : "OFF"}
Auto Replies: ${settings.autoReplies ? "ON" : "OFF"}
Max Warnings: ${settings.maxWarnings}`
    });
  }

  if (command === "set") {
    const allowed = ["antiLink","antiSpam","antiFlood","antiBadWords","antiMedia","welcome","goodbye","autoReplies","deleteWarnedMessages"];
    const key = args[0];
    const value = args[1]?.toLowerCase();
    if (!allowed.includes(key) || !["on","off"].includes(value))
      return sock.sendMessage(jid, { text: `Usage: !set ${allowed[0]} on|off` });
    settings[key] = value === "on";
    setGroupSettings(jid, settings);
    return sock.sendMessage(jid, { text: `✅ ${key}: ${settings[key] ? "ON" : "OFF"}` });
  }

  if (command === "antilink" || command === "antispam" || command === "antiflood" || command === "antimedia") {
    const key = {antilink:"antiLink", antispam:"antiSpam", antiflood:"antiFlood", antimedia:"antiMedia"}[command];
    settings[key] = !settings[key];
    setGroupSettings(jid, settings);
    return sock.sendMessage(jid, { text: `⚙️ ${key}: ${settings[key] ? "ON" : "OFF"}` });
  }

  if (command === "warn") {
    const target = mentionTarget(msg, args);
    if (!target) return sock.sendMessage(jid, { text: "Reply to or mention a member." });
    return warn(sock, { ...msg, key: { ...msg.key, participant: target } }, args.slice(1).join(" ") || "Admin warning", settings);
  }

  if (command === "clearwarn") {
    const target = mentionTarget(msg, args);
    if (!target) return sock.sendMessage(jid, { text: "Reply to or mention a member." });
    clearWarnings(jid, target);
    return sock.sendMessage(jid, { text: `✅ Warnings cleared for @${numberOf(target)}`, mentions: [target] });
  }

  if (command === "kick" || command === "remove") {
    const target = mentionTarget(msg, args);
    if (!target) return sock.sendMessage(jid, { text: "Reply to or mention a member." });
    try {
      await sock.groupParticipantsUpdate(jid, [target], "remove");
      logAction(jid, target, "REMOVE", "Admin command");
      return sock.sendMessage(jid, { text: `🚫 Removed @${numberOf(target)}\n\n💀 ALTITUDE`, mentions: [target] });
    } catch {
      return sock.sendMessage(jid, { text: "❌ Removal failed. Ensure the bot is an admin and has permission." });
    }
  }

  if (command === "del" || command === "delete") {
    if (!msg.message?.extendedTextMessage?.contextInfo?.stanzaId)
      return sock.sendMessage(jid, { text: "Reply to the message you want to delete." });
    const c = msg.message.extendedTextMessage.contextInfo;
    await sock.sendMessage(jid, { delete: { remoteJid: jid, fromMe: false, id: c.stanzaId, participant: c.participant } });
    return;
  }

  if (command === "admins") {
    const md = await metadata(sock, jid);
    const admins = md.participants.filter(p => p.admin);
    return sock.sendMessage(jid, {
      text: "👑 *ADMINS*\n\n" + admins.map((p,i)=>`${i+1}. @${numberOf(p.id)}`).join("\n"),
      mentions: admins.map(p=>p.id)
    });
  }

  if (command === "tagall") {
    const md = await metadata(sock, jid);
    const mentions = md.participants.map(p=>p.id);
    const body = args.join(" ") || "Attention everyone 👀";
    return sock.sendMessage(jid, {
      text: `📢 *${body}*\n\n${mentions.map(x=>`@${numberOf(x)}`).join(" ")}`,
      mentions
    });
  }

  if (command === "groupinfo") {
    const md = await metadata(sock, jid);
    return sock.sendMessage(jid, {
      text: `👑 *GROUP INFO*\n\nName: ${md.subject}\nMembers: ${md.participants.length}\nAdmins: ${md.participants.filter(p=>p.admin).length}`
    });
  }

  if (command === "promote" || command === "demote") {
    const target = mentionTarget(msg, args);
    if (!target) return sock.sendMessage(jid, { text: "Reply to or mention a member." });
    try {
      await sock.groupParticipantsUpdate(jid, [target], command);
      return sock.sendMessage(jid, { text: `✅ ${command} successful for @${numberOf(target)}`, mentions:[target] });
    } catch {
      return sock.sendMessage(jid, { text: `❌ Could not ${command} member.` });
    }
  }

  if (command === "warnings") {
    return sock.sendMessage(jid, { text: "Use !clearwarn @user to reset warnings. Warning counts are stored per group." });
  }
}

async function moderate(sock, msg) {
  const jid = msg.key.remoteJid;
  if (!isGroup(jid) || msg.key.fromMe) return;
  const user = senderOf(msg);
  const text = textOf(msg);
  const type = typeOf(msg);
  const settings = getGroupSettings(jid, C.settings);

  let admin = false;
  try { admin = await isAdmin(sock, jid, user); } catch {}

  if (admin || owner(user)) return;

  if (settings.antiLink && hasUrl(text)) {
    const allowed = C.allowedDomains.some(d => text.toLowerCase().includes(d));
    if (!allowed) return warn(sock, msg, "Unwanted link", settings);
  }

  if (settings.antiBadWords && badWord(text)) {
    return warn(sock, msg, "Blocked keyword", settings);
  }

  if (mediaBlocked(type, settings)) {
    return warn(sock, msg, "Blocked media type", settings);
  }

  if (settings.antiFlood) {
    const key = `${jid}:${user}`;
    const now = Date.now();
    const arr = (flood.get(key) || []).filter(t => now - t < settings.flood.windowSeconds * 1000);
    arr.push(now);
    flood.set(key, arr);
    if (arr.length >= settings.flood.messages) {
      flood.set(key, []);
      return warn(sock, msg, "Flood / spam", settings);
    }
  }
}

async function handleMessage(sock, msg) {
  if (!msg.message || msg.key.remoteJid === "status@broadcast") return;
  const jid = msg.key.remoteJid;
  const user = senderOf(msg);
  const text = textOf(msg);

  if (text) {
    const key = `${jid}:${user}`;
    const last = cooldown.get(key) || 0;
    if (Date.now() - last < C.settings.cooldownMs) return;
    cooldown.set(key, Date.now());
  }

  await moderate(sock, msg);

  const parsed = parseCommand(text);
  if (parsed) return commandHandler(sock, msg, parsed);

  if (!isGroup(jid)) return;
  const settings = getGroupSettings(jid, C.settings);
  if (!settings.autoReplies) return;

  const t = text.trim().toLowerCase();
  if (["hi","hello","hey","salam","assalamualaikum"].includes(t)) {
    return sock.sendMessage(jid, { text: AUTO_REPLIES[Math.floor(Math.random()*AUTO_REPLIES.length)] });
  }
}


// =====================================================
// PRIVATE LOGIN DASHBOARD — QR + PAIRING CODE
// =====================================================
const app = express();
const PORT = Number(process.env.PORT || 3000);
const LOGIN_TOKEN = process.env.LOGIN_TOKEN || "";
let latestQr = null;
let pairingCode = null;
let pairingStatus = "WAITING";

function authorized(req) {
  if (!LOGIN_TOKEN) return true;
  return (req.query.token || "") === LOGIN_TOKEN;
}

app.get("/", (req, res) => {
  if (!authorized(req)) return res.status(401).send("Unauthorized");
  res.type("html").send(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>ALTITUDE — WhatsApp Control Center</title>
<style>
:root{--bg:#050507;--panel:rgba(18,18,23,.78);--line:rgba(255,255,255,.10);--text:#f7f7f8;--muted:#9b9ba5;--accent:#8b5cf6;--accent2:#06b6d4;--ok:#22c55e}
*{box-sizing:border-box}html,body{margin:0;min-height:100%;background:var(--bg);color:var(--text);font-family:Inter,ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif}
body{overflow-x:hidden}.scene{position:fixed;inset:0;pointer-events:none;overflow:hidden;perspective:900px;background:radial-gradient(circle at 50% 15%,rgba(139,92,246,.18),transparent 38%),radial-gradient(circle at 90% 85%,rgba(6,182,212,.10),transparent 32%)}
.orb{position:absolute;border-radius:50%;filter:blur(1px);opacity:.55;transform:translateZ(0);animation:float 9s ease-in-out infinite}.orb.a{width:280px;height:280px;left:-90px;top:10%;background:radial-gradient(circle at 35% 30%,rgba(139,92,246,.5),transparent 65%)}.orb.b{width:360px;height:360px;right:-130px;bottom:-90px;background:radial-gradient(circle at 35% 30%,rgba(6,182,212,.34),transparent 65%);animation-delay:-3s}
@keyframes float{50%{transform:translate3d(0,-22px,35px)}}@media(prefers-reduced-motion:reduce){.orb,.logo3d,.cube{animation:none!important}}
.wrap{position:relative;width:min(1120px,94vw);margin:auto;padding:38px 0 55px}.top{display:flex;justify-content:space-between;align-items:center;gap:18px;margin-bottom:28px}.brand{display:flex;align-items:center;gap:14px}.logo3d{width:54px;height:54px;border:1px solid var(--line);border-radius:17px;display:grid;place-items:center;background:linear-gradient(145deg,#17131f,#0d0d11);box-shadow:inset 0 1px rgba(255,255,255,.08),0 18px 50px rgba(0,0,0,.35);transform-style:preserve-3d;animation:tilt 5s ease-in-out infinite}.logo3d span{font-size:25px;transform:translateZ(12px);text-shadow:0 8px 22px rgba(139,92,246,.65)}
@keyframes tilt{0%,100%{transform:rotateX(0) rotateY(-7deg)}50%{transform:rotateX(7deg) rotateY(7deg)}}h1{font-size:22px;letter-spacing:.2px;margin:0}.sub{color:var(--muted);font-size:13px;margin-top:3px}.pill{display:flex;align-items:center;gap:8px;padding:9px 13px;border:1px solid var(--line);border-radius:999px;background:rgba(255,255,255,.04);font-size:12px;color:#d9d9df}.dot{width:8px;height:8px;border-radius:50%;background:#888;box-shadow:0 0 0 5px rgba(136,136,136,.08)}.dot.ok{background:var(--ok);box-shadow:0 0 18px rgba(34,197,94,.75)}
.grid{display:grid;grid-template-columns:1.05fr .95fr;gap:18px}.card{position:relative;background:var(--panel);border:1px solid var(--line);border-radius:24px;padding:24px;backdrop-filter:blur(14px);box-shadow:0 24px 80px rgba(0,0,0,.35);overflow:hidden}.card:before{content:"";position:absolute;inset:0;background:linear-gradient(120deg,rgba(255,255,255,.055),transparent 35%);pointer-events:none}.hero{min-height:455px;display:flex;flex-direction:column;justify-content:space-between}.eyebrow{font-size:11px;letter-spacing:1.7px;text-transform:uppercase;color:#b7a5ff}.hero h2{font-size:clamp(32px,5vw,58px);line-height:.98;margin:12px 0 15px;letter-spacing:-2px}.hero p{max-width:560px;color:var(--muted);line-height:1.65;margin:0}.actions{display:flex;flex-wrap:wrap;gap:10px;margin-top:25px}.btn{border:1px solid var(--line);background:#111116;color:#fff;border-radius:13px;padding:12px 15px;font-weight:700;cursor:pointer;transition:transform .15s ease,border-color .15s ease,background .15s ease}.btn:hover{transform:translateY(-2px);border-color:rgba(139,92,246,.6);background:#17131f}.btn.primary{background:linear-gradient(135deg,#7c3aed,#2563eb);border:0;box-shadow:0 12px 35px rgba(99,102,241,.28)}
.login{min-height:455px;display:flex;flex-direction:column}.login h3{font-size:19px;margin:0 0 5px}.muted{color:var(--muted);font-size:13px}.qrbox{margin:20px auto 14px;width:min(290px,80vw);aspect-ratio:1;background:#fff;border-radius:20px;padding:14px;display:grid;place-items:center;box-shadow:0 20px 60px rgba(0,0,0,.4);transform:translateZ(0)}.qrbox img{display:block;width:100%;height:100%;object-fit:contain}.empty{height:100%;display:grid;place-items:center;color:#777;font-size:13px;text-align:center}.code{margin-top:auto;padding:16px;border-radius:16px;background:rgba(255,255,255,.045);border:1px solid var(--line)}.code label{display:block;font-size:11px;color:#aaa;letter-spacing:1px;text-transform:uppercase}.code strong{display:block;font:800 25px/1.2 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:6px;margin-top:7px;color:#fff}.status{margin-top:16px;display:flex;align-items:center;justify-content:space-between;gap:12px}.status b{font-size:13px}.badge{font-size:11px;padding:7px 10px;border-radius:999px;background:rgba(34,197,94,.1);color:#86efac;border:1px solid rgba(34,197,94,.2)}.features{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-top:18px}.mini{padding:16px;border:1px solid var(--line);border-radius:18px;background:rgba(255,255,255,.025)}.mini b{display:block;font-size:13px}.mini span{display:block;color:var(--muted);font-size:11px;margin-top:6px;line-height:1.45}.footer{color:#6f7078;font-size:11px;text-align:center;margin-top:18px}
.cube{position:absolute;right:26px;top:24px;width:64px;height:64px;transform-style:preserve-3d;animation:spin 10s linear infinite;opacity:.25}.cube i{position:absolute;inset:0;border:1px solid rgba(255,255,255,.35);background:rgba(139,92,246,.05)}.cube i:nth-child(1){transform:translateZ(32px)}.cube i:nth-child(2){transform:rotateY(180deg) translateZ(32px)}.cube i:nth-child(3){transform:rotateY(90deg) translateZ(32px)}.cube i:nth-child(4){transform:rotateY(-90deg) translateZ(32px)}.cube i:nth-child(5){transform:rotateX(90deg) translateZ(32px)}.cube i:nth-child(6){transform:rotateX(-90deg) translateZ(32px)}@keyframes spin{to{transform:rotateX(360deg) rotateY(360deg)}}
@media(max-width:820px){.grid{grid-template-columns:1fr}.hero,.login{min-height:auto}.features{grid-template-columns:1fr 1fr}.top{align-items:flex-start}}@media(max-width:480px){.wrap{padding-top:22px}.card{padding:19px;border-radius:20px}.features{grid-template-columns:1fr}.pill{display:none}.hero h2{letter-spacing:-1.3px}}
</style></head><body><div class="scene"><div class="orb a"></div><div class="orb b"></div></div>
<main class="wrap"><header class="top"><div class="brand"><div class="logo3d"><span>💀</span></div><div><h1>ALTITUDE CONTROL CENTER</h1><div class="sub">ERROR 💀 WhatsApp Bot · Lightweight 3D interface</div></div></div><div class="pill"><span class="dot" id="topDot"></span><span id="topStatus">Connecting…</span></div></header>
<section class="grid"><article class="card hero"><div class="cube"><i></i><i></i><i></i><i></i><i></i><i></i></div><div><div class="eyebrow">Secure bot gateway</div><h2>Fast. Clean.<br>Ready to pair.</h2><p>Scan the live QR code or use the WhatsApp pairing code. The interface uses CSS-only 3D motion and lightweight effects so it stays responsive on mobile and low-power hosting.</p><div class="actions"><button class="btn primary" onclick="load()">↻ Refresh status</button><button class="btn" onclick="document.querySelector('.login').scrollIntoView({behavior:'smooth'})">View login</button></div></div><div class="features"><div class="mini"><b>⚡ Fast UI</b><span>No heavy animation libraries.</span></div><div class="mini"><b>🛡️ Private</b><span>Token-protected dashboard.</span></div><div class="mini"><b>📱 Mobile</b><span>Responsive QR layout.</span></div><div class="mini"><b>🔄 Live</b><span>Auto-refresh every 2 sec.</span></div></div></article>
<article class="card login"><div><h3>WhatsApp Login</h3><div class="muted">Keep this page and pairing code private.</div></div><div class="qrbox" id="qr"><div class="empty">Waiting for QR…</div></div><div class="status"><b id="status">WAITING</b><span class="badge" id="badge">LIVE</span></div><div class="code"><label>Pairing code</label><strong id="pair">—</strong><div class="muted" style="margin-top:7px">Use your number in international format without + or spaces.</div></div></article></section><div class="footer">ALTITUDE 💀 · Do not publish auth credentials or login tokens.</div></main>
<script>
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
async function load(){try{const r=await fetch('login-status'+location.search,{cache:'no-store'});const x=await r.json();document.getElementById('status').textContent=x.status||'UNKNOWN';document.getElementById('topStatus').textContent=x.status||'UNKNOWN';const dot=document.getElementById('topDot');dot.className='dot '+((x.status||'').includes('CONNECTED')?'ok':'');document.getElementById('pair').textContent=x.pairingCode||'—';document.getElementById('qr').innerHTML=x.qr?('<img alt="WhatsApp QR code" src="'+esc(x.qr)+'">'):'<div class="empty">Waiting for QR…</div>';}catch(e){document.getElementById('status').textContent='SERVER UNAVAILABLE';document.getElementById('topStatus').textContent='OFFLINE';document.getElementById('topDot').className='dot';document.getElementById('qr').innerHTML='<div class="empty">Server unavailable</div>';}}load();setInterval(load,2000);
</script></body></html>`);
});

app.get("/login-status", (req, res) => {
  if (!authorized(req)) return res.status(401).json({error:"Unauthorized"});
  res.set("Cache-Control", "no-store");
  res.json({status: pairingStatus, pairingCode, qr: latestQr});
});

app.listen(PORT, () => console.log(`ALTITUDE login panel listening on :${PORT}`));

async function start() {
  const { state, saveCreds } = await useMultiFileAuthState("./auth");
  const sock = makeWASocket({
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger)
    },
    browser: Browsers.ubuntu("Chrome"),
    logger,
    markOnlineOnConnect: false,
    syncFullHistory: false
  });

  // Optional WhatsApp phone-number pairing code.
  // Set PAIRING_NUMBER=923XXXXXXXXXX in the hosting environment.
  if (process.env.PAIRING_NUMBER && !state.creds.registered) {
    try {
      pairingStatus = "REQUESTING PAIRING CODE";
      const phone = process.env.PAIRING_NUMBER.replace(/\D/g, "");
      pairingCode = await sock.requestPairingCode(phone);
      pairingStatus = "PAIRING CODE READY";
      console.log(`Pairing code: ${pairingCode}`);
    } catch (e) {
      pairingStatus = "PAIRING CODE ERROR";
      console.error("Pairing-code request failed:", e?.message || e);
    }
  }


  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      pairingStatus = "SCAN QR";
      latestQr = await QRCode.toDataURL(qr);
      qrcode.generate(qr, { small: true });
    }
    if (connection === "open") {
      pairingStatus = "CONNECTED"; pairingCode = null; latestQr = null;
      console.log(`\n${C.branding.header}\n🟢 Connected\n💬 ${AUTO_REPLIES.length}+ replies\n🛡️ Moderation active\n`);
    }
    if (connection === "close") {
      const code = lastDisconnect?.error?.output?.statusCode;
      if (code !== DisconnectReason.loggedOut) {
        console.log("Connection closed; reconnecting...");
        setTimeout(start, 3000);
      } else {
        console.log("Logged out. Remove ./auth and pair again.");
      }
    }
  });

  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return;
    for (const msg of messages) {
      try { await handleMessage(sock, msg); }
      catch (e) { console.error("message error:", e?.message || e); }
    }
  });

  sock.ev.on("group-participants.update", async ({ id, participants, action }) => {
    const settings = getGroupSettings(id, C.settings);
    if ((action === "add" && settings.welcome) || (action === "remove" && settings.goodbye)) {
      for (const p of participants) {
        const word = action === "add" ? "WELCOME" : "GOODBYE";
        await sock.sendMessage(id, {
          text: `${C.branding.header}\n\n${action === "add" ? "👋" : "👋"} *${word}*\n@${numberOf(p)}\n\n${C.branding.footer}`,
          mentions: [p]
        });
      }
    }
  });
}

start().catch(err => console.error("Fatal:", err));
