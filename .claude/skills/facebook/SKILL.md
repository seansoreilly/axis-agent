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

**Output:** JSON with fields: `success` (boolean), `post_id`, `url`, or `error`

## Post text only

```bash
python3 /home/ubuntu/agent/.claude/skills/facebook/scripts/post_text.py --message 'Post text'
```

**Arguments:**
- `--message` (required): Post text content

**Output:** JSON with fields: `success` (boolean), `post_id`, `url`, or `error`
