/**
 * settings.ts — Plugin Settings & Settings Tab
 *
 * Defines the user-configurable options for Obsidian Local Agent and
 * renders the settings UI inside Obsidian's native Settings panel.
 */

import {
  App,
  Notice,
  PluginSettingTab,
  Setting,
} from "obsidian";
import type LocalAgentPlugin from "./main";

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
  }
}
