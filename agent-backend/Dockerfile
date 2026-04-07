# KEMLLM Agent Backend — Ubuntu sandbox for Hugging Face Spaces
FROM ubuntu:22.04

ENV DEBIAN_FRONTEND=noninteractive
ENV PYTHONUNBUFFERED=1

# Pre-install commonly used dev tools so the AI doesn't have to apt-install
# everything at runtime
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
 && rm -rf /var/lib/apt/lists/*

# Python deps for the Flask service
RUN pip3 install --no-cache-dir flask flask-cors gunicorn

# Create the agent user with passwordless sudo so the AI can install things
RUN useradd -m -s /bin/bash agent \
 && echo 'agent ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/agent \
 && chmod 0440 /etc/sudoers.d/agent

# Application
WORKDIR /app
COPY app.py /app/app.py
RUN chown -R agent:agent /app

USER agent
WORKDIR /home/agent

# HF Spaces expects port 7860
EXPOSE 7860
CMD ["python3", "/app/app.py"]
