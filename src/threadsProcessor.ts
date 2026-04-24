/**
 * threadsProcessor.ts — Threads Post Processor Engine
 *
 * Batch-processes markdown files in the "Threads" directory with three
 * AI-powered enhancements:
 *   1. Title Generation — reads content and produces a ≤20-char title.
 *   2. Summary Append   — for posts with body text >100 chars, appends
 *                          a concise summary section.
 *   3. Relation Linking  — aggressively links to existing vault pages
 *                          AND creates new thematic hub pages when no
 *                          suitable match exists, to eliminate orphans.
 *
 * Design: lightweight, non-destructive (uses checkpoint system), and
 * follows the same patterns as ArticleProcessorEngine.
 */

import { App, TFile, TFolder, Notice, normalizePath } from "obsidian";
import { LocalLLMClient, parseJsonFromLLM } from "./api";

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

/**
 * Single-shot prompt that handles all three tasks at once to minimise
 * LLM round-trips (Threads posts are short, so context fits easily).
 *
 * Key design decisions for stronger relation linking:
 *   - Page list is grouped by folder (category) so the LLM has context.
 *   - The prompt demands at least 1 relation — never empty.
 *   - If no existing page fits, LLM must suggest a NEW hub topic to create.
 *   - Fuzzy/thematic matching is encouraged (e.g. a food post should
 *     link to a food-related page even if the exact restaurant differs).
 */
const THREADS_PROCESSOR_PROMPT = `你是一位精準的 Obsidian 知識管理助手，專門處理社群媒體短文（來自 Threads / Instagram）。

你將收到：
1. 一篇帖文的「原始檔名」與「內文」
2. 使用者 Obsidian 知識庫中「現有頁面清單」（按資料夾分組）

---

你必須回傳以下 JSON，不得輸出其他任何文字。

{
  "title": "新標題",
  "summary": "摘要文字，或空字串",
  "existing_relations": ["已存在的頁面名稱A", "頁面名稱B"],
  "new_hubs": [
    {
      "name": "新主題頁名稱",
      "description": "2~3句話描述這個主題頁的涵蓋範圍，讓未來的筆記也能連結過來",
      "category": "30_生活與創作"
    }
  ]
}

---

## title 規則
- 繁體中文，最多 20 字（日期不計入字數）
- 若原始檔名有日期（如 2025-06-17），保留日期前綴
- 格式："2025-06-17 草屯碳桔燒肉便當初體驗"

## summary 規則
- 若內文（不含 frontmatter）超過 100 字 → 撰寫 50 字以內的精煉摘要
- 若不超過 100 字 → 回傳空字串 ""
- 食記點出評價、影評點出結論、技術文點出核心觀點

## existing_relations 規則（最重要！）
- 從「現有頁面清單」中挑選 **1 到 5 個**與內文主題相關的頁面
- **請用「主題關聯性」判斷**，而非逐字比對。例如：
  - 影評 → 連結到「觀影心得」、其他相同導演/演員的影評筆記
  - 食記 → 連結到「阿琴麻辣風味」（同為食記）、「草屯美食」等
  - 書評 → 連結到「讀書心得」、同主題的筆記
  - 技術文 → 連結到同領域的技術筆記
  - 生活感想 → 連結到「心理學與個人成長」相關筆記
  - 日文學習 → 連結到相關學習筆記
- **回傳的是頁面的 basename**（不含路徑），例如 "觀影心得" 而非 "30_Life_&_Creations/觀影心得"
- **盡量找到至少 1 個**，只有在清單中完全沒有任何沾得上邊的頁面時才允許空陣列

## new_hubs 規則（減少孤立筆記的關鍵！）
- 當 existing_relations 找到的頁面不足 2 個時，**必須建議 1 個新的主題頁**
- 新主題頁的名稱應該是一個「可以收集同類未來筆記」的通用主題，例如：
  - 一篇草屯食記 → 建議「草屯美食地圖」
  - 一篇影評 → 若「觀影心得」已存在就不用再建，改連結過去
  - 一篇 AI 工具使用心得 → 建議「AI 工具實戰筆記」
  - 一篇育兒日常 → 建議「親子生活記錄」
  - 一篇旅遊 → 建議「旅行見聞」
- name: 繁體中文，簡潔明確（6~12 字）
- description: 2~3 句話描述涵蓋範圍
- category: 必須是以下五個之一：
  - "10_工作與管理"
  - "20_學術與電腦科學"
  - "30_生活與創作"
  - "40_自託管實驗室"
  - "99_未分類"
- 若 existing_relations 已有 2 個以上的良好匹配，new_hubs 可以是空陣列 []
- **重複檢查**：若清單中已有功能相同的頁面（如已有「觀影心得」就不再建「電影心得」），不要建立重複主題`;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface LLMResponse {
  title?: string;
  summary?: string;
  existing_relations?: string[];
  new_hubs?: Array<{
    name: string;
    description: string;
    category: string;
  }>;
}

