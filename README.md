# ALTITUDE 💀 WhatsApp Bot

Professional group-moderation starter using Baileys.

## Features
- 450+ generated auto-replies
- Anti-link with allow-list
- Anti-spam / anti-flood
- Keyword moderation
- Optional image/video/audio/document/sticker filtering
- Warning system with automatic removal after N warnings
- Admin-only kick/remove/delete/warn commands
- Promote/demote
- Tag-all
- Group info/admin list
- Per-group settings stored in SQLite
- Persistent WhatsApp auth folder
- Welcome/goodbye messages
- ALTITUDE 💀 / ERROR 💀 branding

## Install
Node.js 20+ is recommended.

```bash
npm install
npm start
```

Scan the QR shown in the terminal from WhatsApp > Linked devices.

## Configure
Edit `config.json`:
- `ownerNumbers`
- `badWords`
- `allowedDomains`
- moderation defaults
- media settings

Never publish the `auth/` folder. It contains your WhatsApp login credentials.

## Main commands
`!help`
`!ping`
`!bot`
`!reply`
`!rules`
`!warn @user`
`!kick @user`
`!del` (reply to a message)
`!admins`
`!tagall message`
`!groupinfo`
`!promote @user`
`!demote @user`
`!settings`
`!set antiLink on`
`!antilink`
`!antispam`
`!antiflood`
`!antimedia`
`!clearwarn @user`

Use only for legitimate group administration and comply with WhatsApp's rules. Do not use it for unsolicited bulk messaging, harassment, or spam.

## Preconfigured branding
Owner: 03240993066
ERROR 💀 Channel: https://whatsapp.com/channel/0029VbDmAYDCcW4vL9pQTH0o
