# KEMLLM Agent Backend — Ubuntu sandbox with optional desktop
FROM ubuntu:22.04

ENV DEBIAN_FRONTEND=noninteractive
ENV PYTHONUNBUFFERED=1
ENV DISPLAY=:0

# Core dev tools + desktop stack (Xvfb, fluxbox window manager, x11vnc,
# websockify/noVNC for browser-based access, chromium for web browsing)
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 python3-pip python3-venv \
    curl wget git vim nano \
    build-essential pkg-config \
    jq tree ripgrep fd-find bat \
    htop procps net-tools iputils-ping dnsutils \
    ca-certificates gnupg lsb-release \
    sudo unzip zip tar xz-utils \
    nodejs npm \
    sqlite3 \
    xvfb fluxbox x11vnc websockify novnc \
    xterm scrot imagemagick xdotool \
    chromium-browser \
    fonts-dejavu fonts-liberation \
 && rm -rf /var/lib/apt/lists/*

# Symlink novnc's vnc.html → index.html so /vnc works at root
RUN ln -sf /usr/share/novnc/vnc.html /usr/share/novnc/index.html || true

# Python deps for the Flask service
RUN pip3 install --no-cache-dir flask flask-cors gunicorn requests

# Create the agent user with passwordless sudo so the AI can install things
RUN useradd -m -s /bin/bash agent \
 && echo 'agent ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/agent \
 && chmod 0440 /etc/sudoers.d/agent

# Application
WORKDIR /app
COPY app.py /app/app.py
RUN chown -R agent:agent /app /home/agent

USER agent
WORKDIR /home/agent

# HF Spaces expects port 7860
EXPOSE 7860
CMD ["python3", "/app/app.py"]
