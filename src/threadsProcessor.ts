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
      "description": "2~3句話描述這個主題頁的涵蓋範圍",
      "category": "30_生活與創作"
    }
  ],
  "atomic_notes": [
    {
      "title": "可獨立存在的原子化知識點名稱",
      "content": "簡短的知識點定義句。\n\n- **核心機制/關鍵要素 1**：條列化拆解說明...\n- **應用方式/步驟 2**：條列化拆解說明...",
      "tags": ["#標籤1"],
      "category": "20_學術與電腦科學"
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

### 優先順序：主題頁（Hub）> 總覽頁 > 個別筆記
頁面清單中標記為 [hub] 的頁面是「主題頁」，它們是同類筆記的連結中心。
**如果一個 [hub] 主題頁涵蓋了這篇帖文的主題，你必須優先連結它，而非個別筆記。**

例如：
- 食記帖文 → 若有「美食探店地圖 [hub]」就連結它，不要連結其他個別的食記筆記
- 影評帖文 → 若有「觀影心得」或「影視觀後感 [hub]」就連結它
- 書評帖文 → 連結「讀書心得」相關的總覽頁

### 禁止行為
- **嚴禁**把某一篇個別食記/影評/書評筆記當成「所有同類帖文的萬用連結」
- 個別筆記只在「內容上直接高度相關」時才連結（例如：同一部電影的不同評論、同一間餐廳的不同記錄）

### 其他規則
- 從清單中挑選 **1 到 5 個**相關頁面
- 回傳的是頁面的 basename（不含路徑前綴）
- 盡量找到至少 1 個，只有在清單中完全沒有任何沾得上邊的頁面時才允許空陣列

## new_hubs 規則
- 當 existing_relations 中沒有任何 [hub] 主題頁時，才需要建議新的主題頁
- **先在清單中仔細搜尋是否已有功能等價的主題頁**，若已存在，直接連結它即可
- 功能等價的判斷：「美食探店地圖」=「在地美食地圖」=「台灣美食地圖」=「草屯在地美食地圖」，這些都是同一個概念，不可重複建立
- 同一個主題只允許存在一個 hub 頁，若已有就把它放入 existing_relations
- name: 繁體中文，簡潔明確（6~12 字）
- description: 2~3 句話描述涵蓋範圍
- category: 必須是以下五個之一：
  - "10_工作與管理"
  - "20_學術與電腦科學"
  - "30_生活與創作"
  - "40_自託管實驗室"
  - "99_未分類"
- 若 existing_relations 已有合適的 [hub] 頁，new_hubs 必須是空陣列 []

## atomic_notes 規則
- 仔細找出內文中是否有可獨立存在的「原子化知識」（例如：特定技巧、專業名詞解釋、框架、概念）。
- 如果有，將其萃取出來。如果沒有，請回傳空陣列 []。
- **內容（content）必須包含概念的條列化（Bullet points）拆解**，在簡短定義句之後，使用無序列表詳細列出其核心要素、運作機制、步驟或具體場景。
- tags 請包含至少一個標籤。
- category: 必須是以下五個之一："10_工作與管理", "20_學術與電腦科學", "30_生活與創作", "40_自託管實驗室", "99_未分類"。`;

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
  atomic_notes?: Array<{
    title: string;
    content: string;
    tags: string[];
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

    // ── Phase 0: Consolidate duplicate hub pages ──
    // Self-healing: find and merge duplicate hubs before processing.
    await this.consolidateHubs();

    // ── Collect all markdown files ──
    const allFiles = this.getMarkdownFiles(folderPath);
    const files = allFiles.filter(file => {
      const cache = this.app.metadataCache.getFileCache(file);
      return cache?.frontmatter?.["threads-processed"] !== true;
    });

    if (files.length === 0) {
      new Notice(`在「${folderPath}」中找不到需要處理的 Markdown 檔案。`);
      return 0;
    }

    new Notice(`找到 ${files.length} 篇尚未處理的 Threads 帖文，開始批次處理...`);

    // ── Build the vault page index ──
    // allBasenames is kept mutable — new hubs are added as they are created.
    // groupedPages is rebuilt per-file so the LLM always sees the latest hubs.
    const allBasenames = this.collectAllBasenames(folderPath);

    let processedCount = 0;

    for (let i = 0; i < files.length; i++) {
      if (shouldCancel?.()) {
        new Notice("Threads 批次處理已被使用者取消。");
        break;
      }

      const file = files[i];
      onProgress?.(i + 1, files.length, file.basename);

      try {
        const content = await this.app.vault.read(file);

        // Rebuild the grouped page list each time so newly created hubs are visible
        const groupedPages = this.buildGroupedPageList(folderPath);
        await this.processFile(file, content, groupedPages, allBasenames);
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

    const { title, summary, existing_relations, new_hubs, atomic_notes } = parsed;

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
    //    Uses deduplication to prevent near-identical hubs.
    const hubNames: string[] = [];
    if (new_hubs && new_hubs.length > 0) {
      for (const hub of new_hubs) {
        if (!hub.name || !hub.description) continue;

        const safeName = hub.name
          .replace(/[\\/:\"*?<>|#^\[\]]/g, "")
          .trim();
        if (!safeName) continue;

        // Check for exact match first
        if (
          allBasenames.has(safeName) ||
          this.createdHubsThisBatch.has(safeName)
        ) {
          hubNames.push(safeName);
          continue;
        }

        // Check for near-duplicate hubs (e.g. "美食探店地圖" vs "在地美食地圖")
        const existingDuplicate = this.findDuplicateHub(safeName, allBasenames);
        if (existingDuplicate) {
          console.log(
            `[ThreadsProcessor] Hub "${safeName}" is a duplicate of "${existingDuplicate}", reusing.`
          );
          hubNames.push(existingDuplicate);
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

    // Generate atomic notes if any
    let atomicCount = 0;
    const atomicLinks: string[] = [];
    if (atomic_notes && atomic_notes.length > 0) {
      for (const note of atomic_notes) {
        if (!note.title || !note.content) continue;
        const safeTitle = note.title.replace(/[\\/:\"*?<>|#^\[\]]/g, "").trim();
        if (!safeTitle) continue;

        let finalCategory = note.category;
        if (!VALID_CATEGORIES.includes(finalCategory)) {
          finalCategory = "99_未分類";
        }

        const link = await this.createAtomicNote(safeTitle, { content: note.content, tags: note.tags || [] }, finalCategory, file.basename);
        if (link) {
          atomicCount++;
          atomicLinks.push(link);
        }
      }
    }

    if (atomicLinks.length > 0) {
      appendSection += `\n## 萃取的原子化知識\n\n`;
      for (const link of atomicLinks) {
        appendSection += `- ${link}\n`;
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
            `✅ ${safeName}（${allRelations.length} 關聯, ${atomicCount} 原子筆記）`
          );
        } else {
          new Notice(
            `✅ ${file.basename}（${allRelations.length} 關聯, ${atomicCount} 原子筆記，重複未改名）`
          );
        }
      } else {
        new Notice(
          `✅ ${file.basename}（${allRelations.length} 關聯, ${atomicCount} 原子筆記）`
        );
      }
    } else {
      new Notice(
        `✅ ${file.basename}（${allRelations.length} 關聯, ${atomicCount} 原子筆記）`
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

  // ---- Hub Deduplication & Consolidation ------------------------------------

  /**
   * Check if a proposed hub name is a near-duplicate of an existing page.
   * Uses keyword overlap to catch variants like:
   *   "美食探店地圖" ≈ "在地美食地圖" ≈ "草屯在地美食地圖"
   *
   * Returns the existing page basename if a duplicate is found, null otherwise.
   */
  private findDuplicateHub(
    proposed: string,
    allBasenames: Set<string>
  ): string | null {
    const proposedTokens = this.tokenize(proposed);
    if (proposedTokens.length === 0) return null;

    let bestMatch: string | null = null;
    let bestScore = 0;

    for (const existing of allBasenames) {
      const existingTokens = this.tokenize(existing);
      if (existingTokens.length === 0) continue;

      let matchingTokens = 0;
      for (const pt of proposedTokens) {
        for (const et of existingTokens) {
          if (pt === et || pt.includes(et) || et.includes(pt)) {
            matchingTokens++;
            break;
          }
        }
      }

      const ratio = matchingTokens / proposedTokens.length;
      if (matchingTokens >= 2 && ratio >= 0.5 && matchingTokens > bestScore) {
        bestScore = matchingTokens;
        bestMatch = existing;
      }
    }

    return bestMatch;
  }

  /**
   * Compute a bidirectional similarity score between two page names.
   * Returns a score from 0 to 1, where 1 is an exact match.
   */
  private hubSimilarity(a: string, b: string): number {
    const tokensA = this.tokenize(a);
    const tokensB = this.tokenize(b);
    if (tokensA.length === 0 || tokensB.length === 0) return 0;

    let matchesAtoB = 0;
    for (const ta of tokensA) {
      for (const tb of tokensB) {
        if (ta === tb || ta.includes(tb) || tb.includes(ta)) {
          matchesAtoB++;
          break;
        }
      }
    }

    let matchesBtoA = 0;
    for (const tb of tokensB) {
      for (const ta of tokensA) {
        if (tb === ta || tb.includes(ta) || ta.includes(tb)) {
          matchesBtoA++;
          break;
        }
      }
    }

    const ratioA = matchesAtoB / tokensA.length;
    const ratioB = matchesBtoA / tokensB.length;
    return (ratioA + ratioB) / 2;
  }

  /**
   * Automatically find and consolidate duplicate hub pages.
   *
   * Algorithm:
   *   1. Scan all files with frontmatter `type: hub`.
   *   2. Group hubs by semantic similarity (token overlap ≥ 0.5).
   *   3. In each group, pick the "canonical" hub:
   *      - Prefer the one with the most backlinks (most connected).
   *      - Tie-break: oldest creation date.
   *   4. For each duplicate → rewrite all [[duplicate]] wikilinks in
   *      the vault to [[canonical]], then trash the duplicate file.
   *   5. Report results.
   */
  private async consolidateHubs(): Promise<void> {
    // 1. Find all hub files
    const allFiles = this.app.vault.getMarkdownFiles();
    const hubFiles: TFile[] = [];

    for (const f of allFiles) {
      const cache = this.app.metadataCache.getFileCache(f);
      if (cache?.frontmatter?.type === "hub") {
        hubFiles.push(f);
      }
    }

    if (hubFiles.length < 2) return; // Nothing to consolidate

    // 2. Group by similarity using Union-Find approach
    const groups: Map<string, TFile[]> = new Map();
    const assigned: Set<string> = new Set();

    for (let i = 0; i < hubFiles.length; i++) {
      if (assigned.has(hubFiles[i].path)) continue;

      const group: TFile[] = [hubFiles[i]];
      assigned.add(hubFiles[i].path);

      for (let j = i + 1; j < hubFiles.length; j++) {
        if (assigned.has(hubFiles[j].path)) continue;

        const sim = this.hubSimilarity(
          hubFiles[i].basename,
          hubFiles[j].basename
        );
        if (sim >= 0.5) {
          group.push(hubFiles[j]);
          assigned.add(hubFiles[j].path);
        }
      }

      if (group.length > 1) {
        groups.set(hubFiles[i].basename, group);
      }
    }

    if (groups.size === 0) return; // No duplicates found

    // 3. For each group, pick canonical and consolidate
    let totalMerged = 0;
    const mergedNames: string[] = [];

    for (const [, group] of groups) {
      // Pick canonical: most backlinks, then oldest
      const scored = group.map((f) => {
        const backlinks =
          (this.app.metadataCache as any).getBacklinksForFile?.(f)
            ?.count?.() ?? 0;
        return { file: f, backlinks, ctime: f.stat.ctime };
      });

      scored.sort((a, b) => {
        if (b.backlinks !== a.backlinks) return b.backlinks - a.backlinks;
        return a.ctime - b.ctime; // oldest first
      });

      const canonical = scored[0].file;
      const duplicates = scored.slice(1).map((s) => s.file);

      console.log(
        `[ThreadsProcessor] Hub consolidation: canonical="${canonical.basename}", merging ${duplicates.length} duplicates: [${duplicates.map((d) => d.basename).join(", ")}]`
      );

      // 4. For each duplicate, rewrite references and delete
      for (const dup of duplicates) {
        await this.rewriteAllReferences(dup.basename, canonical.basename);

        try {
          await this.app.vault.trash(dup, false);
          totalMerged++;
          console.log(
            `[ThreadsProcessor] Deleted duplicate hub: ${dup.basename}`
          );
        } catch (err) {
          console.warn(
            `[ThreadsProcessor] Could not delete ${dup.basename}:`,
            err
          );
        }
      }

      mergedNames.push(canonical.basename);
    }

    if (totalMerged > 0) {
      new Notice(
        `🔄 Hub 自動整合：合併了 ${totalMerged} 個重複主題頁 → ${mergedNames.join("、")}`
      );
    }
  }

  /**
   * Rewrite all [[oldName]] wikilinks across the entire vault to [[newName]].
   * Handles both `[[oldName]]` and `[[oldName|alias]]` syntax.
   */
  private async rewriteAllReferences(
    oldName: string,
    newName: string
  ): Promise<void> {
    if (oldName === newName) return;

    const allFiles = this.app.vault.getMarkdownFiles();

    // Build regex: match [[oldName]] or [[oldName|anything]]
    const escapedOld = oldName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const linkRegex = new RegExp(
      `\\[\\[${escapedOld}(\\|[^\\]]*)?\\]\\]`,
      "g"
    );

    for (const f of allFiles) {
      try {
        const content = await this.app.vault.read(f);
        if (!linkRegex.test(content)) continue;

        // Reset regex lastIndex after test()
        linkRegex.lastIndex = 0;
        const updated = content.replace(linkRegex, (match, alias) => {
          if (alias) {
            return `[[${newName}${alias}]]`;
          }
          return `[[${newName}]]`;
        });

        if (updated !== content) {
          await this.app.vault.modify(f, updated);
          console.log(
            `[ThreadsProcessor] Updated references in ${f.basename}: [[${oldName}]] → [[${newName}]]`
          );
        }
      } catch (err) {
        console.warn(
          `[ThreadsProcessor] Failed to update references in ${f.basename}:`,
          err
        );
      }
    }
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

  // ---- Atomic Note Creation ---------------------------------------------------

  /**
   * Create an atomic note with an ontology-aware back-link to its source note.
   */
  private async createAtomicNote(
    fileName: string, 
    data: { content: string; tags: string[] },
    category: string,
    sourceName: string
  ): Promise<string | null> {
    try {
      const destFolder = normalizePath(category);
      const abstractFolder = this.app.vault.getAbstractFileByPath(destFolder);
      if (!abstractFolder) {
        await this.app.vault.createFolder(destFolder);
      }

      // Ensure unique filename
      let attempt = 0;
      let finalPath = normalizePath(`${category}/${fileName}.md`);
      while (this.app.vault.getAbstractFileByPath(finalPath)) {
        attempt++;
        finalPath = normalizePath(`${category}/${fileName} ${attempt}.md`);
      }

      const timestamp = new Date().toISOString();
      const tagsStr = data.tags && data.tags.length > 0 
        ? `tags:\n  - ${data.tags.map(t => t.replace(/^#/, "")).join("\n  - ")}`
        : "tags: []";

      // Ontology: maintain bidirectional link back to source note
      const sourceLink = sourceName ? `來源筆記：[[${sourceName}]]\n\n` : "";

      const fullContent = `---
type: atomic-note
category: ${category}
${tagsStr}
created: ${timestamp}
---
${sourceLink}
# ${fileName}

${data.content}
`;

      await this.app.vault.create(finalPath, fullContent);
      return `[[${finalPath.replace(".md", "")}|${fileName}]]`;

    } catch (err) {
      console.error("[ThreadsProcessor] Failed to create atomic note:", err);
      return null;
    }
  }

  // ---- Vault Page Collection ------------------------------------------------

  /**
   * Collect all vault page basenames (excluding target folder, checkpoints, etc.).
   * Returns a mutable Set that will be updated as hubs are created.
   */
  private collectAllBasenames(excludeFolder: string): Set<string> {
    const allFiles = this.app.vault.getMarkdownFiles();
    const excludeNorm = normalizePath(excludeFolder).toLowerCase();
    const basenames: Set<string> = new Set();

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
      basenames.add(f.basename);
    }

    return basenames;
  }

  /**
   * Build the grouped page list string for the LLM prompt.
   * Called per-file so it always includes newly created hub pages.
   * Hub pages are annotated with [hub] so the LLM knows to prefer them.
   */
  private buildGroupedPageList(excludeFolder: string): string {
    const allFiles = this.app.vault.getMarkdownFiles();
    const excludeNorm = normalizePath(excludeFolder).toLowerCase();

    const folderMap: Map<string, string[]> = new Map();

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

      const folder = f.parent?.path || "(root)";
      if (!folderMap.has(folder)) {
        folderMap.set(folder, []);
      }

      // Annotate hub pages so the LLM can identify them
      const isHub = this.createdHubsThisBatch.has(f.basename);
      const label = isHub ? `${f.basename} [hub]` : f.basename;
      folderMap.get(folder)!.push(label);
    }

    // Also check file content for hub type (for hubs created in previous runs)
    // We do this cheaply by checking the metadata cache
    for (const f of allFiles) {
      const cache = this.app.metadataCache.getFileCache(f);
      if (cache?.frontmatter?.type === "hub") {
        const folder = f.parent?.path || "(root)";
        const entries = folderMap.get(folder);
        if (entries) {
          const idx = entries.indexOf(f.basename);
          if (idx !== -1) {
            entries[idx] = `${f.basename} [hub]`;
          }
        }
      }
    }

    const lines: string[] = [];
    const sortedFolders = Array.from(folderMap.keys()).sort();
    for (const folder of sortedFolders) {
      const pages = folderMap.get(folder)!;
      lines.push(`\n📁 ${folder}/`);
      for (const page of pages.sort()) {
        lines.push(`  - ${page}`);
      }
    }

    return lines.join("\n");
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


}
