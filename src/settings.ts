/**
 * settings.ts — Plugin Settings & Settings Tab
 *
 * Defines the user-configurable options for Obsidian Local Agent and
 * renders the settings UI inside Obsidian's native Settings panel.
 *
 * Includes both local LLM settings and Cloud API (Gemini) settings
 * for the Second Self reasoning/synthesis system.
 */

import {
  App,
  Notice,
  PluginSettingTab,
  Setting,
} from "obsidian";
import type LocalAgentPlugin from "./main";
import { CLOUD_MODEL_OPTIONS } from "./cloudApi";

// ---------------------------------------------------------------------------
// Settings Interface & Defaults
// ---------------------------------------------------------------------------

export interface LocalAgentSettings {
  /** Base URL of the local LLM server. */
  apiEndpoint: string;

  /** Model identifier, e.g. "llama3", "mistral", "deepseek-coder". */
  defaultModel: string;

  /**
   * Vault-relative path to the folder containing source notes for
   * the Map-Reduce aggregation engine (e.g. "Daily Notes").
   */
  inputFolder: string;

  /**
   * Vault-relative path to the folder where generated Insight Reports
   * will be saved.
   */
  outputFolder: string;

  /**
   * Maximum number of recent files to process during a Map-Reduce run.
   * Prevents accidentally mapping hundreds of notes.
   */
  maxFilesToProcess: number;

  /**
   * Temperature used for classification tasks (Module 2).
   * Lower = more deterministic.
   */
  classificationTemperature: number;

  /**
   * Temperature used for the summary / aggregation tasks (Module 3).
   */
  aggregationTemperature: number;

  /**
   * Temperature used for the Note Refiner tasks (Module 4).
   * Default 0.3
   */
  refinementTemperature: number;

  // -----------------------------------------------------------------------
  // Second Self — Cloud API Settings
  // -----------------------------------------------------------------------

  /** Enable cloud model for macro synthesis (daily/weekly briefs). */
  cloudEnabled: boolean;

  /** Cloud API Key (Gemini API Key). */
  cloudApiKey: string;

  /** Cloud model name for synthesis tasks. */
  cloudModel: string;

  // -----------------------------------------------------------------------
  // Second Self — Path Configuration
  // -----------------------------------------------------------------------

  /** Vault-relative path to the Second Self working folder. */
  secondSelfFolder: string;

  /** Filename for the identity description file (inside secondSelfFolder). */
  identityFileName: string;

  /** Behavior when translating Chinese selection to English: 'replace' or 'insert'. */
  englishTranslationBehavior: "replace" | "insert";
}

export const DEFAULT_SETTINGS: LocalAgentSettings = {
  apiEndpoint: "http://localhost:11434",
  defaultModel: "llama3",
  inputFolder: "Daily Notes",
  outputFolder: "Insights",
  maxFilesToProcess: 20,
  classificationTemperature: 0.2,
  aggregationTemperature: 0.5,
  refinementTemperature: 0.3,
  // Cloud API
  cloudEnabled: false,
  cloudApiKey: "",
  cloudModel: "gemini-3.1-flash-lite",
  // Second Self paths
  secondSelfFolder: "04_Second_Self",
  identityFileName: "IDENTITY.md",
  // Translation
  englishTranslationBehavior: "replace",
};

// ---------------------------------------------------------------------------
// Settings Tab
// ---------------------------------------------------------------------------

export class LocalAgentSettingTab extends PluginSettingTab {
  plugin: LocalAgentPlugin;

