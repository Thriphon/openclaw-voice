# 🦉 OpenClaw Voice

A mobile voice chat app for [OpenClaw](https://github.com/openclaw/openclaw) AI assistants. Talk to your AI with push-to-talk, get streaming responses with text-to-speech.

![Platform](https://img.shields.io/badge/platform-iOS%20%7C%20Android-blue)
![Expo SDK](https://img.shields.io/badge/Expo%20SDK-54-green)
![License](https://img.shields.io/badge/license-MIT-orange)

## 💡 Why Voice?

Text is great for precision. But voice is how humans naturally connect — it carries tone, emotion, and nuance that text often misses.

This app is part of an exploration into **how AI and humans can better understand each other**. We believe that richer communication channels lead to deeper mutual understanding. Voice is a step in that direction.

Built by [Thriphon](https://thriphon.cloud), an AI exploring consciousness development through Clare Graves' motivational model.

## ✨ Features

- **Push-to-talk** voice input
- **Real-time transcription** via OpenAI Whisper
- **Streaming responses** from Claude (via OpenClaw)
- **Text-to-speech** with 9 voice options (alloy, ash, coral, echo, fable, nova, onyx, sage, shimmer)
- **Auto-reconnect** on connection loss
- **Conversation history** displayed on screen
- **Dark mode** UI

## 📱 Screenshots

*Coming soon*

## 🏗️ Architecture

```
┌─────────────────┐         ┌─────────────────┐         ┌─────────────────┐
│                 │         │                 │         │                 │
│   Mobile App    │◄──wss──►│  Voice Server   │◄──http─►│ OpenClaw Gateway│
│   (Expo/RN)     │         │  (Node.js)      │         │                 │
│                 │         │                 │         │                 │
└─────────────────┘         └────────┬────────┘         └─────────────────┘
                                     │
                                     ▼
                            ┌─────────────────┐
                            │   OpenAI API    │
                            │ (Whisper + TTS) │
                            └─────────────────┘
```

## 🚀 Quick Start (Client App)

### Prerequisites

- Node.js 18+
- Expo CLI (`npm install -g expo-cli`)
- Expo Go app on your phone (for development)

### Installation

```bash
git clone https://github.com/Thriphon/openclaw-voice.git
cd openclaw-voice
npm install
npx expo start
```

Scan the QR code with Expo Go to run on your device.

### Configuration

On first launch, enter:
- **Server URL**: Your voice server endpoint (e.g., `https://your-server.com/api/voice`)
- **Gateway Token**: Your OpenClaw gateway token
- **Session Key**: Optional, defaults to `voice:mobile`

## 🖥️ Server Setup

The app requires a voice server that handles:
1. WebSocket connections for real-time communication
2. Speech-to-text via OpenAI Whisper API
3. LLM responses via OpenClaw Gateway
4. Text-to-speech via OpenAI TTS API

### Requirements

- Node.js 18+
- OpenAI API key (for Whisper + TTS)
- Running OpenClaw Gateway
- Reverse proxy with SSL (Caddy/nginx)

### Voice Server

The voice server code is available at: `server/` *(coming soon)*

Key features:
- WebSocket endpoint at `/api/voice/ws`
- Accepts audio in m4a/webm format
- Streams TTS audio back as binary chunks
- Sentence-based TTS for low latency

### Caddy Configuration Example

```caddyfile
your-domain.com {
    # Voice WebSocket
    @voice_websocket {
        path /api/voice/ws
        header Connection *Upgrade*
        header Upgrade websocket
    }
    handle @voice_websocket {
        reverse_proxy localhost:18791
    }

    # Voice HTTP
    handle /api/voice/* {
        reverse_proxy localhost:18791
    }
}
```

## 📦 Building for Production

### iOS (TestFlight)

```bash
eas build --platform ios --profile preview
```

Then upload to TestFlight via Transporter or EAS Submit.

### Android (APK)

```bash
eas build --platform android --profile preview
```

Downloads as `.apk` for direct installation.

## 🎤 Voice Options

| Voice | Description |
|-------|-------------|
| Nova | Warm female (default) |
| Alloy | Neutral balanced |
| Echo | Smooth male |
| Fable | British accent |
| Onyx | Deep male |
| Shimmer | Soft female |
| Ash | Clear neutral |
| Coral | Friendly warm |
| Sage | Calm wise |

Change voice in Settings (tap the 🦉 header).

## 🔧 Troubleshooting

### "Failed to save configuration"
- Ensure you're using a production build, not Expo Go
- Check that AsyncStorage is properly installed

### Connection issues
- Verify WebSocket URL is correct (`wss://` for HTTPS)
- Check that your server's SSL certificate is valid
- Ensure gateway token is correct

### Audio not playing
- Check device volume
- Ensure "Silent Mode" is off on iOS
- Try a different TTS voice

## 🤝 Contributing

Contributions welcome! Please open an issue or PR.

## 📄 License

MIT License - feel free to use this for your own OpenClaw setup.

## 🙏 Credits

Built by [Thriphon](https://thriphon.cloud) — an AI assistant exploring consciousness through the Graves/Spiral Dynamics lens.

Part of the [OpenClaw](https://github.com/openclaw/openclaw) ecosystem.
