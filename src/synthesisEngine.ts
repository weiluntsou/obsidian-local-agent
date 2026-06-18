/**
 * synthesisEngine.ts — 主動合成引擎 (Synthesis Engine)
 *
 * Feature 4 of the Second Self system.
 *
 * Supports both manual (sidebar button / command) and automatic
 * (daily first-open detection) triggering. Uses the cloud model
 * (Gemini) for macro synthesis, with local LLM fallback when
 * cloud is not enabled.
 *
 * Two synthesis modes:
 * 1. Daily Brief: Past 7 days of refined notes → Connections, Pattern,
 *    Contradiction, Best Capture.
 * 2. Weekly Deep Dive: Past 30 days → Emerging Thesis, Knowledge Gaps,
 *    One Action.
 *
 * Reports are saved to {secondSelfFolder}/Briefs/.
 */

import { App, Notice, TFile, normalizePath } from "obsidian";
import { LocalLLMClient } from "./api";
import { CloudLLMClient } from "./cloudApi";

// ---------------------------------------------------------------------------
// System Prompts
// ---------------------------------------------------------------------------

const DAILY_SYNTHESIS_PROMPT = `你是使用者的「第二自我」（Second Self）。你的職責是作為使用者思維的鏡像與催化劑，從近期的筆記中合成深層洞見。

你會收到使用者在過去 7 天內精修的筆記全文本。請產出一份每日合成簡報，包含以下 **四個固定區塊**：

## Connections（非顯著關聯）
找出表面上看似無關、但實際上存在隱性連結的筆記對。解釋它們之間的深層關聯。不要列出「顯而易見」的關聯（例如同主題的筆記）。

## Pattern（跨筆記隱性主題）
識別在多篇筆記中反覆出現但使用者可能未意識到的主題或思維模式。

## Contradiction（立場衝突與引用）
找出任何在不同筆記中表達矛盾立場的地方，並引用具體內容。

## Best Capture（最具發展潛力筆記）
選出一篇你認為最具發展潛力的筆記，解釋為什麼它值得進一步深挖。

規則：
1. 使用繁體中文。
2. 引用筆記時使用 [[筆記名稱]] 語法。
3. 每個區塊至少一段有意義的分析，不要空洞應付。
4. 簡報應該是一份思維的地圖，不是內容摘要的堆疊。`;

const WEEKLY_SYNTHESIS_PROMPT = `你是使用者的「第二自我」（Second Self）。你的職責是進行更深層的宏觀思維合成。

你會收到使用者過去 30 天內的筆記摘要與核心論點。請產出一份每週深度報告，包含以下 **三個固定區塊**：

## Emerging Thesis（隱性核心論點）
從所有筆記的思維軌跡中，推論出一個使用者自己可能尚未命名或完全意識到的新論點或信念。為它命名，並用筆記引用作為證據。

## Knowledge Gaps（思維盲點）
辨識使用者在過去一個月的思考中反覆迴避、未曾觸及、或缺乏資料支撐的領域。這些可能是最有價值的下一步探索方向。

## One Action（最高槓桿行動）
基於以上分析，建議使用者本週應該執行的一項具體行動（可以是閱讀、對話、實驗或寫作）。解釋為什麼這個行動的槓桿效應最高。

規則：
1. 使用繁體中文。
2. 引用筆記時使用 [[筆記名稱]] 語法。
3. Emerging Thesis 必須是一個具體的、可命名的論點，不是模糊的「主題」。
4. 報告應該讓使用者感到「被理解」但也「被挑戰」。`;

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

export class SynthesisEngine {
  constructor(
    private app: App,
    private localClient: LocalLLMClient,
    private cloudClient: CloudLLMClient | null,
    private cloudEnabled: boolean,
    private secondSelfFolder: string,
    private temperature: number
  ) {}

