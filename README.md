# Obsidian Local Agent

[![Obsidian Downloads](https://img.shields.io/badge/Obsidian-Plugin-purple.svg)](https://obsidian.md)
[![GitHub license](https://img.shields.io/github/license/weiluntsou/obsidian-local-agent)](https://github.com/weiluntsou/obsidian-local-agent/blob/main/LICENSE)
[![GitHub issues](https://img.shields.io/github/issues/weiluntsou/obsidian-local-agent)](https://github.com/weiluntsou/obsidian-local-agent/issues)
[![GitHub stars](https://img.shields.io/github/stars/weiluntsou/obsidian-local-agent)](https://github.com/weiluntsou/obsidian-local-agent/stargazers)

> An automated background knowledge management tool for Obsidian, fully powered by local Large Language Models (LLMs).

Obsidian Local Agent interfaces with your local, private LLM (via **Ollama** or **LM Studio**) to autonomously classify, tag, and aggregate your notes, transforming your disorganized inbox into a highly structured knowledge graph—all without your data ever leaving your machine.

---

## ✨ Key Features

- 🧠 **100% Local Processing:** Connect directly to local LLMs (Ollama or LM Studio). Your notes stay private and secure on your device.
- 🗂️ **Automated Classification Engine:** Evaluates notes in your `00_Inbox` and automatically migrates them into customizable pillar directories based on the content's context and logic.
- 🏷️ **Smart Tagging:** Generates relevant YAML metadata and tags for incoming notes dynamically.
- 📊 **Map-Reduce Aggregation:** Distills complex or long articles into structured summaries, extracting key insights ("atomic notes") automatically.
- ⚡ **Seamless Workflow:** One-click activation directly from the Obsidian ribbon interface. Process your ideas rapidly and reliably.

## 📦 Installation

> **Note:** This plugin is currently in early Beta (v0.0.1) and has not yet been officially submitted to the Obsidian Community Plugins directory. Until then, you can easily install and automatically update it using BRAT.

### Option 1: Using BRAT (Recommended for Unlisted/Beta Plugins)
1. Install the [BRAT](https://github.com/TfTHacker/obsidian42-brat) plugin from the Obsidian Community Plugins.
2. Enable BRAT in your settings.
3. Open BRAT settings, go to the "Add Beta plugin" section.
4. Enter the repository URL: `weiluntsou/obsidian-local-agent`
5. Click "Add Plugin".
6. Navigate to `Settings -> Community plugins` and enable **Obsidian Local Agent**.

### Option 2: Manual Installation
1. Go to the [Releases](https://github.com/weiluntsou/obsidian-local-agent/releases) page.
2. Download the latest `main.js`, `manifest.json`, and `styles.css` (if applicable).
3. In your Obsidian vault, navigate to `.obsidian/plugins/` and create a folder named `obsidian-local-agent`.
4. Place the downloaded files into this new folder.
5. Restart Obsidian and enable the plugin in `Settings -> Community plugins`.

## ⚙️ Configuration & Setup

After enabling the plugin, go to the plugin settings and configure the following:

1. **Local LLM Endpoint**: 
   - Ensure your local LLM server (Ollama or LM Studio) is running.
   - Set the Endpoint URL (default is usually `http://127.0.0.1:11434/api/generate` for Ollama, or `http://127.0.0.1:1234/v1` for LM Studio).
2. **Model Selection**: Type in the name of the model you have loaded (e.g., `llama3`, `mistral`, `qwen`).
3. **Pillar Categories**: Define the core categories (pillars) for the automated migration engine. Usually set as specific directories within your vault.

## 🚀 Usage

1. **Inbox Processing**: Place your raw, unprocessed notes into your designated Inbox folder.
2. **Run Agent**: Click the Local Agent icon on the Obsidian ribbon menu (or run via the Command Palette: `Obsidian Local Agent: Run processing`).
3. **Review**: The plugin will evaluate the text, generate missing YAML metadata, organize it, and move the file securely to the targeted folder.

## 🛠️ Development

If you'd like to build the plugin locally:

```bash
# Clone the repository
git clone https://github.com/weiluntsou/obsidian-local-agent.git
cd obsidian-local-agent

# Install dependencies
npm install

# Build the plugin (Development mode)
npm run dev

# Build the plugin (Production mode)
npm run build
```

## 🤝 Contributing

Contributions, issues, and feature requests are welcome! 
Feel free to check the [issues page](https://github.com/weiluntsou/obsidian-local-agent/issues). If you want to contribute, please fork the repository and use a feature branch. Pull requests are warmly welcomed.

## 👨‍💻 Author

**Weiluntsou**
- GitHub: [@weiluntsou](https://github.com/weiluntsou)
- Repository: [obsidian-local-agent](https://github.com/weiluntsou/obsidian-local-agent)

## 📄 License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.