const VALID_CATEGORIES = [
  "10_工作與管理",
  "20_學術與電腦科學",
  "30_生活與創作",
  "40_自託管實驗室",
  "99_未分類",
];

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

export class ThreadsProcessorEngine {
  /** Cache of hub pages created during this batch to avoid duplicates. */
  private createdHubsThisBatch: Set<string> = new Set();

  constructor(
    private app: App,
    private apiClient: LocalLLMClient,
    private temperature: number
  ) {}

  /**
   * Process all markdown files inside the given folder path.
   * Returns the count of successfully processed files.
   */
  public async processBatch(
    folderPath: string,
    onProgress?: (current: number, total: number, name: string) => void,
    shouldCancel?: () => boolean
  ): Promise<number> {
    // Reset hub creation cache for this batch
    this.createdHubsThisBatch.clear();

    // ── Collect all markdown files ──
    const files = this.getMarkdownFiles(folderPath);
    if (files.length === 0) {
      new Notice(`在「${folderPath}」中找不到任何 Markdown 檔案。`);
      return 0;
    }

    new Notice(`找到 ${files.length} 篇 Threads 帖文，開始批次處理...`);

    // ── Build the vault page index grouped by folder ──
    const { grouped, allBasenames } = this.collectVaultPages(folderPath);

    let processedCount = 0;

    for (let i = 0; i < files.length; i++) {
      if (shouldCancel?.()) {
        new Notice("Threads 批次處理已被使用者取消。");
        break;
      }

      const file = files[i];
      onProgress?.(i + 1, files.length, file.basename);

      try {
        // Skip files that have already been processed by this engine
        const content = await this.app.vault.read(file);
        if (content.includes("threads-processed: true")) {
          console.log(
            `[ThreadsProcessor] Skipping ${file.basename}: already processed.`
          );
          continue;
        }

        await this.processFile(file, content, grouped, allBasenames);
        processedCount++;
      } catch (err) {
        console.error(
          `[ThreadsProcessor] Failed to process ${file.basename}:`,
          err
        );
      }
    }

    if (this.createdHubsThisBatch.size > 0) {
      new Notice(
        `本次共建立 ${this.createdHubsThisBatch.size} 個新主題頁：${Array.from(this.createdHubsThisBatch).join("、")}`
      );
    }

    return processedCount;
  }

  // ---- Single-file processing -----------------------------------------------