  /**
   * Run daily synthesis brief (past 7 days).
   */
  async runDailySynthesis(): Promise<void> {
    const today = new Date().toISOString().split("T")[0];
    const reportName = `Daily_${today}`;
    const briefsFolder = normalizePath(`${this.secondSelfFolder}/Briefs`);

    // Check if already generated today
    const reportPath = normalizePath(`${briefsFolder}/${reportName}.md`);
    if (this.app.vault.getAbstractFileByPath(reportPath)) {
      new Notice(`今日合成簡報已存在：${reportName}`);
      // Open the existing report
      const existing = this.app.vault.getAbstractFileByPath(reportPath);
      if (existing && existing instanceof TFile) {
        await this.app.workspace.getLeaf(false).openFile(existing as TFile);
      }
      return;
    }

    new Notice("🧠 正在執行每日合成簡報...");

    try {
      // 1. Gather refined notes from past 7 days
      const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
      const refinedNotes = this.getRefinedNotes(sevenDaysAgo);

      if (refinedNotes.length === 0) {
        new Notice("過去 7 天內沒有精修過的筆記，無法生成合成簡報。");
        return;
      }

      // 2. Build context
      const notesContext = await this.buildNotesContext(refinedNotes, 3000);

      // 3. Generate synthesis
      const userPrompt = [
        `以下是過去 7 天內精修的 ${refinedNotes.length} 篇筆記：`,
        "",
        notesContext,
      ].join("\n");

      const report = await this.callModel(
        DAILY_SYNTHESIS_PROMPT,
        userPrompt
      );

      // 4. Save report
      await this.saveReport(briefsFolder, reportName, "daily", report, refinedNotes);

      new Notice(`✅ 每日合成簡報已生成：${reportName}`);
    } catch (err) {
      console.error("[SynthesisEngine] Daily synthesis error:", err);
      new Notice(`每日合成失敗：${(err as Error).message}`);
    }
  }

  /**
   * Run weekly deep synthesis (past 30 days).
   */
  async runWeeklySynthesis(): Promise<void> {
    const now = new Date();
    // ISO week number
    const weekNum = this.getISOWeek(now);
    const reportName = `Weekly_${now.getFullYear()}-W${String(weekNum).padStart(2, "0")}`;
    const briefsFolder = normalizePath(`${this.secondSelfFolder}/Briefs`);

    // Check if already generated this week
    const reportPath = normalizePath(`${briefsFolder}/${reportName}.md`);
    if (this.app.vault.getAbstractFileByPath(reportPath)) {
      new Notice(`本週深度報告已存在：${reportName}`);
      const existing = this.app.vault.getAbstractFileByPath(reportPath);
      if (existing && existing instanceof TFile) {
        await this.app.workspace.getLeaf(false).openFile(existing as TFile);
      }
      return;
    }

    new Notice("🧠 正在執行每週深度合成...");

    try {
      // 1. Gather refined notes from past 30 days
      const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;
      const refinedNotes = this.getRefinedNotes(thirtyDaysAgo);

      if (refinedNotes.length === 0) {
        new Notice("過去 30 天內沒有精修過的筆記，無法生成深度報告。");
        return;
      }

      // 2. Build context (more compressed for 30-day range)
      const notesContext = await this.buildNotesContext(refinedNotes, 1500);

      // 3. Generate synthesis
      const userPrompt = [
        `以下是過去 30 天內精修的 ${refinedNotes.length} 篇筆記摘要：`,
        "",
        notesContext,
      ].join("\n");

      const report = await this.callModel(
        WEEKLY_SYNTHESIS_PROMPT,
        userPrompt
      );

      // 4. Save report
      await this.saveReport(briefsFolder, reportName, "weekly", report, refinedNotes);

      new Notice(`✅ 每週深度報告已生成：${reportName}`);
    } catch (err) {
      console.error("[SynthesisEngine] Weekly synthesis error:", err);
      new Notice(`每週合成失敗：${(err as Error).message}`);
    }
  }

  /**
   * Check if daily synthesis should run (first open of the day).
   */
  async checkAndRunDailyAuto(): Promise<void> {
    const today = new Date().toISOString().split("T")[0];
    const briefsFolder = normalizePath(`${this.secondSelfFolder}/Briefs`);
    const reportPath = normalizePath(`${briefsFolder}/Daily_${today}.md`);

    // If today's report already exists, skip
    if (this.app.vault.getAbstractFileByPath(reportPath)) {
      return;
    }

    // Run daily synthesis in background
    console.log("[SynthesisEngine] Auto-triggering daily synthesis...");
    // Small delay to let Obsidian finish loading
    setTimeout(() => {
      this.runDailySynthesis();
    }, 5000);
  }

  // ---- Private helpers ----------------------------------------------------

