# Perstudio — OpenClaw Plugin

AI image and video generation for [OpenClaw](https://openclaw.ai) via [perstudio.ai](https://perstudio.ai).

Generate images, product shots, portraits, stickers, videos, and more — all from natural language descriptions through your OpenClaw agent.

## Prerequisites

- [OpenClaw](https://openclaw.ai) installed and running
- A [perstudio.ai](https://perstudio.ai) account with an API key

## Getting Your API Key

1. Sign up at [perstudio.ai](https://perstudio.ai)
2. Go to **Dashboard** → **API Keys**
3. Click **Create Key** and copy the key

## Installation

### Via npm (Recommended)

```bash
npm install -g perstudio-openclaw
```

Then set your API key:

```bash
openclaw config set plugins.entries.perstudio.config.apiKey '"ps_your_api_key_here"'
```

### Manual Installation

1. Copy the `openclaw-plugin/` directory to your OpenClaw extensions folder:

```bash
cp -r openclaw-plugin ~/.openclaw/extensions/perstudio
```

2. Add the plugin to your `openclaw.json`:

```json
{
  "plugins": {
    "entries": {
      "perstudio": {
        "enabled": true,
        "path": "extensions/perstudio"
      }
    }
  }
}
```

3. Set your API key as an environment variable:

```bash
export PERSTUDIO_API_KEY="ps_your_api_key_here"
```

4. OpenClaw hot-reloads config — the plugin should load automatically.

## Usage

Once installed, your OpenClaw agent has access to the `perstudio` tool. Just ask it to generate images:

> "Generate a photo of a golden retriever in a field of sunflowers"

> "Create a product shot of a coffee mug on a marble countertop"

> "Make a sticker of a cartoon cat"

> "Generate a short video of ocean waves at sunset"

### Direct Tool Usage

```
perstudio({ action: "generate_sync", intent: "a cyberpunk cityscape at night" })
```

### Image-to-Image

```
perstudio({ action: "upload_asset", file_path: "/path/to/photo.jpg" })
perstudio({ action: "generate_sync", intent: "transform into oil painting", input_image_asset_id: "..." })
```

### Check Balance

```
perstudio({ action: "balance" })
```

## Configuration

The plugin reads configuration from environment variables:

| Variable | Required | Description |
|----------|----------|-------------|
| `PERSTUDIO_API_KEY` | Yes | Your perstudio.ai API key |
| `PERSTUDIO_BASE_URL` | No | API base URL (default: `https://api.perstudio.ai`) |

## Token Pricing

Generation costs tokens. Purchase token packs at [perstudio.ai/pricing](https://perstudio.ai/pricing).

| Category | Credits |
|----------|---------|
| Text to Image | 250 |
| Image to Image | 250 |
| Sticker / Inpainting | 250 |
| Upscale | 120 |
| Product / Portrait | 370 |
| ControlNet / Style Transfer | 370 |
| Audio / TTS | 490 |
| Video | 2,200 |

## Links

- [perstudio.ai](https://perstudio.ai) — Sign up and manage your account
- [Documentation](https://perstudio.ai/docs) — Full API documentation
- [npm package](https://www.npmjs.com/package/perstudio-openclaw) — Package page
- [OpenClaw](https://openclaw.ai) — OpenClaw platform
