# KEMLLM Agent Backend — slim Ubuntu 22.04 sandbox
# Optimized for HF Spaces free tier (~16 GB RAM, ~50 GB ephemeral disk)
#
# This is the SLIM build: only the essentials for shell + Python + Node + git.
# No desktop stack (Xvfb / fluxbox / Chromium / noVNC) — that adds ~250 MB
# of packages and frequently OOMs the free tier on first run.
#
# If you want the desktop later, see Dockerfile.desktop (heavyweight) and
# follow agent-backend/SETUP.md.

FROM ubuntu:22.04

ENV DEBIAN_FRONTEND=noninteractive
ENV PYTHONUNBUFFERED=1

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 python3-pip \
    curl wget git ca-certificates \
    sudo unzip \
    nodejs npm \
    nano vim-tiny \
    jq \
 && rm -rf /var/lib/apt/lists/*

# Flask service deps + the requests library used by the /desktop proxy
# (kept in case you upgrade later — small enough to leave in)
RUN pip3 install --no-cache-dir flask flask-cors requests

# Non-root agent user with passwordless sudo
RUN useradd -m -s /bin/bash agent \
 && echo 'agent ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/agent \
 && chmod 0440 /etc/sudoers.d/agent

WORKDIR /app
COPY app.py /app/app.py
RUN chown -R agent:agent /app /home/agent

USER agent
WORKDIR /home/agent

EXPOSE 7860
CMD ["python3", "/app/app.py"]
