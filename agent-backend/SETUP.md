# Deploy the KEMLLM Agent Backend on Hugging Face Spaces

This is a one-time setup. Total time: about 5 minutes from your phone.

## Step 1 — Create a Hugging Face account

If you don't have one already:

1. Open `https://huggingface.co/join` in your phone browser
2. Sign up with email or GitHub
3. Verify your email

No credit card required.

## Step 2 — Create a new Space

1. Go to `https://huggingface.co/new-space`
2. Fill in:
   - **Space name:** `kemllm-agent` (or anything you want — remember it)
   - **License:** MIT
   - **Select the Space SDK:** **Docker** → choose **Blank**
   - **Hardware:** **CPU basic — free**
   - **Visibility:** **Public** is fine (the token protects it)
3. Click **Create Space**

## Step 3 — Add the files

Hugging Face just created an empty Git repo. You need to put three files in it.

The easiest way from a phone is the web UI's "Add file" button:

1. On your new Space page, tap **Files** at the top
2. Tap **+ Add file** → **Create a new file**
3. For each of the three files below, set the filename and paste the contents:

### File 1: `Dockerfile`

Copy the contents of [`agent-backend/Dockerfile`](https://github.com/karimdaman/kemllm/blob/main/agent-backend/Dockerfile) from this repo.

### File 2: `app.py`

Copy the contents of [`agent-backend/app.py`](https://github.com/karimdaman/kemllm/blob/main/agent-backend/app.py).

### File 3: `README.md`

Copy the contents of [`agent-backend/README.md`](https://github.com/karimdaman/kemllm/blob/main/agent-backend/README.md). This file's frontmatter is what tells Hugging Face to use the Docker SDK and port 7860.

After saving each one, HF will automatically start building. Watch the **Logs** tab — first build takes about 3–5 minutes.

## Step 4 — Set the auth token

1. On your Space page, tap **Settings** (gear icon)
2. Scroll to **Variables and secrets**
3. Tap **New secret**
4. Name: `AGENT_TOKEN`
5. Value: a long random string. Generate one however you like — for example, mash your keyboard for ~30 characters of random letters and numbers. Save it somewhere — you'll paste it into KEMLLM in the next step.
6. Tap **Save**

After saving, the Space will restart with the token enabled.

## Step 5 — Get your Space URL

Your backend lives at:

```
https://YOUR-USERNAME-kemllm-agent.hf.space
```

Replace `YOUR-USERNAME` with your actual HF username (lowercase). For example, if your HF username is `karimdaman`, the URL is `https://karimdaman-kemllm-agent.hf.space`.

Test it from your phone browser — you should see a JSON response like:

```json
{
  "service": "kemllm-agent-backend",
  "ok": true,
  "auth_required": true,
  "active_sessions": 0
}
```

## Step 6 — Plug it into KEMLLM

1. Open the live KEMLLM app
2. Go to **Settings → API Keys**
3. Find the new **Agent Backend** section
4. **Backend URL:** paste your Space URL (e.g. `https://karimdaman-kemllm-agent.hf.space`)
5. **Backend Token:** paste the `AGENT_TOKEN` value you generated in step 4
6. Tap **Save**

## Step 7 — Use it

1. Sidebar → **Agent**
2. Tap **Start**
3. You should see `✓ sandbox ready` and the green status dot
4. Try:
   - `> what's the OS version?` → AI runs `cat /etc/os-release`
   - `!ls /usr/bin | head` → direct shell
   - `> install ripgrep` → AI runs `sudo apt install -y ripgrep`
   - `> write a python script that fetches news.ycombinator.com and prints the top 5 titles`

The session persists for 30 minutes of inactivity, then auto-cleans up. Hit **Stop** + **Start** to get a fresh session anytime.

## Free tier notes

- HF Spaces free tier sleeps after ~48 hours of inactivity. First request after sleep takes ~30 seconds to wake up. After that, instant.
- 16 GB RAM, 2 CPU cores
- 50 GB ephemeral disk
- No persistent storage between sleeps (use `/data` if you upgrade to a paid tier)

## Troubleshooting

**Build fails:** check the Logs tab for errors. Most common issue is a typo in the Dockerfile.

**`401 Unauthorized` from KEMLLM:** the token in Settings doesn't match `AGENT_TOKEN` in your Space secrets. Re-paste it carefully.

**`502 Bad Gateway` for the first ~30s:** the Space is waking from sleep. Wait and retry.

**`sudo: a terminal is required`:** the AI tried `sudo` interactively. Use `sudo -n` or pre-confirm with `echo password | sudo -S`. Better: ask the AI to use `apt-get install -y` which doesn't prompt.
