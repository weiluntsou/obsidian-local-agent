import { App, Notice, TFile, TFolder, normalizePath, MarkdownView, Modal, Setting } from "obsidian";
import { LocalLLMClient } from "./api";

// ---------------------------------------------------------------------------
// SYSTEM PROMPTS
// ---------------------------------------------------------------------------

const SUGGEST_PROMPT = `你是一個知識庫檢索代理。請閱讀使用者的「寫作目標」，並從下方提供的「可用筆記標題清單」中，挑選出最相關、最能支援此目標的 5 到 10 篇筆記。
嚴格要求：
1. 只能挑選清單「可用筆記標題清單」中實際存在的筆記，絕不能自己發明名稱。
2. 輸出的格式只能是列表並加上雙層中括號，不得輸出任何前後文或是說明廢話。例如：
- [[筆記名稱A]]
- [[筆記名稱B]]`;

const STANDUP_PROMPT = `你是一個專業的寫作代理。你的任務是執行「晨間簡報」（Standup）。
請閱讀以下過去三天內的筆記或是與目前寫作目標相關的內容，並自動生成與當前創作任務（參見 plan.md 的目標）相關的背景資訊總結。
請找出可用的洞見、事實與連結，讓寫作者能直接利用。
輸出格式：
## 晨間簡報：背景資訊總結
- 總結條目，並附帶原文連結 [[筆記名稱]]`;

const DRAFTING_PROMPT = `你是一個專業的內容創作者。請根據使用者提供的 \`plan.md\`（包含目標、架構與背景資訊）來草擬一篇文章。
嚴格要求：
1. 衍生式寫作：在生成新內容時，必須附帶來源筆記的原文引用與連結（Quotes & Links），確保新文章的論點有跡可循，隨時可以回溯事實。請在行文中使用 \`[[筆記名稱]]\` 的語法。
2. 開頭必須包含標準 YAML 屬性（包含 type: draft, category, tags）。
3. 語氣專業、流暢。`;

const SWEEP_PROMPT = `你是一個嚴謹的寫作助理。請執行「掃除（Sweep）」與「審核」任務。
閱讀目前的草稿，完成以下檢查與建議：
1. 是否有遺漏的YAML屬性？
2. 是否具備至少一個指向現有筆記的連結 \`[[ ]]\`？
3. 從草稿內容中尋找可能的邏輯盲區，建議是否需要補充其他人物誌（People notes）或專案背景。
請以簡潔的列表回報你的審核與 Sweep 結果。`;

// ---------------------------------------------------------------------------
// ENGINE & MODALS
// ---------------------------------------------------------------------------

export class TopicInputModal extends Modal {
  topic: string = "";
  onSubmit: (result: string) => void;

  constructor(app: App, onSubmit: (result: string) => void) {
    super(app);
    this.onSubmit = onSubmit;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.createEl("h2", { text: "請描述你想寫什麼？ (情境工程)" });
    contentEl.createEl("p", { text: "請輸入這篇文章的主題方向或想探討的問題。Agent 將根據您的目標，掃描整個 Vault 並為您找出現有的相關庫存筆記做為參考！" });

    new Setting(contentEl)
      .setName("寫作目標與關鍵字")
      .addTextArea((text) => {
        text.inputEl.setAttr("rows", 4);
        text.inputEl.style.width = "100%";
        text.onChange((value) => {
          this.topic = value;
        });
      });

    new Setting(contentEl)
      .addButton((btn) =>
        btn
          .setButtonText("自動检索與建立計畫")
          .setCta()
          .onClick(() => {
            this.close();
            this.onSubmit(this.topic);
          })
      );
  }

  onClose() {
    const { contentEl } = this;
    contentEl.empty();
  }
}

export class WriterEngine {
  constructor(
    private app: App,
    private apiClient: LocalLLMClient,
    private temperature: number
  ) {}