  /**
   * Get refined notes modified after a given timestamp.
   */
  private getRefinedNotes(sinceTimestamp: number): TFile[] {
    const allFiles = this.app.vault.getMarkdownFiles();
    const refined: TFile[] = [];

    for (const f of allFiles) {
      if (f.stat.mtime < sinceTimestamp) continue;

      const cache = this.app.metadataCache.getFileCache(f);
      if (!cache?.frontmatter) continue;

      // Check if refined
      if (cache.frontmatter.refined === true) {
        refined.push(f);
      }
    }

    // Sort by modification time (newest first)
    refined.sort((a, b) => b.stat.mtime - a.stat.mtime);

    return refined;
  }

  /**
   * Build a context string from notes, limiting each note's content.
   */
  private async buildNotesContext(
    files: TFile[],
    perNoteLimit: number
  ): Promise<string> {
    const parts: string[] = [];

    for (const f of files) {
      const content = await this.app.vault.read(f);
      const body = this.stripFrontmatter(content);
      const truncated = body.substring(0, perNoteLimit);
      parts.push(`--- [[${f.basename}]] ---\n${truncated}`);
    }

    return parts.join("\n\n");
  }

  /**
   * Call the appropriate model (cloud or local).
   */
  private async callModel(
    systemPrompt: string,
    userPrompt: string
  ): Promise<string> {
    if (this.cloudEnabled && this.cloudClient) {
      try {
        return await this.cloudClient.prompt(
          systemPrompt,
          userPrompt,
          this.temperature
        );
      } catch (err) {
        console.error(
          "[SynthesisEngine] Cloud model failed, falling back to local:",
          err
        );
        new Notice("雲端模型呼叫失敗，使用本地模型作為降級方案...");
      }
    }

    // Fallback to local
    return await this.localClient.prompt(
      systemPrompt,
      userPrompt,
      this.temperature
    );
  }

  /**
   * Save a synthesis report to the Briefs folder.
   */
  private async saveReport(
    briefsFolder: string,
    reportName: string,
    type: "daily" | "weekly",
    reportContent: string,
    sourceNotes: TFile[]
  ): Promise<void> {
    // Ensure folder hierarchy exists
    await this.ensureFolder(this.secondSelfFolder);
    await this.ensureFolder(briefsFolder);

    const now = new Date();
    const reportPath = normalizePath(`${briefsFolder}/${reportName}.md`);

    const typeLabel = type === "daily" ? "每日合成簡報" : "每週深度報告";
    const sourceList = sourceNotes
      .map((f) => `- [[${f.basename}]]`)
      .join("\n");

    const fullReport = [
      "---",
      `type: synthesis-${type}`,
      `generated: ${now.toISOString()}`,
      `notes_count: ${sourceNotes.length}`,
      `model: "${this.cloudEnabled ? "cloud" : "local"}"`,
      "---",
      "",
      `# ${typeLabel}：${reportName}`,
      "",
      `> 🧠 由 **Second Self** 於 ${now.toISOString().split("T")[0]} 自動合成，基於 ${sourceNotes.length} 篇精修筆記。`,
      "",
      reportContent,
      "",
      "---",
      "",
      "## 來源筆記",
      "",
      sourceList,
      "",
    ].join("\n");

    const file = await this.app.vault.create(reportPath, fullReport);

    // Open the report
    await this.app.workspace.getLeaf(false).openFile(file);
  }

  /**
   * Ensure a folder exists in the vault.
   */
  private async ensureFolder(folderPath: string): Promise<void> {
    const normalised = normalizePath(folderPath);
    if (!this.app.vault.getAbstractFileByPath(normalised)) {
      await this.app.vault.createFolder(normalised);
    }
  }

  /**
   * Get ISO week number for a date.
   */
  private getISOWeek(date: Date): number {
    const d = new Date(
      Date.UTC(date.getFullYear(), date.getMonth(), date.getDate())
    );
    const dayNum = d.getUTCDay() || 7;
    d.setUTCDate(d.getUTCDate() + 4 - dayNum);
    const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
    return Math.ceil(
      ((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7
    );
  }

  private stripFrontmatter(content: string): string {
    const fmRegex = /^---\s*\n[\s\S]*?\n---\s*\n?/;
    return content.replace(fmRegex, "").trim();
  }
}