  private async processFile(
    file: TFile,
    content: string,
    groupedPages: string,
    allBasenames: Set<string>
  ): Promise<void> {
    const body = this.stripFrontmatter(content);

    // Skip nearly-empty files
    if (body.trim().length < 10) {
      console.log(
        `[ThreadsProcessor] Skipping ${file.basename}: body too short.`
      );
      return;
    }

    // ── Checkpoint before modification ──
    await this.saveCheckpoint(file, content);

    // ── Build user prompt ──
    const userPrompt = [
      `【原始檔名】：${file.basename}`,
      "",
      `【內文】：`,
      body,
      "",
      `【現有頁面清單（按資料夾分組）】：`,
      groupedPages,
    ].join("\n");

    // ── Call LLM ──
    const rawResponse = await this.apiClient.prompt(
      THREADS_PROCESSOR_PROMPT,
      userPrompt,
      this.temperature
    );

    const parsed = parseJsonFromLLM<LLMResponse>(rawResponse);

    if (!parsed) {
      console.warn(
        `[ThreadsProcessor] Failed to parse LLM response for ${file.basename}. Raw:`,
        rawResponse.substring(0, 500)
      );
      return;
    }

    const { title, summary, existing_relations, new_hubs } = parsed;

    // ── Apply changes ──

    // 1. Mark as processed & update frontmatter via Obsidian API
    await this.app.fileManager.processFrontMatter(file, (fm) => {
      fm["threads-processed"] = true;
      if (title) {
        fm["title"] = title;
      }
    });

    // 2. Build append section
    let appendSection = "";

    if (summary && summary.trim().length > 0) {
      appendSection += `\n\n---\n\n## 摘要\n\n${summary.trim()}\n`;
    }

    // 3. Resolve existing relations with fuzzy matching
    const resolvedExisting = this.resolveRelations(
      existing_relations || [],
      allBasenames
    );

    // 4. Create new hub pages if suggested & collect their names
    const hubNames: string[] = [];
    if (new_hubs && new_hubs.length > 0) {
      for (const hub of new_hubs) {
        if (!hub.name || !hub.description) continue;

        const safeName = hub.name
          .replace(/[\\/:\"*?<>|#^\[\]]/g, "")
          .trim();
        if (!safeName) continue;

        // Skip if a page with this basename already exists or was created this batch
        if (
          allBasenames.has(safeName) ||
          this.createdHubsThisBatch.has(safeName)
        ) {
          // Still add it to relations even if we didn't create it
          hubNames.push(safeName);
          continue;
        }

        // Create the hub page
        try {
          await this.createHubPage(safeName, hub.description, hub.category);
          this.createdHubsThisBatch.add(safeName);
          allBasenames.add(safeName);
          hubNames.push(safeName);
          console.log(
            `[ThreadsProcessor] Created hub page: ${safeName}`
          );
        } catch (err) {
          console.warn(
            `[ThreadsProcessor] Failed to create hub page ${safeName}:`,
            err
          );
        }
      }
    }

    // 5. Merge all relations (existing + newly created hubs)
    const allRelations = Array.from(
      new Set([...resolvedExisting, ...hubNames])
    );

    if (allRelations.length > 0) {
      appendSection += `\n## 關聯筆記\n\n`;
      for (const rel of allRelations) {
        appendSection += `- [[${rel}]]\n`;
      }
    }

    if (appendSection) {
      const currentContent = await this.app.vault.read(file);
      await this.app.vault.modify(file, currentContent + appendSection);
    }

    // 6. Rename the file if a new title is suggested and different
    if (title) {
      const safeName = title
        .replace(/[\\/:\"*?<>|#^\[\]]/g, "")
        .trim()
        .slice(0, 60);

      if (safeName && safeName !== file.basename) {
        const parentDir = file.parent?.path || "";
        const newPath = normalizePath(`${parentDir}/${safeName}.md`);

        // Avoid overwriting an existing file
        if (!this.app.vault.getAbstractFileByPath(newPath)) {
          await this.app.vault.rename(file, newPath);
          new Notice(
            `✅ ${safeName}（${allRelations.length} 個關聯）`
          );
        } else {
          new Notice(
            `✅ ${file.basename}（${allRelations.length} 個關聯，名稱重複未改名）`
          );
        }
      } else {
        new Notice(
          `✅ ${file.basename}（${allRelations.length} 個關聯）`
        );
      }
    } else {
      new Notice(
        `✅ ${file.basename}（${allRelations.length} 個關聯）`
      );
    }
  }

  // ---- Relation Matching ----------------------------------------------------

  /**
   * Resolve LLM-suggested relation names against the actual vault page
   * basenames using fuzzy matching:
   *   1. Exact match (case-insensitive)
   *   2. Substring containment (e.g. "觀影心得" matches "觀影心得")
   *   3. Partial keyword overlap
   */
  private resolveRelations(
    suggestions: string[],
    allBasenames: Set<string>
  ): string[] {
    const resolved: string[] = [];
    const basenameArray = Array.from(allBasenames);

    for (const suggestion of suggestions) {
      if (!suggestion || suggestion.trim().length === 0) continue;
      const suggLower = suggestion.trim().toLowerCase();

      // 1. Exact match (case-insensitive)
      const exact = basenameArray.find(
        (b) => b.toLowerCase() === suggLower
      );
      if (exact) {
        resolved.push(exact);
        continue;
      }

      // 2. One contains the other
      const containsMatch = basenameArray.find(
        (b) =>
          b.toLowerCase().includes(suggLower) ||
          suggLower.includes(b.toLowerCase())
      );
      if (containsMatch) {
        resolved.push(containsMatch);
        continue;
      }

      // 3. Significant keyword overlap (≥2 chars overlap in any segment)
      const suggTokens = this.tokenize(suggestion);
      let bestMatch: string | null = null;
      let bestScore = 0;

      for (const basename of basenameArray) {
        const baseTokens = this.tokenize(basename);
        let score = 0;
        for (const st of suggTokens) {
          for (const bt of baseTokens) {
            if (st.length >= 2 && bt.length >= 2) {
              if (st === bt) {
                score += 3;
              } else if (st.includes(bt) || bt.includes(st)) {
                score += 2;
              }
            }
          }
        }
        if (score > bestScore && score >= 3) {
          bestScore = score;
          bestMatch = basename;
        }
      }

      if (bestMatch) {
        resolved.push(bestMatch);
      }
      // If no match at all, the LLM hallucinated a name — skip silently
    }

    return Array.from(new Set(resolved));
  }

  /**
   * Tokenize a string into meaningful segments for fuzzy matching.
   */
  private tokenize(str: string): string[] {
    // Split on common delimiters, filter short fragments
    return str
      .toLowerCase()
      .split(/[\s\-_：:，,、。.()（）《》「」\[\]\/]+/)
      .filter((t) => t.length >= 2);
  }

  // ---- Hub Page Creation ----------------------------------------------------

  /**
   * Create a new thematic hub page in the appropriate category folder.
   * These are lightweight "index" pages that serve as connection points
   * for future notes on the same topic.
   */
  private async createHubPage(
    name: string,
    description: string,
    category: string
  ): Promise<void> {
    // Validate category
    if (!VALID_CATEGORIES.includes(category)) {
      category = "30_生活與創作"; // default for life/threads content
    }

    // Ensure the category folder exists
    const destFolder = normalizePath(category);
    if (!this.app.vault.getAbstractFileByPath(destFolder)) {
      await this.app.vault.createFolder(destFolder);
    }

    const today = new Date().toISOString().split("T")[0];
    const filePath = normalizePath(`${category}/${name}.md`);

    // Don't overwrite if it somehow already exists
    if (this.app.vault.getAbstractFileByPath(filePath)) {
      return;
    }

    const content = [
      "---",
      `title: "${name}"`,
      "type: hub",
      `category: ${category}`,
      `created: ${today}`,
      "tags:",
      "  - hub",
      "  - auto-generated",
      "---",
      "",
      `# ${name}`,
      "",
      `> [!info] 自動建立的主題頁`,
      `> 此頁面由 Threads 處理器自動建立，作為同主題筆記的連結中心。`,
      `> 建立日期：${today}`,
      "",
      `## 主題描述`,
      "",
      description,
      "",
      `## 相關筆記`,
      "",
      "> 以下筆記會自動透過反向連結（Backlinks）出現在這裡。",
      "",
    ].join("\n");

    await this.app.vault.create(filePath, content);
  }

  // ---- Vault Page Collection ------------------------------------------------

  /**
   * Collect all vault pages grouped by their parent folder.
   * Returns both a formatted string for the prompt and a Set of basenames.
   */
  private collectVaultPages(excludeFolder: string): {
    grouped: string;
    allBasenames: Set<string>;
  } {
    const allFiles = this.app.vault.getMarkdownFiles();
    const excludeNorm = normalizePath(excludeFolder).toLowerCase();

    // Group by parent folder
    const folderMap: Map<string, string[]> = new Map();
    const allBasenames: Set<string> = new Set();

    for (const f of allFiles) {
      const pathLower = f.path.toLowerCase();
      if (
        pathLower.startsWith(excludeNorm) ||
        pathLower.startsWith("_checkpoints") ||
        pathLower.includes(".obsidian") ||
        pathLower.startsWith("copilot-custom-prompts") ||
        pathLower.startsWith("00_inbox")
      ) {
        continue;
      }

      allBasenames.add(f.basename);

      const folder = f.parent?.path || "(root)";
      if (!folderMap.has(folder)) {
        folderMap.set(folder, []);
      }
      folderMap.get(folder)!.push(f.basename);
    }

    // Build a grouped string representation
    const lines: string[] = [];
    const sortedFolders = Array.from(folderMap.keys()).sort();
    for (const folder of sortedFolders) {
      const pages = folderMap.get(folder)!;
      lines.push(`\n📁 ${folder}/`);
      for (const page of pages.sort()) {
        lines.push(`  - ${page}`);
      }
    }

    return {
      grouped: lines.join("\n"),
      allBasenames,
    };
  }

  // ---- File Helpers ---------------------------------------------------------

  /**
   * Get all markdown files directly inside the given folder (non-recursive).
   * Sorted by modification time (newest first).
   */
  private getMarkdownFiles(folderPath: string): TFile[] {
    const normalised = normalizePath(folderPath);
    const abstractFile = this.app.vault.getAbstractFileByPath(normalised);

    if (!abstractFile || !(abstractFile instanceof TFolder)) {
      return [];
    }

    const folder = abstractFile as TFolder;
    const mdFiles: TFile[] = [];

    for (const child of folder.children) {
      if (child instanceof TFile && child.extension === "md") {
        mdFiles.push(child);
      }
    }

    // Newest first
    mdFiles.sort((a, b) => b.stat.mtime - a.stat.mtime);
    return mdFiles;
  }

  /**
   * Strip YAML frontmatter, returning only the body text.
   */
  private stripFrontmatter(content: string): string {
    const fmRegex = /^---\s*\n[\s\S]*?\n---\s*\n?/;
    return content.replace(fmRegex, "").trim();
  }

  /**
   * Save a checkpoint snapshot before modifying the file.
   */
  private async saveCheckpoint(
    file: TFile,
    content: string
  ): Promise<void> {
    try {
      const checkpointDir = normalizePath(
        `_checkpoints/${file.basename}`
      );
      const existingDir =
        this.app.vault.getAbstractFileByPath(checkpointDir);
      if (!existingDir) {
        await this.app.vault.createFolder(checkpointDir);
      }

      const now = new Date();
      const ts = now.toISOString().replace(/[:.]/g, "-");
      const checkpointPath = normalizePath(
        `${checkpointDir}/${file.basename}_${ts}.md`
      );

      const header = [
        "---",
        "type: checkpoint",
        `source: "[[${file.basename}]]"`,
        `checkpoint_created: ${now.toISOString()}`,
        `original_path: "${file.path}"`,
        "---",
        "",
        "> [!warning] 此為自動保存的變更檢查點（Checkpoint）",
        `> 原始檔案：[[${file.basename}]]`,
        `> 快照時間：${now.toISOString()}`,
        "",
        "---",
        "",
      ].join("\n");

      await this.app.vault.create(checkpointPath, header + content);
      console.log(
        `[ThreadsProcessor] Checkpoint saved: ${checkpointPath}`
      );
    } catch (err) {
      console.warn(
        "[ThreadsProcessor] Failed to save checkpoint:",
        err
      );
    }
  }
}