  constructor(app: App, plugin: LocalAgentPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    // --- Header ------------------------------------------------------------
    containerEl.createEl("h1", { text: "Obsidian Local Agent" });
    containerEl.createEl("p", {
      text: "Configure your local LLM connection and folder paths for automated knowledge management.",
      cls: "setting-item-description",
    });

    // --- Section: API Connection -------------------------------------------
    containerEl.createEl("h2", { text: "API Connection" });

    new Setting(containerEl)
      .setName("API Endpoint")
      .setDesc(
        "Base URL of your local LLM server (Ollama, LM Studio, etc.). Example: http://localhost:11434"
      )
      .addText((text) =>
        text
          .setPlaceholder("http://localhost:11434")
          .setValue(this.plugin.settings.apiEndpoint)
          .onChange(async (value) => {
            this.plugin.settings.apiEndpoint = value.trim();
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Default Model")
      .setDesc(
        "The model identifier to use for inference (e.g. llama3, mistral, deepseek-r1)."
      )
      .addText((text) =>
        text
          .setPlaceholder("llama3")
          .setValue(this.plugin.settings.defaultModel)
          .onChange(async (value) => {
            this.plugin.settings.defaultModel = value.trim();
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Test Connection")
      .setDesc("Verify that the local LLM server is reachable.")
      .addButton((button) =>
        button.setButtonText("Ping Server").onClick(async () => {
          button.setDisabled(true);
          button.setButtonText("Testing...");
          try {
            const ok = await this.plugin.apiClient.ping();
            if (ok) {
              new Notice("Connection successful — LLM server is reachable.");
            } else {
              new Notice(
                "Connection failed — could not reach the LLM server. Check the endpoint URL."
              );
            }
          } catch (err) {
            new Notice(`Connection error: ${(err as Error).message}`);
          } finally {
            button.setDisabled(false);
            button.setButtonText("Ping Server");
          }
        })
      );

    // --- Section: Cloud API (Second Self) ----------------------------------
    containerEl.createEl("h2", { text: "☁️ 雲端 API（Second Self 合成引擎）" });
    containerEl.createEl("p", {
      text: "設定 Google Gemini 雲端 API，用於每日/每週宏觀合成簡報。若未啟用，合成引擎將使用本地模型作為降級方案。",
      cls: "setting-item-description",
    });

    new Setting(containerEl)
      .setName("啟用線上模型進行宏觀合成")
      .setDesc("開啟後，每日/每週合成簡報將使用 Gemini 雲端模型處理跨時間段的長文本合成。")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.cloudEnabled)
          .onChange(async (value) => {
            this.plugin.settings.cloudEnabled = value;
            await this.plugin.saveSettings();
            // Re-render to show/hide dependent fields
            this.display();
          })
      );

    if (this.plugin.settings.cloudEnabled) {
      new Setting(containerEl)
        .setName("Gemini API Key")
        .setDesc("從 Google AI Studio 取得的 API Key。此值以密碼形式儲存。")
        .addText((text) => {
          text.inputEl.type = "password";
          text.inputEl.style.width = "300px";
          text
            .setPlaceholder("AIza...")
            .setValue(this.plugin.settings.cloudApiKey)
            .onChange(async (value) => {
              this.plugin.settings.cloudApiKey = value.trim();
              await this.plugin.saveSettings();
            });
        });

      new Setting(containerEl)
        .setName("線上模型選擇")
        .setDesc("選擇用於宏觀合成的 Gemini 模型。")
        .addDropdown((dropdown) => {
          for (const opt of CLOUD_MODEL_OPTIONS) {
            dropdown.addOption(opt.value, opt.label);
          }
          dropdown
            .setValue(this.plugin.settings.cloudModel)
            .onChange(async (value) => {
              this.plugin.settings.cloudModel = value;
              await this.plugin.saveSettings();
            });
        });

      new Setting(containerEl)
        .setName("測試雲端連線")
        .setDesc("驗證 Gemini API Key 是否有效且可連線。")
        .addButton((button) =>
          button.setButtonText("Ping Gemini").onClick(async () => {
            button.setDisabled(true);
            button.setButtonText("Testing...");
            try {
              const ok = await this.plugin.cloudClient.ping();
              if (ok) {
                new Notice("✅ Gemini API 連線成功！");
              } else {
                new Notice("❌ Gemini API 連線失敗。請檢查 API Key 是否正確。");
              }
            } catch (err) {
              new Notice(`連線錯誤：${(err as Error).message}`);
            } finally {
              button.setDisabled(false);
              button.setButtonText("Ping Gemini");
            }
          })
        );
    }

    // --- Section: Second Self Path Configuration ---------------------------
    containerEl.createEl("h2", { text: "🧠 Second Self 路徑配置" });

    new Setting(containerEl)
      .setName("推理系統工作資料夾")
      .setDesc(
        "Second Self 系統的工作資料夾名稱（Vault 根目錄下）。合成報告與 IDENTITY.md 均存放於此。"
      )
      .addText((text) =>
        text
          .setPlaceholder("04_Second_Self")
          .setValue(this.plugin.settings.secondSelfFolder)
          .onChange(async (value) => {
            this.plugin.settings.secondSelfFolder = value.trim();
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("身份描述檔案名稱")
      .setDesc(
        "記錄核心價值觀、立場與開放性問題的檔案名稱。用於矛盾檢測與核心問題錨定。"
      )
      .addText((text) =>
        text
          .setPlaceholder("IDENTITY.md")
          .setValue(this.plugin.settings.identityFileName)
          .onChange(async (value) => {
            this.plugin.settings.identityFileName = value.trim();
            await this.plugin.saveSettings();
          })
      );

    // --- Section: Folder Configuration -------------------------------------
    containerEl.createEl("h2", { text: "Folder Configuration" });

    new Setting(containerEl)
      .setName("Input Folder")
      .setDesc(
        "Vault-relative path to the folder containing source notes for aggregation (e.g. Daily Notes)."
      )
      .addText((text) =>
        text
          .setPlaceholder("Daily Notes")
          .setValue(this.plugin.settings.inputFolder)
          .onChange(async (value) => {
            this.plugin.settings.inputFolder = value.trim();
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Output Folder")
      .setDesc(
        "Vault-relative path to the folder where Insight Reports will be created."
      )
      .addText((text) =>
        text
          .setPlaceholder("Insights")
          .setValue(this.plugin.settings.outputFolder)
          .onChange(async (value) => {
            this.plugin.settings.outputFolder = value.trim();
            await this.plugin.saveSettings();
          })
      );

    // --- Section: Processing Options ---------------------------------------
    containerEl.createEl("h2", { text: "Processing Options" });

    new Setting(containerEl)
      .setName("Max Files to Process")
      .setDesc(
        "Maximum number of recent notes to include in a single Map-Reduce aggregation run."
      )
      .addSlider((slider) =>
        slider
          .setLimits(1, 100, 1)
          .setValue(this.plugin.settings.maxFilesToProcess)
          .setDynamicTooltip()
          .onChange(async (value) => {
            this.plugin.settings.maxFilesToProcess = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Classification Temperature")
      .setDesc(
        "LLM temperature for tagging/classification (lower = more deterministic). Range: 0.0 - 1.0."
      )
      .addSlider((slider) =>
        slider
          .setLimits(0, 1, 0.05)
          .setValue(this.plugin.settings.classificationTemperature)
          .setDynamicTooltip()
          .onChange(async (value) => {
            this.plugin.settings.classificationTemperature = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Aggregation Temperature")
      .setDesc(
        "LLM temperature for summary/aggregation tasks (higher = more creative). Range: 0.0 - 1.0."
      )
      .addSlider((slider) =>
        slider
          .setLimits(0, 1, 0.05)
          .setValue(this.plugin.settings.aggregationTemperature)
          .setDynamicTooltip()
          .onChange(async (value) => {
            this.plugin.settings.aggregationTemperature = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Refinement Temperature")
      .setDesc(
        "LLM temperature for the combined Summary/Highlight/Atomize Refiner task. Default 0.3."
      )
      .addSlider((slider) =>
        slider
          .setLimits(0, 1, 0.05)
          .setValue(this.plugin.settings.refinementTemperature)
          .setDynamicTooltip()
          .onChange(async (value) => {
            this.plugin.settings.refinementTemperature = value;
            await this.plugin.saveSettings();
          })
      );

    // --- Section: Translation Settings ------------------------------------
    containerEl.createEl("h2", { text: "翻譯功能設定" });

    new Setting(containerEl)
      .setName("英文翻譯插入方式")
      .setDesc("當選取的中文文字被翻譯為英文時，翻譯結果的處理方式。")
      .addDropdown((dropdown) =>
        dropdown
          .addOption("replace", "置換選取內容")
          .addOption("insert", "插入在下一行")
          .setValue(this.plugin.settings.englishTranslationBehavior || "replace")
          .onChange(async (value) => {
            this.plugin.settings.englishTranslationBehavior = value as "replace" | "insert";
            await this.plugin.saveSettings();
          })
      );
  }
}