  /**
   * 1. Initialize Writing Project
   * 建立一個新的專案資料夾與 plan.md
   */
  public async initProject(projectName: string, objective: string): Promise<void> {
    new Notice("Agentic Reasoning: Searching your vault titles...");
    try {
      const allTitles = this.app.vault.getMarkdownFiles()
          .map(f => f.basename)
          .filter(n => !n.includes("Atomic Note") && n !== "plan" && n !== "draft");
      
      const promptInput = `### 寫作目標\n${objective}\n\n### 可用筆記標題清單\n${allTitles.join("\n")}`;
      
      const suggestedLinks = await this.apiClient.prompt(
         SUGGEST_PROMPT, promptInput, this.temperature
      );

      const safeName = projectName.replace(/[\\/:"*?<>|#^\[\]]/g, "").trim() || "New_Project";
      const destFolder = normalizePath(`99_Uncategorized/${safeName}`);
      
      const abstractFolder = this.app.vault.getAbstractFileByPath(destFolder);
      if (!abstractFolder) {
        await this.app.vault.createFolder(destFolder);
      }

      const planPath = normalizePath(`${destFolder}/plan.md`);
      if (!this.app.vault.getAbstractFileByPath(planPath)) {
        const planTemplate = `---
type: plan
project: ${safeName}
status: planning
---
# 寫作計畫：${safeName}

## 目標 (Objective)
${objective}

## 架構 (Structure)
1. 前言
2. 核心觀點
3. 結論

## 需要引用的既有筆記 (Required Notes)
${suggestedLinks.trim()}

## 情境工程：晨間簡報背景區 (Context)
[透過 Standup 指令自動生成區塊]
`;
        const file = await this.app.vault.create(planPath, planTemplate);
        new Notice(`Initialized Writing Project: ${safeName}`);
        
        // Open the plan
        await this.app.workspace.getLeaf(false).openFile(file);
      } else {
        new Notice("Project already exists!");
      }
    } catch (err) {
      console.error("[WriterEngine] Init failed:", err);
      new Notice(`Initialization failed: ${(err as Error).message}`);
    }
  }

  /**
   * 2. Standup (Retrieve recent context)
   */
  public async generateStandup(planFile: TFile): Promise<void> {
    new Notice("Running Agentic Standup (Gathering Context via Graph & Time)...");

    try {
      const planContent = await this.app.vault.read(planFile);
      const candidateFiles = new Set<TFile>();
      
      // 1. Direct Intent (Explicit Links in plan.md)
      const explicitLinkRegex = /\[\[(.*?)\]\]/g;
      let match;
      while ((match = explicitLinkRegex.exec(planContent)) !== null) {
          const linkName = match[1].split("|")[0].trim();
          const targetFile = this.app.metadataCache.getFirstLinkpathDest(linkName, planFile.path);
          if (targetFile && targetFile instanceof TFile) {
              candidateFiles.add(targetFile);
              
              // 2. Graph Proximity (Degree-1 connections: backlinks & outlinks)
              const resolved = this.app.metadataCache.resolvedLinks;
              if (resolved[targetFile.path]) {
                  for (const outlink in resolved[targetFile.path]) {
                      const outF = this.app.vault.getAbstractFileByPath(outlink);
                      if (outF && outF instanceof TFile) candidateFiles.add(outF);
                  }
              }
              for (const sourcePath in resolved) {
                  if (resolved[sourcePath][targetFile.path]) {
                      const bgFile = this.app.vault.getAbstractFileByPath(sourcePath);
                      if (bgFile && bgFile instanceof TFile) candidateFiles.add(bgFile);
                  }
              }
          }
      }

      // 3. Temporal Intent (Last 3 days)
      const allFiles = this.app.vault.getMarkdownFiles();
      const threeDaysAgo = Date.now() - (3 * 24 * 60 * 60 * 1000);
      for (const f of allFiles) {
          // ignore inbox unprocessed if not explicitly linked
          if (f.stat.mtime >= threeDaysAgo && f.path !== planFile.path) {
              candidateFiles.add(f);
          }
      }

      // Prepare context bundle (Limit to ~15 files to avoid token overflow)
      const candidatesArr = Array.from(candidateFiles)
        .filter(f => f.path !== planFile.path)
        .sort((a, b) => b.stat.mtime - a.stat.mtime); // Prioritize freshly modified

      let notesBundle = "";
      for (const f of candidatesArr.slice(0, 15)) {
        const text = await this.app.vault.read(f);
        notesBundle += `\n\n--- FILE: [[${f.basename}]] ---\n${text.substring(0, 600)}`; // Trim for size
      }

      if (notesBundle.length === 0) {
        new Notice("No related graph or temporal notes found for standup.");
        return;
      }

      const userPrompt = `### 寫作計畫目標\n${planContent}\n\n### 近期筆記庫內容\n${notesBundle}`;

      const response = await this.apiClient.prompt(
        STANDUP_PROMPT,
        userPrompt,
        this.temperature
      );

      // Inject into plan.md
      const mergedContent = planContent + "\n\n" + response.trim();
      await this.app.vault.modify(planFile, mergedContent);

      new Notice("Standup completed! Context added to plan.md");
    } catch (err) {
      console.error("[WriterEngine] Standup failed:", err);
      new Notice(`Standup failed: ${(err as Error).message}`);
    }
  }

  /**
   * 3. Draft Article based on Plan
   */
  public async draftArticle(planFile: TFile): Promise<void> {
    new Notice("Drafting article... This will take a while.");
    try {
      const planContent = await this.app.vault.read(planFile);
      const response = await this.apiClient.prompt(
        DRAFTING_PROMPT,
        `請根據此寫作計畫與背景開始撰寫：\n\n${planContent}`,
        Math.max(0.6, this.temperature + 0.3) // Slightly more creative
      );

      let cleanDraft = response.trim();
      if (cleanDraft.startsWith("```markdown")) {
        cleanDraft = cleanDraft.replace(/^```markdown\n/, "").replace(/\n```$/, "");
      }

      const draftPath = normalizePath(`${planFile.parent?.path}/draft.md`);
      
      const fileExisted = this.app.vault.getAbstractFileByPath(draftPath);
      let draftFile: TFile;
      if (fileExisted && fileExisted instanceof TFile) {
        await this.app.vault.modify(fileExisted, cleanDraft);
        draftFile = fileExisted;
      } else {
        draftFile = await this.app.vault.create(draftPath, cleanDraft);
      }

      new Notice("Draft generated successfully.");
      await this.app.workspace.getLeaf(false).openFile(draftFile);
      
    } catch (err) {
      console.error("[WriterEngine] Drafting failed:", err);
      new Notice(`Drafting failed: ${(err as Error).message}`);
    }
  }

  /**
   * 4. Sweep / Hook Verification
   */
  public async sweepDraft(draftFile: TFile): Promise<void> {
    new Notice("Running Sweep & Verification on draft...");
    try {
      const draftContent = await this.app.vault.read(draftFile);
      
      const response = await this.apiClient.prompt(
        SWEEP_PROMPT,
        draftContent,
        this.temperature
      );

      // We append the sweep results at the end as comments or display a popup. Let's append as comments.
      const appended = `\n\n%% SWEEP REVIEW %%\n${response.replace(/^/gm, "%% ")}`;
      await this.app.vault.modify(draftFile, draftContent + appended);

      new Notice("Sweep completed. Check the bottom of your draft for suggestions.");
    } catch (err) {
      console.error("[WriterEngine] Sweep failed:", err);
      new Notice(`Sweep failed: ${(err as Error).message}`);
    }
  }
}
