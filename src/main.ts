/**
 * main.ts — Obsidian Local Agent
 *
 * Root plugin class that wires together all three modules:
 *   Module 1 — API Bridge (see api.ts)
 *   Module 2 — Structured Classification Engine
 *   Module 3 — Map-Reduce Aggregation Engine
 *
 * Design principles:
 *   - 100 % local privacy — all LLM calls go to localhost only.
 *   - Zero external MCP servers.
 *   - Fully asynchronous background processing.
 *   - NO real-time editor auto-completion / text prediction.
 */

import {
  App,
  MarkdownView,
  Notice,
  Plugin,
  TFile,
  TFolder,
  normalizePath,
} from "obsidian";

import { LocalLLMClient, parseJsonFromLLM } from "./api";
import { ClassificationEngine } from "./classifier";
import { NoteRefinerEngine } from "./refiner";
import { ArticleProcessorEngine } from "./articleProcessor";
import { WriterEngine, TopicInputModal } from "./writer";
import { CleanerEngine } from "./cleaner";
import {
  DEFAULT_SETTINGS,
  LocalAgentSettings,
  LocalAgentSettingTab,
} from "./settings";


const MAP_SUMMARY_SYSTEM_PROMPT = `你是一位精準的內容摘要器。請閱讀以下筆記，並生成恰好一句話來捕捉其核心思想或主題。不要增加任何前言——直接回應那個獨立的句子即可。`;

const REDUCE_INSIGHT_SYSTEM_PROMPT = `你是一位分析型研究助理。你將收到來自在一段時間內所寫筆記的若干個單句摘要（numbered list）。

你的任務：
1. 識別摘要間的循環主題、規律或新興連結。
2. 突顯任何矛盾或觀點的演變。
3. 建議可行的後續步驟或開放性問題。

請將回應格式設為結構良好的 Markdown（標記語言）報告，包含以下章節：
## 循環主題
## 關鍵連結
## 矛盾與張力
## 開放性問題與後續步驟

請深思熟慮且具體說明。引用時請使用摘要編號（例如 "[3]"）作為證據。`;

// ---------------------------------------------------------------------------
// Plugin Class
// ---------------------------------------------------------------------------

export default class LocalAgentPlugin extends Plugin {
  settings: LocalAgentSettings = DEFAULT_SETTINGS;
  apiClient: LocalLLMClient = new LocalLLMClient({
    endpoint: DEFAULT_SETTINGS.apiEndpoint,
    model: DEFAULT_SETTINGS.defaultModel,
  });

  private statusBarEl: HTMLElement | null = null;
  private isProcessing = false;
  private cancelProcessing = false;

  // ---- Lifecycle ----------------------------------------------------------

