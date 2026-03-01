---
name: Facebook Page
description: Post text and photos to a Facebook Page using Graph API (headless-compatible)
tags: [facebook, social-media]
---

# Facebook Page

Post text and photos to a Facebook Page. Uses Graph API with page token authentication, compatible with headless/systemd environments.

Credentials are loaded from environment variable `FACEBOOK_PAGE_TOKEN` or stored in `/home/ubuntu/.claude-agent/facebook-page-token.json` (not committed to repo — instance-only). Page ID is `FACEBOOK_PAGE_ID` env var or sourced from token metadata.

## Post with photos

```bash
python3 /home/ubuntu/agent/.claude/skills/facebook/scripts/post_photos.py --message 'Post text' --photos /tmp/photo1.jpg /tmp/photo2.jpg
```

**Arguments:**
- `--message` (required): Caption text for the post
- `--photos` (required): One or more file paths to image files

**Output:** JSON with fields: `success` (boolean), `post_id`, `url`, `warning` (if app not in Live mode), or `error`

## Optimize photos before posting

```bash
node /home/ubuntu/agent/.claude/skills/facebook/scripts/optimize_photo.mjs --input /tmp/photo.jpg --output /tmp/fb_post_1.jpg --mode single|multi
```

**Arguments:**
- `--input` (required): Source photo path
- `--output` (required): Destination path for optimized photo
- `--mode`: `single` (4:5 portrait, 1080x1350) or `multi` (1:1 square, 1080x1080, default)

**What it does:**
- Analyzes brightness, contrast, and saturation
- Auto-adjusts exposure for dark/bright images
- Boosts saturation conditionally (skips already-vivid photos)
- Enhances contrast for flat/washed-out images
- Smart-crops using face/saliency detection
- Applies post-resize sharpening
- Outputs optimized JPEG (mozjpeg, quality 90)
- Skips upscaling if source is smaller than target

**Output:** JSON with `success`, `adjustments` array, dimensions, and file sizes

## Post text only

```bash
python3 /home/ubuntu/agent/.claude/skills/facebook/scripts/post_text.py --message 'Post text'
```

**Arguments:**
- `--message` (required): Post text content

**Output:** JSON with fields: `success` (boolean), `post_id`, `url`, or `error`
