---
title: KEMLLM Agent Backend
emoji: 🤖
colorFrom: red
colorTo: gray
sdk: docker
app_port: 7860
pinned: false
---

# KEMLLM Agent Backend

A tiny REST service that gives [KEMLLM](https://github.com/karimdaman/kemllm) Agent Mode a real Linux sandbox.

Built to run on Hugging Face Spaces with the Docker SDK. Free CPU tier is enough.

## What it does

Exposes a real Ubuntu 22.04 container with `bash`, `python3`, `node`, `git`, `curl`, `apt`, etc. The KEMLLM frontend calls this service over HTTPS to run shell commands on behalf of the user and the AI.

## Endpoints

| Method | Path | Description |
|---|---|---|
| `GET` | `/` | health check |
| `POST` | `/sessions` | create a new persistent shell session |
| `POST` | `/sessions/{id}/exec` | run a command, preserves cwd |
| `POST` | `/sessions/{id}/write` | write a file |
| `POST` | `/sessions/{id}/read` | read a file |
| `DELETE` | `/sessions/{id}` | kill the session |

All requests need `Authorization: Bearer <AGENT_TOKEN>` if `AGENT_TOKEN` secret is set.

## Setup on Hugging Face Spaces

See the full guide in `SETUP.md`.

## Security note

This container has `sudo` enabled for the `agent` user. **Always set the `AGENT_TOKEN` secret** in your Space settings, otherwise anyone who finds your Space URL can run commands on it.