  async onload(): Promise<void> {
    await this.loadSettings();

    // Sync API client with persisted settings
    this.apiClient.setEndpoint(this.settings.apiEndpoint);
    this.apiClient.setModel(this.settings.defaultModel);

    // Status bar item for background task feedback
    this.statusBarEl = this.addStatusBarItem();
    this.setStatusBarText("");

    // Settings tab (Module 1)
    this.addSettingTab(new LocalAgentSettingTab(this.app, this));

    // ----- UI Elements -----------------------------------------------------

    // Add a Ribbon Icon (Start Button) on the left sidebar
    const ribbonIconEl = this.addRibbonIcon('bot', '開始分類（目前筆記）', (evt: MouseEvent) => {
      this.classifyActiveNote();
    });
    ribbonIconEl.addClass('local-agent-ribbon-class');

    // Add another Ribbon Icon for the Note Refiner
    const refinerIconEl = this.addRibbonIcon('sparkles', '精修目前筆記（摘要、重點提取、原子化）', (evt: MouseEvent) => {
      this.refineActiveNote();
    });
    refinerIconEl.addClass('local-agent-refine-class');

    // Add another Ribbon Icon for the Article Processor
    const articleIconEl = this.addRibbonIcon('book-open', '處理收件箱文章（批次處理）', (evt: MouseEvent) => {
      this.processInboxArticles();
    });
    articleIconEl.addClass('local-agent-article-class');

    // Add Context Menu: Right-Click on File in File Explorer
    this.registerEvent(
      this.app.workspace.on("file-menu", (menu, file) => {
        if (file instanceof TFile && file.extension === "md") {
          menu.addItem((item) => {
            item
              .setTitle("CPR 知識清掃與自我修復")
              .setIcon("wrench")
              .onClick(() => {
                this.cleanSpecificNote(file);
              });
          });
        }
      })
    );

    // ----- Commands --------------------------------------------------------

    // Module 2: Classify the active note
    this.addCommand({
      id: "classify-active-note",
      name: "分類目前筆記（標籤和分類）",
      callback: () => this.classifyActiveNote(),
    });

    // Module 3: Run Map-Reduce Aggregation
    this.addCommand({
      id: "run-map-reduce",
      name: "執行地圖-約化（Map-Reduce）聚合（特定資料夾）",
      callback: () => this.runMapReduce(),
    });

    // Module 4: Refine Active Note
    this.addCommand({
      id: "refine-active-note",
      name: "精修目前筆記（摘要、重點提取、原子化、分類）",
      callback: () => this.refineActiveNote(),
    });

    // Module 5: Process Article Note
    this.addCommand({
      id: "process-inbox-articles",
      name: "處理收件箱文章（批次格式化，含原子化）",
      callback: () => this.processInboxArticles(),
    });

    // Cancel Processing
    this.addCommand({
      id: "cancel-local-agent-processing",
      name: "取消目前處理任務",
      callback: () => {
        if (this.isProcessing) {
          this.cancelProcessing = true;
          new Notice("正在取消背景任務...");
          this.setStatusBarText("取消中...");
        } else {
          new Notice("目前沒有正在執行的任務。");
        }
      },
    });

    // Module 6: Writing Agent Commands
    this.addCommand({
      id: "writer-init-project",
      name: "寫作代理：初始化寫作專案（plan.md）",
      callback: () => this.handleWriterInit(),
    });

    this.addCommand({
      id: "writer-om-standup",
      name: "寫作代理：晨間簡報（蒐集過去 3 天的背景資訊）",
      callback: () => this.handleWriterAction("standup"),
    });

    this.addCommand({
      id: "writer-draft-article",
      name: "寫作代理：草擬文章（從 plan.md）",
      callback: () => this.handleWriterAction("draft"),
    });

    this.addCommand({
      id: "writer-sweep-draft",
      name: "寫作代理：掃除與回饋（用知識庫審核草稿）",
      callback: () => this.handleWriterAction("sweep"),
    });

    // Module 7: Cleaner Engine Command
    this.addCommand({
      id: "cpr-clean-note",
      name: "CPR 知識清掃與自我修復（目前筆記）",
      callback: () => {
        const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (activeView && activeView.file) {
          this.cleanSpecificNote(activeView.file);
        } else {
          new Notice("請先開啟一篇筆記來進行清掃！");
        }
      },
    });
  }

  onunload(): void {
    this.setStatusBarText("");
  }

  // ---- Settings persistence -----------------------------------------------

  async loadSettings(): Promise<void> {
    this.settings = Object.assign(
      {},
      DEFAULT_SETTINGS,
      await this.loadData()
    );
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);

