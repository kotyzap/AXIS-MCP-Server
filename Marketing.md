# Axis MCP Server

### The first on-camera Model Context Protocol server — turning every Axis camera into an AI-native device.

> **Any AI. Any camera. Zero cloud.**
> Install one `.eap`, and Claude, Gemini, ChatGPT, Perplexity, or your own agent can see, understand, and operate the camera — directly, at the edge.

---

## The breakthrough

For twenty years, integrating an IP camera meant learning VAPIX, wiring up SOAP events, wrangling digest auth, and building a bespoke backend for every project. AI agents made it worse: each one needed a custom bridge, a cloud relay, and a security review.

**Axis MCP Server collapses all of that into a single install.** It runs a standards-compliant [Model Context Protocol](https://modelcontextprotocol.io) server *inside the camera* as a native ACAP — no gateway, no middleware, no cloud round-trip. Point any MCP-capable AI client at `http://<camera-ip>/mcp` and it instantly gains a rich, structured toolset for the device.

This is edge AI in the truest sense: the intelligence talks to the camera on the camera's own loopback interface. Nothing leaves the LAN unless you choose to expose it.

---

## Why it's a category-defining, award-worthy solution

**It's genuinely first.** MCP servers run on laptops and in the cloud. This one runs *on the camera* — a Node.js runtime bundled into a native AXIS OS 12 ACAP, speaking Streamable HTTP the way modern agents expect. That combination did not exist before.

**It unlocks a massive installed base.** Axis has shipped millions of cameras; the ARTPEC-7/8/9 generation running AXIS OS 11–12 numbers in the tens of thousands per large deployment alone. A single `.eap` makes every one of them addressable by AI — no hardware change, no forklift upgrade.

**It's model-agnostic by design.** Because it speaks open MCP over HTTP, it works with Claude, Google Antigravity / Gemini, ChatGPT Developer Mode, Perplexity, Claude Code, and any custom agent — today, and whatever ships next.

**It respects the enterprise.** Reverse-proxied behind the camera's own admin authentication, with an optional bearer-guarded direct port for LAN automation. Parameter writes are allow-listed. Nothing is exposed to the internet unless the operator deliberately tunnels it.

---

## What the AI can actually do

Out of the box, the server exposes a curated toolset over MCP:

- **Device & health** — model, serial, firmware, uptime, temperature, network, and time.
- **Imaging & optics** — capture live JPEG snapshots the model can *see*, read and adjust image settings, drive zoom/focus, and run **autofocus** through a resilient four-method cascade that auto-discovers the optics and remembers what works.
- **Events & analytics** — enumerate the camera's event topics and report the state of on-device analytics like AXIS Object Analytics and motion detection.
- **Application control** — list, start, and stop ACAPs; read and (safely) update parameters.
- **The CamStreamer suite** — list and control CamStreamer streams, switch and queue CamSwitcher views, and update CamOverlay custom graphics and info-tickers. Ask an agent *"switch to the gate view and start the YouTube stream,"* and it happens.

Every tool returns clean, structured data an LLM can reason over — not raw CGI dumps.

---

## An operator console that's actually a joy to use

The built-in settings page is a live control room, not a form:

- **One-glance status** — app health, VAPIX connectivity, and device identity, with a one-click self-test.
- **A real-time Live Log** — every request and every MCP tool call streams in as it happens, mirrored to the AXIS system log.
- **A signature touch: the animated AI presence.** The console recognizes *which* model is connected and renders its logo in living ASCII — the Claude spark, the Gemini star, the OpenAI knot, the Antigravity mark — with an animated link pulsing between the AI and the camera and an "LLM Connected" indicator. It turns an invisible protocol into something you can watch, demo, and love.

It's the kind of detail that wins awards and wins rooms.

---

## Built right

- **Native ACAP for AXIS OS 11/12** (ARTPEC-8, `aarch64`), packaged with the official ACAP Native SDK.
- **Streamable HTTP MCP**, stateless — survives the camera's respawn lifecycle cleanly.
- **From-scratch VAPIX digest client** that honors modern MD5 *and* SHA-256 challenges.
- **Bundled Node.js 20** — no runtime assumptions about the camera.
- **Robust by construction** — writable-path auto-discovery, prefix-agnostic routing, graceful degradation when a feature isn't present on a given model.

---

## Who it's for

- **Systems integrators** shipping AI-assisted surveillance without building a backend.
- **Broadcast & live-production teams** letting an agent orchestrate CamStreamer and CamSwitcher.
- **Security operations** giving analysts a natural-language line straight to the device.
- **Developers & researchers** prototyping agentic camera control in minutes, not weeks.

---

## The one-line pitch

> **Axis MCP Server puts a Model Context Protocol server inside the camera — opening tens of thousands of Axis devices to any AI, with no cloud, no middleware, and no compromise.**

*Install the `.eap`. Point your agent at the camera. Watch it come alive.*