    // Keep the API client in sync when settings change
    this.apiClient.setEndpoint(this.settings.apiEndpoint);
    this.apiClient.setModel(this.settings.defaultModel);
  }

  // ---- Status bar helper --------------------------------------------------

  private setStatusBarText(text: string): void {
    if (this.statusBarEl) {
      this.statusBarEl.setText(text);
    }
  }

  // ========================================================================
  // MODULE 2 — Structured Classification Engine
  // ========================================================================

  /**
   * Reads the currently active markdown file and routes it to the ClassificationEngine
   * to determine its pillar and tag it appropriately.
   */
  private async classifyActiveNote(): Promise<void> {
    // Guard: prevent concurrent processing
    if (this.isProcessing) {
      new Notice("Local Agent is already processing. Please wait.");
      return;
    }

    const activeView =
      this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!activeView || !activeView.file) {
      new Notice("No active markdown file to classify.");
      return;
    }

    const file = activeView.file;

    this.isProcessing = true;
    this.setStatusBarText("Classifying via ClassificationEngine...");

    try {
      const engine = new ClassificationEngine(
        this.app,
        this.apiClient,
        this.settings.classificationTemperature
      );
      await engine.classifyFile(file);
    } finally {
      this.isProcessing = false;
      this.setStatusBarText("");
    }
  }

  // ========================================================================
  // MODULE 3 — Map-Reduce Aggregation Engine
  // ========================================================================

  // ========================================================================
  // MODULE 4 — Note Refiner Engine
  // ========================================================================

  private async refineActiveNote(): Promise<void> {
    if (this.isProcessing) {
      new Notice("Local Agent is already processing. Please wait.");
      return;
    }

    const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!activeView || !activeView.file) {
      new Notice("No active markdown file to refine.");
      return;
    }

    const file = activeView.file;

    this.isProcessing = true;
    this.setStatusBarText("Refining via NoteRefinerEngine...");

    try {
      const engine = new NoteRefinerEngine(
        this.app,
        this.apiClient,
        this.settings.refinementTemperature
      );
      await engine.refineFile(file);
    } catch (err) {
      console.error("[Local Agent] Refiner error:", err);
      new Notice(`Refinement failed: ${(err as Error).message}`);
    } finally {
      this.isProcessing = false;
      this.setStatusBarText("");
    }
  }

  // ========================================================================
  // MODULE 5 — Article Processor Engine
  // ========================================================================

  private async processInboxArticles(): Promise<void> {
    if (this.isProcessing) {
      new Notice("Local Agent is already processing. Please wait or use Cancel command.");
      return;
    }

    this.isProcessing = true;
    this.cancelProcessing = false;
    this.setStatusBarText("Batch Processing Articles in 00_Inbox...");

    try {
      const files = await this.getRecentMarkdownFiles("00_Inbox", 999);
      if (files.length === 0) {
        new Notice("No markdown files found in '00_Inbox'.");
        return;
      }

      new Notice(`Found ${files.length} notes in 00_Inbox. Starting batch process...`);

      const engine = new ArticleProcessorEngine(
        this.app,
        this.apiClient,
        this.settings.refinementTemperature
      );

      let processedCount = 0;
      for (let i = 0; i < files.length; i++) {
        if (this.cancelProcessing) {
          new Notice("Batch processing was cancelled by user.");
          break;
        }

        const file = files[i];
        this.setStatusBarText(`Processing Article ${i + 1}/${files.length}: ${file.basename}...`);
        
        try {
          const content = await this.app.vault.read(file);
          if (content.includes("type: atomic-note") || content.includes("type: reference")) {
            console.log(`[Local Agent] Skipping ${file.basename}: already processed or is an atomic note.`);
            continue;
          }

          await engine.processFile(file);
          processedCount++;
          new Notice(`Processed (${processedCount}/${files.length}): ${file.basename}`);
        } catch (err) {
          console.error(`[Local Agent] Failed to process ${file.basename}:`, err);
        }
      }

      new Notice(`Batch Processing completed or stopped. Processed ${processedCount}/${files.length} notes.`);
    } catch (err) {
      console.error("[Local Agent] Batch Article Processor error:", err);
      new Notice(`Batch Processing failed: ${(err as Error).message}`);
    } finally {
      this.isProcessing = false;
      this.cancelProcessing = false;
      this.setStatusBarText("");
    }
  }

  // ========================================================================
  // MODULE 7 — Cleaner Engine
  // ========================================================================

  private async cleanSpecificNote(file: TFile): Promise<void> {
    if (this.isProcessing) {
      new Notice("Local Agent 正在執行其他任務，請稍候。");
      return;
    }

    this.isProcessing = true;
    this.setStatusBarText(`Cleaning Note: ${file.basename}...`);
    try {
      const engine = new CleanerEngine(
        this.app,
        this.apiClient,
        this.settings.refinementTemperature
      );
      await engine.cleanFile(file);
    } catch (err) {
      console.error("[Local Agent] Cleaner error:", err);
      new Notice(`清掃失敗：${(err as Error).message}`);
    } finally {
      this.isProcessing = false;
      this.setStatusBarText("");
    }
  }

  // ========================================================================
  // MODULE 6 — Creative Writing Engine
  // ========================================================================

  private async handleWriterInit(): Promise<void> {
    new TopicInputModal(this.app, async (topic: string) => {
      if (!topic) {
        new Notice("未輸入寫作目標，已取消計畫建立。");
        return;
      }
      
      const engine = new WriterEngine(this.app, this.apiClient, this.settings.refinementTemperature);
      const projectId = "Draft_" + Date.now().toString().slice(-6);
      await engine.initProject(projectId, topic);
    }).open();
  }

  private async handleWriterAction(action: "standup" | "draft" | "sweep"): Promise<void> {
    if (this.isProcessing) {
      new Notice("Local Agent is already processing. Please wait or use Cancel command.");
      return;
    }

    const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!activeView || !activeView.file) {
      new Notice("Please open a plan.md or draft.md to perform this action.");
      return;
    }

    this.isProcessing = true;
    this.cancelProcessing = false;
    this.setStatusBarText(`Writer executing: ${action}...`);

    try {
      const engine = new WriterEngine(this.app, this.apiClient, this.settings.refinementTemperature);
      if (action === "standup") {
        await engine.generateStandup(activeView.file);
      } else if (action === "draft") {
        await engine.draftArticle(activeView.file);
      } else if (action === "sweep") {
        await engine.sweepDraft(activeView.file);
      }
    } catch (err) {
      console.error(`[Local Agent] Writer error (${action}):`, err);
    } finally {
      this.isProcessing = false;
      this.cancelProcessing = false;
      this.setStatusBarText("");
    }
  }

  /**
   * Orchestrates the full map-reduce pipeline:
   *   1. Fetch recent markdown files from the input folder.
   *   2. MAP — Summarise each note into one sentence via the LLM.
   *   3. REDUCE — Feed all summaries to the LLM for a global insight report.
   *   4. Write the report as a new markdown file in the output folder.
   */
  private async runMapReduce(): Promise<void> {
    if (this.isProcessing) {
      new Notice("Local Agent is already processing. Please wait.");
      return;
    }

    this.isProcessing = true;
    this.setStatusBarText("Preparing aggregation...");

    try {
      // --- Gather input files -----------------------------------------------
      const files = await this.getRecentMarkdownFiles(
        this.settings.inputFolder,
        this.settings.maxFilesToProcess
      );

      if (files.length === 0) {
        new Notice(
          `No markdown files found in "${this.settings.inputFolder}".`
        );
        return;
      }

      new Notice(
        `Starting Map-Reduce on ${files.length} note(s) from "${this.settings.inputFolder}"...`
      );

      // --- MAP PHASE --------------------------------------------------------
      const summaries: { index: number; name: string; summary: string }[] = [];

      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        this.setStatusBarText(
          `Mapping note ${i + 1}/${files.length}...`
        );

        try {
          const content = await this.app.vault.read(file);
          const body = this.stripFrontmatter(content);

          // Skip empty notes
          if (body.trim().length < 20) {
            summaries.push({
              index: i + 1,
              name: file.basename,
              summary: "(Note was too short to summarise.)",
            });
            continue;
          }

          const summary = await this.apiClient.prompt(
            MAP_SUMMARY_SYSTEM_PROMPT,
            body,
            this.settings.aggregationTemperature
          );

          summaries.push({
            index: i + 1,
            name: file.basename,
            summary: summary.trim(),
          });
        } catch (err) {
          console.error(
            `[Local Agent] Map error on "${file.basename}":`,
            err
          );
          summaries.push({
            index: i + 1,
            name: file.basename,
            summary: `(Error summarising this note: ${(err as Error).message})`,
          });
        }
      }

      // --- REDUCE PHASE -----------------------------------------------------
      this.setStatusBarText("Reducing — generating insight report...");

      const numberedSummaries = summaries
        .map(
          (s) => `[${s.index}] "${s.name}": ${s.summary}`
        )
        .join("\n");

      const insightReport = await this.apiClient.prompt(
        REDUCE_INSIGHT_SYSTEM_PROMPT,
        numberedSummaries,
        this.settings.aggregationTemperature
      );

      // --- Create the output report file ------------------------------------
      this.setStatusBarText("Writing insight report...");

      const reportFile = await this.createInsightReport(
        insightReport,
        summaries
      );

      new Notice(
        `Insight Report created: "${reportFile.basename}"`
      );

      // Open the newly created report
      await this.app.workspace.getLeaf(false).openFile(reportFile);
    } catch (err) {
      console.error("[Local Agent] Map-Reduce error:", err);
      new Notice(`Map-Reduce failed: ${(err as Error).message}`);
    } finally {
      this.isProcessing = false;
      this.setStatusBarText("");
    }
  }

  // ---- Map-Reduce Helpers -------------------------------------------------

  /**
   * Retrieve the most recently modified markdown files from a vault folder.
   * Sorted by modification time (newest first), limited by `maxFiles`.
   */
  private async getRecentMarkdownFiles(
    folderPath: string,
    maxFiles: number
  ): Promise<TFile[]> {
    const normalised = normalizePath(folderPath);
    const abstractFile = this.app.vault.getAbstractFileByPath(normalised);

    if (!abstractFile || !(abstractFile instanceof TFolder)) {
      new Notice(`Folder not found: "${folderPath}". Check your settings.`);
      return [];
    }

    const folder = abstractFile as TFolder;
    const markdownFiles: TFile[] = [];

    // Recursively collect markdown files
    const collectFiles = (f: TFolder) => {
      for (const child of f.children) {
        if (child instanceof TFile && child.extension === "md") {
          markdownFiles.push(child);
        } else if (child instanceof TFolder) {
          collectFiles(child);
        }
      }
    };

    collectFiles(folder);

    // Sort by modification time (most recent first)
    markdownFiles.sort((a, b) => b.stat.mtime - a.stat.mtime);

    return markdownFiles.slice(0, maxFiles);
  }

  /**
   * Create a new Insight Report markdown file in the output folder.
   * The filename includes a timestamp to guarantee uniqueness.
   */
  private async createInsightReport(
    reportContent: string,
    summaries: { index: number; name: string; summary: string }[]
  ): Promise<TFile> {
    const outputPath = normalizePath(this.settings.outputFolder);

    // Ensure the output folder exists
    const existingFolder =
      this.app.vault.getAbstractFileByPath(outputPath);
    if (!existingFolder) {
      await this.app.vault.createFolder(outputPath);
    }

    const now = new Date();
    const dateStr = now.toISOString().split("T")[0]; // YYYY-MM-DD
    const timeStr = now
      .toISOString()
      .split("T")[1]
      .replace(/:/g, "")
      .substring(0, 6); // HHmmss

    const fileName = `Insight Report ${dateStr} ${timeStr}.md`;
    const filePath = normalizePath(`${outputPath}/${fileName}`);

    // Build the full report document
    const sourceList = summaries
      .map((s) => `${s.index}. **${s.name}**: ${s.summary}`)
      .join("\n");

    const fullReport = [
      "---",
      `type: insight-report`,
      `generated: ${now.toISOString()}`,
      `source_folder: "${this.settings.inputFolder}"`,
      `notes_processed: ${summaries.length}`,
      `model: "${this.settings.defaultModel}"`,
      "---",
      "",
      "# Insight Report",
      "",
      `> Generated by **Obsidian Local Agent** on ${dateStr} from ${summaries.length} notes in \`${this.settings.inputFolder}\`.`,
      "",
      reportContent,
      "",
      "---",
      "",
      "## Source Summaries",
      "",
      sourceList,
      "",
    ].join("\n");

    const file = await this.app.vault.create(filePath, fullReport);
    return file;
  }

  // ---- Utility ------------------------------------------------------------

  /**
   * Strip YAML frontmatter from a markdown string, returning only the body.
   */
  private stripFrontmatter(content: string): string {
    const fmRegex = /^---\s*\n[\s\S]*?\n---\s*\n?/;
    return content.replace(fmRegex, "").trim();
  }
}
